import {
 CANONICAL_ORG_CHANNEL_LOCK_ORDER, type CallerContext, type OrgApprovalRequest, type OrganizationSummary,
 type OrgMembershipRecord, type OrgRole, type WorkspaceMoveTransferMode, type WorkspaceRecord, type WorkspaceSelectorChoice,
 agentOwner, canReadOrg, canReadWorkspace, cascadeWorkspaceMemberRemoval, fail, isLive, isPrin, norm, orgRole, reconcileWorkspaceMove,
} from '../../../../src/protocol/org-channels-contract.js';
import type { ApprovalPendingResult, OrgAuthorityState, OrgChatSignal, RefusalResult } from './invites.js';

export interface OrgSqlQueryResult<T = Record<string, unknown>> { rows?: T[]; rowCount?: number; }
export interface OrgStorageAdapter { put?: (k: string, d: Uint8Array | string, ct: string) => unknown; delete?: (k: string) => unknown; }
export interface OrgSqlExecutor {
 query: <T = Record<string, unknown>>(sql: string, p?: readonly unknown[]) => OrgSqlQueryResult<T> | Promise<OrgSqlQueryResult<T>> | unknown;
 rpc?: <T = unknown>(fn: string, p?: Record<string, unknown> | readonly unknown[]) => T | Promise<T>;
 withTransaction?: <T>(fn: (tx: OrgSqlExecutor) => T) => T;
 storage?: OrgStorageAdapter;
}
export interface OrgCallerContext extends CallerContext { authenticated_email?: string | null; }
export interface OrgCommandOptions { testClockIso?: string; db?: OrgSqlExecutor; }

export type OrgActionExecutor = (s: OrgAuthorityState, c: OrgCallerContext, p: Record<string, unknown>, db?: OrgSqlExecutor) => unknown;
export const ORG_ACTION_EXECUTORS: Record<string, OrgActionExecutor> = {};
export const registerOrgActionExecutor = (k: string, fn: OrgActionExecutor) => { ORG_ACTION_EXECUTORS[k] = fn; };
export const getOrgDb = (s: OrgAuthorityState, db?: OrgSqlExecutor): OrgSqlExecutor | undefined => db ?? s.db;
export const execOrgSql = (db: OrgSqlExecutor | undefined, sql: string, p: readonly unknown[] = []) => (db ? db.query(sql, p) : undefined);

const snapS = (s: OrgAuthorityState) => {
 const o: Record<string, unknown> = {}, r = s as unknown as Record<string, unknown>;
 for (const k of Object.keys(r)) if (k !== 'db' && k !== '_inTx' && r[k] !== undefined) o[k] = structuredClone(r[k]);
 return o;
};
const restS = (s: OrgAuthorityState, sn: Record<string, unknown>) => {
 const r = s as unknown as Record<string, unknown>;
 for (const k of Object.keys(r)) if (k !== 'db' && k !== '_inTx' && !(k in sn)) delete r[k];
 for (const [k, v] of Object.entries(sn)) r[k] = v;
};

export function withOrgTx<T>(s: OrgAuthorityState, db: OrgSqlExecutor | undefined, fn: (tx: OrgSqlExecutor | undefined) => T): T {
 const act = getOrgDb(s, db), sn = !s._inTx ? snapS(s) : null;
 if (!act) {
  try { const r = fn(undefined); return r instanceof Promise ? (r.catch((e) => { if (sn) restS(s, sn); throw e; }) as T) : r; }
  catch (e) { if (sn) restS(s, sn); throw e; }
 }
 const run = (tx: OrgSqlExecutor): T => {
  const pD = s.db, pT = s._inTx; s.db = tx; s._inTx = true; let asy = false;
  try {
   const o = fn(tx);
   if (o instanceof Promise) { asy = true; return o.then((v) => { s.db = pD; s._inTx = pT; return v; }, (e) => { s.db = pD; s._inTx = pT; if (sn) restS(s, sn); throw e; }) as T; }
   return o;
  } catch (e) { if (sn) restS(s, sn); throw e; } finally { if (!asy) { s.db = pD; s._inTx = pT; } }
 };
 if (s._inTx || !act.withTransaction) return run(act);
 try { return act.withTransaction((tx) => run(tx)); } catch (e) { if (sn) restS(s, sn); throw e; }
}

