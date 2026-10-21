import {
  type CallerContext,
  type OrgChannelAuthorityState,
  type OrganizationSummary,
  type OrgRole,
  agentOwner,
  canReadChannel,
  canReadOrg,
  canReadWorkspace,
  isLive,
  orgRole,
} from '../../../../../../src/protocol/org-channels-contract.js';

export const ORG_ROLE_ORDER: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'] as const;
export const ORG_ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

export const ORG_SWITCHER_ACTIONS = [
  { id: 'org-members', label: 'Organization Members', dataView: 'members', dataAction: 'org-members' },
  { id: 'org-settings-logo', label: 'Organization Settings / Logo', dataView: 'settings', dataAction: 'logo' },
  { id: 'new-organization', label: '+ New Organization', dataView: null, dataAction: 'new-org' },
] as const;

export interface OrgSwitcherItemVM {
  orgId: string; slug: string; displayName: string; role: OrgRole; roleLabel: string;
  logoObjectKey: string | null; logoUrl: string | null; logoInitials: string;
  hasCustomLogo: boolean; uploadPlaceholderLabel: string; current: boolean;
  workspaceCount: number; unreadCount: number; unreadBadge: string | null;
}

export interface ActiveWorkspaceHeaderVM {
  workspaceId: string; slug: string; name: string; role: OrgRole; roleLabel: string;
}

export interface OrgHeaderSwitcherVM {
  activeOrg: OrgSwitcherItemVM; activeWorkspace: ActiveWorkspaceHeaderVM | null;
  organizations: OrgSwitcherItemVM[]; switcherOpen: boolean; workspaceMenuOpen: boolean; canManageOrgSettings: boolean;
}

export interface OrgDomElement {
  tagName?: string; className: string; id?: string; textContent: string | null; hidden?: boolean;
  dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void;
  getAttribute?(name: string): string | null;
  append(...nodes: Array<OrgDomElement | string>): void;
  focus?(): void;
  addEventListener?(type: string, listener: (e: { key?: string; preventDefault?(): void }) => void): void;
}

export interface OrgDomDocument { createElement(tag: string): OrgDomElement; }

export interface OrgHeaderSwitcherCallbacks {
  onSelectOrg?: (orgId: string, slug: string) => void;
  onToggleOrgSwitcher?: (open: boolean) => void;
  onToggleWorkspaceSwitcher?: (open: boolean) => void;
  onOpenOrgMembers?: () => void;
  onOpenOrgSettingsLogo?: () => void;
  onCreateOrganization?: () => void;
}

export function formatOrgRoleBadge(role: OrgRole): string {
  return ORG_ROLE_LABELS[role] ?? 'Member';
}

export function formatOrgUnreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.floor(count);
  return n > 99 ? '99+' : String(n);
}

export function computeOrgInitials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return 'O';
  return w.length === 1 ? w[0]!.slice(0, 2).toUpperCase() : `${w[0]![0] ?? ''}${w[1]![0] ?? ''}`.toUpperCase();
}

export function resolveOrgLogoUrl(
  key?: string | null,
  base = 'https://api.commonswarm.com/storage/v1/object/public/commonswarm-files',
): string | null {
  const t = key?.trim() ?? '';
  if (!t || /^(?:javascript|data|vbscript):/i.test(t) || t.startsWith('//') || t.includes('..')) return null;
  return /^https?:\/\//i.test(t) || t.startsWith('/') ? t : `${base.replace(/\/$/, '')}/${t.replace(/^\//, '')}`;
}

export function escapeHtml(v: string): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function effRole(s: OrgChannelAuthorityState, c: CallerContext, orgId: string): OrgRole {
  if (c.principal_kind === 'user') return orgRole(s, orgId, 'user', c.principal_id) ?? 'guest';
  const uRole = ((o) => (o ? orgRole(s, orgId, 'user', o) : null))(agentOwner(s, c));
  return uRole === 'guest' ? 'guest' : orgRole(s, orgId, 'agent', c.principal_id) ?? (uRole ? 'member' : 'guest');
}

