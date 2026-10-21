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
  const s = createFixture(), c = ag('ag-1', 'conn-1');
  const pre = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1' });
  eq(pre.active_seat, null);
  eq(pre.organizations.length, 2);
  eq(pre.organizations[0]?.role, 'admin');
  eq(pre.organizations[1]?.role, 'member');

  const post = buildMultiOrgWhoamiResponse(s, { agent_identity_id: 'ag-1', connection_id: 'conn-1', seat_id: 'seat-2a' });
  eq(post.active_seat?.workspace_id, 'ws-2a');
  eq(post.active_seat?.org_slug, 'household');
  s.hostedGrants![0]!.state = 'revoked';
  s.hostedGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  eq(canReadOrg(s, c, 'org-1'), false);
  s.hostedGrants![0]!.state = 'active';
  s.hostedGrants![0]!.revoked_at = null;
  eq(canReadOrg(s, c, 'org-1'), true);
  eq(canReadOrg({ ...s, now: null }, c, 'org-1'), false);
  eq(canReadOrg(s, { ...c, now: '2100-01-01T00:00:00Z' }, 'org-1'), false);
  s.renewalGrants![0]!.revoked_at = '2026-10-21T01:00:00Z';
  eq(canReadOrg(s, c, 'org-1'), false);
  s.renewalGrants![0]!.principal_id = 'ap-1a';
  s.renewalGrants![0]!.workspace_id = 'ws-1a';
  s.agentPrincipals!.push({ principal_id: 'ap-inh-1a', workspace_id: 'ws-1a', agent_identity_id: 'ag-inherited', owner_user_id: 'u-owner', name: 'Inherited Helper' });
  s.renewalGrants!.push({ renewal_grant_id: 'rg-inh-1a', principal_id: 'ap-inh-1a', workspace_id: 'ws-1a', horizon_expires_at: '2099-01-01T00:00:00Z', revoked_at: null });
  eq(canReadWorkspace(s, c, 'ws-1a'), false);
  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  eq(canReadOrg(s, c, 'org-1'), true);
  eq(canReadWorkspace(s, c, 'ws-1a'), false);
  eq(canReadWorkspace(s, c, 'ws-1b'), true);
  eq(canReadWorkspace(s, ag('ag-inherited'), 'ws-1a'), true);
});

