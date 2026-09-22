/**
 * Database wiring for H0 poll and ack.
 *
 * core.ts stays a leaf. This module opens Postgres with the same environment
 * names the command function uses: SWARM_DATABASE_URL, else SUPABASE_DB_URL,
 * and SWARM_DATABASE_TLS_CA_B64 for the private CA.
 *
 * The wait is a timer. It is not a CPU spin, and it is not inside a
 * transaction. The pool connection is back in the pool before the wait starts.
 * The poll calls claimAgentInbox directly, so the command-edge seat fence does
 * not apply. ack calls ackAgentDelivery and advances delivery state only there.
 * ackBatch closes the batch row and writes no delivery column.
 */
import postgres from "npm:postgres@3.4.9";
import { withDatabaseTls } from "../_shared/database-options.ts";
import {
  agentCredentialRevoked,
  enforceAgentSessionProof,
  loadAgentCredential,
} from "../_shared/agent-auth.ts";
import {
  agentSessionErrorStatus,
  parseAgentSessionProofHeaders,
  type AgentSessionErrorCode,
} from "../../../src/cloud/session-wire.ts";
import {
  ackAgentDelivery,
  claimAgentInbox,
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_CLIENT_ERROR_CODES,
  hydrateDeliveryRefs,
  type AckResult,
  type DeliveryAckOutcome,
  type DeliveryLedgerRef,
  type HydratedDelivery,
} from "../command/durable-delivery.ts";
import { H0_CACHE_CONTROL, H0_ROBOTS_TAG } from "./core.ts";
import {
  H0_ACK_BATCH_MISMATCH,
  H0_ACK_BATCH_MISMATCH_MESSAGE,
  H0_ACK_BATCH_UNKNOWN,
  H0_ACK_BATCH_UNKNOWN_MESSAGE,
  H0_BEARER_QUERY_REFUSED,
  H0_BEARER_QUERY_REFUSED_MESSAGE,
  H0_INVALID_REQUEST,
  H0_POLL_BATCH_LIMIT,
  H0_POLL_IN_PROGRESS,
  H0_POLL_IN_PROGRESS_MESSAGE,
  H0_POLL_IN_PROGRESS_STATUS,
  h0BearerInQuery,
  h0PollLockDurationMs,
  parseH0AckBody,
  parseH0PollBody,
  type H0AckBody,
} from "./parse.ts";

const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer +([^\s]+)$/i;
const MAX_BODY_BYTES = 16 * 1024;
const WAIT_SLICE_MS = 1_000;

type Tx = postgres.TransactionSql<Record<string, unknown>>;

interface Seat {
  principalId: string;
  workspaceId: string;
  ownerUserId: string;
  managed: boolean;
}

interface PollResponseBody {
  batchId: string | null;
  listener_instance_id: string;
  deliveries: HydratedDelivery[];
}

type Collected =
  | { kind: "ready" | "empty"; body: PollResponseBody }
  | { kind: "error"; status: number; error: string; message: string };

type Authed =
  | { ok: true; seat: Seat }
  | { ok: false; status: number; error: string; message: string };

let database: postgres.Sql | null = null;

function h0Database(): postgres.Sql {
  if (database !== null) return database;
  const databaseUrl = Deno.env.get("SWARM_DATABASE_URL") ??
    Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) {
    throw new Error(
      "h0 function requires SWARM_DATABASE_URL/SUPABASE_DB_URL",
    );
  }
  database = postgres(databaseUrl, withDatabaseTls({
    max: 1,
    prepare: false,
    idle_timeout: 3,
    connect_timeout: 10,
  }, Deno.env.get("SWARM_DATABASE_TLS_CA_B64")));
  return database;
}

function verbHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": H0_CACHE_CONTROL,
    "x-robots-tag": H0_ROBOTS_TAG,
  });
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: verbHeaders() });
}

