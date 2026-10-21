import { createRequire } from 'node:module';
import {
  type CallerContext,
  type OrgApprovalRequest,
  type OrgChannelAuthorityState,
  type OrgChannelRefusal,
  type OrgRole,
  type PrincipalKind,
  buildMultiOrgWhoamiResponse,
  orgRole,
  canReadOrg,
  agentOwner,
  resolveOrgWorkspaceChannelSelector,
} from '../protocol/org-channels-contract.js';

export interface CliCallerContext extends CallerContext {
  seat?: string | null;
  seat_id?: string | null;
}

export interface CliOrgChannelState extends OrgChannelAuthorityState {
  orgInvites?: Array<{
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
    revoked_at?: string | null;
  }>;
  approvalRequests?: OrgApprovalRequest[];
  orgLogos?: Record<
    string,
    {
      org_id: string;
      object_key: string;
      content_type: string;
      byte_length: number;
      renditions: { '64': string; '128': string; '256': string };
      rendition_blobs?: Record<
        '64' | '128' | '256',
        {
          object_key: string;
          width: number;
          height: number;
          content_type: string;
          byte_length: number;
          sha256: string;
          data_base64: string;
        }
      >;
      sanitized_svg?: string;
      updated_at: string;
    }
  >;
  signals?: Array<{
    signal_id: string;
    workspace_id: string;
    channel_id?: string | null;
    thread_id?: string | null;
  }>;
}

export interface ParsedOrgChannelCliCommand {
  tool: string;
  arguments: Record<string, unknown>;
  json: boolean;
}

const BOOL_FLAGS = new Set(['json', 'approve', 'reject', 'request-approval']);

function makeEmptyCliState(): CliOrgChannelState {
  return {
    privateChannelsEnabled: true,
    organizations: [],
    workspaces: [],
    channels: [],
    agentIdentities: [],
    orgMemberships: [],
    workspaceGrants: [],
    channelMemberships: [],
    agentPrincipals: [],
    seats: [],
    seatHandles: [],
    connectionPolicies: [],
    fileChannelBindings: [],
    orgInvites: [],
    approvalRequests: [],
    orgLogos: {},
    signals: [],
  };
}

let defaultCliState: CliOrgChannelState = makeEmptyCliState();

export function getDefaultOrgChannelCliState(): CliOrgChannelState {
  return defaultCliState;
}

export function resetDefaultOrgChannelCliState(next?: CliOrgChannelState): CliOrgChannelState {
  defaultCliState = next ?? makeEmptyCliState();
  return defaultCliState;
}

