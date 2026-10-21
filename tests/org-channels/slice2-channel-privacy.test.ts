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
  | 'owner' | 'admin' | 'member' | 'guest' | 'non-member'
  | 'removed-member' | 'org-admin-non-member' | 'multi-org-agent' | 'workspace-removed-agent';

const eq = assert.equal;
const ws = 'ws-1a';
const priv = 'ch-priv';
const u = (principal_id: string): CallerContext => ({ principal_kind: 'user', principal_id });
const a = (principal_id: string, owner_user_id = 'u-owner'): CallerContext => ({
  principal_kind: 'agent', principal_id, owner_user_id,
});
const wc = <T extends Record<string, unknown> = Record<string, never>>(channel_id: string, extra?: T) => ({
  workspace_id: ws, channel_id, ...(extra ?? ({} as T)),
});
const w = <T extends Record<string, unknown> = Record<string, never>>(extra?: T) => ({
  workspace_id: ws, ...(extra ?? ({} as T)),
});

function ref(res: { ok: boolean; refusal?: { code: string; cli_command: string } }, code: string) {
  eq(res.ok, false);
  eq(res.refusal?.code, code);
}

function buildMatrixFixture() {
  const now = '2026-10-21T00:00:00Z';
  const orgRows: Array<[string, PrincipalKind, string, OrgRole]> = [
    ...(['u-owner:owner', 'u-admin-in:admin', 'u-member-in:member', 'u-guest:guest', 'u-non-member:member', 'u-removed:member', 'u-org-admin-out:owner'] as const).map((x) => {
      const [id, r] = x.split(':') as [string, OrgRole];
      return ['org-1', 'user', id, r] as [string, PrincipalKind, string, OrgRole];
    }),
    ['org-1', 'agent', 'ag-multi', 'member'], ['org-2', 'user', 'u-owner', 'owner'],
    ['org-2', 'agent', 'ag-multi', 'member'], ['org-1', 'agent', 'ag-removed', 'member'],
    ['org-2', 'agent', 'ag-removed', 'member'],
  ];
  const wsRows: Array<[string, string, PrincipalKind, string, OrgRole]> = [
    ...(['u-owner:owner', 'u-admin-in:admin', 'u-member-in:member', 'u-non-member:member', 'u-removed:member', 'u-org-admin-out:owner'] as const).map((x) => {
      const [id, r] = x.split(':') as [string, OrgRole];
      return [ws, 'org-1', 'user', id, r] as [string, string, PrincipalKind, string, OrgRole];
    }),
    [ws, 'org-1', 'agent', 'ag-multi', 'member'], ['ws-2a', 'org-2', 'agent', 'ag-multi', 'member'],
    [ws, 'org-1', 'agent', 'ag-removed', 'member'], ['ws-2a', 'org-2', 'agent', 'ag-removed', 'member'],
  ];
  const chRows: Array<[PrincipalKind, string, ChannelRole, string?]> = [
    ['user', 'u-owner', 'owner'], ['user', 'u-admin-in', 'member'],
    ['user', 'u-member-in', 'member'], ['user', 'u-removed', 'member', '2026-10-21T01:00:00Z'],
    ['agent', 'ag-multi', 'member'], ['agent', 'ag-removed', 'member'],
  ];

  const state: OrgChannelAuthorityState = {
    privateChannelsEnabled: true,
    organizations: [
      { id: 'org-1', slug: 'yulan', display_name: 'Yulan', created_by: 'u-owner', created_at: now, updated_at: now },
      { id: 'org-2', slug: 'household', display_name: 'Household', created_by: 'u-owner', created_at: now, updated_at: now },
    ],
    workspaces: [
      { workspace_id: ws, org_id: 'org-1', slug: 'ops', name: 'Operations' },
      { workspace_id: 'ws-2a', org_id: 'org-2', slug: 'home', name: 'Home' },
    ],
    channels: [
      wc('ch-pub', { org_id: 'org-1', slug: 'general', visibility: 'workspace' as const, join_policy: 'open' as const }),
      wc(priv, { org_id: 'org-1', slug: 'sec-incident', visibility: 'private' as const, join_policy: 'invite_only' as const, topic: 'Confidential' }),
    ],
    agentIdentities: [
      { id: 'ag-multi', owner_user_id: 'u-owner', display_name: 'Argon Multi', created_at: now },
      { id: 'ag-removed', owner_user_id: 'u-owner', display_name: 'Argon Removed', created_at: now },
    ],
    orgMemberships: orgRows.map(([org_id, principal_kind, principal_id, role]) => ({ org_id, principal_kind, principal_id, role, created_at: now })),
    workspaceGrants: wsRows.map(([workspace_id, org_id, principal_kind, principal_id, role]) => ({ workspace_id, org_id, principal_kind, principal_id, role, created_at: now })),
    agentPrincipals: [
      ['ap-multi-1a', ws, 'ag-multi'], ['ap-multi-2a', 'ws-2a', 'ag-multi'],
      ['ap-rem-1a', ws, 'ag-removed'], ['ap-rem-2a', 'ws-2a', 'ag-removed'],
    ].map(([p, w, ag]) => ({ principal_id: p!, workspace_id: w!, agent_identity_id: ag!, owner_user_id: 'u-owner', name: ag! })),
    channelMemberships: chRows.map(([principal_kind, principal_id, role, revoked_at]) => wc(priv, {
      principal_kind, principal_id, role, notify_pref: 'all' as const, joined_at: now, ...(revoked_at ? { revoked_at } : {}),
    })),
    fileChannelBindings: [
      wc(priv, { file_id: 'file-priv-1', bound_by_kind: 'user' as const, bound_by: 'u-owner', created_at: now }),
      wc('ch-pub', { file_id: 'file-pub-1', bound_by_kind: 'user' as const, bound_by: 'u-owner', created_at: now }),
    ],
    seats: [
      ['seat-multi-1a', ws, 'ap-multi-1a', 'ag-multi'], ['seat-multi-2a', 'ws-2a', 'ap-multi-2a', 'ag-multi'],
      ['seat-rem-1a', ws, 'ap-rem-1a', 'ag-removed'], ['seat-rem-2a', 'ws-2a', 'ap-rem-2a', 'ag-removed'],
    ].map(([s, w, p, ag]) => ({ seat_id: s!, workspace_id: w!, principal_id: p!, agent_identity_id: ag! })),
  };

  cascadeWorkspaceMemberRemoval(state, { workspace_id: ws, principal_kind: 'agent', principal_id: 'ag-removed', now: '2026-10-21T01:05:00Z' });

  const mkSig = (
    signal_id: string, channel_id: string | null, thread_root_id: string | null,
    author_id: string, signal_kind: 'note' | 'ask', body: string,
    mentions: ch.SignalMention[] = [], attachment_file_ids: string[] = [],
  ): ch.ChannelSignalRecord => ({
    signal_id, workspace_id: ws, channel_id, thread_root_id,
    author_kind: 'user', author_id, signal_kind, body, mentions, attachment_file_ids, created_at: now,
  });

  const signals: ch.ChannelSignalRecord[] = [
    mkSig('sig-pub-1', 'ch-pub', null, 'u-owner', 'note', 'Public roadmap update', [], ['file-pub-1']),
    mkSig('sig-priv-root', priv, null, 'u-owner', 'ask', 'Secret key rotation plan alpha-7', [u('u-member-in'), u('u-non-member')], ['file-priv-1']),
    mkSig('sig-priv-reply', priv, 'sig-priv-root', 'u-admin-in', 'note', 'Completed alpha-7 rotation'),
  ];
  state.signals = [...signals];

  const files: ch.ChannelFileRecord[] = [
    { file_id: 'file-pub-1', workspace_id: ws, name: 'roadmap-alpha-7.md', content_type: 'text/markdown', size_bytes: 1024 },
    { file_id: 'file-priv-1', workspace_id: ws, name: 'incident-alpha-7-keys.txt', content_type: 'text/plain', size_bytes: 2048 },
    { file_id: 'file-unbound-1', workspace_id: ws, name: 'handbook.md', content_type: 'text/markdown', size_bytes: 512 },
  ];

  const principals: Record<RoleKey, CallerContext> = {
    owner: u('u-owner'), admin: u('u-admin-in'), member: u('u-member-in'),
    guest: u('u-guest'), 'non-member': u('u-non-member'), 'removed-member': u('u-removed'),
    'org-admin-non-member': u('u-org-admin-out'), 'multi-org-agent': a('ag-multi'),
    'workspace-removed-agent': a('ag-removed'),
  };

  return { state, principals, signals, files };
}

