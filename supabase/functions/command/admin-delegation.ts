import { prepareAdminRoutine, applyAdminRoutine, type AdminWorkerDelivery } from './admin-routine.ts';
import { adminConnectionResult } from './admin-connection-result.ts';
import type { AdminRoutineCommand, AdminRoutineDecision } from '../_shared/admin-routine.d.ts';
import { AdminRuntimeJwtVerifier, type VerifiedAdminRuntime } from './admin-runtime-auth.ts';
import type postgres from 'npm:postgres@3.4.9';
import { hasFreshInteractiveAuth } from './fresh-auth.ts';
import {
  ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS, ADMIN_GRANT_TTL_SECONDS,
  ADMIN_MUTATION_RATE_PER_HOUR, ADMIN_SCOPE_REGISTRY, adminRatePolicy,
  ADMIN_UUID_RE, adminRecord, adminExactKeys, adminManifestValid, adminScopes,
  canonicalAdminJson, parseAdminClientApprovalCommand, parseAdminRoutineCommand, decideAdminRoutine, decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount,
} from '../_shared/protocol.js';
import type { AdminActor, AdminCommand, AdminAccountState, AdminAccountEvent, AdminConsent, AdminClientApproval, AdminDecisionContext } from '../_shared/admin-authority.d.ts';
import type { AdminScope } from '../_shared/admin-policy.d.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type Result = { status: number; body: Record<string, unknown> };
export interface AdminInput {
  command_id?: unknown; stream?: unknown; resource?: unknown; command?: unknown;
  [key: string]: unknown;
}
export interface AdminHumanIdentity {
  user_id: string; session_binding: string; interactive_at_seconds: number | null; csrf_verified: boolean;
}
export interface AdminCredentialDelivery {
  access_credential: string; refresh_credential: string; resource: typeof ADMIN_RESOURCE;
  grant_id: string; connection_id: string; credential_lineage_id: string;
  generation: number; access_expires_at: number; refresh_deadline: number;
}
export type AdminAuthentication =
  | { kind: 'human'; identity: AdminHumanIdentity }
  | { kind: 'access'; credential: string; recipient_runtime_credential?: string }
  | { kind: 'runtime'; credential: string; refresh_credential?: string }
  | { kind: 'system'; owner_user_id: string };
