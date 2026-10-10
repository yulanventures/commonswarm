import { isVerifiedAdminAdmission } from './admin-admission.ts';
import { prepareAdminRoutine, applyAdminRoutine, type AdminWorkerDelivery } from './admin-routine.ts';
import { adminWorkerChannelConnection, type AdminWorkerChannel } from './admin-worker-delivery.ts';
import { adminConnectionResult } from './admin-connection-result.ts';
import type { AdminRoutineCommand, AdminRoutineDecision } from '../_shared/admin-routine.d.ts';
import { type AdminAdmission, type AdminInput } from '../_shared/admin-oauth-auth.ts';
import { adminAccessState, adminRequestAudit, adminSecurityFailure, type AdminAuditKind } from '../_shared/admin-oauth-db.ts';
import type postgres from 'npm:postgres@3.4.9';
import { hasFreshInteractiveAuth } from './fresh-auth.ts';
import {
  ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS, ADMIN_GRANT_TTL_SECONDS,
  ADMIN_SCOPE_REGISTRY, adminRatePolicy, adminEffectiveCapabilities, adminGrantManifest,
  ADMIN_UUID_RE, adminRecord, adminExactKeys, adminManifestValid, adminScopes,
  canonicalAdminJson, parseAdminClientApprovalCommand, parseAdminRoutineCommand, decideAdminRoutine, decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount, adminAccountWithDurableGrants,
} from '../_shared/protocol.js';
import type { AdminActor, AdminCommand, AdminAccountState, AdminAccountEvent, AdminConsent, AdminClientApproval, AdminDecisionContext } from '../_shared/admin-authority.d.ts';
import type { AdminManifest, AdminScope } from '../_shared/admin-policy.d.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type Result = { status: number; body: Record<string, unknown> };
export type { AdminInput } from '../_shared/admin-oauth-auth.ts';
export interface AdminHumanIdentity {
  user_id: string; session_binding: string; interactive_at_seconds: number | null; csrf_verified: boolean;
}
export type AdminAuthentication =
  | { kind: 'human'; identity: AdminHumanIdentity }
  | { kind: 'oauth'; admission: AdminAdmission; worker_channel?: AdminWorkerChannel };
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
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export async function adminDigest(value: unknown): Promise<string> {
  return Array.from(await digest(canonicalAdminJson(value)), n => n.toString(16).padStart(2, '0')).join('');
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
async function persistEvents(tx: Sql, owner: string, state: AdminAccountState, events: readonly AdminAccountEvent[]): Promise<AdminAccountState> {
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
 * Every delegated call requires OAuth proof provenance and a matching issuance.
 */
export async function adminTransaction(tx: Sql, input: AdminInput, authentication: AdminAuthentication, operation?: AdminAuditKind): Promise<{ result: Result; worker_delivery?: AdminWorkerDelivery }> {
  // Only the common raw-request verifier can produce delegated admission.
  if (authentication.kind !== 'human' &&
      (authentication.kind !== 'oauth' || !isVerifiedAdminAdmission(authentication.admission))) {
    await adminSecurityFailure(tx, 'unknown_admin_credential');
    return { result: errorResult(401, 'unauthenticated') };
  }
  const oauth = authentication.kind === 'oauth' ? authentication.admission : null;
  const token = oauth?.token;
  const auditKind: AdminAuditKind = operation ?? (adminRecord(input.command)?.kind === 'admin_read_metadata' ? 'read' : 'action');
  let boundCapabilities: string[] = [];
  const requestId = typeof input.command_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.command_id) ? input.command_id : crypto.randomUUID();
  if (oauth) {
    const status = await adminAccessState(tx, oauth);
    if (!status.known) {
      await adminSecurityFailure(tx, 'unknown_admin_credential');
      return { result: errorResult(401, 'unauthenticated') };
    }
    boundCapabilities = status.capabilities;
    if (!status.active) {
      await adminRequestAudit(tx, oauth, auditKind, requestId, 'refused', 'inactive');
      return { result: errorResult(403, 'grant_inactive') };
    }
  }
  let audited = false;
  const finish = async (result: Result, events: string[] = []) => {
    if (oauth && !audited) await adminRequestAudit(tx, oauth, auditKind, requestId,
      result.status === 200 ? 'committed' : 'refused', result.status === 200 ? null : 'forbidden', events);
    if (oauth && result.status === 200 && adminRecord(result.body.grant)) result = { ...result, body: { ...result.body, effective_capability_names: adminEffectiveCapabilities(result.body.grant as AdminManifest, oauth.token.scope_names).filter((name: string) => boundCapabilities.includes(name)) } };
    return { result };
  };
  const stream = adminRecord(input.stream), raw = adminRecord(input.command);
  const validCommandId = typeof input.command_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.command_id);
  const commandId = validCommandId ? input.command_id as string : crypto.randomUUID();
  const wireValid = validCommandId && stream !== null && adminExactKeys(stream, ['kind']) && stream.kind === 'account' && input.resource === ADMIN_RESOURCE &&
    !Object.keys(input).some(key => !['command_id', 'stream', 'resource', 'command', 'client_version', 'client_build'].includes(key));
  if (oauth && (raw?.kind === 'admin_read_metadata' || parseAdminRoutineCommand(raw)) && !boundCapabilities.includes(String(raw?.kind))) return await finish(errorResult(403, 'capability_forbidden'));
  const prepare = raw?.kind === 'prepare_admin_consent';
  const proposed = parseCommand(raw);
  let owner: string | undefined = authentication.kind === 'human' ? authentication.identity.user_id : token!.owner_user_id;
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
  if (!owner || !id(owner)) return await finish(errorResult(403, 'forbidden'));
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
  // Lock order: lockPrincipalName in command/index.ts. A human who withdraws another owner's
  // grant already holds their own users row (authenticateHuman), so the grantor's row is
  // KEY SHARE: two owners who withdraw each other's grants cannot wait on each other's row.
  // Withdrawal creates no principal; admin_accounts FOR UPDATE below orders it with the grantor.
  if (authentication.kind === 'human' && owner !== authentication.identity.user_id) await tx`SELECT user_id FROM swarm.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  else await tx`SELECT user_id FROM swarm.users WHERE user_id=${owner}::uuid FOR NO KEY UPDATE`;
  // Only humans create account streams. No grant ID chosen by an admin creates state.
  if (authentication.kind === 'human') await tx`INSERT INTO swarm.admin_accounts(owner_user_id, stream_id) VALUES (${owner}::uuid, ${crypto.randomUUID()}::uuid) ON CONFLICT(owner_user_id) DO NOTHING`;
  const accounts = await tx<{ stream_id: string; seq: string | number; projection: AdminAccountState }[]>`SELECT stream_id, seq, projection FROM swarm.admin_accounts WHERE owner_user_id = ${owner}::uuid FOR UPDATE`;
  const account = accounts[0];
  if (!account) return await finish(errorResult(403, 'forbidden'));
  const clock = await tx<{ now: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`;
  const now = clock[0]!.now;
  let state = account.projection ?? emptyAdminAccount();
  const receipts = await tx<(Omit<AdminConsent, 'expires_at' | 'consumed_at'> & { expires_at: Date; consumed_at: Date | null })[]>`SELECT * FROM swarm.admin_consents WHERE owner_user_id = ${owner}::uuid`;
  for (const c of receipts) state.consents[c.consent_receipt_id] = { ...c, expires_at: new Date(c.expires_at).getTime(), consumed_at: c.consumed_at === null ? null : new Date(c.consumed_at).getTime() };
  // Policy-triggered terminal fences are durable authority, even while the
  // cached projection lags. Other mismatches still fail closed.
  const durableGrants = await tx<{ grant_id: string; state: 'active' | 'suspended' | 'revoked' | 'expired'; manifest_digest: string; expires_at: Date; refresh_deadline: Date; revoked_at: Date | null; suspended_at: Date | null; reason_code: string | null }[]>`
    SELECT grant_id, state, manifest_digest, expires_at, refresh_deadline, revoked_at, suspended_at, reason_code FROM swarm.admin_grants
    WHERE owner_user_id = ${owner}::uuid ORDER BY grant_id FOR UPDATE`;
  const reconciled = adminAccountWithDurableGrants(state, durableGrants.map(row => ({ ...row,
    expires_at: row.expires_at.getTime(), refresh_deadline: row.refresh_deadline.getTime(),
    revoked_at: row.revoked_at?.getTime() ?? null, suspended_at: row.suspended_at?.getTime() ?? null })));
  if (!reconciled) throw new Error('admin projection inconsistent');
  state = reconciled;
  // Lock order: lockPrincipalName in command/index.ts. A routine reads its grant's workspaces
  // FOR SHARE (currentRights), then locks its target (admin-routine.ts:48). Take all of them
  // first, once, in workspace_id order and in the stronger mode, so two owners can neither
  // both hold SHARE and wait to raise it, nor lock two workspaces in opposite orders. As in
  // currentRights, only workspaces where the owner has a membership row are locked, except an
  // admin_create_workspace target: admin-routine.ts:48 locks an existing one (workspace_exists).
  const routineTarget = token ? parseAdminRoutineCommand(raw) : null;
  const routineGrant = routineTarget ? state.grants[token!.admin_grant_id] : undefined;
  const createTarget = routineTarget?.kind === 'admin_create_workspace' ? routineTarget.workspace_id : null;
  if (routineTarget && routineGrant) await tx`
    SELECT w.workspace_id FROM swarm.workspaces w
    WHERE w.workspace_id = ANY(${[routineTarget.workspace_id,
      ...routineGrant.workspace_ids.filter(w => !routineGrant.withdrawn_workspace_ids.includes(w))]}::uuid[])
      AND (w.workspace_id = ${createTarget}::uuid OR EXISTS (SELECT 1 FROM swarm.memberships m
        WHERE m.workspace_id = w.workspace_id AND m.user_id = ${owner}::uuid))
    ORDER BY w.workspace_id FOR NO KEY UPDATE OF w`;
  if (token) {
    const bound = state.grants[token.admin_grant_id];
    if (!bound || bound.owner_user_id !== token.owner_user_id || bound.admin_identity_id !== token.admin_identity_id ||
        bound.connection_id !== token.connection_id || bound.client_id !== token.client_id || bound.resource !== token.resource ||
        bound.registry_version !== token.registry_version || bound.manifest_digest !== token.manifest_digest ||
        !adminScopes(bound.scope_names, bound.registry_version) ||
        !adminManifestValid(adminGrantManifest(bound), now, false) ||
        !token.scope_names.every(scope => bound.scope_names.includes(scope as AdminScope)) ||
        !await currentRights(tx, owner, bound.workspace_ids.filter(w => !bound.withdrawn_workspace_ids.includes(w)), token.scope_names)) {
      return await finish(errorResult(403, 'grant_inactive'));
    }
  }
  let actor: AdminActor;
  if (authentication.kind === 'human') actor = { kind: 'human', user_id: authentication.identity.user_id, session_binding: authentication.identity.session_binding };
  else {
    const grant = state.grants[token!.admin_grant_id]!;
    actor = { kind: 'delegated_admin', grant_id: grant.grant_id, admin_identity_id: grant.admin_identity_id,
      connection_id: grant.connection_id, resource: ADMIN_RESOURCE, scope_names: token!.scope_names as AdminScope[],
      access_expires_at: token!.expires_at };
  }
  const actorKey = actor.kind === 'human' ? `human:${actor.user_id}` : `delegated_admin:${actor.admin_identity_id}`;
  const requestDigest = await adminDigest(input);
  const prior = await tx<{ request_digest: string; response: Result }[]>`SELECT request_digest, response FROM swarm.admin_command_results WHERE owner_user_id = ${owner}::uuid AND actor_key = ${actorKey} AND command_id = ${commandId}`;
  // Cached replies recheck current policy and rights before returning any data.
  if (prior[0]) {
    if (prior[0].request_digest !== requestDigest) return await finish(errorResult(409, 'command_id_conflict'));
    if (actor.kind === 'delegated_admin') {
      const g = state.grants[actor.grant_id];
      if (!g || g.state !== 'active' || g.expires_at <= now || g.refresh_deadline <= now || actor.access_expires_at <= now ||
          !actor.scope_names.every(scope => g.scope_names.includes(scope))) return await finish(errorResult(403, 'grant_inactive'));
      if (!adminManifestValid(adminGrantManifest(g), now, false) || !adminEffectiveCapabilities(g, actor.scope_names).includes(String(raw?.kind))) return await finish(errorResult(403, 'capability_forbidden'));
      const replayRoutine = parseAdminRoutineCommand(proposed);
      if (replayRoutine && replayRoutine.kind !== 'admin_create_workspace' && !await currentRights(tx, owner, [replayRoutine.workspace_id], actor.scope_names)) return await finish(errorResult(403, 'current_rights_required'));
      if (prior[0].response.status === 200 && raw?.kind === 'admin_read_metadata' && adminRecord(prior[0].response.body.grant)?.manifest_digest !== g.manifest_digest) return await finish(errorResult(403, 'grant_changed'));
      if (raw?.kind === 'admin_read_metadata' && id(raw.workspace_id) && (!g.workspace_ids.includes(raw.workspace_id) || g.withdrawn_workspace_ids.includes(raw.workspace_id) || !await currentRights(tx, owner, [raw.workspace_id]))) return await finish(errorResult(403, 'workspace_forbidden'));
      if (proposed?.kind === 'admin_prepare_connection' || proposed?.kind === 'admin_cancel_connection') {
        if (!actor.scope_names.includes('onboarding:connect') || !g.scope_names.includes('onboarding:connect')) return await finish(errorResult(403, 'scope_forbidden'));
        const selected = g.workspace_ids.includes(proposed.workspace_id);
        const created = state.routine?.created_workspaces[proposed.workspace_id];
        const owned = g.workspace_selector === 'owned_and_selected' ? await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${proposed.workspace_id}::uuid AND user_id=${owner}::uuid AND role='owner' AND revoked_at IS NULL FOR SHARE` : [];
        if (g.withdrawn_workspace_ids.includes(proposed.workspace_id) ||
            !(selected || owned.length === 1 || created?.grant_id === g.grant_id) ||
            (created?.grant_id === g.grant_id && (!created.scope_names.includes('onboarding:connect') || !g.created_workspace_policy.scope_names.includes('onboarding:connect'))) ||
            !await currentRights(tx, owner, [proposed.workspace_id], ['onboarding:connect'])) return await finish(errorResult(403, 'workspace_forbidden'));
        // A refused command replay remains refused. Accepted intake replies are
        // refreshed from the projection so cancellation/expiry cannot be hidden.
        if (prior[0].response.status === 200) {
          const saved = adminRecord(prior[0].response.body.connection_attempt);
          const attempt = state.connections?.[String(saved?.attempt_id)];
          if (!attempt || attempt.parent_admin_grant_id !== g.grant_id || attempt.workspace_id !== proposed.workspace_id) return await finish(errorResult(403, 'connection_attempt_forbidden'));
          if (proposed.kind === 'admin_prepare_connection' &&
              (!g.target_rules.recipient_user_ids.includes(attempt.intended_owner_user_id) ||
               !g.target_rules.recipient_connection_ids.includes(attempt.recipient_connection_id) ||
               !g.target_rules.transports.includes(attempt.transport))) return await finish(errorResult(403, 'recipient_forbidden'));
          const result = adminConnectionResult(attempt, now);
          return await finish(result.status === 200 ? { ...result, body: { ...prior[0].response.body, ...result.body } } : result);
        }
      }
    }
    return await finish(prior[0].response);
  }
  let seq = Number(account.seq);
  const context: AdminDecisionContext = { actor, owner_user_id: owner, now, command_id: commandId,
    stream_id: account.stream_id, request_digest: requestDigest, nextSeq: () => ++seq,
    nextEventId: () => crypto.randomUUID(), current_workspace_rights: false,
    withdrawing_workspace_owner: false, target_workspace_owned_by_grantor: false, presenting_refresh_generation: null, presenting_refresh_lineage_id: null };
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
  const grant = token ? state.grants[token.admin_grant_id] : command && 'grant_id' in command ? state.grants[command.grant_id] : undefined;
  const manifest = command?.kind === 'prepare_admin_consent' ? command.consent.manifest : command?.kind === 'grant_admin_delegation' ? state.consents[command.consent_receipt_id]?.manifest : grant;
  // Lock order: lockPrincipalName in command/index.ts. No workspace is locked after the grant's own
  // (the token check above, or this statement), so these reads cannot invert a routine's sorted
  // workspace locks. The core decides without these rights for a delegated grant_admin_delegation
  // (human_confirmation_required) and for a read outside the grant (workspace_forbidden, or the
  // owner's own read, which ignores the workspace).
  const rightsManifest = token && manifest !== grant ? undefined : manifest;
  context.current_workspace_rights = rightsManifest ? await currentRights(tx, owner, rightsManifest.workspace_ids.filter(w => !grant?.withdrawn_workspace_ids.includes(w)), rightsManifest.scope_names) : false;
  if (command?.kind === 'admin_read_metadata' && command.workspace_id !== null) context.current_workspace_rights = !!grant &&
    grant.workspace_ids.includes(command.workspace_id) && !grant.withdrawn_workspace_ids.includes(command.workspace_id) &&
    await currentRights(tx, owner, [command.workspace_id]);
  if (command?.kind === 'withdraw_admin_workspace_access' && authentication.kind === 'human') {
    const rows = await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id = ${command.workspace_id}::uuid AND user_id = ${authentication.identity.user_id}::uuid AND role = 'owner' AND revoked_at IS NULL FOR SHARE`;
    context.withdrawing_workspace_owner = rows.length === 1;
    const owned = await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id = ${command.workspace_id}::uuid
      AND user_id = ${owner}::uuid AND role = 'owner' AND revoked_at IS NULL FOR SHARE`;
    context.target_workspace_owned_by_grantor = owned.length === 1;
  }
  const routineCommand = parseAdminRoutineCommand(command);
  let routineRefusal: string | null = null;
  if (routineCommand) {
    if (actor.kind !== 'delegated_admin') routineRefusal = 'credential_kind_forbidden';
    else if (!grant || routineCommand.grant_id !== actor.grant_id) routineRefusal = 'grant_binding_mismatch';
    else if (grant.state !== 'active' || grant.expires_at <= now || grant.refresh_deadline <= now) routineRefusal = 'grant_inactive';
    else {
      const scope = Object.entries(ADMIN_SCOPE_REGISTRY).find(([,commands]) => (commands as readonly string[]).includes(routineCommand.kind))?.[0] as AdminScope | undefined;
      if (!scope || !grant.scope_names.includes(scope) || !actor.scope_names.includes(scope) || !adminEffectiveCapabilities(grant, actor.scope_names).includes(routineCommand.kind)) routineRefusal = 'scope_forbidden';
      if (routineCommand.kind !== 'admin_create_workspace' && !grant.workspace_ids.includes(routineCommand.workspace_id) && state.routine?.created_workspaces[routineCommand.workspace_id]?.grant_id !== grant.grant_id) {
        const owned = grant.workspace_selector === 'owned_and_selected' ? await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${routineCommand.workspace_id}::uuid AND user_id=${owner}::uuid AND role='owner' AND revoked_at IS NULL FOR SHARE` : [];
        if (owned.length !== 1) routineRefusal = 'workspace_forbidden';
      }
      if (grant.withdrawn_workspace_ids.includes(routineCommand.workspace_id)) routineRefusal = 'workspace_forbidden';
    }
  }
  const routineContext = routineCommand && routineRefusal === null ? await prepareAdminRoutine(tx, routineCommand, state, context, oauth && authentication.kind === 'oauth' ? adminWorkerChannelConnection(authentication.worker_channel, oauth) : null) : null;
  let refusal: string | null = !wireValid ? 'invalid_request' : command === null ? actor.kind === 'delegated_admin' ? 'human_confirmation_required' : 'invalid_request' : routineRefusal;
  let allowance: Awaited<ReturnType<typeof charge>> | null = null;
  if (authentication.kind === 'human' && (prepare || approvalCommand || command?.kind === 'grant_admin_delegation' || command?.kind === 'narrow_admin_delegation') && (!hasFreshInteractiveAuth(authentication.identity.interactive_at_seconds, now) || !authentication.identity.csrf_verified || !/^[0-9a-f]{64}$/u.test(authentication.identity.session_binding))) refusal = 'human_confirmation_required';
  if (command?.kind === 'narrow_admin_delegation' && await adminDigest(command.manifest) !== command.manifest_digest) refusal = 'manifest_mismatch';
  if (grant) {
    const rateGrant = routineContext && (state.routine?.created_workspaces[routineCommand!.workspace_id]?.grant_id === grant.grant_id || grant.workspace_selector === 'owned_and_selected' && routineContext.workspace?.members[owner]?.role === 'owner' && routineContext.workspace?.members[owner]?.revoked_at === null) ? {...grant,workspace_ids:[...new Set([...grant.workspace_ids,routineCommand!.workspace_id])]} : grant;
    const buckets = adminRatePolicy(actor, rateGrant, String(raw?.kind), id(raw?.workspace_id) ? raw.workspace_id : null,
      null,
      command && 'grant_id' in command ? command.grant_id : null);
    allowance = await charge(tx, buckets, now);
    // The core independently applies the same ceiling to the pre-attempt
    // counters; SQL atomically aggregates connection/account/workspace buckets.
    for (const bucket of allowance.buckets) state.rate_buckets[bucket.key] = { hour_start: bucket.hour_start, attempts: bucket.attempts - 1 };
    if (!allowance.allowed) refusal = 'rate_limited';
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
  // Record the decided outcome before effects, in the same transaction. This
  // also allows surrender to terminate its own grant; rollback removes this row.
  if (oauth) {
    await adminRequestAudit(tx, oauth, auditKind, requestId, decision.ok ? 'committed' : 'refused', decision.ok ? null : 'forbidden');
    audited = true;
  }
  const workerDelivery = routineCommand && routineContext ? await applyAdminRoutine(tx, routineCommand, routineContext, decision as AdminRoutineDecision) : undefined;
  // Grant and approval triggers fence linked OAuth families in this same transaction.
  const next = await persistEvents(tx, owner, state, decision.events);
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
  let result: Result = decision.ok ? { status: 200, body: {
    status: workerDelivery || decision.events.some(e => e.payload.delivery_state) ? 'pending' : 'accepted', events: decision.events,
    ...(workerDelivery ? { delivery_state: 'awaiting_delivery', next_action: 'The authenticated recipient runtime must store the credential and verify its connection.' } : {}),
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
  const outcome = await finish(result, decision.events.map(event => event.event_id));
  return { ...outcome, ...(workerDelivery ? { worker_delivery: workerDelivery } : {}) };
}

/** A failed transaction retains only its failure card, in a new transaction.
 * No exception message, SQL parameter, secret or success event is copied here.
 */
export async function recordAdminFailure(tx: Sql, input: AdminInput, authentication: AdminAuthentication, operation?: AdminAuditKind): Promise<void> {
  const oauth = authentication.kind === 'oauth' && isVerifiedAdminAdmission(authentication.admission) ? authentication.admission : null;
  if (authentication.kind !== 'human' && !oauth) { await adminSecurityFailure(tx, 'unknown_admin_credential'); return; }
  if (oauth) {
    const access = await adminAccessState(tx, oauth);
    if (!access.known) { await adminSecurityFailure(tx, 'unknown_admin_credential'); return; }
    await adminRequestAudit(tx, oauth, operation ?? (adminRecord(input.command)?.kind === 'admin_read_metadata' ? 'read' : 'action'),
      typeof input.command_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input.command_id) ? input.command_id : crypto.randomUUID(),
      'refused', 'transaction_failed');
  }
  const raw = adminRecord(input.command);
  const owner = oauth ? oauth.token.owner_user_id : authentication.kind === 'human' ? authentication.identity.user_id : undefined;
  const grantId = oauth ? oauth.token.admin_grant_id : id(raw?.grant_id) ? raw.grant_id : undefined;
  if (owner) await tx`SELECT user_id FROM swarm.users WHERE user_id=${owner}::uuid FOR NO KEY UPDATE`; // Lock order: lockPrincipalName in command/index.ts.
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
  const actor: AdminActor = authentication.kind === 'human' ? { kind: 'human', user_id: owner, session_binding: authentication.identity.session_binding } : { kind: 'delegated_admin', grant_id: oauth!.token.admin_grant_id, admin_identity_id: oauth!.token.admin_identity_id, connection_id: oauth!.token.connection_id, resource: ADMIN_RESOURCE, scope_names: oauth!.token.scope_names as AdminScope[], access_expires_at: oauth!.token.expires_at };
  const allowance = grant ? await charge(tx, adminRatePolicy(actor, grant, String(raw?.kind), id(raw?.workspace_id) ? raw.workspace_id : null,
    null, id(raw?.grant_id) ? raw.grant_id : null), clock[0]!.now) : { buckets: [] };
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
    const actorKey = actor.kind === 'human' ? `human:${actor.user_id}` : `delegated_admin:${actor.admin_identity_id}`;
    await tx`INSERT INTO swarm.admin_command_results(owner_user_id, actor_key, command_id, request_digest, response)
      VALUES (${owner}::uuid, ${actorKey}, ${input.command_id}, ${await adminDigest(input)}, ${tx.json(errorResult(503, 'admin_command_failed') as unknown as postgres.JSONValue)})
      ON CONFLICT(owner_user_id, actor_key, command_id) DO NOTHING`;
  }
}
