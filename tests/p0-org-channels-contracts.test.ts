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
    now: '2026-10-21T02:00:00Z',
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
    channels: ([
      ['ch-1a-gen', 'ws-1a', 'general', 'workspace', 'open'],
      ['ch-1a-priv', 'ws-1a', 'sec-incident', 'private', 'invite_only'],
      ['ch-1b-gen', 'ws-1b', 'general', 'workspace', 'open'],
      ['ch-2a-gen', 'ws-2a', 'general', 'workspace', 'open'],
    ] as const).map(([channel_id, workspace_id, slug, visibility, join_policy]) => ({ channel_id, workspace_id, slug, visibility, join_policy })),
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
    channelMemberships: ([
      ['ch-1a-priv', 'ws-1a', 'user', 'u-owner', 'owner'],
      ['ch-1a-priv', 'ws-1a', 'agent', 'ag-1', 'member'],
    ] as const).map(([channel_id, workspace_id, principal_kind, principal_id, role]) => ({ channel_id, workspace_id, principal_kind, principal_id, role, notify_pref: 'all', joined_at: now })),
    fileChannelBindings: ([
      ['file-priv-1', 'ws-1a', 'ch-1a-priv'],
      ['file-dual-1', 'ws-1a', 'ch-1a-gen'],
      ['file-dual-1', 'ws-1a', 'ch-1a-priv'],
    ] as const).map(([file_id, workspace_id, channel_id]) => ({ file_id, workspace_id, channel_id, bound_by_kind: 'user', created_at: now })),
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

const eq = assert.equal, deq = assert.deepEqual;
const u = (principal_id: string) => ({ principal_kind: 'user' as const, principal_id });
const ag = (principal_id: string, connection_id?: string) => ({ principal_kind: 'agent' as const, principal_id, ...(connection_id ? { connection_id } : {}) });

test('multi-org agent identity whoami pre-seat, post-seat, and standing credential revocation', () => {
  const s = createFixture(), caller = ag('ag-1', 'conn-1');
  const preSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1' });
  eq(preSeat.active_seat, null);
  eq(preSeat.organizations.length, 2);
  eq(preSeat.organizations[0]?.role, 'admin');
  eq(preSeat.organizations[1]?.role, 'member');

  const postSeat = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1', seat_id: 'seat-2a' });
  eq(postSeat.active_seat?.workspace_id, 'ws-2a');
  eq(postSeat.active_seat?.org_slug, 'household');
  s.hostedGrants![0]!.state = 'revoked';
  s.hostedGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  eq(canReadOrg(s, caller, 'org-1'), false);
  s.hostedGrants![0]!.state = 'active';
  s.hostedGrants![0]!.revoked_at = null;
  eq(canReadOrg(s, caller, 'org-1'), true);
  eq(canReadOrg({ ...s, now: null }, caller, 'org-1'), false);
  eq(canReadOrg(s, { ...caller, now: '2100-01-01T00:00:00Z' }, 'org-1'), false);
  s.renewalGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  eq(canReadOrg(s, caller, 'org-1'), false);
});

