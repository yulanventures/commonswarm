import { type CallerContext, type OrgChannelAuthorityState, canReadChannel, canReadOrg, canReadWorkspace, isLive, isPrin, norm } from '../../../../../../src/protocol/org-channels-contract.js';
import { deriveOrgHeaderSwitcherVM, escapeHtml as esc, formatOrgRoleBadge, formatOrgUnreadBadge as formatUnreadCountPill, isWsRevoked, renderKylonIcon as ic, renderOrgHeaderIdentityHtml, renderOrgSwitcherMenuHtml } from './org-header-switcher.js';
export { formatUnreadCountPill };
export type KylonListPaneMode = 'chat' | 'members' | 'wiki';
export type ChannelFilterPill = 'all' | 'unread' | 'private';
export type MemberFilterPill = 'all' | 'people' | 'agents' | 'guests';
export const PRESERVED_SHELL_HOOKS: readonly string[] = [
  '#dashboard-user-menu', '#dashboard-channel-title', '#hm-ws-title', '#hm-phone-title', '#hm-channel-menu-trigger', '#hm-channel-menu-panel',
  ...'user-menu-root,user-menu-trigger,user-menu,rail-account,theme-toggle,theme-toggle-label,connected-apps-open,signout,home-rail-slot,home-workspace-shell,home-route-pane,home-catchup,home-channel-menu,channel-name,channel-description,live-chip,refresh,update-notice,update-dismiss,update-reload,home-workspace-header,home-phone-bar,home-back,home-account-menu,home-workspace-nav,roster-open,channel-menu-label,workspace-view,channel-place,channel-list,channel-new,channel-filter'.split(',').map((k) => `[data-${k}]`),
];
export type WorkspaceChannelNavVM = ReturnType<typeof deriveWorkspaceChannelNavVM>;
export type ChannelNavItemVM = WorkspaceChannelNavVM['channels'][number];
export type RosterSummaryItemVM = WorkspaceChannelNavVM['members'][number];
export type WikiDocumentNavItemVM = { slug: string; title: string; versionLabel: string; current: boolean };

const btn = (a: string, b = '') => `<button type="button" ${a}>${b}</button>`;
const ib = (l: string, a: string, i: string, p = '') => btn(`class="icon-button" aria-label="${l}" ${a}`, `${p}${ic(i)}`);
const pills = (k: string, vs: readonly string[], cur: string) =>
  vs.map((v) => btn(`data-${k}="${v}" aria-pressed="${cur === v}"`, v[0].toUpperCase() + v.slice(1))).join('');

