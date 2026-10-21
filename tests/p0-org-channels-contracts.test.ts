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
      { id: 'ag-1', owner_user_id: 'u-owner', display_name: 'Argon Lead', created_at: now },
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

test('multi-org agent identity whoami pre-seat and post-seat with per-org roles', () => {
  const s = createFixture();
  const preSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1' });
  assert.equal(preSeat.active_seat, null);
  assert.equal(preSeat.organizations.length, 2);
  assert.equal(preSeat.organizations[0]?.role, 'admin');
  assert.equal(preSeat.organizations[1]?.role, 'member');

  const postSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1', seat_id: 'seat-2a' });
  assert.equal(postSeat.active_seat?.workspace_id, 'ws-2a');
  assert.equal(postSeat.active_seat?.org_slug, 'household');
});

test('universal selector precedence, ambiguous workspace choices, and seat mismatch refusal', () => {
  const s = createFixture();
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-1', connection_id: 'conn-1' };

  // Bare workspace="ops" matches both yulan/ops and household/ops -> AMBIGUOUS_WORKSPACE_SELECTOR
  const ambig = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'ops' });
  assert.equal(ambig.ok, false);
  if (!ambig.ok) {
    assert.equal(ambig.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    assert.equal(ambig.refusal.choices?.length, 2);
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
  if (!mismatch.ok) {
    assert.equal(mismatch.refusal.code, 'WORKSPACE_SEAT_MISMATCH');
  }

  // Connection default fallback when no explicit or seat selector is given
  const fromDefault = resolveOrgWorkspaceChannelSelector(s, caller, {});
  assert.equal(fromDefault.ok, true);
  if (fromDefault.ok) {
    assert.equal(fromDefault.workspace.workspace_id, 'ws-1a');
    assert.equal(fromDefault.source, 'connection_default');
  }
});

test('explicit org/workspace revocation overrides owner inheritance and cascades seats', () => {
  const s = createFixture();
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-1', connection_id: 'conn-1' };

  const resWs = cascadeWorkspaceMemberRemoval(s, {
    workspace_id: 'ws-1a',
    principal_kind: 'agent',
    principal_id: 'ag-1',
  });
  assert.deepEqual(resWs.closed_seat_ids, ['seat-1a']);
  assert.equal(canReadWorkspace(s, caller, 'ws-1a'), false);
  // Seat in ws-2a remains untouched
  assert.equal(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
  assert.equal(canReadWorkspace(s, caller, 'ws-2a'), true);

  // Removing from org-2 closes ws-2a seat
  const resOrg = cascadeOrgMemberRemoval(s, {
    org_id: 'org-2',
    principal_kind: 'agent',
    principal_id: 'ag-1',
  });
  assert.deepEqual(resOrg.closed_seat_ids, ['seat-2a']);
  assert.equal(canReadOrg(s, caller, 'org-2'), false);
});

test('guest isolation and private channel non-member owner/admin exclusion + flag gate', () => {
  const s = createFixture();
  const guest = { principal_kind: 'user' as const, principal_id: 'u-guest' };
  const admin = { principal_kind: 'user' as const, principal_id: 'u-admin' };
  const owner = { principal_kind: 'user' as const, principal_id: 'u-owner' };

  // Guest has org membership but no workspace grant -> denied
  assert.equal(canReadOrg(s, guest, 'org-1'), true);
  assert.equal(canReadWorkspace(s, guest, 'ws-1a'), false);

  // Workspace admin who is not a member of ch-1a-priv cannot read or self-join or invite others
  assert.equal(canReadChannel(s, admin, 'ch-1a-priv'), false);
  assert.equal(canReadChannelBoundFile(s, admin, 'file-priv-1', 'ws-1a'), false);
  const selfJoin = canModifyChannelMembership(s, admin, 'ch-1a-priv', admin);
  assert.equal(selfJoin.ok, false);
  if (!selfJoin.ok) assert.equal(selfJoin.refusal.code, 'PRIVATE_CHANNEL_INVITE_REQUIRED');

  // Channel owner can read private channel and bound file
  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), true);
  assert.equal(canReadChannelBoundFile(s, owner, 'file-priv-1', 'ws-1a'), true);

  // PRIVATE_CHANNELS_ENABLED=false fails closed on private channels
  s.privateChannelsEnabled = false;
  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), false);
  assert.equal(canReadChannelBoundFile(s, owner, 'file-priv-1', 'ws-1a'), false);
  s.privateChannelsEnabled = true;

  // Visibility transitions: non-empty public -> private blocked; private -> public blocked
  const pubToPriv = validateChannelVisibilityTransition({
    currentVisibility: 'workspace',
    nextVisibility: 'private',
    nextJoinPolicy: 'invite_only',
    signalCount: 3,
  });
  assert.equal(pubToPriv.ok, false);
  if (!pubToPriv.ok) assert.equal(pubToPriv.refusal.code, 'CHANNEL_HAS_PUBLIC_HISTORY');

  const privToPub = validateChannelVisibilityTransition({
    currentVisibility: 'private',
    nextVisibility: 'workspace',
    nextJoinPolicy: 'open',
  });
  assert.equal(privToPub.ok, false);
  if (!privToPub.ok) assert.equal(privToPub.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
});

test('workspace move between orgs enforces dual owner and owners_only revocation', () => {
  const s = createFixture();
  const moved = reconcileWorkspaceMove(s, {
    workspace_id: 'ws-1a',
    target_org_id: 'org-2',
    actor_user_id: 'u-owner',
    transfer_members: 'owners_only',
  });
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.equal(moved.source_org_id, 'org-1');
    assert.equal(moved.target_org_id, 'org-2');
    // ag-1 is only a 'member' in org-2, so under owners_only its ws-1a grant and seat are revoked
    assert.deepEqual(moved.closed_seat_ids, ['seat-1a']);
  }
});
