import {
  type CallerContext,
  type OrgChannelAuthorityState,
  type OrganizationSummary,
  type OrgRole,
  agentOwner,
  canReadOrg,
  canReadWorkspace,
  isLive,
  orgRole,
} from '../../../../../../src/protocol/org-channels-contract.js';

export const ORG_ROLE_ORDER: readonly OrgRole[] = [
  'owner',
  'admin',
  'member',
  'guest',
] as const;

export const ORG_ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

export const ORG_SWITCHER_ACTIONS = [
  {
    id: 'org-members',
    label: 'Organization Members',
    dataView: 'members',
    dataAction: 'org-members',
  },
  {
    id: 'org-settings-logo',
    label: 'Organization Settings / Logo',
    dataView: 'settings',
    dataAction: 'logo',
  },
  {
    id: 'new-organization',
    label: '+ New Organization',
    dataView: null,
    dataAction: 'new-org',
  },
] as const;

export interface OrgSwitcherItemVM {
  orgId: string;
  slug: string;
  displayName: string;
  role: OrgRole;
  roleLabel: string;
  logoObjectKey: string | null;
  logoUrl: string | null;
  logoInitials: string;
  hasCustomLogo: boolean;
  uploadPlaceholderLabel: string;
  current: boolean;
  workspaceCount: number;
}

export interface ActiveWorkspaceHeaderVM {
  workspaceId: string;
  slug: string;
  name: string;
  role: OrgRole;
  roleLabel: string;
}

export interface OrgHeaderSwitcherVM {
  activeOrg: OrgSwitcherItemVM;
  activeWorkspace: ActiveWorkspaceHeaderVM | null;
  organizations: OrgSwitcherItemVM[];
  switcherOpen: boolean;
  workspaceMenuOpen: boolean;
  canManageOrgSettings: boolean;
}

export interface OrgDomElement {
  tagName?: string;
  className: string;
  id?: string;
  textContent: string | null;
  hidden?: boolean;
  dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void;
  append(...nodes: Array<OrgDomElement | string>): void;
  addEventListener?(
    type: string,
    listener: (event: { preventDefault(): void }) => void,
  ): void;
}

export interface OrgDomDocument {
  createElement(tag: string): OrgDomElement;
}

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

export function computeOrgInitials(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (words.length === 0) return 'O';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
}

export function resolveOrgLogoUrl(
  logoObjectKey?: string | null,
  baseUrl = 'https://api.commonswarm.com/storage/v1/object/public/commonswarm-files',
): string | null {
  const trimmed = logoObjectKey?.trim() ?? '';
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    return trimmed;
  }
  return `${baseUrl.replace(/\/$/, '')}/${trimmed.replace(/^\//, '')}`;
}

export function escapeHtml(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch] ?? ch,
  );
}

function resolveEffectiveOrgRole(
  state: OrgChannelAuthorityState,
  caller: CallerContext,
  orgId: string,
): OrgRole {
  if (caller.principal_kind === 'user') {
    return orgRole(state, orgId, 'user', caller.principal_id) ?? 'guest';
  }
  const direct = orgRole(state, orgId, 'agent', caller.principal_id);
  if (direct) return direct;
  const ownerId = agentOwner(state, caller);
  const inherited = ownerId ? orgRole(state, orgId, 'user', ownerId) : null;
  return inherited ?? 'guest';
}

export function toOrgSwitcherItemVM(
  org: OrganizationSummary,
  role: OrgRole,
  current: boolean,
  workspaceCount: number,
): OrgSwitcherItemVM {
  const logoUrl = resolveOrgLogoUrl(org.logo_object_key);
  const hasCustomLogo = logoUrl !== null;
  const cleanKey = org.logo_object_key?.trim() || null;
  return {
    orgId: org.id,
    slug: org.slug,
    displayName: org.display_name,
    role,
    roleLabel: formatOrgRoleBadge(role),
    logoObjectKey: cleanKey,
    logoUrl,
    logoInitials: computeOrgInitials(org.display_name),
    hasCustomLogo,
    uploadPlaceholderLabel: `Upload organization logo for ${org.display_name}`,
    current,
    workspaceCount,
  };
}

