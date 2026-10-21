import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type OrgChannelAuthorityState,
  bootstrapPrivateChannelMemberships,
  buildMultiOrgWhoamiResponse,
  canModifyChannelMembership,
  canReadChannel,
  canReadChannelBoundFile,
  canReadOrg,
  canReadWorkspace,
  cascadeOrgMemberRemoval,
  cascadeWorkspaceMemberRemoval,
  reconcileAgentIdentityMerge,
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
    hostedGrants: [{ grant_id: 'hg-1', state: 'active', revoked_at: null }],
    renewalGrants: [{ renewal_grant_id: 'rg-1', horizon_expires_at: '2099-01-01T00:00:00Z', revoked_at: null }],
    orgMemberships: ([['org-1','user','u-owner','owner'],['org-1','user','u-admin','admin'],['org-1','user','u-guest','guest'],['org-1','agent','ag-1','admin'],['org-2','user','u-owner','owner'],['org-2','agent','ag-1','member']] as const).map(([org_id, principal_kind, principal_id, role]) => ({ org_id, principal_kind, principal_id, role, created_at: now })),
    workspaceGrants: ([['ws-1a','org-1','user','u-owner','owner'],['ws-1b','org-1','user','u-owner','owner'],['ws-2a','org-2','user','u-owner','owner'],['ws-1a','org-1','user','u-admin','admin'],['ws-1a','org-1','agent','ag-1','admin'],['ws-1b','org-1','agent','ag-1','member'],['ws-2a','org-2','agent','ag-1','member']] as const).map(([workspace_id, org_id, principal_kind, principal_id, role]) => ({ workspace_id, org_id, principal_kind, principal_id, role, created_at: now })),
    agentPrincipals: (['ap-1a:ws-1a', 'ap-1b:ws-1b', 'ap-2a:ws-2a'] as const).map((x) => {
      const [principal_id, workspace_id] = x.split(':') as [string, string];
      return { principal_id, workspace_id, agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' };
    }),
    channelMemberships: [
      { channel_id: 'ch-1a-priv', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', notify_pref: 'all', joined_at: now },
      { channel_id: 'ch-1a-priv', workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', notify_pref: 'all', joined_at: now },
    ],
    fileChannelBindings: [
      { file_id: 'file-priv-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-priv', bound_by_kind: 'user', created_at: now },
      { file_id: 'file-dual-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-gen', bound_by_kind: 'user', created_at: now },
      { file_id: 'file-dual-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-priv', bound_by_kind: 'user', created_at: now },
    ],
    connectionPolicies: [{ connection_id: 'conn-1', owner_user_id: 'u-owner', agent_identity_id: 'ag-1', default_org_id: 'org-1', default_workspace_id: 'ws-1a' }],
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

const u = (principal_id: string) => ({ principal_kind: 'user' as const, principal_id });
const ag = (principal_id: string, connection_id?: string) => ({ principal_kind: 'agent' as const, principal_id, ...(connection_id ? { connection_id } : {}) });

test('multi-org agent identity whoami pre-seat, post-seat, and standing credential revocation', () => {
  const s = createFixture(), caller = ag('ag-1', 'conn-1');
  const preSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1' });
  assert.equal(preSeat.active_seat, null);
  assert.equal(preSeat.organizations.length, 2);
  assert.equal(preSeat.organizations[0]?.role, 'admin');
  assert.equal(preSeat.organizations[1]?.role, 'member');

  const postSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1', seat_id: 'seat-2a' });
  assert.equal(postSeat.active_seat?.workspace_id, 'ws-2a');
  assert.equal(postSeat.active_seat?.org_slug, 'household');
  s.hostedGrants![0]!.state = 'revoked';
  s.hostedGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  assert.equal(canReadOrg(s, caller, 'org-1'), false);
  s.hostedGrants![0]!.state = 'active';
  s.hostedGrants![0]!.revoked_at = null;
  assert.equal(canReadOrg(s, caller, 'org-1'), true);
  assert.equal(canReadOrg(s, { ...caller, now: '2100-01-01T00:00:00Z' }, 'org-1'), false);
  s.renewalGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  assert.equal(canReadOrg(s, caller, 'org-1'), false);
});

test('universal selector precedence, explicit org with connection default, and revoked default fallback', () => {
  const s = createFixture(), caller = ag('ag-1', 'conn-1');
  const ambig = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'ops' });
  assert.equal(ambig.ok, false);
  if (!ambig.ok) { assert.equal(ambig.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR'); assert.equal(ambig.refusal.choices?.length, 2); }
  const exOrg = resolveOrgWorkspaceChannelSelector(s, caller, { org: 'yulan' });
  assert.equal(exOrg.ok, true);
  if (exOrg.ok) assert.equal(exOrg.workspace.workspace_id, 'ws-1a');
  const ex = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'yulan/ops' });
  assert.equal(ex.ok, true);
  if (ex.ok) { assert.equal(ex.workspace.workspace_id, 'ws-1a'); assert.equal(ex.channel?.slug, 'general'); assert.equal(ex.source, 'explicit'); }
  const seatAp = resolveOrgWorkspaceChannelSelector(s, ag('ap-1a', 'conn-1'), { seat_id: 'seat-1a' });
  assert.equal(seatAp.ok, true);
  if (seatAp.ok) { assert.equal(seatAp.workspace.workspace_id, 'ws-1a'); assert.equal(seatAp.source, 'seat'); }
  const osMis = resolveOrgWorkspaceChannelSelector(s, caller, { org: 'yulan', seat_id: 'seat-2a' });
  assert.equal(osMis.ok, false);
  if (!osMis.ok) assert.equal(osMis.refusal.code, 'WORKSPACE_SEAT_MISMATCH');
  const mis = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'household/ops', seat_id: 'seat-1a' });
  assert.equal(mis.ok, false);
  if (!mis.ok) { assert.equal(mis.refusal.code, 'WORKSPACE_SEAT_MISMATCH'); assert.equal(mis.refusal.mcp_tool, 'claim_seat'); }

  s.connectionPolicies![0]!.default_workspace_id = null;
  const mDef = resolveOrgWorkspaceChannelSelector(s, caller, {});
  assert.equal(mDef.ok, false);
  if (!mDef.ok) {
    assert.equal(mDef.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    assert.equal(mDef.refusal.scope.org, 'yulan');
    assert.deepEqual(mDef.refusal.choices?.map((c) => c.workspace_id), ['ws-1a', 'ws-1b']);
  }
  s.connectionPolicies![0]!.default_workspace_id = 'ws-1a';

  const fDef = resolveOrgWorkspaceChannelSelector(s, caller, {});
  assert.equal(fDef.ok, true);
  if (fDef.ok) { assert.equal(fDef.workspace.workspace_id, 'ws-1a'); assert.equal(fDef.source, 'connection_default'); }

  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  const fbOrg = resolveOrgWorkspaceChannelSelector(s, caller, {});
  assert.equal(fbOrg.ok, true);
  if (fbOrg.ok) { assert.equal(fbOrg.workspace.workspace_id, 'ws-1b'); assert.equal(fbOrg.source, 'connection_default'); }
});

