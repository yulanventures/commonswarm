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
  added_by_kind?: PrincipalKind;
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
  now?: string | number | null;
  privateChannelsEnabled?: boolean;
  organizations: OrganizationSummary[];
  workspaces: WorkspaceRecord[];
  channels: ChannelSummary[];
  agentIdentities: AgentIdentity[];
  hostedGrants?: Array<{
    grant_id: string;
    state: 'pending' | 'active' | 'revoked';
    revoked_at?: string | null;
  }>;
  renewalGrants?: Array<{
    renewal_grant_id: string;
    principal_id?: string | null;
    workspace_id?: string | null;
    horizon_expires_at?: string | null;
    revoked_at?: string | null;
  }>;
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
  approvalRequests?: OrgApprovalRequest[];
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
  now?: string | number | null;
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
      ? 'claim_seat'
      : code === 'AMBIGUOUS_WORKSPACE_SELECTOR'
        ? 'workspace_list'
        : code === 'CHANNEL_HAS_PUBLIC_HISTORY' ||
            code === 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC' ||
            code === 'PRIVATE_CHANNEL_OPEN_JOIN_FORBIDDEN'
          ? 'channel_create'
          : code === 'PRIVATE_CHANNELS_DISABLED'
            ? 'channel_list'
            : code === 'ORG_MOVE_REQUIRES_DUAL_OWNER'
              ? 'org_list_members'
              : code.includes('CHANNEL')
                ? 'channel_add_member'
                : 'workspace_grant_member';
  const cli =
    code === 'WORKSPACE_SEAT_MISMATCH'
      ? `cswarm check --workspace ${sel}`
      : code === 'AMBIGUOUS_WORKSPACE_SELECTOR'
        ? 'cswarm workspaces list'
        : code === 'CHANNEL_HAS_PUBLIC_HISTORY' ||
            code === 'PRIVATE_CHANNEL_OPEN_JOIN_FORBIDDEN'
          ? `cswarm channel create <new-name> --private --workspace ${sel}`
          : code === 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC'
            ? `cswarm channel create <new-name> --workspace ${sel}`
            : code === 'PRIVATE_CHANNELS_DISABLED'
              ? `cswarm channel ls --workspace ${sel}`
              : code === 'ORG_MOVE_REQUIRES_DUAL_OWNER'
                ? `cswarm org members list --org ${s.org ?? '<org>'}`
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

export const resolveAgentId = (s: OrgChannelAuthorityState, id: string) =>
  (s.agentPrincipals ?? []).find((ap) => ap.principal_id === id && isLive(ap))
    ?.agent_identity_id ??
  (s.agentPrincipals ?? []).find((ap) => ap.principal_id === id)
    ?.agent_identity_id ??
  id;

export const orgRole = (
  s: OrgChannelAuthorityState,
  orgId: string,
  k: PrincipalKind,
  id: string,
): OrgRole | null => {
  const pid = k === 'agent' ? resolveAgentId(s, id) : id;
  return (
    s.orgMemberships.find(
      (m) => m.org_id === orgId && isPrin(m, k, pid) && isLive(m),
    )?.role ?? null
  );
};

export const hasWsGrant = (
  s: OrgChannelAuthorityState,
  wsId: string,
  k: PrincipalKind,
  id: string,
) => {
  const pid = k === 'agent' ? resolveAgentId(s, id) : id;
  return s.workspaceGrants.some(
    (g) => g.workspace_id === wsId && isPrin(g, k, pid) && isLive(g),
  );
};

export const toEvalMs = (now?: string | number | null): number => {
  if (typeof now === 'number') return now;
  return now ? Date.parse(now) : NaN;
};