export function deriveOrgHeaderSwitcherVM(
  state: OrgChannelAuthorityState,
  caller: CallerContext,
  options: {
    activeOrgId?: string | null;
    activeWorkspaceId?: string | null;
    switcherOpen?: boolean;
    workspaceMenuOpen?: boolean;
  } = {},
): OrgHeaderSwitcherVM {
  const reachableOrgs = state.organizations.filter(
    (org) => isLive(org) && canReadOrg(state, caller, org.id),
  );
  if (reachableOrgs.length === 0) {
    throw new Error('Caller has no reachable organizations');
  }

  const chosenOrg =
    reachableOrgs.find(
      (org) =>
        org.id === options.activeOrgId || org.slug === options.activeOrgId,
    ) ?? reachableOrgs[0]!;

  const organizations: OrgSwitcherItemVM[] = reachableOrgs.map((org) => {
    const role = resolveEffectiveOrgRole(state, caller, org.id);
    const wsCount = state.workspaces.filter(
      (ws) =>
        ws.org_id === org.id &&
        isLive(ws) &&
        canReadWorkspace(state, caller, ws.workspace_id),
    ).length;
    return toOrgSwitcherItemVM(org, role, org.id === chosenOrg.id, wsCount);
  });

  const activeOrg =
    organizations.find((item) => item.current) ?? organizations[0]!;

  const orgWorkspaces = state.workspaces.filter(
    (ws) =>
      ws.org_id === activeOrg.orgId &&
      isLive(ws) &&
      canReadWorkspace(state, caller, ws.workspace_id),
  );

  const chosenWs =
    orgWorkspaces.find(
      (ws) =>
        ws.workspace_id === options.activeWorkspaceId ||
        ws.slug === options.activeWorkspaceId,
    ) ??
    orgWorkspaces[0] ??
    null;

  let activeWorkspace: ActiveWorkspaceHeaderVM | null = null;
  if (chosenWs) {
    const grantRole = state.workspaceGrants.find(
      (g) =>
        g.workspace_id === chosenWs.workspace_id &&
        g.principal_kind === caller.principal_kind &&
        g.principal_id === caller.principal_id &&
        isLive(g),
    )?.role;
    const wsRole = grantRole ?? activeOrg.role;
    activeWorkspace = {
      workspaceId: chosenWs.workspace_id,
      slug: chosenWs.slug,
      name: chosenWs.name,
      role: wsRole,
      roleLabel: formatOrgRoleBadge(wsRole),
    };
  }

  return {
    activeOrg,
    activeWorkspace,
    organizations,
    switcherOpen: Boolean(options.switcherOpen),
    workspaceMenuOpen: Boolean(options.workspaceMenuOpen),
    canManageOrgSettings:
      activeOrg.role === 'owner' || activeOrg.role === 'admin',
  };
}

export function renderOrgLogoBadgeHtml(
  org: Pick<
    OrgSwitcherItemVM,
    | 'displayName'
    | 'logoObjectKey'
    | 'logoUrl'
    | 'logoInitials'
    | 'hasCustomLogo'
    | 'uploadPlaceholderLabel'
  >,
  size: 32 | 24 = 32,
): string {
  const sizeClass = size === 32 ? 'cs-org-logo--32' : 'cs-org-logo--24';
  if (org.hasCustomLogo && org.logoObjectKey && org.logoUrl) {
    return `<span class="cs-org-logo ${sizeClass}" data-org-logo="${escapeHtml(org.logoObjectKey)}" data-logo-object-key="${escapeHtml(org.logoObjectKey)}" aria-label="${escapeHtml(org.displayName)} logo"><img class="cs-org-logo__img" src="${escapeHtml(org.logoUrl)}" alt="${escapeHtml(org.displayName)} logo" width="${size}" height="${size}" /></span>`;
  }
  return `<span class="cs-org-logo-placeholder logo-placeholder ${sizeClass}" data-org-logo-placeholder="${escapeHtml(org.logoInitials)}" data-org-logo-upload-placeholder="true" role="img" aria-label="${escapeHtml(org.uploadPlaceholderLabel)}" title="${escapeHtml(org.uploadPlaceholderLabel)}">${escapeHtml(org.logoInitials)}</span>`;
}

export function renderOrgHeaderIdentityHtml(vm: OrgHeaderSwitcherVM): string {
  const logoHtml = renderOrgLogoBadgeHtml(vm.activeOrg, 32);
  const wsName = vm.activeWorkspace?.name ?? 'No workspace selected';
  const wsSlug = vm.activeWorkspace?.slug ?? '';
  return `<div class="identity cs-org-identity" data-org-header-identity="${escapeHtml(vm.activeOrg.slug)}"><button type="button" class="org-button cs-org-header-trigger" id="org-trigger" data-action="org-menu" data-org-switcher-trigger="${escapeHtml(vm.activeOrg.slug)}" aria-expanded="${String(vm.switcherOpen)}" aria-controls="org-menu">${logoHtml}<span class="cs-org-header-copy"><strong id="org-name" class="cs-org-name" data-org-name="${escapeHtml(vm.activeOrg.displayName)}">${escapeHtml(vm.activeOrg.displayName)}</strong><span class="badge cs-org-role-badge" data-org-role-badge="${escapeHtml(vm.activeOrg.role)}">${escapeHtml(vm.activeOrg.roleLabel)}</span></span><svg class="icon cs-org-chevron" aria-hidden="true"><use href="#i-chevron"/></svg></button><button type="button" class="workspace-button cs-workspace-header-trigger" id="workspace-trigger" data-action="workspace" data-workspace-switcher-trigger="${escapeHtml(wsSlug)}" aria-controls="workspace-menu" aria-expanded="${String(vm.workspaceMenuOpen)}"><span id="workspace-label" data-workspace-name="${escapeHtml(wsName)}">${escapeHtml(wsName)}</span><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg></button></div>`;
}

