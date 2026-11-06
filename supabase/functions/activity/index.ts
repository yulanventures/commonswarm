import postgres from "npm:postgres@3.4.9";
import { presentsAdminCredential } from "../_shared/admin-credential-boundary.ts";
import { withDatabaseTls } from "../_shared/database-options.ts";
import { redactCredentialText } from "../../../src/host/credential-redaction.ts";
import {
  agentCredentialRevoked,
  enforceAgentSessionProof,
  loadAgentCredential,
  planLocalOperation, lockLocalAuthPlan, retryLocalAuthTransaction, LocalCredentialDenied, recheckLocalCredential, reportRevokedLocalCredential,
} from "../_shared/agent-auth.ts";
import { parseAgentSessionProofHeaders } from "../../../src/cloud/session-wire.ts";
import { activityFailureResult } from "../command/failures.ts";
import {
  ACTIVITY_EVENT,
  ACTIVITY_REQUEST_MAX_BYTES,
  activityTopic,
  parseActivityRequest,
  parseActivityStatusRequest,
} from "./core.ts";

const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer +([^\s]+)$/i;
const databaseUrl =
  Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!databaseUrl) {
  throw new Error("activity function requires SWARM_DATABASE_URL/SUPABASE_DB_URL");
}

const db = postgres(databaseUrl, withDatabaseTls({
  max: 1,
  prepare: false,
  idle_timeout: 3,
  connect_timeout: 10,
}, Deno.env.get("SWARM_DATABASE_TLS_CA_B64")));

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? BEARER_RE.exec(header) : null;
  return match?.[1] ?? null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ACTIVITY_REQUEST_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

