import {
  type CallerContext,
  type ChannelSummary,
  type MultiOrgWhoamiResponse,
  type OrgApprovalRequest,
  type OrgChannelAuthorityState,
  type OrgChannelRefusal,
  type OrganizationSummary,
  type OrgRole,
  type PrincipalKind,
  type WorkspaceRecord,
  buildMultiOrgWhoamiResponse,
  buildOrgChannelRefusal,
  canReadChannel,
  canReadChannelBoundFile,
  canReadOrg,
  canReadWorkspace,
  fail,
  isLive,
  isPrin,
  norm,
  orgRole,
  resolveOrgWorkspaceChannelSelector,
} from '../../../src/protocol/org-channels-contract.js';

export interface OrgInviteRecord {
  invite_id: string;
  org_id: string;
  email?: string | null;
  principal_kind?: PrincipalKind;
  principal_id?: string | null;
  role: OrgRole;
  workspace_ids: string[];
  invited_by: string;
  expires_at: string;
  created_at: string;
  consumed_at?: string | null;
  revoked_at?: string | null;
}

export interface OrgLogoArtifact {
  org_id: string;
  object_key: string;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  byte_length: number;
  renditions: { '64': string; '128': string; '256': string };
  sanitized_svg?: string;
  updated_at: string;
}

export interface OrgChannelSlice3State extends OrgChannelAuthorityState {
  orgInvites?: OrgInviteRecord[];
  approvalRequests?: OrgApprovalRequest[];
  orgLogos?: Record<string, OrgLogoArtifact>;
  signals?: Array<{ signal_id: string; workspace_id: string; channel_id?: string | null; thread_id?: string | null }>;
}

export interface McpCallerAuth {
  principal_kind: PrincipalKind;
  principal_id: string;
  owner_user_id?: string | null;
  connection_id?: string | null;
  seat?: string | null;
  seat_id?: string | null;
}

export const ORG_CHANNEL_TOOL_NAMES = [
  'whoami', 'discover',
  'org_list', 'org_get', 'org_create', 'org_update', 'org_delete', 'org_switch_default',
  'org_list_members', 'org_invite_member', 'org_set_member_role', 'org_remove_member', 'org_confirm_action',
  'org_assign_workspace_member', 'org_remove_workspace_member',
  'workspace_list', 'workspace_create', 'workspace_join', 'workspace_leave', 'workspace_list_members', 'org_move_workspace',
  'org_logo_upload', 'org_logo_remove',
  'channel_list', 'channel_create', 'channel_join', 'channel_leave',
  'channel_add_member', 'channel_remove_member', 'channel_list_members',
  'channel_archive', 'channel_rename', 'channel_set_topic', 'channel_set_notify_pref',
] as const;

export type OrgChannelToolName = (typeof ORG_CHANNEL_TOOL_NAMES)[number];
const SEL = ['seat', 'seat_id', 'org', 'workspace', 'channel'] as const;

