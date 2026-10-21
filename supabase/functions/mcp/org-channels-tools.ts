import {
  type CallerContext, type ChannelSummary, type MultiOrgWhoamiResponse, type OrgApprovalRequest, type OrgChannelAuthorityState,
  type OrgChannelRefusal, type OrganizationSummary, type OrgRole, type PrincipalKind, type WorkspaceRecord, type WorkspaceSelectorChoice,
  buildMultiOrgWhoamiResponse, buildOrgChannelRefusal, canReadChannel, canReadChannelBoundFile, canReadOrg, canReadWorkspace,
  isLive, isPrin, norm, orgRole, resolveOrgWorkspaceChannelSelector,
} from '../../../src/protocol/org-channels-contract.js';
import { effCallerOrgRole } from '../../../src/cloud/org-channels-cli.js';
import { type EnrichedOrgChannelRefusal, enrichOrgChannelRefusal } from './org-channels-channels.js';

export { type EnrichedOrgChannelRefusal, enrichOrgChannelRefusal };

export interface OrgInviteRecord { invite_id: string; org_id: string; email?: string | null; principal_kind?: PrincipalKind; principal_id?: string | null; role: OrgRole; workspace_ids: string[]; invited_by: string; expires_at: string; created_at: string; consumed_at?: string | null; revoked_at?: string | null; }
export interface OrgLogoRenditionBlob { object_key: string; width: number; height: number; content_type: string; byte_length: number; sha256: string; data_base64: string; }
export interface OrgLogoArtifact { org_id: string; object_key: string; content_type: string; byte_length: number; renditions: Record<'64' | '128' | '256', string>; rendition_blobs?: Record<'64' | '128' | '256', OrgLogoRenditionBlob>; sanitized_svg?: string; updated_at: string; }
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

