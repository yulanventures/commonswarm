import {
  type CallerContext,
  type ChannelJoinPolicy,
  type ChannelRole,
  type ChannelVisibility,
  type NotifyPref,
  type OrgChannelAuthorityState,
  type OrgChannelRefusal,
  type PrincipalKind,
  agentOwner,
  fail,
  hasWsGrant,
  isLive,
  isPrin,
  orgRole,
  resolveAgentId,
} from '../../../../src/protocol/org-channels-types.ts';

export const normPrinId = (s: OrgChannelAuthorityState, k: PrincipalKind, id: string): string => (k === 'agent' ? resolveAgentId(s, id) : id);
export const matchPrin = (s: OrgChannelAuthorityState, r: { principal_kind: PrincipalKind; principal_id: string }, k: PrincipalKind, id: string): boolean => r.principal_kind === k && normPrinId(s, r.principal_kind, r.principal_id) === normPrinId(s, k, id);

export function canReadOrg(s: OrgChannelAuthorityState, c: CallerContext, orgId: string, now?: string | number | null): boolean {
  if (!s.organizations.some((o) => o.id === orgId && isLive(o))) return false;
  if (c.principal_kind === 'user') return orgRole(s, orgId, 'user', c.principal_id) !== null;
  const aid = resolveAgentId(s, c.principal_id), ownerId = agentOwner(s, c, now), aRole = orgRole(s, orgId, 'agent', aid);
  if (!ownerId || s.orgMemberships.some((m) => m.org_id === orgId && isPrin(m, 'agent', aid) && m.revoked_at != null)) return false;
  if (c.connection_id) {
    const pol = (s.connectionPolicies ?? []).find((p) => p.connection_id === c.connection_id);
    if (pol && (pol.revoked_at != null || (pol.allowed_org_ids && !pol.allowed_org_ids.includes(orgId)))) return false;
  }
  const uRole = orgRole(s, orgId, 'user', ownerId);
  return uRole ? (uRole === 'guest' || aRole === 'guest' ? aRole !== null : true) : false;
}

export function canReadWorkspace(s: OrgChannelAuthorityState, c: CallerContext, wsId: string, now?: string | number | null): boolean {
  const ws = s.workspaces.find((w) => w.workspace_id === wsId && isLive(w));
  if (!ws || !canReadOrg(s, c, ws.org_id, now)) return false;
  if (c.principal_kind === 'user') {
    if (s.workspaceGrants.some((g) => g.workspace_id === wsId && isPrin(g, 'user', c.principal_id) && g.revoked_at != null)) return false;
    return hasWsGrant(s, wsId, 'user', c.principal_id) || Boolean(orgRole(s, ws.org_id, 'user', c.principal_id) !== 'guest' && (s.legacyMemberships ?? []).some((m) => m.workspace_id === wsId && m.user_id === c.principal_id && isLive(m)));
  }
  const aid = resolveAgentId(s, c.principal_id), ownerId = agentOwner(s, c, now);
  if (!ownerId || !canReadWorkspace(s, { principal_kind: 'user', principal_id: ownerId }, wsId, now) || s.workspaceGrants.some((g) => g.workspace_id === wsId && isPrin(g, 'agent', aid) && g.revoked_at != null)) return false;
  const wsAps = (s.agentPrincipals ?? []).filter((ap) => ap.workspace_id === wsId && ap.agent_identity_id === aid);
  if (wsAps.some((ap) => ap.revoked_at != null) && !wsAps.some(isLive)) return false;
  if (hasWsGrant(s, wsId, 'agent', aid)) return true;
  const uRole = orgRole(s, ws.org_id, 'user', ownerId), aRole = orgRole(s, ws.org_id, 'agent', aid);
  return Boolean(uRole && uRole !== 'guest' && (aRole ?? uRole) !== 'guest' && !s.workspaceGrants.some((g) => g.workspace_id === wsId && isPrin(g, 'user', ownerId) && isLive(g) && g.role === 'guest'));
}

