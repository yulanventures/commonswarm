import {
  type AgentIdentityRecord, type AgentPrincipalRecord, type ChannelMembershipRecord,
  type ChannelSummary, type HostedMcpSeatHandleRecord, type HostedMcpSeatRecord,
  type OrgApprovalRequest, type OrganizationSummary, type OrgMembershipRecord,
  type WorkspaceMoveTransferMode, type WorkspacePrincipalGrant, type WorkspaceRecord,
  fail, isPrin, reconcileWorkspaceMove,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState, type OrgCallerContext, type OrgChatSignal,
  type OrgCommandOptions, type OrgInviteRecord, type OrgSqlExecutor, type OrgSqlQueryResult,
  orgConfirmAction, orgInviteAccept, orgInviteCreate, orgInviteRevoke, withOrgTx,
} from './invites.js';
import { orgCreate, orgDelete, orgList, orgUpdate } from './crud.js';
import { orgListMembers, orgRemoveMember, orgSetMemberRole } from './members.js';
import { orgAssignWorkspaceMember, orgRemoveWorkspaceMember, workspaceJoin, workspaceLeave, workspaceListMembers } from './workspace-grants.js';
import { decodeRasterLogo, orgLogoFinalize, orgLogoRemove, orgLogoUploadPrepare } from './logo.js';
import { orgMoveWorkspace } from './move-workspace.js';

export * from '../../../../src/protocol/org-channels-contract.js';
export * from './invites.js';
export * from './crud.js';
export * from './members.js';
export * from './workspace-grants.js';
export * from './logo.js';
export * from './move-workspace.js';

export const ORG_SLICE1_COMMAND_KINDS = [
  'org_create', 'org_update', 'org_delete', 'org_list', 'org_list_members',
  'org_set_member_role', 'org_remove_member', 'org_assign_workspace_member',
  'org_remove_workspace_member', 'workspace_join', 'workspace_leave',
  'workspace_list_members', 'org_invite_create', 'org_invite_accept',
  'org_invite_revoke', 'org_confirm_action', 'org_logo_upload_prepare',
  'org_logo_finalize', 'org_logo_remove', 'org_move_workspace',
] as const;

export type OrgSlice1CommandKind = (typeof ORG_SLICE1_COMMAND_KINDS)[number];
export type OrgSlice1Command = { kind: OrgSlice1CommandKind } & Record<string, unknown>;
export const isOrgSlice1CommandKind = (k: unknown): k is OrgSlice1CommandKind =>
  typeof k === 'string' && (ORG_SLICE1_COMMAND_KINDS as readonly string[]).includes(k);

type CmdArg = { kind: string } & Record<string, unknown>;
const normOpts = (o?: OrgSqlExecutor | OrgCommandOptions): OrgCommandOptions =>
  !o ? {} : 'query' in o && typeof o.query === 'function' ? { db: o } : (o as OrgCommandOptions);

