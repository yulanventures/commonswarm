/**
 * Seat admin: an owner gives one of their own agents admin powers on the seat it already holds.
 *
 * Registry v3 is immutable. A grant pins its version and the exact commands it allows, so a later
 * version can never widen an existing grant; new powers need a new human confirmation. The role
 * bundles are HezSec's exact table (2026-11-09 role-level ruling), not "whatever a human admin can
 * do now". Every command still runs under its own live checks; a bundle only says which commands
 * a seat admin may ask for.
 *
 * Pure decisions only. The command edge gathers the facts under its locks and applies the result.
 */
import { ADMIN_AVAILABILITY, ADMIN_INVITATIONS_PER_GRANT, ADMIN_SEATS_PER_GRANT, ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT,
  ADMIN_CONNECTION_ATTEMPTS_PER_GRANT, canonicalAdminJson } from './admin-policy.js';

export const SEAT_ADMIN_REGISTRY_VERSION = 3;
export const SEAT_ADMIN_MAX_DAYS = 90;
export const SEAT_ADMIN_MAX_WORKSPACES = 10;
export const SEAT_ADMIN_FRESH_SIGN_IN_SECONDS = 300;

export type SeatAdminLevel = 'scoped' | 'workspace' | 'organization';
export const SEAT_ADMIN_LEVELS: readonly SeatAdminLevel[] = Object.freeze(['scoped', 'workspace', 'organization']);

const ROUTINE_SEATS_AND_INVITATIONS = [
  'admin_invite_member', 'admin_revoke_invitation',
  'admin_create_seat', 'admin_provision_seat', 'admin_replace_undelivered_seat_credential', 'admin_renew_seat',
  'admin_revoke_seat', 'admin_revoke_seat_credential',
  'admin_issue_agent_invitation', 'admin_revoke_agent_invitation', 'admin_prepare_connection', 'admin_cancel_connection',
] as const;

const WORKSPACE_ADMIN_COMMANDS = Object.freeze([
  'admin_read_metadata', ...ROUTINE_SEATS_AND_INVITATIONS,
  'rename_workspace', 'set_workspace_lead', 'add_agent_to_workspace', 'remove_agent_from_workspace',
  'remove_member', 'change_role',
].sort());

/** Registry v3 role bundles. Frozen: changing one means a v4 and new confirmations. */
export const SEAT_ADMIN_ROLE_BUNDLES = Object.freeze({
  'role:workspace_admin': Object.freeze({ level: 'workspace' as const, commands: WORKSPACE_ADMIN_COMMANDS }),
  'role:organization_admin': Object.freeze({ level: 'organization' as const,
    commands: Object.freeze([...WORKSPACE_ADMIN_COMMANDS, 'rename_organization'].sort()) }),
});
export type SeatAdminRole = keyof typeof SEAT_ADMIN_ROLE_BUNDLES;

/** Scoped grants: v2's available routine commands per scope, plus workspaces:rename (v3 only). */
export const SEAT_ADMIN_SCOPED_SCOPES = Object.freeze(['admin:read', 'invites:create', 'invites:revoke',
  'onboarding:connect', 'seats:create', 'seats:renew', 'seats:revoke', 'workspaces:rename']);

export function seatAdminScopedCommands(scopes: readonly string[]): string[] {
  const v2 = ADMIN_AVAILABILITY[2]!;
  const commands = Object.entries(v2).filter(([, d]) => d.available && scopes.includes(d.scope)).map(([name]) => name);
  if (scopes.includes('workspaces:rename')) commands.push('rename_workspace');
  return [...new Set(commands)].sort();
}

/** Fixed confirmation copy. Plain words; the site renders these lines as given. */
export const SEAT_ADMIN_ROLE_COPY = Object.freeze({
  'role:workspace_admin': Object.freeze({
    included: Object.freeze([
      'Invite people as members and cancel invitations',
      'Add, renew and stop agent seats, and set up agent connections',
      'Rename this workspace and choose its lead agent',
      'Add agents to this workspace and remove them',
      'Remove members and guests, and switch people between member and guest',
      'See this admin access and its history',
    ]),
    excluded: Object.freeze([
      'Anything about owners or admins',
      'Creating, archiving or moving workspaces',
      'Giving anyone admin access',
      'Billing, sign-in and passwords',
      'Its own seat, or another admin agent',
    ]),
  }),
  'role:organization_admin': Object.freeze({
    included: Object.freeze([
      'Everything an agent workspace admin can do, in each of this organization\'s workspaces you own and it belongs to',
      'Rename the organization',
    ]),
    excluded: Object.freeze([
      'Organization members and roles',
      'Anything about owners or admins',
      'Creating, archiving or moving workspaces',
      'Giving anyone admin access',
      'Billing, sign-in and passwords',
      'Its own seat, or another admin agent',
    ]),
  }),
});
export const SEAT_ADMIN_NO_END_DATE_LINE = 'Admin access stays on until you remove it or retire this agent.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export interface GrantSeatAdminCommand {
  kind: 'grant_seat_admin';
  principal_id: string;
  level: SeatAdminLevel;
  scope_names: string[];
  workspace_ids: string[];
  organization_id: string | null;
  /** Epoch milliseconds, or null for "No end date". */
  expires_at: number | null;
}
export interface EndSeatAdminCommand { kind: 'end_seat_admin'; grant_id: string }
export type SeatAdminCommand = GrantSeatAdminCommand | EndSeatAdminCommand;
export const SEAT_ADMIN_COMMAND_KINDS = Object.freeze(['grant_seat_admin', 'end_seat_admin'] as const);