export function canReadChannel(s: OrgChannelAuthorityState, c: CallerContext, chId: string, now?: string | number | null): boolean {
  const ch = s.channels.find((x) => x.channel_id === chId);
  if (!ch || ch.revoked_at != null) return false;
  const pid = c.principal_kind === 'agent' ? resolveAgentId(s, c.principal_id) : c.principal_id;
  if (!canReadWorkspace(s, c, ch.workspace_id, now)) return false;
  const ws = s.workspaces.find((w) => w.workspace_id === ch.workspace_id);
  if (!ws) return false;
  const hasCh = s.channelMemberships.some((m) => m.channel_id === chId && matchPrin(s, m, c.principal_kind, pid) && isLive(m));
  if (ch.visibility === 'workspace') {
    const gRole = s.workspaceGrants.find((g) => g.workspace_id === ch.workspace_id && matchPrin(s, g, c.principal_kind, pid) && isLive(g))?.role;
    if ((orgRole(s, ws.org_id, c.principal_kind, pid) === 'guest' || gRole === 'guest') && !hasCh) return false;
    if (c.principal_kind === 'agent') {
      const ownerId = agentOwner(s, c, now);
      if (!ownerId) return false;
      const oG = s.workspaceGrants.find((g) => g.workspace_id === ch.workspace_id && isPrin(g, 'user', ownerId) && isLive(g))?.role;
      if ((orgRole(s, ws.org_id, 'user', ownerId) === 'guest' || oG === 'guest') && !(hasCh && s.channelMemberships.some((m) => m.channel_id === chId && isPrin(m, 'user', ownerId) && isLive(m)))) return false;
    }
    return true;
  }
  if (!s.privateChannelsEnabled || !hasCh) return false;
  if (c.principal_kind === 'agent') {
    const ownerId = agentOwner(s, c, now);
    if (!ownerId || !s.channelMemberships.some((m) => m.channel_id === chId && isPrin(m, 'user', ownerId) && isLive(m))) return false;
  }
  return true;
}

export function validateChannelVisibilityTransition(p: { privateChannelsEnabled?: boolean; currentVisibility?: ChannelVisibility | null; nextVisibility: ChannelVisibility; nextJoinPolicy?: ChannelJoinPolicy | null; signalCount?: number; boundFileCount?: number; channelSlug?: string | null; workspaceSlug?: string | null; scope?: OrgChannelRefusal['scope']; }) {
  const { privateChannelsEnabled = false, currentVisibility = null, nextVisibility, nextJoinPolicy = nextVisibility === 'private' ? 'invite_only' : 'open', signalCount = 0, boundFileCount = 0, channelSlug = null, workspaceSlug = null, scope } = p;
  const sc = scope ?? { workspace: workspaceSlug, channel: channelSlug };
  if (nextVisibility === 'private') {
    if (!privateChannelsEnabled) return fail('PRIVATE_CHANNELS_DISABLED', 'feature_flag:private_channels_enabled', sc);
    if (nextJoinPolicy === 'open') return fail('PRIVATE_CHANNEL_OPEN_JOIN_FORBIDDEN', 'invite_only_join_policy', sc);
  }
  if (currentVisibility === 'private' && nextVisibility === 'workspace') return fail('PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC', 'new_public_channel', sc);
  if (currentVisibility === 'workspace' && nextVisibility === 'private' && (signalCount > 0 || boundFileCount > 0)) return fail('CHANNEL_HAS_PUBLIC_HISTORY', 'archive_and_create_private_channel', sc);
  return { ok: true as const, visibility: nextVisibility, join_policy: (nextVisibility === 'private' ? 'invite_only' : nextJoinPolicy) as ChannelJoinPolicy };
}
import {
  channelArchive,
  channelCreate,
  channelGet,
  channelList,
  channelRename,
  channelSetTopic,
  channelSetVisibility,
} from './crud.ts';
import {
  type ChannelSignalRecord,
  type SignalKind,
  type SignalMention,
  postChannelSignal,
} from './delivery-filter.ts';
import {
  authorizeFileDownloadUrl,
  bindFileToChannel,
} from './indirect-guards.ts';
import {
  channelAddMember,
  channelJoin,
  channelLeave,
  channelListMembers,
  channelRemoveMember,
  channelSetNotifyPref,
} from './members.ts';

export * from './crud.ts';
export * from './members.ts';
export * from './delivery-filter.ts';
export * from './indirect-guards.ts';

export {
  channelCreate as channel_create,
  channelList as channel_list,
  channelGet as channel_get,
  channelArchive as channel_archive,
  channelRename as channel_rename,
  channelSetTopic as channel_set_topic,
  channelSetVisibility as channel_set_visibility,
  channelJoin as channel_join,
  channelLeave as channel_leave,
  channelAddMember as channel_add_member,
  channelRemoveMember as channel_remove_member,
  channelListMembers as channel_list_members,
  channelSetNotifyPref as channel_set_notify_pref,
};

