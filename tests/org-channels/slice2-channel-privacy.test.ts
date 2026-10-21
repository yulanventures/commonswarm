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
  const orgRows = [
    ...(['u-owner:owner', 'u-admin-in:admin', 'u-member-in:member', 'u-guest:guest', 'u-non-member:member', 'u-removed:member', 'u-org-admin-out:owner'] as const).map((x) => `org-1:user:${x}`),
    'org-1:agent:ag-multi:member', 'org-2:user:u-owner:owner', 'org-2:agent:ag-multi:member',
    'org-1:agent:ag-removed:member', 'org-2:agent:ag-removed:member',
  ];
  const wsRows = [
    ...(['u-owner:owner', 'u-admin-in:admin', 'u-member-in:member', 'u-non-member:member', 'u-removed:member', 'u-org-admin-out:owner'] as const).map((x) => `${ws}:org-1:user:${x}`),
    `${ws}:org-1:agent:ag-multi:member`, 'ws-2a:org-2:agent:ag-multi:member',
    `${ws}:org-1:agent:ag-removed:member`, 'ws-2a:org-2:agent:ag-removed:member',
  ];
  const chRows: Array<[PrincipalKind, string, ChannelRole, string?]> = [
    ['user', 'u-owner', 'owner'], ['user', 'u-admin-in', 'member'],
    ['user', 'u-member-in', 'member'], ['user', 'u-removed', 'member', '2026-10-21T01:00:00Z'],
    ['agent', 'ag-multi', 'member'], ['agent', 'ag-removed', 'member'],
  ];

  const state: OrgChannelAuthorityState = {
    privateChannelsEnabled: true,
    organizations: (['org-1:yulan:Yulan', 'org-2:household:Household'] as const).map((x) => {
      const [id, slug, display_name] = x.split(':') as [string, string, string];
      return { id, slug, display_name, created_by: 'u-owner', created_at: now, updated_at: now };
    }),
    workspaces: [
      { workspace_id: ws, org_id: 'org-1', slug: 'ops', name: 'Operations' },
      { workspace_id: 'ws-2a', org_id: 'org-2', slug: 'home', name: 'Home' },
    ],
    channels: [
      wc('ch-pub', { org_id: 'org-1', slug: 'general', visibility: 'workspace' as const, join_policy: 'open' as const }),
      wc(priv, { org_id: 'org-1', slug: 'sec-incident', visibility: 'private' as const, join_policy: 'invite_only' as const, topic: 'Confidential' }),
    ],
    agentIdentities: (['ag-multi:Argon Multi', 'ag-removed:Argon Removed'] as const).map((x) => {
      const [id, display_name] = x.split(':') as [string, string];
      return { id, owner_user_id: 'u-owner', display_name, created_at: now };
    }),
    orgMemberships: orgRows.map((x) => {
      const [org_id, principal_kind, principal_id, role] = x.split(':') as [string, PrincipalKind, string, OrgRole];
      return { org_id, principal_kind, principal_id, role, created_at: now };
    }),
    workspaceGrants: wsRows.map((x) => {
      const [workspace_id, org_id, principal_kind, principal_id, role] = x.split(':') as [string, string, PrincipalKind, string, OrgRole];
      return { workspace_id, org_id, principal_kind, principal_id, role, created_at: now };
    }),
    agentPrincipals: [`ap-multi-1a:${ws}:ag-multi`, 'ap-multi-2a:ws-2a:ag-multi', `ap-rem-1a:${ws}:ag-removed`, 'ap-rem-2a:ws-2a:ag-removed'].map((x) => {
      const [principal_id, workspace_id, agent_identity_id] = x.split(':') as [string, string, string];
      return { principal_id, workspace_id, agent_identity_id, owner_user_id: 'u-owner', name: agent_identity_id };
    }),
    channelMemberships: chRows.map(([principal_kind, principal_id, role, revoked_at]) => wc(priv, {
      principal_kind, principal_id, role, notify_pref: 'all' as const, joined_at: now, ...(revoked_at ? { revoked_at } : {}),
    })),
    fileChannelBindings: [
      wc(priv, { file_id: 'file-priv-1', bound_by_kind: 'user' as const, bound_by: 'u-owner', created_at: now }),
      wc('ch-pub', { file_id: 'file-pub-1', bound_by_kind: 'user' as const, bound_by: 'u-owner', created_at: now }),
    ],
    seats: [`seat-multi-1a:${ws}:ap-multi-1a:ag-multi`, 'seat-multi-2a:ws-2a:ap-multi-2a:ag-multi', `seat-rem-1a:${ws}:ap-rem-1a:ag-removed`, 'seat-rem-2a:ws-2a:ap-rem-2a:ag-removed'].map((x) => {
      const [seat_id, workspace_id, principal_id, agent_identity_id] = x.split(':') as [string, string, string, string];
      return { seat_id, workspace_id, principal_id, agent_identity_id };
    }),
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

  return {
    state,
    signals,

    files: (['file-pub-1:roadmap-alpha-7.md:text/markdown:1024', 'file-priv-1:incident-alpha-7-keys.txt:text/plain:2048', 'file-unbound-1:handbook.md:text/markdown:512'] as const).map((x) => {
      const [file_id, name, content_type, sz] = x.split(':') as [string, string, string, string];
      return { file_id, workspace_id: ws, name, content_type, size_bytes: Number(sz) };
    }),
    principals: {
      owner: u('u-owner'), admin: u('u-admin-in'), member: u('u-member-in'),
      guest: u('u-guest'), 'non-member': u('u-non-member'), 'removed-member': u('u-removed'),
      'org-admin-non-member': u('u-org-admin-out'), 'multi-org-agent': a('ag-multi'),
      'workspace-removed-agent': a('ag-removed'),
    } satisfies Record<RoleKey, CallerContext>,
  };
}