export const roleRank = (r: OrgRole | null | undefined): number => r === 'owner' ? 4 : r === 'admin' ? 3 : r === 'member' ? 2 : r === 'guest' ? 1 : 0;
export const findLiveOrg = (s: OrgAuthorityState, idOrSlug: string): OrganizationSummary | undefined => {
 const t = (idOrSlug ?? '').trim();
 return s.organizations.find((o) => isLive(o) && (o.id === t || norm(o.slug) === norm(t)));
};

export function syncLockedOrgRows(s: OrgAuthorityState, orgId: string, tx?: OrgSqlExecutor) {
 const oR = execOrgSql(tx, 'SELECT * FROM swarm.organizations WHERE id = $1 FOR UPDATE', [orgId]) as OrgSqlQueryResult<Partial<OrganizationSummary>> | undefined;
 for (const r of oR?.rows ?? []) { const ex = s.organizations.find((o) => o.id === r.id); if (ex && r.slug) Object.assign(ex, r); }
 const mR = execOrgSql(tx, 'SELECT * FROM swarm.org_memberships WHERE org_id = $1 ORDER BY id FOR UPDATE', [orgId]) as OrgSqlQueryResult<Partial<OrgMembershipRecord>> | undefined;
 for (const r of mR?.rows ?? []) {
  if (!r.principal_kind || !r.principal_id || !r.role) continue;
  const ex = s.orgMemberships.find((m) => m.org_id === (r.org_id ?? orgId) && isPrin(m, r.principal_kind!, r.principal_id!));
  if (ex) Object.assign(ex, r);
 }
}

export function resolveWorkspaceSelector(s: OrgAuthorityState, c: CallerContext | null | undefined, wsSel: string, orgSel?: string | null): { ok: true; workspace: WorkspaceRecord; org: OrganizationSummary } | RefusalResult {
 let oS = orgSel?.trim() || null, wS = (wsSel ?? '').trim();
 if (wS.includes('/')) { const [oP, wP] = wS.split('/', 2); if (!oS && oP) oS = oP.trim(); wS = wP?.trim() || ''; }
 const noWs = (o: string | null) => fail('WORKSPACE_NOT_FOUND', 'workspace', { org: o, workspace: wS });
 const toCh = (w: WorkspaceRecord): WorkspaceSelectorChoice => {
  const o = s.organizations.find((x) => x.id === w.org_id)!;
  return { org_id: o.id, org_slug: o.slug, workspace_id: w.workspace_id, workspace_slug: w.slug, selector: `${o.slug}/${w.slug}` };
 };
 if (oS) {
  const org = findLiveOrg(s, oS);
  if (!org) return noWs(oS);
  const ws = s.workspaces.find((w) => isLive(w) && w.org_id === org.id && (w.workspace_id === wS || norm(w.slug) === norm(wS)));
  return ws ? { ok: true, workspace: ws, org } : noWs(org.slug);
 }
 const ex = s.workspaces.filter((w) => isLive(w) && w.workspace_id === wS);
 if (ex.length === 1) {
  const ws = ex[0]!, org = findLiveOrg(s, ws.org_id);
  return org ? { ok: true, workspace: ws, org } : fail('ORG_NOT_FOUND', 'organization', { org: ws.org_id, workspace: ws.slug });
 }
 const all = s.workspaces.filter((w) => isLive(w) && norm(w.slug) === norm(wS) && Boolean(findLiveOrg(s, w.org_id)));
 const rch = c ? all.filter((w) => canReadOrg(s, c, w.org_id) || canReadWorkspace(s, c, w.workspace_id)) : all, cds = rch.length > 0 ? rch : all;
 if (cds.length > 1) return fail('AMBIGUOUS_WORKSPACE_SELECTOR', 'org_qualifier', { workspace: wS }, cds.map(toCh));
 return cds.length === 0 ? noWs(null) : { ok: true, workspace: cds[0]!, org: findLiveOrg(s, cds[0]!.org_id)! };
}

export const findLiveWorkspace = (s: OrgAuthorityState, w: string, o?: string | null) => {
 const r = resolveWorkspaceSelector(s, null, w, o); return r.ok ? r.workspace : undefined;
};

