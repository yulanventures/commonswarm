import test from 'node:test';
import assert from 'node:assert/strict';
import { type CallerContext, type ChannelRole, type OrgChannelAuthorityState, type OrgRole, type PrincipalKind, cascadeWorkspaceMemberRemoval } from '../../src/protocol/org-channels-contract.js';
import * as ch from '../../supabase/functions/command/channels/index.js';

type RoleKey = 'owner' | 'admin' | 'member' | 'guest' | 'non-member' | 'removed-member' | 'org-admin-non-member' | 'multi-org-agent' | 'workspace-removed-agent';
const eq = assert.equal, ws = 'ws-1a', priv = 'ch-priv', now = '2026-10-21T00:00:00Z';
const u = (principal_id: string): CallerContext => ({ principal_kind: 'user', principal_id });
const a = (principal_id: string, owner_user_id = 'u-owner'): CallerContext => ({ principal_kind: 'agent', principal_id, owner_user_id });
const wc = <T extends Record<string, unknown> = Record<string, never>>(channel_id: string, extra?: T) => ({ workspace_id: ws, channel_id, ...(extra ?? ({} as T)) });
const w = <T extends Record<string, unknown> = Record<string, never>>(extra?: T) => ({ workspace_id: ws, ...(extra ?? ({} as T)) });
const ref = (res: { ok: boolean; refusal?: { code: string; cli_command: string } }, code: string) => { eq(res.ok, false); eq(res.refusal?.code, code); };

