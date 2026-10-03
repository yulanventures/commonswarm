/// <reference types="node" />
// Proposed values pinned by lane B0: one registry for consent and enforcement.
import { createHash } from 'node:crypto';
import { isAgentScopeDenylisted } from './workspace-commands.js';
export const ADMIN_RESOURCE = 'https://api.commonswarm.com/admin';
export const ADMIN_REGISTRY_VERSION = 2;
export const ADMIN_ACCESS_TTL_SECONDS = 300;
export const ADMIN_REFRESH_MAX_LIFETIME_SECONDS = 2_592_000;
export const ADMIN_GRANT_TTL_SECONDS = 2_592_000;
export const ADMIN_READ_RATE_PER_HOUR = { lineage: 120, connection: 120, account: 1000, workspace: 1000 } as const;
export const ADMIN_MUTATION_RATE_PER_HOUR = { lineage: 20, connection: 20, account: 60, workspace: 60 } as const;
export const ADMIN_REFRESH_RATE_PER_HOUR = 20;
export const ADMIN_WORKSPACE_CREATE_PER_DAY = 20;
export const ADMIN_INVITATION_ISSUE_PER_DAY = 10;
export const ADMIN_WORKSPACES_CREATED_PER_GRANT = 10;
export const ADMIN_SEATS_PER_GRANT = { live: 10, total: 50 } as const;
export const ADMIN_INVITATIONS_PER_GRANT = { total: 10, live_agent: 5 } as const;
export const ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT = 50;
export const ADMIN_WORKER_RENEWAL_LIMITS = { bearer_seconds: 3600, horizon_seconds: 2_592_000, successors_per_worker: 800, successors_per_grant: 8000 } as const;
export const ADMIN_CONNECTION_ATTEMPTS_PER_GRANT = 50;
export const ADMIN_INVITATION_AND_ATTEMPT_TTL = { member_seconds: 604800, agent_min_seconds: 3600, agent_max_seconds: 86400, agent_seats: 10, attempt_seconds: 86400 } as const;
export const ADMIN_EXISTING_RESOURCE_CEILINGS = { owned_workspaces: 10, members_and_invitations: 25, principals: 50, joins_per_person: 5, joins_per_workspace: 20, hosted_seats: 10 } as const;

/** Immutable consent definitions. Change authority semantics only in a new version.
 * Historical versions remain here for dispatch; v1 is deliberately not admitted. */