export function dispatchOrgCommand(
  s: OrgAuthorityState, cOrCmd: OrgCallerContext | CmdArg, cmdOrC: CmdArg | OrgCallerContext,
  dbOrOpts?: OrgSqlExecutor | OrgCommandOptions,
) {
  const isC = typeof cOrCmd === 'object' && cOrCmd !== null && 'principal_kind' in cOrCmd && !('kind' in cOrCmd);
  const c = (isC ? cOrCmd : cmdOrC) as OrgCallerContext, cmd = (isC ? cmdOrC : cOrCmd) as CmdArg, opts = normOpts(dbOrOpts);
  return withOrgTx(s, opts.db, (tx) => {
    switch (cmd.kind) {
      case 'org_create': return orgCreate(s, c, cmd as Parameters<typeof orgCreate>[2], tx);
      case 'org_update': return orgUpdate(s, c, cmd as Parameters<typeof orgUpdate>[2], tx);
      case 'org_delete': return orgDelete(s, c, cmd as Parameters<typeof orgDelete>[2], tx);
      case 'org_list': return orgList(s, c);
      case 'org_list_members': return orgListMembers(s, c, cmd as Parameters<typeof orgListMembers>[2]);
      case 'org_set_member_role': return orgSetMemberRole(s, c, cmd as Parameters<typeof orgSetMemberRole>[2], tx);
      case 'org_remove_member': return orgRemoveMember(s, c, cmd as Parameters<typeof orgRemoveMember>[2], tx);
      case 'org_assign_workspace_member': return orgAssignWorkspaceMember(s, c, cmd as Parameters<typeof orgAssignWorkspaceMember>[2], tx);
      case 'org_remove_workspace_member': return orgRemoveWorkspaceMember(s, c, cmd as Parameters<typeof orgRemoveWorkspaceMember>[2], tx);
      case 'workspace_join': return workspaceJoin(s, c, cmd as Parameters<typeof workspaceJoin>[2], tx);
      case 'workspace_leave': return workspaceLeave(s, c, cmd as Parameters<typeof workspaceLeave>[2], tx);
      case 'workspace_list_members': return workspaceListMembers(s, c, cmd as Parameters<typeof workspaceListMembers>[2]);
      case 'org_invite_create': return orgInviteCreate(s, c, cmd as Parameters<typeof orgInviteCreate>[2], tx);
      case 'org_invite_accept': return orgInviteAccept(s, c, cmd as Parameters<typeof orgInviteAccept>[2], { ...opts, db: tx });
      case 'org_invite_revoke': return orgInviteRevoke(s, c, cmd as Parameters<typeof orgInviteRevoke>[2], tx);
      case 'org_confirm_action': return orgConfirmAction(s, c, cmd as Parameters<typeof orgConfirmAction>[2], { ...opts, db: tx });
      case 'org_logo_upload_prepare': return orgLogoUploadPrepare(s, c, cmd as Parameters<typeof orgLogoUploadPrepare>[2], tx);
      case 'org_logo_finalize': return orgLogoFinalize(s, c, cmd as Parameters<typeof orgLogoFinalize>[2], tx);
      case 'org_logo_remove': return orgLogoRemove(s, c, cmd as Parameters<typeof orgLogoRemove>[2], tx);
      case 'org_move_workspace': return orgMoveWorkspace(s, c, cmd as Parameters<typeof orgMoveWorkspace>[2], tx);
      default: return fail('UNKNOWN_ORG_COMMAND', String(cmd.kind ?? 'command_kind'), {});
    }
  });
}

export const executeOrgCommand = dispatchOrgCommand;