export function deriveWorkspaceChannelNavVM(s0: OrgChannelAuthorityState, c: CallerContext, opt: Record<string, any> = {}) {
  const s: OrgChannelAuthorityState = { ...s0, privateChannelsEnabled: s0.privateChannelsEnabled === true };
  const header = deriveOrgHeaderSwitcherVM(s, c, opt), org = header.activeOrg, isGuest = org.role === 'guest', pk = c.principal_kind, pid = c.principal_id;
  const openSet = new Set<string>(opt.openWorkspaceIds ?? []), isOpen = (w: { workspace_id: string; join_policy?: string }) => !isGuest && pk === 'user' && (w.join_policy === 'open' || openSet.has(w.workspace_id));
  const wsList = s.workspaces.filter((w) => w.org_id === org.orgId && isLive(w) && canReadOrg(s, c, org.orgId) && !isWsRevoked(s, c, w.workspace_id, w.org_id) && (canReadWorkspace(s, c, w.workspace_id) || isOpen(w)));
  const curWs = wsList.find((w) => w.workspace_id === header.activeWorkspace?.workspaceId) ?? null;
  const workspaces = wsList.map((w) => {
    const rev = isWsRevoked(s, c, w.workspace_id, w.org_id), granted = !rev && canReadWorkspace(s, c, w.workspace_id);
    const role = s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, pk, pid) && isLive(g))?.role ?? org.role;
    return { workspaceId: w.workspace_id, orgId: w.org_id, slug: w.slug, name: w.name, role, roleLabel: formatOrgRoleBadge(role), granted, joinable: !granted && !rev && isOpen(w), current: curWs ? w.workspace_id === curWs.workspace_id : false };
  });
  const activeWorkspace = workspaces.find((w) => w.current) ?? null, unreads = opt.unreadCounts ?? {}, tMap = opt.threadsByChannel ?? {};
  const rawChs = activeWorkspace?.granted ? s.channels.filter((ch) => ch.workspace_id === activeWorkspace.workspaceId && isLive(ch) && canReadChannel(s, c, ch.channel_id)) : [];
  const curCh = rawChs.find((ch) => ch.channel_id === opt.activeChannelId || norm(ch.slug) === norm(opt.activeChannelId ?? '')) ?? rawChs.find((ch) => norm(ch.slug) === 'general') ?? rawChs[0] ?? null;
  const channels = rawChs.map((ch) => {
    const u = unreads[ch.channel_id] ?? 0, isPrivate = ch.visibility === 'private';
    return { channelId: ch.channel_id, workspaceId: ch.workspace_id, slug: ch.slug, topic: ch.topic ?? ch.purpose ?? null, visibility: ch.visibility, isPrivate, prefix: (isPrivate ? 'lock' : '#') as '#' | 'lock', unreadCount: u > 0 ? Math.floor(u) : 0, unreadBadge: formatUnreadCountPill(u), current: curCh ? ch.channel_id === curCh.channel_id : false, threads: (tMap[ch.channel_id] ?? []) as Array<{ threadId: string; title: string; replyCount: number }> };
  });
  const cf = String(opt.channelFilter ?? 'all').toLowerCase(), channelFilter: ChannelFilterPill = cf === 'unread' || cf === 'private' ? cf : 'all';
  const visibleChannels = channels.filter((ch) => (channelFilter === 'unread' ? ch.unreadCount > 0 : channelFilter === 'private' ? ch.isPrivate : true));
  const activeChannel = channels.find((ch) => ch.current) ?? channels[0] ?? null, mf = String(opt.memberFilter ?? 'all').toLowerCase();
  const memberFilter: MemberFilterPill = mf.startsWith('pe') ? 'people' : mf.startsWith('ag') ? 'agents' : mf.startsWith('gu') ? 'guests' : 'all';
  const allRoster = (opt.roster ?? s.orgMemberships.filter((m) => m.org_id === org.orgId && isLive(m)).map((m) => {
    const dn = (m.principal_kind === 'agent' ? s.agentIdentities.find((a) => a.id === m.principal_id)?.display_name : undefined) ?? m.principal_id;
    return { principalKind: m.principal_kind, principalId: m.principal_id, displayName: dn, initials: dn.slice(0, 2).toUpperCase(), role: m.role, roleLabel: formatOrgRoleBadge(m.role), specialty: m.principal_kind === 'agent' ? 'Agent' : 'Person' };
  })) as Array<{ principalKind: 'user' | 'agent'; principalId: string; displayName: string; initials: string; role: typeof org.role; roleLabel: string; specialty: string }>;
  const members = allRoster.filter((m) => (memberFilter === 'people' ? m.principalKind === 'user' : memberFilter === 'agents' ? m.principalKind === 'agent' : memberFilter === 'guests' ? m.role === 'guest' : true));
  const md = String(opt.mode ?? 'chat').toLowerCase(), mode: KylonListPaneMode = md === 'members' || md === 'wiki' ? md : 'chat';
  return { header, mode, channelFilter, memberFilter, workspaces, activeWorkspace, canCreateWorkspace: !isGuest, canCreateChannel: Boolean(activeWorkspace?.granted && !isGuest), channels, visibleChannels, activeChannel, roster: members, members, wikiDocuments: (opt.wikiDocuments ?? []) as WikiDocumentNavItemVM[], mobileDrawerOpen: Boolean(opt.mobileDrawerOpen) };
}

