import {
  CANONICAL_ORG_CHANNEL_LOCK_ORDER,
  type CallerContext,
  type OrgApprovalRequest,
  type OrganizationSummary,
  type OrgRole,
  type WorkspaceMoveTransferMode,
  type WorkspaceRecord,
  type WorkspaceSelectorChoice,
  agentOwner,
  canReadOrg,
  canReadWorkspace,
  cascadeWorkspaceMemberRemoval,
  fail,
  isLive,
  norm,
  orgRole,
  reconcileWorkspaceMove,
} from '../../../../src/protocol/org-channels-contract.js';
import type {
  ApprovalPendingResult,
  OrgAuthorityState,
  OrgChatSignal,
  RefusalResult,
} from './invites.js';

export interface OrgSqlQueryResult<T = Record<string, unknown>> { rows?: T[]; rowCount?: number; }
export interface OrgSqlExecutor {
  query: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => OrgSqlQueryResult<T> | Promise<OrgSqlQueryResult<T>> | unknown;
  rpc?: <T = unknown>(fn: string, params?: Record<string, unknown> | readonly unknown[]) => T | Promise<T>;
  withTransaction?: <T>(fn: (tx: OrgSqlExecutor) => T) => T;
}
export interface OrgCallerContext extends CallerContext { authenticated_email?: string | null; }
export interface OrgCommandOptions { testClockIso?: string; db?: OrgSqlExecutor; }
export interface OrgLogoPendingUpload {
  upload_id: string; org_id: string; content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  max_bytes: number; object_prefix: string; rendition_keys: { 64: string; 128: string; 256: string };
  requested_by: string; created_at: string; finalized_at?: string | null;
}
export interface OrgLogoObjectRecord {
  key: string; org_id: string; size: 64 | 128 | 256; width?: number; height?: number;
  content_type: string; byte_length: number; sha256: string; data: Uint8Array | string;
}

export type OrgActionExecutor = (s: OrgAuthorityState, c: OrgCallerContext, p: Record<string, unknown>, db?: OrgSqlExecutor) => unknown;
export const ORG_ACTION_EXECUTORS: Record<string, OrgActionExecutor> = {};
export const registerOrgActionExecutor = (k: string, fn: OrgActionExecutor) => { ORG_ACTION_EXECUTORS[k] = fn; };

export const getOrgDb = (s: OrgAuthorityState, db?: OrgSqlExecutor): OrgSqlExecutor | undefined => db ?? s.db;
export const execOrgSql = (db: OrgSqlExecutor | undefined, sql: string, params: readonly unknown[] = []) => (db ? db.query(sql, params) : undefined);

export function withOrgTx<T>(s: OrgAuthorityState, db: OrgSqlExecutor | undefined, fn: (tx: OrgSqlExecutor | undefined) => T): T {
  const active = getOrgDb(s, db);
  if (!active) return fn(undefined);
  if (s._inTx || !active.withTransaction) {
    const prev = s.db; s.db = active;
    try { return fn(active); } finally { s.db = prev; }
  }
  return active.withTransaction((tx) => {
    const prevDb = s.db, prevTx = s._inTx;
    s.db = tx; s._inTx = true;
    try { return fn(tx); } finally { s.db = prevDb; s._inTx = prevTx; }
  });
}

export const roleRank = (r: OrgRole | null | undefined): number =>
  r === 'owner' ? 4 : r === 'admin' ? 3 : r === 'member' ? 2 : r === 'guest' ? 1 : 0;

export const findLiveOrg = (s: OrgAuthorityState, idOrSlug: string): OrganizationSummary | undefined => {
  const tok = idOrSlug.trim();
  return s.organizations.find((o) => isLive(o) && (o.id === tok || norm(o.slug) === norm(tok)));
};