export function upsertAgentPrincipalInWorkspace(s: OrgAuthorityState, wsId: string, agId: string, db?: OrgSqlExecutor) {
 const ai = s.agentIdentities.find((a) => a.id === agId && isLive(a));
 if (!ai) return null;
 let ap = (s.agentPrincipals ??= []).find((p) => p.workspace_id === wsId && p.agent_identity_id === agId);
 if (ap) { ap.revoked_at = null; ap.name = ai.display_name; ap.owner_user_id = ai.owner_user_id; }
 else { ap = { principal_id: crypto.randomUUID(), workspace_id: wsId, agent_identity_id: agId, owner_user_id: ai.owner_user_id, name: ai.display_name, revoked_at: null }; s.agentPrincipals.push(ap); }
 execOrgSql(getOrgDb(s, db), 'INSERT INTO swarm.agent_principals (principal_id,workspace_id,agent_identity_id,owner_user_id,name,revoked_at) VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT (workspace_id,agent_identity_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,name=EXCLUDED.name,revoked_at=NULL', [ap.principal_id, ap.workspace_id, ap.agent_identity_id, ap.owner_user_id, ap.name]);
 return ap;
}

const IGN = new Set(['approval_id', 'require_approval', 'on_behalf_of_owner', 'now', 'kind']);
export function canonicalApprovalJson(v: unknown): string {
 if (v === null || typeof v !== 'object') return JSON.stringify(v);
 if (Array.isArray(v)) return `[${v.map(canonicalApprovalJson).join(',')}]`;
 const r = v as Record<string, unknown>, ks = Object.keys(r).filter((k) => !IGN.has(k) && r[k] !== undefined).sort();
 return `{${ks.map((k) => `${JSON.stringify(k)}:${canonicalApprovalJson(r[k])}`).join(',')}}`;
}