export function renderWorkspaceSwitcherMenuHtml(vm: WorkspaceChannelNavVM): string {
  const rows = vm.workspaces.map((w) => {
    const b = w.joinable ? '<span class="badge" data-workspace-open-badge="true">Open</span>' : `<span class="badge" data-workspace-role-badge="${esc(w.role)}">${esc(w.roleLabel)}</span>`;
    return btn(`class="nav-row" role="menuitemradio" aria-checked="${w.current}" aria-current="${w.current}" data-workspace="${esc(w.name)}" data-workspace-id="${esc(w.workspaceId)}" data-workspace-slug="${esc(w.slug)}" data-workspace-granted="${w.granted}"`, `<span>${esc(w.name)}</span>${b}${w.current ? ic('check') : ''}`);
  }).join(''), act = (a: string, l: string) => btn(`class="nav-row" role="menuitem" ${a}`, l), nw = vm.canCreateWorkspace ? act('data-action="new-workspace"', '+ New Workspace') : '';
  return `<div class="popover" id="workspace-menu" role="menu" style="top:96px;left:64px" aria-label="Workspace switcher"${vm.header.workspaceMenuOpen ? '' : ' hidden'}><p class="cs-popover-heading">Workspaces in ${esc(vm.header.activeOrg.displayName)}</p><div data-home-workspace-list>${rows}</div><hr/>${act('data-roster-open data-view="members"', 'Workspace Members')}${nw}</div>`;
}

export function renderChannelRowHtml(ch: ChannelNavItemVM): string {
  const pfx = ch.isPrivate ? `<span class="cs-channel-prefix" aria-label="Private channel">${ic('lock')}</span>` : '<span class="cs-channel-prefix" aria-hidden="true">#</span>';
  const u = ch.unreadBadge ? `<span class="count cs-unread-pill" data-channel-unread-count="${ch.unreadCount}">${esc(ch.unreadBadge)}</span>` : '', s = esc(ch.slug), cid = esc(ch.channelId), v = esc(ch.visibility);
  const th = ch.current && ch.threads.length ? `<div class="cs-channel-threads">${ch.threads.map((t) => btn(`class="cs-thread-row" data-thread-id="${esc(t.threadId)}"`, `<span>${esc(t.title)}</span><small class="meta">${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}</small>`)).join('')}</div>` : '';
  return `<div class="cs-channel-group">${btn(`class="nav-row" data-channel="${s}" data-channel-id="${cid}" data-channel-visibility="${v}"${ch.current ? ' aria-current="page"' : ''}`, `${pfx}<span>${s}</span>${u}`)}${th}</div>`;
}
export function renderModeContextualListPaneHtml(vm: WorkspaceChannelNavVM): string {
  const pane = (h: string, l: string, a: string, b: string) => `<div data-mode-pane="${esc(vm.mode)}"><div class="pane-heading"><h2>${h}</h2>${a ? ib(l, a, 'plus') : ''}</div>${b}</div>`;
  if (vm.mode === 'members') {
    const rows = vm.members.map((m) => btn(`class="member-row" data-member="${esc(m.displayName)}"`, `<span class="avatar ${m.principalKind === 'agent' ? 'agent' : ''}">${esc(m.initials)}</span><span><strong>${esc(m.displayName)}</strong><small>${esc(m.specialty)} · ${esc(m.roleLabel)}</small></span>`)).join('');
    return pane('Members', 'Add members', vm.canCreateWorkspace ? 'data-action="invite"' : '', `<div class="filters" aria-label="Member filters">${pills('member-filter', ['all', 'people', 'agents', 'guests'], vm.memberFilter)}</div><div aria-label="Organization roster">${rows}</div>`);
  }
  if (vm.mode === 'wiki') {
    const docs = vm.wikiDocuments.length ? vm.wikiDocuments.map((d) => btn(`class="nav-row" data-document="${esc(d.title)}"${d.current ? ' aria-current="page"' : ''}`, `${ic('book')}<span>${esc(d.title)}</span><span class="count">${esc(d.versionLabel)}</span>`)).join('') : '<p class="meta" data-wiki-empty="true">No wiki pages yet.</p>';
    return pane('Knowledge', 'Draft knowledge', vm.canCreateChannel ? 'data-action="knowledge-assist"' : '', `<nav aria-label="Knowledge files">${docs}</nav>`);
  }
  const ncA = 'data-channel-new data-channel-create-trigger', nc = vm.canCreateChannel ? btn(`class="nav-row" ${ncA}`, `${ic('plus')}<span>+ New Channel</span>`) : '';
  return pane('Chat', 'Create channel', vm.canCreateChannel ? ncA : '', `<div class="filters" aria-label="Channel filters">${pills('channel-filter', ['all', 'unread', 'private'], vm.channelFilter)}</div><div class="section-heading"><span>Channels</span></div><nav aria-label="Channels">${vm.visibleChannels.map(renderChannelRowHtml).join('')}${nc}</nav>`);
}

