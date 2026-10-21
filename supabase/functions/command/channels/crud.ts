import {
  type CallerContext, type ChannelJoinPolicy, type ChannelRole, type ChannelSummary, type ChannelVisibility,
  type OrgChannelAuthorityState, type OrgChannelRefusal, type PrincipalKind,
  agentOwner, buildOrgChannelRefusal, fail, isLive, isPrin, norm, orgRole,
} from '../../../../src/protocol/org-channels-types.ts';
import {
  canReadChannel, canReadOrg, canReadWorkspace, validateChannelVisibilityTransition,
} from './index.ts';
export { canReadChannel, canReadOrg, canReadWorkspace, validateChannelVisibilityTransition };

export const CHANNEL_SLUG_MAX = 32, CHANNEL_TOPIC_MAX = 500, CHANNEL_PURPOSE_MAX = 500;
export const RESERVED_CHANNEL_SLUGS = ['all-signals'] as const;
const CHANNEL_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export type ChannelResult<T> = ({ ok: true } & T) | { ok: false; refusal: OrgChannelRefusal };

declare module '../../../../src/protocol/org-channels-types.ts' {
  interface ChannelSummary { has_history?: boolean; revoked_at?: string | null; }
  interface ChannelMembershipRecord { added_by_kind?: PrincipalKind; }
  interface OrgChannelAuthorityState {
    signals?: ReadonlyArray<{ signal_id: string; workspace_id: string; channel_id: string | null; thread_root_id?: string | null; in_reply_to?: string | null; author_kind: 'user' | 'agent'; author_id: string; body: string; created_at: string; }>;
  }
}

