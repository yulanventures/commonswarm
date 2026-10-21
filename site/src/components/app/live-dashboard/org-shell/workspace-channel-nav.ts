import {
  type CallerContext,
  type ChannelVisibility,
  type OrgChannelAuthorityState,
  type OrgRole,
  agentOwner,
  canReadChannel,
  canReadOrg,
  canReadWorkspace,
  isLive,
  isPrin,
  norm,
} from '../../../../../../src/protocol/org-channels-contract.js';
import {
  type OrgHeaderSwitcherVM,
  deriveOrgHeaderSwitcherVM,
  escapeHtml as esc,
  formatOrgRoleBadge,
  formatOrgUnreadBadge as formatUnreadCountPill,
  renderOrgHeaderIdentityHtml,
  renderOrgSwitcherMenuHtml,
} from './org-header-switcher.js';

export { formatUnreadCountPill };

export type KylonListPaneMode = 'chat' | 'members' | 'wiki';
export type ChannelFilterPill = 'all' | 'unread' | 'private';
export type MemberFilterPill = 'all' | 'people' | 'agents' | 'guests';

export const PRESERVED_SHELL_HOOKS: readonly string[] = [
  '#dashboard-user-menu', '#dashboard-channel-title', '#hm-ws-title', '#hm-phone-title', '#hm-channel-menu-trigger', '#hm-channel-menu-panel',
  ...'user-menu-root,user-menu-trigger,user-menu,rail-account,theme-toggle,theme-toggle-label,connected-apps-open,signout,home-rail-slot,home-workspace-shell,home-route-pane,home-catchup,home-channel-menu,channel-name,channel-description,live-chip,refresh,update-notice,update-dismiss,update-reload,home-workspace-header,home-phone-bar,home-back,home-account-menu,home-workspace-nav,roster-open,channel-menu-label,workspace-view,channel-place,channel-list,channel-new,channel-filter'.split(',').map((k) => `[data-${k}]`),
];

export type ChannelNavItemVM = {
  channelId: string; workspaceId: string; slug: string; topic: string | null; visibility: ChannelVisibility;
  isPrivate: boolean; prefix: '#' | 'lock'; unreadCount: number; unreadBadge: string | null; current: boolean;
  threads: Array<{ threadId: string; title: string; replyCount: number }>;
};
export type RosterSummaryItemVM = { principalKind: 'user' | 'agent'; principalId: string; displayName: string; initials: string; role: OrgRole; roleLabel: string; specialty: string };
export type WikiDocumentNavItemVM = { slug: string; title: string; versionLabel: string; current: boolean };
export type WorkspaceChannelNavVM = ReturnType<typeof deriveWorkspaceChannelNavVM>;