const ALLOWED = new Set<RoleKey>(['owner', 'admin', 'member', 'multi-org-agent']);

test('9-principal leak matrix across direct reads/writes, thread replies, file URLs, search, unread, catch-up, wakes/inbox, permalinks, exports', () => {
  const { state: s, principals, signals, files } = buildMatrixFixture();
  eq(s.seats?.find((x) => x.seat_id === 'seat-rem-1a')?.revoked_at != null, true);
  eq(s.seats?.find((x) => x.seat_id === 'seat-rem-2a')?.revoked_at ?? null, null);

  for (const [roleKey, c] of Object.entries(principals) as [RoleKey, CallerContext][]) {
    const ok = ALLOWED.has(roleKey);
    eq(ch.channel_get(s, c, wc(priv)).ok, ok);
    const listRes = ch.channel_list(s, c, w());
    eq(listRes.ok ? listRes.channels.some((x) => x.channel_id === priv) : false, ok);
    eq(ch.channel_list_members(s, c, wc(priv)).ok, ok);
    eq(ch.readChannelSignals(s, c, wc(priv, { signals })).ok, ok);
    eq(ch.postChannelSignal(s, c, wc(priv, { body: `probe ${roleKey}`, existing_signals: signals })).ok, ok);

    const selfJoin = ch.channel_join(s, c, wc(priv));
    eq(selfJoin.ok, ok);
    if (!selfJoin.ok) {
      assert.ok(selfJoin.refusal.code === 'CHANNEL_ACCESS_DENIED' || selfJoin.refusal.code === 'WORKSPACE_ACCESS_DENIED');
      assert.ok(selfJoin.refusal.remedy_url.includes('/app') && selfJoin.refusal.cli_command.length > 0);
    }

    eq(ch.readThreadSignals(s, c, w({ thread_id: 'sig-priv-root', signals })).ok, ok);
    eq(ch.postChannelSignal(s, c, w({ thread_id: 'sig-priv-root', signal_kind: 'note' as const, body: `reply ${roleKey}`, existing_signals: signals })).ok, ok);
    eq(ch.authorizeFileDownloadUrl(s, c, w({ file_id: 'file-priv-1' })).ok, ok);
    eq(ch.filterWorkspaceFiles(s, c, ws, files).some((f) => f.file_id === 'file-priv-1'), ok);

    const sr = ch.searchWorkspaceContent(s, c, w({ query: 'alpha-7', signals, files }));
    if (sr.ok) {
      eq(sr.signal_hits.some((x) => x.channel_id === priv), ok);
      eq(sr.file_hits.some((f) => f.file_id === 'file-priv-1'), ok);
      eq(priv in sr.by_channel_count, ok);
      eq(sr.total_count, ok ? 4 : 1);
    } else eq(ok, false);

    const ur = ch.computeUnreadCounts(s, c, w({ signals }));
    eq(ur.ok ? priv in ur.by_channel : false, ok);

    const cu = ch.buildCatchUpSummary(s, c, w({ signals }));
    if (cu.ok) {
      eq(cu.needs_you_signals.some((x) => x.channel_id === priv), ok);
      eq(cu.active_channel_slugs.includes('sec-incident'), ok);
    } else eq(ok, false);

    eq(ch.resolvePermalink(s, c, w({ signal_id: 'sig-priv-root', signals })).ok, ok);
    eq(ch.resolvePermalink(s, c, w({ file_id: 'file-priv-1', files })).ok, ok);

    const pv = ch.scrubLinkPreviews(s, c, [
      wc(priv, { target_kind: 'signal' as const, signal_id: 'sig-priv-root', title: 'Secret', snippet: 'alpha-7', author: 'u-owner', channel_slug: 'sec-incident' }),
    ]);
    eq(pv[0]?.redacted, !ok);
    if (!ok) eq(pv[0]?.snippet, null);

    const ex = ch.exportWorkspaceData(s, c, w({ signals, files }));
    if (ex.ok) {
      eq(ex.channels.some((x) => x.channel_id === priv), ok);
      eq(ex.signals.some((x) => x.channel_id === priv), ok);
      eq(ex.files.some((f) => f.file_id === 'file-priv-1'), ok);
    } else eq(ok, false);
  }
});

