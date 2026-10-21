import {
  type CallerContext,
  type ChannelJoinPolicy,
  type ChannelRole,
  type ChannelSummary,
  type ChannelVisibility,
  type NotifyPref,
  type OrgChannelRefusal,
  type OrganizationSummary,
  type OrgRole,
  type PrincipalKind,
  type WorkspaceMoveTransferMode,
  type WorkspaceRecord,
  type WorkspaceSelectorChoice,
  agentOwner,
  buildOrgChannelRefusal,
  canModifyChannelMembership,
  canReadChannel,
  canReadOrg,
  canReadWorkspace,
  cascadeWorkspaceMemberRemoval,
  isLive,
  isPrin,
  norm,
  orgRole,
  reconcileWorkspaceMove,
  validateChannelVisibilityTransition,
} from '../../../src/protocol/org-channels-contract.js';
import {
  ORG_CHANNEL_TOOL_NAMES,
  type McpCallerAuth,
  type OrgChannelSlice3State,
  type OrgChannelToolName,
} from './org-channels-tools.js';
import { SLUG_RE, enqueueApproval, upsertWsGrant } from './org-channels-subtools.js';

export type EnrichedOrgChannelRefusal = OrgChannelRefusal & { grant_command_hint: string };

export function isRegisteredTool(v: string): v is OrgChannelToolName {
  return (ORG_CHANNEL_TOOL_NAMES as readonly string[]).includes(v);
}

export function enrichOrgChannelRefusal(r: OrgChannelRefusal): EnrichedOrgChannelRefusal {
  const s = r.scope ?? {};
  const sel = s.org && s.workspace ? `${s.org}/${s.workspace}` : (s.workspace ?? s.org ?? 'default');
  let mcp: OrgChannelToolName = 'org_list', cli = 'cswarm org list';
  if (r.code === 'WORKSPACE_SEAT_MISMATCH' || r.code === 'AMBIGUOUS_WORKSPACE_SELECTOR') {
    mcp = 'workspace_list'; cli = `cswarm workspace list${s.org ? ` --org ${s.org}` : ''}`;
  } else if (r.code === 'CHANNEL_ACCESS_DENIED' || r.code === 'PRIVATE_CHANNEL_INVITE_REQUIRED' || r.code === 'PRIVATE_CHANNEL_OWNER_REQUIRED') {
    mcp = 'channel_add_member'; cli = `cswarm channel add-member --workspace ${sel} --channel ${s.channel ?? 'general'} --principal <principal_id>`;
  } else if (r.code.includes('CHANNEL') || r.code === 'DEFAULT_CHANNEL_MUST_BE_PUBLIC') {
    mcp = 'channel_list'; cli = `cswarm channel list --workspace ${sel}`;
  } else if (r.code === 'ORG_ACCESS_DENIED' || r.code === 'ORG_NOT_FOUND' || r.code === 'MEMBER_NOT_FOUND' || r.code === 'INVALID_INVITE_TARGET') {
    mcp = 'org_invite_member'; cli = `cswarm org invite <principal_id>${s.org ? ` --org ${s.org}` : ''}`;
  } else if (r.code.includes('OWNER') || r.code.includes('ADMIN')) {
    mcp = 'org_list_members'; cli = `cswarm org members${s.org ? ` --org ${s.org}` : ''}`;
  } else if (r.code.includes('APPROVAL')) {
    mcp = 'org_confirm_action'; cli = `cswarm org confirm <approval_id> --approve${s.org ? ` --org ${s.org}` : ''}`;
  } else if (r.code.includes('WORKSPACE') || r.code.includes('GUEST')) {
    mcp = 'org_assign_workspace_member'; cli = `cswarm org members grant <principal_id> --workspace ${sel}`;
  }
  const finalMcp = isRegisteredTool(r.mcp_tool) ? r.mcp_tool : mcp;
  return { ...r, mcp_tool: finalMcp, cli_command: cli, grant_command_hint: cli };
}

export const ref = (code: string, missing: string, scope?: OrgChannelRefusal['scope'], choices?: WorkspaceSelectorChoice[]) => ({
  ok: false as const,
  status: 'refused' as const,
  refusal: enrichOrgChannelRefusal(buildOrgChannelRefusal({ code, missing, scope, choices })),
});