export function renderOrgSwitcherMenuHtml(vm: OrgHeaderSwitcherVM): string {
  const orgRows = vm.organizations
    .map((org) => {
      const checkSvg = org.current
        ? '<svg class="icon cs-org-check" aria-hidden="true"><use href="#i-check"/></svg>'
        : '';
      const badge = renderOrgLogoBadgeHtml(org, 24);
      return `<button type="button" class="cs-org-switcher-item" data-org="${escapeHtml(org.displayName)}" data-org-id="${escapeHtml(org.orgId)}" data-org-slug="${escapeHtml(org.slug)}" data-org-role="${escapeHtml(org.role)}" aria-current="${String(org.current)}">${badge}<span class="cs-org-switcher-item__copy"><strong class="cs-org-switcher-item__name">${escapeHtml(org.displayName)}</strong><small class="cs-org-switcher-item__meta">${escapeHtml(org.roleLabel)} · ${org.workspaceCount} ${org.workspaceCount === 1 ? 'workspace' : 'workspaces'}</small></span><span class="badge cs-org-item-role" data-org-item-role-badge="${escapeHtml(org.role)}">${escapeHtml(org.roleLabel)}</span>${checkSvg}</button>`;
    })
    .join('');

  const actionsHtml = ORG_SWITCHER_ACTIONS.map((act) => {
    const viewAttr = act.dataView ? ` data-view="${escapeHtml(act.dataView)}"` : '';
    const actionAttr = act.dataAction ? ` data-action="${escapeHtml(act.dataAction)}"` : '';
    return `<button type="button" class="cs-org-switcher-action" data-org-action="${escapeHtml(act.id)}"${viewAttr}${actionAttr}>${escapeHtml(act.label)}</button>`;
  }).join('');

  const hiddenAttr = vm.switcherOpen ? '' : ' hidden';
  return `<div class="popover cs-org-switcher-popover" id="org-menu" data-org-switcher-menu="true" aria-label="Organization switcher"${hiddenAttr}><p class="cs-popover-heading">Organizations</p><div class="cs-org-switcher-list" data-org-switcher-list="true">${orgRows}</div><hr/><div class="cs-org-switcher-actions" data-org-switcher-actions="true">${actionsHtml}</div></div>`;
}

export function renderOrgHeaderSwitcherHtml(vm: OrgHeaderSwitcherVM): {
  identityHtml: string;
  popoverHtml: string;
} {
  return {
    identityHtml: renderOrgHeaderIdentityHtml(vm),
    popoverHtml: renderOrgSwitcherMenuHtml(vm),
  };
}