export function toOrgSwitcherItemVM(
  org: OrganizationSummary,
  role: OrgRole,
  current: boolean,
  workspaceCount: number,
  unreadCount = 0,
): OrgSwitcherItemVM {
  const logoUrl = resolveOrgLogoUrl(org.logo_object_key);
  const logoObjectKey = org.logo_object_key?.trim() || null;
  const unread = Number.isFinite(unreadCount) && unreadCount > 0 ? Math.floor(unreadCount) : 0;
  return {
    orgId: org.id,
    slug: org.slug,
    displayName: org.display_name,
    role,
    roleLabel: formatOrgRoleBadge(role),
    logoObjectKey,
    logoUrl,
    logoInitials: computeOrgInitials(org.display_name),
    hasCustomLogo: logoUrl !== null,
    uploadPlaceholderLabel: role === 'owner' || role === 'admin' ? `Upload organization logo for ${org.display_name}` : `${org.display_name} logo`,
    current,
    workspaceCount,
    unreadCount: unread,
    unreadBadge: formatOrgUnreadBadge(unread),
  };
}

export function deriveOrgHeaderSwitcherVM(
  state: OrgChannelAuthorityState,
  caller: CallerContext,
  opt: {
    activeOrgId?: string | null;
    activeWorkspaceId?: string | null;
    switcherOpen?: boolean;
    workspaceMenuOpen?: boolean;
    orgUnreadCounts?: Record<string, number>;
    unreadCounts?: Record<string, number>;
  } = {},
): OrgHeaderSwitcherVM {
  const s: OrgChannelAuthorityState = { ...state, privateChannelsEnabled: state.privateChannelsEnabled === true };
  const orgs = s.organizations.filter((o) => isLive(o) && canReadOrg(s, caller, o.id));
  if (!orgs.length) throw new Error('Caller has no reachable organizations');

  const curOrg = orgs.find((o) => o.id === opt.activeOrgId || o.slug === opt.activeOrgId) ?? orgs[0]!;
  const oUnreads = opt.orgUnreadCounts ?? {};
  const cUnreads = opt.unreadCounts ?? {};

  const organizations = orgs.map((o) => {
    const role = effRole(s, caller, o.id);
    const wsList = s.workspaces.filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, caller, w.workspace_id));
    const direct = oUnreads[o.id] ?? oUnreads[o.slug] ?? cUnreads[o.id] ?? cUnreads[o.slug];
    const unread =
      direct !== undefined
        ? direct
        : wsList.reduce((sum, w) => {
            const chs = s.channels.filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(s, caller, ch.channel_id));
            return sum + chs.reduce((a, ch) => a + Math.max(0, Math.floor(cUnreads[ch.channel_id] ?? cUnreads[ch.slug] ?? 0)), 0);
          }, 0);
    return toOrgSwitcherItemVM(o, role, o.id === curOrg.id, wsList.length, unread);
  });

  const activeOrg = organizations.find((i) => i.current) ?? organizations[0]!;
  const orgWs = s.workspaces.filter((w) => w.org_id === activeOrg.orgId && isLive(w) && canReadWorkspace(s, caller, w.workspace_id));
  const curWs = orgWs.find((w) => w.workspace_id === opt.activeWorkspaceId || w.slug === opt.activeWorkspaceId) ?? orgWs[0] ?? null;

  let activeWorkspace: ActiveWorkspaceHeaderVM | null = null;
  if (curWs) {
    const gRole = s.workspaceGrants.find(
      (g) => g.workspace_id === curWs.workspace_id && g.principal_kind === caller.principal_kind && g.principal_id === caller.principal_id && isLive(g),
    )?.role;
    const role = gRole ?? activeOrg.role;
    activeWorkspace = { workspaceId: curWs.workspace_id, slug: curWs.slug, name: curWs.name, role, roleLabel: formatOrgRoleBadge(role) };
  }

  return {
    activeOrg,
    activeWorkspace,
    organizations,
    switcherOpen: Boolean(opt.switcherOpen),
    workspaceMenuOpen: Boolean(opt.workspaceMenuOpen),
    canManageOrgSettings: activeOrg.role === 'owner' || activeOrg.role === 'admin',
  };
}