export function createStatefulOrgSqlExecutor(init?: Partial<OrgAuthorityState>) {
  const cl = <T>(v: T, d: T): T => structuredClone(v ?? d);
  const store: OrgAuthorityState = {
    privateChannelsEnabled: init?.privateChannelsEnabled ?? true,
    organizations: cl(init?.organizations, []), workspaces: cl(init?.workspaces, []),
    channels: cl(init?.channels, []), agentIdentities: cl(init?.agentIdentities, []),
    orgMemberships: cl(init?.orgMemberships, []), workspaceGrants: cl(init?.workspaceGrants, []),
    channelMemberships: cl(init?.channelMemberships, []), agentPrincipals: cl(init?.agentPrincipals, []),
    legacyMemberships: cl(init?.legacyMemberships, []), seats: cl(init?.seats, []),
    seatHandles: cl(init?.seatHandles, []), orgInvites: cl(init?.orgInvites, []),
    approvalRequests: cl(init?.approvalRequests, []), logoUploads: cl(init?.logoUploads, {}),
    logoObjects: cl(init?.logoObjects, {}), signals: cl(init?.signals, []),
    files: cl(init?.files, []), fileChannelBindings: cl(init?.fileChannelBindings, []),
  };
  const storageMap = new Map<string, { data: Uint8Array | string; contentType: string }>(), queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  let txCount = 0;
  const exec: OrgSqlExecutor & { store: OrgAuthorityState; storageMap: typeof storageMap; queries: typeof queries; getTxCount: () => number } = {
    store, storageMap, queries, getTxCount: () => txCount,
    storage: { put: (k, data, contentType) => { storageMap.set(k, { data, contentType }); }, delete: (k) => { storageMap.delete(k); } },
    query<T = Record<string, unknown>>(sql: string, p: readonly unknown[] = []): OrgSqlQueryResult<T> {
      queries.push({ sql, params: p });
      const s = sql.trim();
      if (/^SELECT\b/i.test(s) && /swarm\.org_move_workspace/i.test(s)) {
        const r = reconcileWorkspaceMove(store, { workspace_id: String(p[0]), target_org_id: String(p[1]), actor_user_id: String(p[2]), transfer_members: (p[3] as WorkspaceMoveTransferMode) ?? 'owners_only' });
        return { rows: [r as unknown as T], rowCount: r.ok ? 1 : 0 };
      }
      if (/^SELECT\b/i.test(s)) {
        const tbls: Array<[RegExp, unknown[]]> = [
          [/FROM swarm\.organizations\b/i, p.length === 1 ? store.organizations.filter((o) => o.id === p[0]) : p.length === 2 ? store.organizations.filter((o) => o.id === p[0] || o.id === p[1]) : store.organizations],
          [/FROM swarm\.org_memberships\b/i, p.length === 1 ? store.orgMemberships.filter((m) => m.org_id === p[0]) : store.orgMemberships],
          [/FROM swarm\.workspace_principal_grants\b/i, p.length === 1 ? store.workspaceGrants.filter((g) => g.workspace_id === p[0] || g.org_id === p[0]) : store.workspaceGrants],
          [/FROM swarm\.workspaces\b/i, store.workspaces], [/FROM swarm\.channels\b/i, store.channels],
          [/FROM swarm\.agent_identities\b/i, store.agentIdentities], [/FROM swarm\.channel_memberships\b/i, store.channelMemberships],
          [/FROM swarm\.agent_principals\b/i, store.agentPrincipals ?? []], [/FROM swarm\.hosted_mcp_seats\b/i, store.seats ?? []],
          [/FROM swarm\.org_invites\b/i, store.orgInvites ?? []], [/FROM swarm\.org_approval_requests\b/i, store.approvalRequests ?? []],
        ];
        for (const [re, arr] of tbls) if (re.test(s)) return { rows: structuredClone(arr) as T[], rowCount: arr.length };
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO swarm\.organizations\b/i.test(s)) {
        store.organizations.push({ id: String(p[0]), slug: String(p[1]), display_name: String(p[2]), logo_object_key: null, logo_updated_at: null, created_by: String(p[3]), created_at: String(p[4]), updated_at: String(p[5]), archived_at: null });
      } else if (/^UPDATE swarm\.organizations\b/i.test(s)) {
        const o = store.organizations.find((x) => x.id === p[0]);
        if (!o) return { rows: [], rowCount: 0 };
        if (/SET slug = \$2/i.test(s)) { o.slug = String(p[1]); o.display_name = String(p[2]); o.updated_at = String(p[3]); }
        else if (/SET archived_at = \$2/i.test(s)) { o.archived_at = String(p[1]); o.updated_at = String(p[1]); }
        else if (/SET logo_object_key = NULL/i.test(s)) { o.logo_object_key = null; o.logo_updated_at = String(p[1]); o.updated_at = String(p[1]); }
        else if (/SET logo_object_key = \$2/i.test(s)) { o.logo_object_key = (p[1] as string | null) ?? null; o.logo_updated_at = String(p[2]); o.updated_at = String(p[2]); }
      } else if (/^INSERT INTO swarm\.org_memberships\b/i.test(s)) {
        const oId = String(p[1]), pk = p[2] as OrgMembershipRecord['principal_kind'], pid = String(p[3]), lv = s.includes('NULL) ON CONFLICT');
        const ex = store.orgMemberships.find((m) => m.org_id === oId && isPrin(m, pk, pid));
        if (ex) { ex.role = p[4] as OrgMembershipRecord['role']; ex.revoked_at = lv ? null : (p[6] as string | null); }
        else store.orgMemberships.push({ id: String(p[0]), org_id: oId, principal_kind: pk, principal_id: pid, role: p[4] as OrgMembershipRecord['role'], invited_by: lv ? (p[5] as string | null) : null, created_at: String(p[lv ? 6 : 5]), revoked_at: lv ? null : (p[6] as string | null) });
      } else if (/^UPDATE swarm\.org_invites SET consumed_at/i.test(s)) {
        const inv = (store.orgInvites ?? []).find((i) => i.invite_id === p[0] && i.revoked_at == null && i.consumed_at == null);
        if (!inv) return { rows: [], rowCount: 0 };
        inv.consumed_at = String(p[1]); inv.consumed_by = String(p[2]);
      } else if (/^INSERT INTO swarm\.org_logo_objects\b/i.test(s)) {
        const k = String(p[0]), sz = Number(p[2]) as 64 | 128 | 256;
        (store.logoObjects ??= {})[k] = { key: k, org_id: String(p[1]), size: sz, width: sz, height: sz, content_type: String(p[3]), byte_length: Number(p[4]), sha256: String(p[5]), data: p[6] as Uint8Array };
      } else if (/^DELETE FROM swarm\.org_logo_objects\b/i.test(s)) {
        for (const [k, v] of Object.entries(store.logoObjects ?? {})) if (v.org_id === p[0]) delete store.logoObjects![k];
      } else if (/^INSERT INTO swarm\.signals\b/i.test(s)) {
        const id = String(p[0]);
        if (!(store.signals ??= []).some((x) => x.signal_id === id)) store.signals.push({ signal_id: id, workspace_id: String(p[1]), channel_id: (p[2] as string | null) ?? null, from_principal_kind: p[3] as OrgChatSignal['from_principal_kind'], from_principal_id: String(p[4]), kind: p[5] as OrgChatSignal['kind'], body: String(p[6]), approval_id: (p[7] as string | null) ?? null, created_at: String(p[8]) });
      }
      return { rows: [], rowCount: 1 };
    },
    withTransaction<T>(fn: (tx: OrgSqlExecutor) => T): T {
      txCount += 1;
      const sn = structuredClone(store), snSt = new Map(storageMap);
      try { return fn(exec); } catch (e) { Object.assign(store, sn); storageMap.clear(); for (const [k, v] of snSt) storageMap.set(k, v); throw e; }
    },
  };
  return exec;
}

