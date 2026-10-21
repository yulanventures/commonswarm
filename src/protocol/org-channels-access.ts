import {
  type CallerContext,
  type ChannelJoinPolicy,
  type ChannelVisibility,
  type OrgChannelAuthorityState,
  type PrincipalKind,
  agentOwner,
  fail,
  hasWsGrant,
  isLive,
  isPrin,
  orgRole,
} from './org-channels-types.js';

type State = OrgChannelAuthorityState;

export function canReadOrg(s: State, c: CallerContext, orgId: string): boolean {
  if (!s.organizations.some((o) => o.id === orgId && isLive(o))) return false;
  if (c.principal_kind === 'user')
    return orgRole(s, orgId, 'user', c.principal_id) !== null;
  const ownerId = agentOwner(s, c);
  if (
    !ownerId ||
    s.orgMemberships.some(
      (m) =>
        m.org_id === orgId &&
        isPrin(m, 'agent', c.principal_id) &&
        m.revoked_at != null,
    )
  )
    return false;
  if (c.connection_id) {
    const pol = (s.connectionPolicies ?? []).find(
      (p) => p.connection_id === c.connection_id,
    );
    if (
      pol &&
      (pol.revoked_at != null ||
        (pol.allowed_org_ids && !pol.allowed_org_ids.includes(orgId)))
    )
      return false;
  }
  const uRole = orgRole(s, orgId, 'user', ownerId);
  if (!uRole) return false;
  const aRole = orgRole(s, orgId, 'agent', c.principal_id);
  return uRole === 'guest' || aRole === 'guest' ? aRole !== null : true;
}

export function canReadWorkspace(
  s: State,
  c: CallerContext,
  wsId: string,
): boolean {
  const ws = s.workspaces.find((w) => w.workspace_id === wsId && isLive(w));
  if (
    !ws ||
    !canReadOrg(s, c, ws.org_id) ||
    s.workspaceGrants.some(
      (g) =>
        g.workspace_id === wsId &&
        isPrin(g, c.principal_kind, c.principal_id) &&
        g.revoked_at != null,
    )
  )
    return false;
  if (c.principal_kind === 'user') {
    if (hasWsGrant(s, wsId, 'user', c.principal_id)) return true;
    const r = orgRole(s, ws.org_id, 'user', c.principal_id);
    return Boolean(
      r &&
        r !== 'guest' &&
        (s.legacyMemberships ?? []).some(
          (m) =>
            m.workspace_id === wsId &&
            m.user_id === c.principal_id &&
            isLive(m),
        ),
    );
  }
  const ownerId = agentOwner(s, c);
  if (
    !ownerId ||
    !canReadWorkspace(
      s,
      { principal_kind: 'user', principal_id: ownerId },
      wsId,
    )
  )
    return false;
  if (
    (s.agentPrincipals ?? []).some(
      (ap) =>
        ap.workspace_id === wsId &&
        ap.agent_identity_id === c.principal_id &&
        ap.revoked_at != null,
    )
  )
    return false;
  const eff =
    orgRole(s, ws.org_id, 'agent', c.principal_id) ??
    orgRole(s, ws.org_id, 'user', ownerId);
  return eff === 'guest'
    ? hasWsGrant(s, wsId, 'agent', c.principal_id)
    : hasWsGrant(s, wsId, 'agent', c.principal_id) || eff !== null;
}

export function canReadChannel(
  s: State,
  c: CallerContext,
  chId: string,
): boolean {
  const ch = s.channels.find((x) => x.channel_id === chId);
  if (!ch || !canReadWorkspace(s, c, ch.workspace_id)) return false;
  if (ch.visibility === 'workspace') return true;
  if (!(s.privateChannelsEnabled ?? true)) return false;
  if (
    !s.channelMemberships.some(
      (m) =>
        m.channel_id === chId &&
        isPrin(m, c.principal_kind, c.principal_id) &&
        isLive(m),
    )
  )
    return false;
  if (c.principal_kind === 'user') return true;
  const ownerId = agentOwner(s, c);
  return Boolean(
    ownerId &&
      s.channelMemberships.some(
        (m) =>
          m.channel_id === chId &&
          isPrin(m, 'user', ownerId) &&
          isLive(m),
      ),
  );
}

export function canModifyChannelMembership(
  s: State,
  actor: CallerContext,
  chId: string,
  target: { principal_kind: PrincipalKind; principal_id: string },
) {
  const ch = s.channels.find((c) => c.channel_id === chId);
  if (!ch || !canReadWorkspace(s, actor, ch.workspace_id))
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
      workspace: ch?.workspace_id ?? null,
      channel: ch?.slug ?? chId,
    });
  if (ch.visibility === 'private') {
    const scope = { workspace: ch.workspace_id, channel: ch.slug };
    if (!(s.privateChannelsEnabled ?? true))
      return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
    if (
      !s.channelMemberships.some(
        (m) =>
          m.channel_id === chId &&
          isPrin(m, actor.principal_kind, actor.principal_id) &&
          m.role === 'owner' &&
          isLive(m),
      )
    ) {
      return fail(
        isPrin(target, actor.principal_kind, actor.principal_id)
          ? 'PRIVATE_CHANNEL_INVITE_REQUIRED'
          : 'PRIVATE_CHANNEL_OWNER_REQUIRED',
        'channel_owner_membership',
        scope,
      );
    }
  }
  return { ok: true as const };
}

export function canReadChannelBoundFile(
  s: State,
  c: CallerContext,
  fileId: string,
  wsId: string,
): boolean {
  if (!canReadWorkspace(s, c, wsId)) return false;
  const b = (s.fileChannelBindings ?? []).filter(
    (x) => x.file_id === fileId && x.workspace_id === wsId,
  );
  return b.length === 0 ? true : b.some((x) => canReadChannel(s, c, x.channel_id));
}

export function validateChannelVisibilityTransition({
  privateChannelsEnabled = true,
  currentVisibility,
  nextVisibility,
  nextJoinPolicy,
  signalCount = 0,
  boundFileCount = 0,
  channelSlug,
  workspaceSlug,
}: {
  privateChannelsEnabled?: boolean;
  currentVisibility?: ChannelVisibility | null;
  nextVisibility: ChannelVisibility;
  nextJoinPolicy: ChannelJoinPolicy;
  signalCount?: number;
  boundFileCount?: number;
  channelSlug?: string;
  workspaceSlug?: string;
}) {
  const scope = { workspace: workspaceSlug ?? null, channel: channelSlug ?? null };
  if (nextVisibility === 'private' && !privateChannelsEnabled)
    return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
  if (nextVisibility === 'private' && nextJoinPolicy === 'open')
    return fail('PRIVATE_CHANNEL_OPEN_JOIN_FORBIDDEN', 'invite_only_join_policy', scope);
  if (currentVisibility && currentVisibility !== nextVisibility) {
    if (currentVisibility === 'private')
      return fail('PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC', 'immutable_private_history', scope);
    if (signalCount > 0 || boundFileCount > 0)
      return fail('CHANNEL_HAS_PUBLIC_HISTORY', 'empty_channel_history', scope);
  }
  return { ok: true as const };
}