export const isPrivateChannelsEnabled = (s: OrgChannelAuthorityState): boolean => s.privateChannelsEnabled === true;
export function resolvePrivateChannelsEnabledFromEnv(env?: Record<string, string | undefined>): boolean {
  const raw = env?.PRIVATE_CHANNELS_ENABLED?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export function wsScope(s: OrgChannelAuthorityState, workspaceId: string, channelSlug?: string | null, seatId?: string | null): OrgChannelRefusal['scope'] {
  const ws = s.workspaces.find((w) => w.workspace_id === workspaceId);
  const org = ws ? s.organizations.find((o) => o.id === ws.org_id) : undefined;
  return { org: org?.slug ?? ws?.org_id ?? null, workspace: ws?.slug ?? workspaceId, channel: channelSlug ?? null, ...(seatId !== undefined ? { seat_id: seatId } : {}) };
}

export const isChannelOwner = (s: OrgChannelAuthorityState, caller: CallerContext, channelId: string): boolean =>
  s.channelMemberships.some((m) => m.channel_id === channelId && isPrin(m, caller.principal_kind, caller.principal_id) && m.role === 'owner' && isLive(m));

export function isWorkspaceAdminOrOwner(s: OrgChannelAuthorityState, caller: CallerContext, workspaceId: string): boolean {
  const ws = s.workspaces.find((w) => w.workspace_id === workspaceId && isLive(w));
  if (!ws) return false;
  const grant = s.workspaceGrants.find((g) => g.workspace_id === workspaceId && isPrin(g, caller.principal_kind, caller.principal_id) && isLive(g));
  const role = grant?.role ?? orgRole(s, ws.org_id, caller.principal_kind, caller.principal_id);
  return role === 'owner' || role === 'admin';
}

export function validateChannelSlug(rawSlug: string, scope: OrgChannelRefusal['scope']): ChannelResult<{ slug: string }> {
  const slug = norm(rawSlug);
  if (slug.length < 1 || slug.length > CHANNEL_SLUG_MAX || !CHANNEL_SLUG_RE.test(slug)) return fail('CHANNEL_SLUG_INVALID', 'valid_channel_slug', { ...scope, channel: slug || rawSlug });
  if ((RESERVED_CHANNEL_SLUGS as readonly string[]).includes(slug)) return fail('CHANNEL_SLUG_RESERVED', 'unreserved_channel_slug', { ...scope, channel: slug });
  return { ok: true, slug };
}

export function requireReadableChannel(
  s: OrgChannelAuthorityState, caller: CallerContext, workspaceId: string, channelId: string, requireLive = false,
): ChannelResult<{ channel: ChannelSummary; scope: OrgChannelRefusal['scope'] }> {
  const baseScope = wsScope(s, workspaceId, channelId);
  if (!canReadWorkspace(s, caller, workspaceId)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', baseScope);
  const ch = s.channels.find((c) => c.workspace_id === workspaceId && c.channel_id === channelId);
  if (!ch) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', baseScope);
  if (ch.visibility === 'private' && !isPrivateChannelsEnabled(s)) return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', baseScope);
  if (!canReadChannel(s, caller, ch.channel_id)) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', baseScope);
  const scope = wsScope(s, workspaceId, ch.slug);
  if (requireLive && !isLive(ch)) return fail('CHANNEL_ARCHIVED', 'active_channel', scope);
  return { ok: true, channel: ch, scope };
}

export function channelCreate(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: { workspace_id: string; channel_id?: string; slug: string; purpose?: string | null; topic?: string | null; visibility?: ChannelVisibility; join_policy?: ChannelJoinPolicy; now?: string },
): ChannelResult<{ channel: ChannelSummary }> {
  const scope = wsScope(s, input.workspace_id, norm(input.slug));
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  const slugCheck = validateChannelSlug(input.slug, scope);
  if (!slugCheck.ok) return slugCheck;
  const slug = slugCheck.slug, visibility: ChannelVisibility = input.visibility ?? 'workspace';
  const joinPolicy: ChannelJoinPolicy = input.join_policy ?? (visibility === 'private' ? 'invite_only' : 'open');
  const trans = validateChannelVisibilityTransition({ privateChannelsEnabled: isPrivateChannelsEnabled(s), currentVisibility: null, nextVisibility: visibility, nextJoinPolicy: joinPolicy, channelSlug: slug, workspaceSlug: scope.workspace ?? input.workspace_id });
  if (!trans.ok) return trans;
  if (input.topic != null && input.topic.length > CHANNEL_TOPIC_MAX) return fail('CHANNEL_TOPIC_TOO_LONG', 'topic_max_500_chars', scope);
  if (input.purpose != null && input.purpose.length > CHANNEL_PURPOSE_MAX) return fail('CHANNEL_PURPOSE_TOO_LONG', 'purpose_max_500_chars', scope);
  if (s.channels.some((ch) => ch.workspace_id === input.workspace_id && norm(ch.slug) === slug && isLive(ch))) return fail('CHANNEL_SLUG_TAKEN', 'unique_channel_slug', scope);
  const ws = s.workspaces.find((w) => w.workspace_id === input.workspace_id)!, now = input.now ?? new Date().toISOString();
  const channelId = input.channel_id ?? `ch-${ws.workspace_id}-${slug}`;
  if (!channelId.trim() || s.channels.some((ch) => ch.channel_id === channelId)) return fail('CHANNEL_SLUG_TAKEN', 'unique_channel_id', scope);
  const channel: ChannelSummary = {
    channel_id: channelId, workspace_id: input.workspace_id, org_id: ws.org_id, slug, purpose: input.purpose ?? null, topic: input.topic ?? null,
    visibility, join_policy: joinPolicy, archived_at: null, created_by_principal: caller.principal_id, created_by_kind: caller.principal_kind, created_at: now, has_history: false,
  };
  s.channels.push(channel);
  const upsertOwner = (k: 'user' | 'agent', id: string, addedByKind: 'user' | 'agent', addedBy: string | null) => {
    const existing = s.channelMemberships.find((m) => m.channel_id === channelId && isPrin(m, k, id));
    if (existing) Object.assign(existing, { role: 'owner', added_by_kind: addedByKind, added_by: addedBy, revoked_at: null, joined_at: now });
    else s.channelMemberships.push({ channel_id: channelId, workspace_id: input.workspace_id, principal_kind: k, principal_id: id, role: 'owner' as ChannelRole, notify_pref: 'all', added_by_kind: addedByKind, added_by: addedBy, joined_at: now, revoked_at: null });
  };
  if (caller.principal_kind === 'user') upsertOwner('user', caller.principal_id, 'user', caller.principal_id);
  else {
    upsertOwner('agent', caller.principal_id, 'agent', caller.principal_id);
    const ownerId = agentOwner(s, caller);
    if (ownerId) upsertOwner('user', ownerId, 'agent', caller.principal_id);
  }
  return { ok: true, channel };
}

export function channelList(s: OrgChannelAuthorityState, caller: CallerContext, input: { workspace_id: string; include_archived?: boolean }): ChannelResult<{ channels: ChannelSummary[] }> {
  const scope = wsScope(s, input.workspace_id);
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', scope);
  return { ok: true, channels: s.channels.filter((ch) => ch.workspace_id === input.workspace_id && (input.include_archived || isLive(ch)) && canReadChannel(s, caller, ch.channel_id)) };
}

export function channelGet(s: OrgChannelAuthorityState, caller: CallerContext, input: { workspace_id: string; channel_id?: string | null; slug?: string | null }): ChannelResult<{ channel: ChannelSummary }> {
  const baseScope = wsScope(s, input.workspace_id, input.slug ?? input.channel_id);
  if (!canReadWorkspace(s, caller, input.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', baseScope);
  const target = s.channels.find((ch) => ch.workspace_id === input.workspace_id && ((input.channel_id && ch.channel_id === input.channel_id) || (input.slug && norm(ch.slug) === norm(input.slug))));
  if (!target) return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', baseScope);
  const check = requireReadableChannel(s, caller, input.workspace_id, target.channel_id);
  return check.ok ? { ok: true, channel: check.channel } : check;
}

export function channelSetVisibility(
  s: OrgChannelAuthorityState, caller: CallerContext,
  input: { workspace_id: string; channel_id: string; visibility: ChannelVisibility; join_policy?: ChannelJoinPolicy; signal_count?: number; bound_file_count?: number },
): ChannelResult<{ channel: ChannelSummary }> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id, true);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;
  if (input.visibility === 'private' && !isPrivateChannelsEnabled(s)) return fail('PRIVATE_CHANNELS_DISABLED', 'private_channels_enabled', scope);
  if (!(isChannelOwner(s, caller, ch.channel_id) || (ch.visibility === 'workspace' && isWorkspaceAdminOrOwner(s, caller, input.workspace_id)))) return fail('PRIVATE_CHANNEL_OWNER_REQUIRED', 'channel_owner_membership', scope);
  const nextJoinPolicy: ChannelJoinPolicy = input.join_policy ?? (input.visibility === 'private' ? 'invite_only' : ch.join_policy);
  const actualSignalCount = (s.signals ?? []).filter((sig) => sig.channel_id === ch.channel_id).length;
  const actualBoundFileCount = (s.fileChannelBindings ?? []).filter((b) => b.channel_id === ch.channel_id).length;
  const missingHistory = ch.has_history === true || (s.signals === undefined && input.signal_count === undefined && ch.has_history !== false);
  const parseCount = (v: unknown): number | null => (v === undefined ? 0 : typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const inputSignalCount = parseCount(input.signal_count), inputBoundFiles = parseCount(input.bound_file_count);
  const signalCount = missingHistory || inputSignalCount === null ? Math.max(1, actualSignalCount) : Math.max(actualSignalCount, inputSignalCount);
  const boundFiles = inputBoundFiles === null ? Math.max(1, actualBoundFileCount) : Math.max(actualBoundFileCount, inputBoundFiles);
  const trans = validateChannelVisibilityTransition({
    privateChannelsEnabled: isPrivateChannelsEnabled(s), currentVisibility: ch.visibility, nextVisibility: input.visibility,
    nextJoinPolicy, signalCount, boundFileCount: boundFiles, channelSlug: ch.slug, workspaceSlug: scope.workspace ?? input.workspace_id,
  });
  if (!trans.ok) {
    if (trans.refusal.code === 'CHANNEL_HAS_PUBLIC_HISTORY') {
      const sel = scope.org && scope.workspace ? `${scope.org}/${scope.workspace}` : (scope.workspace ?? input.workspace_id);
      return { ok: false, refusal: buildOrgChannelRefusal({ code: 'CHANNEL_HAS_PUBLIC_HISTORY', missing: 'archive_and_fork_private_channel', scope, mcp_tool: 'channel_create', cli_command: `cswarm channel archive ${ch.slug} --workspace ${sel} && cswarm channel create ${ch.slug}-private --private --workspace ${sel}` }) };
    }
    return trans;
  }
  if (norm(ch.slug) === 'general' && input.visibility === 'private') return fail('GENERAL_CHANNEL_IMMUTABLE', 'non_general_channel', scope);
  ch.visibility = input.visibility; ch.join_policy = nextJoinPolicy;
  return { ok: true, channel: ch };
}

export function channelRename(s: OrgChannelAuthorityState, caller: CallerContext, input: { workspace_id: string; channel_id: string; slug: string }): ChannelResult<{ channel: ChannelSummary }> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id, true);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;
  if (norm(ch.slug) === 'general') return fail('GENERAL_CHANNEL_IMMUTABLE', 'non_general_channel', scope);
  if (!(ch.visibility === 'private' ? isChannelOwner(s, caller, ch.channel_id) : isChannelOwner(s, caller, ch.channel_id) || isWorkspaceAdminOrOwner(s, caller, input.workspace_id))) {
    return fail('PRIVATE_CHANNEL_OWNER_REQUIRED', 'channel_owner_membership', scope);
  }
  const slugCheck = validateChannelSlug(input.slug, scope);
  if (!slugCheck.ok) return slugCheck;
  if (s.channels.some((o) => o.workspace_id === input.workspace_id && o.channel_id !== ch.channel_id && norm(o.slug) === slugCheck.slug && isLive(o))) {
    return fail('CHANNEL_SLUG_TAKEN', 'unique_channel_slug', { ...scope, channel: slugCheck.slug });
  }
  ch.slug = slugCheck.slug;
  return { ok: true, channel: ch };
}

export function channelSetTopic(s: OrgChannelAuthorityState, caller: CallerContext, input: { workspace_id: string; channel_id: string; topic: string | null; purpose?: string | null }): ChannelResult<{ channel: ChannelSummary }> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id, true);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;
  if (input.topic !== null && input.topic.length > CHANNEL_TOPIC_MAX) return fail('CHANNEL_TOPIC_TOO_LONG', 'topic_max_500_chars', scope);
  if (input.purpose != null && input.purpose.length > CHANNEL_PURPOSE_MAX) return fail('CHANNEL_PURPOSE_TOO_LONG', 'purpose_max_500_chars', scope);
  ch.topic = input.topic;
  if (input.purpose !== undefined) ch.purpose = input.purpose;
  return { ok: true, channel: ch };
}

export function channelArchive(s: OrgChannelAuthorityState, caller: CallerContext, input: { workspace_id: string; channel_id: string; now?: string }): ChannelResult<{ channel: ChannelSummary }> {
  const check = requireReadableChannel(s, caller, input.workspace_id, input.channel_id);
  if (!check.ok) return check;
  const { channel: ch, scope } = check;
  if (norm(ch.slug) === 'general') return fail('GENERAL_CHANNEL_IMMUTABLE', 'non_general_channel', scope);
  if (!(ch.visibility === 'private' ? isChannelOwner(s, caller, ch.channel_id) : isChannelOwner(s, caller, ch.channel_id) || isWorkspaceAdminOrOwner(s, caller, input.workspace_id))) {
    return fail('PRIVATE_CHANNEL_OWNER_REQUIRED', 'channel_owner_membership', scope);
  }
  ch.archived_at = input.now ?? new Date().toISOString();
  return { ok: true, channel: ch };
}