export function renderOrgLogoBadgeHtml(
  o: Pick<OrgSwitcherItemVM, 'displayName' | 'logoObjectKey' | 'logoUrl' | 'logoInitials' | 'hasCustomLogo' | 'uploadPlaceholderLabel'>,
  sz: 32 | 24 = 32,
): string {
  const c = `cs-org-logo--${sz}`;
  if (o.hasCustomLogo && o.logoObjectKey && o.logoUrl) {
    const k = escapeHtml(o.logoObjectKey);
    const l = `${escapeHtml(o.displayName)} logo`;
    return `<span class="cs-org-logo ${c}" data-org-logo="${k}" data-logo-object-key="${k}" role="img" aria-label="${l}"><img class="cs-org-logo__img" src="${escapeHtml(o.logoUrl)}" alt="${l}" width="${sz}" height="${sz}" /></span>`;
  }
  const l = escapeHtml(o.uploadPlaceholderLabel);
  const i = escapeHtml(o.logoInitials);
  return `<span class="cs-org-logo-placeholder logo-placeholder ${c}" data-org-logo-placeholder="${i}" data-org-logo-upload-placeholder="true" role="img" aria-label="${l}" title="${l}">${i}</span>`;
}

export function renderOrgHeaderIdentityHtml(vm: OrgHeaderSwitcherVM): string {
  const o = vm.activeOrg;
  const wn = escapeHtml(vm.activeWorkspace?.name ?? 'No workspace selected');
  const ws = escapeHtml(vm.activeWorkspace?.slug ?? '');
  const os = escapeHtml(o.slug);
  const on = escapeHtml(o.displayName);
  const ic = '<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>';
  return `<div class="identity cs-org-identity" data-org-header-identity="${os}"><button type="button" class="org-button cs-org-header-trigger" id="org-trigger" data-action="org-menu" data-org-switcher-trigger="${os}" aria-haspopup="menu" aria-expanded="${vm.switcherOpen}" aria-controls="org-menu">${renderOrgLogoBadgeHtml(o, 32)}<span class="cs-org-header-copy"><strong id="org-name" class="cs-org-name" data-org-name="${on}">${on}</strong><span class="badge cs-org-role-badge" data-org-role-badge="${escapeHtml(o.role)}">${escapeHtml(o.roleLabel)}</span></span>${ic}</button><button type="button" class="workspace-button cs-workspace-header-trigger" id="workspace-trigger" data-action="workspace" data-workspace-switcher-trigger="${ws}" aria-haspopup="menu" aria-controls="workspace-menu" aria-expanded="${vm.workspaceMenuOpen}"><span id="workspace-label" data-workspace-name="${wn}">${wn}</span>${ic}</button></div>`;
}