const SPECS: ReadonlyArray<readonly [OrgChannelToolName, 0 | 1, readonly string[], readonly string[]]> = [
  ['whoami', 0, [], ['allowed_org_ids']], ['discover', 0, [], ['allowed_org_ids']],
  ['org_list', 0, [], ['allowed_org_ids']], ['org_get', 0, [], []],
  ['org_create', 1, ['slug', 'display_name'], ['slug', 'display_name', 'workspace_slug', 'workspace_name']],
  ['org_update', 1, [], ['display_name', 'slug', 'new_slug', 'request_approval']],
  ['org_delete', 1, ['confirm_slug'], ['confirm_slug', 'request_approval']],
  ['org_switch_default', 1, ['org'], ['allowed_org_ids']], ['org_list_members', 0, [], ['kind']],
  ['org_invite_member', 1, [], ['email', 'principal_id', 'principal_kind', 'role', 'workspace_ids', 'display_name', 'request_approval']],
  ['org_set_member_role', 1, ['principal_id', 'role'], ['principal_id', 'principal_kind', 'role', 'request_approval']],
  ['org_remove_member', 1, ['principal_id'], ['principal_id', 'principal_kind', 'request_approval']],
  ['org_confirm_action', 1, ['approval_id', 'decision'], ['approval_id', 'decision']],
  ['org_assign_workspace_member', 1, ['principal_id'], ['principal_id', 'principal_kind', 'role']],
  ['org_remove_workspace_member', 1, ['principal_id'], ['principal_id', 'principal_kind']],
  ['workspace_list', 0, [], []], ['workspace_create', 1, ['slug', 'name'], ['slug', 'name']],
  ['workspace_join', 1, [], []], ['workspace_leave', 1, [], []], ['workspace_list_members', 0, [], []],
  ['org_move_workspace', 1, ['target_org'], ['target_org', 'transfer_members', 'request_approval']],
  ['org_logo_upload', 1, ['content_type'], ['content_type', 'data_base64', 'svg', 'byte_length']],
  ['org_logo_remove', 1, [], []], ['channel_list', 0, [], []],
  ['channel_create', 1, ['slug'], ['slug', 'visibility', 'join_policy', 'topic', 'purpose']],
  ['channel_join', 1, [], []], ['channel_leave', 1, [], []],
  ['channel_add_member', 1, ['principal_id'], ['principal_id', 'principal_kind', 'role']],
  ['channel_remove_member', 1, ['principal_id'], ['principal_id', 'principal_kind']],
  ['channel_list_members', 0, [], []], ['channel_archive', 1, [], []],
  ['channel_rename', 1, [], ['new_slug', 'slug', 'visibility', 'join_policy']],
  ['channel_set_topic', 1, ['topic'], ['topic', 'purpose']],
  ['channel_set_notify_pref', 1, ['notify_pref'], ['notify_pref']],
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

export const ORG_CHANNEL_TOOL_SPECS = SPECS.map(([name, w, required, extra]) => ({
  name, effect: (w ? 'write' : 'read') as 'read' | 'write', required, allowed: Array.from(new Set([...SEL, ...extra])),
}));

export const ORG_CHANNEL_MCP_TOOLS = ORG_CHANNEL_TOOL_SPECS.map((s) => ({
  name: s.name, title: s.name, description: s.name, securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }],
  annotations: { title: s.name, readOnlyHint: s.effect === 'read', destructiveHint: s.effect === 'write', idempotentHint: s.effect === 'read', openWorldHint: false },
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
    if (v === undefined) continue;
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
const callerCtx = (c: McpCallerAuth): CallerContext => ({ principal_kind: c.principal_kind, principal_id: c.principal_id, owner_user_id: c.owner_user_id ?? null, connection_id: c.connection_id ?? null });
const resolveAgId = (s: OrgChannelSlice3State, id: string) => (s.agentPrincipals ?? []).find((p) => p.principal_id === id && isLive(p))?.agent_identity_id ?? id;
const str = (v: unknown) => (typeof v === 'string' && v.trim()) || null;

export function resolveSeatIdFromAuthOrArgs(
  s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>,
): { ok: true; seat_id: string | null } | { ok: false; refusal: EnrichedOrgChannelRefusal } {
  const argS = str(args.seat_id), authS = str(caller.seat_id), argH = str(args.seat), authH = str(caller.seat);
  if ((argS && authS && argS !== authS) || (argH && authH && argH !== authH)) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'matching_seat', { seat_id: argS ?? argH });
  let seatId = argS || authS;
  const rawH = argH || authH;
  if (rawH) {
    const byS = (s.seats ?? []).find((x) => x.seat_id === rawH && isLive(x)), h = byS ? null : (s.seatHandles ?? []).find((x) => x.handle_id === rawH);
    if (!byS && (!h || !isLive(h))) return failEnriched('WORKSPACE_ACCESS_DENIED', 'active_seat_handle', { seat_id: rawH });
    const hSeatId = byS ? byS.seat_id : h!.seat_id;
    if (seatId && seatId !== hSeatId) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'matching_seat_and_seat_id', { seat_id: seatId });
    seatId = hSeatId;
  }
  if (!seatId) return { ok: true, seat_id: null };
  const seat = (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x)), c = callerCtx(caller), agId = caller.principal_kind === 'agent' ? resolveAgId(s, caller.principal_id) : null;
  const seatOwned = Boolean(seat && (caller.principal_kind !== 'agent' || seat.principal_id === caller.principal_id || !seat.agent_identity_id || seat.agent_identity_id === agId));
  if (!seat || !seatOwned || !canReadWorkspace(s, c, seat.workspace_id)) return failEnriched('WORKSPACE_ACCESS_DENIED', 'active_seat_workspace_access', { seat_id: seatId });
  return { ok: true, seat_id: seatId };
}

export function resolveMcpOrgWorkspaceChannel(
  s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, string | null | undefined>,
) {
  const sr = resolveSeatIdFromAuthOrArgs(s, caller, args as Record<string, unknown>);
  if (!sr.ok) return sr;
  const expOrg = args.org?.trim() || null, expWs = args.workspace?.trim() || null, findOrg = (t: string) => s.organizations.find((o) => isLive(o) && (o.id === t || norm(o.slug) === norm(t)));
  if (expOrg && expWs) {
    const o1 = findOrg(expOrg), matchW = (w: WorkspaceRecord) => isLive(w) && (w.workspace_id === expWs || norm(w.slug) === norm(expWs));
    if (expWs.includes('/')) {
      const o2 = findOrg(expWs.split('/', 2)[0]!.trim());
      if (!o1 || !o2 || o1.id !== o2.id) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'org_workspace_selector_conflict', { org: expOrg, workspace: expWs, seat_id: sr.seat_id });
    } else if (o1 && !s.workspaces.some((w) => w.org_id === o1.id && matchW(w)) && s.workspaces.some((w) => w.org_id !== o1.id && matchW(w))) {
      return failEnriched('WORKSPACE_SEAT_MISMATCH', 'org_workspace_selector_conflict', { org: expOrg, workspace: expWs, seat_id: sr.seat_id });
    }
  }
  const c = callerCtx(caller), res = resolveOrgWorkspaceChannelSelector(s, c, { org: args.org ?? null, workspace: args.workspace ?? null, channel: args.channel ?? null, seat_id: sr.seat_id });
  if (!res.ok) return { ok: false as const, refusal: enrichOrgChannelRefusal(res.refusal) };
  const sigId = args.signal_id?.trim() || args.thread_id?.trim() || null;
  if (sigId) {
    const sig = (s.signals ?? []).find((x) => x.signal_id === sigId || x.thread_id === sigId);
    if (sig) {
      if (sig.workspace_id !== res.workspace.workspace_id) return failEnriched('WORKSPACE_SEAT_MISMATCH', 'signal_workspace_scope', { org: res.org.slug, workspace: res.workspace.slug, seat_id: sr.seat_id });
      if (sig.channel_id && !canReadChannel(s, c, sig.channel_id)) {
        const ch = s.channels.find((x) => x.channel_id === sig.channel_id);
        return failEnriched('CHANNEL_ACCESS_DENIED', 'channel_membership', { org: res.org.slug, workspace: res.workspace.slug, channel: ch?.slug ?? sig.channel_id, seat_id: sr.seat_id });
      }
    }
  }
  if (args.file_id?.trim() && !canReadChannelBoundFile(s, c, args.file_id.trim(), res.workspace.workspace_id)) {
    return failEnriched('CHANNEL_ACCESS_DENIED', 'file_channel_access', { org: res.org.slug, workspace: res.workspace.slug, seat_id: sr.seat_id });
  }
  return { ...res, seat_id: sr.seat_id };
}

