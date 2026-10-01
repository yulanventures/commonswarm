import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS, ADMIN_SCOPE_NAMES,
  adminManifestValid, decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount,
  type AdminActor, type AdminCommand,
} from '../src/protocol/index.js';
import { adminCoreFixture, adminManifest } from './support/admin-fixture.js';

const activate = (f: ReturnType<typeof adminCoreFixture>) => f.run({ kind: 'grant_admin_delegation', grant_id: f.grantId, consent_receipt_id: f.receipt, replaces_grant_id: null });
test('human consent is session-bound, single-use, finite, and cannot be supplied by workers or admins', () => {
  const f = adminCoreFixture();
  assert.equal(f.prepare.ok, true);
  const command: AdminCommand = { kind: 'grant_admin_delegation', grant_id: f.grantId, consent_receipt_id: f.receipt, replaces_grant_id: null };
  for (const actor of [
    { kind: 'worker' }, { kind: 'hosted_seat' },
    { kind: 'human', user_id: f.owner, session_binding: 'wrong_session' },
    { kind: 'delegated_admin', grant_id: f.grantId, admin_identity_id: f.manifest.admin_identity_id, connection_id: f.manifest.connection_id, scope_names: ['admin:read'], resource: ADMIN_RESOURCE, access_expires_at: f.now + 300000 },
  ] as AdminActor[]) {
    const decision = decideAdminAuthority(command, f.state(), { ...f.ctx, actor });
    assert.equal(decision.ok, false);
    assert.deepEqual(decision.events.map(e => e.type), ['AdminActionRecorded']);
  }
  const accepted = activate(f);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.events.map(e => e.type), ['AdminDelegationGranted', 'AdminActionRecorded']);
  assert.equal(Object.hasOwn(accepted.events[0]!, 'workspace_id'), false);
  assert.equal(accepted.events[0]?.admin_identity_id, f.manifest.admin_identity_id);
  assert.equal(activate(f).reason, 'consent_invalid');
  const m = adminManifest(f.now);
  assert.equal(adminManifestValid(m, f.now), true);
  for (const mutation of [
    { expires_at: f.now }, { expires_at: f.now + 2592000001, refresh_deadline: f.now + 2592000001 },
    { issuance_limits: { ...m.issuance_limits, invitations: 11 } },
    { renewal_limits: { ...m.renewal_limits, successors_per_worker: 801 } },
    { worker_scope_ceiling: ['mint_agent_token'] }, { scope_names: ['admin:*'] }, { unexpected: true },
  ]) assert.equal(adminManifestValid({ ...m, ...mutation }, f.now), false);
});

test('full-account consent pins every scope and requires explicit human selection', () => {
  const f = adminCoreFixture();
  const manifest = { ...f.manifest, mode: 'full_account' as const, workspace_selector: 'owned_and_selected' as const, scope_names: [...ADMIN_SCOPE_NAMES] };
  const consent = { consent_receipt_id: randomUUID(), owner_user_id: f.owner, session_binding: f.session,
    manifest, manifest_digest: 'd'.repeat(64), full_account_selected: false, expires_at: f.now + 300000, consumed_at: null };
  assert.equal(f.run({ kind: 'prepare_admin_consent', consent }).reason, 'consent_invalid');
  assert.equal(f.run({ kind: 'prepare_admin_consent', consent: { ...consent, full_account_selected: true } }).ok, true);
  assert.equal(f.run({ kind: 'grant_admin_delegation', grant_id: f.grantId, consent_receipt_id: consent.consent_receipt_id, replaces_grant_id: null }).ok, true);
  assert.equal(adminManifestValid({ ...manifest, scope_names: ['admin:read'] }, f.now), false);
});