test('wakes, inbox delivery filtering, @mention of non-member in private channel, and post-enqueue revocation', () => {
  const { state: s, principals: p, signals } = buildMatrixFixture();
  const postRes = ch.postChannelSignal(s, p.owner, wc(priv, {
    signal_id: 'sig-priv-mention-probe',
    signal_kind: 'ask' as const,
    body: 'Hey @non-member and @org-admin-non-member check this secret',
    mentions: [u('u-non-member'), u('u-org-admin-out'), u('u-member-in'), a('ag-multi')],
    existing_signals: signals,
    candidate_recipients: Object.values(p),
  }));
  eq(postRes.ok, true);
  if (!postRes.ok) return;

  assert.deepEqual(
    postRes.deliveries.map((d) => `${d.recipient_kind}:${d.recipient_id}`).sort(),
    ['agent:ag-multi', 'user:u-admin-in', 'user:u-member-in'],
  );

  eq(ch.channel_remove_member(s, p.owner, wc(priv, u('u-member-in'))).ok, true);
  eq(ch.filterInboxItems(s, p.member, postRes.deliveries).length, 0);
  eq(ch.filterWakeEvents(s, p.member, postRes.wakes).length, 0);

  const memberDel = postRes.deliveries.find((d) => d.recipient_id === 'u-member-in')!;
  ref(ch.canAckInboxItem(s, p.member, memberDel), 'CHANNEL_ACCESS_DENIED');

  const agentDel = postRes.deliveries.find((d) => d.recipient_id === 'ag-multi')!;
  ref(ch.canAckInboxItem(s, p['multi-org-agent'], agentDel, 'seat-multi-2a'), 'WORKSPACE_SEAT_MISMATCH');
});