test('universal selector precedence, explicit org with connection default, and revoked default fallback', () => {
  const s = createFixture(), caller = ag('ag-1', 'conn-1');
  const ambig = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'ops' });
  eq(ambig.ok, false);
  if (!ambig.ok) { eq(ambig.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR'); eq(ambig.refusal.choices?.length, 2); }
  const exOrg = resolveOrgWorkspaceChannelSelector(s, caller, { org: 'yulan' });
  eq(exOrg.ok, true);
  if (exOrg.ok) eq(exOrg.workspace.workspace_id, 'ws-1a');
  const ex = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'yulan/ops' });
  eq(ex.ok, true);
  if (ex.ok) { eq(ex.workspace.workspace_id, 'ws-1a'); eq(ex.channel?.slug, 'general'); eq(ex.source, 'explicit'); }
  const seatAp = resolveOrgWorkspaceChannelSelector(s, ag('ap-1a', 'conn-1'), { seat_id: 'seat-1a' });
  eq(seatAp.ok, true);
  if (seatAp.ok) { eq(seatAp.workspace.workspace_id, 'ws-1a'); eq(seatAp.source, 'seat'); }
  const osMis = resolveOrgWorkspaceChannelSelector(s, caller, { org: 'yulan', seat_id: 'seat-2a' });
  eq(osMis.ok, false);
  if (!osMis.ok) eq(osMis.refusal.code, 'WORKSPACE_SEAT_MISMATCH');
  const mis = resolveOrgWorkspaceChannelSelector(s, caller, { workspace: 'household/ops', seat_id: 'seat-1a' });
  eq(mis.ok, false);
  if (!mis.ok) { eq(mis.refusal.code, 'WORKSPACE_SEAT_MISMATCH'); eq(mis.refusal.mcp_tool, 'claim_seat'); }

  s.connectionPolicies![0]!.default_workspace_id = null;
  const mDef = resolveOrgWorkspaceChannelSelector(s, caller, {});
  eq(mDef.ok, false);
  if (!mDef.ok) {
    eq(mDef.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    eq(mDef.refusal.scope.org, 'yulan');
    deq(mDef.refusal.choices?.map((c) => c.workspace_id), ['ws-1a', 'ws-1b']);
  }
  s.connectionPolicies![0]!.default_workspace_id = 'ws-1a';

  const fDef = resolveOrgWorkspaceChannelSelector(s, caller, {});
  eq(fDef.ok, true);
  if (fDef.ok) { eq(fDef.workspace.workspace_id, 'ws-1a'); eq(fDef.source, 'connection_default'); }

  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  const fbOrg = resolveOrgWorkspaceChannelSelector(s, caller, {});
  eq(fbOrg.ok, true);
  if (fbOrg.ok) { eq(fbOrg.workspace.workspace_id, 'ws-1b'); eq(fbOrg.source, 'connection_default'); }
});