export function executeMultiOrgWhoami(
  s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown> = {},
): ({ ok: true } & MultiOrgWhoamiResponse) | { ok: false; status: 'refused'; refusal: EnrichedOrgChannelRefusal } {
  const sr = resolveSeatIdFromAuthOrArgs(s, caller, args);
  if (!sr.ok) return { ok: false, status: 'refused', refusal: sr.refusal };
  const seatId = sr.seat_id, c = callerCtx(caller), oTok = str(args.org);
  if (str(args.workspace) || str(args.channel)) {
    const chk = resolveMcpOrgWorkspaceChannel(s, caller, { org: oTok, workspace: str(args.workspace), channel: str(args.channel), seat_id: seatId });
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
    const rank: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 }, agId = resolveAgId(s, caller.principal_id);
    const base = buildMultiOrgWhoamiResponse(s, { agent_identity_id: agId, connection_id: caller.connection_id ?? null, seat_id: seatId });
    const capped = base.organizations.map((o) => {
      const eff = effCallerOrgRole(s, c, o.org_id) ?? o.role;
      return { ...o, role: eff, workspaces: o.workspaces.map((w) => {
        const rawW = s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && (isPrin(g, 'agent', agId) || isPrin(g, 'agent', caller.principal_id)) && isLive(g))?.role ?? eff;
        return { ...w, role: rank[rawW] <= rank[eff] ? rawW : eff };
      }) };
    });
    const dOrg = (base.default_org_id ? capped.find((o) => o.org_id === base.default_org_id) : undefined) ?? (capped.length === 1 ? capped[0] : undefined);
    const dWs = (base.default_workspace_id && dOrg?.workspaces.some((w) => w.workspace_id === base.default_workspace_id) ? base.default_workspace_id : null)
      ?? (dOrg?.workspaces.length === 1 ? dOrg.workspaces[0]!.workspace_id : null);
    return { ...base, ok: true, default_org_id: dOrg?.org_id ?? null, default_workspace_id: dWs, organizations: orgFilter ? capped.filter((o) => o.org_id === oTok || norm(o.slug) === orgFilter) : capped };
  }
  const id = caller.principal_id, orgs = s.organizations.filter((o) => isLive(o) && canReadOrg(s, c, o.id) && (!orgFilter || o.id === oTok || norm(o.slug) === orgFilter)).map((o) => {
    const r = orgRole(s, o.id, 'user', id)!, wss = s.workspaces.filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, c, w.workspace_id)).map((w) => ({
      workspace_id: w.workspace_id, slug: w.slug, name: w.name, role: s.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, 'user', id) && isLive(g))?.role ?? r,
      channels: s.channels.filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(s, c, ch.channel_id)).map(({ channel_id, slug, visibility }) => ({ channel_id, slug, visibility })),
    }));
    return { org_id: o.id, slug: o.slug, display_name: o.display_name, role: r, workspaces: wss };
  });
  return { ok: true, agent_identity_id: id, owner_user_id: id, display_name: id, active_seat: null, default_org_id: orgs[0]?.org_id ?? null, default_workspace_id: orgs[0]?.workspaces[0]?.workspace_id ?? null, organizations: orgs };
}

export { executeOrgChannelMcpTool } from './org-channels-handlers.js';