const ADMIN_AVAILABILITY_V2 = {
  admin_read_metadata: { scope: 'admin:read', label: 'Read-only', available: true, authority_revision: 1 },
  admin_create_workspace: { scope: 'workspaces:create', label: 'Create workspaces', available: true, authority_revision: 1 },
  admin_archive_workspace: { scope: 'workspaces:archive', label: 'Archive workspaces', available: false, authority_revision: 1 },
  admin_create_seat: { scope: 'seats:create', label: 'Create seats', available: true, authority_revision: 1 },
  admin_provision_seat: { scope: 'seats:create', label: 'Create seats', available: true, authority_revision: 1 },
  admin_replace_undelivered_seat_credential: { scope: 'seats:create', label: 'Create seats', available: true, authority_revision: 1 },
  admin_renew_seat: { scope: 'seats:renew', label: 'Renew seats', available: true, authority_revision: 1 },
  admin_set_seat_model: { scope: 'seats:manage', label: 'Manage seats', available: false, authority_revision: 1 },
  admin_enable_seat_management: { scope: 'seats:manage', label: 'Manage seats', available: false, authority_revision: 1 },
  admin_recover_seat_session: { scope: 'seats:manage', label: 'Manage seats', available: false, authority_revision: 1 },
  admin_revoke_seat: { scope: 'seats:revoke', label: 'Stop seat access', available: true, authority_revision: 1 },
  admin_revoke_seat_credential: { scope: 'seats:revoke', label: 'Stop seat access', available: true, authority_revision: 1 },
  admin_invite_member: { scope: 'invites:create', label: 'Invite members', available: true, authority_revision: 1 },
  admin_issue_agent_invitation: { scope: 'invites:create', label: 'Invite members', available: true, authority_revision: 1 },
  admin_revoke_invitation: { scope: 'invites:revoke', label: 'Cancel invitations', available: true, authority_revision: 1 },
  admin_revoke_agent_invitation: { scope: 'invites:revoke', label: 'Cancel invitations', available: true, authority_revision: 1 },
  admin_remove_member: { scope: 'members:manage', label: 'Manage members', available: false, authority_revision: 1 },
  admin_change_member_role: { scope: 'members:manage', label: 'Manage members', available: false, authority_revision: 1 },
  admin_prepare_connection: { scope: 'onboarding:connect', label: 'Set up connections', available: true, authority_revision: 1 },
  redeem_agent_connection: { scope: 'onboarding:connect', label: 'Set up connections', available: false, authority_revision: 1 },
  record_agent_connection_progress: { scope: 'onboarding:connect', label: 'Set up connections', available: false, authority_revision: 1 },
  admin_cancel_connection: { scope: 'onboarding:connect', label: 'Set up connections', available: true, authority_revision: 1 },
} as const;
export type AdminScope = typeof ADMIN_AVAILABILITY_V2[keyof typeof ADMIN_AVAILABILITY_V2]['scope'];
export interface AdminCapabilityDefinition {
  scope: AdminScope; label: string; available: boolean; authority_revision: number;
}
export const ADMIN_AVAILABILITY: Readonly<Record<number, Readonly<Record<string, AdminCapabilityDefinition>>>> = Object.freeze({
  [ADMIN_REGISTRY_VERSION]: Object.freeze(Object.fromEntries(Object.entries(ADMIN_AVAILABILITY_V2)
    .map(([name, definition]) => [name, Object.freeze(definition)]))),
});
export const ADMIN_SCOPE_REGISTRY = Object.freeze(Object.fromEntries(
  [...new Set(Object.values(ADMIN_AVAILABILITY[ADMIN_REGISTRY_VERSION]!).map(d => d.scope))].map(scope => [scope,
    Object.freeze(Object.entries(ADMIN_AVAILABILITY[ADMIN_REGISTRY_VERSION]!).filter(([, d]) => d.scope === scope).map(([name]) => name)),
  ]),
)) as Readonly<Record<AdminScope, readonly string[]>>;
export const ADMIN_SCOPE_NAMES = Object.freeze(Object.keys(ADMIN_SCOPE_REGISTRY) as AdminScope[]);

export function adminAvailabilityDigest(version: number): string | null {
  const definitions = ADMIN_AVAILABILITY[version];
  return definitions ? createHash('sha256').update(canonicalAdminJson({ version, definitions })).digest('hex') : null;
}
/** These are resource permissions only; never add them to an OIDC identity scope set. */
export function adminConsentOptions(version = ADMIN_REGISTRY_VERSION) {
  const definitions = ADMIN_AVAILABILITY[version];
  if (!definitions) return [];
  return [...new Set(Object.values(definitions).map(d => d.scope))].sort().map(scope => {
    const entries = Object.entries(definitions).filter(([, d]) => d.scope === scope);
    const capability_names = entries.filter(([, d]) => d.available).map(([name]) => name).sort();
    return { resource: ADMIN_RESOURCE, scope, label: entries[0]![1].label,
      available: capability_names.length > 0, capability_names };
  });
}
export const ADMIN_BILLING_CONSENT = Object.freeze({ label: 'Renew seats',
  description: 'Billing changes are not available', available: false,
  scope_names: Object.freeze([]), capability_names: Object.freeze([]) });
export function adminAvailableCapabilities(scopeNames: readonly string[], version = ADMIN_REGISTRY_VERSION): string[] {
  return Object.entries(ADMIN_AVAILABILITY[version] ?? {})
    .filter(([, d]) => d.available && scopeNames.includes(d.scope)).map(([name]) => name).sort();
}
export function adminCapabilityAvailable(command: string, version = ADMIN_REGISTRY_VERSION): boolean {
  return Object.hasOwn(ADMIN_AVAILABILITY, version) && ADMIN_AVAILABILITY[version]?.[command]?.available === true;
}
/** Tool listing and dispatch use this intersection, never scope presence alone. */
export function adminEffectiveCapabilities(manifest: AdminManifest, actorScopes: readonly string[] = manifest.scope_names): string[] {
  const consented = ADMIN_AVAILABILITY[manifest.registry_version], current = ADMIN_AVAILABILITY[ADMIN_REGISTRY_VERSION];
  if (!consented || !current || manifest.resource !== ADMIN_RESOURCE ||
      manifest.availability_digest !== adminAvailabilityDigest(manifest.registry_version) ||
      !Array.isArray(manifest.capability_names)) return [];
  return manifest.capability_names.filter(name => {
    const prior = consented[name], live = current[name];
    return prior?.available && live?.available && prior.scope === live.scope &&
      prior.authority_revision === live.authority_revision && manifest.scope_names.includes(prior.scope) && actorScopes.includes(prior.scope);
  }).sort();
}