export function renderKylonOrgShellHtml(vm: WorkspaceChannelNavVM): string {
  const wn = esc(vm.activeWorkspace?.name ?? 'Workspace'), wid = esc(vm.activeWorkspace?.workspaceId ?? 'ws-default'), cs = esc(vm.activeChannel?.slug ?? 'general');
  const priv = vm.mode === 'chat' && Boolean(vm.activeChannel?.isPrivate), title = vm.mode === 'members' ? 'Members' : vm.mode === 'wiki' ? 'Wiki' : cs;
  const symK = esc(vm.mode === 'chat' ? (priv ? 'lock' : '#') : vm.mode), symB = vm.mode === 'chat' ? (priv ? ic('lock') : '#') : ic(vm.mode === 'members' ? 'people' : 'book');
  const bT = `${vm.header.activeOrg.displayName} · ${vm.activeWorkspace?.name ?? 'Workspace'}`;
  const topic = esc(vm.mode === 'chat' ? (vm.activeChannel?.topic ?? bT) : `${bT} · ${vm.mode === 'members' ? 'People & agents' : 'Shared knowledge'}`);
  const dA = vm.mobileDrawerOpen ? ' role="dialog" aria-modal="true"' : '', iA = vm.mobileDrawerOpen ? ' inert' : '';
  const navs = [['chat', 'Conversations', 'Chat', 'chat', ''], ['members', 'Members', 'Members', 'people', ' data-roster-open'], ['wiki', 'Wiki', 'Wiki', 'book', ' data-workspace-view="brain"'], ['files', 'Files', 'Files', 'doc', ' data-workspace-view="files"']] as const;
  const rB = navs.map(([v, al, , i, ex]) => ib(al, `data-view="${v}"${ex}${vm.mode === v ? ' aria-current="page"' : ''}`, i)).join('');
  const pB = navs.map(([v, , l, , ex]) => btn(`data-view="${v}"${ex.replace(' data-roster-open', '')}${vm.mode === v ? ' aria-current="page"' : ''}`, l)).join('') + btn('data-view="settings" data-action="settings"', 'Settings');
  return `<div class="app${vm.mobileDrawerOpen ? ' nav-open' : ''}" id="app">${btn('class="nav-scrim" aria-label="Close" data-action="close-nav" tabindex="-1"')}<nav class="rail" aria-label="Product"${iA}><div class="mark" aria-label="CommonSwarm">cs</div>${rB}<div data-home-rail-slot></div><div class="rail-bottom" id="dashboard-user-menu" data-user-menu-root>${ib('Theme', 'data-theme-toggle', 'settings', '<span class="sr-only" data-theme-toggle-label>Theme: Light</span>')}${btn('class="avatar small" aria-label="Account menu" data-user-menu-trigger', 'TL')}<div class="popover" data-user-menu hidden><p class="sr-only" data-rail-account>Your account</p>${btn('data-connected-apps-open', 'Connected apps')}${btn('data-signout', 'Sign out')}</div></div></nav><aside class="sidebar" id="sidebar" aria-label="Context navigation"${dA}>${btn('class="icon-button drawer-close" aria-label="Close" data-action="close-nav"', ic('close'))}${renderOrgHeaderIdentityHtml(vm.header)}<nav class="phone-nav" aria-label="Product sections" data-home-workspace-nav="phone">${pB}</nav><div id="sidebar-content">${renderModeContextualListPaneHtml(vm)}</div></aside><div class="workspace" id="workspace"><main class="panel" id="main" tabindex="-1"${iA}><header class="topbar" data-home-workspace-header="${wid}" data-home-phone-bar="${wid}" data-home-account-menu>${btn(`class="icon-button mobile-menu" aria-label="Menu" data-action="open-nav" data-home-back aria-controls="sidebar" aria-expanded="${vm.mobileDrawerOpen}"`, ic('menu'))}<span class="room-icon" id="room-symbol" data-room-symbol="${symK}">${symB}</span><div class="topbar-copy"><span id="hm-ws-title" class="sr-only">${wn}</span><span id="hm-phone-title" class="sr-only">${wn}</span><h1 id="dashboard-channel-title"><span id="screen-title" data-channel-name>${title}</span><span class="badge private-badge" id="screen-visibility-badge"${priv ? '' : ' hidden'}>Private</span></h1><p class="topic" id="screen-topic" data-channel-description>${topic}</p><div data-home-channel-menu>${btn('id="hm-channel-menu-trigger" class="sr-only" aria-controls="hm-channel-menu-panel" aria-expanded="false"', `<span data-channel-menu-label>${cs}</span>`)}<div id="hm-channel-menu-panel" hidden>${btn(`data-workspace-view="signals" data-channel-place="" data-channel-filter="${esc(vm.channelFilter)}"`)}${btn(`data-channel-new${vm.canCreateChannel ? '' : ' hidden disabled'}`)}<div data-channel-list></div></div></div></div><div class="topbar-actions" id="topbar-actions"><span class="badge good" data-live-chip>Live</span>${ib('Refresh', 'data-refresh', 'bell')}</div></header><div data-home-workspace-shell="${wid}"></div><section class="hm-route-pane" data-home-route-pane hidden></section><div data-home-catchup hidden></div><div data-update-notice hidden>${btn('data-update-dismiss', 'Dismiss')}${btn('data-update-reload', 'Reload')}</div></main></div>${renderOrgSwitcherMenuHtml(vm.header)}${renderWorkspaceSwitcherMenuHtml(vm)}</div>`;
}

