export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type PrincipalKind = 'user' | 'agent';
export type ChannelVisibility = 'workspace' | 'private';
export type ChannelJoinPolicy = 'open' | 'invite_only';
export type ChannelRole = 'owner' | 'member';
export type NotifyPref = 'all' | 'mentions' | 'mute';
export type WorkspaceMoveTransferMode = 'all' | 'owners_only';

export const CANONICAL_ORG_CHANNEL_LOCK_ORDER = [
  'organizations',
  'workspaces',
  'channels',
  'org_memberships',
  'workspace_principal_grants',
  'channel_memberships',
  'agent_principals',
  'seats',
] as const;

export interface AgentIdentity {
  id: string;
  owner_user_id: string;
  standing_grant_id?: string | null;
  standing_renewal_grant_id?: string | null;
  display_name: string;
  created_at: string;
  revoked_at?: string | null;
}
export interface OrganizationSummary {
  id: string;
  slug: string;
  display_name: string;
  logo_object_key?: string | null;
  logo_updated_at?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}
export interface OrgMembershipRecord {
  id?: string;
  org_id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  role: OrgRole;
  invited_by?: string | null;
  created_at: string;
  revoked_at?: string | null;
}
export interface WorkspaceRecord {
  workspace_id: string;
  org_id: string;
  slug: string;
  name: string;
  archived_at?: string | null;
}
export interface WorkspacePrincipalGrant {
  id?: string;
  workspace_id: string;
  org_id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  role: OrgRole;
  granted_by?: string | null;
  created_at: string;
  revoked_at?: string | null;
}
export interface ChannelSummary {
  channel_id: string;
  workspace_id: string;
  org_id?: string;
  slug: string;
  purpose?: string | null;
  topic?: string | null;
  visibility: ChannelVisibility;
  join_policy: ChannelJoinPolicy;
  archived_at?: string | null;
  created_by_principal?: string;
  created_by_kind?: PrincipalKind;
  created_at?: string;
}
export interface ChannelMembershipRecord {
  id?: string;
  channel_id: string;
  workspace_id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  role: ChannelRole;
  notify_pref: NotifyPref;
  added_by?: string | null;
  joined_at: string;
  revoked_at?: string | null;
}
export interface FileChannelBinding {
  file_id: string;
  workspace_id: string;
  channel_id: string;
  bound_by_kind: PrincipalKind;
  bound_by?: string | null;
  created_at: string;
}
export interface OrgApprovalRequest {
  approval_id: string;
  org_id: string;
  workspace_id?: string | null;
  channel_id?: string | null;
  requested_by_agent_identity_id: string;
  owner_user_id: string;
  action_kind: string;
  target_scope: Record<string, unknown>;
  payload: Record<string, unknown>;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  decided_by?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  created_at: string;
}
export interface WorkspaceSelectorChoice {
  org_id: string;
  org_slug: string;
  workspace_id: string;
  workspace_slug: string;
  selector: string;
}
export interface OrgChannelRefusal {
  code: string;
  missing: string;
  scope: {
    org?: string | null;
    workspace?: string | null;
    channel?: string | null;
    seat_id?: string | null;
  };
  remedy_url: string;
  mcp_tool: string;
  cli_command: string;
  choices?: WorkspaceSelectorChoice[];
}
export interface MultiOrgWhoamiResponse {
  agent_identity_id: string;
  owner_user_id: string;
  display_name: string;
  active_seat: {
    seat_id: string;
    org_id: string;
    org_slug: string;
    workspace_id: string;
    workspace_slug: string;
    principal_id: string;
  } | null;
  default_org_id: string | null;
  default_workspace_id: string | null;
  organizations: Array<{
    org_id: string;
    slug: string;
    display_name: string;
    role: OrgRole;
    workspaces: Array<{
      workspace_id: string;
      slug: string;
      name: string;
      role: OrgRole;
      channels: Array<{
        channel_id: string;
        slug: string;
        visibility: ChannelVisibility;
      }>;
    }>;
  }>;
}
export interface OrgChannelAuthorityState {
  privateChannelsEnabled?: boolean;
  organizations: OrganizationSummary[];
  workspaces: WorkspaceRecord[];
  channels: ChannelSummary[];
  agentIdentities: AgentIdentity[];
  orgMemberships: OrgMembershipRecord[];
  workspaceGrants: WorkspacePrincipalGrant[];
  legacyMemberships?: Array<{
    workspace_id: string;
    user_id: string;
    role: 'owner' | 'admin' | 'member';
    revoked_at?: string | null;
  }>;
  agentPrincipals?: Array<{
    principal_id: string;
    workspace_id: string;
    agent_identity_id: string;
    owner_user_id: string;
    name: string;
    revoked_at?: string | null;
  }>;
  channelMemberships: ChannelMembershipRecord[];
  fileChannelBindings?: FileChannelBinding[];
  connectionPolicies?: Array<{
    connection_id: string;
    owner_user_id?: string | null;
    agent_identity_id?: string | null;
    default_org_id?: string | null;
    default_workspace_id?: string | null;
    allowed_org_ids?: string[] | null;
    revoked_at?: string | null;
  }>;
  seats?: Array<{
    seat_id: string;
    workspace_id: string;
    principal_id: string;
    agent_identity_id?: string;
    revoked_at?: string | null;
  }>;
  seatHandles?: Array<{
    handle_id: string;
    seat_id: string;
    workspace_id: string;
    revoked_at?: string | null;
  }>;
}
export interface CallerContext {
  principal_kind: PrincipalKind;
  principal_id: string;
  owner_user_id?: string | null;
  connection_id?: string | null;
}