test('explicit org/workspace revocation overrides owner inheritance (including tombstone creation) and cascades seats', () => {
  const s = createFixture(), caller = ag('ag-1', 'conn-1'), inh = ag('ag-inherited');
  eq(canReadWorkspace(s, inh, 'ws-1a'), true);
  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-inherited' });
  eq(canReadWorkspace(s, inh, 'ws-1a'), false);
  eq(canReadOrg(s, inh, 'org-1'), true);
  cascadeOrgMemberRemoval(s, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-inherited' });
  eq(canReadOrg(s, inh, 'org-1'), false);

  s.agentIdentities!.push({ id: 'ag-same-name-b', owner_user_id: 'u-owner', display_name: 'Inherited Helper', created_at: '2026-10-21T00:00:00Z' });
  eq(canReadOrg(s, ag('ag-same-name-b'), 'org-1'), true);
  eq(canReadWorkspace(s, ag('ag-same-name-b'), 'ws-1a'), true);

  const resWs = cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  deq(resWs.closed_seat_ids, ['seat-1a']);
  eq(canReadWorkspace(s, caller, 'ws-1a'), false);
  eq(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
  eq(canReadWorkspace(s, caller, 'ws-2a'), true);

  const resOrg = cascadeOrgMemberRemoval(s, { org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1' });
  deq(resOrg.closed_seat_ids, ['seat-2a']);
  eq(canReadOrg(s, caller, 'org-2'), false);

  s.agentPrincipals!.push({ principal_id: 'ap-2a-reclaimed', workspace_id: 'ws-2a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' });
  eq(canReadOrg(s, ag('ap-2a-reclaimed'), 'org-2'), false);
  eq(canReadWorkspace(s, ag('ap-2a-reclaimed'), 'ws-2a'), false);
  s.agentIdentities.push({ id: 'ap-1b-temp', owner_user_id: 'u-owner', display_name: 'Argon Lead', created_at: '2026-10-21T00:00:00Z' });
  s.agentPrincipals!.push({ principal_id: 'ap-1b-temp', workspace_id: 'ws-1b', agent_identity_id: 'ap-1b-temp', owner_user_id: 'u-owner', name: 'Argon Lead' });
  s.agentPrincipals!.push({ principal_id: 'ap-1b-retained', workspace_id: 'ws-1a', agent_identity_id: 'ap-1b-temp', owner_user_id: 'u-owner', name: 'Argon Lead' });
  s.seats!.push({ seat_id: 'seat-1b-temp', workspace_id: 'ws-1b', principal_id: 'ap-1b-temp', agent_identity_id: 'ap-1b-temp' });
  reconcileAgentIdentityMerge(s, { principal_id: 'ap-1b-temp', target_agent_identity_id: 'ag-1' });
  eq(resolveOrgWorkspaceChannelSelector(s, ag('ap-1b-temp'), { seat_id: 'seat-1b-temp' }).ok, true);
  cascadeOrgMemberRemoval(s, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ap-1b-retained' });
  ap1bReset: {
    s.agentPrincipals!.find((a) => a.principal_id === 'ap-1b-temp')!.agent_identity_id = 'ap-1b-temp';
    reconcileAgentIdentityMerge(s, { principal_id: 'ap-1b-temp', target_agent_identity_id: 'ag-1' });
  }
  eq(canReadWorkspace(s, caller, 'ws-1b'), false);
  eq(canReadOrg(s, ag('ap-1b-retained'), 'org-1'), false);
});

test('guest channel isolation, every-channel file bindings, and fail-closed privateChannelsEnabled default', () => {
  const s = createFixture(), now = '2026-10-21T00:00:00Z';
  const guest = u('u-guest'), admin = u('u-admin'), owner = u('u-owner');

  eq(canReadOrg(s, guest, 'org-1'), true);
  eq(canReadWorkspace(s, guest, 'ws-1a'), false);

  s.workspaceGrants.push({ workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now });
  eq(canReadWorkspace(s, guest, 'ws-1a'), true);
  eq(canReadChannel(s, guest, 'ch-1a-gen'), false);
  s.channelMemberships.push({ channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-guest', role: 'member', notify_pref: 'all', joined_at: now });
  eq(canReadChannel(s, guest, 'ch-1a-gen'), true);

  eq(canReadChannel(s, admin, 'ch-1a-priv'), false);
  eq(canReadChannelBoundFile(s, admin, 'file-priv-1', 'ws-1a'), false);
  eq(canReadChannelBoundFile(s, admin, 'file-dual-1', 'ws-1a'), false);
  const selfJoin = canModifyChannelMembership(s, admin, 'ch-1a-priv', admin);
  eq(selfJoin.ok, false);
  if (!selfJoin.ok) eq(selfJoin.refusal.code, 'PRIVATE_CHANNEL_INVITE_REQUIRED');

  eq(canReadChannel(s, owner, 'ch-1a-priv'), true);
  eq(canReadChannelBoundFile(s, owner, 'file-dual-1', 'ws-1a'), true);
  s.channelMemberships.find((m) => m.channel_id === 'ch-1a-priv' && m.principal_id === 'ag-1')!.role = 'owner';
  eq(canModifyChannelMembership(s, ag('ap-1a'), 'ch-1a-priv', admin).ok, true);
  s.channels.push({ channel_id: 'ch-ag-priv', workspace_id: 'ws-1a', slug: 'ag-priv', visibility: 'private', join_policy: 'invite_only', created_by_kind: 'agent', created_by_principal: 'ap-1a' });
  eq(bootstrapPrivateChannelMemberships(s, ag('ap-1a'), 'ch-ag-priv', now).ok, true);
  eq(canReadChannel(s, ag('ap-1a'), 'ch-ag-priv'), true);
  s.channelMemberships.forEach((m) => { if (m.channel_id === 'ch-ag-priv') m.revoked_at = now; });
  eq(bootstrapPrivateChannelMemberships(s, ag('ap-1a'), 'ch-ag-priv', now).ok, false);
  eq(canModifyChannelMembership(s, ag('ap-1a'), 'ch-ag-priv', ag('ag-1'), 'owner').ok, false);
  s.channels.find((c) => c.channel_id === 'ch-1a-priv')!.archived_at = now;
  eq(canReadChannel(s, owner, 'ch-1a-priv'), true);
  eq(canReadChannelBoundFile(s, owner, 'file-dual-1', 'ws-1a'), true);
  s.channels.find((c) => c.channel_id === 'ch-1a-priv')!.archived_at = null;

  delete s.privateChannelsEnabled;
  eq(canReadChannel(s, owner, 'ch-1a-priv'), false);
  eq(canModifyChannelMembership(s, owner, 'ch-1a-priv', admin).ok, false);
  const dTr = validateChannelVisibilityTransition({ nextVisibility: 'private', nextJoinPolicy: 'invite_only' });
  eq(dTr.ok, false);
  if (!dTr.ok) eq(dTr.refusal.code, 'PRIVATE_CHANNELS_DISABLED');

  const p2p = validateChannelVisibilityTransition({ privateChannelsEnabled: true, currentVisibility: 'workspace', nextVisibility: 'private', nextJoinPolicy: 'invite_only', signalCount: 3 });
  eq(p2p.ok, false);
  if (!p2p.ok) eq(p2p.refusal.code, 'CHANNEL_HAS_PUBLIC_HISTORY');

  const pr2p = validateChannelVisibilityTransition({ privateChannelsEnabled: true, currentVisibility: 'private', nextVisibility: 'workspace', nextJoinPolicy: 'open' });
  eq(pr2p.ok, false);
  if (!pr2p.ok) eq(pr2p.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
});

test('workspace move enforces dual owner, owners_only revocation, and transfer_members=all revoked-target reconciliation', () => {
  const s1 = createFixture();
  const sConf = reconcileWorkspaceMove(s1, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  eq(sConf.ok, false);
  if (!sConf.ok) eq(sConf.refusal.code, 'WORKSPACE_SLUG_TAKEN');
  s1.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';

  const denied = reconcileWorkspaceMove(s1, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-admin', transfer_members: 'owners_only' });
  eq(denied.ok, false);
  if (!denied.ok) eq(denied.refusal.code, 'ORG_MOVE_REQUIRES_DUAL_OWNER');

  const moved = reconcileWorkspaceMove(s1, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  eq(moved.ok, true);
  if (moved.ok) {
    eq(moved.source_org_id, 'org-1');
    eq(moved.target_org_id, 'org-2');
    deq(moved.closed_seat_ids, ['seat-1a']);
  }
  const sOm = createFixture();
  sOm.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  sOm.orgMemberships.find((m) => m.org_id === 'org-1' && m.principal_id === 'u-admin')!.role = 'owner';
  sOm.workspaceGrants.find((g) => g.workspace_id === 'ws-1a' && g.principal_id === 'u-admin')!.role = 'member';
  eq(reconcileWorkspaceMove(sOm, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' }).ok, true);
  eq(sOm.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_id === 'u-admin')?.role, 'member');

  const s2 = createFixture();
  s2.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  s2.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1')!.revoked_at = '2026-10-21T00:30:00Z';
  const movedAll = reconcileWorkspaceMove(s2, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'all' });
  eq(movedAll.ok, true);
  if (movedAll.ok) {
    deq(movedAll.closed_seat_ids, ['seat-1a']);
    eq(canReadWorkspace(s2, u('u-admin'), 'ws-1a'), true);
    eq(canReadWorkspace(s2, ag('ag-1'), 'ws-1a'), false);
    eq(s2.orgMemberships.filter((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1').length, 1);
  }

  const s3 = createFixture();
  s3.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  s3.workspaceGrants = s3.workspaceGrants.filter((g) => !(g.workspace_id === 'ws-1a' && g.principal_kind === 'agent' && g.principal_id === 'ag-1'));
  eq(canReadWorkspace(s3, ag('ag-1'), 'ws-1a'), true);
  const mvInh = reconcileWorkspaceMove(s3, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  eq(mvInh.ok, true);
  if (mvInh.ok) {
    deq(mvInh.closed_seat_ids, ['seat-1a']);
    eq(canReadWorkspace(s3, ag('ag-1'), 'ws-1a'), false);
  }
});