export function bindWorkspaceChannelNavDom(
  root: { querySelectorAll(s: string): Iterable<any> } | ((s: string) => Iterable<any>),
  vm: WorkspaceChannelNavVM,
  cb: {
    onSelectChannel?: (id: string | null, slug?: string) => void; onCreateChannel?: () => void;
    onSelectChannelFilter?: (f: ChannelFilterPill) => void; onSelectMemberFilter?: (f: MemberFilterPill) => void;
    onSelectWorkspace?: (id: string, slug: string) => void;
  } = {},
): void {
  const q = (s: string): any[] => [...(typeof root === 'function' ? root(s) : root.querySelectorAll(s))];
  const on = (s: string, fn: (el: any) => void) => q(s).forEach((el) => el.addEventListener?.('click', () => fn(el)));
  const cur = (s: string, p: (x: any) => boolean) => q(s).forEach((x) => (p(x) ? x.setAttribute('aria-current', 'page') : x.removeAttribute?.('aria-current')));
  on('[data-channel-id]', (el) => {
    const cid = el.dataset.channelId ?? '', slug = el.dataset.channel ?? cid;
    cur('[data-channel-id]', (r) => r.dataset.channelId === cid);
    cur('[data-channel-place]', (p) => (p.dataset.channelPlace ?? '') === cid);
    q('[data-channel-place]').filter((p) => (p.dataset.channelPlace ?? '') === cid).forEach((p) => p.click?.());
    q('[data-channel-name],[data-channel-menu-label]').forEach((n) => (n.textContent = slug));
    q('#screen-visibility-badge').forEach((b) => (b.hidden = el.dataset.channelVisibility !== 'private'));
    cb.onSelectChannel?.(cid, slug);
  });
  on('[data-channel-place=""]', (el) => { cur('[data-channel-id]', () => false); el.setAttribute('aria-current', 'page'); cb.onSelectChannel?.(null); });
  on('[data-channel-create-trigger]', () => { if (vm.canCreateChannel) { q('#hm-channel-menu-panel [data-channel-new]').forEach((b) => b.click?.()); cb.onCreateChannel?.(); } });
  on('[data-channel-filter]', (el) => { const f = el.dataset.channelFilter ?? 'all'; q('[data-channel-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.channelFilter === f))); cb.onSelectChannelFilter?.(f); });
  on('[data-member-filter]', (el) => { const f = el.dataset.memberFilter ?? 'all'; q('[data-member-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.memberFilter === f))); cb.onSelectMemberFilter?.(f); });
  on('[data-workspace-id]', (el) => { const id = el.dataset.workspaceId ?? ''; q('[data-workspace-id]').forEach((x) => { const c = String(x.dataset.workspaceId === id); x.setAttribute('aria-checked', c); x.setAttribute('aria-current', c); }); cb.onSelectWorkspace?.(id, el.dataset.workspaceSlug ?? ''); });
}