export async function loadOrgAuthorityStateFromDb(db: OrgSqlExecutor): Promise<OrgAuthorityState> {
  const q = async <T>(sql: string): Promise<T[]> => ((await db.query<T>(sql, [])) as OrgSqlQueryResult<T> | undefined)?.rows ?? [];
  const [organizations, workspaces, channels, agentIdentities, orgMemberships, workspaceGrants, channelMemberships, agentPrincipals, seats, orgInvites, approvalRequests] = await Promise.all([
    q<OrganizationSummary>('SELECT * FROM swarm.organizations'), q<WorkspaceRecord>('SELECT * FROM swarm.workspaces'),
    q<ChannelSummary>('SELECT * FROM swarm.channels'), q<AgentIdentityRecord>('SELECT * FROM swarm.agent_identities'),
    q<OrgMembershipRecord>('SELECT * FROM swarm.org_memberships'), q<WorkspacePrincipalGrant>('SELECT * FROM swarm.workspace_principal_grants'),
    q<ChannelMembershipRecord>('SELECT * FROM swarm.channel_memberships'), q<AgentPrincipalRecord>('SELECT * FROM swarm.agent_principals'),
    q<HostedMcpSeatRecord>('SELECT * FROM swarm.hosted_mcp_seats'), q<OrgInviteRecord>('SELECT * FROM swarm.org_invites'),
    q<OrgApprovalRequest>('SELECT * FROM swarm.org_approval_requests'),
  ]);
  return { privateChannelsEnabled: true, organizations, workspaces, channels, agentIdentities, orgMemberships, workspaceGrants, channelMemberships, agentPrincipals, seats, seatHandles: [] as HostedMcpSeatHandleRecord[], orgInvites, approvalRequests, db };
}

