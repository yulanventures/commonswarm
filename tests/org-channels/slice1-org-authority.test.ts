import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 CANONICAL_ORG_CHANNEL_LOCK_ORDER as LOCK_ORDER, type OrgAuthorityState, type OrgRole, type OrgSqlExecutor, type PrincipalKind,
 canReadOrg as cro, createStatefulOrgSqlExecutor as mkDb, decodeRasterLogo as decLogo, dispatchOrgCommand as dispatch,
 handleHostedOrgCommandRequest as hReq, loadOrgAuthorityStateFromDb as loadDb, orgAssignWorkspaceMember as assignWs,
 orgConfirmAction as confirm, orgCreate, orgDelete, orgInviteAccept as invAccept,
 orgInviteCreate as invCreate, orgInviteRevoke as invRevoke, orgList, orgListMembers as listMem,
 orgLogoFinalize as finLogo, orgLogoRemove as remLogo, orgLogoUploadPrepare as prepLogo,
 orgMoveWorkspace as moveWs, orgRemoveMember as remMem, orgRemoveWorkspaceMember as remWs,
 orgSetMemberRole as setRole, orgUpdate, readLogoDimensions as dims, resizeRasterRendition as rsz,
 workspaceJoin as wsJoin, workspaceLeave as wsLeave, workspaceListMembers as wsList,
} from '../../supabase/functions/command/orgs/index.js';
const NOW = '2026-10-21T00:00:00Z', eq = assert.equal, deq = assert.deepEqual, mt = assert.match;
const URE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pu = (id: string) => ({ principal_kind: 'user' as const, principal_id: id });
const pa = (id: string) => ({ principal_kind: 'agent' as const, principal_id: id });
const usr = (id: string, e?: string) => ({ ...pu(id), ...(e ? { authenticated_email: e } : {}) });
const org = (id: string, slug: string, display_name = slug) => ({ id, slug, display_name, created_by: 'u-owner', created_at: NOW, updated_at: NOW });
const ws = (workspace_id: string, org_id: string, slug: string, name = slug) => ({ workspace_id, org_id, slug, name });
const om = (o: string, k: PrincipalKind, p: string, r: OrgRole) => ({ org_id: o, principal_kind: k, principal_id: p, role: r, created_at: NOW });
const wg = (w: string, o: string, k: PrincipalKind, p: string, r: OrgRole) => ({ workspace_id: w, org_id: o, principal_kind: k, principal_id: p, role: r, created_at: NOW });
const cm = (c: string, w: string, k: PrincipalKind, p: string, r: 'owner' | 'member') => ({ channel_id: c, workspace_id: w, principal_kind: k, principal_id: p, role: r, notify_pref: 'all' as const, joined_at: NOW });
const ch = (c: string, w: string, o: string) => ({ channel_id: c, workspace_id: w, org_id: o, slug: 'general', visibility: 'workspace' as const, join_policy: 'open' as const });
const ap = (p: string, w: string, a: string, name = 'Argon') => ({ principal_id: p, workspace_id: w, agent_identity_id: a, owner_user_id: 'u-owner', name });
const st = (s: string, w: string, p: string, a: string) => ({ seat_id: s, workspace_id: w, principal_id: p, agent_identity_id: a });
const ref = (r: { ok: boolean; refusal?: { code: string } }, c: string) => eq(!r.ok && r.refusal?.code, c);
const exec = <T extends { ok: boolean; status?: string }>(r: T) => { eq(r.ok && r.status === 'executed', true); return r as Extract<T, { ok: true; status: 'executed' }>; };
const appr = <T extends { ok: boolean; status?: string }>(r: T) => { eq(r.ok && r.status === 'approval_required', true); return r as Extract<T, { ok: true; status: 'approval_required' }>; };
function fix(): OrgAuthorityState {
 const u: PrincipalKind = 'user', a: PrincipalKind = 'agent', o1s = 'org-1', o2s = 'org-2', w1s = 'ws-1a', w2s = 'ws-2a', g1 = 'ch-1a-gen';
 return {
  privateChannelsEnabled: true,
  organizations: [org(o1s, 'yulan', 'Yulan'), org(o2s, 'household', 'Household')],
  workspaces: [ws(w1s, o1s, 'ops'), ws('ws-1b', o1s, 'product'), ws(w2s, o2s, 'home')],
  channels: [ch(g1, w1s, o1s), ch('ch-1b-gen', 'ws-1b', o1s), ch('ch-2a-gen', w2s, o2s)],
  agentIdentities: [{ id: 'ag-1', owner_user_id: 'u-owner', display_name: 'Argon', created_at: NOW }, { id: 'ag-2', owner_user_id: 'u-owner', display_name: 'Codex', created_at: NOW }],
  orgMemberships: [om(o1s, u, 'u-owner', 'owner'), om(o1s, u, 'u-admin', 'admin'), om(o1s, u, 'u-member', 'member'), om(o1s, u, 'u-guest', 'guest'), om(o1s, a, 'ag-1', 'admin'), om(o2s, u, 'u-owner', 'owner'), om(o2s, a, 'ag-1', 'member')],
  workspaceGrants: [wg(w1s, o1s, u, 'u-owner', 'owner'), wg('ws-1b', o1s, u, 'u-owner', 'owner'), wg(w2s, o2s, u, 'u-owner', 'owner'), wg(w1s, o1s, u, 'u-admin', 'admin'), wg(w1s, o1s, u, 'u-member', 'member'), wg(w1s, o1s, a, 'ag-1', 'admin'), wg(w2s, o2s, a, 'ag-1', 'member')],
  agentPrincipals: [ap('ap-1a', w1s, 'ag-1'), ap('ap-2a', w2s, 'ag-1')],
  channelMemberships: [cm(g1, w1s, u, 'u-owner', 'owner'), cm(g1, w1s, u, 'u-member', 'member'), cm(g1, w1s, a, 'ag-1', 'member')],
  seats: [st('seat-1a', w1s, 'ap-1a', 'ag-1'), st('seat-2a', w2s, 'ap-2a', 'ag-1')],
  seatHandles: [{ handle_id: 'h-1a', seat_id: 'seat-1a', workspace_id: w1s }, { handle_id: 'h-2a', seat_id: 'seat-2a', workspace_id: w2s }],
  signals: [{ signal_id: 'sig-1a-1', workspace_id: w1s, channel_id: g1, from_principal_kind: u, from_principal_id: 'u-owner', kind: 'note', body: 'Init', created_at: NOW }],
  files: [{ file_id: 'file-1a-1', workspace_id: w1s, name: 'runbook.md', created_at: NOW }],
 };
}
function recDb() {
 const qs: Array<{ sql: string; params: readonly unknown[] }> = [], rpcs: Array<{ fn: string; params: unknown }> = [];
 let tx = 0;
 const db: OrgSqlExecutor = {
  query(sql, params = []) { qs.push({ sql, params }); return { rows: [], rowCount: 1 }; },
  rpc(fn, params) { rpcs.push({ fn, params }); return { ok: true }; },
  withTransaction(fn) { tx += 1; return fn(db); },
 };
 return { db, qs, rpcs, getTx: () => tx, hasSql: (s: string) => eq(qs.some((q) => q.sql.includes(s)), true, s) };
}
const ow = usr('u-owner', 'owner@yulan.io'), ad = usr('u-admin', 'admin@yulan.io'), mb = usr('u-member', 'member@yulan.io'), gu = usr('u-guest', 'guest@yulan.io');
const ag1 = pa('ag-1'), ag2 = pa('ag-2'), clk = { testClockIso: '2026-10-22T00:00:00Z' }, o1 = { org_id: 'org-1' }, o2 = { org_id: 'org-2' }, oe = { org_id: 'org-empty' }, w1a = { workspace_id: 'ws-1a' };
test('org CRUD, UUIDs, created_by, and delete cascade', () => {
 const s = fix(), { db, qs, hasSql } = recDb();
 s.workspaceGrants.push(wg('ws-2a', 'org-2', 'agent', 'ag-2', 'member'));
 s.agentPrincipals!.push(ap('ap-2a-ag2', 'ws-2a', 'ag-2', 'Codex'));
 s.channelMemberships.push(cm('ch-2a-gen', 'ws-2a', 'agent', 'ag-2', 'member'));
 s.seats!.push(st('seat-2a-ag2', 'ws-2a', 'ap-2a-ag2', 'ag-2'));
 eq(orgList(s, ow).organizations.length, 2);
 deq(orgList(s, ag1).organizations.map((o) => o.role), ['admin', 'member']);
 const cr = exec(orgCreate(s, ag1, { slug: 'ridge-labs', display_name: 'Ridge Labs', default_workspace: true }, db));
 for (const id of [cr.organization.id, cr.membership.id!, cr.agent_membership!.id!, cr.workspace!.workspace_id, cr.general_channel!.channel_id]) mt(id, URE);
 const wsIns = qs.find((q) => q.sql.includes('INSERT INTO swarm.workspaces'));
 eq(wsIns?.sql.includes('created_by') && wsIns?.params[4] === 'u-owner', true);
 ref(orgCreate(s, ow, { slug: 'RIDGE-LABS', display_name: 'Dup' }), 'ORG_SLUG_TAKEN');
 ref(orgUpdate(s, mb, { ...o1, display_name: 'Nope' }), 'ORG_ADMIN_REQUIRED');
 eq(orgUpdate(s, ad, { ...o1, display_name: 'Yulan Inc.' }).ok, true);
 ref(orgDelete(s, ad, o1), 'ORG_OWNER_REQUIRED');
 eq(orgDelete(s, ow, { org_id: cr.organization.id }).ok, true);
 deq(exec(orgDelete(s, ow, o2, db)).closed_seat_ids, ['seat-2a', 'seat-2a-ag2']);
 for (const t of ['hosted_mcp_seat_handles', 'hosted_mcp_seats', 'agent_principals', 'channel_memberships', 'memberships', 'workspace_principal_grants', 'org_invites', 'org_memberships']) hasSql(`UPDATE swarm.${t}`);
 for (const a of [o1, { ...o1, allow_last_org: true }, { ...o1, confirm_slug: 'yulan' }] as const) ref(orgDelete(s, ow, a), 'CANNOT_DELETE_LAST_ORG');
 exec(orgDelete(s, ow, { ...o1, allow_last_org: true, confirm_slug: 'yulan' }));
});
test('org_memberships, FOR UPDATE lock sync, and removal cascade', () => {
 const s = fix(), { db, hasSql } = recDb();
 eq(listMem(s, ow, { ...o1, filter: 'all' }).ok, true);
 const ags = listMem(s, ow, { ...o1, filter: 'agent' });
 if (!ags.ok) assert.fail();
 deq(ags.members[0]?.active_seat_ids, ['seat-1a']);
 eq(setRole(s, ow, { ...o1, ...ag1, role: 'owner' }).ok, true);
 ref(setRole(s, ow, { ...o1, ...pu('u-owner'), role: 'admin' }), 'CANNOT_REMOVE_LAST_ORG_OWNER');
 ref(remMem(s, ow, { ...o1, ...pu('u-owner') }), 'CANNOT_REMOVE_LAST_ORG_OWNER');
 ref(setRole(s, ad, { ...o1, ...pu('u-admin'), role: 'owner' }), 'ORG_OWNER_REQUIRED');
 mt(exec(setRole(s, ad, { ...o1, ...ag2, role: 'guest' })).membership.id!, URE);
 s.orgMemberships.find((m) => m.org_id === 'org-1' && m.principal_id === 'u-admin')!.role = 'owner';
 const raceDb: OrgSqlExecutor = { query: (sql) => sql.includes('FROM swarm.org_memberships') && sql.includes('FOR UPDATE') ? { rows: [{ org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', revoked_at: null }] } : { rows: [], rowCount: 1 } };
 ref(setRole(s, ow, { ...o1, ...pu('u-owner'), role: 'admin' }, raceDb), 'CANNOT_REMOVE_LAST_ORG_OWNER');
 eq(setRole(s, ow, { ...o1, ...ag1, role: 'admin' }).ok, true);
 const remAg1 = exec(remMem(s, ad, { ...o1, ...ag1 }, db));
 deq(remAg1.closed_seat_ids, ['seat-1a']); deq(remAg1.closed_handle_ids, ['h-1a']);
 hasSql('UPDATE swarm.hosted_mcp_seat_handles');
 eq(cro(s, ag1, 'org-1'), false); eq(cro(s, ag1, 'org-2'), true);
});
test('workspace grants, agent granted_by FK, and workspaceLeave cascade', () => {
 const s = fix(), { db, qs, hasSql } = recDb();
 s.workspaces.push(ws('ws-2b', 'org-2', 'ops'));
 s.workspaceGrants.push(wg('ws-2b', 'org-2', 'user', 'u-owner', 'owner'));
 const ambig = wsJoin(s, ow, { workspace_id: 'ops' });
 ref(ambig, 'AMBIGUOUS_WORKSPACE_SELECTOR');
 eq(!ambig.ok && ambig.refusal.choices?.length, 2);
 eq(wsJoin(s, ow, { workspace_id: 'yulan/ops' }).ok, true);
 ref(wsJoin(s, gu, w1a), 'GUEST_CANNOT_SELF_JOIN_WORKSPACE');
 const agJ = wsJoin(s, ag1, { workspace_id: 'ws-1b' }, db);
 eq(agJ.ok && agJ.grant.granted_by, 'u-owner');
 mt(agJ.ok ? agJ.grant.id! : '', URE); mt(agJ.ok ? agJ.agent_principal!.principal_id : '', URE);
 deq(exec(remWs(s, ad, { ...w1a, ...ag1 }, db)).closed_seat_ids, ['seat-1a']);
 ref(wsJoin(s, ag1, w1a), 'WORKSPACE_ACCESS_REVOKED');
 eq(assignWs(s, ad, { ...w1a, ...ag1, role: 'admin' }).ok, true);
 qs.length = 0;
 eq(wsLeave(s, ag1, w1a, db).ok, true);
 for (const t of ['workspace_principal_grants', 'channel_memberships', 'agent_principals', 'hosted_mcp_seats', 'hosted_mcp_seat_handles']) hasSql(t);
 eq(wsList(s, ad, w1a).ok, true);
});
test('invites & approvals', () => {
 const s = fix(), { db, hasSql } = recDb(), uM = { ...o1, ...pu('u-member') }, invIn = { ...o1, email: 'new@yulan.io', role: 'admin' as const, workspace_ids: ['ws-1a'] };
 eq(orgDelete(s, ag1, { ...o1, require_approval: false }).status, 'approval_required');
 const card = appr(invCreate(s, ag1, { ...invIn, require_approval: false }, db)), aid = card.approval.approval_id;
 mt(aid, URE); mt(card.card_signal!.signal_id, URE); hasSql('INSERT INTO swarm.signals');
 ref(confirm(s, ag1, { approval_id: aid, decision: 'approve' }), 'HUMAN_OWNER_CONFIRMATION_REQUIRED');
 const conf = confirm(s, ow, { approval_id: aid, decision: 'approve' });
 if (!conf.ok || !conf.executed) assert.fail();
 const invRes = conf.result as { token: string; invite: { invite_id: string } }, tok = invRes.token;
 mt(invRes.invite.invite_id, URE);
 eq(invCreate(s, ag1, { ...invIn, approval_id: aid }).status, 'approval_required');
 const rCard = appr(setRole(s, ag1, { ...uM, role: 'admin' })), rAid = rCard.approval.approval_id;
 Object.assign(rCard.approval, { state: 'approved', decided_by: 'u-owner', decided_at: NOW });
 for (const [c, r, exp] of [[ag1, 'owner', 'approval_required'], [ag2, 'admin', 'approval_required'], [ag1, 'admin', 'executed'], [ag1, 'admin', 'approval_required']] as const) {
  eq(setRole(s, c, { ...uM, role: r, approval_id: rAid }).status, exp);
 }
 const uNew = usr('u-new', 'new@yulan.io');
 ref(invAccept(s, uNew, { invite_id: invRes.invite.invite_id }), 'ORG_INVITE_TOKEN_REQUIRED');
 ref(invAccept(s, pu('u-new'), { token: tok, email: 'new@yulan.io' }), 'INVITE_EMAIL_MISMATCH');
 ref(invAccept(s, uNew, { token: tok, now: '2026-10-21T00:01:00Z' }, { testClockIso: '2026-12-01T00:00:00Z' }), 'ORG_INVITE_EXPIRED');
 const zeroDb: OrgSqlExecutor = { query: (sql) => ({ rows: [], rowCount: sql.includes('UPDATE swarm.org_invites SET consumed_at') ? 0 : 1 }) };
 ref(invAccept(s, uNew, { token: tok }, { ...clk, db: zeroDb }), 'ORG_INVITE_UNAVAILABLE');
 eq(invAccept(s, usr('u-new', 'New@Yulan.io'), { token: tok }, clk).ok, true);
 const agInv = exec(invCreate(s, ow, { ...o1, role: 'admin', workspace_ids: ['ws-1a'], now: NOW }));
 const agAcc = invAccept(s, ag1, { token: agInv.token }, clk);
 eq(agAcc.ok && agAcc.invite.consumed_by, 'u-owner');
 const expC = appr(dispatch(s, ag1, { kind: 'org_set_member_role', ...o2, ...pu('u-new'), role: 'owner' }));
 expC.approval.expires_at = '2026-10-22T00:00:00Z';
 ref(confirm(s, ow, { approval_id: expC.approval.approval_id, decision: 'approve', now: NOW }, { testClockIso: '2026-10-23T00:00:00Z' }), 'APPROVAL_REQUEST_EXPIRED');
 eq(expC.approval.state, 'expired');
 const inv2 = exec(invCreate(s, ow, { ...o1, role: 'guest', workspace_ids: ['ws-1a'] }));
 eq(invRevoke(s, ow, { ...o1, invite_id: inv2.invite.invite_id }).ok, true);
 eq(invAccept(s, pu('u-late'), { token: inv2.token }).ok, false);
});
test('Org Logo pipeline', () => {
 const s = fix(), { db, qs, hasSql } = recDb(), lp = 'orgs/org-empty/logo', stored: string[] = [];
 db.storage = { put: (k) => stored.push(k), delete: () => {} };
 eq(orgCreate(s, ow, { id: 'org-empty', slug: 'zero-ws', display_name: 'Zero' }).ok, true);
 for (const [ct, b] of [['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]], ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]], ['image/webp', [0x52, 0x49, 0x46, 0x46, 16, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]]] as const) {
  ref(finLogo(s, ow, { ...oe, content_type: ct, bytes: new Uint8Array(b) }), 'ORG_LOGO_INVALID_FORMAT');
 }
 const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64'));
 const prep = exec(prepLogo(s, ow, { ...oe, content_type: 'image/png', size_bytes: png.byteLength }));
 mt(prep.upload.upload_id, URE);
 deq(exec(finLogo(s, ow, { ...oe, upload_id: prep.upload.upload_id, bytes: png }, db)).renditions, { 64: `${lp}/64.png`, 128: `${lp}/128.png`, 256: `${lp}/256.png` });
 eq(stored.length, 3); eq(qs.filter((q) => q.sql.includes('INSERT INTO swarm.org_logo_objects')).length, 3);
 for (const sz of [64, 128, 256] as const) {
  const d = s.logoObjects![`${lp}/${sz}.png`]!.data;
  deq(dims(d, 'image/png'), { width: sz, height: sz }); eq(decLogo(d as Uint8Array, 'image/png')?.rgba[0], 255);
 }
 eq(finLogo(s, ow, { ...oe, content_type: 'image/jpeg', bytes: rsz(png, 'image/jpeg', 64) }).ok, true);
 deq(dims(s.logoObjects![`${lp}/128.jpg`]!.data, 'image/jpeg'), { width: 128, height: 128 });
 eq(finLogo(s, ow, { ...oe, content_type: 'image/webp', bytes: rsz(png, 'image/webp', 64) }).ok, true);
 deq(dims(s.logoObjects![`${lp}/64.webp`]!.data, 'image/webp'), { width: 64, height: 64 });
 deq(dims(s.logoObjects![`${lp}/256.webp`]!.data, 'image/webp'), { width: 256, height: 256 });
 ref(finLogo(s, ow, { ...oe, content_type: 'image/svg+xml', bytes: '<svg><g></svg>' }), 'ORG_LOGO_INVALID_FORMAT');
 const dirty = `<?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" onload="alert(1)"><script>evil()</script><rect width="100" height="100" style="fill:url(\\68\\74\\74\\70\\73://evil.example/a.svg#x)" fill="#145c46"/></svg>`;
 eq(finLogo(s, ow, { ...oe, content_type: 'image/svg+xml', bytes: dirty }).ok, true);
 const r256 = String(s.logoObjects?.[`${lp}/256.svg`]?.data ?? '');
 eq(/<\?xml|<script|onload|evil\.example/i.test(r256), false);
 mt(r256, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/); mt(r256, /viewBox="0 0 512 512" width="256" height="256"/);
 eq(remLogo(s, ow, oe, db).ok, true); hasSql('DELETE FROM swarm.org_logo_objects');
});
test('move_workspace, tx rollback, and hosted handler', async () => {
 const s1 = fix(), { db, qs, rpcs, getTx } = recDb(), mv = { ...w1a, target_org_id: 'org-2', transfer_members: 'owners_only' as const };
 ref(moveWs(s1, ad, mv), 'ORG_MOVE_REQUIRES_DUAL_OWNER');
 const moved = exec(dispatch(s1, { kind: 'org_move_workspace', ...mv }, ow, db));
 deq(moved.lock_order, [...LOCK_ORDER]); deq(moved.closed_seat_ids, ['seat-1a']);
 eq(getTx(), 1); eq(rpcs.length, 0);
 eq(qs.filter((q) => q.sql.includes('SELECT swarm.org_move_workspace($1, $2, $3, $4)')).length, 1);
 const sF = fix(), tDb: OrgSqlExecutor = { query(sql) { if (sql.includes('UPDATE swarm.organizations')) throw new Error('fail'); return { rows: [], rowCount: 1 }; }, withTransaction(fn) { return fn(tDb); } };
 assert.throws(() => orgUpdate(sF, ow, { ...o1, display_name: 'X' }, tDb), /fail/);
 eq(sF.organizations.find((o) => o.id === 'org-1')?.display_name, 'Yulan');
 const sDb = mkDb(fix());
 eq((await loadDb(sDb)).organizations.length, 2);
 const res = await hReq({ headers: { 'x-principal-id': 'u-owner', 'x-principal-kind': 'user' }, body: { kind: 'org_update', ...o1, display_name: 'Yulan Hosted' } }, { db: sDb });
 eq(res.status, 200); eq(sDb.store.organizations.find((o) => o.id === 'org-1')?.display_name, 'Yulan Hosted');
 for (const f of ['crud.ts', 'index.ts', 'invites.ts', 'logo.ts', 'members.ts', 'move-workspace.ts', 'workspace-grants.ts'].map((x) => `supabase/functions/command/orgs/${x}`).concat('tests/org-channels/slice1-org-authority.test.ts')) {
  assert.ok(Math.ceil(fs.readFileSync(f, 'utf8').length / 4) <= 4500, f);
 }
});
