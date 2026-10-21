export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type PrincipalKind = 'user' | 'agent';
export type OrgRosterFilter = 'all' | 'people' | 'agents' | 'guests' | 'invites';
export type AgentConnectionState = 'connected' | 'working' | 'idle' | 'needs_authorization' | 'unavailable';

export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'] as const;
export const ORG_ROLE_LABELS: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

export const ORG_ROSTER_FILTER_TABS: ReadonlyArray<{ id: OrgRosterFilter; label: string; shortLabel: string }> = [
  { id: 'all', label: 'All', shortLabel: 'All' },
  { id: 'people', label: 'People', shortLabel: 'People' },
  { id: 'agents', label: 'Agents', shortLabel: 'Agents' },
  { id: 'guests', label: 'Guests', shortLabel: 'Guests' },
  { id: 'invites', label: 'Pending Invites', shortLabel: 'Invites' },
] as const;

export const CREATION_MENU_ACTIONS = [
  { id: 'new-agent', label: 'New Agent', description: 'Configure name, specialty, runtime, and model' },
  { id: 'invite-person', label: 'Invite a Person', description: 'Send an organization invite with role & workspace grants' },
  { id: 'connect-agent', label: 'Connect an Existing Agent', description: 'Bind a standing MCP or CLI agent identity to this org' },
] as const;

export const REVOCATION_SCOPE_DISCLOSURE =
  'Removing this agent from the workspace closes its active seat in this workspace; removing from the organization revokes all workspaces, channels, and seats in this org';

export interface RosterWorkspaceGrant { workspace_id: string; workspace_slug: string; workspace_name: string; role: OrgRole; active_seat_id?: string | null; }
export interface RosterOtherOrgRole { org_id: string; org_slug: string; org_name: string; role: OrgRole; }
export interface OrgRosterMemberItem {
  principal_kind: PrincipalKind; principal_id: string; display_name: string; handle: string; initials: string; role: OrgRole; specialty: string;
  provider?: string; model?: string; skills?: string[]; owner_user_id?: string | null; owner_display_name?: string | null;
  inherits_owner_access?: boolean; explicit_revocation_override?: boolean; connection_state?: AgentConnectionState;
  active_seat_id?: string | null; active_seat_workspace_slug?: string | null; workspace_grants: RosterWorkspaceGrant[];
  other_org_roles?: RosterOtherOrgRole[]; invite_pending?: boolean; invited_email_or_id?: string;
}
export interface OrgMembersScreenProps {
  org_id: string; org_slug: string; org_name: string; current_workspace_id: string; current_workspace_slug: string; current_workspace_name: string;
  actor_role: OrgRole; active_filter: OrgRosterFilter; selected_principal_id?: string | null; active_detail_tab?: 'profile' | 'skills';
  mobileView?: 'list' | 'detail'; mobile_view?: 'list' | 'detail';
  available_workspaces: Array<{ workspace_id: string; slug: string; name: string }>;
  members: OrgRosterMemberItem[];
  pending_removal?: { principal_id: string; scope: 'workspace' | 'organization' } | null;
}
export type OrgMembersScreenState = OrgMembersScreenProps;

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));

export function canChangeOrgRole(actorRole: OrgRole, targetCurrentRole: OrgRole, nextRole: OrgRole): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetCurrentRole !== 'owner' && nextRole !== 'owner';
  return false;
}

export function filterOrgRosterMembers(members: OrgRosterMemberItem[], filter: OrgRosterFilter): OrgRosterMemberItem[] {
  switch (filter) {
    case 'people': return members.filter((m) => !m.invite_pending && m.principal_kind === 'user');
    case 'agents': return members.filter((m) => !m.invite_pending && m.principal_kind === 'agent');
    case 'guests': return members.filter((m) => !m.invite_pending && m.role === 'guest');
    case 'invites': return members.filter((m) => Boolean(m.invite_pending));
    default: return members.filter((m) => !m.invite_pending);
  }
}

export function buildOrgMemberParityCommands(orgSlug: string, workspaceSlug: string, member?: OrgRosterMemberItem) {
  const targetId = member?.principal_id || member?.handle || '<principal-id>';
  const kind = member?.principal_kind || 'user';
  const role = member?.role || 'member';
  return {
    cli_member_add: `cswarm org invite ${targetId} --org ${orgSlug} --kind ${kind} --role ${role}`,
    cli_member_role: `cswarm org role ${targetId} ${role} --org ${orgSlug} --kind ${kind}`,
    cli_workspace_grant: `cswarm org members grant ${targetId} --org ${orgSlug} --workspace ${orgSlug}/${workspaceSlug} --kind ${kind} --role ${role}`,
    cli_workspace_revoke: `cswarm org members revoke ${targetId} --org ${orgSlug} --workspace ${orgSlug}/${workspaceSlug} --kind ${kind}`,
    cli_org_remove: `cswarm org remove ${targetId} --org ${orgSlug} --kind ${kind}`,
    mcp_member_add: 'org_invite_member',
    mcp_member_role: 'org_set_member_role',
    mcp_org_remove: 'org_remove_member',
    mcp_workspace_grant: 'org_assign_workspace_member',
    mcp_workspace_revoke: 'org_remove_workspace_member',
  };
}