export function parseOrgChannelsCliArgs(argv: readonly string[]): ParsedOrgChannelCliCommand {
  const tokens = argv[0] === 'cswarm' ? argv.slice(1) : [...argv];
  const pos: string[] = [];
  const f = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (!tok.startsWith('--')) { pos.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq !== -1) { f.set(tok.slice(2, eq), tok.slice(eq + 1)); continue; }
    const name = tok.slice(2);
    if (BOOL_FLAGS.has(name)) { f.set(name, 'true'); continue; }
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`--${name} requires a value`);
    f.set(name, next);
    i += 1;
  }

  const json = f.get('json') === 'true';
  const b: Record<string, unknown> = {};
  for (const [flag, key] of [['org', 'org'], ['workspace', 'workspace'], ['channel', 'channel'], ['seat', 'seat'], ['seat-id', 'seat_id']] as const) {
    if (f.has(flag)) b[key] = f.get(flag);
  }
  if (f.get('request-approval') === 'true') b.request_approval = true;
  const opt = (flag: string, key = flag) => (f.has(flag) ? { [key]: f.get(flag) } : {});

  const [cmd, sub, a1, a2] = pos;
  if (cmd === 'whoami' || cmd === 'discover') return { tool: cmd, arguments: b, json };

  if (cmd === 'org' || cmd === 'orgs') {
    if (!sub || sub === 'list' || sub === 'ls') return { tool: 'org_list', arguments: b, json };
    if (sub === 'get' || sub === 'show') return { tool: 'org_get', arguments: { ...b, ...(a1 ? { org: a1 } : {}) }, json };
    if (sub === 'create') {
      const slug = a1 ?? f.get('slug') ?? '';
      return { tool: 'org_create', arguments: { ...b, slug, display_name: f.get('name') ?? f.get('display-name') ?? a2 ?? slug }, json };
    }
    if (sub === 'update') return { tool: 'org_update', arguments: { ...b, ...(a1 && !b.org ? { org: a1 } : {}), ...opt('name', 'display_name'), ...opt('slug', 'new_slug') }, json };
    if (sub === 'delete' || sub === 'rm') return { tool: 'org_delete', arguments: { ...b, ...(a1 && !b.org ? { org: a1 } : {}), confirm_slug: f.get('confirm') ?? f.get('confirm-slug') ?? '' }, json };
    if (sub === 'switch' || sub === 'default') return { tool: 'org_switch_default', arguments: { ...b, org: a1 ?? b.org }, json };
    if (sub === 'members') {
      const pId = a2 ?? f.get('principal') ?? f.get('principal-id');
      if (a1 === 'grant') return { tool: 'org_assign_workspace_member', arguments: { ...b, principal_id: pId, ...opt('kind', 'principal_kind'), ...opt('role') }, json };
      if (a1 === 'revoke') return { tool: 'org_remove_workspace_member', arguments: { ...b, principal_id: pId, ...opt('kind', 'principal_kind') }, json };
      return { tool: 'org_list_members', arguments: { ...b, ...opt('kind') }, json };
    }
    if (sub === 'invite') {
      const isEmail = a1?.includes('@');
      return { tool: 'org_invite_member', arguments: { ...b, ...(isEmail ? { email: a1 } : a1 ? { principal_id: a1 } : {}), ...opt('email'), ...opt('principal', 'principal_id'), ...opt('kind', 'principal_kind'), ...opt('role'), ...(f.has('workspace') ? { workspace_ids: [f.get('workspace')!] } : {}) }, json };
    }
    if (sub === 'role' || sub === 'set-role') return { tool: 'org_set_member_role', arguments: { ...b, principal_id: a1 ?? f.get('principal'), role: a2 ?? f.get('role'), ...opt('kind', 'principal_kind') }, json };
    if (sub === 'remove' || sub === 'remove-member') return { tool: 'org_remove_member', arguments: { ...b, principal_id: a1 ?? f.get('principal'), ...opt('kind', 'principal_kind') }, json };
    if (sub === 'confirm') {
      const decision = f.get('approve') === 'true' ? 'approve' : f.get('reject') === 'true' ? 'reject' : (f.get('decision') ?? a2 ?? 'approve');
      return { tool: 'org_confirm_action', arguments: { ...b, approval_id: a1 ?? f.get('approval-id'), decision }, json };
    }
    if (sub === 'grant') return { tool: 'org_assign_workspace_member', arguments: { ...b, principal_id: a1 ?? f.get('principal'), ...opt('kind', 'principal_kind'), ...opt('role') }, json };
    if (sub === 'revoke-grant') return { tool: 'org_remove_workspace_member', arguments: { ...b, principal_id: a1 ?? f.get('principal'), ...opt('kind', 'principal_kind') }, json };
    if (sub === 'move-workspace') return { tool: 'org_move_workspace', arguments: { ...b, ...(a1 && !b.workspace ? { workspace: a1 } : {}), target_org: f.get('to-org') ?? f.get('target-org') ?? a2, ...opt('transfer-members', 'transfer_members') }, json };
    if (sub === 'logo') {
      if (a1 === 'remove' || a1 === 'rm') return { tool: 'org_logo_remove', arguments: b, json };
      return { tool: 'org_logo_upload', arguments: { ...b, content_type: f.get('content-type') ?? 'image/png', ...opt('data-base64', 'data_base64'), ...opt('svg') }, json };
    }
  }

  if (cmd === 'workspace' || cmd === 'workspaces') {
    if (!sub || sub === 'list' || sub === 'ls') return { tool: 'workspace_list', arguments: b, json };
    if (sub === 'create') return { tool: 'workspace_create', arguments: { ...b, slug: a1 ?? f.get('slug'), name: f.get('name') ?? a2 ?? a1 }, json };
    if (sub === 'join') return { tool: 'workspace_join', arguments: { ...b, ...(a1 ? { workspace: a1 } : {}) }, json };
    if (sub === 'leave') return { tool: 'workspace_leave', arguments: { ...b, ...(a1 ? { workspace: a1 } : {}) }, json };
    if (sub === 'members') return { tool: 'workspace_list_members', arguments: { ...b, ...(a1 ? { workspace: a1 } : {}) }, json };
    if (sub === 'move') return { tool: 'org_move_workspace', arguments: { ...b, ...(a1 && !b.workspace ? { workspace: a1 } : {}), target_org: f.get('to-org') ?? f.get('target-org') ?? a2, ...opt('transfer-members', 'transfer_members') }, json };
  }

  if (cmd === 'channel' || cmd === 'channels') {
    if (!sub || sub === 'list' || sub === 'ls') return { tool: 'channel_list', arguments: b, json };
    if (sub === 'create') return { tool: 'channel_create', arguments: { ...b, slug: a1 ?? f.get('slug'), ...opt('visibility'), ...opt('join-policy', 'join_policy'), ...opt('topic'), ...opt('purpose') }, json };
    if (sub === 'join') return { tool: 'channel_join', arguments: { ...b, ...(a1 ? { channel: a1 } : {}) }, json };
    if (sub === 'leave') return { tool: 'channel_leave', arguments: { ...b, ...(a1 ? { channel: a1 } : {}) }, json };
    if (sub === 'add-member' || sub === 'invite') {
      const pId = f.get('principal') ?? f.get('principal-id') ?? a1;
      const ch = f.get('channel') ?? (f.has('principal') && a1 ? a1 : b.channel);
      return { tool: 'channel_add_member', arguments: { ...b, ...(ch ? { channel: ch } : {}), principal_id: pId, ...opt('kind', 'principal_kind'), ...opt('role') }, json };
    }
    if (sub === 'remove-member' || sub === 'kick') return { tool: 'channel_remove_member', arguments: { ...b, principal_id: a1 ?? f.get('principal'), ...opt('kind', 'principal_kind') }, json };
    if (sub === 'members') return { tool: 'channel_list_members', arguments: { ...b, ...(a1 ? { channel: a1 } : {}) }, json };
    if (sub === 'archive') return { tool: 'channel_archive', arguments: { ...b, ...(a1 ? { channel: a1 } : {}) }, json };
    if (sub === 'rename') return { tool: 'channel_rename', arguments: { ...b, new_slug: a1 ?? f.get('new-slug') ?? f.get('slug'), ...opt('visibility'), ...opt('join-policy', 'join_policy') }, json };
    if (sub === 'topic') return { tool: 'channel_set_topic', arguments: { ...b, topic: a1 ?? f.get('topic') ?? '', ...opt('purpose') }, json };
    if (sub === 'notify') return { tool: 'channel_set_notify_pref', arguments: { ...b, notify_pref: a1 ?? f.get('notify') ?? 'all' }, json };
  }

  throw new Error(`Unknown org/workspace/channel CLI command: ${pos.join(' ')}`);
}