const ALLOWED = new Set<RoleKey>(['owner', 'admin', 'member', 'multi-org-agent']);

test('9-principal leak matrix', () => {
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
    eq(ch.postChannelSignal(s, c, wc(priv, { body: `p ${roleKey}`, existing_signals: signals })).ok, ok);

    const selfJoin = ch.channel_join(s, c, wc(priv));
    eq(selfJoin.ok, ok);
    if (!selfJoin.ok) {
      assert.ok(selfJoin.refusal.code === 'CHANNEL_ACCESS_DENIED' || selfJoin.refusal.code === 'WORKSPACE_ACCESS_DENIED');
      assert.ok(selfJoin.refusal.remedy_url.includes('/app') && selfJoin.refusal.cli_command.length > 0);
    }

    eq(ch.readThreadSignals(s, c, w({ thread_id: 'sig-priv-root', signals })).ok, ok);
    eq(ch.postChannelSignal(s, c, w({ thread_id: 'sig-priv-root', signal_kind: 'note' as const, body: `r ${roleKey}`, existing_signals: signals })).ok, ok);
    eq(ch.authorizeFileDownloadUrl(s, c, w({ file_id: 'file-priv-1' })).ok, ok);
    eq(ch.filterWorkspaceFiles(s, c, ws, files).some((f) => f.file_id === 'file-priv-1'), ok);

    const sr = ch.searchWorkspaceContent(s, c, w({ query: 'alpha-7', signals, files }));
    if (sr.ok) {
      eq(sr.signal_hits.some((x) => x.channel_id === priv) && sr.file_hits.some((f) => f.file_id === 'file-priv-1') && priv in sr.by_channel_count, ok);
      eq(sr.total_count, ok ? 4 : 1);
    } else eq(ok, false);

    const ur = ch.computeUnreadCounts(s, c, w({ signals }));
    eq(ur.ok ? priv in ur.by_channel : false, ok);

    const cu = ch.buildCatchUpSummary(s, c, w({ signals }));
    if (cu.ok) {
      eq(cu.needs_you_signals.some((x) => x.channel_id === priv) && cu.active_channel_slugs.includes('sec-incident'), ok);
    } else eq(ok, false);

    eq(ch.resolvePermalink(s, c, w({ signal_id: 'sig-priv-root', signals })).ok, ok);
    eq(ch.resolvePermalink(s, c, w({ file_id: 'file-priv-1', files })).ok, ok);

    const pv = ch.scrubLinkPreviews(s, c, [
      wc(priv, { target_kind: 'signal' as const, signal_id: 'sig-priv-root', title: 'S', snippet: 'alpha-7', author: 'u-owner', channel_slug: 'sec-incident' }),
    ]);
    eq(pv[0]?.redacted, !ok);
    if (!ok) eq(pv[0]?.snippet, null);

    const ex = ch.exportWorkspaceData(s, c, w({ signals, files }));
    if (ex.ok) {
      eq(ex.channels.some((x) => x.channel_id === priv) && ex.signals.some((x) => x.channel_id === priv) && ex.files.some((f) => f.file_id === 'file-priv-1'), ok);
    } else eq(ok, false);
  }
});

