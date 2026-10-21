import {
  type CallerContext, type ChannelSummary, type MultiOrgWhoamiResponse, type OrgApprovalRequest, type OrgChannelAuthorityState,
  type OrgChannelRefusal, type OrganizationSummary, type OrgRole, type PrincipalKind, type WorkspaceRecord, type WorkspaceSelectorChoice,
  buildMultiOrgWhoamiResponse, buildOrgChannelRefusal, canReadChannel, canReadChannelBoundFile, canReadOrg, canReadWorkspace,
  isLive, isPrin, norm, orgRole, resolveOrgWorkspaceChannelSelector,
} from '../../../src/protocol/org-channels-contract.js';
import { effCallerOrgRole } from '../../../src/cloud/org-channels-cli.js';
import { type EnrichedOrgChannelRefusal, enrichOrgChannelRefusal } from './org-channels-channels.js';

export { type EnrichedOrgChannelRefusal, enrichOrgChannelRefusal };

export interface OrgInviteRecord {
  invite_id: string; org_id: string; email?: string | null; principal_kind?: PrincipalKind; principal_id?: string | null;
  role: OrgRole; workspace_ids: string[]; invited_by: string; expires_at: string; created_at: string; consumed_at?: string | null; revoked_at?: string | null;
}

export interface OrgLogoRenditionBlob {
  object_key: string; width: number; height: number; content_type: string; byte_length: number; sha256: string; data_base64: string;
}

export interface OrgLogoArtifact {
  org_id: string; object_key: string; content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'; byte_length: number;
  renditions: { '64': string; '128': string; '256': string }; rendition_blobs?: Record<'64' | '128' | '256', OrgLogoRenditionBlob>;
  sanitized_svg?: string; updated_at: string;
}

export interface OrgChannelSlice3State extends OrgChannelAuthorityState {
  orgInvites?: OrgInviteRecord[]; approvalRequests?: OrgApprovalRequest[]; orgLogos?: Record<string, OrgLogoArtifact>;
  signals?: Array<{ signal_id: string; workspace_id: string; channel_id?: string | null; thread_id?: string | null }>;
}

export interface McpCallerAuth {
  principal_kind: PrincipalKind; principal_id: string; owner_user_id?: string | null; connection_id?: string | null; seat?: string | null; seat_id?: string | null;
}

export const ORG_CHANNEL_TOOL_NAMES = [
  'whoami', 'discover', 'org_list', 'org_get', 'org_create', 'org_update', 'org_delete', 'org_switch_default',
  'org_list_members', 'org_invite_member', 'org_set_member_role', 'org_remove_member', 'org_confirm_action',
  'org_assign_workspace_member', 'org_remove_workspace_member', 'workspace_list', 'workspace_create',
  'workspace_join', 'workspace_leave', 'workspace_list_members', 'org_move_workspace', 'org_logo_upload', 'org_logo_remove',
  'channel_list', 'channel_create', 'channel_join', 'channel_leave', 'channel_add_member', 'channel_remove_member',
  'channel_list_members', 'channel_archive', 'channel_rename', 'channel_set_topic', 'channel_set_notify_pref',
] as const;

export type OrgChannelToolName = (typeof ORG_CHANNEL_TOOL_NAMES)[number];
const SEL = ['seat', 'seat_id', 'org', 'workspace', 'channel'] as const;