const SPECS: ReadonlyArray<readonly [OrgChannelToolName, 'read' | 'write', string, readonly string[], readonly string[]]> = [
  ['whoami', 'read', 'Multi-org identity & discovery', [], []],
  ['discover', 'read', 'Discover orgs, workspaces, and channels', [], []],
  ['org_list', 'read', 'List organizations', [], []],
  ['org_get', 'read', 'Get organization details', [], []],
  ['org_create', 'write', 'Create organization', ['slug', 'display_name'], ['slug', 'display_name', 'workspace_slug', 'workspace_name']],
  ['org_update', 'write', 'Update organization', [], ['display_name', 'slug', 'new_slug']],
  ['org_delete', 'write', 'Delete organization', ['confirm_slug'], ['confirm_slug', 'request_approval']],
  ['org_switch_default', 'write', 'Switch default organization/workspace', ['org'], []],
  ['org_list_members', 'read', 'List organization members and agents', [], ['kind']],
  ['org_invite_member', 'write', 'Invite or add org member/agent', [], ['email', 'principal_id', 'principal_kind', 'role', 'workspace_ids', 'display_name', 'request_approval']],
  ['org_set_member_role', 'write', 'Set organization member role', ['principal_id', 'role'], ['principal_id', 'principal_kind', 'role', 'request_approval']],
  ['org_remove_member', 'write', 'Remove organization member or agent', ['principal_id'], ['principal_id', 'principal_kind', 'request_approval']],
  ['org_confirm_action', 'write', 'Confirm or reject owner approval card', ['approval_id', 'decision'], ['approval_id', 'decision']],
  ['org_assign_workspace_member', 'write', 'Grant workspace access', ['principal_id'], ['principal_id', 'principal_kind', 'role']],
  ['org_remove_workspace_member', 'write', 'Revoke workspace access', ['principal_id'], ['principal_id', 'principal_kind']],
  ['workspace_list', 'read', 'List workspaces', [], []],
  ['workspace_create', 'write', 'Create workspace', ['slug', 'name'], ['slug', 'name']],
  ['workspace_join', 'write', 'Join workspace', [], []],
  ['workspace_leave', 'write', 'Leave workspace', [], []],
  ['workspace_list_members', 'read', 'List workspace members', [], []],
  ['org_move_workspace', 'write', 'Move workspace between organizations', ['target_org'], ['target_org', 'transfer_members', 'request_approval']],
  ['org_logo_upload', 'write', 'Upload organization logo', ['content_type'], ['content_type', 'data_base64', 'svg', 'byte_length']],
  ['org_logo_remove', 'write', 'Remove organization logo', [], []],
  ['channel_list', 'read', 'List channels', [], []],
  ['channel_create', 'write', 'Create channel', ['slug'], ['slug', 'visibility', 'join_policy', 'topic', 'purpose']],
  ['channel_join', 'write', 'Join channel', [], []],
  ['channel_leave', 'write', 'Leave channel', [], []],
  ['channel_add_member', 'write', 'Add member or agent to channel', ['principal_id'], ['principal_id', 'principal_kind', 'role']],
  ['channel_remove_member', 'write', 'Remove member or agent from channel', ['principal_id'], ['principal_id', 'principal_kind']],
  ['channel_list_members', 'read', 'List channel members', [], []],
  ['channel_archive', 'write', 'Archive channel', [], []],
  ['channel_rename', 'write', 'Rename or update channel visibility', [], ['new_slug', 'slug', 'visibility', 'join_policy']],
  ['channel_set_topic', 'write', 'Set channel topic', ['topic'], ['topic', 'purpose']],
  ['channel_set_notify_pref', 'write', 'Set channel notification preference', ['notify_pref'], ['notify_pref']],
];

export const ORG_CHANNEL_TOOL_SPECS = SPECS.map(([name, effect, title, required, extra]) => ({
  name, effect, title, description: title, required, allowed: Array.from(new Set([...SEL, ...extra])),
}));

export const ORG_CHANNEL_MCP_TOOLS = ORG_CHANNEL_TOOL_SPECS.map((s) => ({
  name: s.name,
  title: s.title,
  description: s.description,
  securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }],
  annotations: { title: s.title, readOnlyHint: s.effect === 'read', destructiveHint: s.effect === 'write', idempotentHint: s.effect === 'read', openWorldHint: false },
  inputSchema: { type: 'object', properties: Object.fromEntries(s.allowed.map((k) => [k, { type: 'string' }])), required: [...s.required], additionalProperties: false },
}));

export class OrgChannelToolInputError extends Error {
  constructor(message: string) { super(message); this.name = 'OrgChannelToolInputError'; }
}

export function isOrgChannelToolName(v: string): v is OrgChannelToolName {
  return (ORG_CHANNEL_TOOL_NAMES as readonly string[]).includes(v);
}