test('universal selector precedence, explicit org with connection default, and revoked default fallback', () => {
  const s = createFixture(), c = ag('ag-1', 'conn-1');
  const amb = resolveOrgWorkspaceChannelSelector(s, c, { workspace: 'ops' });
  eq(amb.ok, false);
  if (!amb.ok) { eq(amb.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR'); eq(amb.refusal.choices?.length, 2); }
  const eo = resolveOrgWorkspaceChannelSelector(s, c, { org: 'yulan' });
  eq(eo.ok, true);
  if (eo.ok) eq(eo.workspace.workspace_id, 'ws-1a');
  const ex = resolveOrgWorkspaceChannelSelector(s, c, { workspace: 'yulan/ops' });
  eq(ex.ok, true);
  if (ex.ok) { eq(ex.workspace.workspace_id, 'ws-1a'); eq(ex.channel?.slug, 'general'); eq(ex.source, 'explicit'); }
  const sa = resolveOrgWorkspaceChannelSelector(s, ag('ap-1a', 'conn-1'), { seat_id: 'seat-1a' });
  eq(sa.ok, true);
  if (sa.ok) { eq(sa.workspace.workspace_id, 'ws-1a'); eq(sa.source, 'seat'); }
  const om = resolveOrgWorkspaceChannelSelector(s, c, { org: 'yulan', seat_id: 'seat-2a' });
  eq(om.ok, false);
  if (!om.ok) eq(om.refusal.code, 'WORKSPACE_SEAT_MISMATCH');
  const mis = resolveOrgWorkspaceChannelSelector(s, c, { workspace: 'household/ops', seat_id: 'seat-1a' });
  eq(mis.ok, false);
  if (!mis.ok) { eq(mis.refusal.code, 'WORKSPACE_SEAT_MISMATCH'); eq(mis.refusal.mcp_tool, 'claim_seat'); }

  s.connectionPolicies![0]!.default_workspace_id = null;
  const md = resolveOrgWorkspaceChannelSelector(s, c, {});
  eq(md.ok, false);
  if (!md.ok) {
    eq(md.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    eq(md.refusal.scope.org, 'yulan');
    deq(md.refusal.choices?.map((x) => x.workspace_id), ['ws-1a', 'ws-1b']);
  }
  s.connectionPolicies![0]!.default_workspace_id = 'ws-1a';

  const fd = resolveOrgWorkspaceChannelSelector(s, c, {});
  eq(fd.ok, true);
  if (fd.ok) { eq(fd.workspace.workspace_id, 'ws-1a'); eq(fd.source, 'connection_default'); }

  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  const fb = resolveOrgWorkspaceChannelSelector(s, c, {});
  eq(fb.ok, true);
  if (fb.ok) { eq(fb.workspace.workspace_id, 'ws-1b'); eq(fb.source, 'connection_default'); }
});

test('explicit org/workspace revocation overrides owner inheritance (including tombstone creation) and cascades seats', () => {
  const s = createFixture(), c = ag('ag-1', 'conn-1'), inh = ag('ag-inherited'), now = '2026-10-21T00:00:00Z';
  eq(canReadWorkspace(s, inh, 'ws-1a'), true);
  cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-inherited' });
  eq(canReadWorkspace(s, inh, 'ws-1a'), false);
  eq(canReadOrg(s, inh, 'org-1'), true);
  cascadeOrgMemberRemoval(s, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-inherited' });
  eq(canReadOrg(s, inh, 'org-1'), false);

  s.agentIdentities!.push({ id: 'ag-b', owner_user_id: 'u-owner', display_name: 'Inherited Helper', created_at: now });
  eq(canReadOrg(s, ag('ag-b'), 'org-1'), true);
  eq(canReadWorkspace(s, ag('ag-b'), 'ws-1a'), true);

  const rw = cascadeWorkspaceMemberRemoval(s, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  deq(rw.closed_seat_ids, ['seat-1a']);
  eq(canReadWorkspace(s, c, 'ws-1a'), false);
  eq(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
  eq(canReadWorkspace(s, c, 'ws-2a'), true);

  const ro = cascadeOrgMemberRemoval(s, { org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1' });
  deq(ro.closed_seat_ids, ['seat-2a']);
  eq(canReadOrg(s, c, 'org-2'), false);

  s.agentPrincipals!.push({ principal_id: 'ap-2a-rec', workspace_id: 'ws-2a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' });
  eq(canReadOrg(s, ag('ap-2a-rec'), 'org-2'), false);
  eq(canReadWorkspace(s, ag('ap-2a-rec'), 'ws-2a'), false);
  s.agentIdentities.push({ id: 'ap-1b-t', owner_user_id: 'u-owner', display_name: 'Argon Lead', created_at: now });
  s.agentPrincipals!.push({ principal_id: 'ap-1b-t', workspace_id: 'ws-1b', agent_identity_id: 'ap-1b-t', owner_user_id: 'u-owner', name: 'Argon Lead' }, { principal_id: 'ap-1b-r', workspace_id: 'ws-1a', agent_identity_id: 'ap-1b-t', owner_user_id: 'u-owner', name: 'Argon Lead' });
  s.seats!.push({ seat_id: 'seat-1b-t', workspace_id: 'ws-1b', principal_id: 'ap-1b-t', agent_identity_id: 'ap-1b-t' });
  reconcileAgentIdentityMerge(s, { principal_id: 'ap-1b-t', target_agent_identity_id: 'ag-1' });
  eq(resolveOrgWorkspaceChannelSelector(s, ag('ap-1b-t'), { seat_id: 'seat-1b-t' }).ok, true);
  cascadeOrgMemberRemoval(s, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ap-1b-r' });
  s.agentPrincipals!.find((a) => a.principal_id === 'ap-1b-t')!.agent_identity_id = 'ap-1b-t';
  reconcileAgentIdentityMerge(s, { principal_id: 'ap-1b-t', target_agent_identity_id: 'ag-1' });
  eq(canReadWorkspace(s, c, 'ws-1b'), false);
  eq(canReadOrg(s, ag('ap-1b-r'), 'org-1'), false);
});

test('guest channel isolation, every-channel file bindings, and fail-closed privateChannelsEnabled default', () => {
  const s = createFixture(), now = '2026-10-21T00:00:00Z';
  const g = u('u-guest'), adm = u('u-admin'), own = u('u-owner');
  eq(canReadOrg(s, g, 'org-1'), true);
  eq(canReadWorkspace(s, g, 'ws-1a'), false);
  s.workspaceGrants.push({ workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now });
  eq(canReadWorkspace(s, g, 'ws-1a'), true);
  eq(canReadChannel(s, g, 'ch-1a-gen'), false);
  s.channelMemberships.push({ channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-guest', role: 'member', notify_pref: 'all', joined_at: now });
  eq(canReadChannel(s, g, 'ch-1a-gen'), true);
  eq(canReadChannel(s, adm, 'ch-1a-priv'), false);
  eq(canReadChannelBoundFile(s, adm, 'file-priv-1', 'ws-1a'), false);
  eq(canReadChannelBoundFile(s, adm, 'file-dual-1', 'ws-1a'), false);
  const sj = canModifyChannelMembership(s, adm, 'ch-1a-priv', adm);
  eq(sj.ok, false);
  if (!sj.ok) eq(sj.refusal.code, 'PRIVATE_CHANNEL_INVITE_REQUIRED');
  eq(canReadChannel(s, own, 'ch-1a-priv'), true);
  eq(canReadChannelBoundFile(s, own, 'file-dual-1', 'ws-1a'), true);
  s.channelMemberships.find((m) => m.channel_id === 'ch-1a-priv' && m.principal_id === 'ag-1')!.role = 'owner';
  eq(canModifyChannelMembership(s, ag('ap-1a'), 'ch-1a-priv', adm).ok, true);
  s.channels.push({ channel_id: 'ch-ag-priv', workspace_id: 'ws-1a', slug: 'ag-priv', visibility: 'private', join_policy: 'invite_only', created_by_kind: 'agent', created_by_principal: 'ap-1a' });
  s.renewalGrants![0]!.horizon_expires_at = '2026-10-21T01:00:00Z';
  eq(bootstrapPrivateChannelMemberships(s, ag('ap-1a'), 'ch-ag-priv').ok, false);
  s.renewalGrants![0]!.horizon_expires_at = '2026-10-28T00:00:00Z';
  eq(bootstrapPrivateChannelMemberships(s, ag('ap-1a'), 'ch-ag-priv', now).ok, true);
  eq(canReadChannel(s, ag('ap-1a'), 'ch-ag-priv'), true);
  s.channelMemberships.forEach((m) => { if (m.channel_id === 'ch-ag-priv') m.revoked_at = now; });
  eq(bootstrapPrivateChannelMemberships(s, ag('ap-1a'), 'ch-ag-priv', now).ok, false);
  eq(canModifyChannelMembership(s, ag('ap-1a'), 'ch-ag-priv', ag('ag-1'), 'owner').ok, false);
  s.channels.find((c) => c.channel_id === 'ch-1a-priv')!.archived_at = now;
  eq(canReadChannel(s, own, 'ch-1a-priv'), true);
  eq(canReadChannelBoundFile(s, own, 'file-dual-1', 'ws-1a'), true);
  s.channels.find((c) => c.channel_id === 'ch-1a-priv')!.archived_at = null;
  delete s.privateChannelsEnabled;
  eq(canReadChannel(s, own, 'ch-1a-priv'), false);
  eq(canModifyChannelMembership(s, own, 'ch-1a-priv', adm).ok, false);
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
  const s1 = createFixture(), mvArg = (m: 'owners_only' | 'all', actor = 'u-owner') => ({ workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: actor, transfer_members: m });
  const sc = reconcileWorkspaceMove(s1, mvArg('owners_only'));
  eq(sc.ok, false);
  if (!sc.ok) eq(sc.refusal.code, 'WORKSPACE_SLUG_TAKEN');
  s1.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  const dn = reconcileWorkspaceMove(s1, mvArg('owners_only', 'u-admin'));
  eq(dn.ok, false);
  if (!dn.ok) eq(dn.refusal.code, 'ORG_MOVE_REQUIRES_DUAL_OWNER');
  const mv = reconcileWorkspaceMove(s1, mvArg('owners_only'));
  eq(mv.ok, true);
  if (mv.ok) { eq(mv.source_org_id, 'org-1'); eq(mv.target_org_id, 'org-2'); deq(mv.closed_seat_ids, ['seat-1a']); }
  const sOm = createFixture();
  sOm.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  sOm.orgMemberships.find((m) => m.org_id === 'org-1' && m.principal_id === 'u-admin')!.role = 'owner';
  sOm.workspaceGrants.find((g) => g.workspace_id === 'ws-1a' && g.principal_id === 'u-admin')!.role = 'member';
  eq(reconcileWorkspaceMove(sOm, mvArg('owners_only')).ok, true);
  eq(sOm.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_id === 'u-admin')?.role, 'member');
  const s2 = createFixture();
  s2.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  s2.orgMemberships.find((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1')!.revoked_at = '2026-10-21T00:30:00Z';
  const ma = reconcileWorkspaceMove(s2, mvArg('all'));
  eq(ma.ok, true);
  if (ma.ok) {
    deq(ma.closed_seat_ids, ['seat-1a']);
    eq(canReadWorkspace(s2, u('u-admin'), 'ws-1a'), true);
    eq(canReadWorkspace(s2, ag('ag-1'), 'ws-1a'), false);
    eq(s2.orgMemberships.filter((m) => m.org_id === 'org-2' && m.principal_kind === 'agent' && m.principal_id === 'ag-1').length, 1);
  }
  const s3 = createFixture();
  s3.workspaces.find((w) => w.workspace_id === 'ws-2a')!.slug = 'home-ops';
  s3.workspaceGrants = s3.workspaceGrants.filter((g) => !(g.workspace_id === 'ws-1a' && g.principal_kind === 'agent' && g.principal_id === 'ag-1'));
  eq(canReadWorkspace(s3, ag('ag-1'), 'ws-1a'), true);
  const mi = reconcileWorkspaceMove(s3, mvArg('owners_only'));
  eq(mi.ok, true);
  if (mi.ok) { deq(mi.closed_seat_ids, ['seat-1a']); eq(canReadWorkspace(s3, ag('ag-1'), 'ws-1a'), false); }
});