export const isLive = (r: {
  revoked_at?: string | null;
  archived_at?: string | null;
}) => r.revoked_at == null && r.archived_at == null;
export const norm = (v: string) => v.trim().replace(/^#/, '').toLowerCase();
export const isPrin = (
  r: { principal_kind: PrincipalKind; principal_id: string },
  k: PrincipalKind,
  id: string,
) => r.principal_kind === k && r.principal_id === id;

export function buildOrgChannelRefusal({
  code,
  missing,
  scope: s = {},
  baseUrl = 'https://commonswarm.com',
  mcp_tool,
  cli_command,
  choices,
}: {
  code: string;
  missing: string;
  scope?: OrgChannelRefusal['scope'];
  baseUrl?: string;
  mcp_tool?: string;
  cli_command?: string;
  choices?: WorkspaceSelectorChoice[];
}): OrgChannelRefusal {
  const sel =
    s.org && s.workspace
      ? `${s.org}/${s.workspace}`
      : (s.workspace ?? s.org ?? '<org>/<workspace>');
  const mcp =
    code === 'WORKSPACE_SEAT_MISMATCH'
      ? 'cswarm_register_seat'
      : code === 'AMBIGUOUS_WORKSPACE_SELECTOR'
        ? 'cswarm_list_workspaces'
        : code.includes('CHANNEL')
          ? 'cswarm_channel_invite'
          : 'cswarm_request_access';
  const cli =
    code === 'WORKSPACE_SEAT_MISMATCH'
      ? `cswarm check --workspace ${sel}`
      : code === 'AMBIGUOUS_WORKSPACE_SELECTOR'
        ? 'cswarm workspaces list'
        : s.channel
          ? `cswarm channel invite ${s.channel} --workspace ${sel}`
          : `cswarm org members grant --workspace ${sel}`;
  return {
    code,
    missing,
    scope: {
      org: s.org ?? null,
      workspace: s.workspace ?? null,
      channel: s.channel ?? null,
      seat_id: s.seat_id ?? null,
    },
    remedy_url: `${baseUrl.replace(/\/$/, '')}/app${s.org ? `/${encodeURIComponent(s.org)}` : ''}${s.workspace ? `/${encodeURIComponent(s.workspace)}` : ''}`,
    mcp_tool: mcp_tool ?? mcp,
    cli_command: cli_command ?? cli,
    ...(choices ? { choices } : {}),
  };
}

export const fail = (
  code: string,
  missing: string,
  scope?: OrgChannelRefusal['scope'],
  choices?: WorkspaceSelectorChoice[],
) => ({
  ok: false as const,
  refusal: buildOrgChannelRefusal({ code, missing, scope, choices }),
});

export const orgRole = (
  s: OrgChannelAuthorityState,
  orgId: string,
  k: PrincipalKind,
  id: string,
): OrgRole | null =>
  s.orgMemberships.find(
    (m) => m.org_id === orgId && isPrin(m, k, id) && isLive(m),
  )?.role ?? null;

export const hasWsGrant = (
  s: OrgChannelAuthorityState,
  wsId: string,
  k: PrincipalKind,
  id: string,
) =>
  s.workspaceGrants.some(
    (g) => g.workspace_id === wsId && isPrin(g, k, id) && isLive(g),
  );

export const agentOwner = (s: OrgChannelAuthorityState, c: CallerContext) => {
  const ai = s.agentIdentities.find(
    (a) => a.id === c.principal_id && isLive(a),
  );
  return ai ? (c.owner_user_id ?? ai.owner_user_id) : null;
};