export function h0VerbFailure(): Response {
  return json(500, { error: "internal_error" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function setRole(tx: Tx): Promise<void> {
  await tx`
    SELECT
      set_config('role', 'swarm_command', true),
      set_config('search_path', 'swarm, pg_catalog', true),
      set_config('lock_timeout', '5s', true)
  `;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) return {};
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return {};
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function prelude(request: Request): Response | null {
  if (request.method !== "POST") {
    const response = json(405, { error: "method_not_allowed" });
    response.headers.set("allow", "POST");
    return response;
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { error: H0_INVALID_REQUEST, message: "The request URL is not valid." });
  }
  if (h0BearerInQuery(url)) {
    return json(400, {
      error: H0_BEARER_QUERY_REFUSED,
      message: H0_BEARER_QUERY_REFUSED_MESSAGE,
    });
  }
  return null;
}

async function authenticate(tx: Tx, tokenHash: Uint8Array): Promise<Authed> {
  const agent = await loadAgentCredential(tx, tokenHash);
  if (agent === null) {
    return {
      ok: false,
      status: 401,
      error: "unauthenticated",
      message: "Send the seat token in Authorization: Bearer.",
    };
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
    await agentCredentialRevoked(tx, agent, membership.membership_revoked_at)
  ) {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "This seat cannot poll or ack.",
    };
  }
  return {
    ok: true,
    seat: {
      principalId: agent.principal_id,
      workspaceId: agent.principal_workspace_id,
      ownerUserId: agent.owner_user_id,
      managed: agent.managed_at !== null,
    },
  };
}

async function sessionOrRefusal(
  tx: Tx,
  seat: Seat,
  request: Request,
): Promise<
  | { ok: true; session: { session_id: string; generation: number } | null }
  | { ok: false; status: number; error: AgentSessionErrorCode }
> {
  const proofParse = parseAgentSessionProofHeaders(request.headers);
  const session = await enforceAgentSessionProof(tx, {
    principalId: seat.principalId,
    workspaceId: seat.workspaceId,
    proofParse,
  });
  if (!session.ok) return session;
  return {
    ok: true,
    session: proofParse.ok
      ? {
        session_id: proofParse.proof.session_id,
        generation: proofParse.proof.generation,
      }
      : null,
  };
}

function refsFrom(rows: Array<{
  signal_id: string;
  lease_id: string;
  leased_until: Date | string;
  sender_owner_relation: string;
}>): DeliveryLedgerRef[] | null {
  const refs: DeliveryLedgerRef[] = [];
  for (const row of rows) {
    if (
      row.sender_owner_relation !== "same_owner" &&
      row.sender_owner_relation !== "cross_owner" &&
      row.sender_owner_relation !== "unknown"
    ) return null;
    refs.push({
      signal_id: row.signal_id,
      lease_id: row.lease_id,
      leased_until: asIso(row.leased_until),
      sender_owner_relation: row.sender_owner_relation,
    });
  }
  return refs;
}

async function ownLeaseRefs(
  tx: Tx,
  seat: Seat,
  listenerId: string,
  limit: number,
): Promise<DeliveryLedgerRef[]> {
  if (limit <= 0) return [];
  const rows = await tx<{
    signal_id: string;
    lease_id: string;
    leased_until: Date | string;
    sender_owner_relation: string;
  }[]>`
    SELECT
      d.signal_id::text,
      d.lease_id::text,
      d.leased_until,
      CASE
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
         AND s.from_principal = ${seat.ownerUserId}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
         AND author.owner_user_id = ${seat.ownerUserId}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        ELSE 'unknown'
      END::text AS sender_owner_relation
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    LEFT JOIN swarm.agent_principals AS author
      ON s.from_kind = 'agent'
     AND author.workspace_id = s.workspace_id
     AND author.principal_id = s.from_principal
     AND author.revoked_at IS NULL
    LEFT JOIN swarm.memberships AS author_member
      ON author_member.workspace_id = s.workspace_id
     AND author_member.user_id = COALESCE(
       author.owner_user_id,
       CASE WHEN s.from_kind = 'user' THEN s.from_principal END
     )
     AND author_member.revoked_at IS NULL
    WHERE d.workspace_id = ${seat.workspaceId}::uuid
      AND d.recipient_agent_principal_id = ${seat.principalId}::uuid
      AND d.acked_at IS NULL
      AND d.lease_id IS NOT NULL
      AND d.leased_until > statement_timestamp()
      AND d.leased_by = ${listenerId}::uuid
    ORDER BY d.enqueued_at ASC, d.signal_id ASC
    LIMIT ${limit}
  `;
  return refsFrom(rows) ?? [];
}

async function listedLeaseRefs(
  tx: Tx,
  seat: Seat,
  listenerId: string,
  leaseIds: string[],
): Promise<DeliveryLedgerRef[] | null> {
  if (leaseIds.length === 0) return [];
  const rows = await tx<{
    signal_id: string;
    lease_id: string;
    leased_until: Date | string;
    sender_owner_relation: string;
  }[]>`
    SELECT
      d.signal_id::text,
      d.lease_id::text,
      d.leased_until,
      CASE
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
         AND s.from_principal = ${seat.ownerUserId}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'user'
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
         AND author.owner_user_id = ${seat.ownerUserId}::uuid
          THEN 'same_owner'
        WHEN s.from_kind = 'agent'
         AND author.principal_id IS NOT NULL
         AND author_member.user_id IS NOT NULL
          THEN 'cross_owner'
        ELSE 'unknown'
      END::text AS sender_owner_relation
    FROM unnest(${leaseIds}::uuid[]) WITH ORDINALITY AS listed(lease_id, ordinal)
    JOIN swarm.signal_deliveries AS d
      ON d.lease_id = listed.lease_id
     AND d.workspace_id = ${seat.workspaceId}::uuid
     AND d.recipient_agent_principal_id = ${seat.principalId}::uuid
     AND d.acked_at IS NULL
     AND d.leased_until > statement_timestamp()
     AND d.leased_by = ${listenerId}::uuid
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    LEFT JOIN swarm.agent_principals AS author
      ON s.from_kind = 'agent'
     AND author.workspace_id = s.workspace_id
     AND author.principal_id = s.from_principal
     AND author.revoked_at IS NULL
    LEFT JOIN swarm.memberships AS author_member
      ON author_member.workspace_id = s.workspace_id
     AND author_member.user_id = COALESCE(
       author.owner_user_id,
       CASE WHEN s.from_kind = 'user' THEN s.from_principal END
     )
     AND author_member.revoked_at IS NULL
    ORDER BY listed.ordinal
  `;
  return refsFrom(rows);
}

async function closeExpired(tx: Tx, seat: Seat): Promise<void> {
  await tx`
    UPDATE swarm.h0_poll_batches
    SET status = 'closed', closed_at = statement_timestamp()
    WHERE workspace_id = ${seat.workspaceId}::uuid
      AND principal_id = ${seat.principalId}::uuid
      AND status = 'active'
      AND expires_at <= statement_timestamp()
  `;
}

async function applyAckBatch(
  tx: Tx,
  seat: Seat,
  ackBatch: string,
): Promise<Collected | null> {
  const active = await tx<{ batch_id: string }[]>`
    SELECT batch_id::text
    FROM swarm.h0_poll_batches
    WHERE workspace_id = ${seat.workspaceId}::uuid
      AND principal_id = ${seat.principalId}::uuid
      AND status = 'active'
    LIMIT 1
  `;
  const current = active[0]?.batch_id ?? null;
  if (current === ackBatch) {
    await tx`
      UPDATE swarm.h0_poll_batches
      SET status = 'closed', closed_at = statement_timestamp()
      WHERE workspace_id = ${seat.workspaceId}::uuid
        AND principal_id = ${seat.principalId}::uuid
        AND batch_id = ${ackBatch}::uuid
        AND status = 'active'
    `;
    return null;
  }
  if (current !== null) {
    return {
      kind: "error",
      status: 409,
      error: H0_ACK_BATCH_MISMATCH,
      message: H0_ACK_BATCH_MISMATCH_MESSAGE,
    };
  }
  const known = await tx<{ batch_id: string }[]>`
    SELECT batch_id::text
    FROM swarm.h0_poll_batches
    WHERE workspace_id = ${seat.workspaceId}::uuid
      AND principal_id = ${seat.principalId}::uuid
      AND batch_id = ${ackBatch}::uuid
    LIMIT 1
  `;
  if (known.length === 0) {
    return {
      kind: "error",
      status: 409,
      error: H0_ACK_BATCH_UNKNOWN,
      message: H0_ACK_BATCH_UNKNOWN_MESSAGE,
    };
  }
  return null;
}

async function collect(
  tx: Tx,
  seat: Seat,
  listenerId: string,
  ackBatch: string | null,
  session: { session_id: string; generation: number } | null,
): Promise<Collected> {
  await closeExpired(tx, seat);
  if (ackBatch !== null) {
    const problem = await applyAckBatch(tx, seat, ackBatch);
    if (problem !== null) return problem;
  }
  const active = await tx<{ batch_id: string; lease_ids: string[] }[]>`
    SELECT batch_id::text, lease_ids::text[] AS lease_ids
    FROM swarm.h0_poll_batches
    WHERE workspace_id = ${seat.workspaceId}::uuid
      AND principal_id = ${seat.principalId}::uuid
      AND status = 'active'
    LIMIT 1
  `;
  const open = active[0];
  if (open !== undefined) {
    const refs = await listedLeaseRefs(tx, seat, listenerId, open.lease_ids);
    if (refs === null) throw new Error("h0 poll lease refs were unreadable");
    const hydrated = await hydrate(tx, seat, refs);
    return {
      kind: "ready",
      body: {
        batchId: open.batch_id,
        listener_instance_id: listenerId,
        deliveries: hydrated,
      },
    };
  }

  const own = await ownLeaseRefs(tx, seat, listenerId, H0_POLL_BATCH_LIMIT);
  const slots = H0_POLL_BATCH_LIMIT - own.length;
  let claimed: DeliveryLedgerRef[] = [];
  if (slots > 0) {
    const ledger = await claimAgentInbox(tx, {
      workspaceId: seat.workspaceId,
      recipientPrincipalId: seat.principalId,
      receiverOwnerUserId: seat.ownerUserId,
      listenerInstanceId: listenerId,
      limit: slots,
      managed: seat.managed,
      session,
    });
    if (ledger === null) {
      return {
        kind: "error",
        status: 403,
        error: "delivery_unavailable",
        message: "This seat cannot claim messages.",
      };
    }
    claimed = ledger.delivery_refs;
  }
  const refs = [...own, ...claimed];
  if (refs.length === 0) {
    return {
      kind: "empty",
      body: {
        batchId: null,
        listener_instance_id: listenerId,
        deliveries: [],
      },
    };
  }
  const hydrated = await hydrate(tx, seat, refs);
  const batchId = crypto.randomUUID();
  const leaseIds = refs.map((ref) => ref.lease_id);
  const inserted = await tx<{ batch_id: string }[]>`
    INSERT INTO swarm.h0_poll_batches (
      workspace_id, principal_id, batch_id, lease_ids, status, expires_at
    )
    SELECT
      ${seat.workspaceId}::uuid,
      ${seat.principalId}::uuid,
      ${batchId}::uuid,
      ${leaseIds}::uuid[],
      'active',
      min(d.leased_until)
    FROM swarm.signal_deliveries AS d
    WHERE d.workspace_id = ${seat.workspaceId}::uuid
      AND d.recipient_agent_principal_id = ${seat.principalId}::uuid
      AND d.lease_id = ANY(${leaseIds}::uuid[])
    RETURNING batch_id::text
  `;
  if (inserted.length === 0) throw new Error("h0 poll batch was not stored");
  return {
    kind: "ready",
    body: {
      batchId,
      listener_instance_id: listenerId,
      deliveries: hydrated,
    },
  };
}

async function hydrate(
  tx: Tx,
  seat: Seat,
  refs: DeliveryLedgerRef[],
): Promise<HydratedDelivery[]> {
  const hydrated = await hydrateDeliveryRefs(tx, {
    workspaceId: seat.workspaceId,
    recipientPrincipalId: seat.principalId,
    recipientOwnerUserId: seat.ownerUserId,
    refs,
  });
  if (hydrated === null) throw new Error("h0 poll hydration failed");
  return hydrated;
}

async function acquireLock(
  tx: Tx,
  seat: Seat,
  waitSeconds: number,
): Promise<{ holder: string; listenerInstanceId: string } | null> {
  const holder = crypto.randomUUID();
  const durationMs = h0PollLockDurationMs(waitSeconds);
  const rows = await tx<{ holder: string; listener_instance_id: string }[]>`
    INSERT INTO swarm.h0_poll_locks AS poll_lock (
      workspace_id, principal_id, holder, listener_instance_id,
      acquired_at, expires_at
    ) VALUES (
      ${seat.workspaceId}::uuid,
      ${seat.principalId}::uuid,
      ${holder}::uuid,
      gen_random_uuid(),
      statement_timestamp(),
      statement_timestamp() + (${durationMs} * interval '1 millisecond')
    )
    ON CONFLICT (workspace_id, principal_id) DO UPDATE
    SET
      holder = EXCLUDED.holder,
      acquired_at = statement_timestamp(),
      expires_at = EXCLUDED.expires_at
    WHERE poll_lock.expires_at <= statement_timestamp()
    RETURNING holder::text, listener_instance_id::text
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return { holder: row.holder, listenerInstanceId: row.listener_instance_id };
}

async function releaseLock(seat: Seat, holder: string): Promise<void> {
  await h0Database().begin(async (tx) => {
    await setRole(tx);
    await tx`
      UPDATE swarm.h0_poll_locks
      SET expires_at = statement_timestamp()
      WHERE workspace_id = ${seat.workspaceId}::uuid
        AND principal_id = ${seat.principalId}::uuid
        AND holder = ${holder}::uuid
    `;
  });
}

function ackHttp(result: AckResult): Response | null {
  if (result.status === "accepted" || result.status === "idempotent") return null;
  if (result.status === "unavailable") {
    return json(403, {
      error: "delivery_unavailable",
      message: "That message is not an unexpired lease for this seat.",
    });
  }
  if (result.status === "conflict") {
    return json(409, {
      error: "delivery_ack_conflict",
      message: "That message was already acknowledged with a different outcome.",
    });
  }
  const code: AgentSessionErrorCode = result.status === "not_surfaced"
    ? "delivery_not_surfaced"
    : result.status === "session_conflict"
    ? "session_conflict"
    : "session_expired";
  return json(agentSessionErrorStatus(code), { error: code });
}

export async function handleH0PollRequest(request: Request): Promise<Response> {
  const early = prelude(request);
  if (early !== null) return early;
  const token = bearer(request);
  if (token === null || !AGENT_TOKEN_RE.test(token)) {
    return json(401, {
      error: "unauthenticated",
      message: "Send the seat token in Authorization: Bearer.",
    });
  }
  const parsed = parseH0PollBody(await readBody(request));
  if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message });
  const tokenHash = await sha256(token);
  let held: { seat: Seat; holder: string } | null = null;
  try {
    const opened = await h0Database().begin(async (tx) => {
      await setRole(tx);
      const auth = await authenticate(tx, tokenHash);
      if (!auth.ok) return { acquired: false as const, response: json(auth.status, { error: auth.error, message: auth.message }) };
      const session = await sessionOrRefusal(tx, auth.seat, request);
      if (!session.ok) {
        return {
          acquired: false as const,
          response: json(session.status, { error: session.error }),
        };
      }
      const lock = await acquireLock(tx, auth.seat, parsed.body.wait);
      if (lock === null) {
        return {
          acquired: false as const,
          response: json(H0_POLL_IN_PROGRESS_STATUS, {
            error: H0_POLL_IN_PROGRESS,
            message: H0_POLL_IN_PROGRESS_MESSAGE,
          }),
        };
      }
      const collected = await collect(
        tx,
        auth.seat,
        lock.listenerInstanceId,
        parsed.body.ackBatch,
        session.session,
      );
      return {
        acquired: true as const,
        seat: auth.seat,
        holder: lock.holder,
        listenerInstanceId: lock.listenerInstanceId,
        collected,
      };
    });
    if (!opened.acquired) return opened.response;
    held = { seat: opened.seat, holder: opened.holder };
    let current = opened.collected;
    const deadline = Date.now() + parsed.body.wait * 1_000;
    while (current.kind === "empty" && Date.now() < deadline) {
      const slice = Math.min(WAIT_SLICE_MS, deadline - Date.now());
      if (slice > 0) await sleep(slice);
      current = await h0Database().begin(async (tx) => {
        await setRole(tx);
        const auth = await authenticate(tx, tokenHash);
        if (!auth.ok) {
          return {
            kind: "error" as const,
            status: auth.status,
            error: auth.error,
            message: auth.message,
          };
        }
        const session = await sessionOrRefusal(tx, auth.seat, request);
        if (!session.ok) {
          return {
            kind: "error" as const,
            status: session.status,
            error: session.error,
            message: "Send the session proof this managed seat requires.",
          };
        }
        const still = await tx<{ held: number }[]>`
          SELECT 1 AS held
          FROM swarm.h0_poll_locks
          WHERE workspace_id = ${auth.seat.workspaceId}::uuid
            AND principal_id = ${auth.seat.principalId}::uuid
            AND holder = ${opened.holder}::uuid
            AND expires_at > statement_timestamp()
        `;
        if (still.length === 0) {
          return {
            kind: "error" as const,
            status: H0_POLL_IN_PROGRESS_STATUS,
            error: H0_POLL_IN_PROGRESS,
            message: "This poll's lock ended. Poll again.",
          };
        }
        return await collect(
          tx,
          auth.seat,
          opened.listenerInstanceId,
          null,
          session.session,
        );
      });
    }
    if (current.kind === "error") {
      return json(current.status, { error: current.error, message: current.message });
    }
    return json(200, {
      batchId: current.body.batchId,
      listener_instance_id: current.body.listener_instance_id,
      deliveries: current.body.deliveries,
    });
  } finally {
    if (held !== null) {
      try {
        await releaseLock(held.seat, held.holder);
      } catch {
        console.error("h0 poll lock release failed");
      }
    }
  }
}

export async function handleH0AckRequest(request: Request): Promise<Response> {
  const early = prelude(request);
  if (early !== null) return early;
  const token = bearer(request);
  if (token === null || !AGENT_TOKEN_RE.test(token)) {
    return json(401, {
      error: "unauthenticated",
      message: "Send the seat token in Authorization: Bearer.",
    });
  }
  const parsed = parseH0AckBody(await readBody(request), {
    ackOutcomes: DELIVERY_ACK_OUTCOMES,
    ackErrorCodes: DELIVERY_CLIENT_ERROR_CODES,
  });
  if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message });
  const tokenHash = await sha256(token);
  return await h0Database().begin(async (tx) => {
    await setRole(tx);
    const auth = await authenticate(tx, tokenHash);
    if (!auth.ok) {
      return json(auth.status, { error: auth.error, message: auth.message });
    }
    const session = await sessionOrRefusal(tx, auth.seat, request);
    if (!session.ok) return json(session.status, { error: session.error });
    return await ackDelivery(tx, auth.seat, parsed.body, session.session);
  });
}

async function ackDelivery(
  tx: Tx,
  seat: Seat,
  body: H0AckBody,
  session: { session_id: string; generation: number } | null,
): Promise<Response> {
  const result = await ackAgentDelivery(tx, {
    workspaceId: seat.workspaceId,
    recipientPrincipalId: seat.principalId,
    signalId: body.signal_id,
    leaseId: body.lease_id,
    listenerInstanceId: body.listener_instance_id,
    outcome: body.outcome as DeliveryAckOutcome,
    lastErrorCode: body.last_error_code,
    ...(body.surfaced === undefined ? {} : { surfaced: body.surfaced }),
    managed: seat.managed,
    proof: session,
  });
  const refused = ackHttp(result);
  if (refused !== null) return refused;
  if (!("response" in result)) return json(500, { error: "internal_error" });
  return json(200, {
    ok: true,
    status: "accepted",
    signal_id: result.response.signal_id,
    outcome: result.response.outcome,
  });
}