test('refresh preserves deadlines, attenuates scopes, and replay terminally revokes the lineage', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  const lineage = randomUUID();
  f.ctx.actor = { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: f.manifest.client_id, resource: ADMIN_RESOURCE };
  assert.equal(f.run({ kind: 'issue_admin_credential', grant_id: f.grantId, credential_lineage_id: lineage }).ok, true);
  assert.equal(f.state().lineages[lineage]?.access_expires_at, f.now + ADMIN_ACCESS_TTL_SECONDS * 1000);
  f.ctx.now += 200000;
  f.ctx.presenting_refresh_generation = 0;
  f.ctx.presenting_refresh_lineage_id = lineage;
  const rotate: AdminCommand = { kind: 'rotate_admin_credential', grant_id: f.grantId, credential_lineage_id: lineage, generation: 0, scope_names: ['admin:read'] };
  assert.equal(f.run({ ...rotate, scope_names: ['admin:read', 'seats:create'] }).reason, 'scope_expansion_forbidden');
  assert.equal(f.run(rotate).ok, true);
  assert.equal(f.state().lineages[lineage]?.generation, 1);
  assert.equal(f.state().lineages[lineage]?.refresh_deadline, f.manifest.refresh_deadline);
  const replay = f.run(rotate);
  assert.equal(replay.reason, 'refresh_replay');
  assert.deepEqual(replay.events.map(e => e.type), ['AdminCredentialReplayDetected', 'AdminDelegationRevoked', 'AdminActionRecorded']);
  assert.equal(f.state().grants[f.grantId]?.state, 'revoked');
  assert.equal(f.state().lineages[lineage]?.state, 'revoked');
  assert.equal(f.run(rotate).reason, 'grant_inactive');
});

test('grant reads reject credential/resource/workspace substitution, expiry and revoked permission', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  const admin: AdminActor = { kind: 'delegated_admin', admin_identity_id: f.manifest.admin_identity_id,
    grant_id: f.grantId, connection_id: f.manifest.connection_id, resource: ADMIN_RESOURCE,
    scope_names: ['admin:read'], access_expires_at: f.now + 300000 };
  const read: AdminCommand = { kind: 'admin_read_metadata', grant_id: f.grantId, resource_kind: 'grant', workspace_id: null };
  for (const actor of [{ ...admin, resource: 'https://mcp.commonswarm.com/mcp' }, { ...admin, connection_id: randomUUID() }, { ...admin, grant_id: randomUUID() }, { ...admin, access_expires_at: f.now }]) {
    assert.equal(decideAdminAuthority(read, f.state(), { ...f.ctx, actor }).ok, false);
  }
  f.ctx.actor = admin;
  assert.equal(f.run(read).ok, true);
  assert.equal(f.run({ ...read, workspace_id: randomUUID() }).reason, 'workspace_forbidden');
  f.ctx.actor = { kind: 'human', user_id: f.owner, session_binding: f.session };
  assert.equal(f.run({ kind: 'revoke_admin_delegation', grant_id: f.grantId, reason_code: 'human_revoked' }).ok, true);
  f.ctx.actor = admin;
  assert.equal(f.run(read).reason, 'grant_inactive');
});

test('surrender is exact-grant and suspension cannot be refreshed or restored', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  assert.equal(f.run({ kind: 'suspend_admin_delegation', grant_id: f.grantId, reason_code: 'security_review' }).ok, true);
  f.ctx.actor = { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: f.manifest.client_id, resource: ADMIN_RESOURCE };
  assert.equal(f.run({ kind: 'issue_admin_credential', grant_id: f.grantId, credential_lineage_id: randomUUID() }).reason, 'grant_inactive');
  f.ctx.actor = { kind: 'delegated_admin', grant_id: randomUUID(), admin_identity_id: f.manifest.admin_identity_id, connection_id: f.manifest.connection_id, resource: ADMIN_RESOURCE, scope_names: ['admin:read'], access_expires_at: f.now + 300000 };
  assert.equal(f.run({ kind: 'surrender_admin_delegation', grant_id: f.grantId, reason_code: 'surrendered' }).reason, 'grant_binding_mismatch');
  f.ctx.actor = { kind: 'human', user_id: f.owner, session_binding: f.session };
  assert.equal(f.run({ kind: 'revoke_admin_delegation', grant_id: f.grantId, reason_code: 'human_revoked' }).ok, true);
  assert.equal(f.state().grants[f.grantId]?.state, 'revoked');
});

