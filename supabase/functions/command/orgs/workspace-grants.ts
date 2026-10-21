import {
  type CallerContext, type OrgRole, type PrincipalKind, type WorkspacePrincipalGrant,
  agentOwner, canReadOrg, canReadWorkspace, cascadeWorkspaceMemberRemoval,
  fail, isLive, isPrin, orgRole,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState, type OrgSqlExecutor, type OrgSqlQueryResult,
  authorizeOrgAction, effectiveCallerOrgRole, execOrgSql, isValidOrgRole,
  registerOrgActionExecutor, resolveWorkspaceSelector, syncLockedOrgRows,
  upsertAgentPrincipalInWorkspace, withOrgTx,
} from './invites.js';

const UP_GRANT_SQL = 'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, revoked_at = NULL';

export function syncLockedWorkspaceRows(s: OrgAuthorityState, wsId: string, tx?: OrgSqlExecutor) {
  execOrgSql(tx, 'SELECT workspace_id, org_id FROM swarm.workspaces WHERE workspace_id = $1 FOR UPDATE', [wsId]);
  const gR = execOrgSql(tx, 'SELECT id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at FROM swarm.workspace_principal_grants WHERE workspace_id = $1 ORDER BY id FOR UPDATE', [wsId]) as OrgSqlQueryResult<Partial<WorkspacePrincipalGrant>> | undefined;
  for (const r of gR?.rows ?? []) {
    if (!r.principal_kind || !r.principal_id || !r.role) continue;
    const ex = s.workspaceGrants.find((g) => g.workspace_id === wsId && isPrin(g, r.principal_kind!, r.principal_id!));
    if (ex) Object.assign(ex, r);
  }
}

function lockWsCascades(tx: OrgSqlExecutor | undefined, wsId: string) {
  for (const [t, k] of [['channel_memberships', 'id'], ['agent_principals', 'principal_id'], ['hosted_mcp_seats', 'seat_id']] as const) {
    execOrgSql(tx, `SELECT ${k} FROM swarm.${t} WHERE workspace_id = $1 ORDER BY ${k} FOR UPDATE`, [wsId]);
  }
}

function revokeWsMember(
  s: OrgAuthorityState, tx: OrgSqlExecutor | undefined, wsId: string, orgId: string,
  pk: PrincipalKind, pid: string, ex: WorkspacePrincipalGrant | undefined, now: string,
) {
  if (!ex) s.workspaceGrants.push({ id: crypto.randomUUID(), workspace_id: wsId, org_id: orgId, principal_kind: pk, principal_id: pid, role: 'member', created_at: now, revoked_at: now });
  const cas = cascadeWorkspaceMemberRemoval(s, { workspace_id: wsId, principal_kind: pk, principal_id: pid, now });
  execOrgSql(tx, 'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at', [ex?.id ?? crypto.randomUUID(), wsId, orgId, pk, pid, ex?.role ?? 'member', ex?.created_at ?? now, now]);
  if (pk === 'user') execOrgSql(tx, 'UPDATE swarm.memberships SET revoked_at = $3 WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL', [wsId, pid, now]);
  execOrgSql(tx, 'UPDATE swarm.channel_memberships SET revoked_at = $4 WHERE workspace_id = $1 AND principal_kind = $2 AND principal_id = $3 AND revoked_at IS NULL', [wsId, pk, pid, now]);
  execOrgSql(tx, 'UPDATE swarm.agent_principals SET revoked_at = $3 WHERE workspace_id = $1 AND (agent_identity_id = $2 OR owner_user_id = $2) AND revoked_at IS NULL', [wsId, pid, now]);
  execOrgSql(tx, 'UPDATE swarm.hosted_mcp_seats SET revoked_at = $2 WHERE seat_id = ANY($1::uuid[]) AND revoked_at IS NULL', [cas.closed_seat_ids, now]);
  execOrgSql(tx, 'UPDATE swarm.hosted_mcp_seat_handles SET revoked_at = $2 WHERE handle_id = ANY($1::uuid[]) AND revoked_at IS NULL', [cas.closed_handle_ids, now]);
  return cas;
}