const STATUS_LABELS: Record<AgentConnectionState, string> = {
  connected: 'Connected · transport confirmed',
  working: 'Working · active seat open',
  idle: 'Idle · standing credential ready',
  needs_authorization: 'Needs authorization · owner action required',
  unavailable: 'Unavailable · connection offline',
};

export function renderOrgRosterListItem(member: OrgRosterMemberItem, selectedId?: string | null): string {
  const ag = member.principal_kind === 'agent';
  const roleLabel = ORG_ROLE_LABELS[member.role];
  const seatSummary = ag
    ? member.active_seat_id ? `Active seat: ${esc(member.active_seat_id)} (${esc(member.active_seat_workspace_slug ?? 'workspace')})` : 'No active seat'
    : `${member.workspace_grants.length} workspace${member.workspace_grants.length === 1 ? '' : 's'}`;
  return `<button type="button" class="member-row" data-member-id="${esc(member.principal_id)}" data-principal-kind="${esc(member.principal_kind)}" aria-current="${member.principal_id === selectedId ? 'true' : 'false'}"><span class="avatar ${ag ? 'agent' : ''}" aria-hidden="true">${esc(member.initials)}</span><span class="member-row-copy"><strong>${esc(member.display_name)} <span class="badge ${member.role === 'owner' ? 'good' : ''}">${esc(roleLabel)}</span></strong><small>${ag ? 'Agent' : 'Person'} · ${esc(member.specialty)} · ${seatSummary}</small></span></button>`;
}

