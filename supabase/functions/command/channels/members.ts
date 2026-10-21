import {
  type CallerContext,
  type ChannelMembershipRecord,
  type ChannelRole,
  type NotifyPref,
  type OrgChannelAuthorityState,
  type PrincipalKind,
  agentOwner,
  canReadChannel,
  canReadWorkspace,
  fail,
  hasWsGrant,
  isLive,
  isPrin,
  norm,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type ChannelResult,
  isChannelOwner,
  isPrivateChannelsEnabled,
  isWorkspaceAdminOrOwner,
  requireReadableChannel,
  wsScope,
} from './crud.js';

export const NOTIFY_PREFS = ['all', 'mentions', 'mute'] as const;

function hasLiveChannelMember(
  s: OrgChannelAuthorityState,
  channelId: string,
  kind: PrincipalKind,
  id: string,
): boolean {
  return s.channelMemberships.some(
    (m) => m.channel_id === channelId && isPrin(m, kind, id) && isLive(m),
  );
}

function cascadeOwnedAgentsOnChannelExit(
  s: OrgChannelAuthorityState,
  channelId: string,
  userId: string,
  now: string,
): string[] {
  const ownedIds = new Set(
    s.agentIdentities.filter((ai) => ai.owner_user_id === userId).map((ai) => ai.id),
  );
  const cascaded: string[] = [];
  for (const m of s.channelMemberships) {
    if (
      m.channel_id === channelId &&
      m.principal_kind === 'agent' &&
      ownedIds.has(m.principal_id) &&
      isLive(m)
    ) {
      m.revoked_at = now;
      cascaded.push(m.principal_id);
    }
  }
  return cascaded;
}

function isLastPrivateChannelOwner(
  s: OrgChannelAuthorityState,
  channelId: string,
  kind: PrincipalKind,
  id: string,
): boolean {
  const otherOwners = s.channelMemberships.filter(
    (m) =>
      m.channel_id === channelId &&
      isLive(m) &&
      m.role === 'owner' &&
      !isPrin(m, kind, id),
  );
  const otherMembers = s.channelMemberships.filter(
    (m) => m.channel_id === channelId && isLive(m) && !isPrin(m, kind, id),
  );
  return otherOwners.length === 0 && otherMembers.length > 0;
}