const SPECS: ReadonlyArray<readonly [OrgChannelToolName, 'read' | 'write', readonly string[], readonly string[]]> = [
  ['whoami', 'read', [], ['allowed_org_ids']], ['discover', 'read', [], ['allowed_org_ids']],
  ['org_list', 'read', [], ['allowed_org_ids']], ['org_get', 'read', [], []],
  ['org_create', 'write', ['slug', 'display_name'], ['slug', 'display_name', 'workspace_slug', 'workspace_name']],
  ['org_update', 'write', [], ['display_name', 'slug', 'new_slug', 'request_approval']],
  ['org_delete', 'write', ['confirm_slug'], ['confirm_slug', 'request_approval']],
  ['org_switch_default', 'write', ['org'], ['allowed_org_ids']], ['org_list_members', 'read', [], ['kind']],
  ['org_invite_member', 'write', [], ['email', 'principal_id', 'principal_kind', 'role', 'workspace_ids', 'display_name', 'request_approval']],
  ['org_set_member_role', 'write', ['principal_id', 'role'], ['principal_id', 'principal_kind', 'role', 'request_approval']],
  ['org_remove_member', 'write', ['principal_id'], ['principal_id', 'principal_kind', 'request_approval']],
  ['org_confirm_action', 'write', ['approval_id', 'decision'], ['approval_id', 'decision']],
  ['org_assign_workspace_member', 'write', ['principal_id'], ['principal_id', 'principal_kind', 'role']],
  ['org_remove_workspace_member', 'write', ['principal_id'], ['principal_id', 'principal_kind']],
  ['workspace_list', 'read', [], []], ['workspace_create', 'write', ['slug', 'name'], ['slug', 'name']],
  ['workspace_join', 'write', [], []], ['workspace_leave', 'write', [], []], ['workspace_list_members', 'read', [], []],
  ['org_move_workspace', 'write', ['target_org'], ['target_org', 'transfer_members', 'request_approval']],
  ['org_logo_upload', 'write', ['content_type'], ['content_type', 'data_base64', 'svg', 'byte_length']],
  ['org_logo_remove', 'write', [], []], ['channel_list', 'read', [], []],
  ['channel_create', 'write', ['slug'], ['slug', 'visibility', 'join_policy', 'topic', 'purpose']],
  ['channel_join', 'write', [], []], ['channel_leave', 'write', [], []],
  ['channel_add_member', 'write', ['principal_id'], ['principal_id', 'principal_kind', 'role']],
  ['channel_remove_member', 'write', ['principal_id'], ['principal_id', 'principal_kind']],
  ['channel_list_members', 'read', [], []], ['channel_archive', 'write', [], []],
  ['channel_rename', 'write', [], ['new_slug', 'slug', 'visibility', 'join_policy']],
  ['channel_set_topic', 'write', ['topic'], ['topic', 'purpose']],
  ['channel_set_notify_pref', 'write', ['notify_pref'], ['notify_pref']],
];

const ARR_KEYS = new Set(['workspace_ids', 'allowed_org_ids']), BOOL_KEYS = new Set(['request_approval']), NUM_KEYS = new Set(['byte_length']);

const ENUMS: Record<string, readonly string[]> = {
  principal_kind: ['user', 'agent'], kind: ['all', 'user', 'agent', 'guest'], visibility: ['workspace', 'private'],
  join_policy: ['open', 'invite_only'], notify_pref: ['all', 'mentions', 'mute'], transfer_members: ['all', 'owners_only'], decision: ['approve', 'reject'],
};

const fieldEnum = (t: OrgChannelToolName, k: string) =>
  k === 'role' ? (t.startsWith('channel_') ? ['owner', 'member'] : ['owner', 'admin', 'member', 'guest']) : (ENUMS[k] ?? null);

function propSchema(t: OrgChannelToolName, k: string): Record<string, unknown> {
  if (ARR_KEYS.has(k)) return { type: 'array', items: { type: 'string' } };
  if (BOOL_KEYS.has(k)) return { type: 'boolean' };
  if (NUM_KEYS.has(k)) return { type: 'number' };
  const en = fieldEnum(t, k);
  return en ? { type: 'string', enum: [...en] } : { type: 'string' };
}

export const ORG_CHANNEL_TOOL_SPECS = SPECS.map(([name, effect, required, extra]) => ({
  name, effect, title: name, description: name, required, allowed: Array.from(new Set([...SEL, ...extra])),
}));