interface CredentialRow extends Record<string, unknown> {
  grant_id: string; owner_user_id: string; credential_lineage_id: string;
  generation: number; scope_names: AdminScope[];
  access_expires_at: Date; refresh_deadline: Date; revoked_at: Date | null;
}
const runtimeVerifier = new AdminRuntimeJwtVerifier();
const ACCESS_RE = /^swm_adm_[A-Za-z0-9_-]{43}$/u;
const REFRESH_RE = /^swm_adr_[A-Za-z0-9_-]{43}$/u;
const id = (v: unknown): v is string => typeof v === 'string' && ADMIN_UUID_RE.test(v);
const reason = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(v);
const errorResult = (status: number, error: string): Result => ({ status, body: { error } });
function auditAction(raw: Record<string, unknown> | null): string {
  const parsed = parseCommand(raw);
  if (parsed) return parsed.kind;
  if (raw?.kind === 'prepare_admin_consent') return 'prepare_admin_consent';
  return Object.values(ADMIN_SCOPE_REGISTRY).some(commands => (commands as readonly unknown[]).includes(raw?.kind))
    ? String(raw!.kind) : 'invalid_request';
}
export function isAdminAccessCredential(value: string): boolean { return value.startsWith('swm_adm_'); }
export function isAdminRefreshCredential(value: string): boolean { return value.startsWith('swm_adr_'); }
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export async function adminDigest(value: unknown): Promise<string> {
  return Array.from(await digest(canonicalAdminJson(value)), n => n.toString(16).padStart(2, '0')).join('');
}
function opaque(prefix: string): string {
  return prefix + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function parseCommand(input: unknown): AdminCommand | AdminRoutineCommand | null {
  const approval = parseAdminClientApprovalCommand(input); if (approval) return approval;
  const routine = parseAdminRoutineCommand(input); if (routine) return routine;
  const c = adminRecord(input);
  if (!c || !id(c.grant_id)) return null;
  if (c.kind === 'grant_admin_delegation') return adminExactKeys(c, ['kind', 'grant_id', 'consent_receipt_id', 'replaces_grant_id']) && id(c.consent_receipt_id) && (c.replaces_grant_id === null || id(c.replaces_grant_id)) ? c as unknown as AdminCommand : null;
  if (c.kind === 'narrow_admin_delegation') return adminExactKeys(c, ['kind', 'grant_id', 'manifest', 'manifest_digest', 'consent_receipt_id']) && id(c.consent_receipt_id) && typeof c.manifest_digest === 'string' && /^[0-9a-f]{64}$/u.test(c.manifest_digest) ? c as unknown as AdminCommand : null;
  if (['revoke_admin_delegation', 'suspend_admin_delegation', 'surrender_admin_delegation'].includes(String(c.kind))) return adminExactKeys(c, ['kind', 'grant_id', 'reason_code']) && reason(c.reason_code) ? c as unknown as AdminCommand : null;
  if (c.kind === 'expire_admin_delegation') return adminExactKeys(c, ['kind', 'grant_id']) ? c as unknown as AdminCommand : null;
  if (c.kind === 'withdraw_admin_workspace_access') return adminExactKeys(c, ['kind', 'grant_id', 'workspace_id', 'reason_code']) && id(c.workspace_id) && reason(c.reason_code) ? c as unknown as AdminCommand : null;
  if (c.kind === 'issue_admin_credential') return adminExactKeys(c, ['kind', 'grant_id', 'credential_lineage_id']) && id(c.credential_lineage_id) ? c as unknown as AdminCommand : null;
  if (c.kind === 'rotate_admin_credential' || c.kind === 'record_admin_credential_replay') return adminExactKeys(c, ['kind', 'grant_id', 'credential_lineage_id', 'generation', 'scope_names']) && id(c.credential_lineage_id) && Number.isSafeInteger(c.generation) && Number(c.generation) >= 0 && adminScopes(c.scope_names) ? c as unknown as AdminCommand : null;
  if (c.kind === 'admin_read_metadata') return adminExactKeys(c, ['kind', 'grant_id', 'resource_kind', 'workspace_id']) && c.resource_kind === 'grant' && (c.workspace_id === null || id(c.workspace_id)) ? c as unknown as AdminCommand : null;
  return null;
}

async function currentRights(tx: Sql, owner: string, workspaceIds: readonly string[], scopes: readonly string[] = ['admin:read']): Promise<boolean> {
  // Transaction-time membership locks order rights loss against grant/refresh.
  if (workspaceIds.length === 0) return true;
  const rows = await tx<{ workspace_id: string; role: string; revoked_at: Date | null; archived_at: Date | null }[]>`
    SELECT m.workspace_id, m.role, m.revoked_at, w.archived_at
    FROM swarm.memberships m JOIN swarm.workspaces w USING (workspace_id)
    WHERE m.user_id = ${owner}::uuid AND m.workspace_id = ANY(${[...workspaceIds]}::uuid[])
    ORDER BY m.workspace_id FOR SHARE OF m, w
  `;
  const needsManagement = scopes.some(scope => scope !== 'admin:read' && scope !== 'workspaces:create');
  return rows.length === workspaceIds.length && rows.every(row => row.revoked_at === null && row.archived_at === null && (!needsManagement || row.role === 'owner' || row.role === 'admin'));
}
async function charge(tx: Sql, keys: { key: string; limit: number }[], now: number): Promise<{ allowed: boolean; buckets: { key: string; hour_start: number; attempts: number }[] }> {
  let allowed = true;
  const buckets: { key: string; hour_start: number; attempts: number }[] = [];
  for (const bucket of keys.sort((a, b) => a.key.localeCompare(b.key))) {
    const rows = await tx<{ attempts: number }[]>`
      INSERT INTO swarm.admin_rate_buckets(bucket_key, hour_start, attempts)
      VALUES (${bucket.key}, ${Math.floor(now / 3_600_000)}, 1)
      ON CONFLICT(bucket_key, hour_start) DO UPDATE
      SET attempts = swarm.admin_rate_buckets.attempts + 1 RETURNING attempts
    `;
    if (!rows[0] || rows[0].attempts > bucket.limit) allowed = false;
    if (rows[0]) buckets.push({ key: bucket.key, hour_start: Math.floor(now / 3_600_000), attempts: rows[0].attempts });
  }
  return { allowed, buckets };
}
async function persistEvents(tx: Sql, owner: string, state: AdminAccountState, events: readonly AdminAccountEvent[], revokeLegacyCredentials = true): Promise<AdminAccountState> {
  let next = state;
  for (const event of events) {
    next = reduceAdminAuthority(next, event);
    await tx`INSERT INTO swarm.admin_events(owner_user_id, seq, event_id, command_id, event)
      VALUES (${owner}::uuid, ${event.seq}, ${event.event_id}::uuid, ${event.command_id}, ${tx.json(event as unknown as postgres.JSONValue)})`;
  }
  for (const g of Object.values(next.grants)) {
    await tx`
      INSERT INTO swarm.admin_grants(grant_id, owner_user_id, admin_identity_id, connection_id, client_id,
        resource, mode, registry_version, scope_names, workspace_selector, workspace_ids, created_workspace_policy,
        target_rules, worker_scope_ceiling, role_ceiling, renewal_limits, issuance_limits, expires_at, refresh_deadline,
        state, consent_receipt_id, manifest_digest, created_at, suspended_at, revoked_at, reason_code, withdrawn_workspace_ids)
      VALUES (${g.grant_id}::uuid, ${owner}::uuid, ${g.admin_identity_id}::uuid, ${g.connection_id}::uuid, ${g.client_id},
        ${g.resource}, ${g.mode}, ${g.registry_version}, ${g.scope_names}, ${g.workspace_selector}, ${g.workspace_ids}::uuid[],
        ${tx.json(g.created_workspace_policy)}, ${tx.json(g.target_rules)}, ${g.worker_scope_ceiling}, ${g.role_ceiling},
        ${tx.json(g.renewal_limits)}, ${tx.json(g.issuance_limits)}, ${new Date(g.expires_at)}, ${new Date(g.refresh_deadline)},
        ${g.state}, ${g.consent_receipt_id}::uuid, ${g.manifest_digest}, ${new Date(g.created_at)},
        ${g.suspended_at === null ? null : new Date(g.suspended_at)}, ${g.revoked_at === null ? null : new Date(g.revoked_at)},
        ${g.reason_code}, ${g.withdrawn_workspace_ids}::uuid[])
      ON CONFLICT(grant_id) DO UPDATE SET mode = EXCLUDED.mode, scope_names = EXCLUDED.scope_names,
        workspace_selector = EXCLUDED.workspace_selector, workspace_ids = EXCLUDED.workspace_ids,
        created_workspace_policy = EXCLUDED.created_workspace_policy, target_rules = EXCLUDED.target_rules,
        worker_scope_ceiling = EXCLUDED.worker_scope_ceiling, renewal_limits = EXCLUDED.renewal_limits,
        issuance_limits = EXCLUDED.issuance_limits, expires_at = EXCLUDED.expires_at, state = EXCLUDED.state,
        consent_receipt_id = EXCLUDED.consent_receipt_id, manifest_digest = EXCLUDED.manifest_digest,
        suspended_at = EXCLUDED.suspended_at, revoked_at = EXCLUDED.revoked_at,
        reason_code = EXCLUDED.reason_code, withdrawn_workspace_ids = EXCLUDED.withdrawn_workspace_ids
    `;
    if (g.state !== 'active' && revokeLegacyCredentials) await tx`UPDATE swarm.admin_credentials SET revoked_at = coalesce(revoked_at, statement_timestamp()) WHERE grant_id = ${g.grant_id}::uuid`;
  }
  for (const c of Object.values(next.consents)) {
    if (c.consumed_at !== null) await tx`UPDATE swarm.admin_consents SET consumed_at = ${new Date(c.consumed_at)} WHERE consent_receipt_id = ${c.consent_receipt_id}::uuid`;
  }
  // Session bindings are kept solely in the private consent table.
  const projection: AdminAccountState = { ...next, consents: Object.fromEntries(Object.entries(next.consents).map(([key, c]) => [key, { ...c, session_binding: '' }])) };
  await tx`UPDATE swarm.admin_accounts SET projection = ${tx.json(projection as unknown as postgres.JSONValue)}, seq = ${events.at(-1)?.seq ?? 0} WHERE owner_user_id = ${owner}::uuid`;
  return next;
}

/** Called only within the command API transaction, with server-verified identity.
 * Credential material is returned privately to its runtime caller, never in result.body.
 */
export async function adminTransaction(tx: Sql, input: AdminInput, authentication: AdminAuthentication): Promise<{ result: Result; delivery?: AdminCredentialDelivery; worker_delivery?: AdminWorkerDelivery }> {
  // Verify at the transaction boundary too: importing this adapter cannot
  // bypass proof by fabricating an identity object or using the private wrapper.
  let runtime: VerifiedAdminRuntime | undefined;
  if (authentication.kind === 'runtime') {
    try { runtime = await runtimeVerifier.verify(authentication.credential); }
    catch { return { result: errorResult(401, 'credential_runtime_required') }; }
    const command = adminRecord(input.command);
    if (input.resource !== runtime.resource || command?.grant_id !== runtime.grant_id) {
      return { result: errorResult(403, 'runtime_binding_mismatch') };
    }
  }
  const stream = adminRecord(input.stream), raw = adminRecord(input.command);
  const validCommandId = typeof input.command_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.command_id);
  const commandId = validCommandId ? input.command_id as string : crypto.randomUUID();
  const wireValid = validCommandId && stream !== null && adminExactKeys(stream, ['kind']) && stream.kind === 'account' && input.resource === ADMIN_RESOURCE &&
    !Object.keys(input).some(key => !['command_id', 'stream', 'resource', 'command', 'client_version', 'client_build'].includes(key));
  let credential: CredentialRow | undefined;
  if (authentication.kind === 'access' || (authentication.kind === 'runtime' && authentication.refresh_credential !== undefined)) {
    const access = authentication.kind === 'access';
    const secret = access ? authentication.credential : authentication.refresh_credential!;
    const hash = await digest(secret);
    const rows = !(access ? ACCESS_RE : REFRESH_RE).test(secret) ? [] : access ? await tx<CredentialRow[]>`
      SELECT c.*, g.owner_user_id FROM swarm.admin_credentials c JOIN swarm.admin_grants g USING(grant_id) WHERE c.access_hash = ${hash}
    ` : await tx<CredentialRow[]>`
      SELECT c.*, g.owner_user_id FROM swarm.admin_credentials c JOIN swarm.admin_grants g USING(grant_id) WHERE c.refresh_hash = ${hash}
    `;
    credential = rows[0];
    if (!credential) {
      // Unknown inputs have their own security bucket, using the pinned
      // aggregate mutation ceiling; never charge a requested grant/account.
      const [securityClock] = await tx<{ now: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`;
      const security = await charge(tx, [{ key: 'security:unknown_admin_credential', limit: ADMIN_MUTATION_RATE_PER_HOUR.account }], securityClock!.now);
      await tx`INSERT INTO swarm.admin_security_audit(audit_id, occurred_at, reason_code) VALUES (${crypto.randomUUID()}::uuid, statement_timestamp(), 'unknown_admin_credential')`;
      return { result: errorResult(security.allowed ? 401 : 429, security.allowed ? 'unauthenticated' : 'rate_limited') };
    }
  }
  const prepare = raw?.kind === 'prepare_admin_consent';
  const proposed = parseCommand(raw);
  let owner = authentication.kind === 'human' ? authentication.identity.user_id : authentication.kind === 'system' ? authentication.owner_user_id : credential?.owner_user_id;
  if (authentication.kind === 'human' && proposed?.kind === 'withdraw_admin_workspace_access') {
    const withdrawal = await tx<{ owner_user_id: string }[]>`
      SELECT g.owner_user_id FROM swarm.admin_grants g
      JOIN swarm.memberships m ON m.workspace_id = ${proposed.workspace_id}::uuid
        AND m.user_id = ${authentication.identity.user_id}::uuid AND m.role = 'owner' AND m.revoked_at IS NULL
      WHERE g.grant_id = ${proposed.grant_id}::uuid
        AND (${proposed.workspace_id}::uuid = ANY(g.workspace_ids) OR (g.workspace_selector = 'owned_and_selected' AND EXISTS (
          SELECT 1 FROM swarm.memberships own WHERE own.workspace_id = ${proposed.workspace_id}::uuid
          AND own.user_id = g.owner_user_id AND own.role = 'owner' AND own.revoked_at IS NULL)))
    `;
    owner = withdrawal[0]?.owner_user_id;
  }
  if (authentication.kind === 'runtime' && !credential && proposed && 'grant_id' in proposed) {
    const rows = await tx<{ owner_user_id: string }[]>`SELECT owner_user_id FROM swarm.admin_grants WHERE grant_id = ${runtime!.grant_id}::uuid AND owner_user_id = ${runtime!.owner_user_id}::uuid AND connection_id = ${runtime!.connection_id}::uuid AND client_id = ${runtime!.client_id} AND resource = ${runtime!.resource}`;
    owner = rows[0]?.owner_user_id;
  }
  if (!owner || !id(owner)) return { result: errorResult(403, 'forbidden') };
  const approvalCommand = proposed?.kind === 'approve_admin_client' || proposed?.kind === 'withdraw_admin_client_approval' ? proposed : null;
  // Match lane-2 resolver/fence lock order: verification, then account, grants and bindings.
  // Non-human commands never acquire verification facts or write approvals.
  let verification: { active: boolean; withdrawn_at: Date | null }[] = [];
  if (authentication.kind === 'human' && approvalCommand) {
    try {
      // Keep successful locks through the outer command transaction. A missing
      // exact version is a policy refusal, without aborting its audit writes.
      verification = await tx.savepoint(scope => scope<{ active: boolean; withdrawn_at: Date | null }[]>`
        SELECT active, withdrawn_at FROM commonswarm_oauth.lock_admin_client_verification(
          ${approvalCommand.client_id}, ${approvalCommand.verification_version})`);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'P0001') throw error;
    }
  }
  await tx`SELECT user_id FROM swarm.users WHERE user_id=${owner}::uuid FOR UPDATE`;
  // Only humans create account streams. No grant ID chosen by an admin creates state.
  if (authentication.kind === 'human') await tx`INSERT INTO swarm.admin_accounts(owner_user_id, stream_id) VALUES (${owner}::uuid, ${crypto.randomUUID()}::uuid) ON CONFLICT(owner_user_id) DO NOTHING`;
  const accounts = await tx<{ stream_id: string; seq: string | number; projection: AdminAccountState }[]>`SELECT stream_id, seq, projection FROM swarm.admin_accounts WHERE owner_user_id = ${owner}::uuid FOR UPDATE`;
  const account = accounts[0];
  if (!account) return { result: errorResult(403, 'forbidden') };
  const clock = await tx<{ now: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`;
  const now = clock[0]!.now;
  const state = account.projection ?? emptyAdminAccount();
  const receipts = await tx<(Omit<AdminConsent, 'expires_at' | 'consumed_at'> & { expires_at: Date; consumed_at: Date | null })[]>`SELECT * FROM swarm.admin_consents WHERE owner_user_id = ${owner}::uuid`;
  for (const c of receipts) state.consents[c.consent_receipt_id] = { ...c, expires_at: new Date(c.expires_at).getTime(), consumed_at: c.consumed_at === null ? null : new Date(c.consumed_at).getTime() };
  // Recheck durable grant/credential under account lock; stale projections fail closed.
  const durableGrants = await tx<{ grant_id: string; state: string; manifest_digest: string; expires_at: Date; refresh_deadline: Date }[]>`
    SELECT grant_id, state, manifest_digest, expires_at, refresh_deadline FROM swarm.admin_grants
    WHERE owner_user_id = ${owner}::uuid ORDER BY grant_id FOR UPDATE`;
  if (durableGrants.length !== Object.keys(state.grants).length || durableGrants.some(row => {
    const g = state.grants[row.grant_id];
    return !g || g.state !== row.state || g.manifest_digest !== row.manifest_digest ||
      g.expires_at !== row.expires_at.getTime() || g.refresh_deadline !== row.refresh_deadline.getTime();
  })) throw new Error('admin projection inconsistent');
  if (credential) {
    const refreshed = await tx<CredentialRow[]>`SELECT c.*, g.owner_user_id FROM swarm.admin_credentials c
      JOIN swarm.admin_grants g USING(grant_id) WHERE c.credential_lineage_id = ${credential.credential_lineage_id}::uuid
      AND c.generation = ${credential.generation} FOR UPDATE OF c`;
    credential = refreshed[0];
    if (!credential) throw new Error('admin credential missing');
  }
  if (runtime) {
    const bound = state.grants[runtime.grant_id];
    if (runtime.expires_at <= now || owner !== runtime.owner_user_id || !bound ||
        bound.owner_user_id !== runtime.owner_user_id || bound.connection_id !== runtime.connection_id ||
        bound.client_id !== runtime.client_id || bound.resource !== runtime.resource ||
        credential && credential.grant_id !== runtime.grant_id) {
      return { result: errorResult(403, 'runtime_binding_mismatch') };
    }
  }
  let actor: AdminActor;
  if (authentication.kind === 'human') actor = { kind: 'human', user_id: authentication.identity.user_id, session_binding: authentication.identity.session_binding };
  else if (authentication.kind === 'system') actor = { kind: 'system' };
  else if (authentication.kind === 'runtime') actor = { kind: 'credential_runtime', connection_id: runtime!.connection_id, client_id: runtime!.client_id, resource: runtime!.resource };
  else {
    const grant = state.grants[credential!.grant_id];
    if (!grant) return { result: errorResult(403, 'grant_unavailable') };
    actor = { kind: 'delegated_admin', grant_id: grant.grant_id, admin_identity_id: grant.admin_identity_id,
      connection_id: grant.connection_id, resource: ADMIN_RESOURCE, scope_names: credential!.scope_names,
      access_expires_at: credential!.access_expires_at.getTime() };
  }
  const actorKey = actor.kind === 'human' ? `human:${actor.user_id}` : actor.kind === 'delegated_admin' ? `delegated_admin:${actor.admin_identity_id}` : actor.kind === 'credential_runtime' ? `runtime:${actor.connection_id}` : 'system';
  const requestDigest = await adminDigest(input);
  const prior = await tx<{ request_digest: string; response: Result }[]>`SELECT request_digest, response FROM swarm.admin_command_results WHERE owner_user_id = ${owner}::uuid AND actor_key = ${actorKey} AND command_id = ${commandId}`;
  // Replays of reads never return metadata after revocation/expiry. A rotation
  // retry returns its body-free receipt, never the old secret delivery.
  if (prior[0]) {
    if (prior[0].request_digest !== requestDigest) return { result: errorResult(409, 'command_id_conflict') };
    if (actor.kind === 'delegated_admin') {
      const g = state.grants[actor.grant_id];
      if (!g || g.state !== 'active' || g.expires_at <= now || g.refresh_deadline <= now || actor.access_expires_at <= now || credential!.revoked_at !== null ||
          !actor.scope_names.every(scope => g.scope_names.includes(scope)) || state.lineages[credential!.credential_lineage_id]?.generation !== credential!.generation) return { result: errorResult(403, 'grant_inactive') };
      if (prior[0].response.status === 200 && raw?.kind === 'admin_read_metadata' && adminRecord(prior[0].response.body.grant)?.manifest_digest !== g.manifest_digest) return { result: errorResult(403, 'grant_changed') };
      if (raw?.kind === 'admin_read_metadata' && id(raw.workspace_id) && (!g.workspace_ids.includes(raw.workspace_id) || g.withdrawn_workspace_ids.includes(raw.workspace_id) || !await currentRights(tx, owner, [raw.workspace_id]))) return { result: errorResult(403, 'workspace_forbidden') };
      if (proposed?.kind === 'admin_prepare_connection' || proposed?.kind === 'admin_cancel_connection') {
        if (!actor.scope_names.includes('onboarding:connect') || !g.scope_names.includes('onboarding:connect')) return { result: errorResult(403, 'scope_forbidden') };
        const selected = g.workspace_ids.includes(proposed.workspace_id);
        const created = state.routine?.created_workspaces[proposed.workspace_id];
        const owned = g.workspace_selector === 'owned_and_selected' ? await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${proposed.workspace_id}::uuid AND user_id=${owner}::uuid AND role='owner' AND revoked_at IS NULL FOR SHARE` : [];
        if (g.withdrawn_workspace_ids.includes(proposed.workspace_id) ||
            !(selected || owned.length === 1 || created?.grant_id === g.grant_id) ||
            (created?.grant_id === g.grant_id && (!created.scope_names.includes('onboarding:connect') || !g.created_workspace_policy.scope_names.includes('onboarding:connect'))) ||
            !await currentRights(tx, owner, [proposed.workspace_id], ['onboarding:connect'])) return { result: errorResult(403, 'workspace_forbidden') };
        // A refused command replay remains refused. Accepted intake replies are
        // refreshed from the projection so cancellation/expiry cannot be hidden.
        if (prior[0].response.status === 200) {
          const saved = adminRecord(prior[0].response.body.connection_attempt);
          const attempt = state.connections?.[String(saved?.attempt_id)];
          if (!attempt || attempt.parent_admin_grant_id !== g.grant_id || attempt.workspace_id !== proposed.workspace_id) return { result: errorResult(403, 'connection_attempt_forbidden') };
          if (proposed.kind === 'admin_prepare_connection' &&
              (!g.target_rules.recipient_user_ids.includes(attempt.intended_owner_user_id) ||
               !g.target_rules.recipient_connection_ids.includes(attempt.recipient_connection_id) ||
               !g.target_rules.transports.includes(attempt.transport))) return { result: errorResult(403, 'recipient_forbidden') };
          const result = adminConnectionResult(attempt, now);
          return { result: result.status === 200 ? { ...result, body: { ...prior[0].response.body, ...result.body } } : result };
        }
      }
    }
    if (actor.kind === 'credential_runtime' && proposed && 'grant_id' in proposed) {
      const g = state.grants[proposed.grant_id];
      if (!g || g.state !== 'active' || g.expires_at <= now || g.refresh_deadline <= now ||
          actor.resource !== ADMIN_RESOURCE || actor.connection_id !== g.connection_id || actor.client_id !== g.client_id ||
          !await currentRights(tx, owner, g.workspace_ids.filter(w => !g.withdrawn_workspace_ids.includes(w)), g.scope_names)) return { result: errorResult(403, 'grant_inactive') };
    }
    return { result: prior[0].response };
  }
  let seq = Number(account.seq);
  const context: AdminDecisionContext = { actor, owner_user_id: owner, now, command_id: commandId,
    stream_id: account.stream_id, request_digest: requestDigest, nextSeq: () => ++seq,
    nextEventId: () => crypto.randomUUID(), current_workspace_rights: false,
    withdrawing_workspace_owner: false, target_workspace_owned_by_grantor: false, presenting_refresh_generation: credential?.generation ?? null, presenting_refresh_lineage_id: credential?.credential_lineage_id ?? null };
  if (approvalCommand && authentication.kind === 'human') {
    const rows = await tx<(Omit<AdminClientApproval, 'approved_at' | 'withdrawn_at'> & { approved_at: Date; withdrawn_at: Date | null })[]>`
      SELECT * FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id = ${owner}::uuid
      AND client_id = ${approvalCommand.client_id} AND verification_version = ${approvalCommand.verification_version} FOR UPDATE`;
    const row = rows[0];
    const approval: AdminClientApproval | null = row ? { ...row, approved_at: row.approved_at.getTime(), withdrawn_at: row.withdrawn_at?.getTime() ?? null } : null;
    if (approval) state.client_approvals = { ...state.client_approvals,
      [canonicalAdminJson([owner, approvalCommand.client_id, approvalCommand.verification_version])]: approval };
    const bindings = approvalCommand.kind === 'withdraw_admin_client_approval' ? await tx<{ admin_grant_id: string }[]>`
      SELECT admin_grant_id FROM commonswarm_oauth.admin_grant_bindings WHERE owner_user_id = ${owner}::uuid
      AND client_id = ${approvalCommand.client_id} AND verification_version = ${approvalCommand.verification_version}
      ORDER BY admin_grant_id` : [];
    context.client_policy = { client_id: approvalCommand.client_id, verification_version: approvalCommand.verification_version,
      verification_active: verification[0]?.active === true && verification[0].withdrawn_at === null,
      approval, linked_grant_ids: bindings.map(b => b.admin_grant_id) };
  }
  let command = proposed;
  if (prepare && authentication.kind === 'human' && raw && adminExactKeys(raw, ['kind', 'manifest', 'full_account_selected'])) {
    // Defaults are server-computed, then included in the exact summary returned for confirmation.
    const candidate = adminRecord(raw.manifest);
    const existingIdentity = Object.values(state.grants).find(g => g.connection_id === candidate?.connection_id && g.client_id === candidate?.client_id)?.admin_identity_id;
    const manifest = candidate ? { ...candidate, mode: candidate.mode ?? 'granular',
      workspace_selector: candidate.workspace_selector ?? ((candidate.mode ?? 'granular') === 'granular' ? 'selected' : 'owned_and_selected'),
      scope_names: candidate.scope_names ?? ['admin:read'], admin_identity_id: existingIdentity ?? crypto.randomUUID(),
      expires_at: candidate.expires_at ?? now + ADMIN_GRANT_TTL_SECONDS * 1000,
      refresh_deadline: candidate.refresh_deadline ?? now + ADMIN_GRANT_TTL_SECONDS * 1000 } : null;
    if (adminManifestValid(manifest, now) && typeof raw.full_account_selected === 'boolean') {
      command = { kind: 'prepare_admin_consent', consent: {
        consent_receipt_id: crypto.randomUUID(), owner_user_id: owner,
        session_binding: authentication.identity.session_binding, manifest,
        manifest_digest: await adminDigest(manifest), full_account_selected: raw.full_account_selected,
        expires_at: now + ADMIN_ACCESS_TTL_SECONDS * 1000, consumed_at: null,
      } };
    }
  }
  const grant = credential ? state.grants[credential.grant_id] : command && 'grant_id' in command ? state.grants[command.grant_id] : undefined;
  const manifest = command?.kind === 'prepare_admin_consent' ? command.consent.manifest : command?.kind === 'grant_admin_delegation' ? state.consents[command.consent_receipt_id]?.manifest : grant;
  context.current_workspace_rights = manifest ? await currentRights(tx, owner, manifest.workspace_ids.filter(w => !grant?.withdrawn_workspace_ids.includes(w)), manifest.scope_names) : false;
  if (command?.kind === 'admin_read_metadata' && command.workspace_id !== null) context.current_workspace_rights = await currentRights(tx, owner, [command.workspace_id]);
  if (command?.kind === 'withdraw_admin_workspace_access' && authentication.kind === 'human') {
    const rows = await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id = ${command.workspace_id}::uuid AND user_id = ${authentication.identity.user_id}::uuid AND role = 'owner' AND revoked_at IS NULL FOR SHARE`;
    context.withdrawing_workspace_owner = rows.length === 1;
    const owned = await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id = ${command.workspace_id}::uuid
      AND user_id = ${owner}::uuid AND role = 'owner' AND revoked_at IS NULL FOR SHARE`;
    context.target_workspace_owned_by_grantor = owned.length === 1;
  }
  const routineCommand = parseAdminRoutineCommand(command);
  let recipientRuntime: VerifiedAdminRuntime | undefined;
  if (authentication.kind === 'access' && authentication.recipient_runtime_credential !== undefined) {
    try { recipientRuntime = await runtimeVerifier.verify(authentication.recipient_runtime_credential); } catch { /* Core refuses without verified delivery. */ }
    if (!grant || recipientRuntime?.grant_id !== grant.grant_id || recipientRuntime.owner_user_id !== owner || recipientRuntime.expires_at <= now || !grant.target_rules.recipient_connection_ids.includes(recipientRuntime.connection_id) || recipientRuntime.client_id !== grant.client_id) recipientRuntime = undefined;
  }
  let routineRefusal: string | null = null;
  if (routineCommand) {
    if (actor.kind !== 'delegated_admin') routineRefusal = 'credential_kind_forbidden';
    else if (!grant || routineCommand.grant_id !== actor.grant_id) routineRefusal = 'grant_binding_mismatch';
    else if (grant.state !== 'active' || grant.expires_at <= now || grant.refresh_deadline <= now) routineRefusal = 'grant_inactive';
    else {
      const scope = Object.entries(ADMIN_SCOPE_REGISTRY).find(([,commands]) => (commands as readonly string[]).includes(routineCommand.kind))?.[0] as AdminScope | undefined;
      if (!scope || !grant.scope_names.includes(scope) || !actor.scope_names.includes(scope)) routineRefusal = 'scope_forbidden';
      if (routineCommand.kind !== 'admin_create_workspace' && !grant.workspace_ids.includes(routineCommand.workspace_id) && state.routine?.created_workspaces[routineCommand.workspace_id]?.grant_id !== grant.grant_id) {
        const owned = grant.workspace_selector === 'owned_and_selected' ? await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${routineCommand.workspace_id}::uuid AND user_id=${owner}::uuid AND role='owner' AND revoked_at IS NULL FOR SHARE` : [];
        if (owned.length !== 1) routineRefusal = 'workspace_forbidden';
      }
      if (grant.withdrawn_workspace_ids.includes(routineCommand.workspace_id)) routineRefusal = 'workspace_forbidden';
    }
  }
  const routineContext = routineCommand && routineRefusal === null ? await prepareAdminRoutine(tx, routineCommand, state, context, recipientRuntime?.connection_id ?? null) : null;
  let refusal: string | null = !wireValid ? 'invalid_request' : command === null ? actor.kind === 'delegated_admin' ? 'human_confirmation_required' : 'invalid_request' : routineRefusal;
  let allowance: Awaited<ReturnType<typeof charge>> | null = null;
  if (authentication.kind === 'human' && (prepare || approvalCommand || command?.kind === 'grant_admin_delegation' || command?.kind === 'narrow_admin_delegation') && (!hasFreshInteractiveAuth(authentication.identity.interactive_at_seconds, now) || !authentication.identity.csrf_verified || !/^[0-9a-f]{64}$/u.test(authentication.identity.session_binding))) refusal = 'human_confirmation_required';
  if (authentication.kind === 'access' && (credential!.revoked_at !== null || credential!.access_expires_at.getTime() <= now || state.lineages[credential!.credential_lineage_id]?.generation !== credential!.generation)) refusal = 'credential_expired';
  if (authentication.kind === 'runtime' && credential && command && 'grant_id' in command &&
      (command.grant_id !== credential.grant_id || ('credential_lineage_id' in command && command.credential_lineage_id !== credential.credential_lineage_id))) refusal = 'refresh_binding_mismatch';
  if (authentication.kind === 'runtime' && credential && (credential.revoked_at !== null || credential.refresh_deadline.getTime() <= now)) refusal = 'refresh_invalid';
  if (command?.kind === 'narrow_admin_delegation' && await adminDigest(command.manifest) !== command.manifest_digest) refusal = 'manifest_mismatch';
  if (grant) {
    const rateGrant = routineContext && (state.routine?.created_workspaces[routineCommand!.workspace_id]?.grant_id === grant.grant_id || grant.workspace_selector === 'owned_and_selected' && routineContext.workspace?.members[owner]?.role === 'owner' && routineContext.workspace?.members[owner]?.revoked_at === null) ? {...grant,workspace_ids:[...new Set([...grant.workspace_ids,routineCommand!.workspace_id])]} : grant;
    const buckets = adminRatePolicy(actor, rateGrant, String(raw?.kind), id(raw?.workspace_id) ? raw.workspace_id : null,
      authentication.kind === 'runtime' ? credential?.credential_lineage_id ?? null : null,
      command && 'grant_id' in command ? command.grant_id : null);
    allowance = await charge(tx, buckets, now);
    // The core independently applies the same ceiling to the pre-attempt
    // counters; SQL atomically aggregates connection/account/workspace buckets.
    for (const bucket of allowance.buckets) state.rate_buckets[bucket.key] = { hour_start: bucket.hour_start, attempts: bucket.attempts - 1 };
    const replay = authentication.kind === 'runtime' && credential &&
      (command?.kind === 'rotate_admin_credential' || command?.kind === 'record_admin_credential_replay') &&
      command.grant_id === credential.grant_id && command.credential_lineage_id === credential.credential_lineage_id &&
      command.generation === credential.generation && credential.generation < (state.lineages[credential.credential_lineage_id]?.generation ?? -1);
    if (!allowance.allowed && !replay) refusal = 'rate_limited';
  }
  // Verified malformed/refused requests still produce an account action record,
  // without resolving targets outside the authenticated account.
  const decision = refusal === null && command ? routineCommand && routineContext ? decideAdminRoutine(routineCommand, state, routineContext) : decideAdminAuthority(command as AdminCommand, state, context) : {
    ok: false, reason: refusal ?? 'invalid_request', events: [] as AdminAccountEvent[],
  };
  if (decision.events.length === 0) decision.events.push({
    stream_kind: 'account', owner_user_id: owner, stream_id: account.stream_id, seq: ++seq,
    event_id: crypto.randomUUID(), command_id: commandId, type: 'AdminActionRecorded', schema_version: 1,
    actor_user: actor.kind === 'human' ? actor.user_id : null, actor_agent_principal: null, actor_run: null,
    admin_identity_id: grant?.admin_identity_id ?? null, grant_id: grant?.grant_id ?? null,
    grant_manifest_digest: grant?.manifest_digest ?? null, occurred_at_server: now,
    payload: { audit_record_id: crypto.randomUUID(), grant_id: grant?.grant_id ?? null,
      admin_identity_id: grant?.admin_identity_id ?? null, connection_id: grant?.connection_id ?? null,
      action: auditAction(raw),
      target_kind: approvalCommand ? 'admin_client' : 'admin_grant', target_id: approvalCommand?.client_id ?? grant?.grant_id ?? null,
      ...(approvalCommand ? { client_id: approvalCommand.client_id, verification_version: approvalCommand.verification_version } : {}), workspace_id: null,
      manifest_digest: grant?.manifest_digest ?? null, request_digest: requestDigest,
      outcome: 'refused', reason_code: decision.reason, policy_check: decision.reason,
      related_event_ids: [], next_action: 'Ask the granting person to review this connection.', recovery_kind: 'human' },
  });
  if (allowance !== null) {
    const audit = decision.events.find(e => e.type === 'AdminActionRecorded');
    if (audit) audit.payload.policy_check = { result: decision.reason ?? 'passed', buckets: allowance.buckets };
  }
  for (const event of decision.events) {
    if (event.payload.worker_policy) {
      const policyDigest = await adminDigest(event.payload.worker_policy);
      if ('policy_digest' in event.payload) event.payload.policy_digest = policyDigest;
      if ('worker_policy_digest' in event.payload) event.payload.worker_policy_digest = policyDigest;
    }
  }
  const workerDelivery = routineCommand && routineContext ? await applyAdminRoutine(tx, routineCommand, routineContext, decision as AdminRoutineDecision) : undefined;
  // The OAuth approval trigger fences linked families; the retired opaque table is inaccessible after M3.
  const next = await persistEvents(tx, owner, state, decision.events, approvalCommand === null);
  for (const event of decision.events) {
    if (event.type === 'AdminClientApproved') {
      await tx`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id, client_id, verification_version,
        approved_at, approval_event_id, approval_command_id)
        VALUES (${owner}::uuid, ${event.payload.client_id as string}, ${event.payload.verification_version as number},
          ${new Date(now)}, ${event.event_id}::uuid, ${commandId})`;
    } else if (event.type === 'AdminClientApprovalWithdrawn') {
      // Invoker guard validates this committed-in-transaction human event and calls fence_admin_family for every linked binding.
      await tx`UPDATE commonswarm_oauth.admin_client_owner_approvals SET withdrawn_at = ${new Date(now)},
        withdrawal_event_id = ${event.event_id}::uuid, withdrawal_reason = ${event.payload.reason_code as string}
        WHERE owner_user_id = ${owner}::uuid AND client_id = ${event.payload.client_id as string}
          AND verification_version = ${event.payload.verification_version as number}`;
    }
  }
  if (command?.kind === 'prepare_admin_consent' && decision.ok) {
    const c = command.consent;
    await tx`INSERT INTO swarm.admin_consents(consent_receipt_id, owner_user_id, session_binding, manifest_digest, manifest, full_account_selected, expires_at)
      VALUES (${c.consent_receipt_id}::uuid, ${owner}::uuid, ${c.session_binding}, ${c.manifest_digest}, ${tx.json(c.manifest as unknown as postgres.JSONValue)}, ${c.full_account_selected}, ${new Date(c.expires_at)})`;
  }
  let delivery: AdminCredentialDelivery | undefined;
  if (decision.ok && command && (command.kind === 'issue_admin_credential' || command.kind === 'rotate_admin_credential')) {
    const lineage = next.lineages[command.credential_lineage_id]!;
    const g = next.grants[command.grant_id]!;
    delivery = { access_credential: opaque('swm_adm_'), refresh_credential: opaque('swm_adr_'), resource: ADMIN_RESOURCE,
      grant_id: g.grant_id, connection_id: g.connection_id, credential_lineage_id: lineage.credential_lineage_id,
      generation: lineage.generation, access_expires_at: lineage.access_expires_at, refresh_deadline: lineage.refresh_deadline };
    if (command.kind === 'rotate_admin_credential') await tx`UPDATE swarm.admin_credentials SET consumed_at = ${new Date(now)} WHERE credential_lineage_id = ${lineage.credential_lineage_id}::uuid AND generation = ${command.generation}`;
    await tx`INSERT INTO swarm.admin_credentials(credential_id, grant_id, credential_lineage_id, generation, access_hash, refresh_hash, access_expires_at, refresh_deadline, scope_names)
      VALUES (${crypto.randomUUID()}::uuid, ${g.grant_id}::uuid, ${lineage.credential_lineage_id}::uuid, ${lineage.generation}, ${await digest(delivery.access_credential)}, ${await digest(delivery.refresh_credential)}, ${new Date(lineage.access_expires_at)}, ${new Date(lineage.refresh_deadline)}, ${lineage.scope_names})`;
  }
  let result: Result = decision.ok ? { status: 200, body: {
    status: delivery || workerDelivery || decision.events.some(e => e.payload.delivery_state) ? 'pending' : 'accepted', events: decision.events,
    ...(workerDelivery ? { delivery_state: 'awaiting_delivery', next_action: 'The authenticated recipient runtime must store the credential and verify its connection.' } : {}),
    ...(delivery ? { delivery_state: 'awaiting_delivery', next_action: 'The authenticated runtime must store the credentials.' } : {}),
    ...(command?.kind === 'prepare_admin_consent' ? { consent_receipt_id: command.consent.consent_receipt_id, manifest_digest: command.consent.manifest_digest, manifest: command.consent.manifest, expires_at: command.consent.expires_at } : {}),
    ...(command?.kind === 'admin_read_metadata' ? { grant: { ...next.grants[command.grant_id],
      state: next.grants[command.grant_id]?.state === 'active' && (next.grants[command.grant_id]!.expires_at <= now || next.grants[command.grant_id]!.refresh_deadline <= now) ? 'expired' : next.grants[command.grant_id]?.state } } : {}),
  } } : errorResult(decision.reason === 'rate_limited' ? 429 : decision.reason === 'invalid_request' ? 400 : 403, decision.reason ?? 'forbidden');
  if (decision.ok && (command?.kind === 'admin_prepare_connection' || command?.kind === 'admin_cancel_connection')) {
    const attemptId = command.kind === 'admin_cancel_connection' ? command.attempt_id
      : decision.events.find(e => e.type === 'AdminActionRecorded')?.payload.attempt_id;
    const current = adminConnectionResult(next.connections?.[String(attemptId)], now);
    result = current.status === 200 ? { ...current, body: { ...result.body, ...current.body } } : current;
  }
  await tx`INSERT INTO swarm.admin_command_results(owner_user_id, actor_key, command_id, request_digest, response) VALUES (${owner}::uuid, ${actorKey}, ${commandId}, ${requestDigest}, ${tx.json(result as unknown as postgres.JSONValue)})`;
  return { result, ...(delivery ? { delivery } : {}), ...(workerDelivery ? { worker_delivery: workerDelivery } : {}) };
}

/** A failed transaction retains only its failure card, in a new transaction.
 * No exception message, SQL parameter, secret or success event is copied here.
 */
export async function recordAdminFailure(tx: Sql, input: AdminInput, authentication: AdminAuthentication): Promise<void> {
  let runtime: VerifiedAdminRuntime | undefined;
  if (authentication.kind === 'runtime') {
    try { runtime = await runtimeVerifier.verify(authentication.credential); }
    catch {
      await tx`INSERT INTO swarm.admin_security_audit(audit_id, occurred_at, reason_code) VALUES (${crypto.randomUUID()}::uuid, statement_timestamp(), 'unauthenticated_admin_runtime')`;
      return;
    }
    if (input.resource !== runtime.resource || adminRecord(input.command)?.grant_id !== runtime.grant_id) return;
  }
  const raw = adminRecord(input.command);
  let owner: string | undefined, grantId: string | undefined;
  let failedCredential: CredentialRow | undefined;
  if (authentication.kind === 'human') owner = authentication.identity.user_id;
  else if (authentication.kind === 'system') owner = authentication.owner_user_id;
  else if (authentication.kind === 'access' || authentication.refresh_credential !== undefined) {
    const secret = authentication.kind === 'access' ? authentication.credential : authentication.refresh_credential!;
    const rows = await tx<CredentialRow[]>`
      SELECT c.*, g.owner_user_id FROM swarm.admin_credentials c JOIN swarm.admin_grants g USING(grant_id)
      WHERE c.access_hash = ${await digest(secret)} OR c.refresh_hash = ${await digest(secret)}
    `;
    owner = rows[0]?.owner_user_id; grantId = rows[0]?.grant_id;
    failedCredential = rows[0];
  } else if (id(raw?.grant_id)) {
    const rows = await tx<{ owner_user_id: string; grant_id: string }[]>`
      SELECT owner_user_id, grant_id FROM swarm.admin_grants WHERE grant_id = ${raw.grant_id}::uuid
        AND owner_user_id = ${runtime!.owner_user_id}::uuid AND resource = ${runtime!.resource}
        AND connection_id = ${runtime!.connection_id}::uuid AND client_id = ${runtime!.client_id}
    `;
    owner = rows[0]?.owner_user_id; grantId = rows[0]?.grant_id;
  }
  if (runtime) {
    if (owner !== runtime.owner_user_id || grantId !== runtime.grant_id) return;
    const bound = await tx`SELECT grant_id FROM swarm.admin_grants
      WHERE grant_id = ${runtime.grant_id}::uuid AND owner_user_id = ${runtime.owner_user_id}::uuid
        AND connection_id = ${runtime.connection_id}::uuid AND client_id = ${runtime.client_id}
        AND resource = ${runtime.resource}`;
    if (bound.length !== 1) return;
  }
  if (owner) await tx`SELECT user_id FROM swarm.users WHERE user_id=${owner}::uuid FOR UPDATE`;
  const rows = owner ? await tx<{ stream_id: string; seq: string | number; projection: AdminAccountState }[]>`
    SELECT stream_id, seq, projection FROM swarm.admin_accounts WHERE owner_user_id = ${owner}::uuid FOR UPDATE
  ` : [];
  const account = rows[0];
  if (!owner || !account) {
    await tx`INSERT INTO swarm.admin_security_audit(audit_id, occurred_at, reason_code) VALUES (${crypto.randomUUID()}::uuid, statement_timestamp(), 'admin_transaction_failed')`;
    return;
  }
  const grant = account.projection.grants[grantId ?? (id(raw?.grant_id) ? raw.grant_id : '')];
  const clock = await tx<{ now: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`;
  const actor: AdminActor = authentication.kind === 'human' ? { kind: 'human', user_id: authentication.identity.user_id, session_binding: authentication.identity.session_binding }
    : authentication.kind === 'system' ? { kind: 'system' }
    : authentication.kind === 'runtime' ? { kind: 'credential_runtime', connection_id: runtime!.connection_id, client_id: runtime!.client_id, resource: runtime!.resource }
    : { kind: 'delegated_admin', grant_id: grant?.grant_id ?? '', admin_identity_id: grant?.admin_identity_id ?? '',
      connection_id: grant?.connection_id ?? '', resource: ADMIN_RESOURCE, scope_names: failedCredential?.scope_names ?? [], access_expires_at: failedCredential?.access_expires_at.getTime() ?? 0 };
  const allowance = grant ? await charge(tx, adminRatePolicy(actor, grant, String(raw?.kind), id(raw?.workspace_id) ? raw.workspace_id : null,
    authentication.kind === 'runtime' ? failedCredential?.credential_lineage_id ?? null : null, id(raw?.grant_id) ? raw.grant_id : null), clock[0]!.now) : { buckets: [] };
  const event: AdminAccountEvent = {
    stream_kind: 'account', owner_user_id: owner, stream_id: account.stream_id, seq: Number(account.seq) + 1,
    event_id: crypto.randomUUID(), command_id: typeof input.command_id === 'string' ? input.command_id : crypto.randomUUID(),
    type: 'AdminActionRecorded', schema_version: 1, occurred_at_server: clock[0]!.now,
    actor_user: authentication.kind === 'human' ? authentication.identity.user_id : null,
    actor_agent_principal: null, actor_run: null, admin_identity_id: grant?.admin_identity_id ?? null,
    grant_id: grant?.grant_id ?? null, grant_manifest_digest: grant?.manifest_digest ?? null,
    payload: { audit_record_id: crypto.randomUUID(), grant_id: grant?.grant_id ?? null,
      admin_identity_id: grant?.admin_identity_id ?? null, connection_id: grant?.connection_id ?? null,
      action: auditAction(raw),
      target_kind: 'admin_grant', target_id: grant?.grant_id ?? null, workspace_id: null,
      manifest_digest: grant?.manifest_digest ?? null, request_digest: await adminDigest(input),
      outcome: 'failed', reason_code: 'admin_transaction_failed', policy_check: { result: 'rolled_back', buckets: allowance.buckets }, related_event_ids: [],
      next_action: 'Ask the granting person to review the failed connection.', recovery_kind: 'human' },
  };
  await tx`INSERT INTO swarm.admin_events(owner_user_id, seq, event_id, command_id, event)
    VALUES (${owner}::uuid, ${event.seq}, ${event.event_id}::uuid, ${event.command_id}, ${tx.json(event as unknown as postgres.JSONValue)})`;
  const projection = reduceAdminAuthority(account.projection, event);
  await tx`UPDATE swarm.admin_accounts SET seq = ${event.seq}, projection = ${tx.json(projection as unknown as postgres.JSONValue)} WHERE owner_user_id = ${owner}::uuid`;
  if (typeof input.command_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.command_id)) {
    const actorKey = actor.kind === 'human' ? `human:${actor.user_id}` : actor.kind === 'delegated_admin' ? `delegated_admin:${actor.admin_identity_id}` : actor.kind === 'credential_runtime' ? `runtime:${actor.connection_id}` : 'system';
    await tx`INSERT INTO swarm.admin_command_results(owner_user_id, actor_key, command_id, request_digest, response)
      VALUES (${owner}::uuid, ${actorKey}, ${input.command_id}, ${await adminDigest(input)}, ${tx.json(errorResult(500, 'admin_command_failed') as unknown as postgres.JSONValue)})
      ON CONFLICT(owner_user_id, actor_key, command_id) DO NOTHING`;
  }
}