export function channelJoin(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    channel_id: string;
    notify_pref?: NotifyPref;
    now?: string;
  },
): ChannelResult<{ membership: ChannelMembershipRecord }> {
  const baseScope = wsScope(s, input.workspace_id, input.channel_id);
  if (!canReadWorkspace(s, caller, input.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', baseScope);
  }
  const ch = s.channels.find(
    (c) => c.workspace_id === input.workspace_id && c.channel_id === input.channel_id,
  );
  if (!ch) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', baseScope);
  const scope = wsScope(s, input.workspace_id, ch.slug);
  if (ch.visibility === 'private' && !isPrivateChannelsEnabled(s)) {
    return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
  }
  if (!isLive(ch)) return fail('CHANNEL_ARCHIVED', 'active_channel', scope);

  if (ch.visibility === 'private' || ch.join_policy === 'invite_only') {
    const existingLive = s.channelMemberships.find(
      (m) =>
        m.channel_id === ch.channel_id &&
        isPrin(m, caller.principal_kind, caller.principal_id) &&
        isLive(m),
    );
    if (existingLive && canReadChannel(s, caller, ch.channel_id)) {
      return { ok: true, membership: existingLive };
    }
    return fail('CHANNEL_ACCESS_DENIED', 'channel_owner_invite', scope);
  }

  const now = input.now ?? new Date().toISOString();
  const notifyPref: NotifyPref = input.notify_pref ?? 'all';
  const existing = s.channelMemberships.find(
    (m) =>
      m.channel_id === ch.channel_id &&
      isPrin(m, caller.principal_kind, caller.principal_id),
  );
  if (existing) {
    existing.revoked_at = null;
    existing.joined_at = now;
    if (input.notify_pref) existing.notify_pref = notifyPref;
    return { ok: true, membership: existing };
  }

  const membership: ChannelMembershipRecord = {
    channel_id: ch.channel_id,
    workspace_id: ch.workspace_id,
    principal_kind: caller.principal_kind,
    principal_id: caller.principal_id,
    role: 'member',
    notify_pref: notifyPref,
    added_by: caller.principal_kind === 'user' ? caller.principal_id : null,
    joined_at: now,
    revoked_at: null,
  };
  s.channelMemberships.push(membership);
  return { ok: true, membership };
}

export function channelAddMember(
  s: OrgChannelAuthorityState,
  actor: CallerContext,
  input: {
    workspace_id: string;
    channel_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    role?: ChannelRole;
    notify_pref?: NotifyPref;
    now?: string;
  },
): ChannelResult<{ membership: ChannelMembershipRecord }> {
  const check = requireReadableChannel(
    s,
    actor,
    input.workspace_id,
    input.channel_id,
    true,
  );
  if (!check.ok) return check;
  const { channel: ch, scope } = check;

  if (ch.visibility === 'private') {
    if (!isChannelOwner(s, actor, ch.channel_id)) {
      return fail('PRIVATE_CHANNEL_OWNER_REQUIRED', 'channel_owner_membership', scope);
    }
  } else if (
    !isChannelOwner(s, actor, ch.channel_id) &&
    !isWorkspaceAdminOrOwner(s, actor, ch.workspace_id)
  ) {
    return fail(
      'CHANNEL_OWNER_OR_ADMIN_REQUIRED',
      'channel_owner_or_workspace_admin',
      scope,
    );
  }

  const targetCaller: CallerContext = {
    principal_kind: input.principal_kind,
    principal_id: input.principal_id,
  };
  if (
    !hasWsGrant(s, ch.workspace_id, input.principal_kind, input.principal_id) ||
    !canReadWorkspace(s, targetCaller, ch.workspace_id)
  ) {
    return fail('TARGET_MISSING_WORKSPACE_GRANT', 'target_workspace_grant', scope);
  }

  if (ch.visibility === 'private' && input.principal_kind === 'agent') {
    const ownerId = agentOwner(s, targetCaller);
    if (!ownerId || !hasLiveChannelMember(s, ch.channel_id, 'user', ownerId)) {
      return fail(
        'AGENT_OWNER_NOT_IN_PRIVATE_CHANNEL',
        'agent_owner_channel_membership',
        scope,
      );
    }
  }

  const now = input.now ?? new Date().toISOString();
  const role: ChannelRole = input.role ?? 'member';
  const notifyPref: NotifyPref = input.notify_pref ?? 'all';
  const addedByUser =
    actor.principal_kind === 'user' ? actor.principal_id : agentOwner(s, actor);

  const existing = s.channelMemberships.find(
    (m) =>
      m.channel_id === ch.channel_id &&
      isPrin(m, input.principal_kind, input.principal_id),
  );
  if (existing) {
    existing.role = role;
    existing.notify_pref = notifyPref;
    existing.added_by = addedByUser;
    existing.joined_at = now;
    existing.revoked_at = null;
    return { ok: true, membership: existing };
  }

  const membership: ChannelMembershipRecord = {
    channel_id: ch.channel_id,
    workspace_id: ch.workspace_id,
    principal_kind: input.principal_kind,
    principal_id: input.principal_id,
    role,
    notify_pref: notifyPref,
    added_by: addedByUser,
    joined_at: now,
    revoked_at: null,
  };
  s.channelMemberships.push(membership);
  return { ok: true, membership };
}

export function channelRemoveMember(
  s: OrgChannelAuthorityState,
  actor: CallerContext,
  input: {
    workspace_id: string;
    channel_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    now?: string;
  },
): ChannelResult<{
  revoked_membership: ChannelMembershipRecord;
  cascaded_agent_ids: string[];
}> {
  const check = requireReadableChannel(s, actor, input.workspace_id, input.channel_id);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;

  const isOwnAgent =
    actor.principal_kind === 'user' &&
    input.principal_kind === 'agent' &&
    s.agentIdentities.some(
      (ai) =>
        ai.id === input.principal_id &&
        ai.owner_user_id === actor.principal_id &&
        isLive(ai),
    );
  const allowed =
    isChannelOwner(s, actor, ch.channel_id) ||
    isOwnAgent ||
    (ch.visibility === 'workspace' && isWorkspaceAdminOrOwner(s, actor, ch.workspace_id));
  if (!allowed) {
    return fail('PRIVATE_CHANNEL_OWNER_REQUIRED', 'channel_owner_membership', scope);
  }

  const targetMem = s.channelMemberships.find(
    (m) =>
      m.channel_id === ch.channel_id &&
      isPrin(m, input.principal_kind, input.principal_id) &&
      isLive(m),
  );
  if (!targetMem) {
    return fail('CHANNEL_MEMBER_NOT_FOUND', 'target_channel_membership', scope);
  }
  if (
    ch.visibility === 'private' &&
    targetMem.role === 'owner' &&
    isLastPrivateChannelOwner(s, ch.channel_id, input.principal_kind, input.principal_id)
  ) {
    return fail('CANNOT_REMOVE_LAST_CHANNEL_OWNER', 'another_channel_owner', scope);
  }

  const now = input.now ?? new Date().toISOString();
  targetMem.revoked_at = now;
  const cascaded =
    input.principal_kind === 'user'
      ? cascadeOwnedAgentsOnChannelExit(s, ch.channel_id, input.principal_id, now)
      : [];
  return { ok: true, revoked_membership: targetMem, cascaded_agent_ids: cascaded };
}

export function channelLeave(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: { workspace_id: string; channel_id: string; now?: string },
): ChannelResult<{
  revoked_membership: ChannelMembershipRecord;
  cascaded_agent_ids: string[];
}> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;
  if (norm(ch.slug) === 'general') {
    return fail('CANNOT_LEAVE_GENERAL_CHANNEL', 'non_general_channel', scope);
  }

  const selfMem = s.channelMemberships.find(
    (m) =>
      m.channel_id === ch.channel_id &&
      isPrin(m, caller.principal_kind, caller.principal_id) &&
      isLive(m),
  );
  if (!selfMem) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', scope);

  if (
    ch.visibility === 'private' &&
    selfMem.role === 'owner' &&
    isLastPrivateChannelOwner(s, ch.channel_id, caller.principal_kind, caller.principal_id)
  ) {
    return fail('CANNOT_LEAVE_AS_LAST_CHANNEL_OWNER', 'another_channel_owner', scope);
  }

  const now = input.now ?? new Date().toISOString();
  selfMem.revoked_at = now;
  const cascaded =
    caller.principal_kind === 'user'
      ? cascadeOwnedAgentsOnChannelExit(s, ch.channel_id, caller.principal_id, now)
      : [];
  return { ok: true, revoked_membership: selfMem, cascaded_agent_ids: cascaded };
}