export function formatOrgChannelRefusal(refusal: OrgChannelRefusal & { grant_command_hint?: string }): string {
  const hint = refusal.grant_command_hint ?? refusal.cli_command;
  const lines = [
    `Refused (${refusal.code}): missing ${refusal.missing}.`,
    `Scope: org=${refusal.scope.org ?? '-'} workspace=${refusal.scope.workspace ?? '-'} channel=${refusal.scope.channel ?? '-'}`,
  ];
  if (refusal.choices?.length) lines.push(`Matching workspaces: ${refusal.choices.map((c) => c.selector).join(', ')}`);
  lines.push(`Remedy URL: ${refusal.remedy_url}`, `MCP tool: ${refusal.mcp_tool}`, `Run next: ${hint}`);
  return lines.join('\n');
}

export type OrgChannelToolDispatcher = (
  state: CliOrgChannelState,
  caller: CliCallerContext,
  tool: string,
  args: Record<string, unknown>,
) => Record<string, unknown>;

let defaultDispatcher: OrgChannelToolDispatcher | null = null;
export function registerDefaultOrgChannelCliExecutor(fn: OrgChannelToolDispatcher): void {
  defaultDispatcher = fn;
}

function resolveDefaultDispatcher(): OrgChannelToolDispatcher {
  if (defaultDispatcher) return defaultDispatcher;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('../../supabase/functions/mcp/org-channels-handlers.js') as {
      executeOrgChannelMcpTool?: OrgChannelToolDispatcher;
    };
    if (mod.executeOrgChannelMcpTool) {
      defaultDispatcher = mod.executeOrgChannelMcpTool;
      return defaultDispatcher;
    }
  } catch {
    // Fallback used only if handlers module cannot be loaded in isolated build environment.
  }
  return fallbackDispatch;
}