export function resolveWorkspaceSelector(
  s: OrgAuthorityState,
  c: CallerContext | null | undefined,
  wsIdOrSelector: string,
  orgIdOrSlug?: string | null,
): { ok: true; workspace: WorkspaceRecord; org: OrganizationSummary } | RefusalResult {
  let orgSpec = orgIdOrSlug?.trim() || null, wsSpec = (wsIdOrSelector ?? '').trim();
  if (wsSpec.includes('/')) {
    const [oPart, wPart] = wsSpec.split('/', 2);
    if (!orgSpec && oPart) orgSpec = oPart.trim();
    wsSpec = wPart?.trim() || '';
  }
  const toChoice = (w: WorkspaceRecord): WorkspaceSelectorChoice => {
    const o = s.organizations.find((org) => org.id === w.org_id)!;
    return { org_id: o.id, org_slug: o.slug, workspace_id: w.workspace_id, workspace_slug: w.slug, selector: `${o.slug}/${w.slug}` };
  };
  if (orgSpec) {
    const org = findLiveOrg(s, orgSpec);
    if (!org) return fail('WORKSPACE_NOT_FOUND', 'workspace', { org: orgSpec, workspace: wsSpec });
    const ws = s.workspaces.find((w) => isLive(w) && w.org_id === org.id && (w.workspace_id === wsSpec || norm(w.slug) === norm(wsSpec)));
    return ws ? { ok: true, workspace: ws, org } : fail('WORKSPACE_NOT_FOUND', 'workspace', { org: org.slug, workspace: wsSpec });
  }
  const exact = s.workspaces.filter((w) => isLive(w) && w.workspace_id === wsSpec);
  if (exact.length === 1) {
    const ws = exact[0]!, org = findLiveOrg(s, ws.org_id);
    return org ? { ok: true, workspace: ws, org } : fail('ORG_NOT_FOUND', 'organization', { org: ws.org_id, workspace: ws.slug });
  }
  const allBySlug = s.workspaces.filter((w) => isLive(w) && norm(w.slug) === norm(wsSpec) && Boolean(findLiveOrg(s, w.org_id)));
  const reach = c ? allBySlug.filter((w) => canReadOrg(s, c, w.org_id) || canReadWorkspace(s, c, w.workspace_id)) : allBySlug;
  const cands = reach.length > 0 ? reach : allBySlug;
  if (cands.length > 1) return fail('AMBIGUOUS_WORKSPACE_SELECTOR', 'org_qualifier', { workspace: wsSpec }, cands.map(toChoice));
  if (cands.length === 0) return fail('WORKSPACE_NOT_FOUND', 'workspace', { org: null, workspace: wsSpec });
  return { ok: true, workspace: cands[0]!, org: findLiveOrg(s, cands[0]!.org_id)! };
}

export const findLiveWorkspace = (s: OrgAuthorityState, wsIdOrSlug: string, orgIdOrSlug?: string | null): WorkspaceRecord | undefined => {
  const res = resolveWorkspaceSelector(s, null, wsIdOrSlug, orgIdOrSlug);
  return res.ok ? res.workspace : undefined;
};

export function upsertAgentPrincipalInWorkspace(state: OrgAuthorityState, workspaceId: string, agentIdentityId: string, db?: OrgSqlExecutor) {
  const ai = state.agentIdentities.find((a) => a.id === agentIdentityId && isLive(a));
  if (!ai) return null;
  state.agentPrincipals ??= [];
  let ap = state.agentPrincipals.find((p) => p.workspace_id === workspaceId && p.agent_identity_id === agentIdentityId);
  if (ap) {
    ap.revoked_at = null; ap.name = ai.display_name; ap.owner_user_id = ai.owner_user_id;
  } else {
    ap = { principal_id: `ap-${workspaceId}-${agentIdentityId}`, workspace_id: workspaceId, agent_identity_id: agentIdentityId, owner_user_id: ai.owner_user_id, name: ai.display_name, revoked_at: null };
    state.agentPrincipals.push(ap);
  }
  execOrgSql(
    getOrgDb(state, db),
    'INSERT INTO swarm.agent_principals (principal_id, workspace_id, agent_identity_id, owner_user_id, name, revoked_at) VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (workspace_id, agent_identity_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, name = EXCLUDED.name, revoked_at = NULL',
    [ap.principal_id, ap.workspace_id, ap.agent_identity_id, ap.owner_user_id, ap.name],
  );
  return ap;
}