export const ORG_CHANNEL_MCP_TOOLS = ORG_CHANNEL_TOOL_SPECS.map((s) => ({
  name: s.name, title: s.title, description: s.description, securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }],
  annotations: { title: s.title, readOnlyHint: s.effect === 'read', destructiveHint: s.effect === 'write', idempotentHint: s.effect === 'read', openWorldHint: false },
  inputSchema: { type: 'object', properties: Object.fromEntries(s.allowed.map((k) => [k, propSchema(s.name, k)])), required: [...s.required], additionalProperties: false },
}));

export class OrgChannelToolInputError extends Error {
  code = 'INVALID_ARGUMENTS';
  constructor(message: string) { super(message); this.name = 'OrgChannelToolInputError'; }
}

export const isOrgChannelToolName = (v: string): v is OrgChannelToolName => (ORG_CHANNEL_TOOL_NAMES as readonly string[]).includes(v);

export function validateOrgChannelToolArguments(name: string, value: unknown): Record<string, unknown> {
  if (!isOrgChannelToolName(name)) throw new OrgChannelToolInputError(`Unknown org/channel tool: ${name}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OrgChannelToolInputError('Expected JSON object.');
  const args = value as Record<string, unknown>, spec = ORG_CHANNEL_TOOL_SPECS.find((s) => s.name === name)!, extra = ['thread_id', 'signal_id', 'file_id', 'request_id'];
  for (const k of Object.keys(args)) if (!spec.allowed.includes(k) && !extra.includes(k)) throw new OrgChannelToolInputError(`Unknown argument "${k}".`);
  for (const req of spec.required) if (args[req] === undefined || args[req] === null || args[req] === '') throw new OrgChannelToolInputError(`Missing required argument "${req}".`);
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    const en = fieldEnum(name, k);
    const bad = ARR_KEYS.has(k) ? !Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim().length > 0)
      : BOOL_KEYS.has(k) ? typeof v !== 'boolean'
      : NUM_KEYS.has(k) ? typeof v !== 'number' || !Number.isFinite(v) || v < 0
      : typeof v !== 'string' || Boolean(en && !en.includes(v));
    if (bad) throw new OrgChannelToolInputError(`Invalid "${k}" (INVALID_ARGUMENTS).`);
  }
  return args;
}

export const failEnriched = (code: string, missing: string, scope?: OrgChannelRefusal['scope'], choices?: WorkspaceSelectorChoice[]) => ({
  ok: false as const, refusal: enrichOrgChannelRefusal(buildOrgChannelRefusal({ code, missing, scope, choices })),
});

const callerCtx = (c: McpCallerAuth): CallerContext => ({
  principal_kind: c.principal_kind, principal_id: c.principal_id, owner_user_id: c.owner_user_id ?? null, connection_id: c.connection_id ?? null,
});

export function resolveSeatIdFromAuthOrArgs(
  s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>,
): { ok: true; seat_id: string | null } | { ok: false; refusal: EnrichedOrgChannelRefusal } {
  const str = (v: unknown) => (typeof v === 'string' && v.trim()) || null;
  const argS = str(args.seat_id), authS = str(caller.seat_id), argH = str(args.seat), authH = str(caller.seat);
  if ((argS && authS && argS !== authS) || (argH && authH && argH !== authH)) {
    return failEnriched('WORKSPACE_SEAT_MISMATCH', 'matching_seat', { seat_id: argS ?? argH });
  }
  let seatId = argS || authS;
  const rawH = argH || authH;
  if (rawH) {
    const byS = (s.seats ?? []).find((x) => x.seat_id === rawH && isLive(x));
    const h = byS ? null : (s.seatHandles ?? []).find((x) => x.handle_id === rawH);
    if (!byS && (!h || !isLive(h))) return failEnriched('WORKSPACE_ACCESS_DENIED', 'active_seat_handle', { seat_id: rawH });
    const hSeatId = byS ? byS.seat_id : h!.seat_id;
    if (seatId && seatId !== hSeatId) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'matching_seat_and_seat_id', { seat_id: seatId });
    seatId = hSeatId;
  }
  if (!seatId) return { ok: true, seat_id: null };
  const seat = (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x));
  if (!seat || (caller.principal_kind === 'agent' && seat.agent_identity_id && seat.agent_identity_id !== caller.principal_id) || !canReadWorkspace(s, callerCtx(caller), seat.workspace_id)) {
    return failEnriched('WORKSPACE_ACCESS_DENIED', 'active_seat_workspace_access', { seat_id: seatId });
  }
  return { ok: true, seat_id: seatId };
}

export function resolveMcpOrgWorkspaceChannel(
  s: OrgChannelSlice3State, caller: McpCallerAuth,
  args: { org?: string | null; workspace?: string | null; channel?: string | null; seat?: string | null; seat_id?: string | null; thread_id?: string | null; signal_id?: string | null; file_id?: string | null },
): { ok: true; org: OrganizationSummary; workspace: WorkspaceRecord; channel: ChannelSummary | null; source: 'explicit' | 'seat' | 'connection_default' | 'inferred'; seat_id: string | null } | { ok: false; refusal: EnrichedOrgChannelRefusal } {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args as Record<string, unknown>);
  if (!seatRes.ok) return seatRes;
  const expOrg = args.org?.trim() || null, expWs = args.workspace?.trim() || null, findOrg = (t: string) => s.organizations.find((o) => isLive(o) && (o.id === t || norm(o.slug) === norm(t)));
  if (expOrg && expWs?.includes('/')) {
    const o1 = findOrg(expOrg), o2 = findOrg(expWs.split('/', 2)[0]!.trim());
    if (!o1 || !o2 || o1.id !== o2.id) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'org_workspace_selector_conflict', { org: expOrg, workspace: expWs, seat_id: seatRes.seat_id });
  }
  const c = callerCtx(caller), resolved = resolveOrgWorkspaceChannelSelector(s, c, { org: args.org ?? null, workspace: args.workspace ?? null, channel: args.channel ?? null, seat_id: seatRes.seat_id });
  if (!resolved.ok) return { ok: false, refusal: enrichOrgChannelRefusal(resolved.refusal) };
  const sigId = args.signal_id?.trim() || args.thread_id?.trim() || null;
  if (sigId) {
    const sig = (s.signals ?? []).find((x) => x.signal_id === sigId || x.thread_id === sigId);
    if (sig) {
      if (sig.workspace_id !== resolved.workspace.workspace_id) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'signal_workspace_scope', { org: resolved.org.slug, workspace: resolved.workspace.slug, seat_id: seatRes.seat_id });
      if (sig.channel_id && !canReadChannel(s, c, sig.channel_id)) {
        const ch = s.channels.find((x) => x.channel_id === sig.channel_id);
        return failEnriched('CHANNEL_ACCESS_DENIED', 'channel_membership', { org: resolved.org.slug, workspace: resolved.workspace.slug, channel: ch?.slug ?? sig.channel_id, seat_id: seatRes.seat_id });
      }
    }
  }
  if (args.file_id?.trim() && !canReadChannelBoundFile(s, c, args.file_id.trim(), resolved.workspace.workspace_id)) {
    return failEnriched('CHANNEL_ACCESS_DENIED', 'file_channel_access', { org: resolved.org.slug, workspace: resolved.workspace.slug, seat_id: seatRes.seat_id });
  }
  return { ...resolved, seat_id: seatRes.seat_id };
}

export function executeMultiOrgWhoami(
  s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown> = {},
): ({ ok: true } & MultiOrgWhoamiResponse) | { ok: false; status: 'refused'; refusal: EnrichedOrgChannelRefusal } {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args);
  if (!seatRes.ok) return { ok: false, status: 'refused', refusal: seatRes.refusal };
  const seatId = seatRes.seat_id, c = callerCtx(caller), oTok = typeof args.org === 'string' && args.org.trim() ? args.org.trim() : null;
  if ((typeof args.workspace === 'string' && args.workspace.trim()) || (typeof args.channel === 'string' && args.channel.trim())) {
    const chk = resolveMcpOrgWorkspaceChannel(s, caller, { org: oTok, workspace: (args.workspace as string | undefined) ?? null, channel: (args.channel as string | undefined) ?? null, seat_id: seatId });
    if (!chk.ok) return { ok: false, status: 'refused', refusal: chk.refusal };
  } else if (oTok) {
    const found = s.organizations.find((o) => isLive(o) && canReadOrg(s, c, o.id) && (o.id === oTok || norm(o.slug) === norm(oTok)));
    if (!found) return { ok: false, status: 'refused', refusal: failEnriched('ORG_ACCESS_DENIED', 'org_membership', { org: oTok, seat_id: seatId }).refusal };
    const seat = seatId ? (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x)) : undefined;
    const seatWs = seat ? s.workspaces.find((w) => w.workspace_id === seat.workspace_id && isLive(w)) : undefined;
    if (seatWs && seatWs.org_id !== found.id) return { ok: false, status: 'refused', refusal: failEnriched('WORKSPACE_SEAT_MISMATCH', `seat_in_${found.slug}`, { org: found.slug, workspace: seatWs.slug, seat_id: seatId }).refusal };
  }
  const orgFilter = oTok ? norm(oTok) : null;
  if (caller.principal_kind === 'agent') {
    const rank: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 };
    const base = buildMultiOrgWhoamiResponse(s, { agent_identity_id: caller.principal_id, connection_id: caller.connection_id ?? null, seat_id: seatId });
    const capped = base.organizations.map((o) => {
      const eff = effCallerOrgRole(s, c, o.org_id) ?? o.role;
      return { ...o, role: eff, workspaces: o.workspaces.map((w) => {
        const rawW = s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, 'agent', caller.principal_id) && isLive(g))?.role ?? eff;
        return { ...w, role: rank[rawW] <= rank[eff] ? rawW : eff };
      }) };
    });
    const liveO = new Set(capped.map((o) => o.org_id)), liveW = new Set(capped.flatMap((o) => o.workspaces.map((w) => w.workspace_id)));
    return { ...base, ok: true, default_org_id: base.default_org_id && liveO.has(base.default_org_id) ? base.default_org_id : null, default_workspace_id: base.default_workspace_id && liveW.has(base.default_workspace_id) ? base.default_workspace_id : null, organizations: orgFilter ? capped.filter((o) => o.org_id === oTok || norm(o.slug) === orgFilter) : capped };
  }
  const organizations = s.organizations.filter((o) => isLive(o) && canReadOrg(s, c, o.id) && (!orgFilter || o.id === oTok || norm(o.slug) === orgFilter)).map((o) => {
    const id = caller.principal_id, r = orgRole(s, o.id, 'user', id)!;
    const workspaces = s.workspaces.filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, c, w.workspace_id)).map((w) => ({
      workspace_id: w.workspace_id, slug: w.slug, name: w.name, role: s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, 'user', id) && isLive(g))?.role ?? r,
      channels: s.channels.filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(s, c, ch.channel_id)).map((ch) => ({ channel_id: ch.channel_id, slug: ch.slug, visibility: ch.visibility })),
    }));
    return { org_id: o.id, slug: o.slug, display_name: o.display_name, role: r, workspaces };
  });
  const id = caller.principal_id, w0 = organizations[0]?.workspaces[0]?.workspace_id ?? null;
  return { ok: true, agent_identity_id: id, owner_user_id: id, display_name: id, active_seat: null, default_org_id: organizations[0]?.org_id ?? null, default_workspace_id: w0, organizations };
}

export { executeOrgChannelMcpTool } from './org-channels-handlers.js';