test('explicit org/workspace revocation overrides owner inheritance (including tombstone creation) and cascades seats', () => {
  const s = createFixture(), caller = ag('ag-1', 'conn-1'), inh = ag('ag-inherited');
  assert.equal(canReadWorkspace(s, inh, 'ws-1a'), true);
  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-inherited' });
  assert.equal(canReadWorkspace(s, inh, 'ws-1a'), false);
  assert.equal(canReadOrg(s, inh, 'org-1'), true);
  cascadeOrgMemberRemoval(s, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-inherited' });
  assert.equal(canReadOrg(s, inh, 'org-1'), false);

  s.agentIdentities!.push({ id: 'ag-same-name-b', owner_user_id: 'u-owner', display_name: 'Inherited Helper', created_at: '2026-10-21T00:00:00Z' });
  assert.equal(canReadOrg(s, ag('ag-same-name-b'), 'org-1'), true);
  assert.equal(canReadWorkspace(s, ag('ag-same-name-b'), 'ws-1a'), true);

  const resWs = cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  assert.deepEqual(resWs.closed_seat_ids, ['seat-1a']);
  assert.equal(canReadWorkspace(s, caller, 'ws-1a'), false);
  assert.equal(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
  assert.equal(canReadWorkspace(s, caller, 'ws-2a'), true);

  const resOrg = cascadeOrgMemberRemoval(s, { org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1' });
  assert.deepEqual(resOrg.closed_seat_ids, ['seat-2a']);
  assert.equal(canReadOrg(s, caller, 'org-2'), false);

  s.agentPrincipals!.push({ principal_id: 'ap-2a-reclaimed', workspace_id: 'ws-2a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' });
  assert.equal(canReadOrg(s, ag('ap-2a-reclaimed'), 'org-2'), false);
  assert.equal(canReadWorkspace(s, ag('ap-2a-reclaimed'), 'ws-2a'), false);
  s.agentIdentities.push({ id: 'ap-1b-temp', owner_user_id: 'u-owner', display_name: 'Argon Lead', created_at: '2026-10-21T00:00:00Z' });
  s.agentPrincipals!.push({ principal_id: 'ap-1b-temp', workspace_id: 'ws-1b', agent_identity_id: 'ap-1b-temp', owner_user_id: 'u-owner', name: 'Argon Lead' });
  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1b', principal_kind: 'agent', principal_id: 'ap-1b-temp' });
  reconcileAgentIdentityMerge(s, { principal_id: 'ap-1b-temp', target_agent_identity_id: 'ag-1' });
  assert.equal(canReadWorkspace(s, caller, 'ws-1b'), false);
});

test('guest channel isolation, every-channel file bindings, and fail-closed privateChannelsEnabled default', () => {
  const s = createFixture(), now = '2026-10-21T00:00:00Z';
  const guest = u('u-guest'), admin = u('u-admin'), owner = u('u-owner');

  assert.equal(canReadOrg(s, guest, 'org-1'), true);
  assert.equal(canReadWorkspace(s, guest, 'ws-1a'), false);

  s.workspaceGrants.push({ workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now });
  assert.equal(canReadWorkspace(s, guest, 'ws-1a'), true);
  assert.equal(canReadChannel(s, guest, 'ch-1a-gen'), false);
  s.channelMemberships.push({ channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-guest', role: 'member', notify_pref: 'all', joined_at: now });
  assert.equal(canReadChannel(s, guest, 'ch-1a-gen'), true);

  assert.equal(canReadChannel(s, admin, 'ch-1a-priv'), false);
  assert.equal(canReadChannelBoundFile(s, admin, 'file-priv-1', 'ws-1a'), false);
  assert.equal(canReadChannelBoundFile(s, admin, 'file-dual-1', 'ws-1a'), false);
  const selfJoin = canModifyChannelMembership(s, admin, 'ch-1a-priv', admin);
  assert.equal(selfJoin.ok, false);
  if (!selfJoin.ok) assert.equal(selfJoin.refusal.code, 'PRIVATE_CHANNEL_INVITE_REQUIRED');

  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), true);
  assert.equal(canReadChannelBoundFile(s, owner, 'file-dual-1', 'ws-1a'), true);
  s.channelMemberships.find((m) => m.channel_id === 'ch-1a-priv' && m.principal_id === 'ag-1')!.role = 'owner';
  assert.equal(canModifyChannelMembership(s, ag('ap-1a'), 'ch-1a-priv', admin).ok, true);
  s.channels.push({ channel_id: 'ch-ag-priv', workspace_id: 'ws-1a', slug: 'ag-priv', visibility: 'private', join_policy: 'invite_only', created_by_kind: 'agent', created_by_principal: 'ap-1a' });
  assert.equal(bootstrapPrivateChannelMemberships(s, ag('ap-1a'), 'ch-ag-priv', now).ok, true);
  assert.equal(canReadChannel(s, ag('ap-1a'), 'ch-ag-priv'), true);
  s.channels.find((c) => c.channel_id === 'ch-1a-priv')!.archived_at = now;
  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), true);
  assert.equal(canReadChannelBoundFile(s, owner, 'file-dual-1', 'ws-1a'), true);
  s.channels.find((c) => c.channel_id === 'ch-1a-priv')!.archived_at = null;

  delete s.privateChannelsEnabled;
  assert.equal(canReadChannel(s, owner, 'ch-1a-priv'), false);
  assert.equal(canModifyChannelMembership(s, owner, 'ch-1a-priv', admin).ok, false);
  const dTr = validateChannelVisibilityTransition({ nextVisibility: 'private', nextJoinPolicy: 'invite_only' });
  assert.equal(dTr.ok, false);
  if (!dTr.ok) assert.equal(dTr.refusal.code, 'PRIVATE_CHANNELS_DISABLED');

  const p2p = validateChannelVisibilityTransition({ privateChannelsEnabled: true, currentVisibility: 'workspace', nextVisibility: 'private', nextJoinPolicy: 'invite_only', signalCount: 3 });
  assert.equal(p2p.ok, false);
  if (!p2p.ok) assert.equal(p2p.refusal.code, 'CHANNEL_HAS_PUBLIC_HISTORY');

  const pr2p = validateChannelVisibilityTransition({ privateChannelsEnabled: true, currentVisibility: 'private', nextVisibility: 'workspace', nextJoinPolicy: 'open' });
  assert.equal(pr2p.ok, false);
  if (!pr2p.ok) assert.equal(pr2p.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
});

test('workspace move enforces dual owner, owners_only revocation, and transfer_members=all revoked-target reconciliation', () => {
  const s1 = createFixture();
  const sConf = reconcileWorkspaceMove(s1, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  assert.equal(sConf.ok, false);
  if (!sConf.ok) assert.equal(sConf.refusal.code, 'WORKSPACE_SLUG_TAKEN');
  s1.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';

  const denied = reconcileWorkspaceMove(s1, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-admin', transfer_members: 'owners_only' });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.refusal.code, 'ORG_MOVE_REQUIRES_DUAL_OWNER');

  const moved = reconcileWorkspaceMove(s1, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.equal(moved.source_org_id, 'org-1');
    assert.equal(moved.target_org_id, 'org-2');
    assert.deepEqual(moved.closed_seat_ids, ['seat-1a']);
  }
  const sOm = createFixture();
  sOm.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  sOm.orgMemberships.find((m) => m.org_id === 'org-1' && m.principal_id === 'u-admin')!.role = 'owner';
  sOm.workspaceGrants.find((g) => g.workspace_id === 'ws-1a' && g.principal_id === 'u-admin')!.role = 'member';
  assert.equal(reconcileWorkspaceMove(sOm, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' }).ok, true);
  assert.equal(sOm.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_id === 'u-admin')?.role, 'member');

  const s2 = createFixture();
  s2.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  s2.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1')!.revoked_at = '2026-10-21T00:30:00Z';
  const movedAll = reconcileWorkspaceMove(s2, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'all' });
  assert.equal(movedAll.ok, true);
  if (movedAll.ok) {
    assert.deepEqual(movedAll.closed_seat_ids, ['seat-1a']);
    assert.equal(canReadWorkspace(s2, u('u-admin'), 'ws-1a'), true);
    assert.equal(canReadWorkspace(s2, ag('ag-1'), 'ws-1a'), false);
    assert.equal(s2.orgMemberships.filter((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1').length, 1);
  }

  const s3 = createFixture();
  s3.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  s3.workspaceGrants = s3.workspaceGrants.filter((g) => !(g.workspace_id === 'ws-1a' && g.principal_kind === 'agent' && g.principal_id === 'ag-1'));
  assert.equal(canReadWorkspace(s3, ag('ag-1'), 'ws-1a'), true);
  const mvInh = reconcileWorkspaceMove(s3, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  assert.equal(mvInh.ok, true);
  if (mvInh.ok) {
    assert.deepEqual(mvInh.closed_seat_ids, ['seat-1a']);
    assert.equal(canReadWorkspace(s3, ag('ag-1'), 'ws-1a'), false);
  }
});
