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
  norm,
  orgRole,
  resolveAgentId,
} from './org-channels-types.js';

type State = OrgChannelAuthorityState;

export function canReadOrg(
  s: State,
  c: CallerContext,
  orgId: string,
  now?: string | number | null,
): boolean {
  if (!s.organizations.some((o) => o.id === orgId && isLive(o))) return false;
  if (c.principal_kind === 'user')
    return orgRole(s, orgId, 'user', c.principal_id) !== null;
  const aid = resolveAgentId(s, c.principal_id);
  const ownerId = agentOwner(s, c, now);
  const aRole = orgRole(s, orgId, 'agent', aid);
  if (
    !ownerId ||
    s.orgMemberships.some(
      (m) =>
        m.org_id === orgId &&
        m.principal_kind === 'agent' &&
        m.principal_id === aid &&
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
  return uRole === 'guest' || aRole === 'guest' ? aRole !== null : true;
}

export function canReadWorkspace(
  s: State,
  c: CallerContext,
  wsId: string,
  now?: string | number | null,
): boolean {
  const ws = s.workspaces.find((w) => w.workspace_id === wsId && isLive(w));
  const aid =
    c.principal_kind === 'agent'
      ? resolveAgentId(s, c.principal_id)
      : c.principal_id;
  if (
    !ws ||
    !canReadOrg(s, c, ws.org_id, now) ||
    s.workspaceGrants.some(
      (g) =>
        g.workspace_id === wsId &&
        isPrin(g, c.principal_kind, aid) &&
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
  const ownerId = agentOwner(s, c, now);
  if (
    !ownerId ||
    !canReadWorkspace(
      s,
      { principal_kind: 'user', principal_id: ownerId },
      wsId,
      now,
    )
  )
    return false;
  const explicitGrant = hasWsGrant(s, wsId, 'agent', aid);
  const wsAps = (s.agentPrincipals ?? []).filter(
    (ap) => ap.workspace_id === wsId && ap.agent_identity_id === aid,
  );
  if (wsAps.some((ap) => ap.revoked_at != null) && !wsAps.some(isLive))
    return false;
  const ownerRole = orgRole(s, ws.org_id, 'user', ownerId);
  const agentRole = orgRole(s, ws.org_id, 'agent', aid);
  const ownerWsGuest = s.workspaceGrants.some(
    (g) => g.workspace_id === wsId && isPrin(g, 'user', ownerId) && isLive(g) && g.role === 'guest',
  );
  const inheritedOwnerRole =
    ownerRole === 'guest' || ownerWsGuest ? 'guest' : ownerRole ? 'member' : null;
  const eff =
    ownerRole === 'guest' || ownerWsGuest || agentRole === 'guest'
      ? 'guest'
      : (agentRole ?? inheritedOwnerRole);
  return eff === 'guest' ? explicitGrant : explicitGrant || eff !== null;
}

export function canReadChannel(
  s: State,
  c: CallerContext,
  chId: string,
  now?: string | number | null,
): boolean {
  const ch = s.channels.find((x) => x.channel_id === chId);
  if (!ch || !canReadWorkspace(s, c, ch.workspace_id, now)) return false;
  const aid =
    c.principal_kind === 'agent'
      ? resolveAgentId(s, c.principal_id)
      : c.principal_id;
  const ws = s.workspaces.find((w) => w.workspace_id === ch.workspace_id);
  const hasChMem = (k: PrincipalKind, id: string) =>
    s.channelMemberships.some(
      (m) =>
        m.channel_id === chId &&
        m.principal_kind === k &&
        (k === 'agent' ? resolveAgentId(s, m.principal_id) : m.principal_id) === id &&
        isLive(m),
    );
  const isGuest = (k: PrincipalKind, id: string) =>
    (ws != null && orgRole(s, ws.org_id, k, id) === 'guest') ||
    s.workspaceGrants.some(
      (g) =>
        g.workspace_id === ch.workspace_id &&
        isPrin(g, k, id) &&
        isLive(g) &&
        g.role === 'guest',
    );
  if (ch.visibility === 'workspace') {
    if (isGuest(c.principal_kind, aid) && !hasChMem(c.principal_kind, aid))
      return false;
    if (c.principal_kind === 'agent') {
      const ownerId = agentOwner(s, c, now);
      if (!ownerId) return false;
      if (isGuest('user', ownerId) && (!hasChMem('user', ownerId) || !hasChMem('agent', aid)))
        return false;
    }
    return true;
  }
  if (!Boolean(s.privateChannelsEnabled)) return false;
  if (!hasChMem(c.principal_kind, aid)) return false;
  if (c.principal_kind === 'user') return true;
  const ownerId = agentOwner(s, c, now);
  return Boolean(ownerId && hasChMem('user', ownerId));
}

export function canModifyChannelMembership(
  s: State,
  actor: CallerContext,
  chId: string,
  target: { principal_kind: PrincipalKind; principal_id: string },
  now?: string | number | null,
) {
  const ch = s.channels.find((c) => c.channel_id === chId && isLive(c));
  if (!ch || !canReadWorkspace(s, actor, ch.workspace_id, now))
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
      workspace: ch?.workspace_id ?? null,
      channel: ch?.slug ?? chId,
    });
  if (ch.visibility === 'private') {
    const scope = { workspace: ch.workspace_id, channel: ch.slug };
    if (!Boolean(s.privateChannelsEnabled))
      return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
    const actorId =
      actor.principal_kind === 'agent'
        ? resolveAgentId(s, actor.principal_id)
        : actor.principal_id;
    const targetId =
      target.principal_kind === 'agent'
        ? resolveAgentId(s, target.principal_id)
        : target.principal_id;
    const allMems = s.channelMemberships.filter((m) => m.channel_id === chId);
    const liveMems = allMems.filter(isLive);
    const creatorId = ch.created_by_principal
      ? ch.created_by_kind === 'agent'
        ? resolveAgentId(s, ch.created_by_principal)
        : ch.created_by_principal
      : null;
    const isCreator =
      (ch.created_by_kind == null || ch.created_by_kind === actor.principal_kind) &&
      (creatorId === null || creatorId === actorId);
    const ownerUserId = actor.principal_kind === 'agent' ? agentOwner(s, actor, now) : null;
    const hasActorOwner = liveMems.some(
      (m) =>
        m.principal_kind === actor.principal_kind &&
        (actor.principal_kind === 'agent' ? resolveAgentId(s, m.principal_id) : m.principal_id) === actorId &&
        m.role === 'owner',
    );
    const isBootstrap =
      (allMems.length === 0 &&
        isCreator &&
        target.principal_kind === actor.principal_kind &&
        targetId === actorId) ||
      (allMems.length === 1 &&
        actor.principal_kind === 'agent' &&
        isCreator &&
        hasActorOwner &&
        ownerUserId != null &&
        target.principal_kind === 'user' &&
        targetId === ownerUserId);
    if (!isBootstrap && (!canReadChannel(s, actor, chId, now) || !hasActorOwner)) {
      return fail(
        target.principal_kind === actor.principal_kind && targetId === actorId
          ? 'PRIVATE_CHANNEL_INVITE_REQUIRED'
          : 'PRIVATE_CHANNEL_OWNER_REQUIRED',
        'channel_owner_membership',
        scope,
      );
    }
  }
  return { ok: true as const };
}

export function bootstrapPrivateChannelMemberships(
  s: State,
  actor: CallerContext,
  chId: string,
  now = '2026-10-21T00:00:00Z',
) {
  const ch = s.channels.find((c) => c.channel_id === chId && isLive(c));
  const actorId =
    actor.principal_kind === 'agent'
      ? resolveAgentId(s, actor.principal_id)
      : actor.principal_id;
  if (s.channelMemberships.some((m) => m.channel_id === chId)) {
    return fail(
      'PRIVATE_CHANNEL_INVITE_REQUIRED',
      'channel_owner_membership',
      { workspace: ch?.workspace_id ?? null, channel: ch?.slug ?? chId },
    );
  }
  const targets: Array<{ principal_kind: PrincipalKind; principal_id: string }> = [
    { principal_kind: actor.principal_kind, principal_id: actorId },
  ];
  if (actor.principal_kind === 'agent') {
    const ownerUserId = agentOwner(s, actor, now);
    if (!ownerUserId)
      return fail('WORKSPACE_ACCESS_DENIED', 'agent_owner', {
        workspace: ch?.workspace_id ?? null,
        channel: ch?.slug ?? chId,
      });
    targets.push({ principal_kind: 'user', principal_id: ownerUserId });
  }
  const snap = s.channelMemberships.map((m) => ({ ...m }));
  for (const t of targets) {
    const auth = canModifyChannelMembership(s, actor, chId, t, now);
    if (!auth.ok) {
      s.channelMemberships = snap;
      return auth;
    }
    if (ch) {
      s.channelMemberships.push({
        channel_id: chId,
        workspace_id: ch.workspace_id,
        principal_kind: t.principal_kind,
        principal_id: t.principal_id,
        role: 'owner',
        notify_pref: 'all',
        added_by_kind: actor.principal_kind,
        added_by: actorId,
        joined_at: now,
      });
    }
  }
  return { ok: true as const };
}

export function reconcileAgentIdentityMerge(
  s: State,
  {
    principal_id,
    target_agent_identity_id,
  }: {
    principal_id: string;
    target_agent_identity_id: string;
  },
) {
  const ap = (s.agentPrincipals ?? []).find((x) => x.principal_id === principal_id);
  if (!ap) return { ok: false as const };
  const oldId = ap.agent_identity_id;
  if (oldId === target_agent_identity_id) return { ok: true as const };
  ap.agent_identity_id = target_agent_identity_id;
  const oldRetained = (s.agentPrincipals ?? []).some((x) => x.agent_identity_id === oldId);
  const oldWg = s.workspaceGrants.find(
    (g) => g.workspace_id === ap.workspace_id && isPrin(g, 'agent', oldId),
  );
  const newWg = s.workspaceGrants.find(
    (g) => g.workspace_id === ap.workspace_id && isPrin(g, 'agent', target_agent_identity_id),
  );
  if (oldWg && newWg) {
    newWg.revoked_at = newWg.revoked_at ?? oldWg.revoked_at ?? ap.revoked_at ?? null;
    s.workspaceGrants = s.workspaceGrants.filter((g) => g !== oldWg);
  } else if (oldWg) {
    oldWg.principal_id = target_agent_identity_id;
    oldWg.revoked_at = oldWg.revoked_at ?? ap.revoked_at ?? null;
  }
  for (const oldOm of [...s.orgMemberships.filter((m) => isPrin(m, 'agent', oldId))]) {
    const newOm = s.orgMemberships.find(
      (m) => m.org_id === oldOm.org_id && isPrin(m, 'agent', target_agent_identity_id),
    );
    if (newOm) {
      newOm.revoked_at = newOm.revoked_at ?? oldOm.revoked_at ?? null;
      if (!oldRetained) s.orgMemberships = s.orgMemberships.filter((m) => m !== oldOm);
    } else if (!oldRetained) {
      oldOm.principal_id = target_agent_identity_id;
    } else {
      s.orgMemberships.push({ ...oldOm, principal_id: target_agent_identity_id });
    }
  }
  for (const oldCm of [
    ...s.channelMemberships.filter(
      (m) => m.workspace_id === ap.workspace_id && isPrin(m, 'agent', oldId),
    ),
  ]) {
    const newCm = s.channelMemberships.find(
      (m) => m.channel_id === oldCm.channel_id && isPrin(m, 'agent', target_agent_identity_id),
    );
    if (newCm) {
      if (oldCm.role === 'owner') newCm.role = 'owner';
      newCm.revoked_at = newCm.revoked_at ?? oldCm.revoked_at ?? null;
      s.channelMemberships = s.channelMemberships.filter((m) => m !== oldCm);
    } else {
      oldCm.principal_id = target_agent_identity_id;
    }
  }
  for (const x of s.seats ?? []) if (x.principal_id === principal_id || (!oldRetained && x.agent_identity_id === oldId)) x.agent_identity_id = target_agent_identity_id;
  if (!oldRetained) {
    for (const p of s.connectionPolicies ?? []) if (p.agent_identity_id === oldId) p.agent_identity_id = target_agent_identity_id;
    for (const r of s.approvalRequests ?? []) if (r.requested_by_agent_identity_id === oldId) r.requested_by_agent_identity_id = target_agent_identity_id;
    s.agentIdentities = s.agentIdentities.filter((a) => a.id !== oldId);
  }
  return { ok: true as const };
}

export function cascadeWorkspaceMemberRemoval(
  s: State,
  {
    workspace_id,
    principal_kind,
    principal_id: raw_principal_id,
    now = String(s.now ?? s.organizations[0]?.updated_at ?? s.organizations[0]?.created_at ?? '2026-10-21T00:00:00Z'),
  }: {
    workspace_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    now?: string;
  },
) {
  const principal_id =
    principal_kind === 'agent'
      ? resolveAgentId(s, raw_principal_id)
      : raw_principal_id;
  const revoke = <T extends { revoked_at?: string | null }>(
    rows: T[] | undefined,
    pred: (r: T) => boolean,
  ) => {
    for (const r of rows ?? []) if (r.revoked_at == null && pred(r)) r.revoked_at = now;
  };
  let foundGrant = false;
  for (const g of s.workspaceGrants) {
    if (g.workspace_id === workspace_id && isPrin(g, principal_kind, principal_id)) {
      foundGrant = true;
      if (g.revoked_at == null) g.revoked_at = now;
    }
  }
  if (!foundGrant) {
    const ws = s.workspaces.find((w) => w.workspace_id === workspace_id);
    s.workspaceGrants.push({
      workspace_id,
      org_id: ws?.org_id ?? '',
      principal_kind,
      principal_id,
      role: 'member',
      created_at: now,
      revoked_at: now,
    });
  }
  if (principal_kind === 'user')
    revoke(s.legacyMemberships, (m) => m.workspace_id === workspace_id && m.user_id === principal_id);
  revoke(
    s.channelMemberships,
    (cm) => cm.workspace_id === workspace_id && isPrin(cm, principal_kind, principal_id),
  );
  const affected = new Set<string>();
  for (const ap of s.agentPrincipals ?? []) {
    if (
      ap.workspace_id === workspace_id &&
      ((principal_kind === 'agent' && ap.agent_identity_id === principal_id) ||
        (principal_kind === 'user' && ap.owner_user_id === principal_id))
    ) {
      if (ap.revoked_at == null) ap.revoked_at = now;
      affected.add(ap.principal_id);
    }
  }
  const closedSeats: string[] = [],
    closedHandles: string[] = [];
  for (const x of s.seats ?? []) {
    if (
      x.workspace_id === workspace_id &&
      (affected.has(x.principal_id) ||
        (principal_kind === 'agent' && x.agent_identity_id === principal_id)) &&
      x.revoked_at == null
    ) {
      x.revoked_at = now;
      closedSeats.push(x.seat_id);
    }
  }
  for (const h of s.seatHandles ?? []) {
    if (h.workspace_id === workspace_id && closedSeats.includes(h.seat_id) && h.revoked_at == null) {
      h.revoked_at = now;
      closedHandles.push(h.handle_id);
    }
  }
  return { closed_seat_ids: closedSeats, closed_handle_ids: closedHandles };
}

export function cascadeOrgMemberRemoval(
  s: State,
  {
    org_id,
    principal_kind,
    principal_id: raw_principal_id,
    now = String(s.now ?? s.organizations[0]?.updated_at ?? s.organizations[0]?.created_at ?? '2026-10-21T00:00:00Z'),
  }: {
    org_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    now?: string;
  },
) {
  const principal_id =
    principal_kind === 'agent'
      ? resolveAgentId(s, raw_principal_id)
      : raw_principal_id;
  let foundMem = false;
  for (const m of s.orgMemberships) {
    if (m.org_id === org_id && isPrin(m, principal_kind, principal_id)) {
      foundMem = true;
      if (m.revoked_at == null) m.revoked_at = now;
    }
  }
  if (!foundMem) {
    s.orgMemberships.push({
      org_id,
      principal_kind,
      principal_id,
      role: 'member',
      created_at: now,
      revoked_at: now,
    });
  }
  const closedSeats: string[] = [],
    closedHandles: string[] = [];
  for (const ws of s.workspaces) {
    if (ws.org_id === org_id) {
      const res = cascadeWorkspaceMemberRemoval(s, {
        workspace_id: ws.workspace_id,
        principal_kind,
        principal_id,
        now,
      });
      closedSeats.push(...res.closed_seat_ids);
      closedHandles.push(...res.closed_handle_ids);
    }
  }
  return { closed_seat_ids: closedSeats, closed_handle_ids: closedHandles };
}

export function canReadChannelBoundFile(
  s: State,
  c: CallerContext,
  fileId: string,
  wsId: string,
  now?: string | number | null,
): boolean {
  if (!canReadWorkspace(s, c, wsId, now)) return false;
  const b = (s.fileChannelBindings ?? []).filter(
    (x) => x.file_id === fileId && x.workspace_id === wsId,
  );
  return b.every((x) => canReadChannel(s, c, x.channel_id, now));
}

export function validateChannelVisibilityTransition({
  privateChannelsEnabled = false,
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
