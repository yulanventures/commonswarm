import type postgres from "npm:postgres@3.4.9";
import { ADMIN_ROUTINE_EVENT_TYPES, reduceAdminRoutine } from "../_shared/protocol.js";
import type { WorkspaceEventEnvelope, WorkspaceState } from "../_shared/workspace-events.d.ts";

type ReplayRow = Pick<WorkspaceEventEnvelope, "type" | "schema_version" |
  "actor_user" | "actor_agent_principal" | "admin_identity_id" | "grant_id" |
  "grant_manifest_digest"> & {
  seq: string | number; occurred_at_server: Date; payload: Record<string, unknown>;
};

/** Restore this grant's reducer state under the locked workspace stream.
 * Policy and account-wide budgets come from the account projection; this read
 * only supplies prior workspace facts required to fold the next routine event.
 */
export async function restoreAdminRoutineWorkspace(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  workspace: WorkspaceState,
  streamId: string,
  grantId: string,
): Promise<WorkspaceState> {
  const events = await tx<ReplayRow[]>`
    SELECT seq, type, schema_version, actor_user, actor_agent_principal,
      admin_identity_id, grant_id, grant_manifest_digest, occurred_at_server, payload
    FROM swarm.admin_routine_workspace_history(
      ${workspace.workspace.workspace_id}::uuid, ${grantId}::uuid, ${streamId}::uuid)
    ORDER BY seq
  `;
  let routine = workspace.admin_routine;
  for (const event of events) {
    if (!(ADMIN_ROUTINE_EVENT_TYPES as readonly string[]).includes(event.type) || event.schema_version !== 1 ||
      event.grant_id !== grantId || !event.admin_identity_id || !event.grant_manifest_digest ||
      event.actor_user !== null || event.actor_agent_principal !== null ||
      !Number.isSafeInteger(Number(event.seq))) throw new Error("invalid delegated workspace history");
    routine = reduceAdminRoutine(routine, { type: event.type, grant_id: event.grant_id,
      occurred_at_server: event.occurred_at_server.getTime(), payload: event.payload });
  }
  return { ...workspace, ...(routine === undefined ? {} : { admin_routine: routine }) };
}
