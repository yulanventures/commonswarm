import type { WorkspaceMember, WorkspacePrincipal, WorkspaceRole } from './workspace-events.js';

// Preparatory contracts only. No protocol-index export or authenticated adapter yet.
// Canonical baseline: human org membership; agent IDs remain workspace principals.
export type OrgRole = WorkspaceRole;
export type PrincipalKind = 'user' | 'agent';
export type ChannelVisibility = 'workspace' | 'private';

export interface OrganizationSummary {
  id: string;
  slug: string;
  display_name: string;
  archived_at: number | null;
}
export interface OrgMembershipRecord {
  org_id: string;
  user_id: string;
  role: OrgRole;
  revoked_at: number | null;
}
export interface WorkspaceRecord {
  workspace_id: string;
  org_id: string;
  slug: string;
  name: string;
  archived_at: number | null;
}
export interface WorkspaceMembershipRecord extends Pick<WorkspaceMember, 'user_id' | 'role' | 'revoked_at'> {
  workspace_id: string;
}
export interface AgentPrincipalRecord extends Pick<WorkspacePrincipal, 'principal_id' | 'owner_user_id' | 'revoked_at'> {
  workspace_id: string;
}
export interface ChannelSummary {
  channel_id: string;
  workspace_id: string;
  slug: string;
  visibility: ChannelVisibility;
  archived_at: number | null;
}
export interface ChannelMembershipRecord {
  channel_id: string;
  workspace_id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  role: 'owner' | 'member';
  revoked_at: number | null;
}
export interface SignalScopeRecord {
  signal_id: string;
  workspace_id: string;
  channel_id: string | null;
  thread_root_id: string | null;
}
export interface FileScopeRecord {
  file_id: string;
  workspace_id: string;
}
export interface FileChannelBinding extends FileScopeRecord {
  channel_id: string;
}
export interface WorkspaceSeatRecord {
  seat_id: string;
  workspace_id: string;
  principal_id: string;
  revoked_at: number | null;
}

/** Facts supplied by existing authenticated authority, inside its transaction.
 * credential_active includes its existing revocation/expiry/suspension checks.
 * workspace_consented includes its existing connection policy and grant checks.
 * This module neither authenticates callers nor maintains sessions or expiries.
 */
export interface AgentWorkspaceAuthority {
  credential_id: string;
  workspace_id: string;
  principal_id: string;
  owner_user_id: string;
  credential_active: boolean;
  workspace_consented: boolean;
}
/** Derived server-side from the authenticated credential inside the command/read
 * transaction; never trust HTTP JSON, request headers or bodies for these facts.
 * A user's current_workspace_id is a preference only, never authority.
 */
export type CallerContext =
  | { principal_kind: 'user'; principal_id: string; current_workspace_id?: string | null }
  | { principal_kind: 'agent'; principal_id: string; workspace_id: string; credential_id: string };

/** Trusted, transaction-consistent projections; never caller-authored request data.
 * Workspace memberships preserve legacy authority; org roles never replace them.
 * Private channels have no enabling switch in this preparatory contract.
 */
export interface OrgChannelAuthorityState {
  organizations: readonly OrganizationSummary[];
  orgMemberships: readonly OrgMembershipRecord[];
  workspaces: readonly WorkspaceRecord[];
  workspaceMemberships: readonly WorkspaceMembershipRecord[];
  agentPrincipals: readonly AgentPrincipalRecord[];
  agentAuthority: readonly AgentWorkspaceAuthority[];
  channels: readonly ChannelSummary[];
  channelMemberships: readonly ChannelMembershipRecord[];
  signals: readonly SignalScopeRecord[];
  files: readonly FileScopeRecord[];
  fileChannelBindings: readonly FileChannelBinding[];
  seats: readonly WorkspaceSeatRecord[];
}
export interface WorkspaceSelectorChoice {
  org_id: string;
  org_slug: string;
  workspace_id: string;
  workspace_slug: string;
  selector: string;
}
export interface ChannelSelectorChoice extends WorkspaceSelectorChoice {
  // selector still names the workspace; channel_id disambiguates the channel.
  channel_id: string;
  channel_slug: string;
}
export type OrgChannelRefusalCode =
  | 'INVALID_SELECTOR' | 'ORG_ACCESS_DENIED' | 'WORKSPACE_ACCESS_DENIED'
  | 'CHANNEL_ACCESS_DENIED' | 'ENTITY_ACCESS_DENIED' | 'WORKSPACE_SEAT_MISMATCH'
  | 'AMBIGUOUS_WORKSPACE_SELECTOR' | 'AMBIGUOUS_ORG_SELECTOR' | 'AMBIGUOUS_CHANNEL_SELECTOR';
export interface OrgChannelRefusal {
  code: OrgChannelRefusalCode;
  remedy_url: string;
  choices?: (WorkspaceSelectorChoice | ChannelSelectorChoice)[];
}

// Denials never resolve hidden names, counts, selectors or target-specific remedies.
export function fail(code: OrgChannelRefusalCode, choices?: (WorkspaceSelectorChoice | ChannelSelectorChoice)[]) {
  return {
    ok: false as const,
    refusal: { code, remedy_url: 'https://commonswarm.com/app',
      ...(choices?.length ? { choices } : {}) } satisfies OrgChannelRefusal,
  };
}
