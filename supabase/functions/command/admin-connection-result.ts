import type { AdminConnectionAttempt } from '../_shared/admin-authority.d.ts';

/** Render current durable intake state on both fresh commands and command-ID
 * replay. Historical events remain historical; they cannot restore old status.
 */
export function adminConnectionResult(attempt: AdminConnectionAttempt | undefined, now: number): {
  status: number; body: Record<string, unknown>;
} {
  if (!attempt) return { status: 403, body: { error: 'connection_attempt_forbidden' } };
  if (attempt.state !== 'cancelled' && attempt.expires_at <= now) {
    return { status: 403, body: { error: 'connection_attempt_expired' } };
  }
  const { attempt_id, parent_admin_grant_id, workspace_id, intended_owner_user_id,
    intended_agent_id, recipient_connection_id, requested_name, transport, ttl_seconds,
    capability_set, state, created_at, expires_at, cancelled_at, reason_code } = attempt;
  return { status: 200, body: {
    status: state === 'cancelled' ? 'accepted' : 'pending',
    connection_attempt: { attempt_id, parent_admin_grant_id, workspace_id, intended_owner_user_id,
      intended_agent_id, recipient_connection_id, requested_name, transport, ttl_seconds,
      capability_set, state, created_at, expires_at, cancelled_at, reason_code },
    next_action: state === 'cancelled' ? 'The pending setup was cancelled.'
      : 'The recipient must authorize setup. Runtime enrollment and connection proof are still pending.',
  } };
}
