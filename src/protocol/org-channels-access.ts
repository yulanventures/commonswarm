import type { CallerContext, OrgChannelAuthorityState } from './org-channels-types.js';

type State = OrgChannelAuthorityState;

function humanCanReadWorkspace(s: State, userId: string, workspaceId: string): boolean {
  // D2 / Phase-1 precondition before any mount or org-membership-filter consumer:
  // migration A backfills every live legacy workspace member; legacy workspace
  // create/invite/join writers atomically maintain the org membership mapping.
  // Empty org state must never remove existing legacy workspace authority.
  const ws = s.workspaces.find((w) => w.workspace_id === workspaceId && w.archived_at === null);
  return Boolean(ws && s.organizations.some((o) => o.id === ws.org_id && o.archived_at === null)
    && s.orgMemberships.some((m) => m.org_id === ws.org_id && m.user_id === userId && m.revoked_at === null)
    && s.workspaceMemberships.some((m) => m.workspace_id === workspaceId && m.user_id === userId && m.revoked_at === null));
}

export function canReadWorkspace(s: State, c: CallerContext, workspaceId: string): boolean {
  if (c.principal_kind === 'user') return humanCanReadWorkspace(s, c.principal_id, workspaceId);
  if (c.workspace_id !== workspaceId) return false;
  const principal = s.agentPrincipals.find((p) => p.workspace_id === workspaceId
    && p.principal_id === c.principal_id && p.revoked_at === null);
  return Boolean(principal && humanCanReadWorkspace(s, principal.owner_user_id, workspaceId)
    && s.agentAuthority.some((a) => a.credential_id === c.credential_id
      && a.workspace_id === workspaceId && a.principal_id === principal.principal_id
      && a.owner_user_id === principal.owner_user_id
      && a.credential_active === true && a.workspace_consented === true));
}

export function canReadOrg(s: State, c: CallerContext, orgId: string): boolean {
  if (!s.organizations.some((o) => o.id === orgId && o.archived_at === null)) return false;
  if (c.principal_kind === 'user') {
    return s.orgMemberships.some((m) => m.org_id === orgId && m.user_id === c.principal_id && m.revoked_at === null);
  }
  return s.workspaces.some((w) => w.org_id === orgId && canReadWorkspace(s, c, w.workspace_id));
}

export function canReadChannel(s: State, c: CallerContext, channelId: string): boolean {
  const ch = s.channels.find((x) => x.channel_id === channelId);
  // Archived workspace-visible channels retain their readable history.
  return Boolean(ch && ch.visibility === 'workspace' && canReadWorkspace(s, c, ch.workspace_id));
}

export function canReadSignal(s: State, c: CallerContext, signalId: string, workspaceId: string): boolean {
  if (!canReadWorkspace(s, c, workspaceId)) return false;
  const signal = s.signals.find((x) => x.signal_id === signalId && x.workspace_id === workspaceId);
  if (!signal) return false;
  const root = signal.thread_root_id === null ? signal : s.signals.find((x) =>
    x.signal_id === signal.thread_root_id && x.workspace_id === workspaceId && x.thread_root_id === null);
  if (!root || signal.channel_id !== root.channel_id) return false;
  if (root.channel_id === null) return true; // Legacy unfiled history stays unfiled.
  return s.channels.some((ch) => ch.channel_id === root.channel_id && ch.workspace_id === workspaceId)
    && canReadChannel(s, c, root.channel_id);
}

export function canReadChannelBoundFile(s: State, c: CallerContext, fileId: string, workspaceId: string): boolean {
  return canReadWorkspace(s, c, workspaceId)
    && s.files.some((f) => f.file_id === fileId && f.workspace_id === workspaceId)
    && s.fileChannelBindings.filter((b) => b.file_id === fileId)
      .every((b) => b.workspace_id === workspaceId
        && s.channels.some((ch) => ch.channel_id === b.channel_id && ch.workspace_id === workspaceId)
        && canReadChannel(s, c, b.channel_id));
}