export const ADMIN_ISSUANCE_CEILINGS = {
  workspaces: ADMIN_WORKSPACES_CREATED_PER_GRANT,
  live_seats: ADMIN_SEATS_PER_GRANT.live,
  total_seats: ADMIN_SEATS_PER_GRANT.total,
  invitations: ADMIN_INVITATIONS_PER_GRANT.total,
  live_agent_invitations: ADMIN_INVITATIONS_PER_GRANT.live_agent,
  worker_credentials: ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT,
  connection_attempts: ADMIN_CONNECTION_ATTEMPTS_PER_GRANT,
} as const;
export const ADMIN_RENEWAL_CEILINGS = ADMIN_WORKER_RENEWAL_LIMITS;

export function adminRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
export function adminExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export const ADMIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function adminIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string' && ADMIN_UUID_RE.test(id)) && new Set(value).size === value.length;
}
export function adminScopes(value: unknown, version = ADMIN_REGISTRY_VERSION): value is AdminScope[] {
  const definitions = ADMIN_AVAILABILITY[version];
  return !!definitions && Array.isArray(value) && value.every(scope => typeof scope === 'string' &&
    Object.values(definitions).some(d => d.scope === scope)) && new Set(value).size === value.length;
}
export interface AdminManifest {
  admin_identity_id: string;
  connection_id: string;
  client_id: string;
  resource: typeof ADMIN_RESOURCE;
  mode: 'granular' | 'full_account';
  registry_version: number;
  capability_names: string[];
  availability_digest: string;
  scope_names: AdminScope[];
  workspace_selector: 'selected' | 'owned_and_selected';
  workspace_ids: string[];
  created_workspace_policy: { scope_names: AdminScope[] };
  target_rules: {
    seat_ids: string[]; own_seats: boolean; grant_created_seats: boolean;
    recipient_user_ids: string[]; recipient_connection_ids: string[];
    transports: ('local' | 'hosted_mcp')[];
  };
  worker_scope_ceiling: string[];
  role_ceiling: 'member';
  renewal_limits: {
    grant_kinds: ('timeboxed' | 'standing')[]; principal_ids: string[];
    bearer_seconds: number; horizon_seconds: number;
    successors_per_worker: number; successors_per_grant: number;
  };
  issuance_limits: { [K in keyof typeof ADMIN_ISSUANCE_CEILINGS]: number };
  expires_at: number;
  refresh_deadline: number;
}
const MANIFEST_KEYS = [
  'admin_identity_id', 'connection_id', 'client_id', 'resource', 'mode', 'registry_version',
  'capability_names', 'availability_digest', 'scope_names', 'workspace_selector', 'workspace_ids', 'created_workspace_policy', 'target_rules',
  'worker_scope_ceiling', 'role_ceiling', 'renewal_limits', 'issuance_limits', 'expires_at', 'refresh_deadline',
] as const;

