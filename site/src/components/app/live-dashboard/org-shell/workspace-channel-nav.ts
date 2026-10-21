import {
  type CallerContext,
  type ChannelVisibility,
  type OrgChannelAuthorityState,
  type OrgRole,
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
  renderOrgHeaderIdentityHtml,
  renderOrgSwitcherMenuHtml,
} from './org-header-switcher.js';

export type KylonListPaneMode = 'chat' | 'members' | 'wiki';
export type ChannelFilterPill = 'all' | 'unread' | 'private';

export const PRESERVED_SHELL_HOOKS = [
  '#dashboard-user-menu', '[data-user-menu-root]', '[data-user-menu-trigger]', '[data-user-menu]', '[data-rail-account]',
  '[data-theme-toggle]', '[data-theme-toggle-label]', '[data-connected-apps-open]', '[data-signout]', '[data-home-rail-slot]',
  '[data-home-workspace-shell]', '[data-home-route-pane]', '[data-home-catchup]', '[data-home-channel-menu]',
  '#dashboard-channel-title', '[data-channel-name]', '[data-channel-description]', '[data-live-chip]', '[data-refresh]',
  '[data-update-notice]', '[data-update-dismiss]', '[data-update-reload]', '#hm-ws-title', '#hm-phone-title',
  '[data-home-workspace-header]', '[data-home-phone-bar]', '[data-home-back]', '[data-home-account-menu]',
  '[data-home-workspace-nav]', '[data-roster-open]', '#hm-channel-menu-trigger', '#hm-channel-menu-panel',
  '[data-channel-menu-label]', '[data-workspace-view]', '[data-channel-place]', '[data-channel-list]', '[data-channel-new]',
] as const;

export interface WorkspaceSelectorItemVM {
  workspaceId: string; orgId: string; slug: string; name: string;
  role: OrgRole; roleLabel: string; granted: boolean; joinable: boolean; current: boolean;
}
export interface ChannelThreadSummaryVM { threadId: string; title: string; replyCount: number; }
export interface ChannelNavItemVM {
  channelId: string; workspaceId: string; slug: string; topic: string | null;
  visibility: ChannelVisibility; isPrivate: boolean; prefix: '#' | 'lock';
  unreadCount: number; unreadBadge: string | null; current: boolean; threads: ChannelThreadSummaryVM[];
}
export interface RosterSummaryItemVM {
  principalKind: 'user' | 'agent'; principalId: string; displayName: string;
  initials: string; role: OrgRole; roleLabel: string; specialty: string;
}
export interface WikiDocumentNavItemVM { slug: string; title: string; versionLabel: string; current: boolean; }
export interface WorkspaceChannelNavVM {
  header: OrgHeaderSwitcherVM; mode: KylonListPaneMode; channelFilter: ChannelFilterPill;
  workspaces: WorkspaceSelectorItemVM[]; activeWorkspace: WorkspaceSelectorItemVM | null;
  canCreateWorkspace: boolean; canCreateChannel: boolean;
  channels: ChannelNavItemVM[]; visibleChannels: ChannelNavItemVM[]; activeChannel: ChannelNavItemVM | null;
  roster: RosterSummaryItemVM[]; wikiDocuments: WikiDocumentNavItemVM[]; mobileDrawerOpen: boolean;
}

