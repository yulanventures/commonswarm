import { P0_AGENT_SCOPES } from "./worker-scopes.ts";
import { restoreAdminRoutineWorkspace } from "./admin-routine-workspace.ts";
import type postgres from "npm:postgres@3.4.9";
import {
  reduceWorkspace,
  RENEWAL_IDLE_PAUSE_DAYS,
} from "../_shared/protocol.js";
import type {
  AdminAccountState,
  AdminDecisionContext,
} from "../_shared/admin-authority.d.ts";
import type {
  AdminRoutineCommand,
  AdminRoutineContext,
  AdminRoutineDecision,
  RoutineCredential,
} from "../_shared/admin-routine.d.ts";
import type {
  WorkspaceEventEnvelope,
  WorkspaceState,
} from "../_shared/workspace-events.d.ts";

type Sql = postgres.TransactionSql<Record<string, unknown>>;
export interface AdminWorkerDelivery {
  credential: string;
  credential_id: string;
  principal_id: string;
  workspace_id: string;
  grant_id: string;
  recipient_connection_id: string;
  expires_at: number;
}
const date = (n: number | null) => n === null ? null : new Date(n);
const json = (tx: Sql, value: unknown) => tx.json(value as postgres.JSONValue);

/** All facts are read under the same grant/account and workspace locks as the write. */
export async function prepareAdminRoutine(
  tx: Sql,
  command: AdminRoutineCommand,
  state: AdminAccountState,
  ctx: AdminDecisionContext,
  deliveryConnection: string | null,
): Promise<AdminRoutineContext> {
  const owner = ctx.owner_user_id;
  // Also serializes with human account resource creation and invitation counters.
  await tx`SELECT user_id FROM swarm.users WHERE user_id = ${owner}::uuid FOR NO KEY UPDATE`; // Lock order: lockPrincipalName in command/index.ts.
  const workspaces =
    await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = ${command.workspace_id}::uuid FOR NO KEY UPDATE`; // Lock order: lockPrincipalName in command/index.ts.
  const streams = workspaces.length
    ? await tx<
      { stream_id: string; head_seq: string | number }[]
    >`SELECT stream_id, head_seq FROM swarm.streams WHERE workspace_id = ${command.workspace_id}::uuid AND kind = 'workspace' FOR UPDATE`
    : [];
  let workspace: WorkspaceState | null = null;
  if (workspaces.length && streams.length !== 1) {
    throw new Error("routine workspace stream missing");
  }
  if (streams[0]) {
    const [w] = await tx<
      Record<string, unknown>[]
    >`SELECT * FROM swarm.workspaces WHERE workspace_id=${command.workspace_id}::uuid`;
    const members = await tx<
      Record<string, unknown>[]
    >`SELECT * FROM swarm.memberships WHERE workspace_id=${command.workspace_id}::uuid ORDER BY user_id FOR SHARE`;
    const principals = await tx<
      Record<string, unknown>[]
    >`SELECT * FROM swarm.agent_principals WHERE workspace_id=${command.workspace_id}::uuid ORDER BY principal_id FOR SHARE`;
    const tokens = await tx<
      Record<string, unknown>[]
    >`SELECT t.* FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id) WHERE p.workspace_id=${command.workspace_id}::uuid`;
    const stamp = (v: unknown): number | null =>
      v === null ? null : new Date(v as string).getTime();
    workspace = {
      workspace: {
        workspace_id: command.workspace_id,
        name: String(w!.name),
        created_by: String(w!.created_by),
        created_at: stamp(w!.created_at)!,
        archived_at: stamp(w!.archived_at),
      },
      members: Object.fromEntries(members.map((m) => [String(m.user_id), {
        user_id: String(m.user_id),
        role: m.role as "owner" | "admin" | "member",
        joined_at: stamp(m.joined_at)!,
        invited_by: m.invited_by as string | null,
        revoked_at: stamp(m.revoked_at),
      }])),
      principals: Object.fromEntries(
        principals.map((p) => [String(p.principal_id), {
          principal_id: String(p.principal_id),
          owner_user_id: String(p.owner_user_id),
          name: String(p.name),
          model: p.model as string | null,
          transport: p.transport as "local" | "hosted_mcp",
          turn_only: p.turn_only === true,
          created_at: stamp(p.created_at)!,
          revoked_at: stamp(p.revoked_at),
        }]),
      ),
      tokens: Object.fromEntries(tokens.map((t) => [String(t.token_id), {
        token_id: String(t.token_id),
        principal_id: String(t.principal_id),
        run_id: String(t.run_id),
        task_id: t.task_id as string | null,
        epoch: t.epoch as number | null,
        scopes: t.scopes as string[],
        issued_at: stamp(t.issued_at)!,
        expires_at: stamp(t.expires_at)!,
        revoked_at: stamp(t.revoked_at),
      }])),
      invitations: {},
      owners_count: members.filter((m) =>
        m.role === "owner" && m.revoked_at === null
      ).length,
    };
    workspace = await restoreAdminRoutineWorkspace(tx, workspace, streams[0].stream_id, command.grant_id);
  }
  const [owned] = await tx<
    { n: string }[]
  >`SELECT count(*)::text AS n FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id) WHERE m.user_id=${owner}::uuid AND m.role='owner' AND m.revoked_at IS NULL AND w.archived_at IS NULL`;
  const [created] = await tx<
    { n: string }[]
  >`SELECT count(*)::text AS n FROM swarm.workspaces WHERE created_by=${owner}::uuid AND created_at > ${new Date(
    ctx.now - 86400000,
  )}`;
  const [invites] = await tx<
    { n: string }[]
  >`SELECT ((SELECT count(*) FROM swarm.invitations WHERE created_by=${owner}::uuid AND created_at > ${new Date(
    ctx.now - 86400000,
  )}) + (SELECT count(*) FROM swarm.admin_routine_invitations WHERE owner_user_id=${owner}::uuid AND created_at > ${new Date(
    ctx.now - 86400000,
  )}))::text AS n`;
  const [principals] = await tx<
    { n: string }[]
  >`SELECT count(*)::text AS n FROM swarm.agent_principals WHERE workspace_id=${command.workspace_id}::uuid AND revoked_at IS NULL`;
  const [members] = await tx<
    { n: string }[]
  >`SELECT ((SELECT count(*) FROM swarm.memberships WHERE workspace_id=${command.workspace_id}::uuid AND revoked_at IS NULL) + (SELECT count(*) FROM swarm.invitations WHERE workspace_id=${command.workspace_id}::uuid AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>${
    date(ctx.now)
  }) + (SELECT count(*) FROM swarm.admin_routine_invitations WHERE workspace_id=${command.workspace_id}::uuid AND invitation_kind='member' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>${
    date(ctx.now)
  }))::text AS n`;
  const [joins] = await tx<
    { mine: string; workspace: string }[]
  >`SELECT (SELECT count(*) FROM swarm.agent_join_credentials WHERE workspace_id=${command.workspace_id}::uuid AND owner_user_id=${owner}::uuid AND revoked_at IS NULL AND expires_at>${
    date(ctx.now)
  })::text AS mine, (SELECT count(*) FROM swarm.agent_join_credentials WHERE workspace_id=${command.workspace_id}::uuid AND revoked_at IS NULL AND expires_at>${
    date(ctx.now)
  })::text AS workspace`;
  const [routineJoins] = await tx<
    { mine: string; workspace: string }[]
  >`SELECT count(*) FILTER(WHERE recipient_user_id=${owner}::uuid)::text AS mine,count(*)::text AS workspace FROM swarm.admin_routine_invitations WHERE workspace_id=${command.workspace_id}::uuid AND invitation_kind='agent' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>${
    date(ctx.now)
  }`;
  const recipient = command.kind === "admin_invite_member"
    ? command.recipient_user_id
    : command.kind === "admin_issue_agent_invitation"
    ? command.intended_owner_user_id
    : owner;
  const recipients =
    await tx`SELECT user_id FROM swarm.users WHERE user_id=${recipient}::uuid`;
  let target_credential: RoutineCredential | null = null;
  if ("credential_id" in command || "predecessor_credential_id" in command) {
    const tokenId = "credential_id" in command
      ? command.credential_id
      : command.predecessor_credential_id;
    const rows = await tx<
      (Record<string, unknown> & {
        token_id: string;
        issued_at: Date;
        expires_at: Date;
        revoked_at: Date | null;
        first_used_at: Date | null;
        horizon_expires_at: Date | null;
      })[]
    >`
      SELECT t.*,g.kind,g.last_used_at,g.horizon_expires_at,g.max_successors,g.successors_used,g.suspension_active,g.bound_device_id,
        r.device_id,r.ended_at,d.revoked_at AS device_revoked_at,
        EXISTS(SELECT 1 FROM swarm.agent_tokens s WHERE s.predecessor_token_id=t.token_id AND s.revoked_at IS NULL) AS superseded,
        EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='lineage' AND z.target_id=t.lineage_id) AS lineage_revoked,
        g.revoked_at AS grant_revoked_at
      FROM swarm.agent_tokens t LEFT JOIN swarm.renewal_grants g USING(renewal_grant_id)
      JOIN swarm.agent_runs r ON r.run_id=t.run_id JOIN swarm.devices d USING(device_id)
      WHERE t.token_id=${tokenId}::uuid AND t.principal_id IN (SELECT principal_id FROM swarm.agent_principals WHERE workspace_id=${command.workspace_id}::uuid AND owner_user_id=${owner}::uuid)
      FOR UPDATE OF t
    `;
    const row = rows[0];
    if (row?.renewal_grant_id) {
      const [current] = await tx<
        Record<string, unknown>[]
      >`SELECT * FROM swarm.renewal_grants WHERE renewal_grant_id=${
        String(row.renewal_grant_id)
      }::uuid FOR UPDATE`;
      if (!current) throw new Error("routine renewal grant missing");
      for (
        const key of [
          "kind",
          "last_used_at",
          "horizon_expires_at",
          "max_successors",
          "successors_used",
          "suspension_active",
          "bound_device_id",
        ]
      ) row[key] = current[key];
      row.grant_revoked_at = current.revoked_at;
    }
    if (row) {
      target_credential = {
        credential_id: row.token_id,
        workspace_id: command.workspace_id,
        principal_id: String(row.principal_id),
        worker_lineage_id: String(row.lineage_id),
        parent_admin_grant_id: row.parent_admin_grant_id as string | null,
        recipient_connection_id: String(
          row.recipient_connection_id ??
            state.routine?.credentials[row.token_id]?.recipient_connection_id ??
            ("recipient_connection_id" in command
              ? command.recipient_connection_id
              : ""),
        ),
        worker_scope_names: row.scopes as string[],
        expires_at: row.expires_at.getTime(),
        horizon_expires_at: row.horizon_expires_at?.getTime() ?? null,
        bearer_seconds:
          state.routine?.credentials[row.token_id]?.bearer_seconds ??
            (row.expires_at.getTime() - row.issued_at.getTime()) / 1000,
        max_successors: row.max_successors as number | null,
        successors_used: Number(row.successors_used),
        kind: row.kind as "standing" | "timeboxed",
        revoked_at: row.revoked_at?.getTime() ??
          (row.lineage_revoked || row.grant_revoked_at ? ctx.now : null),
        first_used_at: row.first_used_at?.getTime() ?? null,
        superseded: row.superseded === true,
        suspended: row.suspension_active === true ||
          row.kind === "standing" &&
            (!row.last_used_at ||
              new Date(row.last_used_at as string).getTime() <=
                ctx.now - RENEWAL_IDLE_PAUSE_DAYS * 86400000),
        device_valid: row.ended_at === null && row.device_revoked_at === null &&
          (row.bound_device_id === null ||
            row.bound_device_id === row.device_id),
        run_id: String(row.run_id),
        task_id: String(row.task_id),
        epoch: Number(row.epoch),
        renewal_grant_id: String(row.renewal_grant_id),
        device_id: String(row.device_id),
      };
    }
  }
  const role = workspace?.members[owner]?.role;
  const rights = role === "owner" || role === "admin" || role === "member"
    ? [...P0_AGENT_SCOPES]
    : [];
  return {
    ...ctx,
    workspace,
    workspace_stream_id: streams[0]?.stream_id ?? crypto.randomUUID(),
    workspace_seq: Number(streams[0]?.head_seq ?? 0),
    owned_workspaces: Number(owned!.n),
    workspace_creations_last_day: Number(created!.n),
    invitations_last_day: Number(invites!.n),
    live_principals: Number(principals!.n),
    live_members_and_invitations: Number(members!.n),
    live_agent_invitations_person: Number(joins!.mine) +
      Number(routineJoins!.mine),
    live_agent_invitations_workspace: Number(joins!.workspace) +
      Number(routineJoins!.workspace),
    human_worker_scopes: rights,
    recipient_exists: recipients.length === 1,
    recipient_is_member: workspace?.members[recipient]?.revoked_at === null,
    delivery_connection_id: deliveryConnection,
    target_credential,
    principal_lineage_ids: "principal_id" in command
      ? (await tx<
        { lineage_id: string }[]
      >`SELECT DISTINCT lineage_id FROM swarm.agent_tokens WHERE principal_id=${command.principal_id}::uuid`)
        .map((row) => row.lineage_id)
      : [],
    nextResourceId: () => crypto.randomUUID(),
  };
}

export async function applyAdminRoutine(
  tx: Sql,
  command: AdminRoutineCommand,
  ctx: AdminRoutineContext,
  decision: AdminRoutineDecision,
): Promise<AdminWorkerDelivery | undefined> {
  if (!decision.ok) return;
  let delivery: AdminWorkerDelivery | undefined;
  let workspace = ctx.workspace;
  for (const e of decision.workspace_events) {
    workspace = reduceWorkspace(workspace, e);
    const p = e.payload as Record<string, unknown>;
    if (e.type === "WorkspaceCreated") {
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by,created_at) VALUES(${e.workspace_id}::uuid,${
        String(p.name)
      },${ctx.owner_user_id}::uuid,${date(ctx.now)})`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role,joined_at) VALUES(${e.workspace_id}::uuid,${ctx.owner_user_id}::uuid,'owner',${
        date(ctx.now)
      })`;
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${e.stream_id}::uuid,${e.workspace_id}::uuid,'workspace')`;
      await tx`INSERT INTO swarm.admin_created_workspaces(workspace_id,grant_id,scope_names) VALUES(${e.workspace_id}::uuid,${command.grant_id}::uuid,${decision
        .events[0]!.payload.applied_scope_names as string[]})`;
    } else if (e.type === "AgentPrincipalCreated") {
      await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,model,transport,turn_only,created_at,parent_admin_grant_id) VALUES(${
        String(p.principal_id)
      }::uuid,${e.workspace_id}::uuid,${ctx.owner_user_id}::uuid,${
        String(p.name)
      },${p.model as string | null},${String(p.transport)},${p
        .turn_only as boolean},${date(ctx.now)},${command.grant_id}::uuid)`;
    } else if (e.type === "AgentTokenMinted") {
      const event = decision.events.find((e) =>
        [
          "AdminSeatProvisioned",
          "AdminSeatRenewed",
          "AdminSeatCredentialReplaced",
        ].includes(e.type)
      )!;
      const c = event.payload.credential as unknown as RoutineCredential;
      if (command.kind === "admin_provision_seat") {
        await tx`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${c.device_id}::uuid,${ctx.owner_user_id}::uuid,'Delegated seat runtime')`;
        await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES(${c.run_id}::uuid,${c.principal_id}::uuid,${c.device_id}::uuid)`;
        await tx`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,created_by,created_at,bound_device_id) VALUES(${c.renewal_grant_id}::uuid,${e.workspace_id}::uuid,${c.principal_id}::uuid,${c.run_id}::uuid,'timeboxed',${c.max_successors},0,${
          date(c.horizon_expires_at)
        },${ctx.owner_user_id}::uuid,${date(ctx.now)},NULL)`;
      }
      const secret = "swm_agt_" +
        btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
          .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
      );
      // Undelivered replacement uses the same worker lineage and horizon. Its spend
      // is recorded here; ordinary successor spend remains in the existing SQL fence.
      const predecessor = command.kind === "admin_renew_seat"
        ? command.predecessor_credential_id
        : null;
      if (command.kind === "admin_replace_undelivered_seat_credential") {
        await tx`UPDATE swarm.renewal_grants SET successors_used=successors_used+1 WHERE renewal_grant_id=${c.renewal_grant_id}::uuid`;
      }
      await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,issued_at,expires_at,lineage_id,renewal_grant_id,predecessor_token_id,parent_admin_grant_id,recipient_connection_id) VALUES(${c.credential_id}::uuid,${c.principal_id}::uuid,${c.run_id}::uuid,${c.task_id}::uuid,${c.epoch},${
        json(tx, c.worker_scope_names)
      },${hash},${date(ctx.now)},${
        date(c.expires_at)
      },${c.worker_lineage_id}::uuid,${c.renewal_grant_id}::uuid,${predecessor}::uuid,${c.parent_admin_grant_id}::uuid,${c.recipient_connection_id}::uuid)`;
      delivery = {
        credential: secret,
        credential_id: c.credential_id,
        principal_id: c.principal_id,
        workspace_id: e.workspace_id,
        grant_id: command.grant_id,
        recipient_connection_id: c.recipient_connection_id,
        expires_at: c.expires_at,
      };
    } else if (e.type === "AgentPrincipalRevoked") {
      await tx`UPDATE swarm.agent_principals SET revoked_at=${
        date(ctx.now)
      } WHERE principal_id=${String(p.principal_id)}::uuid`;
      await tx`UPDATE swarm.hosted_mcp_seats SET revoked_at=coalesce(revoked_at,${
        date(ctx.now)
      }) WHERE principal_id=${String(p.principal_id)}::uuid`;
      await tx`UPDATE swarm.agent_tokens SET revoked_at=coalesce(revoked_at,${
        date(ctx.now)
      }) WHERE principal_id=${String(p.principal_id)}::uuid`;
      await tx`UPDATE swarm.renewal_grants SET revoked_at=coalesce(revoked_at,${
        date(ctx.now)
      }),revoked_by=coalesce(revoked_by,${ctx.owner_user_id}::uuid) WHERE principal_id=${
        String(p.principal_id)
      }::uuid`;
      await tx`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by) VALUES('principal',${
        String(p.principal_id)
      }::uuid,${ctx.owner_user_id}::uuid) ON CONFLICT DO NOTHING`;
    } else if (e.type === "AgentTokenRevoked") {
      if (command.kind === "admin_replace_undelivered_seat_credential") {
        // A never-used delivery is retired individually; revoking its entire
        // lineage would also revoke the deliberate bounded replacement.
        await tx`UPDATE swarm.agent_tokens SET revoked_at=${
          date(ctx.now)
        } WHERE token_id=${String(p.token_id)}::uuid AND first_used_at IS NULL`;
      } else {
        await tx`UPDATE swarm.agent_tokens SET revoked_at=coalesce(revoked_at,${
          date(ctx.now)
        }) WHERE lineage_id=(SELECT lineage_id FROM swarm.agent_tokens WHERE token_id=${
          String(p.token_id)
        }::uuid)`;
        await tx`INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by) SELECT 'lineage',lineage_id,${ctx.owner_user_id}::uuid FROM swarm.agent_tokens WHERE token_id=${
          String(p.token_id)
        }::uuid ON CONFLICT DO NOTHING`;
      }
    }
    await tx`INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,actor_run,occurred_at_server,payload,admin_identity_id,grant_id,grant_manifest_digest) VALUES(${e.workspace_id}::uuid,${e.stream_id}::uuid,${e.seq},${e.event_id}::uuid,${e.command_id},${e.type},1,NULL,NULL,NULL,${
      date(e.occurred_at_server)
    },${json(tx, e.payload)},${
      ctx.actor.kind === "delegated_admin" ? ctx.actor.admin_identity_id : null
    }::uuid,${command.grant_id}::uuid,${
      decision.events[0]?.grant_manifest_digest ?? null
    })`;
  }
  if (decision.workspace_events.length) {
    await tx`UPDATE swarm.streams SET head_seq=${
      decision.workspace_events.at(-1)!.seq
    } WHERE stream_id=${ctx.workspace_stream_id}::uuid`;
  }
  for (const event of decision.events) {
    const p = event.payload;
    if (
      event.type === "AdminMemberInvited" ||
      event.type === "AdminAgentInvitationIssued"
    ) {
      await tx`INSERT INTO swarm.admin_routine_invitations(invitation_id,workspace_id,parent_admin_grant_id,owner_user_id,recipient_user_id,recipient_connection_id,invitation_kind,expires_at,created_at,projection) VALUES(${
        String(p.invitation_id)
      }::uuid,${command.workspace_id}::uuid,${command.grant_id}::uuid,${ctx.owner_user_id}::uuid,${
        String(p.recipient_user_id)
      }::uuid,${p.recipient_connection_id as string | null}::uuid,${
        String(p.invitation_kind)
      },${date(Number(p.expires_at))},${date(ctx.now)},${json(tx, p)})`;
    }
    if (event.type === "AdminInvitationRevoked") {
      await tx`UPDATE swarm.admin_routine_invitations SET revoked_at=${
        date(ctx.now)
      } WHERE invitation_id=${String(p.invitation_id)}::uuid`;
    }
  }
  return delivery;
}
