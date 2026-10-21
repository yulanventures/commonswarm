import { type CallerContext, type OrgMembershipRecord, type OrgRole, type PrincipalKind, canReadOrg, cascadeOrgMemberRemoval, fail, isLive, isPrin } from '../../../../src/protocol/org-channels-contract.js';
import { type OrgAuthorityState, type OrgSqlExecutor, authorizeOrgAction, execOrgSql, findLiveOrg, isValidOrgRole, registerOrgActionExecutor, syncLockedOrgRows, withOrgTx } from './invites.js';

export interface OrgRosterEntry {
 org_id: string; principal_kind: PrincipalKind; principal_id: string; display_name: string; role: OrgRole; owner_user_id: string | null;
 workspaces: Array<{ workspace_id: string; workspace_slug: string; workspace_name: string; role: OrgRole }>; active_seat_ids: string[]; created_at: string;
}

const isLastHumanOwner = (s: OrgAuthorityState, oId: string, pk: PrincipalKind, pid: string) =>
 !s.orgMemberships.some((m) => m.org_id === oId && m.principal_kind === 'user' && isLive(m) && m.role === 'owner' && !isPrin(m, pk, pid));

export function orgListMembers(s: OrgAuthorityState, c: CallerContext, input: { org_id: string; filter?: 'all' | 'user' | 'agent' | 'guest' }) {
 const org = findLiveOrg(s, input.org_id);
 if (!org || !canReadOrg(s, c, org.id)) return fail('ORG_ACCESS_DENIED', 'org_membership', { org: input.org_id });
 const orgWss = s.workspaces.filter((w) => w.org_id === org.id && isLive(w)), wsIds = new Set(orgWss.map((w) => w.workspace_id)), flt = input.filter ?? 'all';
 const members: OrgRosterEntry[] = s.orgMemberships
  .filter((m) => m.org_id === org.id && isLive(m) && (flt === 'user' ? m.principal_kind === 'user' : flt === 'agent' ? m.principal_kind === 'agent' : flt === 'guest' ? m.role === 'guest' : true))
  .map((m) => {
   const ai = m.principal_kind === 'agent' ? s.agentIdentities.find((a) => a.id === m.principal_id) : undefined;
   const workspaces = s.workspaceGrants.filter((g) => wsIds.has(g.workspace_id) && isPrin(g, m.principal_kind, m.principal_id) && isLive(g)).map((g) => {
    const w = orgWss.find((x) => x.workspace_id === g.workspace_id)!;
    return { workspace_id: w.workspace_id, workspace_slug: w.slug, workspace_name: w.name, role: g.role };
   });
   const apIds = new Set((s.agentPrincipals ?? []).filter((ap) => wsIds.has(ap.workspace_id) && isLive(ap) && (m.principal_kind === 'agent' ? ap.agent_identity_id === m.principal_id : ap.owner_user_id === m.principal_id)).map((ap) => ap.principal_id));
   const active_seat_ids = (s.seats ?? []).filter((st) => wsIds.has(st.workspace_id) && isLive(st) && (apIds.has(st.principal_id) || (m.principal_kind === 'agent' && st.agent_identity_id === m.principal_id))).map((st) => st.seat_id);
   return { org_id: org.id, principal_kind: m.principal_kind, principal_id: m.principal_id, display_name: ai?.display_name ?? m.principal_id, role: m.role, owner_user_id: ai?.owner_user_id ?? null, workspaces, active_seat_ids, created_at: m.created_at };
  });
 return { ok: true as const, org_id: org.id, org_slug: org.slug, members };
}

