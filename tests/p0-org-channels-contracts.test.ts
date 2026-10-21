import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type OrgChannelAuthorityState,
  buildMultiOrgWhoamiResponse,
  canModifyChannelMembership,
  canReadChannel,
  canReadChannelBoundFile,
  canReadOrg,
  canReadWorkspace,
  cascadeOrgMemberRemoval,
  cascadeWorkspaceMemberRemoval,
  reconcileWorkspaceMove,
  resolveOrgWorkspaceChannelSelector,
  validateChannelVisibilityTransition,
} from '../src/protocol/org-channels-contract.js';

function createFixture(): OrgChannelAuthorityState {
  const now = '2026-10-21T00:00:00Z';
  return {
    privateChannelsEnabled: true,
    organizations: [
      { id: 'org-1', slug: 'yulan', display_name: 'Yulan Ventures', created_by: 'u-owner', created_at: now, updated_at: now },
      { id: 'org-2', slug: 'household', display_name: 'Langridge Household', created_by: 'u-owner', created_at: now, updated_at: now },
    ],
    workspaces: [
      { workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: 'Operations' },
      { workspace_id: 'ws-1b', org_id: 'org-1', slug: 'product', name: 'Product' },
      { workspace_id: 'ws-2a', org_id: 'org-2', slug: 'ops', name: 'Household Ops' },
    ],
    channels: [
      { channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', slug: 'general', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-1a-priv', workspace_id: 'ws-1a', slug: 'sec-incident', visibility: 'private', join_policy: 'invite_only' },
      { channel_id: 'ch-1b-gen', workspace_id: 'ws-1b', slug: 'general', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-2a-gen', workspace_id: 'ws-2a', slug: 'general', visibility: 'workspace', join_policy: 'open' },
    ],
    agentIdentities: [
      { id: 'ag-1', owner_user_id: 'u-owner', standing_grant_id: 'hg-1', standing_renewal_grant_id: 'rg-1', display_name: 'Argon Lead', created_at: now },
      { id: 'ag-inherited', owner_user_id: 'u-owner', display_name: 'Inherited Helper', created_at: now },
    ],
    hostedGrants: [
      { grant_id: 'hg-1', state: 'active', revoked_at: null },
    ],
    renewalGrants: [
      { renewal_grant_id: 'rg-1', horizon_expires_at: '2099-01-01T00:00:00Z', revoked_at: null },
    ],
    orgMemberships: [
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', created_at: now },
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now },
      { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-1', role: 'admin', created_at: now },
      { org_id: 'org-2', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', created_at: now },
    ],
    workspaceGrants: [
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { workspace_id: 'ws-1b', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { workspace_id: 'ws-2a', org_id: 'org-2', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', created_at: now },
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-1', role: 'admin', created_at: now },
      { workspace_id: 'ws-1b', org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', created_at: now },
      { workspace_id: 'ws-2a', org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', created_at: now },
    ],
    agentPrincipals: [
      { principal_id: 'ap-1a', workspace_id: 'ws-1a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' },
      { principal_id: 'ap-1b', workspace_id: 'ws-1b', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' },
      { principal_id: 'ap-2a', workspace_id: 'ws-2a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' },
    ],
    channelMemberships: [
      { channel_id: 'ch-1a-priv', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', notify_pref: 'all', joined_at: now },
      { channel_id: 'ch-1a-priv', workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', notify_pref: 'all', joined_at: now },
    ],
    fileChannelBindings: [
      { file_id: 'file-priv-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-priv', bound_by_kind: 'user', created_at: now },
      { file_id: 'file-dual-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-gen', bound_by_kind: 'user', created_at: now },
      { file_id: 'file-dual-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-priv', bound_by_kind: 'user', created_at: now },
    ],
    connectionPolicies: [
      { connection_id: 'conn-1', owner_user_id: 'u-owner', agent_identity_id: 'ag-1', default_org_id: 'org-1', default_workspace_id: 'ws-1a' },
    ],
    seats: [
      { seat_id: 'seat-1a', workspace_id: 'ws-1a', principal_id: 'ap-1a', agent_identity_id: 'ag-1' },
      { seat_id: 'seat-2a', workspace_id: 'ws-2a', principal_id: 'ap-2a', agent_identity_id: 'ag-1' },
    ],
    seatHandles: [
      { handle_id: 'h-1a', seat_id: 'seat-1a', workspace_id: 'ws-1a' },
      { handle_id: 'h-2a', seat_id: 'seat-2a', workspace_id: 'ws-2a' },
    ],
  };
}

test('multi-org agent identity whoami pre-seat, post-seat, and standing credential revocation', () => {
  const s = createFixture();
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-1', connection_id: 'conn-1' };
  const preSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1' });
  assert.equal(preSeat.active_seat, null);
  assert.equal(preSeat.organizations.length, 2);
  assert.equal(preSeat.organizations[0]?.role, 'admin');
  assert.equal(preSeat.organizations[1]?.role, 'member');

  const postSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1', seat_id: 'seat-2a' });
  assert.equal(postSeat.active_seat?.workspace_id, 'ws-2a');
  assert.equal(postSeat.active_seat?.org_slug, 'household');

  // Revoking standing hosted grant revokes canReadOrg
  s.hostedGrants![0]!.state = 'revoked';
  s.hostedGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  assert.equal(canReadOrg(s, caller, 'org-1'), false);
  s.hostedGrants![0]!.state = 'active';
  s.hostedGrants![0]!.revoked_at = null;
  assert.equal(canReadOrg(s, caller, 'org-1'), true);

  // Revoking standing renewal grant revokes canReadOrg
  s.renewalGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  assert.equal(canReadOrg(s, caller, 'org-1'), false);
});

test('universal selector precedence, explicit org with connection default, and revoked default fallback', () => {
  const s = createFixture();
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-1', connection_id: 'conn-1' };

  // Bare workspace="ops" matches both yulan/ops and household/ops -> AMBIGUOUS_WORKSPACE_SELECTOR
  const ambig = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'ops' });
  assert.equal(ambig.ok, false);
  if (!ambig.ok) {
    assert.equal(ambig.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    assert.equal(ambig.refusal.choices?.length, 2);
  }

  // Explicit org="yulan" without workspace uses connection default_workspace_id (ws-1a)
  const explicitOrg = resolveOrgWorkspaceChannelSelector(s, caller, { org: 'yulan' });
  assert.equal(explicitOrg.ok, true);
  if (explicitOrg.ok) {
    assert.equal(explicitOrg.workspace.workspace_id, 'ws-1a');
  }

  // Qualified yulan/ops succeeds
  const explicit = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'yulan/ops' });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.workspace.workspace_id, 'ws-1a');
    assert.equal(explicit.channel?.slug, 'general');
    assert.equal(explicit.source, 'explicit');
  }

  // Seat mismatch fails closed with WORKSPACE_SEAT_MISMATCH
  const mismatch = resolveOrgWorkspaceChannelSelector(s, caller, {
    workspace: 'household/ops',
    seat_id: 'seat-1a',
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.refusal.code, 'WORKSPACE_SEAT_MISMATCH');

  // Connection default fallback when no explicit or seat selector is given
  const fromDefault = resolveOrgWorkspaceChannelSelector(s, caller, {});
  assert.equal(fromDefault.ok, true);
  if (fromDefault.ok) {
    assert.equal(fromDefault.workspace.workspace_id, 'ws-1a');
    assert.equal(fromDefault.source, 'connection_default');
  }

  // When default_workspace_id (ws-1a) is revoked, falls back to remaining workspace (ws-1b) in default_org_id
  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  const fallbackToOrg = resolveOrgWorkspaceChannelSelector(s, caller, {});
  assert.equal(fallbackToOrg.ok, true);
  if (fallbackToOrg.ok) {
    assert.equal(fallbackToOrg.workspace.workspace_id, 'ws-1b');
    assert.equal(fallbackToOrg.source, 'connection_default');
  }
});

test('explicit org/workspace revocation overrides owner inheritance (including tombstone creation) and cascades seats', () => {
  const s = createFixture();
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-1', connection_id: 'conn-1' };
  const inheritedCaller = { principal_kind: 'agent' as const, principal_id: 'ag-inherited' };

  // Inherited agent has no explicit orgMemberships or workspaceGrants rows, yet can read via u-owner
  assert.equal(canReadWorkspace(s, inheritedCaller, 'ws-1a'), true);
  cascadeWorkspaceMemberRemoval(s, {
    workspace_id: 'ws-1a',
    principal_kind: 'agent',
    principal_id: 'ag-inherited',
  });
  assert.equal(canReadWorkspace(s, inheritedCaller, 'ws-1a'), false);
  assert.equal(canReadOrg(s, inheritedCaller, 'org-1'), true);
  cascadeOrgMemberRemoval(s, {
    org_id: 'org-1',
    principal_kind: 'agent',
    principal_id: 'ag-inherited',
  });
  assert.equal(canReadOrg(s, inheritedCaller, 'org-1'), false);

  const resWs = cascadeWorkspaceMemberRemoval(s, {
    workspace_id: 'ws-1a',
    principal_kind: 'agent',
    principal_id: 'ag-1',
  });
  assert.deepEqual(resWs.closed_seat_ids, ['seat-1a']);
  assert.equal(canReadWorkspace(s, caller, 'ws-1a'), false);
  assert.equal(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
  assert.equal(canReadWorkspace(s, caller, 'ws-2a'), true);

  const resOrg = cascadeOrgMemberRemoval(s, {
    org_id: 'org-2',
    principal_kind: 'agent',
    principal_id: 'ag-1',
  });
  assert.deepEqual(resOrg.closed_seat_ids, ['seat-2a']);
  assert.equal(canReadOrg(s, caller, 'org-2'), false);
});

test('guest channel isolation, every-channel file bindings, and fail-closed privateChannelsEnabled default', () => {
  const s = createFixture();
  const now = '2026-10-21T00:00:00Z';
  const guest = { principal_kind: 'user' as const, principal_id: 'u-guest' };
  const admin = { principal_kind: 'user' as const, principal_id: 'u-admin' };
  const owner = { principal_kind: 'user' as const, principal_id: 'u-owner' };

  // Guest without workspace grant -> denied workspace
  assert.equal(canReadOrg(s, guest, 'org-1'), true);
  assert.equal(canReadWorkspace(s, guest, 'ws-1a'), false);

  // Guest WITH workspace grant can read workspace, but is isolated from workspace-visible channel until added to channelMemberships
  s.workspaceGrants.push({ workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now });
  assert.equal(canReadWorkspace(s, guest, 'ws-1a'), true);
  assert.equal(canReadChannel(s, guest, 'ch-1a-gen'), false);
  s.channelMemberships.push({ channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-guest', role: 'member', notify_pref: 'all', joined_at: now });
  assert.equal(canReadChannel(s, guest, 'ch-1a-gen'), true);

  // Workspace admin who is not a member of ch-1a-priv cannot read private channel or dual-bound file
  assert.equal(canReadChannel(s, admin, 'ch-1a-priv'), false);
  assert.equal(canReadChannelBoundFile(s, admin, 'file-priv-1', 'ws-1a'), false);
  assert.equal(canReadChannelBoundFile(s, admin, 'file-dual-1', 'ws-1a'), false);
  const selfJoin = canModifyChannelMembership(s, admin, 'ch-1a-priv', admin);
  assert.equal(selfJoin.ok, false);
  if (!selfJoin.ok) assert.equal(selfJoin.refusal.code, 'PRIVATE_CHANNEL_INVITE_REQUIRED');

  // Channel owner can read both channels and dual-bound file
  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), true);
  assert.equal(canReadChannelBoundFile(s, owner, 'file-dual-1', 'ws-1a'), true);

  // Omitting privateChannelsEnabled (undefined) fails CLOSED on private channels
  delete s.privateChannelsEnabled;
  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), false);
  assert.equal(canModifyChannelMembership(s, owner, 'ch-1a-priv', admin).ok, false);
  const defaultTrans = validateChannelVisibilityTransition({
    nextVisibility: 'private',
    nextJoinPolicy: 'invite_only',
  });
  assert.equal(defaultTrans.ok, false);
  if (!defaultTrans.ok) assert.equal(defaultTrans.refusal.code, 'PRIVATE_CHANNELS_DISABLED');

  // Visibility transitions with privateChannelsEnabled=true: non-empty public -> private blocked; private -> public blocked
  const pubToPriv = validateChannelVisibilityTransition({
    privateChannelsEnabled: true,
    currentVisibility: 'workspace',
    nextVisibility: 'private',
    nextJoinPolicy: 'invite_only',
    signalCount: 3,
  });
  assert.equal(pubToPriv.ok, false);
  if (!pubToPriv.ok) assert.equal(pubToPriv.refusal.code, 'CHANNEL_HAS_PUBLIC_HISTORY');

  const privToPub = validateChannelVisibilityTransition({
    privateChannelsEnabled: true,
    currentVisibility: 'private',
    nextVisibility: 'workspace',
    nextJoinPolicy: 'open',
  });
  assert.equal(privToPub.ok, false);
  if (!privToPub.ok) assert.equal(privToPub.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
});

test('workspace move enforces dual owner, owners_only revocation, and transfer_members=all revoked-target reconciliation', () => {
  const s1 = createFixture();
  // Non-owner actor refused with ORG_MOVE_REQUIRES_DUAL_OWNER
  const denied = reconcileWorkspaceMove(s1, {
    workspace_id: 'ws-1a',
    target_org_id: 'org-2',
    actor_user_id: 'u-admin',
    transfer_members: 'owners_only',
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.refusal.code, 'ORG_MOVE_REQUIRES_DUAL_OWNER');

  const moved = reconcileWorkspaceMove(s1, {
    workspace_id: 'ws-1a',
    target_org_id: 'org-2',
    actor_user_id: 'u-owner',
    transfer_members: 'owners_only',
  });
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.equal(moved.source_org_id, 'org-1');
    assert.equal(moved.target_org_id, 'org-2');
    assert.deepEqual(moved.closed_seat_ids, ['seat-1a']);
  }

  // Under transfer_members='all', a principal explicitly revoked in target_org_id has their workspace grant & seat revoked
  const s2 = createFixture();
  const ag2 = s2.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1')!;
  ag2.revoked_at = '2026-10-21T00:30:00Z';
  const movedAll = reconcileWorkspaceMove(s2, {
    workspace_id: 'ws-1a',
    target_org_id: 'org-2',
    actor_user_id: 'u-owner',
    transfer_members: 'all',
  });
  assert.equal(movedAll.ok, true);
  if (movedAll.ok) {
    assert.deepEqual(movedAll.closed_seat_ids, ['seat-1a']);
    // u-admin was not in org-2 at all -> transferred as active admin in org-2
    assert.equal(canReadWorkspace(s2, { principal_kind: 'user', principal_id: 'u-admin' }, 'ws-1a'), true);
    // ag-1 was explicitly revoked in org-2 -> remains denied in ws-1a with no duplicate orgMemberships row
    assert.equal(canReadWorkspace(s2, { principal_kind: 'agent', principal_id: 'ag-1' }, 'ws-1a'), false);
    assert.equal(
      s2.orgMemberships.filter((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1').length,
      1,
    );
  }
});
