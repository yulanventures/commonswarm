import { HOUSEHOLD_CONTENT_ROLES } from './household-object-policy.js';
/** Human enrollment decisions. Inviting grants no right to choose the recipient's
 * content role, private workspace, connector, or agent identity. */
export const HOUSEHOLD_JOIN_RATE_PER_HOUR = 120;
export const HOUSEHOLD_JOIN_CONSENT_VERSION = 'household-join-v1';
export const HOUSEHOLD_JOIN_DISCLOSURE = 'Members can read shared workspace content and retained history, except directed messages restricted to their audience. Your personal and business spaces stay separate. You choose and authorize your own agents separately. Copies already read cannot be recalled.';
export type HumanInviteRef = { source: 'delegated'; invitation_id: string } | { source: 'link'; token: string };
export type HumanInviteCommand = { kind: 'household_invitation'; action: 'preview'; invitation: HumanInviteRef }
  | { kind: 'household_invitation'; action: 'accept'; invitation: HumanInviteRef; consent_version: string; preview_digest: string; content_role: 'reader' | 'editor' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseHumanInviteCommand(value: unknown): HumanInviteCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>, ref = c.invitation as Record<string, unknown> | null;
  if (c.kind !== 'household_invitation' || !ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const keys = ref.source === 'delegated' ? ['source','invitation_id'] : ['source','token'];
  if (Object.keys(ref).length !== 2 || Object.keys(ref).some(k => !keys.includes(k)) ||
    !(ref.source === 'delegated' ? typeof ref.invitation_id === 'string' && uuid.test(ref.invitation_id)
      : ref.source === 'link' && typeof ref.token === 'string' && /^swm_inv_[A-Za-z0-9_-]{43}$/.test(ref.token))) return null;
  const allowed = c.action === 'preview' ? ['kind','action','invitation'] : ['kind','action','invitation','consent_version','preview_digest','content_role'];
  if (Object.keys(c).length !== allowed.length || Object.keys(c).some(k => !allowed.includes(k))) return null;
  if (c.action !== 'preview' && !(c.action === 'accept' && c.consent_version === HOUSEHOLD_JOIN_CONSENT_VERSION &&
    typeof c.preview_digest === 'string' && /^[0-9a-f]{64}$/.test(c.preview_digest) && (HOUSEHOLD_CONTENT_ROLES as readonly unknown[]).includes(c.content_role))) return null;
  return c as unknown as HumanInviteCommand;
}
export interface HumanInviteFacts {
  human: boolean; identity_verified: boolean; recipient_matches: boolean;
  invitation_kind: 'member' | 'agent'; role: string; personal_boundary: boolean;
  inviter_can_invite: boolean; parent_live: boolean; now: number; expires_at: number;
  revoked_at: number | null; accepted_at: number | null; accepted_by: string | null;
  user_id: string; member_live: boolean; preview_digest: string;
}
export type HumanInviteDecision = { status: 'preview' | 'join' | 'already_joined' } | { status: 'refused'; reason: string };
export function decideHumanInvite(command: HumanInviteCommand, facts: HumanInviteFacts): HumanInviteDecision {
  const refuse = (reason: string) => ({ status: 'refused' as const, reason });
  if (!facts.human || !facts.identity_verified) return refuse('human_sign_in_required');
  if (!facts.recipient_matches || facts.invitation_kind !== 'member' || facts.role !== 'member') return refuse('invitation_unavailable');
  // A completed join is an independent human membership, not delegated access.
  // It must never revive a removed member, even on an exact retry.
  if (facts.accepted_at !== null) return facts.accepted_by === facts.user_id && facts.member_live
    ? { status: 'already_joined' } : refuse('invitation_unavailable');
  if (facts.revoked_at !== null || facts.expires_at <= facts.now || !facts.parent_live || !facts.inviter_can_invite || facts.personal_boundary)
    return refuse('invitation_unavailable');
  if (facts.member_live) return refuse('member_exists');
  if (command.action === 'preview') return { status: 'preview' };
  if (command.consent_version !== HOUSEHOLD_JOIN_CONSENT_VERSION || !(HOUSEHOLD_CONTENT_ROLES as readonly unknown[]).includes(command.content_role)) return refuse('recipient_consent_required');
  if (command.preview_digest !== facts.preview_digest) return refuse('review_changed');
  return { status: 'join' };
}