export function orgAssignWorkspaceMember(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id?: string; workspace_id: string; principal_kind: PrincipalKind; principal_id: string; role?: OrgRole; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), wsRes = resolveWorkspaceSelector(s, c, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;
    syncLockedOrgRows(s, org.id, tx); syncLockedWorkspaceRows(s, ws.workspace_id, tx);
    if (!isLive(org) || !isLive(ws)) return fail('WORKSPACE_NOT_FOUND', 'workspace', { org: org.slug, workspace: ws.slug });

    const tRole = orgRole(s, org.id, input.principal_kind, input.principal_id);
    if (input.principal_kind === 'user') {
      if (!tRole) return fail('TARGET_NOT_IN_ORG', 'org_membership', { org: org.slug, workspace: ws.slug });
    } else {
      const ai = s.agentIdentities.find((a) => a.id === input.principal_id && isLive(a));
      if (!ai) return fail('AGENT_IDENTITY_NOT_FOUND', 'live_agent_identity', { org: org.slug, workspace: ws.slug });
      const rev = s.orgMemberships.some((m) => m.org_id === org.id && isPrin(m, 'agent', input.principal_id) && m.revoked_at != null);
      const oRole = orgRole(s, org.id, 'user', ai.owner_user_id);
      if (rev || (!tRole && (!oRole || oRole === 'guest'))) return fail('TARGET_NOT_IN_ORG', 'agent_org_membership', { org: org.slug, workspace: ws.slug });
    }
    const gRole: OrgRole = input.role ?? tRole ?? 'member';
    if (!isValidOrgRole(gRole)) return fail('INVALID_ORG_ROLE', 'valid_org_role', { org: org.slug, workspace: ws.slug });
    const auth = authorizeOrgAction(s, c, { org, workspace_slug: ws.slug, workspace_id: ws.workspace_id, min_role: gRole === 'owner' ? 'owner' : 'admin', action_kind: 'org_assign_workspace_member', payload: { ...input, role: gRole }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;

    let g = s.workspaceGrants.find((x) => x.workspace_id === ws.workspace_id && isPrin(x, input.principal_kind, input.principal_id));
    if (g) { g.org_id = org.id; g.role = gRole; g.granted_by = auth.actor_user_id; g.revoked_at = null; }
    else { g = { id: crypto.randomUUID(), workspace_id: ws.workspace_id, org_id: org.id, principal_kind: input.principal_kind, principal_id: input.principal_id, role: gRole, granted_by: auth.actor_user_id, created_at: now, revoked_at: null }; s.workspaceGrants.push(g); }
    execOrgSql(tx, UP_GRANT_SQL, [g.id ?? crypto.randomUUID(), ws.workspace_id, org.id, input.principal_kind, input.principal_id, gRole, auth.actor_user_id, g.created_at]);
    const ap = input.principal_kind === 'agent' ? upsertAgentPrincipalInWorkspace(s, ws.workspace_id, input.principal_id, tx) : null;
    return { ok: true as const, status: 'executed' as const, grant: g, agent_principal: ap };
  });
}

export function orgRemoveWorkspaceMember(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id?: string; workspace_id: string; principal_kind: PrincipalKind; principal_id: string; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), wsRes = resolveWorkspaceSelector(s, c, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;
    syncLockedOrgRows(s, org.id, tx); syncLockedWorkspaceRows(s, ws.workspace_id, tx); lockWsCascades(tx, ws.workspace_id);
    const ex = s.workspaceGrants.find((g) => g.workspace_id === ws.workspace_id && isPrin(g, input.principal_kind, input.principal_id));
    const exRole = ex && isLive(ex) ? ex.role : null, wasOwner = exRole === 'owner';
    const auth = authorizeOrgAction(s, c, { org, workspace_slug: ws.slug, workspace_id: ws.workspace_id, min_role: wasOwner ? 'owner' : 'admin', action_kind: 'org_remove_workspace_member', payload: { ...input }, existing_target_role: exRole, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;
    if (wasOwner && input.principal_kind === 'user' && !s.workspaceGrants.some((g) => g.workspace_id === ws.workspace_id && g.principal_kind === 'user' && isLive(g) && g.role === 'owner' && !isPrin(g, input.principal_kind, input.principal_id))) {
      return fail('CANNOT_REMOVE_LAST_WORKSPACE_OWNER', 'another_workspace_owner', { org: org.slug, workspace: ws.slug });
    }
    const cas = revokeWsMember(s, tx, ws.workspace_id, org.id, input.principal_kind, input.principal_id, ex, now);
    return { ok: true as const, status: 'executed' as const, workspace_id: ws.workspace_id, principal_kind: input.principal_kind, principal_id: input.principal_id, closed_seat_ids: cas.closed_seat_ids, closed_handle_ids: cas.closed_handle_ids };
  });
}

