import { type CallerContext, type OrgChannelAuthorityState, type OrganizationSummary, type OrgRole, agentOwner, canReadChannel, canReadOrg, canReadWorkspace, isLive, isPrin, orgRole } from '../../../../../../src/protocol/org-channels-contract.js';

export const ORG_ROLE_ORDER: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'] as const;
export const ORG_ROLE_LABELS: Readonly<Record<OrgRole, string>> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
export const ORG_SWITCHER_ACTIONS = [
  { id: 'org-members', label: 'Organization Members', dataView: 'members', dataAction: 'org-members' },
  { id: 'org-settings-logo', label: 'Organization Settings / Logo', dataView: 'settings', dataAction: 'logo' },
  { id: 'new-organization', label: '+ New Organization', dataView: null, dataAction: 'new-org' },
] as const;

const IC: Readonly<Record<string, string>> = {
  chat: 'M5 18 3 21l1-6a8 8 0 1 1 4 4Z', plus: 'M12 5v14M5 12h14', chevron: 'm8 10 4 4 4-4',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 9v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2',
  book: 'M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-11v2m0 12v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M4 12h2m12 0h2M5.6 18.4 7 17m10-10 1.4-1.4',
  bell: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5Zm5 3h4', menu: 'M4 6h16M4 12h16M4 18h16', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 5 5L20 7',
  doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h5',
  lock: 'M7 10h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm1 0V7a4 4 0 0 1 8 0v3m-4 4v3',
};
export const renderKylonIcon = (id: string, c = '') => `<svg class="icon${c ? ` ${c}` : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[id] ?? ''}"/></svg>`;
export function isWsRevoked(s: OrgChannelAuthorityState, c: CallerContext, wsId: string, orgId: string): boolean {
  const o = c.principal_kind === 'agent' ? agentOwner(s, c) : null;
  const hit = (r: { principal_kind: 'user' | 'agent'; principal_id: string }) => isPrin(r, c.principal_kind, c.principal_id) || Boolean(o && isPrin(r, 'user', o));
  const rev = (x: { revoked_at?: string | null }) => x.revoked_at != null;
  return s.orgMemberships.some((m) => m.org_id === orgId && hit(m) && rev(m)) || s.workspaceGrants.some((g) => g.workspace_id === wsId && hit(g) && rev(g)) || (s.legacyMemberships ?? []).some((m) => m.workspace_id === wsId && (m.user_id === c.principal_id || m.user_id === o) && rev(m)) || (s.agentPrincipals ?? []).some((a) => a.workspace_id === wsId && a.agent_identity_id === c.principal_id && rev(a));
}

export type OrgSwitcherItemVM = ReturnType<typeof toOrgSwitcherItemVM>;
export type OrgHeaderSwitcherVM = ReturnType<typeof deriveOrgHeaderSwitcherVM>;
export interface OrgDomElement {
  tagName?: string; className: string; id?: string; textContent: string | null; hidden?: boolean;
  style?: Record<string, string>; dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void; getAttribute?(name: string): string | null;
  getBoundingClientRect?(): { left: number; bottom: number; top?: number; width?: number };
  append(...nodes: Array<OrgDomElement | string>): void; focus?(): void;
  addEventListener?(type: string, listener: (e: { key?: string; preventDefault?(): void }) => void): void;
}
export interface OrgDomDocument { createElement(tag: string): OrgDomElement; }
export interface OrgHeaderSwitcherCallbacks {
  onSelectOrg?: (orgId: string, slug: string) => void; onToggleOrgSwitcher?: (open: boolean) => void;
  onToggleWorkspaceSwitcher?: (open: boolean) => void; onOpenOrgMembers?: () => void;
  onOpenOrgSettingsLogo?: () => void; onCreateOrganization?: () => void;
}