/** Closed wire shape. Arrays come back sorted and unique so the manifest has one form. */
export function parseSeatAdminCommand(input: unknown): SeatAdminCommand | null {
  const c = record(input);
  if (!c) return null;
  if (c.kind === 'end_seat_admin') return exactKeys(c, ['kind', 'grant_id']) && isUuid(c.grant_id) ? { kind: 'end_seat_admin', grant_id: c.grant_id } : null;
  if (c.kind !== 'grant_seat_admin' || !exactKeys(c, ['kind', 'principal_id', 'level', 'scope_names', 'workspace_ids', 'organization_id', 'expires_at'])) return null;
  if (!isUuid(c.principal_id) || !SEAT_ADMIN_LEVELS.includes(c.level as SeatAdminLevel)) return null;
  if (!Array.isArray(c.scope_names) || !c.scope_names.every(s => typeof s === 'string')) return null;
  if (!Array.isArray(c.workspace_ids) || !c.workspace_ids.every(isUuid)) return null;
  if (!(c.organization_id === null || isUuid(c.organization_id))) return null;
  if (!(c.expires_at === null || (typeof c.expires_at === 'number' && Number.isSafeInteger(c.expires_at)))) return null;
  const scopes = [...new Set(c.scope_names as string[])].sort(), workspaces = [...new Set(c.workspace_ids as string[])].sort();
  if (scopes.length !== c.scope_names.length || workspaces.length !== c.workspace_ids.length) return null;
  return { kind: 'grant_seat_admin', principal_id: c.principal_id, level: c.level as SeatAdminLevel, scope_names: scopes,
    workspace_ids: workspaces, organization_id: c.organization_id as string | null, expires_at: c.expires_at as number | null };
}

export interface SeatAdminManifest {
  registry_version: 3;
  level: SeatAdminLevel;
  principal_id: string;
  scope_names: string[];
  workspace_ids: string[];
  organization_id: string | null;
  expires_at: number | null;
  /** The exact commands this grant allows, from the pinned registry. */
  capability_names: string[];
  /** The engine ceilings and target rules this grant runs under, pinned at confirmation. */
  policy: {
    role_ceiling: 'member';
    targets: 'grantor_owned_not_self_not_admin_seat';
    secret_delivery: 'bound_recipient_only';
    seats_per_grant: { live: number; total: number };
    invitations_per_grant: { total: number; live_agent: number };
    worker_credential_issues_per_grant: number;
    connection_attempts_per_grant: number;
  };
}

export interface GrantFacts {
  now: number;
  /** Human session facts; anything but a person's session is refused. */
  actor: { kind: 'human' | 'agent' | 'hosted_seat' | 'other'; user_id: string | null; interactive_at_seconds: number | null;
    csrf_verified: boolean; session_bound: boolean };
  principal: { owner_user_id: string; revoked: boolean } | null;
  /** Per requested workspace, read under lock. */
  workspaces: Record<string, { grantor_live_owner: boolean; agent_live_member: boolean; archived: boolean }>;
  organization: { grantor_live_owner: boolean; archived: boolean } | null;
  /** An active grant already exists for this principal at this level and target. */
  existing_active: boolean;
}

export type GrantDecision = { ok: true; manifest: SeatAdminManifest } | { ok: false; reason: string };