export function channelListMembers(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: { workspace_id: string; channel_id: string },
): ChannelResult<{ members: ChannelMembershipRecord[] }> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id);
  if (!check.ok) return check;
  const { channel: ch } = check;
  const members = s.channelMemberships.filter(
    (m) =>
      m.channel_id === ch.channel_id &&
      m.workspace_id === ch.workspace_id &&
      isLive(m) &&
      canReadChannel(
        s,
        { principal_kind: m.principal_kind, principal_id: m.principal_id },
        ch.channel_id,
      ),
  );
  return { ok: true, members };
}

export function channelSetNotifyPref(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    channel_id: string;
    notify_pref: NotifyPref;
    now?: string;
  },
): ChannelResult<{ membership: ChannelMembershipRecord }> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;
  if (!(NOTIFY_PREFS as readonly string[]).includes(input.notify_pref)) {
    return fail('INVALID_NOTIFY_PREF', 'notify_pref_all_mentions_or_mute', scope);
  }
  const existing = s.channelMemberships.find(
    (m) =>
      m.channel_id === ch.channel_id &&
      isPrin(m, caller.principal_kind, caller.principal_id) &&
      isLive(m),
  );
  if (existing) {
    existing.notify_pref = input.notify_pref;
    return { ok: true, membership: existing };
  }
  const membership: ChannelMembershipRecord = {
    channel_id: ch.channel_id,
    workspace_id: ch.workspace_id,
    principal_kind: caller.principal_kind,
    principal_id: caller.principal_id,
    role: 'member',
    notify_pref: input.notify_pref,
    added_by: caller.principal_kind === 'user' ? caller.principal_id : null,
    joined_at: input.now ?? new Date().toISOString(),
    revoked_at: null,
  };
  s.channelMemberships.push(membership);
  return { ok: true, membership };
}