export function workspaceJoin(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id?: string; workspace_id: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), wsRes = resolveWorkspaceSelector(s, c, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;
    syncLockedOrgRows(s, org.id, tx); syncLockedWorkspaceRows(s, ws.workspace_id, tx);
    if (!canReadOrg(s, c, org.id)) return fail('ORG_ACCESS_DENIED', 'org_membership', { org: org.slug, workspace: ws.slug });
    const eff = effectiveCallerOrgRole(s, c, org.id);
    if (!eff || eff === 'guest') return fail('GUEST_CANNOT_SELF_JOIN_WORKSPACE', 'explicit_workspace_grant', { org: org.slug, workspace: ws.slug });
    const byUser = c.principal_kind === 'user' ? c.principal_id : agentOwner(s, c);
    if (!byUser) return fail('ORG_ACCESS_DENIED', 'authenticated_owner', { org: org.slug, workspace: ws.slug });
    const ex = s.workspaceGrants.find((g) => g.workspace_id === ws.workspace_id && isPrin(g, c.principal_kind, c.principal_id));
    if (ex && ex.revoked_at != null) return fail('WORKSPACE_ACCESS_REVOKED', 'explicit_workspace_regrant', { org: org.slug, workspace: ws.slug });
    const g: WorkspacePrincipalGrant = ex ?? { id: crypto.randomUUID(), workspace_id: ws.workspace_id, org_id: org.id, principal_kind: c.principal_kind, principal_id: c.principal_id, role: eff, granted_by: byUser, created_at: now, revoked_at: null };
    if (!ex) s.workspaceGrants.push(g);
    execOrgSql(tx, UP_GRANT_SQL, [g.id ?? crypto.randomUUID(), ws.workspace_id, org.id, c.principal_kind, c.principal_id, g.role, g.granted_by ?? byUser, g.created_at]);
    const ap = c.principal_kind === 'agent' ? upsertAgentPrincipalInWorkspace(s, ws.workspace_id, c.principal_id, tx) : null;
    return { ok: true as const, grant: g, agent_principal: ap };
  });
}

export function workspaceLeave(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id?: string; workspace_id: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), wsRes = resolveWorkspaceSelector(s, c, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;
    syncLockedOrgRows(s, org.id, tx); syncLockedWorkspaceRows(s, ws.workspace_id, tx); lockWsCascades(tx, ws.workspace_id);
    if (!canReadWorkspace(s, c, ws.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', { org: org.slug, workspace: ws.slug });
    const ex = s.workspaceGrants.find((g) => g.workspace_id === ws.workspace_id && isPrin(g, c.principal_kind, c.principal_id));
    if (ex && isLive(ex) && ex.role === 'owner' && !s.workspaceGrants.some((g) => g.workspace_id === ws.workspace_id && g.principal_kind === 'user' && isLive(g) && g.role === 'owner' && !isPrin(g, c.principal_kind, c.principal_id))) {
      return fail('CANNOT_REMOVE_LAST_WORKSPACE_OWNER', 'another_workspace_owner', { org: org.slug, workspace: ws.slug });
    }
    const cas = revokeWsMember(s, tx, ws.workspace_id, org.id, c.principal_kind, c.principal_id, ex, now);
    return { ok: true as const, workspace_id: ws.workspace_id, closed_seat_ids: cas.closed_seat_ids, closed_handle_ids: cas.closed_handle_ids };
  });
}

export function workspaceListMembers(s: OrgAuthorityState, c: CallerContext, input: { org_id?: string; workspace_id: string }) {
  const wsRes = resolveWorkspaceSelector(s, c, input.workspace_id, input.org_id);
  if (!wsRes.ok) return wsRes.refusal.code === 'AMBIGUOUS_WORKSPACE_SELECTOR' ? wsRes : fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', { org: input.org_id ?? null, workspace: input.workspace_id });
  const { workspace: ws, org } = wsRes;
  if (!canReadWorkspace(s, c, ws.workspace_id)) return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', { org: org.slug, workspace: ws.slug });
  const members = s.workspaceGrants.filter((g) => g.workspace_id === ws.workspace_id && isLive(g)).map((g) => {
    const ai = g.principal_kind === 'agent' ? s.agentIdentities.find((a) => a.id === g.principal_id) : undefined;
    const ap = g.principal_kind === 'agent' ? (s.agentPrincipals ?? []).find((p) => p.workspace_id === ws.workspace_id && p.agent_identity_id === g.principal_id && isLive(p)) : undefined;
    const active_seat_ids = (s.seats ?? []).filter((st) => st.workspace_id === ws.workspace_id && isLive(st) && ((ap && st.principal_id === ap.principal_id) || (g.principal_kind === 'agent' && st.agent_identity_id === g.principal_id))).map((st) => st.seat_id);
    return { workspace_id: ws.workspace_id, org_id: org.id, principal_kind: g.principal_kind, principal_id: g.principal_id, display_name: ai?.display_name ?? g.principal_id, role: g.role, org_role: orgRole(s, org.id, g.principal_kind, g.principal_id), agent_principal_id: ap?.principal_id ?? null, active_seat_ids };
  });
  return { ok: true as const, org_id: org.id, workspace_id: ws.workspace_id, members };
}