export function createOrgApprovalCard(s: OrgAuthorityState, c: CallerContext, input: { org: OrganizationSummary; workspace_id?: string | null; channel_id?: string | null; action_kind: string; target_scope: Record<string, unknown>; payload: Record<string, unknown>; expires_at?: string | null; now?: string }, db?: OrgSqlExecutor): ApprovalPendingResult | RefusalResult {
 const now = input.now ?? new Date().toISOString(), oId = agentOwner(s, c);
 if (c.principal_kind !== 'agent' || !oId) return fail('ORG_ACCESS_DENIED', 'agent_owner_binding', { org: input.org.slug });
 const ws = (input.workspace_id ? s.workspaces.find((w) => w.workspace_id === input.workspace_id && isLive(w)) : undefined) ?? s.workspaces.find((w) => w.org_id === input.org.id && isLive(w));
 const ch = (input.channel_id ? s.channels.find((x) => x.channel_id === input.channel_id && isLive(x)) : undefined) ?? (ws ? s.channels.find((x) => x.workspace_id === ws.workspace_id && norm(x.slug) === 'general' && isLive(x)) : undefined);
 const cp: Record<string, unknown> = {};
 for (const [k, v] of Object.entries(input.payload)) if (!IGN.has(k) && v !== undefined) cp[k] = v;
 const a: OrgApprovalRequest = {
  approval_id: crypto.randomUUID(), org_id: input.org.id, workspace_id: ws?.workspace_id ?? input.workspace_id ?? null, channel_id: ch?.channel_id ?? input.channel_id ?? null,
  requested_by_agent_identity_id: c.principal_id, owner_user_id: oId, action_kind: input.action_kind, target_scope: input.target_scope, payload: cp,
  state: 'pending', decided_by: null, decided_at: null, expires_at: input.expires_at ?? null, created_at: now,
 };
 (s.approvalRequests ??= []).push(a);
 const aDb = getOrgDb(s, db);
 execOrgSql(aDb, 'INSERT INTO swarm.org_approval_requests (approval_id,org_id,workspace_id,channel_id,requested_by_agent_identity_id,owner_user_id,action_kind,target_scope,payload,state,decided_by,decided_at,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12)', [a.approval_id, a.org_id, a.workspace_id, a.channel_id, a.requested_by_agent_identity_id, a.owner_user_id, a.action_kind, JSON.stringify(a.target_scope), JSON.stringify(a.payload), a.state, a.expires_at, a.created_at]);
 let sig: OrgChatSignal | null = null;
 if (ws) {
  sig = { signal_id: crypto.randomUUID(), workspace_id: ws.workspace_id, channel_id: ch?.channel_id ?? null, from_principal_kind: 'agent', from_principal_id: c.principal_id, kind: 'ask', body: `[Approval Card] Agent ${c.principal_id} requested ${input.action_kind} in ${input.org.slug}. Confirm via MCP org_confirm_action or CLI: cswarm org confirm ${a.approval_id} --approve`, approval_id: a.approval_id, created_at: now };
  (s.signals ??= []).push(sig);
  execOrgSql(aDb, 'INSERT INTO swarm.signals (signal_id,workspace_id,channel_id,from_principal_kind,from_principal_id,kind,body,approval_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [sig.signal_id, sig.workspace_id, sig.channel_id, sig.from_principal_kind, sig.from_principal_id, sig.kind, sig.body, sig.approval_id ?? null, sig.created_at]);
 }
 return { ok: true, status: 'approval_required', code: 'APPROVAL_REQUIRED', approval_required: true, approval: a, card_signal: sig };
}

export function hasVerifiedHumanApproval(s: OrgAuthorityState, orgId: string, actionKind: string, minRole: 'owner' | 'admin', approvalId: unknown, caller?: CallerContext, expPayload?: Record<string, unknown>, expScope?: Record<string, unknown>, nowMs = Date.now(), db?: OrgSqlExecutor) {
 if (typeof approvalId !== 'string' || !approvalId.trim()) return null;
 const a = (s.approvalRequests ?? []).find((x) => x.approval_id === approvalId.trim() && x.org_id === orgId && x.action_kind === actionKind && x.state === 'approved' && !(x as { consumed_at?: string | null }).consumed_at);
 if (!a?.decided_by || (a.expires_at != null && Date.parse(a.expires_at) <= nowMs)) return null;
 if (caller?.principal_kind === 'agent' && a.requested_by_agent_identity_id !== caller.principal_id) return null;
 if (expPayload && canonicalApprovalJson(a.payload) !== canonicalApprovalJson(expPayload)) return null;
 if (expScope && canonicalApprovalJson(a.target_scope) !== canonicalApprovalJson(expScope)) return null;
 const dRole = orgRole(s, orgId, 'user', a.decided_by);
 if (!dRole || roleRank(dRole) < roleRank(minRole)) return null;
 const iso = new Date(nowMs).toISOString();
 (a as { consumed_at?: string | null }).consumed_at = iso;
 execOrgSql(getOrgDb(s, db), 'UPDATE swarm.org_approval_requests SET decided_at = COALESCE(decided_at, $2) WHERE approval_id = $1 AND state = $3', [a.approval_id, iso, 'approved']);
 return { ok: true as const, decided_by: a.decided_by, role: dRole };
}

export function orgMoveWorkspace(s: OrgAuthorityState, c: CallerContext, input: { workspace_id: string; source_org_id?: string; target_org_id: string; transfer_members?: WorkspaceMoveTransferMode; require_approval?: boolean; approval_id?: string; now?: string }, db?: OrgSqlExecutor) {
 return withOrgTx(s, db, (tx) => {
  const now = input.now ?? new Date().toISOString(), tm: WorkspaceMoveTransferMode = input.transfer_members ?? 'owners_only';
  if (tm !== 'all' && tm !== 'owners_only') return fail('INVALID_TRANSFER_MEMBERS_MODE', 'all_or_owners_only', { org: input.target_org_id, workspace: input.workspace_id });
  const wsRes = resolveWorkspaceSelector(s, c, input.workspace_id, input.source_org_id);
  if (!wsRes.ok) return wsRes;
  const { workspace: ws, org: src } = wsRes, tgt = findLiveOrg(s, input.target_org_id), wId = ws.workspace_id;
  if (!src || !tgt) return fail('ORG_NOT_FOUND', 'target_organization', { org: input.target_org_id, workspace: ws.slug });
  if (src.id === tgt.id) return fail('WORKSPACE_ALREADY_IN_TARGET_ORG', 'distinct_target_org', { org: tgt.slug, workspace: ws.slug });
  if (s.workspaces.some((w) => w.org_id === tgt.id && w.workspace_id !== wId && isLive(w) && norm(w.slug) === norm(ws.slug))) return fail('WORKSPACE_SLUG_CONFLICT_IN_TARGET_ORG', 'unique_workspace_slug_in_target_org', { org: tgt.slug, workspace: ws.slug });
  const isDual = (u?: string | null) => Boolean(u && orgRole(s, src.id, 'user', u) === 'owner' && orgRole(s, tgt.id, 'user', u) === 'owner');
  const needDual = () => fail('ORG_MOVE_REQUIRES_DUAL_OWNER', 'dual_org_owner_role', { org: tgt.slug, workspace: ws.slug });
  const mScope = { source_org: src.slug, target_org: tgt.slug, workspace: ws.slug, transfer_members: tm }, mPay = { workspace_id: wId, source_org_id: src.id, target_org_id: tgt.id, transfer_members: tm };
  let actorId = c.principal_id;
  if (c.principal_kind === 'agent') {
   if (!isDual(agentOwner(s, c))) return needDual();
   const ver = hasVerifiedHumanApproval(s, src.id, 'org_move_workspace', 'owner', input.approval_id, c, mPay, mScope, Date.parse(now) || Date.now(), tx);
   if (!ver || !isDual(ver.decided_by)) return createOrgApprovalCard(s, c, { org: src, workspace_id: wId, action_kind: 'org_move_workspace', target_scope: mScope, payload: mPay, now }, tx);
   actorId = ver.decided_by;
  } else if (!isDual(c.principal_id)) return needDual();
  const locks = [...CANONICAL_ORG_CHANNEL_LOCK_ORDER];
  (s.lockLog ??= []).push(...locks);
  execOrgSql(tx, 'SELECT id FROM swarm.organizations WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [src.id, tgt.id]);
  execOrgSql(tx, 'SELECT workspace_id,org_id FROM swarm.workspaces WHERE workspace_id=$1 FOR UPDATE', [wId]);
  for (const [t, k, byO] of [['channels','channel_id',false],['org_memberships','id',true],['workspace_principal_grants','id',false],['channel_memberships','id',false],['agent_principals','principal_id',false],['hosted_mcp_seats','seat_id',false]] as const) {
   execOrgSql(tx, `SELECT ${k} FROM swarm.${t} WHERE ${byO ? 'org_id IN ($1,$2)' : 'workspace_id=$1'} ORDER BY ${k} FOR UPDATE`, byO ? [src.id, tgt.id] : [wId]);
  }
  execOrgSql(tx, 'SELECT swarm.org_move_workspace($1, $2, $3, $4)', [wId, tgt.id, actorId, tm]);
  const rec = reconcileWorkspaceMove(s, { workspace_id: wId, target_org_id: tgt.id, actor_user_id: actorId, transfer_members: tm, now });
  if (!rec.ok) return rec;
  const closed = [...rec.closed_seat_ids];
  if (tm === 'owners_only') {
   const drop = (pk: 'user' | 'agent', pid: string) => {
    if (orgRole(s, tgt.id, pk, pid) !== 'owner') for (const id of cascadeWorkspaceMemberRemoval(s, { workspace_id: wId, principal_kind: pk, principal_id: pid, now }).closed_seat_ids) if (!closed.includes(id)) closed.push(id);
   };
   for (const cm of s.channelMemberships) if (cm.workspace_id === wId && isLive(cm)) drop(cm.principal_kind, cm.principal_id);
   for (const ap of s.agentPrincipals ?? []) if (ap.workspace_id === wId && isLive(ap)) drop('agent', ap.agent_identity_id);
  }
  for (const ch of s.channels) if (ch.workspace_id === wId && ch.org_id !== undefined) ch.org_id = tgt.id;
  return {
   ok: true as const, status: 'executed' as const, workspace_id: wId, source_org_id: src.id, target_org_id: tgt.id,
   transfer_members: tm, lock_order: locks, closed_seat_ids: closed,
   preserved: {
    workspace_id: wId,
    channel_ids: s.channels.filter((x) => x.workspace_id === wId).map((x) => x.channel_id),
    signal_ids: (s.signals ?? []).filter((x) => x.workspace_id === wId).map((x) => x.signal_id),
    file_ids: Array.from(new Set([...(s.files ?? []).filter((f) => f.workspace_id === wId).map((f) => f.file_id), ...(s.fileChannelBindings ?? []).filter((b) => b.workspace_id === wId).map((b) => b.file_id)])),
   },
  };
 });
}

registerOrgActionExecutor('org_move_workspace', (s, c, p, db) => orgMoveWorkspace(s, c, p as Parameters<typeof orgMoveWorkspace>[2], db));
export const org_move_workspace = orgMoveWorkspace;