function buildMatrixFixture() {
  const uRoles = ['u-owner:owner', 'u-admin-in:admin', 'u-member-in:member', 'u-non-member:member', 'u-removed:member', 'u-org-admin-out:owner'] as const;
  const orgRows = [...uRoles.concat('u-guest:guest' as any).map((x) => `org-1:user:${x}`), 'org-1:agent:ag-multi:member', 'org-2:user:u-owner:owner', 'org-2:agent:ag-multi:member', 'org-1:agent:ag-removed:member', 'org-2:agent:ag-removed:member'];
  const wsRows = [...uRoles.map((x) => `${ws}:org-1:user:${x}`), `${ws}:org-1:agent:ag-multi:member`, 'ws-2a:org-2:agent:ag-multi:member', `${ws}:org-1:agent:ag-removed:member`, 'ws-2a:org-2:agent:ag-removed:member'];
  const chRows: Array<[PrincipalKind, string, ChannelRole, string?]> = [['user', 'u-owner', 'owner'], ['user', 'u-admin-in', 'member'], ['user', 'u-member-in', 'member'], ['user', 'u-removed', 'member', '2026-10-21T01:00:00Z'], ['agent', 'ag-multi', 'member'], ['agent', 'ag-removed', 'member']];
  const sp = <T extends string[]>(x: string) => x.split(':') as unknown as T;
  const apRows = [`ap-multi-1a:${ws}:ag-multi`, 'ap-multi-2a:ws-2a:ag-multi', `ap-rem-1a:${ws}:ag-removed`, 'ap-rem-2a:ws-2a:ag-removed'];
  const state: OrgChannelAuthorityState = {
    privateChannelsEnabled: true,
    organizations: ['org-1:yulan:Yulan', 'org-2:household:Household'].map((x) => { const [id, slug, display_name] = sp<[string, string, string]>(x); return { id, slug, display_name, created_by: 'u-owner', created_at: now, updated_at: now }; }),
    workspaces: [{ workspace_id: ws, org_id: 'org-1', slug: 'ops', name: 'Ops' }, { workspace_id: 'ws-2a', org_id: 'org-2', slug: 'home', name: 'Home' }],
    channels: [wc('ch-pub', { org_id: 'org-1', slug: 'general', visibility: 'workspace' as const, join_policy: 'open' as const }), wc(priv, { org_id: 'org-1', slug: 'sec-incident', visibility: 'private' as const, join_policy: 'invite_only' as const, topic: 'Confidential' })],
    agentIdentities: ['ag-multi:Argon Multi', 'ag-removed:Argon Rem'].map((x) => { const [id, display_name] = sp<[string, string]>(x); return { id, owner_user_id: 'u-owner', display_name, created_at: now }; }),
    orgMemberships: orgRows.map((x) => { const [org_id, principal_kind, principal_id, role] = sp<[string, PrincipalKind, string, OrgRole]>(x); return { org_id, principal_kind, principal_id, role, created_at: now }; }),
    workspaceGrants: wsRows.map((x) => { const [workspace_id, org_id, principal_kind, principal_id, role] = sp<[string, string, PrincipalKind, string, OrgRole]>(x); return { workspace_id, org_id, principal_kind, principal_id, role, created_at: now }; }),
    agentPrincipals: apRows.map((x) => { const [principal_id, workspace_id, agent_identity_id] = sp<[string, string, string]>(x); return { principal_id, workspace_id, agent_identity_id, owner_user_id: 'u-owner', name: agent_identity_id }; }),
    channelMemberships: chRows.map(([principal_kind, principal_id, role, revoked_at]) => wc(priv, { principal_kind, principal_id, role, notify_pref: 'all' as const, joined_at: now, ...(revoked_at ? { revoked_at } : {}) })),
    fileChannelBindings: [wc(priv, { file_id: 'file-priv-1', bound_by_kind: 'user' as const, bound_by: 'u-owner', created_at: now }), wc('ch-pub', { file_id: 'file-pub-1', bound_by_kind: 'user' as const, bound_by: 'u-owner', created_at: now })],
    seats: apRows.map((x) => { const [principal_id, workspace_id, agent_identity_id] = sp<[string, string, string]>(x); return { seat_id: principal_id.replace('ap-', 'seat-'), workspace_id, principal_id, agent_identity_id }; }),
  };
  cascadeWorkspaceMemberRemoval(state, w({ principal_kind: 'agent', principal_id: 'ag-removed', now: '2026-10-21T01:05:00Z' }));
  const mkSig = (signal_id: string, channel_id: string | null, thread_root_id: string | null, author_id: string, signal_kind: 'note' | 'ask', body: string, mentions: ch.SignalMention[] = [], attachment_file_ids: string[] = []): ch.ChannelSignalRecord => ({ signal_id, workspace_id: ws, channel_id, thread_root_id, author_kind: 'user', author_id, signal_kind, body, mentions, attachment_file_ids, created_at: now });
  const signals = [
    mkSig('sig-pub-1', 'ch-pub', null, 'u-owner', 'note', 'Public roadmap update', [], ['file-pub-1']),
    mkSig('sig-priv-root', priv, null, 'u-owner', 'ask', 'Secret key rotation plan alpha-7', [u('u-member-in'), u('u-non-member')], ['file-priv-1']),
    mkSig('sig-priv-reply', priv, 'sig-priv-root', 'u-admin-in', 'note', 'Completed alpha-7 rotation'),
  ];
  state.signals = [...signals];
  return {
    state, signals,
    files: ['file-pub-1:roadmap-alpha-7.md:text/markdown:1024', 'file-priv-1:incident-alpha-7-keys.txt:text/plain:2048', 'file-unbound-1:handbook.md:text/markdown:512'].map((x) => { const [file_id, name, content_type, sz] = sp<[string, string, string, string]>(x); return { file_id, workspace_id: ws, name, content_type, size_bytes: Number(sz) }; }),
    principals: { owner: u('u-owner'), admin: u('u-admin-in'), member: u('u-member-in'), guest: u('u-guest'), 'non-member': u('u-non-member'), 'removed-member': u('u-removed'), 'org-admin-non-member': u('u-org-admin-out'), 'multi-org-agent': a('ag-multi'), 'workspace-removed-agent': a('ag-removed') } as Record<RoleKey, CallerContext>,
  };
}

const ALLOWED = new Set<RoleKey>(['owner', 'admin', 'member', 'multi-org-agent']);
const ok = (r: { ok: boolean }) => eq(r.ok, true);