export const formatOrgRoleBadge = (role: OrgRole): string => ORG_ROLE_LABELS[role] ?? 'Member';
export const formatOrgUnreadBadge = (count: number): string | null =>
  !Number.isFinite(count) || count <= 0 ? null : Math.floor(count) > 99 ? '99+' : String(Math.floor(count));
export function computeOrgInitials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return !w.length ? 'O' : w.length === 1 ? w[0]!.slice(0, 2).toUpperCase() : `${w[0]![0] ?? ''}${w[1]![0] ?? ''}`.toUpperCase();
}
export function resolveOrgLogoUrl(key?: string | null, base = 'https://api.commonswarm.com/storage/v1/object/public/commonswarm-files'): string | null {
  const t = key?.trim() ?? '';
  if (!t || /^(?:javascript|data|vbscript):/i.test(t) || t.startsWith('//') || t.includes('..')) return null;
  return /^https?:\/\//i.test(t) || t.startsWith('/') ? t : `${base.replace(/\/$/, '')}/${t.replace(/^\//, '')}`;
}
export const escapeHtml = (v: string): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function effRole(s: OrgChannelAuthorityState, c: CallerContext, orgId: string): OrgRole {
  if (c.principal_kind === 'user') return orgRole(s, orgId, 'user', c.principal_id) ?? 'guest';
  const uRole = ((o) => (o ? orgRole(s, orgId, 'user', o) : null))(agentOwner(s, c));
  return uRole === 'guest' ? 'guest' : orgRole(s, orgId, 'agent', c.principal_id) ?? (uRole ? 'member' : 'guest');
}

export function toOrgSwitcherItemVM(org: OrganizationSummary, role: OrgRole, current: boolean, workspaceCount: number, unreadCount = 0) {
  const logoUrl = resolveOrgLogoUrl(org.logo_object_key), logoObjectKey = org.logo_object_key?.trim() || null;
  const unread = Number.isFinite(unreadCount) && unreadCount > 0 ? Math.floor(unreadCount) : 0;
  return {
    orgId: org.id, slug: org.slug, displayName: org.display_name, role, roleLabel: formatOrgRoleBadge(role),
    logoObjectKey, logoUrl, logoInitials: computeOrgInitials(org.display_name), hasCustomLogo: logoUrl !== null,
    uploadPlaceholderLabel: role === 'owner' || role === 'admin' ? `Upload organization logo for ${org.display_name}` : `${org.display_name} logo`,
    current, workspaceCount, unreadCount: unread, unreadBadge: formatOrgUnreadBadge(unread),
  };
}

export function deriveOrgHeaderSwitcherVM(s0: OrgChannelAuthorityState, c: CallerContext, opt: Record<string, any> = {}) {
  const s: OrgChannelAuthorityState = { ...s0, privateChannelsEnabled: s0.privateChannelsEnabled === true };
  const orgs = s.organizations.filter((o) => isLive(o) && canReadOrg(s, c, o.id));
  if (!orgs.length) throw new Error('Caller has no reachable organizations');
  const curOrg = orgs.find((o) => o.id === opt.activeOrgId || o.slug === opt.activeOrgId) ?? orgs[0]!;
  const oU = opt.orgUnreadCounts ?? {}, cU = opt.unreadCounts ?? {};
  const organizations = orgs.map((o) => {
    const role = effRole(s, c, o.id);
    const ws = s.workspaces.filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, c, w.workspace_id));
    const u = oU[o.id] ?? cU[o.id] ?? ws.reduce((sum, w) => sum + s.channels.filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(s, c, ch.channel_id)).reduce((a, ch) => a + Math.max(0, Math.floor(cU[ch.channel_id] ?? 0)), 0), 0);
    return toOrgSwitcherItemVM(o, role, o.id === curOrg.id, ws.length, u);
  });
  const activeOrg = organizations.find((i) => i.current) ?? organizations[0]!;
  const orgWs = s.workspaces.filter((w) => w.org_id === activeOrg.orgId && isLive(w) && canReadWorkspace(s, c, w.workspace_id));
  const curWs = orgWs.find((w) => w.workspace_id === opt.activeWorkspaceId || w.slug === opt.activeWorkspaceId) ?? orgWs[0] ?? null;
  const wsRole = curWs ? (s.workspaceGrants.find((g) => g.workspace_id === curWs.workspace_id && g.principal_kind === c.principal_kind && g.principal_id === c.principal_id && isLive(g))?.role ?? activeOrg.role) : activeOrg.role;
  const activeWorkspace = curWs ? { workspaceId: curWs.workspace_id, slug: curWs.slug, name: curWs.name, role: wsRole, roleLabel: formatOrgRoleBadge(wsRole) } : null;
  return { activeOrg, activeWorkspace, organizations, switcherOpen: Boolean(opt.switcherOpen), workspaceMenuOpen: Boolean(opt.workspaceMenuOpen), canManageOrgSettings: activeOrg.role === 'owner' || activeOrg.role === 'admin' };
}