const isDef = (c: ChannelSummary): boolean =>
  Boolean((c as ChannelSummary & { is_default?: boolean }).is_default) || norm(c.slug) === 'general';

export function executeWorkspaceScopeTool(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  _ctx: CallerContext,
  org: OrganizationSummary,
  ws: WorkspaceRecord,
  callerOrgRole: OrgRole | null,
  name: string,
  args: Record<string, unknown>,
  now: string,
): Record<string, unknown> | null {
  const inferKind = (id: string) => ((args.principal_kind as PrincipalKind | undefined) ?? (s.agentIdentities.some((a) => a.id === id) ? 'agent' : 'user')) as PrincipalKind;
  if (name === 'org_assign_workspace_member' || name === 'org_remove_workspace_member') {
    if (callerOrgRole !== 'owner' && callerOrgRole !== 'admin') return ref('ORG_ADMIN_REQUIRED', 'org_owner_or_admin_role', { org: org.slug, workspace: ws.slug });
    const pId = String(args.principal_id), pKind = inferKind(pId);
    if (name === 'org_assign_workspace_member') {
      if (!canReadOrg(s, { principal_kind: pKind, principal_id: pId }, org.id)) return ref('ORG_ACCESS_DENIED', 'target_org_membership', { org: org.slug, workspace: ws.slug });
      const gRole = ((args.role as OrgRole | undefined) ?? orgRole(s, org.id, pKind, pId) ?? 'member') as OrgRole;
      const agentPrincipalId = upsertWsGrant(s, ws.workspace_id, org.id, pKind, pId, gRole, now, caller.principal_id);
      return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, principal_id: pId, principal_kind: pKind, role: gRole, agent_principal_id: agentPrincipalId };
    }
    return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, principal_id: pId, principal_kind: pKind, ...cascadeWorkspaceMemberRemoval(s, { workspace_id: ws.workspace_id, principal_kind: pKind, principal_id: pId, now }) };
  }
  if (name === 'workspace_leave') return { ok: true, workspace_id: ws.workspace_id, ...cascadeWorkspaceMemberRemoval(s, { workspace_id: ws.workspace_id, principal_kind: caller.principal_kind, principal_id: caller.principal_id, now }) };
  if (name === 'workspace_list_members') return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, members: s.workspaceGrants.filter((g) => g.workspace_id === ws.workspace_id && isLive(g)) };
  if (name === 'org_move_workspace') {
    const tok = String(args.target_org).trim();
    const dst = s.organizations.find((o) => isLive(o) && (o.id === tok || norm(o.slug) === norm(tok)));
    if (!dst) return ref('ORG_NOT_FOUND', 'target_org', { org: tok, workspace: ws.slug });
    const mode = ((args.transfer_members as WorkspaceMoveTransferMode | undefined) ?? 'owners_only') as WorkspaceMoveTransferMode;
    if (caller.principal_kind === 'agent' || args.request_approval === true) return enqueueApproval(s, caller, org, 'org_move_workspace', { org: org.id, workspace: ws.workspace_id, target_org: dst.id, transfer_members: mode }, ws.workspace_id);
    const moved = reconcileWorkspaceMove(s, { workspace_id: ws.workspace_id, target_org_id: dst.id, actor_user_id: caller.principal_id, transfer_members: mode, now });
    return moved.ok ? { ...moved, workspace_id: ws.workspace_id, transfer_members: mode } : { ok: false, status: 'refused', refusal: enrichOrgChannelRefusal(moved.refusal) };
  }
  return null;
}