export function effCallerOrgRole(s: CliOrgChannelState, c: CallerContext, orgId: string): OrgRole | null {
  if (!canReadOrg(s, c, orgId)) return null;
  if (c.principal_kind === 'user') return orgRole(s, orgId, 'user', c.principal_id);
  const explicit = orgRole(s, orgId, 'agent', c.principal_id);
  if (explicit) return explicit;
  const owner = agentOwner(s, c);
  const ownerRole = owner ? orgRole(s, orgId, 'user', owner) : null;
  return ownerRole ? (ownerRole === 'guest' ? 'guest' : 'member') : null;
}

export interface ExecuteOrgChannelsCliOptions {
  state?: CliOrgChannelState;
  caller?: CliCallerContext;
  executeTool?: OrgChannelToolDispatcher;
}

export function executeOrgChannelsCli(argv: readonly string[], options: ExecuteOrgChannelsCliOptions = {}) {
  const parsed = parseOrgChannelsCliArgs(argv);
  const state = options.state ?? defaultCliState;
  const caller: CliCallerContext = options.caller ?? { principal_kind: 'user', principal_id: 'u-cli-default' };
  const argsWithSeat: Record<string, unknown> = {
    ...(caller.seat ? { seat: caller.seat } : {}),
    ...(caller.seat_id ? { seat_id: caller.seat_id } : {}),
    ...parsed.arguments,
  };
  const run = options.executeTool ?? resolveDefaultDispatcher();
  const payload = run(state, caller, parsed.tool, argsWithSeat);
  const ok = payload.ok === true;
  if (!ok && payload.refusal) {
    const text = parsed.json ? JSON.stringify(payload) : formatOrgChannelRefusal(payload.refusal as OrgChannelRefusal);
    return { exitCode: 1, ok: false, tool: parsed.tool, payload, stdout: parsed.json ? text : '', stderr: parsed.json ? '' : text };
  }
  const pendingApproval = payload.status === 'pending_owner_approval' || payload.status === 'approval_required';
  const statusLabel = pendingApproval
    ? 'pending_owner_approval'
    : typeof payload.status === 'string' && payload.status.length > 0
      ? payload.status
      : ok
        ? 'ok'
        : String(payload.error ?? 'error');
  const stdout = parsed.json ? JSON.stringify(payload) : `${parsed.tool}: ${statusLabel}`;
  return { exitCode: ok ? 0 : 1, ok, tool: parsed.tool, payload, stdout, stderr: ok ? '' : stdout };
}

function fallbackDispatch(s: CliOrgChannelState, caller: CliCallerContext, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const seatId = (args.seat_id as string | undefined) ?? caller.seat_id ?? null;
  if (tool === 'whoami' || tool === 'discover') {
    const base = buildMultiOrgWhoamiResponse(s, { agent_identity_id: caller.principal_id, connection_id: caller.connection_id ?? null, seat_id: seatId });
    return { ok: true, ...base };
  }
  const res = resolveOrgWorkspaceChannelSelector(s, caller, {
    org: (args.org as string | undefined) ?? null,
    workspace: (args.workspace as string | undefined) ?? null,
    channel: (args.channel as string | undefined) ?? null,
    seat_id: seatId,
  });
  return res.ok ? { ok: true, org: res.org, workspace: res.workspace, channel: res.channel, source: res.source } : { ok: false, status: 'refused', refusal: res.refusal };
}
