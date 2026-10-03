import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as policy from '../../src/protocol/index.js';

/** Real consent/authority decisions; no fabricated grant or receipt state. */
export function adminCoreFixture(workspaceIds: string[] = [], mode: 'granular' | 'full_account' = 'granular', core = policy) {
  const now = 1_800_000_000_000, owner = randomUUID(), grantId = randomUUID(), receipt = randomUUID(), session = 'synthetic-session';
  const scope_names = mode === 'full_account' ? core.adminConsentOptions().filter(o => o.available).map(o => o.scope) : ['admin:read' as const];
  const manifest: policy.AdminManifest = {
    admin_identity_id: randomUUID(), connection_id: randomUUID(), client_id: 'https://client.example.test',
    resource: core.ADMIN_RESOURCE, mode, registry_version: core.ADMIN_REGISTRY_VERSION,
    capability_names: core.adminAvailableCapabilities(scope_names), availability_digest: core.adminAvailabilityDigest(core.ADMIN_REGISTRY_VERSION)!,
    scope_names, workspace_selector: mode === 'granular' ? 'selected' : 'owned_and_selected', workspace_ids: workspaceIds,
    created_workspace_policy: { scope_names: [] },
    target_rules: { seat_ids: [], own_seats: false, grant_created_seats: false, recipient_user_ids: [], recipient_connection_ids: [], transports: [] },
    worker_scope_ceiling: [], role_ceiling: 'member',
    renewal_limits: { ...core.ADMIN_RENEWAL_CEILINGS, grant_kinds: [], principal_ids: [] }, issuance_limits: { ...core.ADMIN_ISSUANCE_CEILINGS },
    expires_at: now + 86400000, refresh_deadline: now + 86400000,
  };
  let seq = 0, state = core.emptyAdminAccount();
  const ctx: policy.AdminDecisionContext = {
    now, owner_user_id: owner, actor: { kind: 'human', user_id: owner, session_binding: session },
    command_id: randomUUID(), stream_id: randomUUID(), request_digest: 'b'.repeat(64), nextSeq: () => ++seq, nextEventId: randomUUID,
    current_workspace_rights: true, withdrawing_workspace_owner: false, target_workspace_owned_by_grantor: false,
    presenting_refresh_generation: null, presenting_refresh_lineage_id: null,
  };
  const run = (command: policy.AdminCommand) => {
    ctx.command_id = randomUUID();
    const decision = core.decideAdminAuthority(command, state, ctx);
    state = decision.events.reduce(core.reduceAdminAuthority, state);
    for (const c of Object.values(state.consents)) c.session_binding = session;
    return decision;
  };
  // Prepare after callers finish choosing fields, so consent is an exact immutable snapshot.
  const prepare = () => run({ kind: 'prepare_admin_consent', consent: {
    consent_receipt_id: receipt, owner_user_id: owner, session_binding: session,
    manifest: structuredClone(manifest), manifest_digest: createHash('sha256').update(core.canonicalAdminJson(manifest)).digest('hex'),
    full_account_selected: mode === 'full_account', expires_at: now + 300000, consumed_at: null,
  } });
  const grant = () => run({ kind: 'grant_admin_delegation', grant_id: grantId, consent_receipt_id: receipt, replaces_grant_id: null });
  return { now, owner, grantId, receipt, manifest, session, ctx, run, prepare, grant, state: () => state };
}
export function routineContext(f: ReturnType<typeof adminCoreFixture>): policy.AdminRoutineContext {
  return { ...f.ctx, actor: { kind: 'delegated_admin', grant_id: f.grantId, admin_identity_id: f.manifest.admin_identity_id,
    connection_id: f.manifest.connection_id, scope_names: f.manifest.scope_names, resource: policy.ADMIN_RESOURCE, access_expires_at: f.now + 300000 },
    workspace: null, workspace_stream_id: randomUUID(), workspace_seq: 0, owned_workspaces: 0, workspace_creations_last_day: 0,
    invitations_last_day: 0, live_principals: 0, live_members_and_invitations: 0, live_agent_invitations_person: 0,
    live_agent_invitations_workspace: 0, human_worker_scopes: [], recipient_exists: false, recipient_is_member: false,
    delivery_connection_id: null, target_credential: null, principal_lineage_ids: [], nextResourceId: randomUUID };
}

test('v2 consent, grant projection and digest retain the exact capability snapshot', () => {
  const f = adminCoreFixture([], 'full_account');
  assert.equal(f.prepare().ok, true);
  const decision = f.grant();
  assert.equal(decision.ok, true);
  const granted = f.state().grants[f.grantId]!;
  assert.deepEqual(policy.adminGrantManifest(granted), f.manifest);
  const digest = createHash('sha256').update(policy.canonicalAdminJson(f.manifest)).digest('hex');
  assert.equal(granted.manifest_digest, digest);
  for (const mutation of [{ capability_names: [] }, { availability_digest: '0'.repeat(64) }, { registry_version: 1 }]) {
    assert.notEqual(createHash('sha256').update(policy.canonicalAdminJson({ ...f.manifest, ...mutation })).digest('hex'), digest);
    assert.equal(policy.adminManifestValid({ ...f.manifest, ...mutation }, f.now), false);
  }
});