export function executeChannelMcpSubtool(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  ctx: CallerContext,
  org: OrganizationSummary,
  ws: WorkspaceRecord,
  callerOrgRole: OrgRole | null,
  name: string,
  args: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
  const upsertChMem = (chId: string, k: PrincipalKind, id: string, role: ChannelRole, pref: NotifyPref = 'all') => {
    const ex = s.channelMemberships.find((m) => m.channel_id === chId && isPrin(m, k, id));
    if (ex) { ex.role = role; ex.notify_pref = pref; ex.revoked_at = null; }
    else s.channelMemberships.push({ channel_id: chId, workspace_id: ws.workspace_id, principal_kind: k, principal_id: id, role, notify_pref: pref, joined_at: now, revoked_at: null });
  };
  const wsGrantRole = s.workspaceGrants.find((g) => g.workspace_id === ws.workspace_id && isPrin(g, caller.principal_kind, caller.principal_id) && isLive(g))?.role ?? null;
  const RANK: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 };
  const effWsRole: OrgRole | null = !callerOrgRole || callerOrgRole === 'guest' ? (callerOrgRole === 'guest' && wsGrantRole ? 'guest' : null)
    : wsGrantRole ? (caller.principal_kind === 'agent' && RANK[wsGrantRole] > RANK[callerOrgRole] ? callerOrgRole : wsGrantRole) : callerOrgRole;
  if (name === 'channel_list') {
    return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, channels: s.channels.filter((ch) => ch.workspace_id === ws.workspace_id && isLive(ch) && canReadChannel(s, ctx, ch.channel_id)) };
  }
  if (name === 'channel_create') {
    if (!effWsRole || effWsRole === 'guest') return ref('CHANNEL_CREATE_FORBIDDEN', 'member_role', { org: org.slug, workspace: ws.slug });
    const slug = norm(String(args.slug));
    if (!SLUG_RE.test(slug)) return ref('INVALID_CHANNEL_SLUG', 'valid_channel_slug', { org: org.slug, workspace: ws.slug, channel: slug });
    const vis = ((args.visibility as ChannelVisibility | undefined) ?? 'workspace') as ChannelVisibility;
    const jp = ((args.join_policy as ChannelJoinPolicy | undefined) ?? (vis === 'private' ? 'invite_only' : 'open')) as ChannelJoinPolicy;
    if (slug === 'general' && (vis === 'private' || jp !== 'open')) return ref('DEFAULT_CHANNEL_MUST_BE_PUBLIC', 'public_general_channel', { org: org.slug, workspace: ws.slug, channel: slug });
    const tr = validateChannelVisibilityTransition({ privateChannelsEnabled: s.privateChannelsEnabled ?? true, nextVisibility: vis, nextJoinPolicy: jp, channelSlug: slug, workspaceSlug: `${org.slug}/${ws.slug}` });
    if (!tr.ok) return { ok: false, status: 'refused', refusal: enrichOrgChannelRefusal(tr.refusal) };
    if (s.channels.some((c) => c.workspace_id === ws.workspace_id && norm(c.slug) === slug && isLive(c))) return ref('CHANNEL_SLUG_TAKEN', 'unique_channel_slug', { org: org.slug, workspace: ws.slug, channel: slug });
    const ch: ChannelSummary = { channel_id: `ch-${s.channels.length + 1}`, workspace_id: ws.workspace_id, org_id: org.id, slug, visibility: vis, join_policy: jp, topic: typeof args.topic === 'string' ? args.topic : null, purpose: typeof args.purpose === 'string' ? args.purpose : null, created_by_principal: caller.principal_id, created_by_kind: caller.principal_kind, created_at: now };
    s.channels.push(ch);
    upsertChMem(ch.channel_id, caller.principal_kind, caller.principal_id, 'owner');
    if (caller.principal_kind === 'agent') {
      const ownerId = agentOwner(s, ctx);
      if (ownerId) upsertChMem(ch.channel_id, 'user', ownerId, 'owner');
    }
    return { ok: true, channel: ch };
  }
  const chTok = typeof args.channel === 'string' && args.channel.trim() ? args.channel.trim() : 'general';
  const ch = s.channels.find((c) => c.workspace_id === ws.workspace_id && isLive(c) && (c.channel_id === chTok || norm(c.slug) === norm(chTok)));
  if (!ch) return ref('CHANNEL_ACCESS_DENIED', 'channel_membership', { org: org.slug, workspace: ws.slug, channel: norm(chTok) });
  if (name === 'channel_join') {
    const chk = canModifyChannelMembership(s, ctx, ch.channel_id, { principal_kind: caller.principal_kind, principal_id: caller.principal_id });
    if (!chk.ok) return { ok: false, status: 'refused', refusal: enrichOrgChannelRefusal(chk.refusal) };
    const exRole = s.channelMemberships.find((m) => m.channel_id === ch.channel_id && isPrin(m, caller.principal_kind, caller.principal_id) && isLive(m))?.role ?? 'member';
    upsertChMem(ch.channel_id, caller.principal_kind, caller.principal_id, exRole);
    return { ok: true, channel_id: ch.channel_id, slug: ch.slug };
  }
  if (!canReadChannel(s, ctx, ch.channel_id)) return ref('CHANNEL_ACCESS_DENIED', 'channel_membership', { org: org.slug, workspace: ws.slug, channel: ch.slug });
  const cScope = { org: org.slug, workspace: ws.slug, channel: ch.slug };
  if (name === 'channel_leave') {
    if (isDef(ch)) return ref('CANNOT_LEAVE_GENERAL_CHANNEL', 'non_general_channel', cScope);
    const mem = s.channelMemberships.find((m) => m.channel_id === ch.channel_id && isPrin(m, caller.principal_kind, caller.principal_id) && isLive(m));
    if (mem) mem.revoked_at = now;
    return { ok: true, channel_id: ch.channel_id, left: true };
  }
  const chRole = s.channelMemberships.find((m) => m.channel_id === ch.channel_id && isPrin(m, caller.principal_kind, caller.principal_id) && isLive(m))?.role ?? null;
  const isChAdmin = effWsRole !== 'guest' && (ch.visibility === 'private'
    ? (chRole === 'owner' || callerOrgRole === 'owner' || callerOrgRole === 'admin')
    : (chRole === 'owner' || effWsRole === 'owner' || effWsRole === 'admin'));
  if (name === 'channel_add_member' || name === 'channel_remove_member') {
    const pId = String(args.principal_id);
    const pKind = ((args.principal_kind as PrincipalKind | undefined) ?? (s.agentIdentities.some((a) => a.id === pId) ? 'agent' : 'user')) as PrincipalKind;
    const chk = canModifyChannelMembership(s, ctx, ch.channel_id, { principal_kind: pKind, principal_id: pId });
    if (!chk.ok) return { ok: false, status: 'refused', refusal: enrichOrgChannelRefusal(chk.refusal) };
    const ex = s.channelMemberships.find((m) => m.channel_id === ch.channel_id && isPrin(m, pKind, pId) && isLive(m));
    if (name === 'channel_add_member') {
      if (!canReadWorkspace(s, { principal_kind: pKind, principal_id: pId }, ws.workspace_id)) return ref('WORKSPACE_ACCESS_DENIED', 'target_workspace_grant', cScope);
      const cRole = ((args.role as ChannelRole | undefined) ?? 'member') as ChannelRole;
      if ((cRole === 'owner' || ex?.role === 'owner') && !isChAdmin) {
        return ref(ch.visibility === 'private' ? 'PRIVATE_CHANNEL_OWNER_REQUIRED' : 'CHANNEL_ADMIN_REQUIRED', 'channel_owner_or_admin_role', cScope);
      }
      upsertChMem(ch.channel_id, pKind, pId, cRole);
      return { ok: true, channel_id: ch.channel_id, principal_id: pId, principal_kind: pKind, role: cRole };
    }
    if (!isPrin({ principal_kind: pKind, principal_id: pId }, caller.principal_kind, caller.principal_id) && !isChAdmin) {
      return ref(ch.visibility === 'private' ? 'PRIVATE_CHANNEL_OWNER_REQUIRED' : 'CHANNEL_ADMIN_REQUIRED', 'channel_owner_or_admin_role', cScope);
    }
    if (ex) ex.revoked_at = now;
    return { ok: true, channel_id: ch.channel_id, principal_id: pId, principal_kind: pKind, removed: true };
  }
  if (name === 'channel_list_members') return { ok: true, channel_id: ch.channel_id, members: s.channelMemberships.filter((m) => m.channel_id === ch.channel_id && isLive(m)) };
  if (name === 'channel_archive' || name === 'channel_delete') {
    if (!isChAdmin) return ref(ch.visibility === 'private' ? 'PRIVATE_CHANNEL_OWNER_REQUIRED' : 'CHANNEL_ADMIN_REQUIRED', ch.visibility === 'private' ? 'channel_owner_role' : 'channel_owner_or_admin_role', cScope);
    if (isDef(ch)) return ref('CANNOT_ARCHIVE_GENERAL_CHANNEL', 'non_general_channel', cScope);
    ch.archived_at = now;
    return { ok: true, channel_id: ch.channel_id, archived_at: now };
  }
  if (name === 'channel_rename' || name === 'channel_set_visibility' || name === 'channel_update') {
    if (!isChAdmin) return ref(ch.visibility === 'private' ? 'PRIVATE_CHANNEL_OWNER_REQUIRED' : 'CHANNEL_ADMIN_REQUIRED', ch.visibility === 'private' ? 'channel_owner_role' : 'channel_owner_or_admin_role', cScope);
    if (args.visibility || args.join_policy) {
      const nextVis = ((args.visibility as ChannelVisibility | undefined) ?? ch.visibility) as ChannelVisibility;
      const nextJp = ((args.join_policy as ChannelJoinPolicy | undefined) ?? (nextVis === 'private' ? 'invite_only' : ch.join_policy)) as ChannelJoinPolicy;
      const tr = validateChannelVisibilityTransition({
        privateChannelsEnabled: s.privateChannelsEnabled ?? true,
        currentVisibility: ch.visibility,
        nextVisibility: nextVis,
        nextJoinPolicy: nextJp,
        signalCount: (s.signals ?? []).filter((sig) => sig.channel_id === ch.channel_id).length,
        boundFileCount: (s.fileChannelBindings ?? []).filter((f) => f.channel_id === ch.channel_id).length,
        channelSlug: ch.slug,
        workspaceSlug: `${org.slug}/${ws.slug}`,
      });
      if (!tr.ok) return { ok: false, status: 'refused', refusal: enrichOrgChannelRefusal(tr.refusal) };
      if (isDef(ch) && (nextVis === 'private' || nextJp !== 'open')) return ref('DEFAULT_CHANNEL_MUST_BE_PUBLIC', 'public_general_channel', cScope);
      ch.visibility = nextVis;
      ch.join_policy = nextJp;
    }
    const rawNew = (args.new_slug ?? args.slug) as string | undefined;
    if (rawNew) {
      if (isDef(ch)) return ref('CANNOT_RENAME_GENERAL_CHANNEL', 'non_general_channel', cScope);
      const nextSlug = norm(rawNew);
      if (!SLUG_RE.test(nextSlug)) return ref('INVALID_CHANNEL_SLUG', 'valid_channel_slug', { org: org.slug, workspace: ws.slug, channel: nextSlug });
      if (s.channels.some((c) => c.workspace_id === ws.workspace_id && c.channel_id !== ch.channel_id && norm(c.slug) === nextSlug && isLive(c))) return ref('CHANNEL_SLUG_TAKEN', 'unique_channel_slug', { org: org.slug, workspace: ws.slug, channel: nextSlug });
      ch.slug = nextSlug;
    }
    return { ok: true, channel: ch };
  }
  if (name === 'channel_set_topic') {
    if (effWsRole === 'guest' || callerOrgRole === 'guest') return ref('CHANNEL_UPDATE_FORBIDDEN', 'member_role', cScope);
    const topic = String(args.topic);
    if (topic.length > 500) return ref('TOPIC_TOO_LONG', 'topic_max_500_chars', cScope);
    ch.topic = topic;
    if (typeof args.purpose === 'string') ch.purpose = args.purpose;
    return { ok: true, channel: ch };
  }
  if (name === 'channel_set_notify_pref') {
    const pref = String(args.notify_pref) as NotifyPref;
    if (!['all', 'mentions', 'mute'].includes(pref)) return ref('INVALID_NOTIFY_PREF', 'notify_pref_all_mentions_or_mute', cScope);
    const role: ChannelRole = s.channelMemberships.find((m) => m.channel_id === ch.channel_id && isPrin(m, caller.principal_kind, caller.principal_id) && isLive(m))?.role ?? 'member';
    upsertChMem(ch.channel_id, caller.principal_kind, caller.principal_id, role, pref);
    return { ok: true, channel_id: ch.channel_id, role, notify_pref: pref };
  }
  return ref('UNKNOWN_TOOL', 'supported_mcp_tool');
}
