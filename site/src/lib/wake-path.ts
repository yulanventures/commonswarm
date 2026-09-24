import { WAKE_STALE_LABEL, WAKE_STALE_MS } from "../../../src/cloud/idle-poll";

/** Browser roster refresh cadence; the stale decision itself uses WAKE_STALE_MS. */
export const WAKE_ROSTER_REFRESH_TIMEOUT_MS = 30_000;

/** The server's oldest unacked directed delivery becomes stale at one shared threshold. */
export function wakePathMark(oldestUnobservedAt: string | null | undefined, nowMs = Date.now()): string | null {
  if (!oldestUnobservedAt) return null;
  const acceptedAt = Date.parse(oldestUnobservedAt);
  if (!Number.isFinite(acceptedAt) || nowMs - acceptedAt < WAKE_STALE_MS) return null;
  return `Wake path stale · no session check in ${WAKE_STALE_LABEL}`;
}