test('account events rebuild grants and lineages without secrets or worker attribution', () => {
  const f = adminCoreFixture();
  const events = [...f.prepare.events, ...activate(f).events];
  f.ctx.actor = { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: f.manifest.client_id, resource: ADMIN_RESOURCE };
  events.push(...f.run({ kind: 'issue_admin_credential', grant_id: f.grantId, credential_lineage_id: randomUUID() }).events);
  const rebuilt = events.reduce(reduceAdminAuthority, emptyAdminAccount());
  assert.deepEqual(rebuilt.grants, f.state().grants);
  assert.deepEqual(rebuilt.lineages, f.state().lineages);
  assert.equal(events.every(e => e.stream_kind === 'account' && e.actor_agent_principal === null), true);
  assert.equal(JSON.stringify(events).includes(f.session), false);
  assert.equal(JSON.stringify(events).includes('token_hash'), false);
});

test('human narrowing removes permission and cannot expand a grant or reset its deadline', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  const manifest = { ...f.manifest, expires_at: f.now + 60000, issuance_limits: { ...f.manifest.issuance_limits, worker_credentials: 0 } };
  const receipt = randomUUID();
  assert.equal(f.run({ kind: 'prepare_admin_consent', consent: { consent_receipt_id: receipt, owner_user_id: f.owner,
    session_binding: f.session, manifest, manifest_digest: 'd'.repeat(64), full_account_selected: false, expires_at: f.now + 300000, consumed_at: null } }).ok, true);
  const narrow: AdminCommand = { kind: 'narrow_admin_delegation', grant_id: f.grantId, manifest, manifest_digest: 'd'.repeat(64), consent_receipt_id: receipt };
  assert.equal(f.run({ ...narrow, manifest: { ...manifest, scope_names: ['admin:read', 'seats:create'] } }).reason, 'scope_expansion_forbidden');
  assert.equal(f.run(narrow).ok, true);
  assert.equal(f.state().grants[f.grantId]?.expires_at, f.now + 60000);
  assert.equal(f.state().grants[f.grantId]?.issuance_limits.worker_credentials, 0);
  assert.equal(f.run(narrow).reason, 'scope_expansion_forbidden');
});

test('replacement revokes the prior grant atomically and expiry applies before its lazy event', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  const receipt = randomUUID();
  assert.equal(f.run({ kind: 'prepare_admin_consent', consent: { consent_receipt_id: receipt,
    owner_user_id: f.owner, session_binding: f.session, manifest: f.manifest, manifest_digest: 'e'.repeat(64),
    full_account_selected: false, expires_at: f.now + 300000, consumed_at: null } }).ok, true);
  const replacement = randomUUID();
  assert.equal(f.run({ kind: 'grant_admin_delegation', grant_id: replacement, consent_receipt_id: receipt, replaces_grant_id: null }).reason, 'replacement_required');
  const accepted = f.run({ kind: 'grant_admin_delegation', grant_id: replacement, consent_receipt_id: receipt, replaces_grant_id: f.grantId });
  assert.deepEqual(accepted.events.map(e => e.type), ['AdminDelegationRevoked', 'AdminDelegationGranted', 'AdminActionRecorded']);
  assert.equal(f.state().grants[f.grantId]?.state, 'revoked');
  f.ctx.now = f.manifest.expires_at;
  f.ctx.actor = { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: f.manifest.client_id, resource: ADMIN_RESOURCE };
  assert.equal(f.run({ kind: 'issue_admin_credential', grant_id: replacement, credential_lineage_id: randomUUID() }).reason, 'grant_inactive');
  f.ctx.actor = { kind: 'system' };
  assert.equal(f.run({ kind: 'expire_admin_delegation', grant_id: replacement }).ok, true);
  assert.equal(f.state().grants[replacement]?.state, 'expired');
  f.ctx.actor = { kind: 'human', user_id: f.owner, session_binding: f.session };
  assert.equal(f.run({ kind: 'admin_read_metadata', grant_id: replacement, resource_kind: 'grant', workspace_id: null }).ok, true);
});