export function validateOrgChannelToolArguments(name: string, value: unknown): Record<string, unknown> {
  if (!isOrgChannelToolName(name)) throw new OrgChannelToolInputError(`Unknown org/channel tool: ${name}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OrgChannelToolInputError('Expected a JSON object of tool arguments.');
  const args = value as Record<string, unknown>;
  const spec = ORG_CHANNEL_TOOL_SPECS.find((s) => s.name === name)!;
  const extra = ['thread_id', 'signal_id', 'file_id', 'request_id'];
  for (const k of Object.keys(args)) {
    if (!spec.allowed.includes(k) && !extra.includes(k)) throw new OrgChannelToolInputError(`Unknown argument "${k}" for ${name}. Allowed: ${spec.allowed.join(', ')}`);
  }
  for (const req of spec.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') throw new OrgChannelToolInputError(`Missing required argument "${req}" for ${name}.`);
  }
  return args;
}

export function resolveSeatIdFromAuthOrArgs(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  args: Record<string, unknown>,
): { ok: true; seat_id: string | null } | { ok: false; refusal: OrgChannelRefusal } {
  const rawSeatId = (typeof args.seat_id === 'string' && args.seat_id.trim()) || caller.seat_id || null;
  const rawHandle = (typeof args.seat === 'string' && args.seat.trim()) || caller.seat || null;
  if (rawSeatId) return { ok: true, seat_id: rawSeatId };
  if (!rawHandle) return { ok: true, seat_id: null };
  const bySeatId = (s.seats ?? []).find((x) => x.seat_id === rawHandle);
  if (bySeatId) return { ok: true, seat_id: bySeatId.seat_id };
  const handleRow = (s.seatHandles ?? []).find((h) => h.handle_id === rawHandle);
  if (!handleRow || !isLive(handleRow)) return fail('WORKSPACE_ACCESS_DENIED', 'active_seat_handle', { seat_id: rawHandle });
  return { ok: true, seat_id: handleRow.seat_id };
}

export function resolveMcpOrgWorkspaceChannel(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  args: { org?: string | null; workspace?: string | null; channel?: string | null; seat?: string | null; seat_id?: string | null; thread_id?: string | null; signal_id?: string | null; file_id?: string | null },
): { ok: true; org: OrganizationSummary; workspace: WorkspaceRecord; channel: ChannelSummary | null; source: 'explicit' | 'seat' | 'connection_default' | 'inferred'; seat_id: string | null } | { ok: false; refusal: OrgChannelRefusal } {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args as Record<string, unknown>);
  if (!seatRes.ok) return seatRes;
  const c: CallerContext = { principal_kind: caller.principal_kind, principal_id: caller.principal_id, owner_user_id: caller.owner_user_id ?? null, connection_id: caller.connection_id ?? null };
  const resolved = resolveOrgWorkspaceChannelSelector(s, c, { org: args.org ?? null, workspace: args.workspace ?? null, channel: args.channel ?? null, seat_id: seatRes.seat_id });
  if (!resolved.ok) return resolved;

  const sigId = args.signal_id?.trim() || args.thread_id?.trim() || null;
  if (sigId) {
    const sig = (s.signals ?? []).find((x) => x.signal_id === sigId || x.thread_id === sigId);
    if (sig) {
      if (sig.workspace_id !== resolved.workspace.workspace_id) return fail('WORKSPACE_SEAT_MISMATCH', 'signal_workspace_scope', { org: resolved.org.slug, workspace: resolved.workspace.slug, seat_id: seatRes.seat_id });
      if (sig.channel_id && !canReadChannel(s, c, sig.channel_id)) {
        const ch = s.channels.find((x) => x.channel_id === sig.channel_id);
        return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', { org: resolved.org.slug, workspace: resolved.workspace.slug, channel: ch?.slug ?? sig.channel_id, seat_id: seatRes.seat_id });
      }
    }
  }
  if (args.file_id?.trim() && !canReadChannelBoundFile(s, c, args.file_id.trim(), resolved.workspace.workspace_id)) {
    return fail('CHANNEL_ACCESS_DENIED', 'file_channel_access', { org: resolved.org.slug, workspace: resolved.workspace.slug, seat_id: seatRes.seat_id });
  }
  return { ...resolved, seat_id: seatRes.seat_id };
}

export function executeMultiOrgWhoami(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  args: Record<string, unknown> = {},
): ({ ok: true } & MultiOrgWhoamiResponse) | { ok: false; status: 'refused'; refusal: OrgChannelRefusal } {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args);
  if (!seatRes.ok) return { ok: false, status: 'refused', refusal: seatRes.refusal };
  const seatId = seatRes.seat_id;
  const c: CallerContext = { principal_kind: caller.principal_kind, principal_id: caller.principal_id, owner_user_id: caller.owner_user_id ?? null, connection_id: caller.connection_id ?? null };
  if (seatId && (typeof args.org === 'string' || typeof args.workspace === 'string')) {
    const check = resolveOrgWorkspaceChannelSelector(s, c, { org: (args.org as string | undefined) ?? null, workspace: (args.workspace as string | undefined) ?? null, seat_id: seatId });
    if (!check.ok) return { ok: false, status: 'refused', refusal: check.refusal };
  } else if (seatId) {
    const seat = (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x));
    if (!seat || !canReadWorkspace(s, c, seat.workspace_id)) {
      return { ok: false, status: 'refused', refusal: buildOrgChannelRefusal({ code: 'WORKSPACE_ACCESS_DENIED', missing: 'active_seat_workspace_access', scope: { seat_id: seatId } }) };
    }
  }
  if (caller.principal_kind === 'agent') {
    const base = buildMultiOrgWhoamiResponse(s, { agent_identity_id: caller.principal_id, connection_id: caller.connection_id ?? null, seat_id: seatId });
    const liveOrgs = new Set(base.organizations.map((o) => o.org_id));
    const liveWs = new Set(base.organizations.flatMap((o) => o.workspaces.map((w) => w.workspace_id)));
    const orgFilter = typeof args.org === 'string' ? norm(args.org) : null;
    const filtered = orgFilter ? base.organizations.filter((o) => o.org_id === args.org || norm(o.slug) === orgFilter) : base.organizations;
    return {
      ok: true,
      ...base,
      default_org_id: base.default_org_id && liveOrgs.has(base.default_org_id) ? base.default_org_id : null,
      default_workspace_id: base.default_workspace_id && liveWs.has(base.default_workspace_id) ? base.default_workspace_id : null,
      organizations: filtered,
    };
  }
  const organizations = s.organizations
    .filter((o) => isLive(o) && canReadOrg(s, c, o.id))
    .map((o) => {
      const r = orgRole(s, o.id, 'user', caller.principal_id)!;
      const workspaces = s.workspaces
        .filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, c, w.workspace_id))
        .map((w) => {
          const wg = s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, 'user', caller.principal_id) && isLive(g));
          const channels = s.channels
            .filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(s, c, ch.channel_id))
            .map((ch) => ({ channel_id: ch.channel_id, slug: ch.slug, visibility: ch.visibility }));
          return { workspace_id: w.workspace_id, slug: w.slug, name: w.name, role: wg?.role ?? r, channels };
        });
      return { org_id: o.id, slug: o.slug, display_name: o.display_name, role: r, workspaces };
    });
  return { ok: true, agent_identity_id: caller.principal_id, owner_user_id: caller.principal_id, display_name: caller.principal_id, active_seat: null, default_org_id: organizations[0]?.org_id ?? null, default_workspace_id: organizations[0]?.workspaces[0]?.workspace_id ?? null, organizations };
}

export { executeOrgChannelMcpTool } from './org-channels-handlers.js';