const ic = (id: string, c = '') => `<svg class="icon${c ? ` ${c}` : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const btn = (a: string, b = '') => `<button type="button" ${a}>${b}</button>`;
const ib = (l: string, a: string, i: string, p = '') => btn(`class="icon-button" aria-label="${l}" ${a}`, `${p}${ic(i)}`);
const pills = (k: string, vs: readonly string[], cur: string) =>
  vs.map((v) => btn(`data-${k}="${v}" aria-pressed="${cur === v}"`, v[0].toUpperCase() + v.slice(1))).join('');

function isWsRevoked(s: OrgChannelAuthorityState, c: CallerContext, wsId: string, orgId: string): boolean {
  const o = c.principal_kind === 'agent' ? agentOwner(s, c) : null;
  const hit = (r: { principal_kind: 'user' | 'agent'; principal_id: string }) => isPrin(r, c.principal_kind, c.principal_id) || Boolean(o && isPrin(r, 'user', o));
  const rev = (x: { revoked_at?: string | null }) => x.revoked_at != null;
  return (
    s.orgMemberships.some((m) => m.org_id === orgId && hit(m) && rev(m)) ||
    s.workspaceGrants.some((g) => g.workspace_id === wsId && hit(g) && rev(g)) ||
    (s.legacyMemberships ?? []).some((m) => m.workspace_id === wsId && (m.user_id === c.principal_id || m.user_id === o) && rev(m)) ||
    (s.agentPrincipals ?? []).some((a) => a.workspace_id === wsId && a.agent_identity_id === c.principal_id && rev(a))
  );
}

export function deriveWorkspaceChannelNavVM(s0: OrgChannelAuthorityState, c: CallerContext, opt: Record<string, any> = {}) {
  const s: OrgChannelAuthorityState = { ...s0, privateChannelsEnabled: s0.privateChannelsEnabled === true };
  const header = deriveOrgHeaderSwitcherVM(s, c, opt);
  const org = header.activeOrg, isGuest = org.role === 'guest', pk = c.principal_kind, pid = c.principal_id;
  const wsList = s.workspaces.filter(
    (w) => w.org_id === org.orgId && isLive(w) && canReadOrg(s, c, org.orgId) && !isWsRevoked(s, c, w.workspace_id, w.org_id) && (isGuest || pk === 'agent' ? canReadWorkspace(s, c, w.workspace_id) : true),
  );
  const curWs = wsList.find((w) => w.workspace_id === header.activeWorkspace?.workspaceId) ?? null;
  const workspaces = wsList.map((w) => {
    const rev = isWsRevoked(s, c, w.workspace_id, w.org_id), granted = !rev && canReadWorkspace(s, c, w.workspace_id);
    const role = s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, pk, pid) && isLive(g))?.role ?? org.role;
    return { workspaceId: w.workspace_id, orgId: w.org_id, slug: w.slug, name: w.name, role, roleLabel: formatOrgRoleBadge(role), granted, joinable: !granted && !rev && !isGuest && pk === 'user', current: curWs ? w.workspace_id === curWs.workspace_id : false };
  });
  const activeWorkspace = workspaces.find((w) => w.current) ?? null;
  const unreads = opt.unreadCounts ?? {}, tMap = opt.threadsByChannel ?? {};
  const rawChs = activeWorkspace?.granted ? s.channels.filter((ch) => ch.workspace_id === activeWorkspace.workspaceId && isLive(ch) && canReadChannel(s, c, ch.channel_id)) : [];
  const curCh = rawChs.find((ch) => ch.channel_id === opt.activeChannelId || norm(ch.slug) === norm(opt.activeChannelId ?? '')) ?? rawChs.find((ch) => norm(ch.slug) === 'general') ?? rawChs[0] ?? null;
  const channels: ChannelNavItemVM[] = rawChs.map((ch) => {
    const u = unreads[ch.channel_id] ?? unreads[ch.slug] ?? 0, isPrivate = ch.visibility === 'private';
    return { channelId: ch.channel_id, workspaceId: ch.workspace_id, slug: ch.slug, topic: ch.topic ?? ch.purpose ?? null, visibility: ch.visibility, isPrivate, prefix: (isPrivate ? 'lock' : '#') as '#' | 'lock', unreadCount: u > 0 ? Math.floor(u) : 0, unreadBadge: formatUnreadCountPill(u), current: curCh ? ch.channel_id === curCh.channel_id : false, threads: tMap[ch.channel_id] ?? tMap[ch.slug] ?? [] };
  });
  const channelFilter: ChannelFilterPill = opt.channelFilter ?? 'all';
  const visibleChannels = channels.filter((ch) => (channelFilter === 'unread' ? ch.unreadCount > 0 : channelFilter === 'private' ? ch.isPrivate : true));
  const activeChannel = channels.find((ch) => ch.current) ?? channels[0] ?? null;
  const mf = String(opt.memberFilter ?? 'all').toLowerCase();
  const memberFilter: MemberFilterPill = mf.startsWith('pe') ? 'people' : mf.startsWith('ag') ? 'agents' : mf.startsWith('gu') ? 'guests' : 'all';
  const allRoster: RosterSummaryItemVM[] = opt.roster ?? s.orgMemberships.filter((m) => m.org_id === org.orgId && isLive(m)).map((m) => {
    const dn = (m.principal_kind === 'agent' ? s.agentIdentities.find((a) => a.id === m.principal_id)?.display_name : undefined) ?? m.principal_id;
    return { principalKind: m.principal_kind, principalId: m.principal_id, displayName: dn, initials: dn.slice(0, 2).toUpperCase(), role: m.role, roleLabel: formatOrgRoleBadge(m.role), specialty: m.principal_kind === 'agent' ? 'Agent' : 'Person' };
  });
  const members = allRoster.filter((m) => (memberFilter === 'people' ? m.principalKind === 'user' : memberFilter === 'agents' ? m.principalKind === 'agent' : memberFilter === 'guests' ? m.role === 'guest' : true));
  const wikiDocuments: WikiDocumentNavItemVM[] = opt.wikiDocuments ?? [
    { slug: 'design-principles', title: 'Design-principles.md', versionLabel: 'v2', current: true },
    { slug: 'working-agreements', title: 'Working-agreements.md', versionLabel: 'v1', current: false },
  ];
  return { header, mode: (opt.mode ?? 'chat') as KylonListPaneMode, channelFilter, memberFilter, workspaces, activeWorkspace, canCreateWorkspace: !isGuest, canCreateChannel: Boolean(activeWorkspace?.granted && !isGuest), channels, visibleChannels, activeChannel, roster: members, members, wikiDocuments, mobileDrawerOpen: Boolean(opt.mobileDrawerOpen) };
}

export function renderWorkspaceSwitcherMenuHtml(vm: WorkspaceChannelNavVM): string {
  const rows = vm.workspaces.map((w) => {
    const b = w.joinable ? '<span class="badge" data-workspace-open-badge="true">Open</span>' : `<span class="badge" data-workspace-role-badge="${esc(w.role)}">${esc(w.roleLabel)}</span>`;
    return btn(`class="cs-workspace-switcher-item" role="menuitemradio" aria-checked="${w.current}" aria-current="${w.current}" data-workspace="${esc(w.name)}" data-workspace-id="${esc(w.workspaceId)}" data-workspace-slug="${esc(w.slug)}" data-workspace-granted="${w.granted}"`, `<span class="cs-workspace-switcher-item__name">${esc(w.name)}</span>${b}${w.current ? ic('check', 'cs-ws-check') : ''}`);
  }).join('');
  const act = (a: string, l: string) => btn(`class="cs-workspace-switcher-action" role="menuitem" ${a}`, l);
  const nw = vm.canCreateWorkspace ? act('data-workspace-action="new-workspace" data-home-new-workspace data-action="new-workspace"', '+ New Workspace') : '';
  return `<div class="popover cs-workspace-switcher-popover" id="workspace-menu" role="menu" data-workspace-switcher-menu="true" data-anchor-for="workspace-trigger" style="top: 96px; left: 64px;" aria-label="Workspace switcher"${vm.header.workspaceMenuOpen ? '' : ' hidden'}><p class="cs-popover-heading">Workspaces in ${esc(vm.header.activeOrg.displayName)}</p><div class="cs-workspace-switcher-list" data-home-workspace-list>${rows}</div><hr/><div class="cs-workspace-switcher-actions">${act('data-workspace-action="workspace-members" data-roster-open data-view="members"', 'Workspace Members')}${nw}</div></div>`;
}

export function renderChannelRowHtml(ch: ChannelNavItemVM): string {
  const pfx = ch.isPrivate ? `<span class="cs-channel-prefix cs-channel-prefix--lock" data-channel-prefix="lock" data-channel-lock-icon="true" aria-label="Private channel">${ic('lock')}</span>` : '<span class="cs-channel-prefix cs-channel-prefix--hash" data-channel-prefix="#" aria-hidden="true">#</span>';
  const u = ch.unreadBadge ? `<span class="count cs-unread-pill" data-channel-unread-count="${ch.unreadCount}">${esc(ch.unreadBadge)}</span>` : '';
  const s = esc(ch.slug), cid = esc(ch.channelId), v = esc(ch.visibility);
  const th = ch.current && ch.threads.length ? `<div class="cs-channel-threads" data-channel-threads="${s}">${ch.threads.map((t) => btn(`class="cs-thread-row" data-thread-id="${esc(t.threadId)}" data-action="thread"`, `<span class="cs-thread-row__title">${esc(t.title)}</span><small class="meta">${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}</small>`)).join('')}</div>` : '';
  return `<div class="cs-channel-group" data-channel-visibility="${v}">${btn(`class="nav-row cs-channel-row" data-channel="${s}" data-channel-id="${cid}" data-channel-place="${cid}" data-channel-visibility="${v}"${ch.current ? ' aria-current="page"' : ''}`, `${pfx}<span class="cs-channel-row__name">${s}</span>${u}`)}${th}</div>`;
}

export function renderModeContextualListPaneHtml(vm: WorkspaceChannelNavVM): string {
  const pane = (h: string, l: string, a: string, b: string) => `<div class="cs-mode-pane" data-mode-pane="${vm.mode}"><div class="pane-heading"><h2>${h}</h2>${ib(l, a, 'plus')}</div>${b}</div>`;
  if (vm.mode === 'members') {
    const rows = vm.members.map((m) => btn(`class="member-row" data-member="${esc(m.displayName)}" data-principal-kind="${esc(m.principalKind)}" data-member-role="${esc(m.role)}"`, `<span class="avatar ${m.principalKind === 'agent' ? 'agent' : ''}">${esc(m.initials)}</span><span><strong>${esc(m.displayName)}</strong><small>${esc(m.specialty)} · ${esc(m.roleLabel)}</small></span>`)).join('');
    return pane('Members', 'Add members', 'data-action="invite"', `<div class="filters" aria-label="Member filters">${pills('member-filter', ['all', 'people', 'agents', 'guests'], vm.memberFilter)}</div><div class="cs-roster-list" data-org-member-roster="true" aria-label="Organization roster">${rows}</div>`);
  }
  if (vm.mode === 'wiki') {
    const docs = vm.wikiDocuments.map((d) => btn(`class="nav-row" data-document="${esc(d.title)}"${d.current ? ' aria-current="page"' : ''}`, `${ic('book')}<span>${esc(d.title)}</span><span class="count">${esc(d.versionLabel)}</span>`)).join('');
    return pane('Knowledge', 'Draft knowledge', 'data-action="knowledge-assist"', `<nav aria-label="Knowledge files" data-wiki-document-list="true">${docs}</nav>`);
  }
  const ncA = 'data-channel-new data-channel-create-trigger data-action="create-channel"';
  const nc = vm.canCreateChannel ? btn(`class="nav-row cs-channel-new-row" ${ncA}`, `${ic('plus')}<span>+ New Channel</span>`) : '';
  return pane('Chat', 'Create channel', ncA, `<div class="filters cs-channel-filters" aria-label="Channel filters">${pills('channel-filter', ['all', 'unread', 'private'], vm.channelFilter)}</div><div class="section-heading"><span>Channels</span></div><nav aria-label="Channels" data-channel-list>${vm.visibleChannels.map(renderChannelRowHtml).join('')}${nc}</nav>`);
}

export function renderKylonOrgShellHtml(vm: WorkspaceChannelNavVM): string {
  const wn = esc(vm.activeWorkspace?.name ?? 'Workspace'), wid = esc(vm.activeWorkspace?.workspaceId ?? 'ws-default'), cs = esc(vm.activeChannel?.slug ?? 'general'), cid = esc(vm.activeChannel?.channelId ?? cs);
  const priv = vm.mode === 'chat' && Boolean(vm.activeChannel?.isPrivate);
  const title = vm.mode === 'members' ? 'Members' : vm.mode === 'wiki' ? 'Wiki' : cs;
  const symK = vm.mode === 'chat' ? (priv ? 'lock' : '#') : vm.mode, symB = vm.mode === 'chat' ? (priv ? ic('lock') : '#') : ic(vm.mode === 'members' ? 'people' : 'book');
  const bT = `${vm.header.activeOrg.displayName} · ${vm.activeWorkspace?.name ?? 'Workspace'}`;
  const topic = esc(vm.mode === 'chat' ? (vm.activeChannel?.topic ?? bT) : `${bT} · ${vm.mode === 'members' ? 'People & agents' : 'Shared knowledge'}`);
  const dA = vm.mobileDrawerOpen ? ' role="dialog" aria-modal="true"' : '', iA = vm.mobileDrawerOpen ? ' inert' : '';
  const navs = [['chat', 'Conversations', 'Chat', 'chat', ''], ['members', 'Members', 'Members', 'people', ' data-roster-open'], ['wiki', 'Wiki', 'Wiki', 'book', ' data-workspace-view="brain"'], ['files', 'Files', 'Files', 'doc', ' data-workspace-view="files"']] as const;
  const rB = navs.map(([v, al, , i, ex]) => ib(al, `data-view="${v}"${ex}${vm.mode === v ? ' aria-current="page"' : ''}`, i)).join('');
  const pB = navs.map(([v, , l, , ex]) => btn(`data-view="${v}"${ex.replace(' data-roster-open', '')}${vm.mode === v ? ' aria-current="page"' : ''}`, l)).join('') + btn('data-view="settings" data-action="settings" aria-label="Settings and account"', 'Settings');
  return `<div class="app${vm.mobileDrawerOpen ? ' nav-open' : ''}" id="app" data-kylon-shell="true">${btn('class="nav-scrim" aria-label="Dismiss navigation" data-action="close-nav" tabindex="-1"')}<nav class="rail" aria-label="Product" data-home-rail-slot${iA}><div class="mark" aria-label="CommonSwarm">cs</div>${rB}<div class="rail-bottom" id="dashboard-user-menu" data-user-menu-root>${ib('Theme', 'data-theme-toggle', 'settings', '<span class="sr-only" data-theme-toggle-label>Theme: Light</span>')}${btn('class="avatar small" aria-label="Account menu" data-user-menu-trigger', 'TL')}<div class="popover" data-user-menu hidden><p class="sr-only" data-rail-account>Your account</p>${btn('data-connected-apps-open', 'Connected apps')}${btn('data-signout', 'Sign out')}</div></div></nav><aside class="sidebar" id="sidebar" aria-label="Context navigation"${dA}>${btn('class="icon-button drawer-close" aria-label="Close navigation" data-action="close-nav"', ic('close'))}${renderOrgHeaderIdentityHtml(vm.header)}<nav class="phone-nav" aria-label="Product sections" data-home-workspace-nav="phone">${pB}</nav><div id="sidebar-content">${renderModeContextualListPaneHtml(vm)}</div></aside><div class="workspace" id="workspace"><main class="panel" id="main" tabindex="-1"${iA}><header class="topbar" data-home-workspace-header="${wid}" data-home-phone-bar="${wid}" data-home-account-menu>${btn(`class="icon-button mobile-menu" aria-label="Open navigation" data-action="open-nav" data-home-back aria-controls="sidebar" aria-expanded="${vm.mobileDrawerOpen}"`, ic('menu'))}<span class="room-icon" id="room-symbol" data-room-symbol="${symK}">${symB}</span><div class="topbar-copy"><h1 id="dashboard-channel-title" data-channel-name><span id="hm-ws-title" class="sr-only">${wn}</span><span id="hm-phone-title" class="sr-only">${wn}</span><span id="screen-title">${title}</span><span class="badge private-badge" id="screen-visibility-badge"${priv ? '' : ' hidden'}>Private</span></h1><p class="topic" id="screen-topic" data-channel-description>${topic}</p><div data-home-channel-menu hidden>${btn('id="hm-channel-menu-trigger" class="sr-only" aria-controls="hm-channel-menu-panel" aria-expanded="false"', `<span data-channel-menu-label>${cs}</span>`)}<div id="hm-channel-menu-panel" hidden>${btn(`data-workspace-view="signals" data-channel-place="${cid}" data-channel-filter="${esc(vm.channelFilter)}"`)}${btn('data-channel-new data-channel-create-trigger')}<div data-channel-list></div></div></div></div><div class="topbar-actions" id="topbar-actions"><span class="badge good" data-live-chip>Live</span>${ib('Refresh', 'data-refresh', 'bell')}</div></header><div class="cs-home-workspace-shell-slot" data-home-workspace-shell="${wid}" hidden></div><section class="hm-route-pane" data-home-route-pane hidden></section><div data-home-catchup hidden></div><div data-update-notice hidden>${btn('data-update-dismiss', 'Dismiss')}${btn('data-update-reload', 'Reload')}</div></main></div>${renderOrgSwitcherMenuHtml(vm.header)}${renderWorkspaceSwitcherMenuHtml(vm)}</div>`;
}