const ic = (id: string, cls = '') => `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const btn = (attrs: string, body = '') => `<button type="button" ${attrs}>${body}</button>`;

export function formatUnreadCountPill(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.floor(count);
  return n > 99 ? '99+' : String(n);
}

export function deriveWorkspaceChannelNavVM(
  state: OrgChannelAuthorityState,
  caller: CallerContext,
  options: {
    activeOrgId?: string | null; activeWorkspaceId?: string | null; activeChannelId?: string | null;
    mode?: KylonListPaneMode; channelFilter?: ChannelFilterPill; switcherOpen?: boolean;
    workspaceMenuOpen?: boolean; mobileDrawerOpen?: boolean; unreadCounts?: Record<string, number>;
    threadsByChannel?: Record<string, ChannelThreadSummaryVM[]>; roster?: RosterSummaryItemVM[];
    wikiDocuments?: WikiDocumentNavItemVM[];
  } = {},
): WorkspaceChannelNavVM {
  const header = deriveOrgHeaderSwitcherVM(state, caller, options);
  const activeOrg = header.activeOrg;
  const isGuest = activeOrg.role === 'guest';

  const wsList = state.workspaces.filter((ws) => {
    if (ws.org_id !== activeOrg.orgId || !isLive(ws) || !canReadOrg(state, caller, activeOrg.orgId)) return false;
    const revoked = state.workspaceGrants.some(
      (g) => g.workspace_id === ws.workspace_id && isPrin(g, caller.principal_kind, caller.principal_id) && g.revoked_at != null,
    );
    return !revoked && (isGuest ? canReadWorkspace(state, caller, ws.workspace_id) : true);
  });

  const chosenWs =
    wsList.find((ws) => ws.workspace_id === options.activeWorkspaceId || ws.slug === options.activeWorkspaceId || ws.workspace_id === header.activeWorkspace?.workspaceId) ??
    wsList[0] ?? null;

  const workspaces: WorkspaceSelectorItemVM[] = wsList.map((ws) => {
    const granted = canReadWorkspace(state, caller, ws.workspace_id);
    const grantRole = state.workspaceGrants.find(
      (g) => g.workspace_id === ws.workspace_id && isPrin(g, caller.principal_kind, caller.principal_id) && isLive(g),
    )?.role;
    const role = grantRole ?? activeOrg.role;
    return {
      workspaceId: ws.workspace_id, orgId: ws.org_id, slug: ws.slug, name: ws.name,
      role, roleLabel: formatOrgRoleBadge(role), granted, joinable: !granted && !isGuest,
      current: chosenWs ? ws.workspace_id === chosenWs.workspace_id : false,
    };
  });

  const activeWorkspace = workspaces.find((ws) => ws.current) ?? workspaces[0] ?? null;
  const unreads = options.unreadCounts ?? {};
  const threadsMap = options.threadsByChannel ?? {};

  const rawChs = activeWorkspace
    ? state.channels.filter((ch) => ch.workspace_id === activeWorkspace.workspaceId && isLive(ch) && canReadChannel(state, caller, ch.channel_id))
    : [];

  const chosenCh =
    rawChs.find((ch) => ch.channel_id === options.activeChannelId || norm(ch.slug) === norm(options.activeChannelId ?? '')) ??
    rawChs.find((ch) => norm(ch.slug) === 'general') ?? rawChs[0] ?? null;

  const channels: ChannelNavItemVM[] = rawChs.map((ch) => {
    const unread = unreads[ch.channel_id] ?? unreads[ch.slug] ?? 0;
    const isPrivate = ch.visibility === 'private';
    return {
      channelId: ch.channel_id, workspaceId: ch.workspace_id, slug: ch.slug,
      topic: ch.topic ?? ch.purpose ?? null, visibility: ch.visibility, isPrivate,
      prefix: isPrivate ? 'lock' : '#', unreadCount: unread > 0 ? Math.floor(unread) : 0,
      unreadBadge: formatUnreadCountPill(unread),
      current: chosenCh ? ch.channel_id === chosenCh.channel_id : false,
      threads: threadsMap[ch.channel_id] ?? threadsMap[ch.slug] ?? [],
    };
  });

  const channelFilter: ChannelFilterPill = options.channelFilter ?? 'all';
  const visibleChannels = channels.filter((ch) =>
    channelFilter === 'unread' ? ch.unreadCount > 0 : channelFilter === 'private' ? ch.isPrivate : true,
  );
  const activeChannel = channels.find((ch) => ch.current) ?? channels[0] ?? null;

  const roster: RosterSummaryItemVM[] =
    options.roster ??
    state.orgMemberships
      .filter((m) => m.org_id === activeOrg.orgId && isLive(m))
      .map((m) => {
        const agent = m.principal_kind === 'agent' ? state.agentIdentities.find((a) => a.id === m.principal_id) : undefined;
        const displayName = agent?.display_name ?? m.principal_id;
        return {
          principalKind: m.principal_kind, principalId: m.principal_id, displayName,
          initials: displayName.slice(0, 2).toUpperCase(), role: m.role,
          roleLabel: formatOrgRoleBadge(m.role), specialty: m.principal_kind === 'agent' ? 'Agent' : 'Person',
        };
      });

  const wikiDocuments: WikiDocumentNavItemVM[] = options.wikiDocuments ?? [
    { slug: 'design-principles', title: 'Design-principles.md', versionLabel: 'v2', current: true },
    { slug: 'working-agreements', title: 'Working-agreements.md', versionLabel: 'v1', current: false },
  ];

  return {
    header, mode: options.mode ?? 'chat', channelFilter, workspaces, activeWorkspace,
    canCreateWorkspace: !isGuest, canCreateChannel: Boolean(activeWorkspace && !isGuest),
    channels, visibleChannels, activeChannel, roster, wikiDocuments, mobileDrawerOpen: Boolean(options.mobileDrawerOpen),
  };
}

export function renderWorkspaceSwitcherMenuHtml(vm: WorkspaceChannelNavVM): string {
  const wsRows = vm.workspaces
    .map((ws) => {
      const badge = ws.joinable
        ? '<span class="badge" data-workspace-open-badge="true">Open</span>'
        : `<span class="badge" data-workspace-role-badge="${esc(ws.role)}">${esc(ws.roleLabel)}</span>`;
      return btn(
        `class="cs-workspace-switcher-item" data-workspace="${esc(ws.name)}" data-workspace-id="${esc(ws.workspaceId)}" data-workspace-slug="${esc(ws.slug)}" data-workspace-granted="${String(ws.granted)}" aria-current="${String(ws.current)}"`,
        `<span class="cs-workspace-switcher-item__name">${esc(ws.name)}</span>${badge}${ws.current ? ic('check', 'cs-ws-check') : ''}`,
      );
    })
    .join('');
  const newWsBtn = vm.canCreateWorkspace
    ? btn('class="cs-workspace-switcher-action" data-workspace-action="new-workspace" data-home-new-workspace="" data-action="new-workspace"', '+ New Workspace')
    : '';
  return `<div class="popover cs-workspace-switcher-popover" id="workspace-menu" data-workspace-switcher-menu="true" aria-label="Workspace switcher"${vm.header.workspaceMenuOpen ? '' : ' hidden'}><p class="cs-popover-heading">Workspaces in ${esc(vm.header.activeOrg.displayName)}</p><div class="cs-workspace-switcher-list" data-home-workspace-list="">${wsRows}</div><hr/><div class="cs-workspace-switcher-actions">${btn('class="cs-workspace-switcher-action" data-workspace-action="workspace-members" data-roster-open="" data-view="members"', 'Workspace Members')}${newWsBtn}</div></div>`;
}

export function renderChannelRowHtml(ch: ChannelNavItemVM): string {
  const pfx = ch.isPrivate
    ? `<span class="cs-channel-prefix cs-channel-prefix--lock" data-channel-prefix="lock" data-channel-lock-icon="true" aria-label="Private channel">${ic('lock')}</span>`
    : '<span class="cs-channel-prefix cs-channel-prefix--hash" data-channel-prefix="#" aria-hidden="true">#</span>';
  const unread = ch.unreadBadge ? `<span class="count cs-unread-pill" data-channel-unread-count="${ch.unreadCount}">${esc(ch.unreadBadge)}</span>` : '';
  const threads = ch.current && ch.threads.length > 0
    ? `<div class="cs-channel-threads" data-channel-threads="${esc(ch.slug)}">${ch.threads.map((t) => btn(`class="cs-thread-row" data-thread-id="${esc(t.threadId)}" data-action="thread"`, `<span class="cs-thread-row__title">${esc(t.title)}</span><small class="meta">${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}</small>`)).join('')}</div>`
    : '';
  return `<div class="cs-channel-group" data-channel-visibility="${esc(ch.visibility)}">${btn(`class="nav-row cs-channel-row" data-channel="${esc(ch.slug)}" data-channel-id="${esc(ch.channelId)}" data-channel-place="${esc(ch.slug)}" data-channel-visibility="${esc(ch.visibility)}"${ch.current ? ' aria-current="page"' : ''}`, `${pfx}<span class="cs-channel-row__name">${esc(ch.slug)}</span>${unread}`)}${threads}</div>`;
}

export function renderModeContextualListPaneHtml(vm: WorkspaceChannelNavVM): string {
  if (vm.mode === 'members') {
    const rows = vm.roster.map((m) => btn(`class="member-row" data-member="${esc(m.displayName)}" data-principal-kind="${esc(m.principalKind)}" data-member-role="${esc(m.role)}"`, `<span class="avatar ${m.principalKind === 'agent' ? 'agent' : ''}">${esc(m.initials)}</span><span><strong>${esc(m.displayName)}</strong><small>${esc(m.specialty)} · ${esc(m.roleLabel)}</small></span>`)).join('');
    const mFilters = ([['all', 'All', 'true'], ['Person', 'People', 'false'], ['Agent', 'Agents', 'false'], ['Guest', 'Guests', 'false']] as const).map(([k, l, p]) => btn(`data-member-filter="${k}" aria-pressed="${p}"`, l)).join('');
    return `<div class="cs-mode-pane" data-mode-pane="members"><div class="pane-heading"><h2>Members</h2>${btn('class="icon-button" aria-label="Add members" data-action="invite"', ic('plus'))}</div><div class="filters" aria-label="Member filters">${mFilters}</div><div class="cs-roster-list" data-org-member-roster="true" aria-label="Organization roster">${rows}</div></div>`;
  }
  if (vm.mode === 'wiki') {
    const docs = vm.wikiDocuments.map((d) => btn(`class="nav-row" data-document="${esc(d.title)}"${d.current ? ' aria-current="page"' : ''}`, `${ic('book')}<span>${esc(d.title)}</span><span class="count">${esc(d.versionLabel)}</span>`)).join('');
    return `<div class="cs-mode-pane" data-mode-pane="wiki"><div class="pane-heading"><h2>Knowledge</h2>${btn('class="icon-button" aria-label="Draft knowledge" data-action="knowledge-assist"', ic('plus'))}</div><nav aria-label="Knowledge files" data-wiki-document-list="true">${docs}</nav></div>`;
  }
  const filters = (['all', 'unread', 'private'] as const).map((v) => btn(`data-channel-filter="${v}" aria-pressed="${String(vm.channelFilter === v)}"`, v[0].toUpperCase() + v.slice(1))).join('');
  const newCh = vm.canCreateChannel ? btn('class="nav-row cs-channel-new-row" data-channel-new="" data-action="create-channel"', `${ic('plus')}<span>+ New Channel</span>`) : '';
  return `<div class="cs-mode-pane" data-mode-pane="chat"><div class="pane-heading"><h2>Chat</h2>${btn('class="icon-button" aria-label="Create channel" data-channel-new="" data-action="create-channel"', ic('plus'))}</div><div class="filters cs-channel-filters" aria-label="Channel filters">${filters}</div><nav class="cs-workspace-quick-links" aria-label="Workspace resources">${btn('class="nav-row" data-home-catchup-nav="" data-workspace-view="catchup"', '<span>Catch up</span>')}${btn('class="nav-row" data-workspace-view="brain"', `${ic('book')}<span>Wiki</span>`)}${btn('class="nav-row" data-workspace-view="files" data-view="files"', `${ic('doc')}<span>Files</span>`)}</nav><div class="section-heading"><span>Channels</span></div><nav aria-label="Channels" data-channel-list="">${vm.visibleChannels.map(renderChannelRowHtml).join('')}${newCh}</nav></div>`;
}

export function renderKylonOrgShellHtml(vm: WorkspaceChannelNavVM): string {
  const wsName = esc(vm.activeWorkspace?.name ?? 'Workspace');
  const wsId = esc(vm.activeWorkspace?.workspaceId ?? 'ws-default');
  const chSlug = esc(vm.activeChannel?.slug ?? 'general');
  const topic = esc(vm.activeChannel?.topic ?? `${vm.header.activeOrg.displayName} · ${vm.activeWorkspace?.name ?? 'Workspace'}`);
  const cur = (m: KylonListPaneMode) => (vm.mode === m ? ' aria-current="page"' : '');
  return `<div class="app${vm.mobileDrawerOpen ? ' nav-open' : ''}" id="app" data-kylon-shell="true" data-home-workspace-shell="${wsId}">${btn('class="nav-scrim" aria-label="Dismiss navigation" data-action="close-nav" tabindex="-1"')}<nav class="rail" aria-label="Product" data-home-rail-slot=""><div class="mark" aria-label="CommonSwarm">cs</div>${btn(`class="icon-button" aria-label="Conversations" data-view="chat"${cur('chat')}`, ic('chat'))}${btn(`class="icon-button" aria-label="Members" data-view="members" data-roster-open=""${cur('members')}`, ic('people'))}${btn(`class="icon-button" aria-label="Wiki" data-view="wiki" data-workspace-view="brain"${cur('wiki')}`, ic('book'))}<div class="rail-bottom" id="dashboard-user-menu" data-user-menu-root="" data-rail-account="">${btn('class="icon-button" aria-label="Theme" data-theme-toggle=""', `<span class="sr-only" data-theme-toggle-label="">Theme: Light</span>${ic('settings')}`)}${btn('class="avatar small" aria-label="Account menu" data-user-menu-trigger=""', 'TL')}<div class="popover" data-user-menu="" hidden>${btn('data-connected-apps-open=""', 'Connected apps')}${btn('data-signout=""', 'Sign out')}</div></div></nav><aside class="sidebar" id="navigation" aria-label="Context navigation">${btn('class="icon-button drawer-close" aria-label="Close navigation" data-action="close-nav"', ic('close'))}${renderOrgHeaderIdentityHtml(vm.header)}<nav class="phone-nav" aria-label="Product sections" data-home-workspace-nav="phone">${btn(`data-view="chat"${cur('chat')}`, 'Chat')}${btn(`data-view="members"${cur('members')}`, 'Members')}${btn(`data-view="wiki"${cur('wiki')}`, 'Wiki')}${btn('data-view="files"', 'Files')}</nav><div id="sidebar-content">${renderModeContextualListPaneHtml(vm)}</div></aside><div class="workspace" id="workspace" data-home-route-pane=""><main class="panel" id="main" tabindex="-1"><header class="topbar" data-home-workspace-header="${wsId}" data-home-phone-bar="${wsId}" data-home-account-menu="">${btn(`class="icon-button mobile-menu" aria-label="Open navigation" data-action="open-nav" data-home-back="" aria-controls="navigation" aria-expanded="${String(vm.mobileDrawerOpen)}"`, ic('menu'))}<div class="topbar-copy" data-home-channel-menu=""><h1 id="dashboard-channel-title" data-channel-name=""><span id="hm-ws-title" class="sr-only">${wsName}</span><span id="hm-phone-title" class="sr-only">${wsName}</span><span id="screen-title">${chSlug}</span></h1><p class="topic" id="screen-topic" data-channel-description="">${topic}</p>${btn('id="hm-channel-menu-trigger" class="sr-only" aria-controls="hm-channel-menu-panel" aria-expanded="false"', `<span data-channel-menu-label="">${chSlug}</span>`)}<div id="hm-channel-menu-panel" hidden></div></div><div class="topbar-actions" id="topbar-actions"><span class="badge good" data-live-chip="">Live</span>${btn('class="icon-button" aria-label="Refresh" data-refresh=""', ic('bell'))}</div></header><div data-home-catchup="" hidden></div><div data-update-notice="" hidden>${btn('data-update-dismiss=""', 'Dismiss')}${btn('data-update-reload=""', 'Reload')}</div></main></div>${renderOrgSwitcherMenuHtml(vm.header)}${renderWorkspaceSwitcherMenuHtml(vm)}</div>`;
}