export function orgSetMemberRole(s: OrgAuthorityState, c: CallerContext, input: { org_id: string; principal_kind: PrincipalKind; principal_id: string; role: OrgRole; require_approval?: boolean; approval_id?: string; now?: string }, db?: OrgSqlExecutor) {
 return withOrgTx(s, db, (tx) => {
  const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  if (!isValidOrgRole(input.role)) return fail('INVALID_ORG_ROLE', 'valid_org_role', { org: org.slug });
  if (input.principal_kind !== 'user' && input.principal_kind !== 'agent') return fail('INVALID_PRINCIPAL_KIND', 'user_or_agent_principal', { org: org.slug });
  if (input.principal_kind === 'agent' && !s.agentIdentities.some((a) => a.id === input.principal_id && isLive(a))) return fail('AGENT_IDENTITY_NOT_FOUND', 'live_agent_identity', { org: org.slug });
  syncLockedOrgRows(s, org.id, tx);
  if (!isLive(org)) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const ex = s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, input.principal_kind, input.principal_id)), exR = ex && isLive(ex) ? ex.role : null, wasO = exR === 'owner';
  const auth = authorizeOrgAction(s, c, { org, min_role: input.role === 'owner' || wasO ? 'owner' : 'admin', action_kind: 'org_set_member_role', payload: { ...input }, existing_target_role: exR, require_approval: input.require_approval, now, db: tx });
  if (auth.status !== 'authorized') return auth.result;
  if (wasO && input.role !== 'owner' && isLastHumanOwner(s, org.id, input.principal_kind, input.principal_id)) return fail('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_human_org_owner', { org: org.slug });
  const m: OrgMembershipRecord = ex ?? { id: crypto.randomUUID(), org_id: org.id, principal_kind: input.principal_kind, principal_id: input.principal_id, role: input.role, invited_by: auth.actor_user_id, created_at: now, revoked_at: null };
  if (ex) { ex.role = input.role; ex.invited_by = auth.actor_user_id; ex.revoked_at = null; } else s.orgMemberships.push(m);
  execOrgSql(tx, 'INSERT INTO swarm.org_memberships (id,org_id,principal_kind,principal_id,role,invited_by,created_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL) ON CONFLICT (org_id,principal_kind,principal_id) DO UPDATE SET role=EXCLUDED.role,invited_by=EXCLUDED.invited_by,revoked_at=NULL', [m.id ?? crypto.randomUUID(), org.id, m.principal_kind, m.principal_id, m.role, m.invited_by ?? null, m.created_at]);
  return { ok: true as const, status: 'executed' as const, membership: m };
 });
}

export function orgRemoveMember(s: OrgAuthorityState, c: CallerContext, input: { org_id: string; principal_kind: PrincipalKind; principal_id: string; require_approval?: boolean; approval_id?: string; now?: string }, db?: OrgSqlExecutor) {
 return withOrgTx(s, db, (tx) => {
  const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id), { principal_kind: pk, principal_id: pid } = input;
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const wsIds = s.workspaces.filter((w) => w.org_id === org.id).map((w) => w.workspace_id);
  syncLockedOrgRows(s, org.id, tx);
  for (const [t, k, p] of [['workspaces', 'workspace_id', 'org_id=$1'], ['workspace_principal_grants', 'id', 'org_id=$1'], ['channel_memberships', 'id', 'workspace_id=ANY($1::uuid[])'], ['agent_principals', 'principal_id', 'workspace_id=ANY($1::uuid[])'], ['hosted_mcp_seats', 'seat_id', 'workspace_id=ANY($1::uuid[])']] as const) {
   execOrgSql(tx, `SELECT ${k} FROM swarm.${t} WHERE ${p} ORDER BY ${k} FOR UPDATE`, [p.includes('ANY') ? wsIds : org.id]);
  }
  if (!isLive(org)) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const ex = s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pk, pid)), exR = ex && isLive(ex) ? ex.role : null, wasO = exR === 'owner';
  if (!(c.principal_kind === 'user' && !input.require_approval && isPrin(c, pk, pid) && canReadOrg(s, c, org.id))) {
   const auth = authorizeOrgAction(s, c, { org, min_role: wasO ? 'owner' : 'admin', action_kind: 'org_remove_member', payload: { ...input }, existing_target_role: exR, require_approval: input.require_approval, now, db: tx });
   if (auth.status !== 'authorized') return auth.result;
  }
  if (wasO && isLastHumanOwner(s, org.id, pk, pid)) return fail('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_human_org_owner', { org: org.slug });
  if (!ex) s.orgMemberships.push({ id: crypto.randomUUID(), org_id: org.id, principal_kind: pk, principal_id: pid, role: 'member', created_at: now, revoked_at: now });
  const cas = cascadeOrgMemberRemoval(s, { org_id: org.id, principal_kind: pk, principal_id: pid, now });
  execOrgSql(tx, 'INSERT INTO swarm.org_memberships (id,org_id,principal_kind,principal_id,role,created_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id,principal_kind,principal_id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at', [ex?.id ?? crypto.randomUUID(), org.id, pk, pid, ex?.role ?? 'member', ex?.created_at ?? now, now]);
  execOrgSql(tx, 'UPDATE swarm.workspace_principal_grants SET revoked_at=$4 WHERE org_id=$1 AND principal_kind=$2 AND principal_id=$3 AND revoked_at IS NULL', [org.id, pk, pid, now]);
  if (pk === 'user') execOrgSql(tx, 'UPDATE swarm.memberships SET revoked_at=$3 WHERE workspace_id=ANY($1::uuid[]) AND user_id=$2 AND revoked_at IS NULL', [wsIds, pid, now]);
  execOrgSql(tx, 'UPDATE swarm.channel_memberships SET revoked_at=$4 WHERE workspace_id=ANY($1::uuid[]) AND principal_kind=$2 AND principal_id=$3 AND revoked_at IS NULL', [wsIds, pk, pid, now]);
  execOrgSql(tx, 'UPDATE swarm.agent_principals SET revoked_at=$3 WHERE workspace_id=ANY($1::uuid[]) AND (agent_identity_id=$2 OR owner_user_id=$2) AND revoked_at IS NULL', [wsIds, pid, now]);
  execOrgSql(tx, 'UPDATE swarm.hosted_mcp_seats SET revoked_at=$2 WHERE seat_id=ANY($1::uuid[]) AND revoked_at IS NULL', [cas.closed_seat_ids, now]);
  execOrgSql(tx, 'UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=$2 WHERE handle_id=ANY($1::uuid[]) AND revoked_at IS NULL', [cas.closed_handle_ids, now]);
  return { ok: true as const, status: 'executed' as const, org_id: org.id, principal_kind: pk, principal_id: pid, closed_seat_ids: cas.closed_seat_ids, closed_handle_ids: cas.closed_handle_ids };
 });
}