/** Validate untrusted JSON as well as typed callers; no missing limit means unlimited. */
export function adminManifestValid(value: unknown, now: number, initial = true): value is AdminManifest {
  const m = adminRecord(value);
  if (!m || !adminExactKeys(m, MANIFEST_KEYS)) return false;
  const target = adminRecord(m.target_rules), created = adminRecord(m.created_workspace_policy);
  const renewal = adminRecord(m.renewal_limits), issuance = adminRecord(m.issuance_limits);
  if (!ADMIN_UUID_RE.test(String(m.admin_identity_id)) || !ADMIN_UUID_RE.test(String(m.connection_id)) ||
      typeof m.client_id !== 'string' || m.client_id.length < 1 || m.client_id.length > 2048 ||
      m.resource !== ADMIN_RESOURCE || typeof m.registry_version !== 'number' ||
      !Object.hasOwn(ADMIN_AVAILABILITY, m.registry_version) ||
      (initial && m.registry_version !== ADMIN_REGISTRY_VERSION) ||
      m.availability_digest !== adminAvailabilityDigest(m.registry_version) ||
      !adminScopes(m.scope_names, m.registry_version) || !m.scope_names.includes('admin:read') || !adminIds(m.workspace_ids) ||
      m.role_ceiling !== 'member' || !['granular', 'full_account'].includes(String(m.mode)) ||
      m.workspace_selector !== (m.mode === 'granular' ? 'selected' : 'owned_and_selected')) return false;
  const definitions = ADMIN_AVAILABILITY[m.registry_version as number]!;
  if (!Array.isArray(m.capability_names) || !m.capability_names.every((name, i, names) =>
      typeof name === 'string' && (i === 0 || names[i - 1] < name) &&
      definitions[name]?.available === true && (m.scope_names as string[]).includes(definitions[name]!.scope)) ||
      !m.capability_names.includes('admin_read_metadata') ||
      !m.scope_names.every(scope => (m.capability_names as string[]).some(name => definitions[name]?.scope === scope))) return false;
  if (m.mode === 'full_account') {
    const available = Object.entries(definitions).filter(([, d]) => d.available).map(([name]) => name).sort();
    if (canonicalAdminJson(m.capability_names) !== canonicalAdminJson(available)) return false;
  }
  if (!created || !adminExactKeys(created, ['scope_names']) || !adminScopes(created.scope_names, m.registry_version as number) ||
      !created.scope_names.every(scope => (m.scope_names as string[]).includes(scope)) ||
      (created.scope_names.length > 0 && !m.scope_names.includes('workspaces:create'))) return false;
  if (!target || !adminExactKeys(target, ['seat_ids', 'own_seats', 'grant_created_seats', 'recipient_user_ids', 'recipient_connection_ids', 'transports']) ||
      !adminIds(target.seat_ids) || !adminIds(target.recipient_user_ids) || !adminIds(target.recipient_connection_ids) ||
      typeof target.own_seats !== 'boolean' || typeof target.grant_created_seats !== 'boolean' ||
      !Array.isArray(target.transports) || !target.transports.every(t => t === 'local' || t === 'hosted_mcp') || new Set(target.transports).size !== target.transports.length) return false;
  if (!Array.isArray(m.worker_scope_ceiling) || m.worker_scope_ceiling.length > 100 ||
      !m.worker_scope_ceiling.every(scope => typeof scope === 'string' && /^[a-z][a-z0-9_:.-]{0,79}$/u.test(scope)) ||
      m.worker_scope_ceiling.some(scope => isAgentScopeDenylisted(String(scope))) ||
      new Set(m.worker_scope_ceiling).size !== m.worker_scope_ceiling.length) return false;
  if (!renewal || !adminExactKeys(renewal, [...Object.keys(ADMIN_RENEWAL_CEILINGS), 'grant_kinds', 'principal_ids']) ||
      !adminIds(renewal.principal_ids) || !Array.isArray(renewal.grant_kinds) ||
      !renewal.grant_kinds.every(kind => kind === 'timeboxed' || kind === 'standing') || new Set(renewal.grant_kinds).size !== renewal.grant_kinds.length ||
      !issuance || !adminExactKeys(issuance, Object.keys(ADMIN_ISSUANCE_CEILINGS))) return false;
  for (const [limits, ceilings] of [[renewal, ADMIN_RENEWAL_CEILINGS], [issuance, ADMIN_ISSUANCE_CEILINGS]] as const) {
    for (const [key, ceiling] of Object.entries(ceilings)) {
      const n = limits[key];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > ceiling) return false;
    }
  }
  return typeof m.expires_at === 'number' && Number.isSafeInteger(m.expires_at) &&
    typeof m.refresh_deadline === 'number' && Number.isSafeInteger(m.refresh_deadline) &&
    m.expires_at > now && m.expires_at <= m.refresh_deadline &&
    (!initial || (m.expires_at >= now + 1000 && m.refresh_deadline <= now + ADMIN_REFRESH_MAX_LIFETIME_SECONDS * 1000 && m.expires_at <= now + ADMIN_GRANT_TTL_SECONDS * 1000));
}

/** The adapter hashes this canonical manifest; ordering never changes its meaning. */
export function canonicalAdminJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAdminJson).join(',')}]`;
  const r = adminRecord(value);
  if (r) return `{${Object.keys(r).sort().map(key => `${JSON.stringify(key)}:${canonicalAdminJson(r[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Project exactly the consent fields from a durable grant/event projection. */
export function adminGrantManifest(value: AdminManifest): AdminManifest {
  return Object.fromEntries(MANIFEST_KEYS.map(key => [key, value[key]])) as unknown as AdminManifest;
}