export function renderOrgLogoBadgeHtml(
  o: Pick<OrgSwitcherItemVM, 'displayName' | 'logoObjectKey' | 'logoUrl' | 'logoInitials' | 'hasCustomLogo' | 'uploadPlaceholderLabel'>,
  sz: 32 | 24 = 32,
): string {
  const c = `cs-org-logo--${sz}`;
  if (o.hasCustomLogo && o.logoObjectKey && o.logoUrl) {
    const k = escapeHtml(o.logoObjectKey), l = `${escapeHtml(o.displayName)} logo`;
    return `<span class="cs-org-logo ${c}" data-org-logo="${k}" data-logo-object-key="${k}" role="img" aria-label="${l}"><img class="cs-org-logo__img" src="${escapeHtml(o.logoUrl)}" alt="${l}" width="${sz}" height="${sz}" /></span>`;
  }
  const l = escapeHtml(o.uploadPlaceholderLabel), i = escapeHtml(o.logoInitials);
  return `<span class="cs-org-logo-placeholder logo-placeholder ${c}" data-org-logo-placeholder="${i}" data-org-logo-upload-placeholder="true" role="img" aria-label="${l}" title="${l}">${i}</span>`;
}

export function renderOrgHeaderIdentityHtml(vm: OrgHeaderSwitcherVM): string {
  const o = vm.activeOrg, wn = escapeHtml(vm.activeWorkspace?.name ?? 'No workspace selected'), ws = escapeHtml(vm.activeWorkspace?.slug ?? ''), os = escapeHtml(o.slug), on = escapeHtml(o.displayName), ic = renderKylonIcon('chevron');
  return `<div class="identity" data-org-header-identity="${os}"><button type="button" class="org-button" id="org-trigger" data-action="org-menu" data-org-switcher-trigger="${os}" aria-haspopup="menu" aria-expanded="${vm.switcherOpen}" aria-controls="org-menu">${renderOrgLogoBadgeHtml(o, 32)}<span class="cs-org-header-copy"><strong id="org-name" class="cs-org-name" data-org-name="${on}">${on}</strong><span class="badge cs-org-role-badge" data-org-role-badge="${escapeHtml(o.role)}">${escapeHtml(o.roleLabel)}</span></span>${ic}</button><button type="button" class="workspace-button" id="workspace-trigger" data-action="workspace" data-workspace-switcher-trigger="${ws}" aria-haspopup="menu" aria-controls="workspace-menu" aria-expanded="${vm.workspaceMenuOpen}"><span id="workspace-label" data-workspace-name="${wn}">${wn}</span>${ic}</button></div>`;
}