export function renderOrgSwitcherMenuHtml(vm: OrgHeaderSwitcherVM): string {
  const rows = vm.organizations
    .map((o) => {
      const chk = o.current ? '<svg class="icon cs-org-check" aria-hidden="true"><use href="#i-check"/></svg>' : '';
      const uMeta = o.unreadBadge ? ` · ${escapeHtml(o.unreadBadge)} unread` : '';
      const uPill = `<span class="count cs-unread-pill cs-org-unread-pill" data-org-unread-count="${o.unreadCount}"${o.unreadBadge ? '' : ' hidden'}>${escapeHtml(o.unreadBadge ?? '0')}</span>`;
      const n = escapeHtml(o.displayName);
      const r = escapeHtml(o.role);
      const rl = escapeHtml(o.roleLabel);
      return `<button type="button" class="cs-org-switcher-item" role="menuitemradio" aria-checked="${o.current}" aria-current="${o.current}" data-org="${n}" data-org-id="${escapeHtml(o.orgId)}" data-org-slug="${escapeHtml(o.slug)}" data-org-role="${r}" data-org-unread-count="${o.unreadCount}">${renderOrgLogoBadgeHtml(o, 24)}<span class="cs-org-switcher-item__copy"><strong class="cs-org-switcher-item__name">${n}</strong><small class="cs-org-switcher-item__meta">${rl} · ${o.workspaceCount} ${o.workspaceCount === 1 ? 'workspace' : 'workspaces'}${uMeta}</small></span><span class="badge cs-org-item-role" data-org-item-role-badge="${r}">${rl}</span>${uPill}${chk}</button>`;
    })
    .join('');
  const acts = ORG_SWITCHER_ACTIONS.map((a) => {
    const v = a.dataView ? ` data-view="${escapeHtml(a.dataView)}"` : '';
    const d = a.dataAction ? ` data-action="${escapeHtml(a.dataAction)}"` : '';
    return `<button type="button" class="cs-org-switcher-action" role="menuitem" data-org-action="${escapeHtml(a.id)}"${v}${d}>${escapeHtml(a.label)}</button>`;
  }).join('');
  return `<div class="popover cs-org-switcher-popover" id="org-menu" role="menu" data-org-switcher-menu="true" aria-label="Organization switcher"${vm.switcherOpen ? '' : ' hidden'}><p class="cs-popover-heading">Organizations</p><div class="cs-org-switcher-list" data-org-switcher-list="true">${rows}</div><hr/><div class="cs-org-switcher-actions" data-org-switcher-actions="true">${acts}</div></div>`;
}

export function renderOrgHeaderSwitcherHtml(vm: OrgHeaderSwitcherVM): { identityHtml: string; popoverHtml: string } {
  return { identityHtml: renderOrgHeaderIdentityHtml(vm), popoverHtml: renderOrgSwitcherMenuHtml(vm) };
}

