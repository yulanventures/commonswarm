import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS, ADMIN_SCOPE_NAMES,
  adminManifestValid, decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount, adminAccountWithDurableGrants,
  adminConsentOptions, adminAvailableCapabilities,
  type AdminActor, type AdminCommand, type AdminManifest,
} from '../src/protocol/index.js';
import { adminCoreFixture, adminManifest, adminManifestDigest } from './support/admin-fixture.js';

const activate = (f: ReturnType<typeof adminCoreFixture>) => f.run({ kind: 'grant_admin_delegation', grant_id: f.grantId, consent_receipt_id: f.receipt, replaces_grant_id: null });

test('durable policy fences reduce the cached grant and its dependents while independent grants remain usable', () => {
  const f = adminCoreFixture();
  assert.equal(activate(f).ok, true);
  const state = f.state(), grant = state.grants[f.grantId]!;
  const independentId = randomUUID(), lineageId = randomUUID(), attemptId = randomUUID();
  state.grants[independentId] = { ...grant, grant_id: independentId, connection_id: randomUUID(), admin_identity_id: randomUUID() };
  state.lineages[lineageId] = { credential_lineage_id: lineageId, grant_id: f.grantId, generation: 0,
    scope_names: ['admin:read'], access_expires_at: f.now + 300000, refresh_deadline: grant.refresh_deadline,
    state: 'active', delivery_state: 'awaiting_delivery' };
  state.connections = { [attemptId]: { attempt_id: attemptId, parent_admin_grant_id: f.grantId,
    workspace_id: randomUUID(), intended_owner_user_id: f.owner, intended_agent_id: randomUUID(),
    recipient_connection_id: grant.connection_id, requested_name: 'Pending', transport: 'local', ttl_seconds: 300,
    capability_set: [], state: 'awaiting_authorization', created_at: f.now, expires_at: f.now + 300000,
    cancelled_at: null, reason_code: null } };
  for (const status of ['revoked', 'suspended', 'expired'] as const) {
    const fence = { ...grant, state: status, reason_code: 'issuer_key_denied',
      revoked_at: status === 'revoked' ? f.now + 1000 : null, suspended_at: status === 'suspended' ? f.now + 1000 : null };
    const rows = [fence, state.grants[independentId]!];
    const next = adminAccountWithDurableGrants(state, rows)!;
    assert.ok(next);
    assert.equal(next.grants[f.grantId]!.state, status);
    assert.equal(next.lineages[lineageId]!.state, 'revoked');
    assert.equal(next.connections![attemptId]!.state, 'cancelled');
    assert.equal(next.grants[independentId]!.state, 'active');
    assert.equal(state.grants[f.grantId]!.state, 'active', 'reconciliation does not mutate the stored snapshot');
    assert.equal(decideAdminAuthority({ kind: 'admin_read_metadata', grant_id: independentId, resource_kind: 'grant', workspace_id: null }, next,
      { ...f.ctx, actor: { kind: 'delegated_admin', grant_id: independentId, admin_identity_id: next.grants[independentId]!.admin_identity_id,
        connection_id: next.grants[independentId]!.connection_id, resource: ADMIN_RESOURCE, scope_names: ['admin:read'], access_expires_at: f.now + 300000 } }).ok, true);
    for (const change of [{ manifest_digest: 'changed' }, { expires_at: grant.expires_at + 1000 },
      { refresh_deadline: grant.refresh_deadline + 1000 }]) {
      assert.equal(adminAccountWithDurableGrants(state, [{ ...fence, ...change }, rows[1]!]), null);
    }
    assert.equal(adminAccountWithDurableGrants(next, [grant, rows[1]!]), null, 'durable rows cannot reactivate a projected fence');
    assert.equal(adminAccountWithDurableGrants(state, [fence, fence]), null, 'duplicate rows cannot hide a missing grant');
    assert.equal(adminAccountWithDurableGrants(state, [fence]), null, 'missing grants refuse');
  }
});
test('v1 consent is refused while historical v1 grants retain human recovery, revoke and audit without conversion', () => {
  for (const mode of ['granular', 'full_account'] as const) {
    const f = adminCoreFixture();
    const { capability_names, availability_digest, ...fields } = f.manifest;
    const historical = { ...fields, registry_version: 1, mode,
      scope_names: mode === 'full_account' ? [...ADMIN_SCOPE_NAMES] : fields.scope_names,
      workspace_selector: mode === 'full_account' ? 'owned_and_selected' as const : 'selected' as const };
    const digest = adminManifestDigest(historical);
    const refused = f.run({ kind: 'prepare_admin_consent', consent: {
      consent_receipt_id: randomUUID(), owner_user_id: f.owner, session_binding: f.session,
      manifest: historical as unknown as AdminManifest, manifest_digest: digest,
      full_account_selected: mode === 'full_account', expires_at: f.now + 300000, consumed_at: null,
    } });
    assert.equal(refused.reason, 'consent_invalid');
    assert.deepEqual(refused.events.map(event => event.type), ['AdminActionRecorded']);
    assert.equal(adminManifestValid(historical, f.now, false), false);
    const accepted = activate(f);
    assert.equal(accepted.ok, true); // Fresh v2 consent is the positive control.
    // Replay persisted pre-v2 consent/grant envelopes, never re-consent or infer capabilities.
    const oldEvents = [...f.prepare.events, ...accepted.events].map(event => {
      const payload = event.type === 'AdminConsentPrepared' ? { ...event.payload, manifest: historical,
        manifest_digest: digest, full_account_selected: mode === 'full_account' }
        : event.type === 'AdminDelegationGranted' ? { ...event.payload, ...historical, manifest_digest: digest }
        : event.payload;
      if (event.type === 'AdminDelegationGranted') {
        delete payload.capability_names;
        delete payload.availability_digest;
      }
      return { ...event, payload, grant_manifest_digest: event.grant_id ? digest : null };
    });
    const oldState = oldEvents.reduce(reduceAdminAuthority, emptyAdminAccount());
    const actor: AdminActor = { kind: 'delegated_admin', grant_id: f.grantId,
      admin_identity_id: f.manifest.admin_identity_id, connection_id: f.manifest.connection_id,
      resource: ADMIN_RESOURCE, scope_names: ['admin:read'], access_expires_at: f.now + 300000 };
    const read: AdminCommand = { kind: 'admin_read_metadata', grant_id: f.grantId, resource_kind: 'grant', workspace_id: null };
    assert.equal(decideAdminAuthority(read, oldState, { ...f.ctx, actor }).reason, 'scope_expansion_forbidden');
    assert.equal(decideAdminAuthority(read, f.state(), { ...f.ctx, actor }).ok, true);
    for (const status of ['active', 'suspended', 'revoked', 'expired'] as const) {
      let state = structuredClone(oldState);
      const ctx = { ...f.ctx, now: status === 'expired' ? f.manifest.expires_at : f.now, current_workspace_rights: false };
      if (status !== 'active') {
        const terminal: AdminCommand = status === 'expired' ? { kind: 'expire_admin_delegation', grant_id: f.grantId }
          : { kind: status === 'suspended' ? 'suspend_admin_delegation' : 'revoke_admin_delegation', grant_id: f.grantId, reason_code: 'human_fenced' };
        const decision = decideAdminAuthority(terminal, state, status === 'expired'
          ? { ...ctx, now: f.manifest.expires_at, actor: { kind: 'system' } } : ctx);
        assert.equal(decision.ok, true);
        state = decision.events.reduce(reduceAdminAuthority, state);
      }
      assert.equal(state.grants[f.grantId]?.state, status);
      assert.equal(decideAdminAuthority(read, state, { ...ctx, actor: { kind: 'human', user_id: randomUUID(), session_binding: f.session } }).ok, false);
      assert.equal(decideAdminAuthority({ kind: 'revoke_admin_delegation', grant_id: f.grantId, reason_code: 'human_revoked' }, state,
        { ...ctx, actor: { kind: 'human', user_id: randomUUID(), session_binding: f.session } }).reason, 'human_confirmation_required');
      const recovered = decideAdminAuthority(read, state, ctx);
      assert.equal(recovered.ok, true);
      assert.deepEqual(recovered.events.map(event => event.type), ['AdminMetadataRead', 'AdminActionRecorded']);
      assert.equal(recovered.events[1]?.grant_manifest_digest, digest);
      const revoked = decideAdminAuthority({ kind: 'revoke_admin_delegation', grant_id: f.grantId, reason_code: 'human_revoked' }, state, ctx);
      assert.equal(revoked.ok, true);
      assert.deepEqual(revoked.events.map(event => event.type), status === 'revoked' || status === 'expired'
        ? ['AdminActionRecorded'] : ['AdminDelegationRevoked', 'AdminActionRecorded']);
      state = revoked.events.reduce(reduceAdminAuthority, state);
      assert.equal(state.grants[f.grantId]?.manifest_digest, digest);
      assert.equal(state.grants[f.grantId]?.registry_version, 1);
      assert.equal(Object.hasOwn(state.grants[f.grantId]!, 'capability_names'), false);
      assert.equal(Object.hasOwn(state.grants[f.grantId]!, 'availability_digest'), false);
      assert.equal(state.consents[f.receipt]?.manifest_digest, digest);
    }
  }
});

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