test('pure decisions charge refused attempts, enforce finite read allowance, and preserve exact surrender', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  f.ctx.actor = { kind: 'delegated_admin', grant_id: f.grantId, admin_identity_id: f.manifest.admin_identity_id,
    connection_id: f.manifest.connection_id, resource: ADMIN_RESOURCE, scope_names: ['admin:read'], access_expires_at: f.now + 300000 };
  const read: AdminCommand = { kind: 'admin_read_metadata', grant_id: f.grantId, resource_kind: 'grant', workspace_id: null };
  assert.equal(f.run({ ...read, workspace_id: randomUUID() }).reason, 'workspace_forbidden');
  for (let i = 1; i < 120; i++) assert.equal(f.run(read).ok, true);
  const limited = f.run(read);
  assert.equal(limited.reason, 'rate_limited');
  assert.deepEqual(limited.events.map(e => e.type), ['AdminActionRecorded']);
  assert.equal(f.run({ kind: 'surrender_admin_delegation', grant_id: f.grantId, reason_code: 'surrendered' }).ok, true);
  assert.equal(f.state().grants[f.grantId]?.state, 'revoked');
});

test('credential scope widening is refused and replay revokes even after underlying rights loss', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  f.ctx.actor = { kind: 'delegated_admin', grant_id: f.grantId, admin_identity_id: f.manifest.admin_identity_id,
    connection_id: f.manifest.connection_id, resource: ADMIN_RESOURCE, scope_names: ['admin:read', 'seats:create'], access_expires_at: f.now + 300000 };
  assert.equal(f.run({ kind: 'admin_read_metadata', grant_id: f.grantId, resource_kind: 'grant', workspace_id: null }).reason, 'scope_expansion_forbidden');
  const lineage = randomUUID();
  f.ctx.actor = { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: f.manifest.client_id, resource: ADMIN_RESOURCE };
  assert.equal(f.run({ kind: 'issue_admin_credential', grant_id: f.grantId, credential_lineage_id: lineage }).ok, true);
  f.ctx.presenting_refresh_generation = 0;
  f.ctx.presenting_refresh_lineage_id = lineage;
  const rotate: AdminCommand = { kind: 'rotate_admin_credential', grant_id: f.grantId, credential_lineage_id: lineage, generation: 0, scope_names: ['admin:read'] };
  assert.equal(f.run(rotate).ok, true);
  f.ctx.current_workspace_rights = false;
  assert.equal(f.run(rotate).reason, 'refresh_replay');
  assert.equal(f.state().grants[f.grantId]?.state, 'revoked');
});

test('workspace withdrawal requires both current ownership and grant coverage', () => {
  const workspaceId = randomUUID();
  const f = adminCoreFixture([workspaceId]);
  assert.equal(activate(f).ok, true);
  f.ctx.withdrawing_workspace_owner = true;
  const withdrawal: AdminCommand = { kind: 'withdraw_admin_workspace_access', grant_id: f.grantId, workspace_id: randomUUID(), reason_code: 'withdrawn' };
  assert.equal(f.run(withdrawal).reason, 'workspace_forbidden');
  assert.deepEqual(f.state().grants[f.grantId]?.withdrawn_workspace_ids, []);
  assert.equal(f.run({ ...withdrawal, workspace_id: workspaceId }).ok, true);
  assert.deepEqual(f.state().grants[f.grantId]?.withdrawn_workspace_ids, [workspaceId]);
});