export function seatAdminManifest(c: GrantSeatAdminCommand): SeatAdminManifest {
  const capability_names = c.level === 'scoped' ? seatAdminScopedCommands(c.scope_names)
    : [...SEAT_ADMIN_ROLE_BUNDLES[c.scope_names[0] as SeatAdminRole].commands];
  return { registry_version: 3, level: c.level, principal_id: c.principal_id, scope_names: c.scope_names,
    workspace_ids: c.workspace_ids, organization_id: c.organization_id, expires_at: c.expires_at, capability_names,
    policy: { role_ceiling: 'member', targets: 'grantor_owned_not_self_not_admin_seat', secret_delivery: 'bound_recipient_only',
      seats_per_grant: { ...ADMIN_SEATS_PER_GRANT }, invitations_per_grant: { ...ADMIN_INVITATIONS_PER_GRANT },
      worker_credential_issues_per_grant: ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT,
      connection_attempts_per_grant: ADMIN_CONNECTION_ATTEMPTS_PER_GRANT } };
}

export function seatAdminManifestJson(m: SeatAdminManifest): string { return canonicalAdminJson(m); }

function shapeProblem(c: GrantSeatAdminCommand, now: number): string | null {
  if (c.expires_at !== null && (c.expires_at <= now || c.expires_at > now + SEAT_ADMIN_MAX_DAYS * 86_400_000)) return 'invalid_expiry';
  if (c.level === 'scoped') {
    if (c.organization_id !== null || c.workspace_ids.length < 1 || c.workspace_ids.length > SEAT_ADMIN_MAX_WORKSPACES) return 'invalid_request';
    if (!c.scope_names.includes('admin:read') || !c.scope_names.every(s => SEAT_ADMIN_SCOPED_SCOPES.includes(s))) return 'scope_forbidden';
    return null;
  }
  const role = c.level === 'workspace' ? 'role:workspace_admin' : 'role:organization_admin';
  if (c.scope_names.length !== 1 || c.scope_names[0] !== role) return 'scope_forbidden';
  if (c.level === 'workspace' && (c.organization_id !== null || c.workspace_ids.length !== 1)) return 'invalid_request';
  if (c.level === 'organization' && (c.organization_id === null || c.workspace_ids.length !== 0)) return 'invalid_request';
  return null;
}

/**
 * Grant: a person's fresh, session-bound, CSRF-checked confirmation; the grantor owns the agent and
 * is a live owner of every covered workspace (and the organization, at that level), and the agent
 * is a live member of every listed workspace.
 */
export function decideSeatAdminGrant(c: GrantSeatAdminCommand, f: GrantFacts): GrantDecision {
  if (f.actor.kind !== 'human' || f.actor.user_id === null) return { ok: false, reason: 'credential_kind_forbidden' };
  const fresh = f.actor.interactive_at_seconds !== null
    && f.now / 1000 - f.actor.interactive_at_seconds <= SEAT_ADMIN_FRESH_SIGN_IN_SECONDS
    && f.now / 1000 - f.actor.interactive_at_seconds >= -5;
  if (!fresh || !f.actor.csrf_verified || !f.actor.session_bound) return { ok: false, reason: 'human_confirmation_required' };
  const shape = shapeProblem(c, f.now);
  if (shape) return { ok: false, reason: shape };
  if (!f.principal || f.principal.revoked || f.principal.owner_user_id !== f.actor.user_id) return { ok: false, reason: 'agent_not_yours' };
  for (const id of c.workspace_ids) {
    const w = f.workspaces[id];
    if (!w || !w.grantor_live_owner || w.archived) return { ok: false, reason: 'workspace_not_owned' };
    if (!w.agent_live_member) return { ok: false, reason: 'agent_not_member' };
  }
  if (c.level === 'organization' && (!f.organization || !f.organization.grantor_live_owner || f.organization.archived)) {
    return { ok: false, reason: 'organization_not_owned' };
  }
  if (f.existing_active) return { ok: false, reason: 'seat_admin_exists' };
  return { ok: true, manifest: seatAdminManifest(c) };
}

export interface EndFacts {
  actor: { kind: 'human' | 'agent' | 'hosted_seat' | 'other'; user_id: string | null; csrf_verified: boolean };
  grant: { owner_user_id: string; state: string; level: SeatAdminLevel } | null;
  /** The actor is a live owner of a workspace (or the organization) this grant covers. */
  actor_owns_covered_target: boolean;
}
export type EndDecision = { ok: true; already_ended: boolean } | { ok: false; reason: string };

/** End: human only, CSRF, no freshness requirement. The grantor, or a current owner of a covered target. Idempotent. */
export function decideSeatAdminEnd(f: EndFacts): EndDecision {
  if (f.actor.kind !== 'human' || f.actor.user_id === null) return { ok: false, reason: 'credential_kind_forbidden' };
  if (!f.actor.csrf_verified) return { ok: false, reason: 'human_confirmation_required' };
  if (!f.grant || (f.grant.owner_user_id !== f.actor.user_id && !f.actor_owns_covered_target)) return { ok: false, reason: 'not_found' };
  return { ok: true, already_ended: f.grant.state !== 'active' };
}