export function renderOrgMemberDetailPane(props: OrgMembersScreenProps, member: OrgRosterMemberItem): string {
  const ag = member.principal_kind === 'agent';
  const tab = props.active_detail_tab ?? 'profile';
  const cmds = buildOrgMemberParityCommands(props.org_slug, props.current_workspace_slug, member);
  const canEditRole = props.actor_role === 'owner' || (props.actor_role === 'admin' && member.role !== 'owner');
  const ungranted = props.available_workspaces.filter((w) => !member.workspace_grants.some((g) => g.workspace_id === w.workspace_id));
  const statusText = ag ? (member.connection_state ? STATUS_LABELS[member.connection_state] : 'Connection state unknown · no transport reported') : 'Human member · direct sign-in';
  const ownerLabel = member.owner_display_name ?? member.owner_user_id ?? null;
  const ownerInheritanceText = ag
    ? member.explicit_revocation_override ? `Explicit revocation active — overrides owner${ownerLabel ? ` (${esc(ownerLabel)})` : ''} inheritance.`
      : !ownerLabel ? 'No owner bound · explicit grants only.'
      : member.role === 'guest' ? `Owner-connected (${esc(ownerLabel)}) · Guest role: explicit grants only.`
      : member.inherits_owner_access === true ? `Owner-connected to ${esc(ownerLabel)} · Inherits live member access.`
      : `Owner-connected to ${esc(ownerLabel)} · Direct workspace grants only (does not inherit owner access).`
    : 'Direct human account.';
  const providerModelText = member.provider || member.model ? `${esc(member.provider ?? 'Unspecified')} / ${esc(member.model ?? 'Unspecified')}` : 'Not specified';
  const roleOptionsHtml = ORG_ROLES.map((r) => `<option value="${r}" ${member.role === r ? 'selected' : ''} ${!canChangeOrgRole(props.actor_role, member.role, r) ? 'disabled' : ''}>${ORG_ROLE_LABELS[r]}</option>`).join('');
  const grantsChipsHtml = member.workspace_grants.map((g) => `<span class="ws-chip" data-workspace-id="${esc(g.workspace_id)}"><span>${esc(g.workspace_name)} <small>(${esc(ORG_ROLE_LABELS[g.role])}${g.active_seat_id ? ` · seat ${esc(g.active_seat_id)}` : ''})</small></span><button type="button" class="ws-chip-remove" data-action="revoke-workspace-grant" data-member-id="${esc(member.principal_id)}" data-workspace-id="${esc(g.workspace_id)}" aria-label="Remove ${esc(member.display_name)} from ${esc(g.workspace_name)}">×</button></span>`).join('');
  const otherOrgsHtml = (member.other_org_roles ?? []).length ? member.other_org_roles!.map((o) => `<span class="badge">${esc(o.org_name)} (${esc(o.org_slug)}): ${esc(ORG_ROLE_LABELS[o.role])}</span>`).join(' ') : '<span class="meta">None</span>';
  const skillsHtml = member.skills?.length ? member.skills.map((s) => `<span class="badge">${esc(s)}</span>`).join(' ') : '<span class="meta">No declared capabilities</span>';
  const pendingRem = props.pending_removal?.principal_id === member.principal_id ? props.pending_removal : null;
  const pendingRemovalHtml = pendingRem
    ? `<dialog class="notice danger-confirm-box" open role="alertdialog" aria-modal="true" aria-labelledby="rem-confirm-${esc(member.principal_id)}" data-dialog="confirm-remove-org-member" data-pending-removal-scope="${esc(pendingRem.scope)}"><strong id="rem-confirm-${esc(member.principal_id)}">Confirm removal of ${esc(member.display_name)}</strong><p>${esc(REVOCATION_SCOPE_DISCLOSURE)}.</p><code>${esc(pendingRem.scope === 'organization' ? cmds.cli_org_remove : cmds.cli_workspace_revoke)}</code><div class="sample-row"><button type="button" class="button" data-action="cancel-remove-member" data-member-id="${esc(member.principal_id)}">Cancel</button><button type="button" class="button primary danger" data-action="confirm-remove-member" data-removal-scope="${esc(pendingRem.scope)}" data-member-id="${esc(member.principal_id)}">Confirm remove</button></div></dialog>`
    : '';
  const pRow = (lbl: string, mcp: string, cli: string) => `<div class="parity-row"><span class="meta">${lbl} (${esc(mcp)})</span><code>${esc(cli)}</code><button type="button" class="button" data-copy-cmd="${esc(cli)}">Copy CLI</button></div>`;
  return `<div class="profile" data-selected-member="${esc(member.principal_id)}">
<button type="button" class="text-button mobile-member-back" data-action="member-list-back">← Back to members</button>
<div class="profile-heading"><span class="avatar ${ag ? 'agent' : ''}">${esc(member.initials)}</span><div class="profile-identity"><div class="profile-title-row"><h2>${esc(member.display_name)}</h2><span class="badge">${ag ? 'Agent' : 'Person'}</span><span class="badge ${member.role === 'owner' ? 'good' : ''}">${esc(ORG_ROLE_LABELS[member.role])}</span>${ag && member.active_seat_id ? `<span class="badge good" data-active-seat="${esc(member.active_seat_id)}">Active seat · ${esc(member.active_seat_id)}</span>` : ''}</div><p class="meta">${esc(member.handle)} · ${esc(member.specialty)}</p></div><div class="profile-quick-actions"><button type="button" class="button" data-action="message-member" data-member-id="${esc(member.principal_id)}">Message</button></div></div>
<div class="filters detail-tabs" role="tablist"><button type="button" role="tab" data-detail-tab="profile" aria-selected="${tab === 'profile'}" aria-pressed="${tab === 'profile'}">Profile &amp; Access</button><button type="button" role="tab" data-detail-tab="skills" aria-selected="${tab === 'skills'}" aria-pressed="${tab === 'skills'}">Skills &amp; Parity</button></div>
<div class="detail-tab-panel" data-tab-panel="profile" ${tab === 'skills' ? 'hidden' : ''}>
<dl class="profile-dl">
<dt><label for="org-role-select-${esc(member.principal_id)}">Organization role</label></dt>
<dd><select id="org-role-select-${esc(member.principal_id)}" class="role-select" data-action="change-org-role" data-member-id="${esc(member.principal_id)}" ${!canEditRole ? 'disabled' : ''}>${roleOptionsHtml}</select><small class="meta">4-tier org role in ${esc(props.org_name)} (${esc(props.org_slug)})</small></dd>
<dt>Workspace grants</dt>
<dd><div class="ws-chip-list">${grantsChipsHtml || '<span class="meta">No explicit workspace grants</span>'}</div><div class="ws-grant-add-row"><select id="add-ws-select-${esc(member.principal_id)}" class="ws-select" data-add-workspace-for="${esc(member.principal_id)}">${ungranted.length ? ungranted.map((w) => `<option value="${esc(w.workspace_id)}">${esc(w.name)} (${esc(w.slug)})</option>`).join('') : '<option value="">All workspaces granted</option>'}</select><button type="button" class="button" data-action="add-workspace-grant" data-member-id="${esc(member.principal_id)}" ${!ungranted.length ? 'disabled' : ''}>+ Add to workspace</button></div></dd>
<dt>Status</dt><dd>${esc(statusText)}</dd>
${ag ? `<dt>Owner connection</dt><dd><span data-owner-link="${esc(member.owner_user_id ?? '')}">Owner: ${esc(ownerLabel ?? 'None')}</span> · ${ownerInheritanceText}</dd><dt>Provider / model</dt><dd>${providerModelText}</dd>` : ''}
<dt>Multi-org identity</dt><dd>${otherOrgsHtml}</dd>
</dl>
<div class="notice revocation-disclosure" role="note" data-revocation-disclosure="true"><strong>Revocation scope &amp; active seat behavior</strong><p>${esc(REVOCATION_SCOPE_DISCLOSURE)}.</p></div>
${pendingRemovalHtml}
<div class="sample-row member-danger-actions"><button type="button" class="button danger" data-action="open-remove-workspace" data-member-id="${esc(member.principal_id)}">Remove from ${esc(props.current_workspace_name)}</button><button type="button" class="button primary danger" data-action="open-remove-org" data-member-id="${esc(member.principal_id)}">Remove from Organization</button></div>
</div>
<div class="detail-tab-panel" data-tab-panel="skills" ${tab !== 'skills' ? 'hidden' : ''}>
<h3>Capabilities &amp; specialties</h3><div class="sample-row">${skillsHtml}</div>
<h3>MCP &amp; CLI parity commands</h3>
<div class="parity-command-box">${pRow('Invite / add org member', cmds.mcp_member_add, cmds.cli_member_add)}${pRow('Set org role', cmds.mcp_member_role, cmds.cli_member_role)}${pRow('Grant workspace access', cmds.mcp_workspace_grant, cmds.cli_workspace_grant)}${pRow('Revoke workspace grant', cmds.mcp_workspace_revoke, cmds.cli_workspace_revoke)}</div>
</div></div>`;
}