export function buildOrgHeaderSwitcherDom(
  doc: OrgDomDocument,
  vm: OrgHeaderSwitcherVM,
  cb: OrgHeaderSwitcherCallbacks = {},
): { identityEl: OrgDomElement; popoverEl: OrgDomElement } {
  const mk = (tag: string, cls: string, attrs: Record<string, string> = {}, data: Record<string, string> = {}, text: string | null = null, id?: string) => {
    const el = doc.createElement(tag);
    el.className = cls;
    if (id) el.id = id;
    if (text !== null) el.textContent = text;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    Object.assign(el.dataset, data);
    return el;
  };
  const o = vm.activeOrg;
  const idEl = mk('div', 'identity cs-org-identity', {}, { orgHeaderIdentity: o.slug });
  const orgBtn = mk('button', 'org-button cs-org-header-trigger', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(vm.switcherOpen), 'aria-controls': 'org-menu',
  }, { action: 'org-menu', orgSwitcherTrigger: o.slug }, null, 'org-trigger');

  const logoEl = o.hasCustomLogo && o.logoObjectKey && o.logoUrl
    ? mk('span', 'cs-org-logo cs-org-logo--32', { role: 'img', 'aria-label': `${o.displayName} logo` }, { orgLogo: o.logoObjectKey, logoObjectKey: o.logoObjectKey })
    : mk('span', 'cs-org-logo-placeholder logo-placeholder cs-org-logo--32', { role: 'img', 'aria-label': o.uploadPlaceholderLabel }, { orgLogoPlaceholder: o.logoInitials, orgLogoUploadPlaceholder: 'true' }, o.logoInitials);
  if (o.hasCustomLogo && o.logoObjectKey && o.logoUrl) {
    logoEl.append(mk('img', 'cs-org-logo__img', { src: o.logoUrl, alt: `${o.displayName} logo`, width: '32', height: '32' }));
  }

  orgBtn.append(
    logoEl,
    mk('strong', 'cs-org-name', {}, { orgName: o.displayName }, o.displayName, 'org-name'),
    mk('span', 'badge cs-org-role-badge', {}, { orgRoleBadge: o.role }, o.roleLabel),
  );

  const wsName = vm.activeWorkspace?.name ?? 'No workspace selected';
  const wsBtn = mk('button', 'workspace-button cs-workspace-header-trigger', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-controls': 'workspace-menu', 'aria-expanded': String(vm.workspaceMenuOpen),
  }, { action: 'workspace', workspaceSwitcherTrigger: vm.activeWorkspace?.slug ?? '' }, null, 'workspace-trigger');
  wsBtn.append(mk('span', '', {}, { workspaceName: wsName }, wsName, 'workspace-label'));
  idEl.append(orgBtn, wsBtn);

  const popEl = mk('div', 'popover cs-org-switcher-popover', { role: 'menu', 'aria-label': 'Organization switcher' }, { orgSwitcherMenu: 'true' }, null, 'org-menu');
  popEl.hidden = !vm.switcherOpen;

  const btns: OrgDomElement[] = [];
  let idx = Math.max(0, vm.organizations.findIndex((i) => i.current));
  const setOpen = (open: boolean, restore = false) => {
    popEl.hidden = !open;
    orgBtn.setAttribute('aria-expanded', String(open));
    cb.onToggleOrgSwitcher?.(open);
    if (!open && restore) orgBtn.focus?.();
  };

  for (const item of vm.organizations) {
    const b = mk(
      'button',
      'cs-org-switcher-item',
      { type: 'button', role: 'menuitemradio', 'aria-checked': String(item.current), 'aria-current': String(item.current) },
      { org: item.displayName, orgId: item.orgId, orgSlug: item.slug, orgRole: item.role, orgUnreadCount: String(item.unreadCount) },
      `${item.displayName} (${item.roleLabel}${item.unreadBadge ? ` · ${item.unreadBadge} unread` : ''})`,
    );
    b.addEventListener?.('click', () => { setOpen(false, true); cb.onSelectOrg?.(item.orgId, item.slug); });
    btns.push(b);
    popEl.append(b);
  }

  for (const act of ORG_SWITCHER_ACTIONS) {
    const data: Record<string, string> = { orgAction: act.id };
    if (act.dataView) data.view = act.dataView;
    if (act.dataAction) data.action = act.dataAction;
    const b = mk('button', 'cs-org-switcher-action', { type: 'button', role: 'menuitem' }, data, act.label);
    b.addEventListener?.('click', () => {
      setOpen(false, true);
      if (act.id === 'org-members') cb.onOpenOrgMembers?.();
      else if (act.id === 'org-settings-logo') cb.onOpenOrgSettingsLogo?.();
      else if (act.id === 'new-organization') cb.onCreateOrganization?.();
    });
    btns.push(b);
    popEl.append(b);
  }

  orgBtn.addEventListener?.('click', () => {
    const open = Boolean(popEl.hidden);
    setOpen(open, !open);
    if (open) btns[idx]?.focus?.();
  });
  orgBtn.addEventListener?.('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault?.();
      setOpen(true, false);
      idx = e.key === 'ArrowUp' ? Math.max(0, btns.length - 1) : 0;
      btns[idx]?.focus?.();
    } else if (e.key === 'Escape' && !popEl.hidden) {
      e.preventDefault?.();
      setOpen(false, true);
    }
  });
  wsBtn.addEventListener?.('click', () => {
    const open = wsBtn.getAttribute?.('aria-expanded') !== 'true';
    wsBtn.setAttribute('aria-expanded', String(open));
    cb.onToggleWorkspaceSwitcher?.(open);
  });
  wsBtn.addEventListener?.('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault?.();
      wsBtn.setAttribute('aria-expanded', 'false');
      cb.onToggleWorkspaceSwitcher?.(false);
      wsBtn.focus?.();
    }
  });
  popEl.addEventListener?.('keydown', (e) => {
    if (!btns.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault?.();
      idx = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (idx + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
      btns[idx]?.focus?.();
    } else if (e.key === 'Escape') {
      e.preventDefault?.();
      setOpen(false, true);
    }
  });

  return { identityEl: idEl, popoverEl: popEl };
}
