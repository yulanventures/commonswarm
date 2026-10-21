import { createHash } from 'node:crypto';
import {
 type CallerContext, type OrgApprovalRequest, type OrgChannelAuthorityState,
 type OrgChannelRefusal, type OrganizationSummary, type OrgRole,
 type PrincipalKind, type WorkspacePrincipalGrant,
 agentOwner, canReadOrg, fail, isLive, isPrin, orgRole,
} from '../../../../src/protocol/org-channels-contract.js';
import type { OrgLogoObjectRecord, OrgLogoPendingUpload } from './logo.js';
import {
 ORG_ACTION_EXECUTORS, type OrgCallerContext, type OrgCommandOptions, type OrgSqlExecutor,
 createOrgApprovalCard, execOrgSql, findLiveOrg, hasVerifiedHumanApproval,
 registerOrgActionExecutor, resolveWorkspaceSelector, roleRank,
 upsertAgentPrincipalInWorkspace, withOrgTx,
} from './move-workspace.js';
export * from './move-workspace.js';
export type { OrgLogoObjectRecord, OrgLogoPendingUpload } from './logo.js';
export const VALID_ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'];
export const ORG_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;
export interface OrgInviteRecord {
 invite_id: string; org_id: string; email: string | null; role: OrgRole; workspace_ids: string[];
 token_hash: string; token?: string; invited_by: string; expires_at: string; created_at: string;
 consumed_at?: string | null; consumed_by?: string | null; revoked_at?: string | null;
}
export interface OrgChatSignal {
 signal_id: string; workspace_id: string; channel_id: string | null;
 from_principal_kind: PrincipalKind; from_principal_id: string;
 kind: 'note' | 'ask' | 'working-on'; body: string; approval_id?: string | null; created_at: string;
}
export interface OrgAuthorityState extends OrgChannelAuthorityState {
 orgInvites?: OrgInviteRecord[]; approvalRequests?: OrgApprovalRequest[];
 logoUploads?: Record<string, OrgLogoPendingUpload>; logoObjects?: Record<string, OrgLogoObjectRecord>;
 signals?: OrgChatSignal[]; files?: Array<{ file_id: string; workspace_id: string; name?: string; created_at?: string }>;
 lockLog?: string[]; db?: OrgSqlExecutor; _inTx?: boolean;
}
export type RefusalResult = { ok: false; refusal: OrgChannelRefusal };
export type ApprovalPendingResult = {
 ok: true; status: 'approval_required'; code: 'APPROVAL_REQUIRED';
 approval_required: true; approval: OrgApprovalRequest; card_signal: OrgChatSignal | null;
};
export const isValidOrgRole = (v: unknown): v is OrgRole => typeof v === 'string' && (VALID_ORG_ROLES as readonly string[]).includes(v);
export const isValidOrgSlug = (s: string): boolean => s.length >= 1 && s.length <= 48 && ORG_SLUG_RE.test(s);
export function effectiveCallerOrgRole(s: OrgAuthorityState, c: CallerContext, orgId: string): OrgRole | null {
 if (!canReadOrg(s, c, orgId)) return null;
 if (c.principal_kind === 'user') return orgRole(s, orgId, 'user', c.principal_id);
 const oId = agentOwner(s, c), uR = oId ? orgRole(s, orgId, 'user', oId) : null;
 if (!uR) return null;
 const aR = orgRole(s, orgId, 'agent', c.principal_id);
 return uR === 'guest' || aR === 'guest' ? (aR ? 'guest' : null) : (aR ?? uR);
}
function needAgentConfirm(k: string, p: Record<string, unknown>, ex?: OrgRole | null): boolean {
 if (k === 'org_delete' || k === 'org_move_workspace' || k === 'org_remove_member') return true;
 const r = (p.role as OrgRole | undefined) ?? 'member';
 if (k === 'org_set_member_role') return r === 'owner' || r === 'admin' || ex === 'owner' || ex === 'admin';
 if (k === 'org_invite_create' || k === 'org_assign_workspace_member') return r === 'owner' || r === 'admin';
 return k === 'org_remove_workspace_member' && (ex === 'owner' || ex === 'admin');
}
export function authorizeOrgAction(
 s: OrgAuthorityState, c: CallerContext,
 opts: { org: OrganizationSummary; workspace_slug?: string | null; workspace_id?: string | null; channel_id?: string | null; min_role: 'owner' | 'admin'; action_kind: string; payload: Record<string, unknown>; existing_target_role?: OrgRole | null; require_approval?: boolean; now?: string; db?: OrgSqlExecutor },
): { status: 'authorized'; actor_user_id: string; role: OrgRole } | { status: 'approval_required'; result: ApprovalPendingResult } | { status: 'refused'; result: RefusalResult } {
 const scope = { org: opts.org.slug, workspace: opts.workspace_slug ?? null };
 if (!canReadOrg(s, c, opts.org.id)) return { status: 'refused', result: fail('ORG_ACCESS_DENIED', 'org_membership', scope) };
 const errC = opts.min_role === 'owner' ? 'ORG_OWNER_REQUIRED' : 'ORG_ADMIN_REQUIRED', errM = opts.min_role === 'owner' ? 'org_owner_role' : 'org_admin_role';
 if (c.principal_kind === 'user') {
  const uR = orgRole(s, opts.org.id, 'user', c.principal_id);
  return roleRank(uR) < roleRank(opts.min_role) ? { status: 'refused', result: fail(errC, errM, scope) } : { status: 'authorized', actor_user_id: c.principal_id, role: uR! };
 }
 const oId = agentOwner(s, c), oR = oId ? orgRole(s, opts.org.id, 'user', oId) : null, aR = orgRole(s, opts.org.id, 'agent', c.principal_id);
 const ver = hasVerifiedHumanApproval(s, opts.org.id, opts.action_kind, opts.min_role, opts.payload.approval_id, c, opts.payload, scope, opts.now ? Date.parse(opts.now) || Date.now() : Date.now(), opts.db);
 if (ver) return { status: 'authorized', actor_user_id: ver.decided_by, role: ver.role };
 const need = Boolean(opts.require_approval) || needAgentConfirm(opts.action_kind, opts.payload, opts.existing_target_role);
 if (!need && oId && roleRank(aR) >= roleRank(opts.min_role) && roleRank(oR) >= roleRank(opts.min_role)) return { status: 'authorized', actor_user_id: oId, role: aR! };
 if (oId && roleRank(oR) >= roleRank(opts.min_role)) {
  const cl = { ...opts.payload }; delete cl.require_approval; delete cl.on_behalf_of_owner; delete cl.approval_id;
  const card = createOrgApprovalCard(s, c, { org: opts.org, workspace_id: opts.workspace_id ?? null, channel_id: opts.channel_id ?? null, action_kind: opts.action_kind, target_scope: scope, payload: cl, now: opts.now }, opts.db);
  return card.ok ? { status: 'approval_required', result: card } : { status: 'refused', result: card };
 }
 return { status: 'refused', result: fail(errC, errM, scope) };
}
export const hashInviteToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
export function orgInviteCreate(
 s: OrgAuthorityState, c: OrgCallerContext,
 input: { org_id: string; email?: string | null; role?: OrgRole; workspace_ids?: string[]; ttl_ms?: number; require_approval?: boolean; approval_id?: string; now?: string },
 db?: OrgSqlExecutor,
) {
 return withOrgTx(s, db, (tx) => {
  const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const role: OrgRole = input.role ?? 'member';
  if (!isValidOrgRole(role)) return fail('INVALID_ORG_ROLE', 'valid_org_role', { org: org.slug });
  const auth = authorizeOrgAction(s, c, { org, min_role: role === 'owner' ? 'owner' : 'admin', action_kind: 'org_invite_create', payload: { ...input, role }, require_approval: input.require_approval, now, db: tx });
  if (auth.status !== 'authorized') return auth.result;
  const wsIds: string[] = [];
  for (const raw of input.workspace_ids ?? []) {
   const wr = resolveWorkspaceSelector(s, c, raw, org.id);
   if (!wr.ok) return fail('WORKSPACE_NOT_FOUND', 'workspace_in_org', { org: org.slug, workspace: raw });
   if (!wsIds.includes(wr.workspace.workspace_id)) wsIds.push(wr.workspace.workspace_id);
  }
  const tok = `swm_orginv_${crypto.randomUUID().replace(/-/g, '')}`, ttl = input.ttl_ms && input.ttl_ms > 0 ? input.ttl_ms : DEFAULT_TTL;
  const inv: OrgInviteRecord = {
   invite_id: crypto.randomUUID(), org_id: org.id, email: input.email ? input.email.trim().toLowerCase() : null,
   role, workspace_ids: wsIds, token_hash: hashInviteToken(tok), token: tok, invited_by: auth.actor_user_id,
   expires_at: new Date(new Date(now).getTime() + ttl).toISOString(), created_at: now, consumed_at: null, consumed_by: null, revoked_at: null,
  };
  (s.orgInvites ??= []).push(inv);
  execOrgSql(tx, "INSERT INTO swarm.org_invites (invite_id, org_id, email, role, workspace_ids, token_hash, invited_by, expires_at, created_at, consumed_at, consumed_by, revoked_at) VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7, $8, $9, NULL, NULL, NULL)", [inv.invite_id, inv.org_id, inv.email, inv.role, inv.workspace_ids, inv.token_hash, inv.invited_by, inv.expires_at, inv.created_at]);
  return { ok: true as const, status: 'executed' as const, invite: inv, token: tok };
 });
}
export function orgInviteAccept(
 s: OrgAuthorityState, c: OrgCallerContext,
 input: { token?: string; invite_id?: string; email?: string | null; now?: string },
 opts?: OrgCommandOptions,
) {
 return withOrgTx(s, opts?.db, (tx) => {
  const iso = opts?.testClockIso ?? new Date().toISOString(), ms = Date.parse(iso), raw = typeof input.token === 'string' ? input.token.trim() : '';
  if (!raw) return fail('ORG_INVITE_TOKEN_REQUIRED', 'invite_token', { org: null });
  const h = hashInviteToken(raw);
  execOrgSql(tx, "SELECT invite_id, revoked_at, consumed_at FROM swarm.org_invites WHERE token_hash = decode($1, 'hex') FOR UPDATE", [h]);
  const inv = (s.orgInvites ?? []).find((x) => x.token_hash === h && (!input.invite_id || x.invite_id === input.invite_id));
  if (!inv || inv.revoked_at != null || inv.consumed_at != null) return fail('ORG_INVITE_UNAVAILABLE', 'active_org_invite', { org: inv?.org_id ?? null });
  if (Date.parse(inv.expires_at) <= ms) return fail('ORG_INVITE_EXPIRED', 'unexpired_org_invite', { org: inv.org_id });
  if (inv.email) {
   const em = typeof c.authenticated_email === 'string' ? c.authenticated_email.trim().toLowerCase() : '';
   if (!em || em !== inv.email.trim().toLowerCase()) return fail('INVITE_EMAIL_MISMATCH', 'matching_authenticated_email', { org: inv.org_id });
  }
  const org = findLiveOrg(s, inv.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: inv.org_id });
  const actId = c.principal_kind === 'user' ? c.principal_id : agentOwner(s, c);
  if (!actId) return fail('ORG_ACCESS_DENIED', 'authenticated_owner', { org: org.slug });
  const upd = execOrgSql(tx, 'UPDATE swarm.org_invites SET consumed_at = $2, consumed_by = $3 WHERE invite_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL', [inv.invite_id, iso, actId]) as { rowCount?: number } | undefined;
  if (upd && upd.rowCount !== undefined && upd.rowCount <= 0) return fail('ORG_INVITE_UNAVAILABLE', 'active_org_invite', { org: inv.org_id });
  inv.consumed_at = iso; inv.consumed_by = actId;
  let m = s.orgMemberships.find((x) => x.org_id === org.id && isPrin(x, c.principal_kind, c.principal_id));
  if (m) { m.role = isLive(m) && roleRank(m.role) >= roleRank(inv.role) ? m.role : inv.role; m.invited_by = inv.invited_by; m.revoked_at = null; }
  else { m = { id: crypto.randomUUID(), org_id: org.id, principal_kind: c.principal_kind, principal_id: c.principal_id, role: inv.role, invited_by: inv.invited_by, created_at: iso, revoked_at: null }; s.orgMemberships.push(m); }
  execOrgSql(tx, 'INSERT INTO swarm.org_memberships (id, org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) ON CONFLICT (org_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, revoked_at = NULL', [m.id ?? crypto.randomUUID(), m.org_id, m.principal_kind, m.principal_id, m.role, m.invited_by ?? null, m.created_at]);
  const grants: WorkspacePrincipalGrant[] = [], aps = [];
  for (const wsId of inv.workspace_ids) {
   const ws = s.workspaces.find((w) => w.workspace_id === wsId && w.org_id === org.id && isLive(w));
   if (!ws) continue;
   let g = s.workspaceGrants.find((x) => x.workspace_id === ws.workspace_id && isPrin(x, c.principal_kind, c.principal_id));
   if (g) { g.role = isLive(g) && roleRank(g.role) >= roleRank(inv.role) ? g.role : inv.role; g.granted_by = inv.invited_by; g.revoked_at = null; }
   else { g = { id: crypto.randomUUID(), workspace_id: ws.workspace_id, org_id: org.id, principal_kind: c.principal_kind, principal_id: c.principal_id, role: inv.role, granted_by: inv.invited_by, created_at: iso, revoked_at: null }; s.workspaceGrants.push(g); }
   execOrgSql(tx, 'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, revoked_at = NULL', [g.id ?? crypto.randomUUID(), g.workspace_id, g.org_id, g.principal_kind, g.principal_id, g.role, g.granted_by ?? null, g.created_at]);
   grants.push(g);
   if (c.principal_kind === 'agent') { const ap = upsertAgentPrincipalInWorkspace(s, ws.workspace_id, c.principal_id, tx); if (ap) aps.push(ap); }
  }
  return { ok: true as const, invite: inv, membership: m, workspace_grants: grants, agent_principals: aps };
 });
}
export function orgInviteRevoke(
 s: OrgAuthorityState, c: OrgCallerContext,
 input: { org_id: string; invite_id: string; require_approval?: boolean; now?: string },
 db?: OrgSqlExecutor,
) {
 return withOrgTx(s, db, (tx) => {
  const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: 'org_invite_revoke', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
  if (auth.status !== 'authorized') return auth.result;
  const inv = (s.orgInvites ?? []).find((x) => x.invite_id === input.invite_id && x.org_id === org.id && x.revoked_at == null);
  if (!inv) return fail('ORG_INVITE_NOT_FOUND', 'active_org_invite', { org: org.slug });
  inv.revoked_at = now;
  execOrgSql(tx, 'UPDATE swarm.org_invites SET revoked_at = $2 WHERE invite_id = $1 AND org_id = $3 AND revoked_at IS NULL', [inv.invite_id, now, org.id]);
  return { ok: true as const, status: 'executed' as const, invite: inv };
 });
}
export function orgConfirmAction(
 s: OrgAuthorityState, c: OrgCallerContext,
 input: { approval_id: string; decision?: 'approve' | 'reject'; approve?: boolean; now?: string },
 opts?: OrgCommandOptions,
) {
 return withOrgTx(s, opts?.db, (tx) => {
  const iso = opts?.testClockIso ?? new Date().toISOString(), ms = Date.parse(iso);
  if (c.principal_kind !== 'user') return fail('HUMAN_OWNER_CONFIRMATION_REQUIRED', 'human_owner_session', {});
  execOrgSql(tx, 'SELECT approval_id, state FROM swarm.org_approval_requests WHERE approval_id = $1 FOR UPDATE', [input.approval_id]);
  const appr = (s.approvalRequests ?? []).find((a) => a.approval_id === input.approval_id);
  if (!appr) return fail('APPROVAL_NOT_FOUND', 'approval_request', {});
  if (appr.state !== 'pending') return fail('APPROVAL_ALREADY_DECIDED', 'pending_approval_request', { org: appr.org_id });
  if (appr.expires_at != null && Date.parse(appr.expires_at) <= ms) {
   appr.state = 'expired'; appr.decided_at = iso;
   execOrgSql(tx, 'UPDATE swarm.org_approval_requests SET state = $2, decided_at = $3 WHERE approval_id = $1', [appr.approval_id, 'expired', iso]);
   return fail('APPROVAL_REQUEST_EXPIRED', 'unexpired_approval_request', { org: appr.org_id });
  }
  const org = findLiveOrg(s, appr.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: appr.org_id });
  const cR = orgRole(s, org.id, 'user', c.principal_id), minR: 'owner' | 'admin' = appr.action_kind === 'org_delete' || appr.action_kind === 'org_move_workspace' || appr.payload?.role === 'owner' ? 'owner' : 'admin';
  if (!cR || roleRank(cR) < roleRank(minR) || (c.principal_id !== appr.owner_user_id && roleRank(cR) < roleRank('admin'))) return fail('ORG_APPROVAL_ACCESS_DENIED', 'approval_owner_or_admin', { org: org.slug });
  if ((input.decision ?? (input.approve === false ? 'reject' : 'approve')) === 'reject') {
   appr.state = 'rejected'; appr.decided_by = c.principal_id; appr.decided_at = iso;
   execOrgSql(tx, 'UPDATE swarm.org_approval_requests SET state = $2, decided_by = $3, decided_at = $4 WHERE approval_id = $1 AND state = $5', [appr.approval_id, 'rejected', c.principal_id, iso, 'pending']);
   return { ok: true as const, approval: appr, executed: false as const, result: null };
  }
  const exec = ORG_ACTION_EXECUTORS[appr.action_kind];
  if (!exec) return fail('UNSUPPORTED_APPROVAL_ACTION', appr.action_kind, { org: org.slug });
  const res = exec(s, { principal_kind: 'user', principal_id: c.principal_id }, { ...appr.payload, now: iso, require_approval: false }, tx) as { ok?: boolean; refusal?: OrgChannelRefusal };
  if (!res?.ok) return (res as RefusalResult) ?? fail('APPROVAL_EXECUTION_FAILED', appr.action_kind, { org: org.slug });
  appr.state = 'approved'; appr.decided_by = c.principal_id; appr.decided_at = iso;
  (appr as { consumed_at?: string | null }).consumed_at = iso;
  execOrgSql(tx, 'UPDATE swarm.org_approval_requests SET state = $2, decided_by = $3, decided_at = $4 WHERE approval_id = $1 AND state = $5', [appr.approval_id, 'approved', c.principal_id, iso, 'pending']);
  return { ok: true as const, approval: appr, executed: true as const, result: res };
 });
}
registerOrgActionExecutor('org_invite_create', (s, c, p, db) => orgInviteCreate(s, c, p as Parameters<typeof orgInviteCreate>[2], db));
registerOrgActionExecutor('org_invite_revoke', (s, c, p, db) => orgInviteRevoke(s, c, p as Parameters<typeof orgInviteRevoke>[2], db));
export const org_invite_create = orgInviteCreate, org_invite_accept = orgInviteAccept, org_invite_revoke = orgInviteRevoke, org_confirm_action = orgConfirmAction;