export function createOrgApprovalCard(
  s: OrgAuthorityState,
  c: CallerContext,
  input: { org: OrganizationSummary; workspace_id?: string | null; channel_id?: string | null; action_kind: string; target_scope: Record<string, unknown>; payload: Record<string, unknown>; expires_at?: string | null; now?: string },
  db?: OrgSqlExecutor,
): ApprovalPendingResult | RefusalResult {
  const now = input.now ?? new Date().toISOString();
  const ownerId = agentOwner(s, c);
  if (c.principal_kind !== 'agent' || !ownerId) return fail('ORG_ACCESS_DENIED', 'agent_owner_binding', { org: input.org.slug });
  s.approvalRequests ??= []; s.signals ??= [];
  const ws = (input.workspace_id ? s.workspaces.find((w) => w.workspace_id === input.workspace_id && isLive(w)) : undefined) ?? s.workspaces.find((w) => w.org_id === input.org.id && isLive(w));
  const ch = (input.channel_id ? s.channels.find((x) => x.channel_id === input.channel_id && isLive(x)) : undefined) ?? (ws ? s.channels.find((x) => x.workspace_id === ws.workspace_id && norm(x.slug) === 'general' && isLive(x)) : undefined);
  const approval: OrgApprovalRequest = {
    approval_id: `appr-${crypto.randomUUID()}`, org_id: input.org.id, workspace_id: ws?.workspace_id ?? input.workspace_id ?? null, channel_id: ch?.channel_id ?? input.channel_id ?? null,
    requested_by_agent_identity_id: c.principal_id, owner_user_id: ownerId, action_kind: input.action_kind, target_scope: input.target_scope, payload: input.payload,
    state: 'pending', decided_by: null, decided_at: null, expires_at: input.expires_at ?? null, created_at: now,
  };
  s.approvalRequests.push(approval);
  execOrgSql(
    getOrgDb(s, db),
    'INSERT INTO swarm.org_approval_requests (approval_id, org_id, workspace_id, channel_id, requested_by_agent_identity_id, owner_user_id, action_kind, target_scope, payload, state, decided_by, decided_at, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [approval.approval_id, approval.org_id, approval.workspace_id, approval.channel_id, approval.requested_by_agent_identity_id, approval.owner_user_id, approval.action_kind, JSON.stringify(approval.target_scope), JSON.stringify(approval.payload), approval.state, null, null, approval.expires_at, approval.created_at],
  );
  let cardSignal: OrgChatSignal | null = null;
  if (ws) {
    cardSignal = {
      signal_id: `sig-${crypto.randomUUID()}`, workspace_id: ws.workspace_id, channel_id: ch?.channel_id ?? null, from_principal_kind: 'agent', from_principal_id: c.principal_id,
      kind: 'ask', body: `[Approval Card] Agent ${c.principal_id} requested ${input.action_kind} in ${input.org.slug}. Confirm via MCP org_confirm_action or CLI: cswarm org confirm ${approval.approval_id} --approve`, approval_id: approval.approval_id, created_at: now,
    };
    s.signals.push(cardSignal);
  }
  return { ok: true, status: 'approval_required', code: 'APPROVAL_REQUIRED', approval_required: true, approval, card_signal: cardSignal };
}

export function hasVerifiedHumanApproval(s: OrgAuthorityState, orgId: string, actionKind: string, minRole: 'owner' | 'admin', approvalId: unknown, serverNowMs = Date.now()) {
  if (typeof approvalId !== 'string' || !approvalId.trim()) return null;
  const appr = (s.approvalRequests ?? []).find((a) => a.approval_id === approvalId.trim() && a.org_id === orgId && a.action_kind === actionKind && a.state === 'approved');
  if (!appr?.decided_by || (appr.expires_at != null && Date.parse(appr.expires_at) <= serverNowMs)) return null;
  const deciderRole = orgRole(s, orgId, 'user', appr.decided_by);
  return deciderRole && roleRank(deciderRole) >= roleRank(minRole) ? { ok: true as const, decided_by: appr.decided_by, role: deciderRole } : null;
}