export function renderOrgSwitcherMenuHtml(vm: OrgHeaderSwitcherVM): string {
  const rows = vm.organizations.map((o) => {
    const chk = o.current ? renderKylonIcon('check', 'cs-org-check') : '', uM = o.unreadBadge ? ` · ${escapeHtml(o.unreadBadge)} unread` : '';
    const uP = `<span class="count cs-unread-pill" data-org-unread-count="${o.unreadCount}"${o.unreadBadge ? '' : ' hidden'}>${escapeHtml(o.unreadBadge ?? '0')}</span>`;
    const n = escapeHtml(o.displayName), r = escapeHtml(o.role), rl = escapeHtml(o.roleLabel);
    return `<button type="button" role="menuitemradio" aria-checked="${o.current}" aria-current="${o.current}" data-org="${n}" data-org-id="${escapeHtml(o.orgId)}" data-org-slug="${escapeHtml(o.slug)}" data-org-role="${r}" data-org-unread-count="${o.unreadCount}">${renderOrgLogoBadgeHtml(o, 24)}<span class="cs-org-switcher-item__copy"><strong class="cs-org-switcher-item__name">${n}</strong><small class="cs-org-switcher-item__meta">${rl} · ${o.workspaceCount} ${o.workspaceCount === 1 ? 'workspace' : 'workspaces'}${uM}</small></span><span class="badge" data-org-item-role-badge="${r}">${rl}</span>${uP}${chk}</button>`;
  }).join('');
  const acts = ORG_SWITCHER_ACTIONS.map((a) => `<button type="button" role="menuitem" data-org-action="${escapeHtml(a.id)}"${a.dataView ? ` data-view="${escapeHtml(a.dataView)}"` : ''}${a.dataAction ? ` data-action="${escapeHtml(a.dataAction)}"` : ''}>${escapeHtml(a.label)}</button>`).join('');
  return `<div class="popover" id="org-menu" role="menu" style="top:58px;left:64px" aria-label="Organization switcher"${vm.switcherOpen ? '' : ' hidden'}><p class="cs-popover-heading">Organizations</p><div>${rows}</div><hr/><div>${acts}</div></div>`;
}

export function anchorSwitcherPopover(
  trig?: Pick<OrgDomElement, 'getBoundingClientRect'> | null,
  pop?: Pick<OrgDomElement, 'style' | 'setAttribute' | 'dataset'> | null,
  fbTop = 58, fbLeft = 64,
): { top: string; left: string } {
  const r = trig?.getBoundingClientRect?.();
  const top = `${Math.max(8, Math.round((r?.bottom ?? fbTop - 6) + 6))}px`, left = `${Math.max(8, Math.round(r?.left ?? fbLeft))}px`;
  if (pop) {
    if (pop.style) { pop.style.top = top; pop.style.left = left; }
    pop.setAttribute?.('style', `top: ${top}; left: ${left};`);
    if (pop.dataset) { pop.dataset.anchorTop = top; pop.dataset.anchorLeft = left; }
  }
  return { top, left };
}

export const renderOrgHeaderSwitcherHtml = (vm: OrgHeaderSwitcherVM) => ({
  identityHtml: renderOrgHeaderIdentityHtml(vm), popoverHtml: renderOrgSwitcherMenuHtml(vm),
});