class LocalActivityRefused extends Error {
  constructor(readonly response:Response) { super('Activity credential operation refused'); }
}
async function handle(request: Request): Promise<Response> {
  if (presentsAdminCredential(request)) {
    return json(401, { error: "unauthenticated" });
  }
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const token = bearer(request);
  if (token === null || !AGENT_TOKEN_RE.test(token)) {
    return json(401, { error: "unauthenticated" });
  }
  const body = await boundedJson(request);
  // A status frame is its own closed shape; it never falls back to the activity frame parser.
  const isStatus = !!body && typeof body === "object" && !Array.isArray(body) &&
    (body as Record<string, unknown>).kind !== undefined;
  const status = isStatus ? parseActivityStatusRequest(body) : null;
  const activity = isStatus ? null : parseActivityRequest(body);
  const frame = status ?? activity;
  if (frame === null) return json(400, { error: "invalid_request" });
  const tokenHash = await sha256(token);

  // One BEGIN with the isolation level and one statement for the local settings:
  // each round trip costs about 110 ms from the Falkenstein box to us-east-1.
  return await retryLocalAuthTransaction(()=>db.begin("isolation level read committed", async (tx) => {
    const result=await (async()=>{
    await tx`
      SELECT
        set_config('role', 'swarm_command', true),
        set_config('search_path', 'swarm, pg_catalog', true),
        set_config('lock_timeout', '5s', true)
    `;

    const plan=await planLocalOperation(tx,{hash:tokenHash,workspace:frame.workspaceId,sessionMode:'update'});
    if(plan) await lockLocalAuthPlan(tx,plan);
    const agent = plan ? await loadAgentCredential(tx, tokenHash, plan) : null;
    if (agent === null) return json(401, { error: "unauthenticated" });
    if (agent.transport !== "local") {
      return json(403, { error: "transport_unavailable" });
    }
    const memberships = await tx<{
      membership_revoked_at: Date | null;
      workspace_archived_at: Date | null;
    }[]>`
      SELECT
        m.revoked_at AS membership_revoked_at,
        w.archived_at AS workspace_archived_at
      FROM swarm.memberships AS m
      JOIN swarm.workspaces AS w ON w.workspace_id = m.workspace_id
      WHERE m.workspace_id = ${agent.principal_workspace_id}::uuid
        AND m.user_id = ${agent.owner_user_id}::uuid
    `;
    const membership = memberships[0];
    if (
      membership === undefined ||
      membership.workspace_archived_at !== null ||
      frame.workspaceId !== agent.principal_workspace_id ||
      await agentCredentialRevoked(
        tx,
        agent,
        membership.membership_revoked_at,
      )
    ) {
      return json(403, { error: "forbidden" });
    }

    /* Activity is an agent mutation: it broadcasts in the principal's name.
     * When the principal is managed, the same session proof the command fence
     * requires applies here. Reads stay on the read edge and never reach this. */
    const sessionResult = await enforceAgentSessionProof(tx, {
      principalId: agent.principal_id,
      workspaceId: agent.principal_workspace_id,
      proofParse: parseAgentSessionProofHeaders(request.headers),
      managedAt: agent.managed_at ?? null,
    });
    if (!sessionResult.ok) {
      return json(sessionResult.status, { error: sessionResult.error });
    }

    if (status !== null && status.state === "working") {
      // Working names one message, and only a live delivery addressed to this agent qualifies.
      const addressed = await tx`
        SELECT 1
        FROM swarm.signal_deliveries AS d
        JOIN swarm.signals AS s
          ON s.id = d.signal_id AND s.workspace_id = d.workspace_id
        WHERE d.workspace_id = ${agent.principal_workspace_id}::uuid
          AND d.signal_id = ${status.signalId}::uuid
          AND d.recipient_agent_principal_id = ${agent.principal_id}::uuid
          AND s.until > statement_timestamp()
      `;
      if (addressed.length === 0) return json(403, { error: "forbidden" });
    }
    if (status !== null) {
      // Server time sets the two-minute expiry. Stream and sequence order the frames, so a late
      // frame cannot revive or clear newer work. Idle clears the snapshot and keeps the order.
      await tx`
        INSERT INTO swarm.agent_message_working AS w
          (workspace_id, principal_id, signal_id, label, working_until, stream_id, sequence)
        VALUES (
          ${agent.principal_workspace_id}::uuid, ${agent.principal_id}::uuid,
          ${status.signalId}::uuid, ${status.label},
          CASE WHEN ${status.state} = 'working'
            THEN statement_timestamp() + interval '2 minutes' ELSE NULL END,
          ${status.streamId}::uuid, ${status.sequence}
        )
        ON CONFLICT (workspace_id, principal_id) DO UPDATE SET
          signal_id = EXCLUDED.signal_id,
          label = EXCLUDED.label,
          working_until = EXCLUDED.working_until,
          stream_id = EXCLUDED.stream_id,
          sequence = EXCLUDED.sequence,
          updated_at = statement_timestamp()
        WHERE w.stream_id IS DISTINCT FROM EXCLUDED.stream_id OR w.sequence < EXCLUDED.sequence
      `;
    }
    // The workspace topic admits every live member: a status event says only that this agent's
    // status changed. The message id and label stay behind message_status.
    const payload = status !== null ? {
      version: 1,
      kind: "status",
      workspaceId: agent.principal_workspace_id,
      principalId: agent.principal_id,
      emittedAt: new Date().toISOString(),
    } : {
      version: 1,
      workspaceId: agent.principal_workspace_id,
      principalId: agent.principal_id,
      streamId: activity!.streamId,
      sequence: activity!.sequence,
      phase: activity!.phase,
      signalId: activity!.signalId,
      toolTitle: activity!.toolTitle === null
        ? null
        : redactCredentialText(activity!.toolTitle).slice(0, 160) || "Tool",
      elapsedMs: activity!.elapsedMs,
      emittedAt: new Date().toISOString(),
    };
    // The built-in realtime.send function is not executable by swarm_command.
    // Restore the connection role only after every caller-controlled value has
    // passed the closed parser and agent/workspace authorization above. The
    // one privileged statement receives a derived topic and bound parameters.
    if (!plan || !await loadAgentCredential(tx,tokenHash,plan)) return json(403,{error:'forbidden'});
    await tx`SELECT swarm.record_renewal_grant_use(${agent.token_id}::uuid,${agent.device_id}::uuid,NULL)`;
    await tx.unsafe("RESET ROLE");
    await tx.unsafe("SET LOCAL search_path = pg_catalog");
    await tx`
      SELECT realtime.send(
        ${tx.json(payload)}::jsonb,
        ${ACTIVITY_EVENT},
        ${activityTopic(agent.principal_workspace_id)},
        true
      )
    `;
    // realtime.send may wait. Its row/notification is transactional: validate
    // after that final wait, and roll the entire send back if authority elapsed.
    await tx`SELECT set_config('role','swarm_command',true)`;
    const finalAgent=await recheckLocalCredential(tx,tokenHash,plan);
    const finalSession=finalAgent ? await enforceAgentSessionProof(tx,{
      principalId:finalAgent.principal_id,workspaceId:finalAgent.principal_workspace_id,
      proofParse:parseAgentSessionProofHeaders(request.headers),
    }) : null;
    if(!finalAgent || !finalSession?.ok) return json(403,{error:'forbidden'});
    return json(202, { status: "accepted" });
    })();
    if(result.status>=400) throw new LocalActivityRefused(result);
    return result;
  }).catch(async error=>{
    if(error instanceof LocalActivityRefused) return error.response;
    if(error instanceof LocalCredentialDenied) {
      await reportRevokedLocalCredential(async <T,>(run:(tx:postgres.TransactionSql<Record<string,unknown>>)=>Promise<T>):Promise<T> =>
        await db.begin("isolation level read committed", async tx=>{await tx`SELECT set_config('role','swarm_command',true)`;return await run(tx);}) as unknown as T,tokenHash);
      return json(403,{error:'forbidden'});
    }
    throw error;
  }));
}

Deno.serve((request) =>
  handle(request).catch((error) => {
    console.error("activity publish failed");
    const failure = activityFailureResult(error);
    return json(failure.status, failure.body);
  })
);