test('channel owner invite rules, public->private history guard, private->public block, and PRIVATE_CHANNELS_ENABLED=false fail-closed gate', () => {
  const { state: s, principals: p, signals, files } = buildMatrixFixture();

  ref(ch.channel_add_member(s, p.member, wc(priv, u('u-non-member'))), 'PRIVATE_CHANNEL_OWNER_REQUIRED');
  ref(ch.channel_add_member(s, p['org-admin-non-member'], wc(priv, u('u-org-admin-out'))), 'CHANNEL_ACCESS_DENIED');
  ref(ch.channel_add_member(s, p.owner, wc(priv, u('u-guest'))), 'TARGET_MISSING_WORKSPACE_GRANT');
  ref(ch.bindFileToChannel(s, p.owner, wc('ch-pub', { file_id: 'file-priv-1' })), 'PRIVATE_FILE_CANNOT_BECOME_PUBLIC');

  eq(ch.channel_create(s, p.owner, wc('ch-roadmap', { slug: 'roadmap', visibility: 'workspace' as const })).ok, true);

  const flipNonEmpty = ch.channel_set_visibility(s, p.owner, wc('ch-roadmap', { visibility: 'private' as const, signal_count: 1 }));
  ref(flipNonEmpty, 'CHANNEL_HAS_PUBLIC_HISTORY');
  if (!flipNonEmpty.ok) assert.ok(flipNonEmpty.refusal.cli_command.includes('cswarm channel archive'));

  eq(ch.channel_set_visibility(s, p.owner, wc('ch-roadmap', { visibility: 'private' as const, signal_count: 0, bound_file_count: 0 })).ok, true);
  ref(ch.channel_set_visibility(s, p.owner, wc(priv, { visibility: 'workspace' as const })), 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');

  eq(ch.channel_set_topic(s, p.owner, wc('ch-roadmap', { topic: 'Updated' })).ok, true);
  eq(ch.channel_rename(s, p.owner, wc('ch-roadmap', { slug: 'roadmap-v2' })).ok, true);
  eq(ch.channel_leave(s, p.member, wc(priv)).ok, true);
  eq(ch.channel_archive(s, p.owner, wc('ch-roadmap')).ok, true);

  eq(ch.channel_set_notify_pref(s, p.admin, wc(priv, { notify_pref: 'mute' as const })).ok, true);
  const mutedUnreads = ch.computeUnreadCounts(s, p.admin, w({ signals }));
  eq(mutedUnreads.ok && mutedUnreads.by_channel[priv]?.unread_count, 0);

  s.privateChannelsEnabled = false;
  ref(ch.dispatchChannelCommand(s, p.owner, w({ kind: 'channel_create' as const, slug: 'new-secret', visibility: 'private' as const })), 'PRIVATE_CHANNELS_DISABLED');
  ref(ch.channel_get(s, p.owner, wc(priv)), 'PRIVATE_CHANNELS_DISABLED');
  const ownerListDisabled = ch.channel_list(s, p.owner, w());
  eq(ownerListDisabled.ok && ownerListDisabled.channels.some((c) => c.visibility === 'private'), false);
  ref(ch.authorizeFileDownloadUrl(s, p.owner, w({ file_id: 'file-priv-1' })), 'PRIVATE_CHANNELS_DISABLED');

  const exp = ch.exportWorkspaceData(s, p.owner, w({ signals, files }));
  eq(exp.ok, true);
  if (exp.ok) {
    eq(exp.channels.some((c) => c.channel_id === priv), false);
    eq(exp.signals.some((x) => x.channel_id === priv), false);
    eq(exp.files.some((f) => f.file_id === 'file-priv-1'), false);
  }
});

test('regression guards: omitted flag, guest self-join, authoritative history counts, owner-only private agent removal, and omitted-channel preview redaction', () => {
  const { state: s, principals: p } = buildMatrixFixture();
  const now = '2026-10-21T02:00:00Z';

  eq(ch.channel_create(s, p.owner, wc('ch-empty', { slug: 'empty-pub', visibility: 'workspace' as const })).ok, true);
  delete s.privateChannelsEnabled;
  ref(ch.channel_create(s, p.owner, w({ slug: 'omitted-priv', visibility: 'private' as const })), 'PRIVATE_CHANNELS_DISABLED');
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-empty', { visibility: 'private' as const })), 'PRIVATE_CHANNELS_DISABLED');
  s.privateChannelsEnabled = true;

  s.workspaceGrants.push(w({ org_id: 'org-1', ...u('u-guest'), role: 'guest' as const, created_at: now }));
  eq(ch.channel_create(s, p.owner, wc('ch-open', { slug: 'open-lobby', visibility: 'workspace' as const })).ok, true);
  ref(ch.channel_join(s, p.guest, wc('ch-open')), 'CHANNEL_INVITE_REQUIRED');
  ref(ch.channel_get(s, p.guest, wc('ch-open')), 'CHANNEL_ACCESS_DENIED');
  eq(ch.channel_add_member(s, p.owner, wc('ch-open', u('u-guest'))).ok, true);
  eq(ch.channel_join(s, p.guest, wc('ch-open', { notify_pref: 'mentions' as const })).ok, true);

  eq(ch.bindFileToChannel(s, p.owner, wc('ch-open', { file_id: 'file-unbound-1' })).ok, true);
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-open', { visibility: 'private' as const, signal_count: 0, bound_file_count: 0 })), 'CHANNEL_HAS_PUBLIC_HISTORY');
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-pub', { visibility: 'private' as const, signal_count: 0, bound_file_count: 0 })), 'CHANNEL_HAS_PUBLIC_HISTORY');

  s.agentIdentities.push({ id: 'ag-mem-own', owner_user_id: 'u-member-in', display_name: 'Mem Agent', created_at: now });
  s.workspaceGrants.push(w({ org_id: 'org-1', ...a('ag-mem-own', 'u-member-in'), role: 'member' as const, created_at: now }));
  eq(ch.channel_add_member(s, p.owner, wc(priv, a('ag-mem-own', 'u-member-in'))).ok, true);
  ref(ch.channel_remove_member(s, p.member, wc(priv, a('ag-mem-own', 'u-member-in'))), 'PRIVATE_CHANNEL_OWNER_REQUIRED');
  eq(ch.channel_remove_member(s, p.owner, wc(priv, a('ag-mem-own', 'u-member-in'))).ok, true);

  const scrubbed = ch.scrubLinkPreviews(s, p['non-member'], [
    w({ target_kind: 'signal' as const, signal_id: 'sig-priv-root', title: 'Secret', snippet: 'alpha-7', author: 'u-owner', author_name: 'Owner', channel_slug: 'sec-incident', channel_name: 'sec-incident' }),
    wc('ch-pub', { target_kind: 'signal' as const, signal_id: 'sig-priv-root', title: 'Forged', snippet: 'alpha-7', author_name: 'Owner', channel_name: 'general' }),
    w({ target_kind: 'signal' as const, title: 'Unresolved', snippet: 'mystery' }),
  ]);
  for (const item of scrubbed) {
    eq(item.redacted, true);
    eq(item.title ?? item.snippet ?? item.author ?? item.author_name ?? item.channel_slug ?? item.channel_name, null);
  }
  const ownerPreview = ch.scrubLinkPreviews(s, p.owner, [
    w({ target_kind: 'signal' as const, signal_id: 'sig-priv-root', title: 'Secret', snippet: 'alpha-7', author_name: 'Owner', channel_name: 'sec-incident' }),
  ]);
  eq(ownerPreview[0]?.redacted, false);
  eq(ownerPreview[0]?.channel_id, priv);
});