export function buildOrgHeaderSwitcherDom(doc: OrgDomDocument, vm: OrgHeaderSwitcherVM, cb: OrgHeaderSwitcherCallbacks = {}) {
  const mk = (tag: string, cls: string, attrs: Record<string, string> = {}, data: Record<string, string> = {}, text: string | null = null, id?: string) => {
    const el = doc.createElement(tag);
    el.className = cls; if (id) el.id = id; if (text !== null) el.textContent = text;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    Object.assign(el.dataset, data);
    return el;
  };
  const o = vm.activeOrg, idEl = mk('div', 'identity', {}, { orgHeaderIdentity: o.slug });
  const orgBtn = mk('button', 'org-button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(vm.switcherOpen), 'aria-controls': 'org-menu' }, { action: 'org-menu', orgSwitcherTrigger: o.slug }, null, 'org-trigger');
  orgBtn.append(mk('strong', 'cs-org-name', {}, { orgName: o.displayName }, o.displayName, 'org-name'), mk('span', 'badge cs-org-role-badge', {}, { orgRoleBadge: o.role }, o.roleLabel));
  const wsName = vm.activeWorkspace?.name ?? 'No workspace selected';
  const wsBtn = mk('button', 'workspace-button', { type: 'button', 'aria-haspopup': 'menu', 'aria-controls': 'workspace-menu', 'aria-expanded': String(vm.workspaceMenuOpen) }, { action: 'workspace', workspaceSwitcherTrigger: vm.activeWorkspace?.slug ?? '' }, wsName, 'workspace-trigger');
  idEl.append(orgBtn, wsBtn);
  const popEl = mk('div', 'popover', { role: 'menu', 'aria-label': 'Organization switcher', style: 'top: 58px; left: 64px;' }, { orgSwitcherMenu: 'true', anchorFor: 'org-trigger' }, null, 'org-menu');
  popEl.hidden = !vm.switcherOpen;
  if (vm.switcherOpen) anchorSwitcherPopover(orgBtn, popEl, 58, 64);
  const btns: OrgDomElement[] = [];
  let idx = Math.max(0, vm.organizations.findIndex((i) => i.current));
  const setOpen = (open: boolean, restore = false) => {
    popEl.hidden = !open; if (open) anchorSwitcherPopover(orgBtn, popEl, 58, 64);
    orgBtn.setAttribute('aria-expanded', String(open)); cb.onToggleOrgSwitcher?.(open);
    if (!open && restore) orgBtn.focus?.();
  };
  for (const item of vm.organizations) {
    const b = mk('button', '', { type: 'button', role: 'menuitemradio', 'aria-checked': String(item.current), 'aria-current': String(item.current) }, { org: item.displayName, orgId: item.orgId, orgSlug: item.slug, orgRole: item.role, orgUnreadCount: String(item.unreadCount) }, item.displayName);
    b.addEventListener?.('click', () => { setOpen(false, true); cb.onSelectOrg?.(item.orgId, item.slug); });
    btns.push(b); popEl.append(b);
  }
  for (const act of ORG_SWITCHER_ACTIONS) {
    const b = mk('button', '', { type: 'button', role: 'menuitem' }, { orgAction: act.id }, act.label);
    b.addEventListener?.('click', () => {
      setOpen(false, true);
      if (act.id === 'org-members') cb.onOpenOrgMembers?.();
      else if (act.id === 'org-settings-logo') cb.onOpenOrgSettingsLogo?.();
      else if (act.id === 'new-organization') cb.onCreateOrganization?.();
    });
    btns.push(b); popEl.append(b);
  }
  orgBtn.addEventListener?.('click', () => { const open = Boolean(popEl.hidden); setOpen(open, !open); if (open) btns[idx]?.focus?.(); });
  orgBtn.addEventListener?.('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault?.(); setOpen(true, false); idx = e.key === 'ArrowUp' ? Math.max(0, btns.length - 1) : 0; btns[idx]?.focus?.(); }
    else if (e.key === 'Escape' && !popEl.hidden) { e.preventDefault?.(); setOpen(false, true); }
  });
  wsBtn.addEventListener?.('click', () => { const open = wsBtn.getAttribute?.('aria-expanded') !== 'true'; wsBtn.setAttribute('aria-expanded', String(open)); cb.onToggleWorkspaceSwitcher?.(open); });
  wsBtn.addEventListener?.('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault?.(); wsBtn.setAttribute('aria-expanded', 'false'); cb.onToggleWorkspaceSwitcher?.(false); wsBtn.focus?.(); } });
  popEl.addEventListener?.('keydown', (e) => {
    if (!btns.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') { e.preventDefault?.(); idx = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (idx + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length; btns[idx]?.focus?.(); }
    else if (e.key === 'Escape') { e.preventDefault?.(); setOpen(false, true); }
  });
  return { identityEl: idEl, popoverEl: popEl };
}