export const agentOwner = (
  s: OrgChannelAuthorityState,
  c: CallerContext,
  now?: string | number | null,
) => {
  const aid = resolveAgentId(s, c.principal_id);
  const ai = s.agentIdentities.find(
    (a) => a.id === aid && isLive(a),
  );
  if (!ai) return null;
  if (
    ai.standing_grant_id &&
    !(s.hostedGrants ?? []).some(
      (g) =>
        g.grant_id === ai.standing_grant_id &&
        g.state === 'active' &&
        g.revoked_at == null,
    )
  )
    return null;
  const refMs = toEvalMs(now ?? c.now ?? s.now);
  if (ai.standing_renewal_grant_id) {
    const aps = (s.agentPrincipals ?? []).filter((ap) => ap.agent_identity_id === aid);
    const liveRg = (rg: NonNullable<OrgChannelAuthorityState['renewalGrants']>[number]) =>
      rg.revoked_at == null &&
      (rg.horizon_expires_at == null ||
        (Number.isFinite(refMs) && Date.parse(rg.horizon_expires_at) > refMs));
    const srg = (s.renewalGrants ?? []).find(
      (rg) => rg.renewal_grant_id === ai.standing_renewal_grant_id,
    );
    const srgAp = srg?.principal_id
      ? aps.find((ap) => ap.principal_id === srg.principal_id)
      : undefined;
    const hasOtherLiveAp =
      srgAp != null &&
      !isLive(srgAp) &&
      aps.some(
        (ap) =>
          isLive(ap) &&
          !(s.renewalGrants ?? []).some(
            (rg) => rg.principal_id === ap.principal_id && !liveRg(rg),
          ),
      );
    const hasLiveAltRg = (s.renewalGrants ?? []).some(
      (rg) =>
        rg.principal_id != null &&
        aps.some((ap) => ap.principal_id === rg.principal_id && isLive(ap)) &&
        liveRg(rg),
    );
    if (!((srg && liveRg(srg)) || hasOtherLiveAp || hasLiveAltRg)) return null;
  }
  if (c.owner_user_id != null && c.owner_user_id !== ai.owner_user_id)
    return null;
  return ai.owner_user_id;
};

export const hasLiveWsRenewal = (
  s: OrgChannelAuthorityState,
  wsId: string,
  wsAps: NonNullable<OrgChannelAuthorityState['agentPrincipals']>,
  c: CallerContext,
  now?: string | number | null,
) => {
  const refMs = toEvalMs(now ?? c.now ?? s.now);
  const wsRgs = (s.renewalGrants ?? []).filter(
    (rg) =>
      rg.workspace_id === wsId ||
      (rg.principal_id != null && wsAps.some((ap) => ap.principal_id === rg.principal_id)),
  );
  return (
    wsRgs.length === 0 ||
    wsRgs.some(
      (rg) =>
        rg.revoked_at == null &&
        (rg.horizon_expires_at == null ||
          (Number.isFinite(refMs) && Date.parse(rg.horizon_expires_at) > refMs)),
    )
  );
};

export const cascadeWsRenewalGrants = (
  s: OrgChannelAuthorityState,
  workspace_id: string,
  affected: Set<string>,
  now: string,
) => {
  for (const rg of s.renewalGrants ?? []) {
    if (
      rg.revoked_at == null &&
      (rg.workspace_id === workspace_id || (rg.principal_id && affected.has(rg.principal_id)))
    )
      rg.revoked_at = now;
  }
  for (const ai of s.agentIdentities) {
    if (!ai.standing_renewal_grant_id) continue;
    const cur = (s.renewalGrants ?? []).find(
      (rg) => rg.renewal_grant_id === ai.standing_renewal_grant_id,
    );
    if (cur && cur.revoked_at != null && cur.principal_id != null) {
      const next = (s.renewalGrants ?? []).find(
        (rg) =>
          rg.revoked_at == null &&
          rg.principal_id != null &&
          (s.agentPrincipals ?? []).some(
            (ap) =>
              ap.agent_identity_id === ai.id &&
              ap.principal_id === rg.principal_id &&
              isLive(ap),
          ),
      );
      if (next) ai.standing_renewal_grant_id = next.renewal_grant_id;
      else if (
        (s.agentPrincipals ?? []).some((ap) => ap.agent_identity_id === ai.id && isLive(ap))
      )
        ai.standing_renewal_grant_id = null;
    }
  }
};