export function orgMoveWorkspace(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: { workspace_id: string; source_org_id?: string; target_org_id: string; transfer_members?: WorkspaceMoveTransferMode; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const transferMode: WorkspaceMoveTransferMode = input.transfer_members ?? 'owners_only';
    if (transferMode !== 'all' && transferMode !== 'owners_only') return fail('INVALID_TRANSFER_MEMBERS_MODE', 'all_or_owners_only', { org: input.target_org_id, workspace: input.workspace_id });
    const wsRes = resolveWorkspaceSelector(state, caller, input.workspace_id, input.source_org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org: sourceOrg } = wsRes;
    const targetOrg = findLiveOrg(state, input.target_org_id);
    if (!sourceOrg || !targetOrg) return fail('ORG_NOT_FOUND', 'target_organization', { org: input.target_org_id, workspace: ws.slug });
    if (sourceOrg.id === targetOrg.id) return fail('WORKSPACE_ALREADY_IN_TARGET_ORG', 'distinct_target_org', { org: targetOrg.slug, workspace: ws.slug });
    if (state.workspaces.some((w) => w.org_id === targetOrg.id && w.workspace_id !== ws.workspace_id && isLive(w) && norm(w.slug) === norm(ws.slug))) {
      return fail('WORKSPACE_SLUG_CONFLICT_IN_TARGET_ORG', 'unique_workspace_slug_in_target_org', { org: targetOrg.slug, workspace: ws.slug });
    }

    let actorUserId = caller.principal_id;
    if (caller.principal_kind === 'agent') {
      const ownerId = agentOwner(state, caller);
      if (!ownerId || orgRole(state, sourceOrg.id, 'user', ownerId) !== 'owner' || orgRole(state, targetOrg.id, 'user', ownerId) !== 'owner') {
        return fail('ORG_MOVE_REQUIRES_DUAL_OWNER', 'dual_org_owner_role', { org: targetOrg.slug, workspace: ws.slug });
      }
      const verified = hasVerifiedHumanApproval(state, sourceOrg.id, 'org_move_workspace', 'owner', input.approval_id);
      if (!verified || orgRole(state, targetOrg.id, 'user', verified.decided_by) !== 'owner') {
        return createOrgApprovalCard(state, caller, {
          org: sourceOrg, workspace_id: ws.workspace_id, action_kind: 'org_move_workspace',
          target_scope: { source_org: sourceOrg.slug, target_org: targetOrg.slug, workspace: ws.slug, transfer_members: transferMode },
          payload: { workspace_id: ws.workspace_id, source_org_id: sourceOrg.id, target_org_id: targetOrg.id, transfer_members: transferMode }, now,
        }, tx);
      }
      actorUserId = verified.decided_by;
    } else if (orgRole(state, sourceOrg.id, 'user', caller.principal_id) !== 'owner' || orgRole(state, targetOrg.id, 'user', caller.principal_id) !== 'owner') {
      return fail('ORG_MOVE_REQUIRES_DUAL_OWNER', 'dual_org_owner_role', { org: targetOrg.slug, workspace: ws.slug });
    }

    state.lockLog ??= [];
    const acquiredLocks = [...CANONICAL_ORG_CHANNEL_LOCK_ORDER];
    state.lockLog.push(...acquiredLocks);
    execOrgSql(tx, 'SELECT id FROM swarm.organizations WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [sourceOrg.id, targetOrg.id]);
    execOrgSql(tx, 'SELECT workspace_id, org_id FROM swarm.workspaces WHERE workspace_id = $1 FOR UPDATE', [ws.workspace_id]);
    execOrgSql(tx, 'SELECT channel_id FROM swarm.channels WHERE workspace_id = $1 ORDER BY channel_id FOR UPDATE', [ws.workspace_id]);
    execOrgSql(tx, 'SELECT id FROM swarm.org_memberships WHERE org_id IN ($1, $2) ORDER BY id FOR UPDATE', [sourceOrg.id, targetOrg.id]);
    execOrgSql(tx, 'SELECT id FROM swarm.workspace_principal_grants WHERE workspace_id = $1 ORDER BY id FOR UPDATE', [ws.workspace_id]);
    execOrgSql(tx, 'SELECT id FROM swarm.channel_memberships WHERE workspace_id = $1 ORDER BY id FOR UPDATE', [ws.workspace_id]);
    execOrgSql(tx, 'SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = $1 ORDER BY principal_id FOR UPDATE', [ws.workspace_id]);
    execOrgSql(tx, 'SELECT seat_id FROM swarm.hosted_mcp_seats WHERE workspace_id = $1 ORDER BY seat_id FOR UPDATE', [ws.workspace_id]);
    execOrgSql(tx, 'SELECT swarm.org_move_workspace($1, $2, $3, $4)', [ws.workspace_id, targetOrg.id, actorUserId, transferMode]);
    tx?.rpc?.('org_move_workspace', { p_ws: ws.workspace_id, p_dst: targetOrg.id, p_actor: actorUserId, p_mode: transferMode });

    const reconciled = reconcileWorkspaceMove(state, { workspace_id: ws.workspace_id, target_org_id: targetOrg.id, actor_user_id: actorUserId, transfer_members: transferMode, now });
    if (!reconciled.ok) return reconciled;
    const closedSeats = [...reconciled.closed_seat_ids];
    if (transferMode === 'owners_only') {
      for (const cm of state.channelMemberships) {
        if (cm.workspace_id === ws.workspace_id && isLive(cm) && orgRole(state, targetOrg.id, cm.principal_kind, cm.principal_id) !== 'owner') {
          for (const sid of cascadeWorkspaceMemberRemoval(state, { workspace_id: ws.workspace_id, principal_kind: cm.principal_kind, principal_id: cm.principal_id, now }).closed_seat_ids) if (!closedSeats.includes(sid)) closedSeats.push(sid);
        }
      }
      for (const ap of state.agentPrincipals ?? []) {
        if (ap.workspace_id === ws.workspace_id && isLive(ap) && orgRole(state, targetOrg.id, 'agent', ap.agent_identity_id) !== 'owner') {
          for (const sid of cascadeWorkspaceMemberRemoval(state, { workspace_id: ws.workspace_id, principal_kind: 'agent', principal_id: ap.agent_identity_id, now }).closed_seat_ids) if (!closedSeats.includes(sid)) closedSeats.push(sid);
        }
      }
    }
    for (const ch of state.channels) if (ch.workspace_id === ws.workspace_id && ch.org_id !== undefined) ch.org_id = targetOrg.id;

    return {
      ok: true as const, status: 'executed' as const, workspace_id: ws.workspace_id, source_org_id: sourceOrg.id, target_org_id: targetOrg.id,
      transfer_members: transferMode, lock_order: acquiredLocks, closed_seat_ids: closedSeats,
      preserved: {
        workspace_id: ws.workspace_id,
        channel_ids: state.channels.filter((ch) => ch.workspace_id === ws.workspace_id).map((ch) => ch.channel_id),
        signal_ids: (state.signals ?? []).filter((sig) => sig.workspace_id === ws.workspace_id).map((sig) => sig.signal_id),
        file_ids: Array.from(new Set([...(state.files ?? []).filter((f) => f.workspace_id === ws.workspace_id).map((f) => f.file_id), ...(state.fileChannelBindings ?? []).filter((b) => b.workspace_id === ws.workspace_id).map((b) => b.file_id)])),
      },
    };
  });
}

registerOrgActionExecutor('org_move_workspace', (s, c, p, db) => orgMoveWorkspace(s, c, p as Parameters<typeof orgMoveWorkspace>[2], db));
export const org_move_workspace = orgMoveWorkspace;
