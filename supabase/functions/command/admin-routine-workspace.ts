import type postgres from "npm:postgres@3.4.9";
import { ADMIN_ROUTINE_EVENT_TYPES, reduceWorkspace } from "../_shared/protocol.js";
import type { WorkspaceEventEnvelope, WorkspaceState } from "../_shared/workspace-events.d.ts";

/** Ordinary table projections do not contain the delegated workspace reducer state.
 * Rebuild it from this locked stream's durable events, including other grantors.
 * Never substitute the caller's account projection for workspace history.
 */
export async function restoreAdminRoutineWorkspace(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  workspace: WorkspaceState,
  streamId: string,
): Promise<WorkspaceState> {
  const events = await tx<(Omit<WorkspaceEventEnvelope, "seq" | "occurred_at_server"> & {
    seq: string | number; occurred_at_server: Date;
  })[]>`
    SELECT * FROM swarm.events
    WHERE workspace_id = ${workspace.workspace.workspace_id}::uuid
      AND stream_id = ${streamId}::uuid AND type = ANY(${ADMIN_ROUTINE_EVENT_TYPES})
    ORDER BY seq
  `;
  for (const event of events) {
    workspace = reduceWorkspace(workspace, { ...event,
      seq: Number(event.seq), occurred_at_server: event.occurred_at_server.getTime() });
  }
  return workspace;
}