export function renderOrgMembersScreen(props: OrgMembersScreenProps): string {
  const mobileView = props.mobileView ?? props.mobile_view ?? 'list';
  const visible = filterOrgRosterMembers(props.members, props.active_filter);
  const selected = props.members.find((m) => m.principal_id === props.selected_principal_id) ?? visible[0] ?? props.members[0] ?? null;
  const cmds = buildOrgMemberParityCommands(props.org_slug, props.current_workspace_slug, selected ?? undefined);
  const orgInitial = (props.org_name.trim()[0] || 'O').toUpperCase();
  const filterPills = ORG_ROSTER_FILTER_TABS.map((t) => `<button type="button" data-roster-filter="${t.id}" aria-pressed="${props.active_filter === t.id}">${esc(t.label)}</button>`).join('');
  const creationMenu = CREATION_MENU_ACTIONS.map((a) => `<button type="button" data-creation-action="${a.id}"><span><strong>${esc(a.label)}</strong><small class="meta">${esc(a.description)}</small></span></button>`).join('');
  const rosterRows = visible.length ? visible.map((m) => renderOrgRosterListItem(m, selected?.principal_id)).join('') : `<div class="empty"><p>No ${esc(props.active_filter)} entries.</p></div>`;
  return `<div class="org-members-mode" data-org-slug="${esc(props.org_slug)}" data-workspace-slug="${esc(props.current_workspace_slug)}" data-mobile-view="${esc(mobileView)}"><aside class="sidebar roster-pane members-list-pane" aria-label="Unified organization roster"><div class="identity"><button type="button" class="org-button" data-action="open-org-settings"><span class="logo-placeholder">${esc(orgInitial)}</span><strong>${esc(props.org_name)}</strong><span class="badge ${props.actor_role === 'owner' ? 'good' : ''}" style="margin-left:auto">${esc(ORG_ROLE_LABELS[props.actor_role])}</span></button><button type="button" class="workspace-button" data-action="open-workspace-settings"><span>Workspace: <strong>${esc(props.current_workspace_name)} (${esc(props.org_slug)}/${esc(props.current_workspace_slug)})</strong></span></button></div><div class="pane-heading"><h2>Members &amp; Agents</h2><div class="creation-menu-wrap"><button type="button" class="icon-button" data-action="toggle-creation-menu" aria-label="Add person or agent">+</button><div class="popover creation-menu-popover" id="creation-menu-popover" hidden>${creationMenu}</div></div></div><div class="top-roster-actions sample-row"><button type="button" class="button primary" data-action="invite-person">+ Invite Person</button><button type="button" class="button" data-action="connect-grant-agent">+ Connect / Grant Agent</button></div><div class="filters" role="toolbar">${filterPills}</div><div class="roster-list" role="list">${rosterRows}</div><div class="sidebar-parity-footer"><small class="meta">CLI parity</small><code>${esc(cmds.cli_member_add)}</code><code>${esc(cmds.cli_workspace_grant)}</code></div></aside><section class="page-content detail-pane member-detail-pane" aria-label="Selected member detail">${selected ? renderOrgMemberDetailPane(props, selected) : '<div class="empty-selection"><p>Select a person or agent</p></div>'}</section></div>`;
}