test('full-account consent refuses unavailable scopes, pins all available capabilities and requires explicit human selection', () => {
  const f = adminCoreFixture();
  const scope_names = adminConsentOptions().filter(option => option.available).map(option => option.scope);
  const manifest = { ...f.manifest, mode: 'full_account' as const, workspace_selector: 'owned_and_selected' as const,
    scope_names, capability_names: adminAvailableCapabilities(scope_names) };
  const consent = { consent_receipt_id: randomUUID(), owner_user_id: f.owner, session_binding: f.session,
    manifest, manifest_digest: adminManifestDigest(manifest), full_account_selected: false, expires_at: f.now + 300000, consumed_at: null };
  const unavailable = { ...manifest, scope_names: [...ADMIN_SCOPE_NAMES] };
  assert.equal(f.run({ kind: 'prepare_admin_consent', consent: { ...consent, manifest: unavailable,
    manifest_digest: adminManifestDigest(unavailable), full_account_selected: true } }).reason, 'consent_invalid');
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
    session_binding: f.session, manifest, manifest_digest: adminManifestDigest(manifest), full_account_selected: false, expires_at: f.now + 300000, consumed_at: null } }).ok, true);
  const narrow: AdminCommand = { kind: 'narrow_admin_delegation', grant_id: f.grantId, manifest, manifest_digest: adminManifestDigest(manifest), consent_receipt_id: receipt };
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
    owner_user_id: f.owner, session_binding: f.session, manifest: f.manifest, manifest_digest: adminManifestDigest(f.manifest),
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
