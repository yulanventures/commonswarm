import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type CallerContext, type OrgChannelAuthorityState, type OrgWorkspaceChannelSelector,
  canReadOrg, canReadWorkspace, canReadChannel, canReadSignal, canReadChannelBoundFile,
  resolveOrgWorkspaceChannelSelector,
} from '../src/protocol/org-channels-contract.js';

// Synthetic canonical topology: separate principals for two workspaces owned by
// the same person; human-only org roles; original workspace membership authority.
function fixture(): OrgChannelAuthorityState {
  return {
    organizations: [
      { id: 'north', slug: 'north', display_name: 'North House', archived_at: null },
      { id: 'south', slug: 'south', display_name: 'South House', archived_at: null },
      { id: 'vault', slug: 'hidden-org', display_name: 'Hidden Organization', archived_at: null },
    ],
    orgMemberships: [
      { org_id: 'north', user_id: 'owner', role: 'owner', revoked_at: null },
      { org_id: 'south', user_id: 'owner', role: 'owner', revoked_at: null },
      { org_id: 'north', user_id: 'admin', role: 'admin', revoked_at: null },
      { org_id: 'north', user_id: 'member', role: 'member', revoked_at: null },
      { org_id: 'north', user_id: 'visitor', role: 'member', revoked_at: null },
      { org_id: 'north', user_id: 'removed', role: 'member', revoked_at: 1 },
    ],
    workspaces: [
      { workspace_id: 'a', org_id: 'north', slug: 'ops', name: 'North Ops', archived_at: null },
      { workspace_id: 'b', org_id: 'south', slug: 'ops', name: 'South Ops', archived_at: null },
      { workspace_id: 'sibling', org_id: 'north', slug: 'hidden-budget', name: 'Hidden Budget', archived_at: null },
      { workspace_id: 'hidden-ws', org_id: 'vault', slug: 'ops', name: 'Hidden Workspace', archived_at: null },
    ],
    workspaceMemberships: [
      { workspace_id: 'a', user_id: 'owner', role: 'owner', revoked_at: null },
      { workspace_id: 'b', user_id: 'owner', role: 'owner', revoked_at: null },
      { workspace_id: 'a', user_id: 'admin', role: 'admin', revoked_at: null },
      { workspace_id: 'a', user_id: 'member', role: 'member', revoked_at: null },
      { workspace_id: 'a', user_id: 'removed', role: 'member', revoked_at: 1 },
    ],
    agentPrincipals: [
      { principal_id: 'ap-a', workspace_id: 'a', owner_user_id: 'owner', revoked_at: null },
      { principal_id: 'ap-b', workspace_id: 'b', owner_user_id: 'owner', revoked_at: null },
    ],
    agentAuthority: [
      { credential_id: 'grant', workspace_id: 'a', principal_id: 'ap-a', owner_user_id: 'owner', credential_active: true, workspace_consented: true },
      { credential_id: 'grant', workspace_id: 'b', principal_id: 'ap-b', owner_user_id: 'owner', credential_active: true, workspace_consented: true },
    ],
    channels: [
      { channel_id: 'general-a', workspace_id: 'a', slug: 'general', visibility: 'workspace', archived_at: null },
      { channel_id: 'private-a', workspace_id: 'a', slug: 'hidden-private', visibility: 'private', archived_at: null },
      { channel_id: 'archive-a', workspace_id: 'a', slug: 'archive', visibility: 'workspace', archived_at: 1 },
      { channel_id: 'general-b', workspace_id: 'b', slug: 'general', visibility: 'workspace', archived_at: null },
    ],
    channelMemberships: [
      { channel_id: 'private-a', workspace_id: 'a', principal_kind: 'user', principal_id: 'owner', role: 'owner', revoked_at: null },
      { channel_id: 'private-a', workspace_id: 'a', principal_kind: 'user', principal_id: 'admin', role: 'member', revoked_at: null },
      { channel_id: 'private-a', workspace_id: 'a', principal_kind: 'user', principal_id: 'member', role: 'member', revoked_at: null },
      { channel_id: 'private-a', workspace_id: 'a', principal_kind: 'agent', principal_id: 'ap-a', role: 'owner', revoked_at: null },
    ],
    signals: [
      { signal_id: 'unfiled', workspace_id: 'a', channel_id: null, thread_root_id: null },
      { signal_id: 'unfiled-reply', workspace_id: 'a', channel_id: null, thread_root_id: 'unfiled' },
      { signal_id: 'root-a', workspace_id: 'a', channel_id: 'general-a', thread_root_id: null },
      { signal_id: 'reply-a', workspace_id: 'a', channel_id: 'general-a', thread_root_id: 'root-a' },
      { signal_id: 'archive-root', workspace_id: 'a', channel_id: 'archive-a', thread_root_id: null },
      { signal_id: 'private-root', workspace_id: 'a', channel_id: 'private-a', thread_root_id: null },
      { signal_id: 'private-reply', workspace_id: 'a', channel_id: 'private-a', thread_root_id: 'private-root' },
      { signal_id: 'root-b', workspace_id: 'b', channel_id: 'general-b', thread_root_id: null },
    ],
    files: [
      { file_id: 'unbound', workspace_id: 'a' }, { file_id: 'public-file', workspace_id: 'a' },
      { file_id: 'mixed-file', workspace_id: 'a' }, { file_id: 'file-b', workspace_id: 'b' },
    ],
    fileChannelBindings: [
      { file_id: 'public-file', workspace_id: 'a', channel_id: 'general-a' },
      { file_id: 'mixed-file', workspace_id: 'a', channel_id: 'general-a' },
      { file_id: 'mixed-file', workspace_id: 'a', channel_id: 'private-a' },
    ],
    seats: [
      { seat_id: 'seat-a', workspace_id: 'a', principal_id: 'ap-a', revoked_at: null },
      { seat_id: 'seat-b', workspace_id: 'b', principal_id: 'ap-b', revoked_at: null },
    ],
  };
}
const user = (principal_id: string, current_workspace_id?: string): CallerContext => ({ principal_kind: 'user', principal_id, current_workspace_id });
const agent = (principal_id = 'ap-a', workspace_id = 'a', credential_id = 'grant'): CallerContext =>
  ({ principal_kind: 'agent', principal_id, workspace_id, credential_id });