export const CLO = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
function vp8lTree(lens: readonly number[]): Map<number, number> | null {
  const cnt = new Int32Array(16), nxt = new Int32Array(16), t = new Map<number, number>();
  let nz = 0, single = 0;
  for (let i = 0; i < lens.length; i++) { const l = lens[i]!; if (l > 15) return null; if (l > 0) { cnt[l]!++; nz++; single = i; } }
  if (!nz) return null; if (nz === 1) { t.set(0, single); return t; }
  for (let b = 1, c = 0; b <= 15; b++) { c = (c + cnt[b - 1]!) << 1; nxt[b] = c; }
  for (let s = 0; s < lens.length; s++) {
    const l = lens[s]!; if (!l) continue;
    const c = nxt[l]!++; let rv = 0; for (let i = 0; i < l; i++) rv = (rv << 1) | ((c >> i) & 1);
    t.set((l << 16) | rv, s);
  }
  return t;
}

export function decodeWebp(raw: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  const n = raw.byteLength; if (n < 25) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, n);
  if (dv.getUint32(0) !== 0x52494646 || dv.getUint32(4, true) + 8 > n || dv.getUint32(8) !== 0x57454250 || dv.getUint32(12) !== 0x5650384c) return null;
  const cLen = dv.getUint32(16, true); if (20 + cLen > n || raw[20] !== 0x2f) return null;
  const ch = raw.subarray(20, 20 + cLen); let bp = 8;
  const rb = (k: number) => {
    if (bp + k > ch.byteLength * 8) return -1;
    let v = 0; for (let i = 0; i < k; i++) v |= ((ch[(bp + i) >> 3]! >> ((bp + i) & 7)) & 1) << i;
    bp += k; return v;
  };
  const w = rb(14) + 1, h = rb(14) + 1, _a = rb(1), ver = rb(3);
  if (w < 1 || w > 2048 || h < 1 || h > 2048 || ver || rb(1) || rb(1) || rb(1)) return null;
  const decS = (t: Map<number, number>) => {
    if (t.has(0)) return t.get(0)!;
    let c = 0; for (let l = 1; l <= 15; l++) { const b = rb(1); if (b < 0) return -1; c |= b << (l - 1); const s = t.get((l << 16) | c); if (s !== undefined) return s; }
    return -1;
  };
  const rdTree = (asz: number): Map<number, number> | null => {
    const smp = rb(1); if (smp < 0) return null;
    if (smp) {
      const ns = rb(1) + 1, f8 = rb(1), s0 = rb(f8 ? 8 : 1); if (s0 < 0 || s0 >= asz) return null;
      if (ns === 1) return new Map([[0, s0]]);
      const s1 = rb(8); return s1 < 0 || s1 >= asz ? null : new Map([[(1 << 16) | 0, s0], [(1 << 16) | 1, s1]]);
    }
    const ncl = rb(4) + 4, clL = new Int32Array(19);
    for (let i = 0; i < ncl; i++) { const v = rb(3); if (v < 0) return null; clL[CLO[i]!] = v; }
    const clT = vp8lTree(clL); if (!clT || rb(1)) return null;
    const sL = new Int32Array(asz); let prev = 8;
    for (let s = 0; s < asz; ) {
      const c = decS(clT); if (c < 0) return null;
      if (c < 16) { sL[s++] = c; if (c) prev = c; }
      else if (c === 16) { const r = rb(2) + 3; for (let k = 0; k < r && s < asz; k++) sL[s++] = prev; }
      else if (c === 17) s += rb(3) + 3; else s += rb(7) + 11;
    }
    return vp8lTree(sL);
  };
  const ts = [rdTree(280), rdTree(256), rdTree(256), rdTree(256), rdTree(40)];
  if (ts.some((t) => !t)) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const g = decS(ts[0]!), r = decS(ts[1]!), b = decS(ts[2]!), a = decS(ts[3]!);
    if (g < 0 || g > 255 || r < 0 || b < 0 || a < 0) return null;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width: w, height: h, rgba };
}

registerOrgActionExecutor('org_assign_workspace_member', (s, c, p, db) => orgAssignWorkspaceMember(s, c, p as Parameters<typeof orgAssignWorkspaceMember>[2], db));
registerOrgActionExecutor('org_remove_workspace_member', (s, c, p, db) => orgRemoveWorkspaceMember(s, c, p as Parameters<typeof orgRemoveWorkspaceMember>[2], db));

export const org_assign_workspace_member = orgAssignWorkspaceMember;
export const org_remove_workspace_member = orgRemoveWorkspaceMember;
export const workspace_join = workspaceJoin;
export const workspace_leave = workspaceLeave;
export const workspace_list_members = workspaceListMembers;
