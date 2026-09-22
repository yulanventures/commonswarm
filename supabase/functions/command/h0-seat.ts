/**
 * The H0 seat fence for the command edge's claim branch.
 *
 * A principal is an H0 seat exactly when swarm.agent_join_attempts names it
 * (20260916000002_agent_join_attempts.sql). The claim branch asks this module
 * and refuses. The h0 poll calls claimAgentInbox directly and does not.
 *
 * The code is the classifier. Callers must not branch on the message text.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const H0_SEAT_CLAIM_REFUSED = "h0_seat_uses_poll";

export const H0_SEAT_CLAIM_REFUSED_MESSAGE =
  "This seat receives messages through the h0 poll. Send POST /functions/v1/h0/poll with the seat token in Authorization: Bearer. claim_agent_inbox does not deliver to this seat.";

export function h0SeatClaimRefusal(isH0Seat: boolean): {
  error: typeof H0_SEAT_CLAIM_REFUSED;
  message: string;
} | null {
  if (isH0Seat !== true) return null;
  return {
    error: H0_SEAT_CLAIM_REFUSED,
    message: H0_SEAT_CLAIM_REFUSED_MESSAGE,
  };
}

export async function principalIsH0Seat(
  tx: Sql,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const rows = await tx<{ present: number }[]>`
    SELECT 1 AS present
    FROM swarm.agent_join_attempts
    WHERE principal_id = ${principalId}::uuid
      AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows.length > 0;
}