test('wakes, inbox filtering, @mention of non-member, and revocation', () => {
  const { state: s, principals: p, signals } = buildMatrixFixture();
  const postRes = ch.postChannelSignal(s, p.owner, wc(priv, {
    signal_id: 'sig-priv-mention-probe',
    signal_kind: 'ask',
    body: 'secret',
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
  eq(ch.filterInboxItems(s, p.member, postRes.deliveries).length + ch.filterWakeEvents(s, p.member, postRes.wakes).length, 0);

  ref(ch.canAckInboxItem(s, p.member, postRes.deliveries.find((d) => d.recipient_id === 'u-member-in')!), 'CHANNEL_ACCESS_DENIED');
  ref(ch.canAckInboxItem(s, p['multi-org-agent'], postRes.deliveries.find((d) => d.recipient_id === 'ag-multi')!, 'seat-multi-2a'), 'WORKSPACE_SEAT_MISMATCH');
});

test('channel owner invite, visibility guards, and flag gate', () => {
  const { state: s, principals: p, signals, files } = buildMatrixFixture();

  ref(ch.channel_add_member(s, p.member, wc(priv, u('u-non-member'))), 'PRIVATE_CHANNEL_OWNER_REQUIRED');
  ref(ch.channel_add_member(s, p['org-admin-non-member'], wc(priv, u('u-org-admin-out'))), 'CHANNEL_ACCESS_DENIED');
  ref(ch.channel_add_member(s, p.owner, wc(priv, u('u-guest'))), 'TARGET_MISSING_WORKSPACE_GRANT');
  ref(ch.bindFileToChannel(s, p.owner, wc('ch-pub', { file_id: 'file-priv-1' })), 'PRIVATE_FILE_CANNOT_BECOME_PUBLIC');

  eq(ch.channel_create(s, p.owner, wc('ch-roadmap', { slug: 'roadmap', visibility: 'workspace' })).ok, true);

  const flipNonEmpty = ch.channel_set_visibility(s, p.owner, wc('ch-roadmap', { visibility: 'private', signal_count: 1 }));
  ref(flipNonEmpty, 'CHANNEL_HAS_PUBLIC_HISTORY');
  if (!flipNonEmpty.ok) assert.ok(flipNonEmpty.refusal.cli_command.includes('cswarm channel archive'));

  eq(ch.channel_set_visibility(s, p.owner, wc('ch-roadmap', { visibility: 'private', signal_count: 0, bound_file_count: 0 })).ok, true);
  ref(ch.channel_set_visibility(s, p.owner, wc(priv, { visibility: 'workspace' })), 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');

  eq(ch.channel_set_topic(s, p.owner, wc('ch-roadmap', { topic: 'Updated' })).ok, true);
  eq(ch.channel_rename(s, p.owner, wc('ch-roadmap', { slug: 'roadmap-v2' })).ok, true);
  eq(ch.channel_leave(s, p.member, wc(priv)).ok, true);
  eq(ch.channel_archive(s, p.owner, wc('ch-roadmap')).ok, true);
  const archList = ch.channel_list(s, p.owner, w({ include_archived: true }));
  eq(archList.ok && archList.channels.some((c) => c.channel_id === 'ch-roadmap'), true);

  eq(ch.channel_set_notify_pref(s, p.admin, wc(priv, { notify_pref: 'mute' })).ok, true);
  const mutedUnreads = ch.computeUnreadCounts(s, p.admin, w({ signals }));
  eq(mutedUnreads.ok && mutedUnreads.by_channel[priv]?.unread_count, 0);

  s.privateChannelsEnabled = false;
  ref(ch.dispatchChannelCommand(s, p.owner, w({ kind: 'channel_create', slug: 'new-secret', visibility: 'private' })), 'PRIVATE_CHANNELS_DISABLED');
  ref(ch.channel_get(s, p.owner, wc(priv)), 'PRIVATE_CHANNELS_DISABLED');
  const ownerListDisabled = ch.channel_list(s, p.owner, w());
  eq(ownerListDisabled.ok && ownerListDisabled.channels.some((c) => c.visibility === 'private'), false);
  ref(ch.authorizeFileDownloadUrl(s, p.owner, w({ file_id: 'file-priv-1' })), 'PRIVATE_CHANNELS_DISABLED');

  const exp = ch.exportWorkspaceData(s, p.owner, w({ signals, files }));
  eq(exp.ok && !exp.channels.some((c) => c.channel_id === priv) && !exp.signals.some((x) => x.channel_id === priv) && !exp.files.some((f) => f.file_id === 'file-priv-1'), true);
});

test('regression guards', () => {
  const { state: s, principals: p } = buildMatrixFixture();
  const now = '2026-10-21T02:00:00Z';

  eq(ch.channel_create(s, p.owner, wc('ch-empty', { slug: 'empty-pub', visibility: 'workspace' })).ok, true);
  delete s.privateChannelsEnabled;
  ref(ch.channel_create(s, p.owner, w({ slug: 'omitted-priv', visibility: 'private' })), 'PRIVATE_CHANNELS_DISABLED');
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-empty', { visibility: 'private' })), 'PRIVATE_CHANNELS_DISABLED');
  s.privateChannelsEnabled = true;

  s.workspaceGrants.push(w({ org_id: 'org-1', ...u('u-guest'), role: 'guest', created_at: now }));
  eq(ch.channel_create(s, p.owner, wc('ch-open', { slug: 'open-lobby', visibility: 'workspace' })).ok, true);
  ref(ch.channel_join(s, p.guest, wc('ch-open')), 'CHANNEL_INVITE_REQUIRED');
  ref(ch.channel_get(s, p.guest, wc('ch-open')), 'CHANNEL_ACCESS_DENIED');
  eq(ch.channel_add_member(s, p.owner, wc('ch-open', u('u-guest'))).ok, true);
  eq(ch.channel_join(s, p.guest, wc('ch-open', { notify_pref: 'mentions' })).ok, true);

  eq(ch.bindFileToChannel(s, p.owner, wc('ch-open', { file_id: 'file-unbound-1' })).ok, true);
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-open', { visibility: 'private', signal_count: 0, bound_file_count: 0 })), 'CHANNEL_HAS_PUBLIC_HISTORY');
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-pub', { visibility: 'private', signal_count: 0, bound_file_count: 0 })), 'CHANNEL_HAS_PUBLIC_HISTORY');

  s.agentIdentities.push({ id: 'ag-mem-own', owner_user_id: 'u-member-in', display_name: 'Mem Agent', created_at: now });
  s.workspaceGrants.push(w({ org_id: 'org-1', ...a('ag-mem-own', 'u-member-in'), role: 'member', created_at: now }));
  eq(ch.channel_add_member(s, p.owner, wc(priv, a('ag-mem-own', 'u-member-in'))).ok, true);
  ref(ch.channel_remove_member(s, p.member, wc(priv, a('ag-mem-own', 'u-member-in'))), 'PRIVATE_CHANNEL_OWNER_REQUIRED');
  eq(ch.channel_remove_member(s, p.owner, wc(priv, a('ag-mem-own', 'u-member-in'))).ok, true);

  const scrubbed = ch.scrubLinkPreviews(s, p['non-member'], [
    w({ target_kind: 'signal', signal_id: 'sig-priv-root', title: 'S', snippet: 'a', author: 'u-owner', author_name: 'O', channel_slug: 'sec-incident', channel_name: 'sec-incident' }),
    wc('ch-pub', { target_kind: 'signal', signal_id: 'sig-priv-root', title: 'F', snippet: 'a', author_name: 'O', channel_name: 'general' }),
    w({ target_kind: 'file', file_id: 'file-priv-1', signal_id: 'sig-pub-1', title: 'SF', snippet: 'a', author_name: 'O', channel_name: 'general' }),
    w({ target_kind: 'signal', title: 'U', snippet: 'm' }),
  ]);
  for (const item of scrubbed) {
    eq(item.redacted && (item.title ?? item.snippet ?? item.author ?? item.author_name ?? item.channel_slug ?? item.channel_name) === null, true);
  }
  const ownerPreview = ch.scrubLinkPreviews(s, p.owner, [
    w({ target_kind: 'signal', signal_id: 'sig-priv-root', title: 'S', snippet: 'a', author_name: 'O', channel_name: 'sec-incident' }),
  ]);
  eq(ownerPreview[0]?.redacted === false && ownerPreview[0]?.channel_id === priv, true);

  const dp = ch.postChannelSignal(s, p['non-member'], wc(priv, { body: 'probe' }));
  ref(dp, 'CHANNEL_ACCESS_DENIED');
  if (!dp.ok) eq(dp.refusal.scope.channel ?? (dp.refusal.cli_command.includes('sec-incident') ? 'leak' : null), null);

  ref(ch.postChannelSignal(s, p['non-member'], w({ thread_id: 'sig-pub-1', in_reply_to: 'sig-priv-root', body: 'm' })), 'CHANNEL_ACCESS_DENIED');
  ref(ch.postChannelSignal(s, p.owner, w({ thread_id: 'sig-pub-1', in_reply_to: 'sig-priv-root', body: 'x' })), 'THREAD_CHANNEL_MISMATCH');
  ref(ch.channel_add_member(s, p.owner, wc(priv, { ...u('u-owner'), role: 'member' })), 'CANNOT_REMOVE_LAST_CHANNEL_OWNER');
});