export type Slice2ChannelCommand =
  | {
      kind: 'channel_create';
      workspace_id: string;
      channel_id?: string;
      slug: string;
      purpose?: string | null;
      topic?: string | null;
      visibility?: ChannelVisibility;
      join_policy?: ChannelJoinPolicy;
      now?: string;
    }
  | {
      kind: 'channel_list';
      workspace_id: string;
      include_archived?: boolean;
    }
  | {
      kind: 'channel_get';
      workspace_id: string;
      channel_id?: string | null;
      slug?: string | null;
    }
  | {
      kind: 'channel_archive';
      workspace_id: string;
      channel_id: string;
      now?: string;
    }
  | {
      kind: 'channel_rename';
      workspace_id: string;
      channel_id: string;
      slug: string;
    }
  | {
      kind: 'channel_set_topic';
      workspace_id: string;
      channel_id: string;
      topic: string | null;
      purpose?: string | null;
    }
  | {
      kind: 'channel_set_visibility';
      workspace_id: string;
      channel_id: string;
      visibility: ChannelVisibility;
      join_policy?: ChannelJoinPolicy;
      signal_count?: number;
      bound_file_count?: number;
    }
  | {
      kind: 'channel_join';
      workspace_id: string;
      channel_id: string;
      notify_pref?: NotifyPref;
      now?: string;
    }
  | {
      kind: 'channel_leave';
      workspace_id: string;
      channel_id: string;
      now?: string;
    }
  | {
      kind: 'channel_add_member';
      workspace_id: string;
      channel_id: string;
      principal_kind: PrincipalKind;
      principal_id: string;
      role?: ChannelRole;
      notify_pref?: NotifyPref;
      now?: string;
    }
  | {
      kind: 'channel_remove_member';
      workspace_id: string;
      channel_id: string;
      principal_kind: PrincipalKind;
      principal_id: string;
      now?: string;
    }
  | {
      kind: 'channel_list_members';
      workspace_id: string;
      channel_id: string;
    }
  | {
      kind: 'channel_set_notify_pref';
      workspace_id: string;
      channel_id: string;
      notify_pref: NotifyPref;
      now?: string;
    }
  | {
      kind: 'channel_post_signal';
      signal_id?: string;
      workspace_id: string;
      channel_id?: string | null;
      thread_id?: string | null;
      thread_root_id?: string | null;
      in_reply_to?: string | null;
      signal_kind?: SignalKind;
      body: string;
      mentions?: SignalMention[];
      attachment_file_ids?: string[];
      seat_id?: string | null;
      existing_signals?: readonly ChannelSignalRecord[];
      candidate_recipients?: readonly CallerContext[];
      now?: string;
    }
  | {
      kind: 'channel_bind_file';
      file_id: string;
      workspace_id: string;
      channel_id: string;
      now?: string;
    }
  | {
      kind: 'channel_file_download_url';
      workspace_id: string;
      file_id: string;
      version_n?: number;
      ttl_seconds?: number;
    };

export const SLICE2_CHANNEL_COMMAND_KINDS = [
  'channel_create',
  'channel_list',
  'channel_get',
  'channel_archive',
  'channel_rename',
  'channel_set_topic',
  'channel_set_visibility',
  'channel_join',
  'channel_leave',
  'channel_add_member',
  'channel_remove_member',
  'channel_list_members',
  'channel_set_notify_pref',
  'channel_post_signal',
  'channel_bind_file',
  'channel_file_download_url',
] as const;

export function dispatchChannelCommand(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  cmd: Slice2ChannelCommand,
) {
  switch (cmd.kind) {
    case 'channel_create':
      return channelCreate(s, caller, cmd);
    case 'channel_list':
      return channelList(s, caller, cmd);
    case 'channel_get':
      return channelGet(s, caller, cmd);
    case 'channel_archive':
      return channelArchive(s, caller, cmd);
    case 'channel_rename':
      return channelRename(s, caller, cmd);
    case 'channel_set_topic':
      return channelSetTopic(s, caller, cmd);
    case 'channel_set_visibility':
      return channelSetVisibility(s, caller, cmd);
    case 'channel_join':
      return channelJoin(s, caller, cmd);
    case 'channel_leave':
      return channelLeave(s, caller, cmd);
    case 'channel_add_member':
      return channelAddMember(s, caller, cmd);
    case 'channel_remove_member':
      return channelRemoveMember(s, caller, cmd);
    case 'channel_list_members':
      return channelListMembers(s, caller, cmd);
    case 'channel_set_notify_pref':
      return channelSetNotifyPref(s, caller, cmd);
    case 'channel_post_signal':
      return postChannelSignal(s, caller, cmd);
    case 'channel_bind_file':
      return bindFileToChannel(s, caller, cmd);
    case 'channel_file_download_url':
      return authorizeFileDownloadUrl(s, caller, cmd);
  }
}