const ZZ = Array.from(Buffer.from('AAEIEAkCAwoRGCAZEgsEBQwTGiEoMCkiGxQNBgcOFRwjKjE4OTIrJB0WDxceJSwzOjs0LSYfJy41PD02Lzc+Pw==', 'base64'));
const DC_N = [0,0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0], DC_V = [0,1,2,3,4,5,6,7,8,9,10,11], AC_N = [0,0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,125];
const AC_V = Array.from(Buffer.from('AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6', 'base64'));
const CT = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (__, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u ? 1 : Math.SQRT1_2)));

function hDec(nrc: readonly number[], vs: readonly number[]) {
 const m = new Map<number, number>(); let c = 0, k = 0;
 for (let l = 1; l <= 16; l++) { for (let i = 0; i < (nrc[l] ?? 0); i++) m.set((l << 16) | c++, vs[k++] ?? 0); c <<= 1; }
 return m;
}
function hEnc(nrc: readonly number[], vs: readonly number[]) {
 const m = new Map<number, [number, number]>(); let c = 0, k = 0;
 for (let l = 1; l <= 16; l++) { for (let i = 0; i < (nrc[l] ?? 0); i++) m.set(vs[k++]!, [c++, l]); c <<= 1; }
 return m;
}

export function decodeJpeg(raw: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
 const n = raw.byteLength;
 if (n < 20 || raw[0] !== 0xff || raw[1] !== 0xd8 || raw[n - 2] !== 0xff || raw[n - 1] !== 0xd9) return null;
 const qts = [new Int32Array(64).fill(16), new Int32Array(64).fill(16)], dcH = [hDec(DC_N, DC_V), hDec(DC_N, DC_V)], acH = [hDec(AC_N, AC_V), hDec(AC_N, AC_V)];
 let w = 0, h = 0, nc = 0, sos = 0, p = 2;
 const cQt = [0, 0, 0], cDc = [0, 0, 0], cAc = [0, 0, 0];
 while (p + 4 <= n) {
  if (raw[p] !== 0xff) return null;
  while (p < n && raw[p] === 0xff) p++;
  const mk = raw[p++]!; if (mk === 0xd9) break; if (!mk || (mk >= 0xd0 && mk <= 0xd7)) continue;
  const len = (raw[p]! << 8) | raw[p + 1]!; if (len < 2 || p + len > n) return null;
  if (mk === 0xdb) {
   for (let q = p + 2; q + 65 <= p + len; q += 65) {
    const id = raw[q]!; if (id >> 4) return null;
    const t = new Int32Array(64); for (let i = 0; i < 64; i++) t[ZZ[i]!] = raw[q + 1 + i]!; qts[id & 15] = t;
   }
  } else if (mk === 0xc0) {
   h = (raw[p + 3]! << 8) | raw[p + 4]!; w = (raw[p + 5]! << 8) | raw[p + 6]!; nc = raw[p + 7]!;
   if (raw[p + 2] !== 8 || w < 1 || w > 2048 || h < 1 || h > 2048 || (nc !== 1 && nc !== 3) || len < 8 + nc * 3) return null;
   for (let c = 0; c < nc; c++) { if (raw[p + 9 + c * 3] !== 0x11) return null; cQt[c] = raw[p + 10 + c * 3]!; }
  } else if (mk === 0xc4) {
   for (let q = p + 2; q + 17 <= p + len; ) {
    const info = raw[q++]!, nrc = [0]; let tot = 0;
    for (let i = 0; i < 16; i++) { const c = raw[q++]!; nrc.push(c); tot += c; }
    if (q + tot > p + len) return null;
    const vs = Array.from(raw.subarray(q, q + tot)); q += tot;
    if (info >> 4) acH[info & 15] = hDec(nrc, vs); else dcH[info & 15] = hDec(nrc, vs);
   }
  } else if (mk === 0xda) {
   if (!w || !h || len < 6 + nc * 2) return null;
   for (let c = 0; c < nc; c++) { const b = raw[p + 4 + c * 2]!; cDc[c] = b >> 4; cAc[c] = b & 15; }
   sos = p + len; break;
  }
  p += len;
 }
 if (!w || !h || !sos) return null;
 let bp = sos, bb = 0, bc = 0;
 const bit = (): number => {
  if (!bc) { if (bp >= n - 2) return -1; const b = raw[bp++]!; if (b === 0xff && raw[bp++] !== 0) return -1; bb = b; bc = 8; }
  return (bb >> --bc) & 1;
 };
 const bits = (k: number) => { let v = 0; for (let i = 0; i < k; i++) { const b = bit(); if (b < 0) return -1; v = (v << 1) | b; } return v; };
 const sym = (t: Map<number, number>) => { let c = 0; for (let l = 1; l <= 16; l++) { const b = bit(); if (b < 0) return -1; c = (c << 1) | b; const s = t.get((l << 16) | c); if (s !== undefined) return s; } return -1; };
 const ext = (v: number, t: number) => (!t ? 0 : v < 1 << (t - 1) ? v - ((1 << t) - 1) : v), clp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
 const dcP = [0, 0, 0], rgba = new Uint8Array(w * h * 4), pl = [new Float64Array(64), new Float64Array(64), new Float64Array(64)], cf = new Int32Array(64);
 for (let my = 0; my < Math.ceil(h / 8); my++) for (let mx = 0; mx < Math.ceil(w / 8); mx++) {
  for (let c = 0; c < nc; c++) {
   cf.fill(0);
   const s0 = sym(dcH[cDc[c]!] ?? dcH[0]!); if (s0 < 0 || s0 > 11) return null;
   const db = s0 ? bits(s0) : 0; if (db < 0) return null;
   dcP[c]! += ext(db, s0); const qt = qts[cQt[c]!] ?? qts[0]!; cf[0] = dcP[c]! * qt[0]!;
   for (let k = 1; k < 64; ) {
    const rs = sym(acH[cAc[c]!] ?? acH[0]!); if (rs < 0) return null; if (!rs) break;
    k += rs >> 4; const s = rs & 15; if (k >= 64) return null;
    if (s > 0) { const ab = bits(s); if (ab < 0) return null; cf[ZZ[k]!] = ext(ab, s) * qt[ZZ[k]!]!; }
    k++;
   }
   for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let sum = 0; for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) sum += cf[v * 8 + u]! * CT[u]![x]! * CT[v]![y]!;
    pl[c]![y * 8 + x] = sum * 0.25 + 128;
   }
  }
  for (let y = 0; y < 8; y++) {
   const py = my * 8 + y; if (py >= h) continue;
   for (let x = 0; x < 8; x++) {
    const px = mx * 8 + x; if (px >= w) continue;
    const Y = pl[0]![y * 8 + x]!, Cb = nc === 3 ? pl[1]![y * 8 + x]! - 128 : 0, Cr = nc === 3 ? pl[2]![y * 8 + x]! - 128 : 0, di = (py * w + px) * 4;
    rgba[di] = clp(Y + 1.402 * Cr); rgba[di + 1] = clp(Y - 0.344136 * Cb - 0.714136 * Cr); rgba[di + 2] = clp(Y + 1.772 * Cb); rgba[di + 3] = 255;
   }
  }
 }
 return { width: w, height: h, rgba };
}