test('9-principal leak matrix', () => {
  const { state: s, principals, signals, files } = buildMatrixFixture();
  eq(s.seats?.find((x) => x.seat_id === 'seat-rem-1a')?.revoked_at != null, true);
  eq(s.seats?.find((x) => x.seat_id === 'seat-rem-2a')?.revoked_at ?? null, null);
  for (const [k, c] of Object.entries(principals) as [RoleKey, CallerContext][]) {
    const al = ALLOWED.has(k), lr = ch.channel_list(s, c, w()), sj = ch.channel_join(s, c, wc(priv));
    for (const r of [ch.channel_get(s, c, wc(priv)), ch.channel_list_members(s, c, wc(priv)), ch.readChannelSignals(s, c, wc(priv, { signals })), ch.postChannelSignal(s, c, wc(priv, { body: `p ${k}`, existing_signals: signals })), sj, ch.readThreadSignals(s, c, w({ thread_id: 'sig-priv-root', signals })), ch.postChannelSignal(s, c, w({ thread_id: 'sig-priv-root', signal_kind: 'note' as const, body: `r ${k}`, existing_signals: signals })), ch.authorizeFileDownloadUrl(s, c, w({ file_id: 'file-priv-1' })), ch.resolvePermalink(s, c, w({ signal_id: 'sig-priv-root', signals })), ch.resolvePermalink(s, c, w({ file_id: 'file-priv-1', files }))]) eq(r.ok, al);
    eq(lr.ok ? lr.channels.some((x) => x.channel_id === priv) : false, al);
    if (!sj.ok) eq(['CHANNEL_ACCESS_DENIED', 'WORKSPACE_ACCESS_DENIED'].includes(sj.refusal.code) && sj.refusal.remedy_url.includes('/app') && Boolean(sj.refusal.cli_command), true);
    eq(ch.filterWorkspaceFiles(s, c, ws, files).some((f) => f.file_id === 'file-priv-1'), al);
    const sr = ch.searchWorkspaceContent(s, c, w({ query: 'alpha-7', signals, files }));
    if (sr.ok) { eq(sr.signal_hits.some((x) => x.channel_id === priv) && sr.file_hits.some((f) => f.file_id === 'file-priv-1') && priv in sr.by_channel_count, al); eq(sr.total_count, al ? 4 : 1); } else eq(al, false);
    const ur = ch.computeUnreadCounts(s, c, w({ signals })), cu = ch.buildCatchUpSummary(s, c, w({ signals })), ex = ch.exportWorkspaceData(s, c, w({ signals, files }));
    eq(ur.ok ? priv in ur.by_channel : false, al);
    if (cu.ok) eq(cu.needs_you_signals.some((x) => x.channel_id === priv) && cu.active_channel_slugs.includes('sec-incident'), al); else eq(al, false);
    const pv = ch.scrubLinkPreviews(s, c, [wc(priv, { target_kind: 'signal' as const, signal_id: 'sig-priv-root', title: 'S', snippet: 'alpha-7', author: 'u-owner', channel_slug: 'sec-incident' })]);
    eq(pv[0]?.redacted && pv[0]?.snippet === null, !al);
    if (ex.ok) eq(ex.channels.some((x) => x.channel_id === priv) && ex.signals.some((x) => x.channel_id === priv) && ex.files.some((f) => f.file_id === 'file-priv-1'), al); else eq(al, false);
  }
});

test('wakes, inbox filtering, @mention of non-member, and revocation', () => {
  const { state: s, principals: p, signals } = buildMatrixFixture();
  const pr = ch.postChannelSignal(s, p.owner, wc(priv, { signal_id: 'sig-m', signal_kind: 'ask', body: 's', mentions: [u('u-non-member'), u('u-org-admin-out'), u('u-member-in'), a('ag-multi')], existing_signals: signals, candidate_recipients: Object.values(p) }));
  ok(pr);
  if (!pr.ok) return;
  assert.deepEqual(pr.deliveries.map((d) => `${d.recipient_kind}:${d.recipient_id}`).sort(), ['agent:ag-multi', 'user:u-admin-in', 'user:u-member-in']);
  ok(ch.channel_remove_member(s, p.owner, wc(priv, u('u-member-in'))));
  eq(ch.filterInboxItems(s, p.member, pr.deliveries).length + ch.filterWakeEvents(s, p.member, pr.wakes).length, 0);
  ref(ch.canAckInboxItem(s, p.member, pr.deliveries.find((d) => d.recipient_id === 'u-member-in')!), 'CHANNEL_ACCESS_DENIED');
  ref(ch.canAckInboxItem(s, p['multi-org-agent'], pr.deliveries.find((d) => d.recipient_id === 'ag-multi')!, 'seat-multi-2a'), 'WORKSPACE_SEAT_MISMATCH');
});

