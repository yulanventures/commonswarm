import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type CallerContext,
  type ChannelRole,
  type OrgChannelAuthorityState,
  type OrgRole,
  type PrincipalKind,
  cascadeWorkspaceMemberRemoval,
} from '../../src/protocol/org-channels-contract.js';
import * as ch from '../../supabase/functions/command/channels/index.js';

type RoleKey =
  | 'owner'
  | 'admin'
  | 'member'
  | 'guest'
  | 'non-member'
  | 'removed-member'
  | 'org-admin-non-member'
  | 'multi-org-agent'
  | 'workspace-removed-agent';

function expectRefusal(res: { ok: boolean; refusal?: { code: string; cli_command: string } }, code: string) {
  assert.equal(res.ok, false);
  assert.equal(res.refusal?.code, code);
}

function buildMatrixFixture() {
  const now = '2026-10-21T00:00:00Z';
  const orgRows: Array<[string, PrincipalKind, string, OrgRole]> = [
    ['org-1', 'user', 'u-owner', 'owner'],
    ['org-1', 'user', 'u-admin-in', 'admin'],
    ['org-1', 'user', 'u-member-in', 'member'],
    ['org-1', 'user', 'u-guest', 'guest'],
    ['org-1', 'user', 'u-non-member', 'member'],
    ['org-1', 'user', 'u-removed', 'member'],
    ['org-1', 'user', 'u-org-admin-out', 'owner'],
    ['org-1', 'agent', 'ag-multi', 'member'],
    ['org-2', 'user', 'u-owner', 'owner'],
    ['org-2', 'agent', 'ag-multi', 'member'],
    ['org-1', 'agent', 'ag-removed', 'member'],
    ['org-2', 'agent', 'ag-removed', 'member'],
  ];
  const wsRows: Array<[string, string, PrincipalKind, string, OrgRole]> = [
    ['ws-1a', 'org-1', 'user', 'u-owner', 'owner'],
    ['ws-1a', 'org-1', 'user', 'u-admin-in', 'admin'],
    ['ws-1a', 'org-1', 'user', 'u-member-in', 'member'],
    ['ws-1a', 'org-1', 'user', 'u-non-member', 'member'],
    ['ws-1a', 'org-1', 'user', 'u-removed', 'member'],
    ['ws-1a', 'org-1', 'user', 'u-org-admin-out', 'owner'],
    ['ws-1a', 'org-1', 'agent', 'ag-multi', 'member'],
    ['ws-2a', 'org-2', 'agent', 'ag-multi', 'member'],
    ['ws-1a', 'org-1', 'agent', 'ag-removed', 'member'],
    ['ws-2a', 'org-2', 'agent', 'ag-removed', 'member'],
  ];
  const chRows: Array<[PrincipalKind, string, ChannelRole, string?]> = [
    ['user', 'u-owner', 'owner'],
    ['user', 'u-admin-in', 'member'],
    ['user', 'u-member-in', 'member'],
    ['user', 'u-removed', 'member', '2026-10-21T01:00:00Z'],
    ['agent', 'ag-multi', 'member'],
    ['agent', 'ag-removed', 'member'],
  ];

  const state: OrgChannelAuthorityState = {
    privateChannelsEnabled: true,
    organizations: [
      { id: 'org-1', slug: 'yulan', display_name: 'Yulan', created_by: 'u-owner', created_at: now, updated_at: now },
      { id: 'org-2', slug: 'household', display_name: 'Household', created_by: 'u-owner', created_at: now, updated_at: now },
    ],
    workspaces: [
      { workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: 'Operations' },
      { workspace_id: 'ws-2a', org_id: 'org-2', slug: 'home', name: 'Home' },
    ],
    channels: [
      { channel_id: 'ch-pub', workspace_id: 'ws-1a', org_id: 'org-1', slug: 'general', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-priv', workspace_id: 'ws-1a', org_id: 'org-1', slug: 'sec-incident', visibility: 'private', join_policy: 'invite_only', topic: 'Confidential' },
    ],
    agentIdentities: [
      { id: 'ag-multi', owner_user_id: 'u-owner', display_name: 'Argon Multi', created_at: now },
      { id: 'ag-removed', owner_user_id: 'u-owner', display_name: 'Argon Removed', created_at: now },
    ],
    orgMemberships: orgRows.map(([org_id, principal_kind, principal_id, role]) => ({
      org_id,
      principal_kind,
      principal_id,
      role,
      created_at: now,
    })),
    workspaceGrants: wsRows.map(([workspace_id, org_id, principal_kind, principal_id, role]) => ({
      workspace_id,
      org_id,
      principal_kind,
      principal_id,
      role,
      created_at: now,
    })),
    agentPrincipals: [
      ['ap-multi-1a', 'ws-1a', 'ag-multi'],
      ['ap-multi-2a', 'ws-2a', 'ag-multi'],
      ['ap-rem-1a', 'ws-1a', 'ag-removed'],
      ['ap-rem-2a', 'ws-2a', 'ag-removed'],
    ].map(([p, w, ag]) => ({
      principal_id: p!,
      workspace_id: w!,
      agent_identity_id: ag!,
      owner_user_id: 'u-owner',
      name: ag!,
    })),
    channelMemberships: chRows.map(([principal_kind, principal_id, role, revoked_at]) => ({
      channel_id: 'ch-priv',
      workspace_id: 'ws-1a',
      principal_kind,
      principal_id,
      role,
      notify_pref: 'all',
      joined_at: now,
      ...(revoked_at ? { revoked_at } : {}),
    })),
    fileChannelBindings: [
      { file_id: 'file-priv-1', workspace_id: 'ws-1a', channel_id: 'ch-priv', bound_by_kind: 'user', bound_by: 'u-owner', created_at: now },
      { file_id: 'file-pub-1', workspace_id: 'ws-1a', channel_id: 'ch-pub', bound_by_kind: 'user', bound_by: 'u-owner', created_at: now },
    ],
    seats: [
      ['seat-multi-1a', 'ws-1a', 'ap-multi-1a', 'ag-multi'],
      ['seat-multi-2a', 'ws-2a', 'ap-multi-2a', 'ag-multi'],
      ['seat-rem-1a', 'ws-1a', 'ap-rem-1a', 'ag-removed'],
      ['seat-rem-2a', 'ws-2a', 'ap-rem-2a', 'ag-removed'],
    ].map(([s, w, p, ag]) => ({
      seat_id: s!,
      workspace_id: w!,
      principal_id: p!,
      agent_identity_id: ag!,
    })),
  };

  cascadeWorkspaceMemberRemoval(state, {
    workspace_id: 'ws-1a',
    principal_kind: 'agent',
    principal_id: 'ag-removed',
    now: '2026-10-21T01:05:00Z',
  });

  const mkSig = (
    signal_id: string,
    channel_id: string | null,
    thread_root_id: string | null,
    author_id: string,
    signal_kind: 'note' | 'ask',
    body: string,
    mentions: ch.SignalMention[] = [],
    attachment_file_ids: string[] = [],
  ): ch.ChannelSignalRecord => ({
    signal_id,
    workspace_id: 'ws-1a',
    channel_id,
    thread_root_id,
    author_kind: 'user',
    author_id,
    signal_kind,
    body,
    mentions,
    attachment_file_ids,
    created_at: now,
  });

  const signals: ch.ChannelSignalRecord[] = [
    mkSig('sig-pub-1', 'ch-pub', null, 'u-owner', 'note', 'Public roadmap update', [], ['file-pub-1']),
    mkSig(
      'sig-priv-root',
      'ch-priv',
      null,
      'u-owner',
      'ask',
      'Secret key rotation plan alpha-7',
      [
        { principal_kind: 'user', principal_id: 'u-member-in' },
        { principal_kind: 'user', principal_id: 'u-non-member' },
      ],
      ['file-priv-1'],
    ),
    mkSig('sig-priv-reply', 'ch-priv', 'sig-priv-root', 'u-admin-in', 'note', 'Completed alpha-7 rotation'),
  ];

  const files: ch.ChannelFileRecord[] = [
    { file_id: 'file-pub-1', workspace_id: 'ws-1a', name: 'roadmap-alpha-7.md', content_type: 'text/markdown', size_bytes: 1024 },
    { file_id: 'file-priv-1', workspace_id: 'ws-1a', name: 'incident-alpha-7-keys.txt', content_type: 'text/plain', size_bytes: 2048 },
    { file_id: 'file-unbound-1', workspace_id: 'ws-1a', name: 'handbook.md', content_type: 'text/markdown', size_bytes: 512 },
  ];

  const u = (principal_id: string): CallerContext => ({ principal_kind: 'user', principal_id });
  const a = (principal_id: string): CallerContext => ({
    principal_kind: 'agent',
    principal_id,
    owner_user_id: 'u-owner',
  });
  const principals: Record<RoleKey, CallerContext> = {
    owner: u('u-owner'),
    admin: u('u-admin-in'),
    member: u('u-member-in'),
    guest: u('u-guest'),
    'non-member': u('u-non-member'),
    'removed-member': u('u-removed'),
    'org-admin-non-member': u('u-org-admin-out'),
    'multi-org-agent': a('ag-multi'),
    'workspace-removed-agent': a('ag-removed'),
  };

  return { state, principals, signals, files };
}

const ALLOWED = new Set<RoleKey>(['owner', 'admin', 'member', 'multi-org-agent']);

test('9-principal leak matrix across direct reads, writes, thread_id replies, file URLs, search, unread, catch-up, wakes/inbox, permalinks, and exports', () => {
  const { state, principals, signals, files } = buildMatrixFixture();
  assert.equal(state.seats?.find((x) => x.seat_id === 'seat-rem-1a')?.revoked_at != null, true);
  assert.equal(state.seats?.find((x) => x.seat_id === 'seat-rem-2a')?.revoked_at ?? null, null);

  for (const [roleKey, caller] of Object.entries(principals) as [RoleKey, CallerContext][]) {
    const ok = ALLOWED.has(roleKey);
    const ws = 'ws-1a';
    const priv = 'ch-priv';

    assert.equal(ch.channel_get(state, caller, { workspace_id: ws, channel_id: priv }).ok, ok);
    const listRes = ch.channel_list(state, caller, { workspace_id: ws });
    assert.equal(listRes.ok ? listRes.channels.some((c) => c.channel_id === priv) : false, ok);
    assert.equal(ch.channel_list_members(state, caller, { workspace_id: ws, channel_id: priv }).ok, ok);
    assert.equal(ch.readChannelSignals(state, caller, { workspace_id: ws, channel_id: priv, signals }).ok, ok);
    assert.equal(ch.postChannelSignal(state, caller, { workspace_id: ws, channel_id: priv, body: `probe ${roleKey}`, existing_signals: signals }).ok, ok);

    const selfJoin = ch.channel_join(state, caller, { workspace_id: ws, channel_id: priv });
    assert.equal(selfJoin.ok, ok);
    if (!selfJoin.ok) {
      assert.ok(selfJoin.refusal.code === 'CHANNEL_ACCESS_DENIED' || selfJoin.refusal.code === 'WORKSPACE_ACCESS_DENIED');
      assert.ok(selfJoin.refusal.remedy_url.includes('/app'));
      assert.ok(selfJoin.refusal.cli_command.length > 0);
    }

    assert.equal(ch.readThreadSignals(state, caller, { workspace_id: ws, thread_id: 'sig-priv-root', signals }).ok, ok);
    assert.equal(ch.postChannelSignal(state, caller, { workspace_id: ws, thread_id: 'sig-priv-root', signal_kind: 'note', body: `reply ${roleKey}`, existing_signals: signals }).ok, ok);
    assert.equal(ch.authorizeFileDownloadUrl(state, caller, { workspace_id: ws, file_id: 'file-priv-1' }).ok, ok);
    assert.equal(ch.filterWorkspaceFiles(state, caller, ws, files).some((f) => f.file_id === 'file-priv-1'), ok);

    const searchRes = ch.searchWorkspaceContent(state, caller, { workspace_id: ws, query: 'alpha-7', signals, files });
    if (searchRes.ok) {
      assert.equal(searchRes.signal_hits.some((s) => s.channel_id === priv), ok);
      assert.equal(searchRes.file_hits.some((f) => f.file_id === 'file-priv-1'), ok);
      assert.equal(priv in searchRes.by_channel_count, ok);
      assert.equal(searchRes.total_count, ok ? 4 : 1);
    } else assert.equal(ok, false);

    const unreadRes = ch.computeUnreadCounts(state, caller, { workspace_id: ws, signals });
    assert.equal(unreadRes.ok ? priv in unreadRes.by_channel : false, ok);

    const catchUpRes = ch.buildCatchUpSummary(state, caller, { workspace_id: ws, signals });
    if (catchUpRes.ok) {
      assert.equal(catchUpRes.needs_you_signals.some((s) => s.channel_id === priv), ok);
      assert.equal(catchUpRes.active_channel_slugs.includes('sec-incident'), ok);
    } else assert.equal(ok, false);

    assert.equal(ch.resolvePermalink(state, caller, { workspace_id: ws, signal_id: 'sig-priv-root', signals }).ok, ok);
    assert.equal(ch.resolvePermalink(state, caller, { workspace_id: ws, file_id: 'file-priv-1', files }).ok, ok);

    const previews = ch.scrubLinkPreviews(state, caller, [
      { target_kind: 'signal', workspace_id: ws, channel_id: priv, signal_id: 'sig-priv-root', title: 'Secret', snippet: 'alpha-7', author: 'u-owner', channel_slug: 'sec-incident' },
    ]);
    assert.equal(previews[0]?.redacted, !ok);
    if (!ok) assert.equal(previews[0]?.snippet, null);

    const exportRes = ch.exportWorkspaceData(state, caller, { workspace_id: ws, signals, files });
    if (exportRes.ok) {
      assert.equal(exportRes.channels.some((c) => c.channel_id === priv), ok);
      assert.equal(exportRes.signals.some((s) => s.channel_id === priv), ok);
      assert.equal(exportRes.files.some((f) => f.file_id === 'file-priv-1'), ok);
    } else assert.equal(ok, false);
  }
});

test('wakes, inbox delivery filtering, @mention of non-member in private channel, and post-enqueue revocation', () => {
  const { state, principals, signals } = buildMatrixFixture();
  const postRes = ch.postChannelSignal(state, principals.owner, {
    signal_id: 'sig-priv-mention-probe',
    workspace_id: 'ws-1a',
    channel_id: 'ch-priv',
    signal_kind: 'ask',
    body: 'Hey @non-member and @org-admin-non-member check this secret',
    mentions: [
      { principal_kind: 'user', principal_id: 'u-non-member' },
      { principal_kind: 'user', principal_id: 'u-org-admin-out' },
      { principal_kind: 'user', principal_id: 'u-member-in' },
      { principal_kind: 'agent', principal_id: 'ag-multi' },
    ],
    existing_signals: signals,
    candidate_recipients: Object.values(principals),
  });
  assert.equal(postRes.ok, true);
  if (!postRes.ok) return;

  assert.deepEqual(
    postRes.deliveries.map((d) => `${d.recipient_kind}:${d.recipient_id}`).sort(),
    ['agent:ag-multi', 'user:u-admin-in', 'user:u-member-in'],
  );

  assert.equal(ch.channel_remove_member(state, principals.owner, { workspace_id: 'ws-1a', channel_id: 'ch-priv', principal_kind: 'user', principal_id: 'u-member-in' }).ok, true);
  assert.equal(ch.filterInboxItems(state, principals.member, postRes.deliveries).length, 0);
  assert.equal(ch.filterWakeEvents(state, principals.member, postRes.wakes).length, 0);

  const memberDel = postRes.deliveries.find((d) => d.recipient_id === 'u-member-in')!;
  expectRefusal(ch.canAckInboxItem(state, principals.member, memberDel), 'CHANNEL_ACCESS_DENIED');

  const agentDel = postRes.deliveries.find((d) => d.recipient_id === 'ag-multi')!;
  expectRefusal(ch.canAckInboxItem(state, principals['multi-org-agent'], agentDel, 'seat-multi-2a'), 'WORKSPACE_SEAT_MISMATCH');
});

test('channel owner invite rules, public->private history guard, private->public block, and PRIVATE_CHANNELS_ENABLED=false fail-closed gate', () => {
  const { state, principals, signals, files } = buildMatrixFixture();
  const ws = 'ws-1a';

  expectRefusal(
    ch.channel_add_member(state, principals.member, { workspace_id: ws, channel_id: 'ch-priv', principal_kind: 'user', principal_id: 'u-non-member' }),
    'PRIVATE_CHANNEL_OWNER_REQUIRED',
  );
  expectRefusal(
    ch.channel_add_member(state, principals['org-admin-non-member'], { workspace_id: ws, channel_id: 'ch-priv', principal_kind: 'user', principal_id: 'u-org-admin-out' }),
    'CHANNEL_ACCESS_DENIED',
  );
  expectRefusal(
    ch.channel_add_member(state, principals.owner, { workspace_id: ws, channel_id: 'ch-priv', principal_kind: 'user', principal_id: 'u-guest' }),
    'TARGET_MISSING_WORKSPACE_GRANT',
  );
  expectRefusal(
    ch.bindFileToChannel(state, principals.owner, { file_id: 'file-priv-1', workspace_id: ws, channel_id: 'ch-pub' }),
    'PRIVATE_FILE_CANNOT_BECOME_PUBLIC',
  );

  assert.equal(ch.channel_create(state, principals.owner, { workspace_id: ws, channel_id: 'ch-roadmap', slug: 'roadmap', visibility: 'workspace' }).ok, true);

  const flipNonEmpty = ch.channel_set_visibility(state, principals.owner, { workspace_id: ws, channel_id: 'ch-roadmap', visibility: 'private', signal_count: 1 });
  expectRefusal(flipNonEmpty, 'CHANNEL_HAS_PUBLIC_HISTORY');
  if (!flipNonEmpty.ok) assert.ok(flipNonEmpty.refusal.cli_command.includes('cswarm channel archive'));

  assert.equal(ch.channel_set_visibility(state, principals.owner, { workspace_id: ws, channel_id: 'ch-roadmap', visibility: 'private', signal_count: 0, bound_file_count: 0 }).ok, true);
  expectRefusal(
    ch.channel_set_visibility(state, principals.owner, { workspace_id: ws, channel_id: 'ch-priv', visibility: 'workspace' }),
    'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC',
  );

  assert.equal(ch.channel_set_topic(state, principals.owner, { workspace_id: ws, channel_id: 'ch-roadmap', topic: 'Updated' }).ok, true);
  assert.equal(ch.channel_rename(state, principals.owner, { workspace_id: ws, channel_id: 'ch-roadmap', slug: 'roadmap-v2' }).ok, true);
  assert.equal(ch.channel_leave(state, principals.member, { workspace_id: ws, channel_id: 'ch-priv' }).ok, true);
  assert.equal(ch.channel_archive(state, principals.owner, { workspace_id: ws, channel_id: 'ch-roadmap' }).ok, true);

  assert.equal(ch.channel_set_notify_pref(state, principals.admin, { workspace_id: ws, channel_id: 'ch-priv', notify_pref: 'mute' }).ok, true);
  const mutedUnreads = ch.computeUnreadCounts(state, principals.admin, { workspace_id: ws, signals });
  assert.equal(mutedUnreads.ok && mutedUnreads.by_channel['ch-priv']?.unread_count, 0);

  state.privateChannelsEnabled = false;
  expectRefusal(
    ch.dispatchChannelCommand(state, principals.owner, { kind: 'channel_create', workspace_id: ws, slug: 'new-secret', visibility: 'private' }),
    'PRIVATE_CHANNELS_DISABLED',
  );
  expectRefusal(ch.channel_get(state, principals.owner, { workspace_id: ws, channel_id: 'ch-priv' }), 'PRIVATE_CHANNELS_DISABLED');
  const ownerListDisabled = ch.channel_list(state, principals.owner, { workspace_id: ws });
  assert.equal(ownerListDisabled.ok && ownerListDisabled.channels.some((c) => c.visibility === 'private'), false);
  expectRefusal(ch.authorizeFileDownloadUrl(state, principals.owner, { workspace_id: ws, file_id: 'file-priv-1' }), 'PRIVATE_CHANNELS_DISABLED');

  const ownerExportDisabled = ch.exportWorkspaceData(state, principals.owner, { workspace_id: ws, signals, files });
  assert.equal(ownerExportDisabled.ok, true);
  if (ownerExportDisabled.ok) {
    assert.equal(ownerExportDisabled.channels.some((c) => c.channel_id === 'ch-priv'), false);
    assert.equal(ownerExportDisabled.signals.some((s) => s.channel_id === 'ch-priv'), false);
    assert.equal(ownerExportDisabled.files.some((f) => f.file_id === 'file-priv-1'), false);
  }
});