const resolve = (s: OrgChannelAuthorityState, c: CallerContext, input: OrgWorkspaceChannelSelector = {}) =>
  resolveOrgWorkspaceChannelSelector(s, c, input);
function selected(s: OrgChannelAuthorityState, c: CallerContext, input: OrgWorkspaceChannelSelector, workspaceId: string) {
  const result = resolve(s, c, input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Expected permitted selector');
  assert.equal(result.workspace.workspace_id, workspaceId);
  return result;
}

test('legacy memberships authorize each human role; org roles never grant sibling workspace access', () => {
  const s = fixture();
  for (const id of ['owner', 'admin', 'member']) {
    assert.equal(canReadOrg(s, user(id), 'north'), true);
    assert.equal(canReadWorkspace(s, user(id), 'a'), true);
    assert.equal(canReadChannel(s, user(id), 'general-a'), true);
    assert.equal(canReadWorkspace(s, user(id), 'sibling'), false);
  }
  for (const id of ['outsider', 'removed', 'visitor']) {
    assert.equal(canReadWorkspace(s, user(id), 'a'), false);
    assert.equal(canReadChannel(s, user(id), 'general-a'), false);
  }
  // A live org member without a workspace grant has no guest or inherited grant.
  assert.equal(canReadOrg(s, user('visitor'), 'north'), true);
  const removedOrg = { ...s, orgMemberships: s.orgMemberships.filter((m) => m.user_id !== 'owner') };
  assert.equal(canReadWorkspace(removedOrg, user('owner'), 'a'), false);
  assert.equal(canReadWorkspace(s, user('owner'), 'a'), true);
});

test('agent authority intersects exact principal, workspace, credential, consent and live owner', () => {
  const s = fixture(), c = agent();
  assert.equal(canReadWorkspace(s, c, 'a'), true);
  assert.equal(canReadWorkspace(s, agent('ap-b', 'b'), 'b'), true);
  for (const wrong of [agent('ap-b'), agent('ap-a', 'b'), agent('ap-a', 'a', 'other-credential')]) {
    assert.equal(canReadWorkspace(s, wrong, 'a'), false);
    assert.equal(resolve(s, wrong, { workspace: 'north/ops' }).ok, false);
  }
  const negatives: Array<[string, OrgChannelAuthorityState]> = [
    ['revoked principal', { ...s, agentPrincipals: s.agentPrincipals.map((p) => ({ ...p, revoked_at: 1 })) }],
    ['removed workspace owner', { ...s, workspaceMemberships: s.workspaceMemberships.filter((m) => m.user_id !== 'owner') }],
    ['removed org owner', { ...s, orgMemberships: s.orgMemberships.filter((m) => m.user_id !== 'owner') }],
    ['missing consent', { ...s, agentAuthority: s.agentAuthority.map((a) => ({ ...a, workspace_consented: false })) }],
    ['inactive credential', { ...s, agentAuthority: s.agentAuthority.map((a) => ({ ...a, credential_active: false })) }],
    ['missing authority', { ...s, agentAuthority: [] }],
    ['wrong owner', { ...s, agentAuthority: s.agentAuthority.map((a) => ({ ...a, owner_user_id: 'admin' })) }],
  ];
  for (const [reason, denied] of negatives) {
    selected(s, c, { seat_id: 'seat-a' }, 'a'); // Same-invocation positive control.
    assert.equal(canReadWorkspace(denied, c, 'a'), false, reason);
    assert.equal(canReadOrg(denied, c, 'north'), false, reason);
    assert.equal(resolve(denied, c, { seat_id: 'seat-a' }).ok, false, reason);
  }
});

test('private OFF denies private channel owners, admins, members and agents including indirect model reads', () => {
  const s = fixture();
  for (const c of [user('owner'), user('admin'), user('member'), agent()]) {
    assert.equal(canReadChannel(s, c, 'general-a'), true);
    assert.equal(canReadSignal(s, c, 'reply-a', 'a'), true);
    assert.equal(canReadChannelBoundFile(s, c, 'public-file', 'a'), true);
    assert.equal(canReadChannel(s, c, 'private-a'), false);
    assert.equal(canReadSignal(s, c, 'private-root', 'a'), false);
    assert.equal(canReadSignal(s, c, 'private-reply', 'a'), false);
    assert.equal(canReadChannelBoundFile(s, c, 'mixed-file', 'a'), false);
    selected(s, c, { workspace: 'north/ops', channel: '#general' }, 'a');
    assert.equal(resolve(s, c, { workspace: 'north/ops', channel: 'hidden-private' }).ok, false);
  }
  for (const c of [user('outsider'), user('visitor'), user('removed'), agent('ap-b', 'b')]) {
    assert.equal(canReadChannel(s, c, 'private-a'), false);
  }
});

test('unfiled and archived history, root channels and file containment preserve legacy workspace boundaries', () => {
  const s = fixture(), before = structuredClone(s), c = user('owner');
  for (const id of ['unfiled', 'unfiled-reply', 'root-a', 'reply-a', 'archive-root']) {
    assert.equal(canReadSignal(s, c, id, 'a'), true, id);
    assert.equal(canReadSignal(s, c, id, 'b'), false, id);
  }
  assert.equal(canReadSignal(s, c, 'root-b', 'b'), true);
  assert.equal(canReadSignal(s, c, 'root-b', 'a'), false);
  for (const broken of [
    { signal_id: 'broken', workspace_id: 'a', channel_id: 'general-a', thread_root_id: 'root-b' },
    { signal_id: 'broken', workspace_id: 'a', channel_id: 'general-a', thread_root_id: 'private-root' },
    { signal_id: 'broken', workspace_id: 'a', channel_id: 'general-a', thread_root_id: 'absent' },
    { signal_id: 'broken', workspace_id: 'a', channel_id: 'general-a', thread_root_id: 'broken' },
    { signal_id: 'broken', workspace_id: 'a', channel_id: 'general-b', thread_root_id: null },
  ]) {
    assert.equal(canReadSignal({ ...s, signals: [...s.signals, broken] }, c, 'broken', 'a'), false);
  }
  for (const id of ['unbound', 'public-file']) assert.equal(canReadChannelBoundFile(s, c, id, 'a'), true);
  assert.equal(canReadChannelBoundFile(s, c, 'file-b', 'b'), true);
  assert.equal(canReadChannelBoundFile(s, c, 'file-b', 'a'), false);
  assert.equal(canReadChannelBoundFile(s, c, 'absent', 'a'), false);
  const badBinding = { ...s, fileChannelBindings: [...s.fileChannelBindings,
    { file_id: 'public-file', workspace_id: 'a', channel_id: 'general-b' }] };
  assert.equal(canReadChannelBoundFile(badBinding, c, 'public-file', 'a'), false);
  assert.equal(selected(s, c, { workspace: 'north/ops', entity: { kind: 'signal', id: 'unfiled' } }, 'a').channel, null);
  assert.equal(selected(s, c, { workspace: 'north/ops', entity: { kind: 'signal', id: 'archive-root' } }, 'a').channel?.channel_id, 'archive-a');
  assert.deepEqual(s, before); // Selection must never refile history or edit authority.
});

test('selectors honor explicit scope, current workspace and exact seat without retargeting', () => {
  const s = fixture(), c = user('owner', 'a');
  assert.equal(selected(s, c, {}, 'a').source, 'current_workspace');
  assert.equal(selected(s, c, { workspace: 'south/ops' }, 'b').source, 'explicit');
  selected(s, c, { org: 'south', workspace: 'ops' }, 'b');
  selected(s, c, { workspace: 'a' }, 'a');
  assert.equal(selected(s, agent(), { seat_id: 'seat-a' }, 'a').source, 'seat');
  for (const input of [
    { workspace: 'south/ops', seat_id: 'seat-a' }, { seat_id: 'seat-b' },
    { workspace: 'north/ops/extra' }, { org: 'north', workspace: 'south/ops' },
    { workspace: 'north/ops', entity: { kind: 'signal' as const, id: 'root-b' } },
    { workspace: 'north/ops', entity: { kind: 'file' as const, id: 'file-b' } },
    { workspace: 'north/ops', channel: 'general', entity: { kind: 'signal' as const, id: 'unfiled' } },
  ]) assert.equal(resolve(s, agent(), input).ok, false);
  assert.equal(resolve(s, c, { seat_id: 'seat-a' }).ok, false);
  const revokedSeat = { ...s, seats: s.seats.map((seat) => ({ ...seat, revoked_at: 1 })) };
  assert.equal(resolve(revokedSeat, agent(), { seat_id: 'seat-a' }).ok, false);
  selected(s, c, { workspace: 'north/ops', entity: { kind: 'signal', id: 'reply-a' } }, 'a');
  selected(s, c, { workspace: 'north/ops', entity: { kind: 'file', id: 'public-file' } }, 'a');
  const removedCurrent = { ...s, workspaceMemberships: s.workspaceMemberships.filter((m) => m.workspace_id !== 'a') };
  assert.equal(resolve(removedCurrent, c).ok, false);
  selected(removedCurrent, c, { workspace: 'south/ops' }, 'b');
});

test('ambiguity and denials reveal only permitted choices; inaccessible and missing targets match', () => {
  const s = fixture(), c = user('owner');
  const result = resolve(s, c, { workspace: 'ops' });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected ambiguous permitted workspaces');
  assert.equal(result.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
  assert.deepEqual(result.refusal.choices?.map((choice) => choice.selector), ['north/ops', 'south/ops']);
  assert.equal(resolve(s, user('admin'), { workspace: 'ops' }).ok, true);
  const compare: Array<[OrgWorkspaceChannelSelector, OrgWorkspaceChannelSelector]> = [
    [{ org: 'hidden-org' }, { org: 'missing-org' }],
    [{ workspace: 'north/hidden-budget' }, { workspace: 'north/missing-workspace' }],
    [{ workspace: 'north/ops', channel: 'hidden-private' }, { workspace: 'north/ops', channel: 'missing-channel' }],
    [{ workspace: 'north/ops', entity: { kind: 'signal', id: 'private-root' } },
      { workspace: 'north/ops', entity: { kind: 'signal', id: 'missing-signal' } }],
    [{ seat_id: 'seat-b' }, { seat_id: 'missing-seat' }],
  ];
  for (const [hidden, missing] of compare) {
    const caller = hidden.seat_id ? agent() : c;
    const denied = resolve(s, caller, hidden);
    assert.equal(denied.ok, false);
    assert.deepEqual(denied, resolve(s, caller, missing));
  }
  const deniedDiscovery = resolve(s, user('outsider'), {});
  assert.equal(deniedDiscovery.ok, false);
  if (!deniedDiscovery.ok) assert.equal(deniedDiscovery.refusal.choices, undefined);
});

test('a wrong-workspace binding for the same file ID fails closed instead of becoming unbound', () => {
  const s = fixture();
  for (const c of [user('owner'), agent()]) {
    assert.equal(canReadWorkspace(s, c, 'a'), true);
    for (const fileId of ['unbound', 'public-file']) {
      assert.equal(canReadChannelBoundFile(s, c, fileId, 'a'), true);
      const malformed = { ...s, fileChannelBindings: [...s.fileChannelBindings,
        { file_id: fileId, workspace_id: 'b', channel_id: 'general-b' }] };
      assert.equal(canReadChannelBoundFile(malformed, c, fileId, 'a'), false);
      assert.deepEqual(resolve(malformed, c, { workspace: 'a', entity: { kind: 'file', id: fileId } }), {
        ok: false, refusal: { code: 'ENTITY_ACCESS_DENIED', remedy_url: 'https://commonswarm.com/app' },
      });
    }
    assert.equal(canReadChannelBoundFile(s, c, 'missing-file', 'a'), false);
  }
});

test('org aliases refuse duplicate slugs and ID collisions with only readable workspace choices', () => {
  const s = fixture(), c = user('owner', 'a');
  for (const northSlug of ['north', 'headquarters']) {
    const duplicate = { ...s, organizations: s.organizations.map((o) => ({ ...o,
      slug: o.id === 'north' ? northSlug : o.id === 'south' ? 'NORTH' : o.slug })) };
    const expected = { ok: false, refusal: { code: 'AMBIGUOUS_ORG_SELECTOR',
      remedy_url: 'https://commonswarm.com/app', choices: [
        { org_id: 'north', org_slug: northSlug, workspace_id: 'a', workspace_slug: 'ops', selector: `${northSlug}/ops` },
        { org_id: 'south', org_slug: 'NORTH', workspace_id: 'b', workspace_slug: 'ops', selector: 'NORTH/ops' },
      ] } };
    for (const input of [{ org: 'north', workspace: 'ops' }, { workspace: 'north/ops' },
      { org: 'south', workspace: 'north/ops' }]) {
      assert.deepEqual(resolve(duplicate, c, input), expected);
      assert.deepEqual(resolve({ ...duplicate, organizations: [...duplicate.organizations].reverse() }, c, input), expected);
    }
    selected(duplicate, c, { org: 'south', workspace: 'ops' }, 'b');
    selected(duplicate, c, { workspace: 'a' }, 'a');
    const hiddenCollision = { ...duplicate, organizations: duplicate.organizations.map((o) =>
      o.id === 'vault' ? { ...o, slug: 'NORTH' } : o) };
    assert.deepEqual(resolve(hiddenCollision, c, { org: 'north' }), expected);
  }
  const hiddenOnly = { ...s, organizations: s.organizations.map((o) =>
    o.id === 'vault' ? { ...o, slug: 'NORTH' } : o) };
  assert.deepEqual(resolve(hiddenOnly, c, { workspace: 'north/ops' }), resolve(s, c, { workspace: 'north/ops' }));
  selected(s, c, { workspace: 'south/ops' }, 'b');
  assert.equal(resolve(s, c, { org: 'north', workspace: 'south/ops' }).ok, false);
});

test('channel aliases refuse readable duplicates and ID collisions without hidden or sibling choices', () => {
  const s = fixture(), c = user('owner');
  for (const alias of ['GENERAL', 'general-a']) {
    const duplicate = { ...s, channels: [...s.channels,
      { channel_id: 'updates-a', workspace_id: 'a', slug: alias, visibility: 'workspace' as const, archived_at: null }] };
    const token = alias === 'GENERAL' ? '#general' : 'general-a';
    const input = { workspace: 'a', channel: token };
    const expected = { ok: false, refusal: { code: 'AMBIGUOUS_CHANNEL_SELECTOR',
      remedy_url: 'https://commonswarm.com/app', choices: [
        { org_id: 'north', org_slug: 'north', workspace_id: 'a', workspace_slug: 'ops', selector: 'north/ops',
          channel_id: 'general-a', channel_slug: 'general' },
        { org_id: 'north', org_slug: 'north', workspace_id: 'a', workspace_slug: 'ops', selector: 'north/ops',
          channel_id: 'updates-a', channel_slug: alias },
      ] } };
    assert.deepEqual(resolve(duplicate, c, input), expected);
    const reversed = resolve({ ...duplicate, channels: [...duplicate.channels].reverse() }, c, input);
    assert.equal(reversed.ok, false);
    if (reversed.ok) throw new Error('Expected ambiguous channels in either order');
    assert.equal(reversed.refusal.code, 'AMBIGUOUS_CHANNEL_SELECTOR');
    assert.deepEqual(reversed.refusal.choices, [...expected.refusal.choices].reverse());
    assert.equal(selected(duplicate, c, { workspace: 'a', channel: 'updates-a' }, 'a').channel?.channel_id, 'updates-a');
    const hiddenCollision = { ...duplicate, channels: duplicate.channels.map((ch) =>
      ch.channel_id === 'private-a' || ch.channel_id === 'general-b' ? { ...ch, slug: alias } : ch) };
    assert.deepEqual(resolve(hiddenCollision, c, input), expected);
    assert.deepEqual(resolve(hiddenCollision, c, { workspace: 'a', channel: 'private-a' }),
      resolve(hiddenCollision, c, { workspace: 'a', channel: 'missing-channel' }));
    if (alias === 'GENERAL') assert.deepEqual(resolve(duplicate, c, { workspace: 'a' }), expected);
    // Existing filing still wins over an ambiguous default; no retargeting.
    assert.equal(selected(duplicate, c, { workspace: 'a', entity: { kind: 'signal', id: 'unfiled' } }, 'a').channel, null);
  }
  const hiddenOnly = { ...s, channels: s.channels.map((ch) =>
    ch.channel_id === 'private-a' || ch.channel_id === 'general-b' ? { ...ch, slug: 'GENERAL' } : ch) };
  assert.deepEqual(resolve(hiddenOnly, c, { workspace: 'a', channel: 'general' }),
    resolve(s, c, { workspace: 'a', channel: 'general' }));
});

test('explicit file context requires its existing binding to the requested readable channel', () => {
  const original = fixture();
  const s = { ...original, channels: [...original.channels,
    { channel_id: 'updates-a', workspace_id: 'a', slug: 'updates', visibility: 'workspace' as const, archived_at: null }] };
  const before = structuredClone(s);
  for (const c of [user('owner'), agent()]) {
    for (const id of ['public-file', 'unbound']) {
      assert.equal(selected(s, c, { workspace: 'a', entity: { kind: 'file', id } }, 'a').channel, null);
    }
    assert.equal(selected(s, c, { workspace: 'a', channel: 'general',
      entity: { kind: 'file', id: 'public-file' } }, 'a').channel?.channel_id, 'general-a');
    selected(s, c, { workspace: 'a', channel: 'updates' }, 'a'); // Target itself is readable.
    for (const [id, channel] of [['unbound', 'general'], ['public-file', 'updates']] as const) {
      assert.deepEqual(resolve(s, c, { workspace: 'a', channel, entity: { kind: 'file', id } }), {
        ok: false, refusal: { code: 'ENTITY_ACCESS_DENIED', remedy_url: 'https://commonswarm.com/app' },
      });
    }
    assert.equal(resolve(s, c, { workspace: 'a', channel: 'general-b',
      entity: { kind: 'file', id: 'public-file' } }).ok, false);
    const rebound = { ...s, fileChannelBindings: [...s.fileChannelBindings,
      { file_id: 'public-file', workspace_id: 'a', channel_id: 'updates-a' }] };
    assert.equal(selected(rebound, c, { workspace: 'a', channel: 'updates',
      entity: { kind: 'file', id: 'public-file' } }, 'a').channel?.channel_id, 'updates-a');
  }
  assert.deepEqual(s, before);
});