export async function handleHostedOrgCommandRequest(
  req: Request | { method?: string; headers?: Record<string, string> | Headers; body?: unknown; caller?: OrgCallerContext },
  env: { state?: OrgAuthorityState; db?: OrgSqlExecutor; resolveCaller?: (r: unknown) => OrgCallerContext | Promise<OrgCallerContext | null> | null; testClockIso?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  let payload: Record<string, unknown> = {};
  if (typeof Request !== 'undefined' && req instanceof Request) {
    try { payload = (await req.json()) as Record<string, unknown>; } catch { return { status: 400, body: fail('INVALID_COMMAND_PAYLOAD', 'json_body', {}) }; }
  } else if (req && typeof req === 'object' && 'body' in req && req.body && typeof req.body === 'object') payload = req.body as Record<string, unknown>;
  const hdr = (n: string): string | null => {
    if (!req || typeof req !== 'object' || !('headers' in req) || !req.headers) return null;
    if (typeof Headers !== 'undefined' && req.headers instanceof Headers) return req.headers.get(n);
    const rec = req.headers as Record<string, string>;
    return rec[n] ?? rec[n.toLowerCase()] ?? null;
  };
  let caller: OrgCallerContext | null = ('caller' in req && req.caller ? req.caller : null) ?? (env.resolveCaller ? await env.resolveCaller(req) : null);
  if (!caller) {
    const pid = hdr('x-principal-id'), pk = hdr('x-principal-kind');
    if (pid && (pk === 'user' || pk === 'agent')) caller = { principal_kind: pk, principal_id: pid, authenticated_email: hdr('x-authenticated-email') };
  }
  if (!caller) return { status: 401, body: fail('ORG_ACCESS_DENIED', 'authenticated_caller', {}) };
  if (!isOrgSlice1CommandKind(payload.kind)) return { status: 400, body: fail('UNKNOWN_ORG_COMMAND', String(payload.kind ?? 'command_kind'), {}) };
  const state = env.state ?? (env.db ? await loadOrgAuthorityStateFromDb(env.db) : null);
  if (!state) return { status: 500, body: fail('ORG_STATE_UNAVAILABLE', 'org_authority_state', {}) };
  const result = (await dispatchOrgCommand(state, caller, payload as OrgSlice1Command, { db: env.db ?? state.db, testClockIso: env.testClockIso })) as Record<string, unknown>;
  return { status: result.ok ? 200 : 400, body: result };
}

export function readLogoDimensions(data: Uint8Array | string, ct: string): { width: number; height: number } | null {
  if (ct === 'image/svg+xml') {
    const tag = (typeof data === 'string' ? data : new TextDecoder().decode(data)).match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const w = Number(tag.match(/\bwidth="(\d+)"/i)?.[1] ?? 0), h = Number(tag.match(/\bheight="(\d+)"/i)?.[1] ?? 0);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (ct === 'image/png' || ct === 'image/jpeg' || ct === 'image/webp') {
    const dec = decodeRasterLogo(typeof data === 'string' ? new TextEncoder().encode(data) : data, ct);
    return dec ? { width: dec.width, height: dec.height } : null;
  }
  return null;
}