test('channel owner invite, visibility guards, and flag gate', () => {
  const { state: s, principals: p, signals, files } = buildMatrixFixture(), rm = 'ch-rm';
  ref(ch.channel_add_member(s, p.member, wc(priv, u('u-non-member'))), 'PRIVATE_CHANNEL_OWNER_REQUIRED');
  ref(ch.channel_add_member(s, p['org-admin-non-member'], wc(priv, u('u-org-admin-out'))), 'CHANNEL_ACCESS_DENIED');
  ref(ch.channel_add_member(s, p.owner, wc(priv, u('u-guest'))), 'TARGET_MISSING_WORKSPACE_GRANT');
  ref(ch.bindFileToChannel(s, p.owner, wc('ch-pub', { file_id: 'file-priv-1' })), 'PRIVATE_FILE_CANNOT_BECOME_PUBLIC');
  ok(ch.channel_create(s, p.owner, wc(rm, { slug: 'roadmap', visibility: 'workspace' })));
  const fn = ch.channel_set_visibility(s, p.owner, wc(rm, { visibility: 'private', signal_count: 1 }));
  ref(fn, 'CHANNEL_HAS_PUBLIC_HISTORY');
  if (!fn.ok) eq(fn.refusal.cli_command.includes('cswarm channel archive'), true);
  ok(ch.channel_set_visibility(s, p.owner, wc(rm, { visibility: 'private', signal_count: 0, bound_file_count: 0 })));
  ref(ch.channel_set_visibility(s, p.owner, wc(priv, { visibility: 'workspace' })), 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
  ok(ch.channel_set_topic(s, p.owner, wc(rm, { topic: 'Up' })));
  ok(ch.channel_rename(s, p.owner, wc(rm, { slug: 'roadmap-v2' })));
  ok(ch.channel_leave(s, p.member, wc(priv)));
  ok(ch.channel_archive(s, p.owner, wc(rm)));
  const al = ch.channel_list(s, p.owner, w({ include_archived: true }));
  eq(al.ok && al.channels.some((c) => c.channel_id === rm), true);
  ok(ch.channel_set_notify_pref(s, p.admin, wc(priv, { notify_pref: 'mute' })));
  const mu = ch.computeUnreadCounts(s, p.admin, w({ signals }));
  eq(mu.ok && mu.by_channel[priv]?.unread_count, 0);
  s.privateChannelsEnabled = false;
  ref(ch.dispatchChannelCommand(s, p.owner, w({ kind: 'channel_create', slug: 'new-s', visibility: 'private' })), 'PRIVATE_CHANNELS_DISABLED');
  ref(ch.channel_get(s, p.owner, wc(priv)), 'PRIVATE_CHANNELS_DISABLED');
  const od = ch.channel_list(s, p.owner, w());
  eq(od.ok && od.channels.some((c) => c.visibility === 'private'), false);
  ref(ch.authorizeFileDownloadUrl(s, p.owner, w({ file_id: 'file-priv-1' })), 'PRIVATE_CHANNELS_DISABLED');
  const exp = ch.exportWorkspaceData(s, p.owner, w({ signals, files }));
  eq(exp.ok && !exp.channels.some((c) => c.channel_id === priv) && !exp.signals.some((x) => x.channel_id === priv) && !exp.files.some((f) => f.file_id === 'file-priv-1'), true);
});

test('regression guards', () => {
  const { state: s, principals: p } = buildMatrixFixture();
  ok(ch.channel_create(s, p.owner, wc('ch-empty', { slug: 'empty-pub', visibility: 'workspace' })));
  delete s.privateChannelsEnabled;
  ref(ch.channel_create(s, p.owner, w({ slug: 'omitted-priv', visibility: 'private' })), 'PRIVATE_CHANNELS_DISABLED');
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-empty', { visibility: 'private' })), 'PRIVATE_CHANNELS_DISABLED');
  s.privateChannelsEnabled = true;
  s.workspaceGrants.push(w({ org_id: 'org-1', ...u('u-guest'), role: 'guest', created_at: now }));
  ok(ch.channel_create(s, p.owner, wc('ch-open', { slug: 'open-lobby', visibility: 'workspace' })));
  ref(ch.channel_join(s, p.guest, wc('ch-open')), 'CHANNEL_INVITE_REQUIRED');
  ref(ch.channel_get(s, p.guest, wc('ch-open')), 'CHANNEL_ACCESS_DENIED');
  ok(ch.channel_add_member(s, p.owner, wc('ch-open', u('u-guest'))));
  ok(ch.channel_join(s, p.guest, wc('ch-open', { notify_pref: 'mentions' })));
  ok(ch.bindFileToChannel(s, p.owner, wc('ch-open', { file_id: 'file-unbound-1' })));
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-open', { visibility: 'private', signal_count: 0, bound_file_count: 0 })), 'CHANNEL_HAS_PUBLIC_HISTORY');
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-pub', { visibility: 'private', signal_count: 0, bound_file_count: 0 })), 'CHANNEL_HAS_PUBLIC_HISTORY');
  s.agentIdentities.push({ id: 'ag-mem', owner_user_id: 'u-member-in', display_name: 'M', created_at: now });
  s.workspaceGrants.push(w({ org_id: 'org-1', ...a('ag-mem', 'u-member-in'), role: 'member', created_at: now }));
  ok(ch.channel_add_member(s, p.owner, wc(priv, a('ag-mem', 'u-member-in'))));
  ref(ch.channel_remove_member(s, p.member, wc(priv, a('ag-mem', 'u-member-in'))), 'PRIVATE_CHANNEL_OWNER_REQUIRED');
  ok(ch.channel_remove_member(s, p.owner, wc(priv, a('ag-mem', 'u-member-in'))));
  const sc = ch.scrubLinkPreviews(s, p['non-member'], [
    w({ target_kind: 'signal', signal_id: 'sig-priv-root', title: 'S', snippet: 'a', author: 'u-owner', author_name: 'O', channel_slug: 'sec-incident', channel_name: 'sec-incident' }),
    wc('ch-pub', { target_kind: 'signal', signal_id: 'sig-priv-root', title: 'F', snippet: 'a', author_name: 'O', channel_name: 'general' }),
    w({ target_kind: 'file', file_id: 'file-priv-1', signal_id: 'sig-pub-1', title: 'SF', snippet: 'a', author_name: 'O', channel_name: 'general' }),
    w({ target_kind: 'signal', title: 'U', snippet: 'm' }),
  ]);
  for (const i of sc) eq(i.redacted && (i.title ?? i.snippet ?? i.author ?? i.author_name ?? i.channel_slug ?? i.channel_name) === null, true);
  const op = ch.scrubLinkPreviews(s, p.owner, [w({ target_kind: 'signal', signal_id: 'sig-priv-root', title: 'S', snippet: 'a', author_name: 'O', channel_name: 'sec-incident' })]);
  eq(op[0]?.redacted === false && op[0]?.channel_id === priv, true);
  const dp = ch.postChannelSignal(s, p['non-member'], wc(priv, { body: 'probe' }));
  ref(dp, 'CHANNEL_ACCESS_DENIED');
  if (!dp.ok) eq(dp.refusal.scope.channel ?? (dp.refusal.cli_command.includes('sec-incident') ? 'leak' : null), null);
  ref(ch.postChannelSignal(s, p['non-member'], w({ thread_id: 'sig-pub-1', in_reply_to: 'sig-priv-root', body: 'm' })), 'CHANNEL_ACCESS_DENIED');
  ref(ch.postChannelSignal(s, p.owner, w({ thread_id: 'sig-pub-1', in_reply_to: 'sig-priv-root', body: 'x' })), 'THREAD_CHANNEL_MISMATCH');
  ref(ch.channel_add_member(s, p.owner, wc(priv, { ...u('u-owner'), role: 'member' })), 'CANNOT_REMOVE_LAST_CHANNEL_OWNER');
  ref(ch.postChannelSignal(s, p['non-member'], w({ in_reply_to: 'sig-priv-root', body: 's', existing_signals: [{ ...s.signals!.find((x) => x.signal_id === 'sig-priv-root')!, channel_id: 'ch-pub' }] })), 'CHANNEL_ACCESS_DENIED');
  const pt = ch.readThreadSignals(s, p['non-member'], w({ thread_id: 'sig-pub-1', signals: [...s.signals!, { ...s.signals![2]!, signal_id: 'sig-x', channel_id: priv, thread_root_id: 'sig-pub-1' }] }));
  eq(pt.ok && pt.replies.length, 0);
  ok(ch.postChannelSignal(s, p.owner, wc('ch-empty', { signal_id: 'sig-e1', body: 'h' })));
  delete s.signals;
  ref(ch.channel_set_visibility(s, p.owner, wc('ch-empty', { visibility: 'private' })), 'CHANNEL_HAS_PUBLIC_HISTORY');
  const agL = a('ap-multi-1a');
  ok(ch.channel_create(s, agL, wc('ch-ag', { slug: 'ag-room', visibility: 'private' })));
  ok(ch.channel_get(s, agL, wc('ch-ag')));
  const agM = s.channelMemberships.find((m) => m.channel_id === 'ch-ag')!, agA = ch.channel_add_member(s, agL, wc('ch-ag', u('u-member-in')));
  eq(agM.principal_id === 'ag-multi' && agM.added_by === 'ag-multi' && agA.ok && agA.membership.added_by === 'ag-multi', true);
  ok(ch.channel_archive(s, agL, wc('ch-ag')));
  ref(ch.channel_create(s, p.owner, w({ slug: 'ag-room' })), 'CHANNEL_SLUG_TAKEN');
  ref(ch.channel_rename(s, p.owner, wc('ch-open', { slug: 'ag-room' })), 'CHANNEL_SLUG_TAKEN');
  ok(ch.resolvePermalink(s, p['non-member'], w({ signal_id: 'sig-u1', signals: [{ signal_id: 'sig-u1', workspace_id: ws, channel_id: null, author_kind: 'user', author_id: 'u-owner', body: 'u', created_at: now }] })));
});