export function encodeJpeg(rgba: Uint8Array, sz: number): Uint8Array {
 const dcE = hEnc(DC_N, DC_V), acE = hEnc(AC_N, AC_V), out: number[] = [0xff, 0xd8, 0xff, 0xdb, 0, 67, 0, ...new Array(64).fill(16)];
 out.push(0xff, 0xc0, 0, 17, 8, sz >> 8, sz & 255, sz >> 8, sz & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0);
 for (const [id, nrc, vs] of [[0, DC_N, DC_V], [0x10, AC_N, AC_V]] as const) { const l = 19 + vs.length; out.push(0xff, 0xc4, l >> 8, l & 255, id, ...nrc.slice(1, 17), ...vs); }
 out.push(0xff, 0xda, 0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 0);
 let bb = 0, bc = 0;
 const put = (c: number, l: number) => { for (let i = l - 1; i >= 0; i--) { bb = (bb << 1) | ((c >> i) & 1); if (++bc === 8) { out.push(bb); if (bb === 0xff) out.push(0); bb = 0; bc = 0; } } };
 const mag = (v: number): [number, number] => { if (!v) return [0, 0]; const s = 32 - Math.clz32(Math.abs(v)); return [s, v > 0 ? v : (1 << s) - 1 + v]; };
 const dcP = [0, 0, 0], blk = [new Float64Array(64), new Float64Array(64), new Float64Array(64)], zz = new Int32Array(64);
 for (let my = 0; my < sz; my += 8) for (let mx = 0; mx < sz; mx += 8) {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
   const i = ((my + y) * sz + mx + x) * 4, r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
   blk[0]![y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128; blk[1]![y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b; blk[2]![y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  for (let c = 0; c < 3; c++) {
   const p = blk[c]!;
   for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let s = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += p[y * 8 + x]! * CT[u]![x]! * CT[v]![y]!;
    zz[ZZ.indexOf(v * 8 + u)] = Math.max(-1023, Math.min(1023, Math.round((s * 0.25) / 16)));
   }
   const [ds, db] = mag(zz[0]! - dcP[c]!); dcP[c] = zz[0]!;
   const [dc, dl] = dcE.get(ds)!; put(dc, dl); if (ds) put(db, ds);
   let run = 0;
   for (let k = 1; k < 64; k++) {
    const val = zz[k]!; if (!val) { run++; continue; }
    while (run >= 16) { const [zc, zl] = acE.get(0xf0)!; put(zc, zl); run -= 16; }
    const [as, ab] = mag(val), [ac, al] = acE.get((run << 4) | as)!; put(ac, al); put(ab, as); run = 0;
   }
   if (run) { const [ec, el] = acE.get(0)!; put(ec, el); }
  }
 }
 if (bc) put((1 << (8 - bc)) - 1, 8 - bc);
 out.push(0xff, 0xd9); return new Uint8Array(out);
}

registerOrgActionExecutor('org_set_member_role', (s, c, p, db) => orgSetMemberRole(s, c, p as Parameters<typeof orgSetMemberRole>[2], db));
registerOrgActionExecutor('org_remove_member', (s, c, p, db) => orgRemoveMember(s, c, p as Parameters<typeof orgRemoveMember>[2], db));
export const org_list_members = orgListMembers, org_set_member_role = orgSetMemberRole, org_remove_member = orgRemoveMember;