export function buildOrgHeaderSwitcherDom(
  doc: OrgDomDocument,
  vm: OrgHeaderSwitcherVM,
  callbacks: OrgHeaderSwitcherCallbacks = {},
): { identityEl: OrgDomElement; popoverEl: OrgDomElement } {
  const identityEl = doc.createElement('div');
  identityEl.className = 'identity cs-org-identity';
  identityEl.dataset.orgHeaderIdentity = vm.activeOrg.slug;

  const orgBtn = doc.createElement('button');
  orgBtn.className = 'org-button cs-org-header-trigger';
  orgBtn.id = 'org-trigger';
  orgBtn.setAttribute('type', 'button');
  orgBtn.setAttribute('aria-expanded', String(vm.switcherOpen));
  orgBtn.setAttribute('aria-controls', 'org-menu');
  orgBtn.dataset.action = 'org-menu';
  orgBtn.dataset.orgSwitcherTrigger = vm.activeOrg.slug;

  const logoEl = doc.createElement('span');
  if (vm.activeOrg.hasCustomLogo && vm.activeOrg.logoObjectKey && vm.activeOrg.logoUrl) {
    logoEl.className = 'cs-org-logo cs-org-logo--32';
    logoEl.dataset.orgLogo = vm.activeOrg.logoObjectKey;
    logoEl.dataset.logoObjectKey = vm.activeOrg.logoObjectKey;
    logoEl.setAttribute('aria-label', `${vm.activeOrg.displayName} logo`);
    const imgEl = doc.createElement('img');
    imgEl.className = 'cs-org-logo__img';
    imgEl.setAttribute('src', vm.activeOrg.logoUrl);
    imgEl.setAttribute('alt', `${vm.activeOrg.displayName} logo`);
    imgEl.setAttribute('width', '32');
    imgEl.setAttribute('height', '32');
    logoEl.append(imgEl);
  } else {
    logoEl.className = 'cs-org-logo-placeholder logo-placeholder cs-org-logo--32';
    logoEl.dataset.orgLogoPlaceholder = vm.activeOrg.logoInitials;
    logoEl.dataset.orgLogoUploadPlaceholder = 'true';
    logoEl.setAttribute('role', 'img');
    logoEl.setAttribute('aria-label', vm.activeOrg.uploadPlaceholderLabel);
    logoEl.textContent = vm.activeOrg.logoInitials;
  }

  const nameEl = doc.createElement('strong');
  nameEl.id = 'org-name';
  nameEl.className = 'cs-org-name';
  nameEl.dataset.orgName = vm.activeOrg.displayName;
  nameEl.textContent = vm.activeOrg.displayName;

  const roleBadgeEl = doc.createElement('span');
  roleBadgeEl.className = 'badge cs-org-role-badge';
  roleBadgeEl.dataset.orgRoleBadge = vm.activeOrg.role;
  roleBadgeEl.textContent = vm.activeOrg.roleLabel;

  orgBtn.append(logoEl, nameEl, roleBadgeEl);
  orgBtn.addEventListener?.('click', () => {
    callbacks.onToggleOrgSwitcher?.(!vm.switcherOpen);
  });

  const wsBtn = doc.createElement('button');
  wsBtn.className = 'workspace-button cs-workspace-header-trigger';
  wsBtn.id = 'workspace-trigger';
  wsBtn.setAttribute('type', 'button');
  wsBtn.setAttribute('aria-controls', 'workspace-menu');
  wsBtn.setAttribute('aria-expanded', String(vm.workspaceMenuOpen));
  wsBtn.dataset.action = 'workspace';
  wsBtn.dataset.workspaceSwitcherTrigger = vm.activeWorkspace?.slug ?? '';

  const wsLabel = doc.createElement('span');
  wsLabel.id = 'workspace-label';
  wsLabel.dataset.workspaceName = vm.activeWorkspace?.name ?? 'No workspace selected';
  wsLabel.textContent = vm.activeWorkspace?.name ?? 'No workspace selected';
  wsBtn.append(wsLabel);
  wsBtn.addEventListener?.('click', () => {
    callbacks.onToggleWorkspaceSwitcher?.(!vm.workspaceMenuOpen);
  });

  identityEl.append(orgBtn, wsBtn);

  const popoverEl = doc.createElement('div');
  popoverEl.className = 'popover cs-org-switcher-popover';
  popoverEl.id = 'org-menu';
  popoverEl.hidden = !vm.switcherOpen;
  popoverEl.dataset.orgSwitcherMenu = 'true';
  popoverEl.setAttribute('aria-label', 'Organization switcher');

  for (const org of vm.organizations) {
    const itemBtn = doc.createElement('button');
    itemBtn.className = 'cs-org-switcher-item';
    itemBtn.setAttribute('type', 'button');
    itemBtn.setAttribute('aria-current', String(org.current));
    itemBtn.dataset.org = org.displayName;
    itemBtn.dataset.orgId = org.orgId;
    itemBtn.dataset.orgSlug = org.slug;
    itemBtn.dataset.orgRole = org.role;
    itemBtn.textContent = `${org.displayName} (${org.roleLabel})`;
    itemBtn.addEventListener?.('click', () => {
      callbacks.onSelectOrg?.(org.orgId, org.slug);
    });
    popoverEl.append(itemBtn);
  }

  for (const act of ORG_SWITCHER_ACTIONS) {
    const actBtn = doc.createElement('button');
    actBtn.className = 'cs-org-switcher-action';
    actBtn.setAttribute('type', 'button');
    actBtn.dataset.orgAction = act.id;
    if (act.dataView) actBtn.dataset.view = act.dataView;
    if (act.dataAction) actBtn.dataset.action = act.dataAction;
    actBtn.textContent = act.label;
    popoverEl.append(actBtn);
  }

  return { identityEl, popoverEl };
}
