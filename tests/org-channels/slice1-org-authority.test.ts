import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_ORG_CHANNEL_LOCK_ORDER as LOCK_ORDER, ORG_LOGO_MAX_BYTES as MAX_BYTES,
  type OrgAuthorityState, type OrgRole, type OrgSqlExecutor, type PrincipalKind,
  canReadOrg as cro, canReadWorkspace as crw, dispatchOrgCommand as dispatch,
  orgAssignWorkspaceMember as assignWs, orgConfirmAction as confirm, orgCreate, orgDelete,
  orgInviteAccept as invAccept, orgInviteCreate as invCreate, orgInviteRevoke as invRevoke,
  orgList, orgListMembers as listMem, orgLogoFinalize as finLogo, orgLogoRemove as remLogo,
  orgLogoUploadPrepare as prepLogo, orgMoveWorkspace as moveWs, orgRemoveMember as remMem,
  orgRemoveWorkspaceMember as remWs, orgSetMemberRole as setRole, orgUpdate,
  readLogoDimensions as dims, workspaceJoin as wsJoin, workspaceLeave as wsLeave, workspaceListMembers as wsList,
} from '../../supabase/functions/command/orgs/index.js';

const NOW = '2026-10-21T00:00:00Z', eq = assert.equal, deq = assert.deepEqual, neq = assert.notEqual;
const pu = (id: string) => ({ principal_kind: 'user' as const, principal_id: id });
const pa = (id: string) => ({ principal_kind: 'agent' as const, principal_id: id });
const usr = (id: string, email?: string) => ({ ...pu(id), ...(email ? { authenticated_email: email } : {}) });
const org = (id: string, slug: string, display_name = slug) => ({ id, slug, display_name, created_by: 'u-owner', created_at: NOW, updated_at: NOW });
const ws = (workspace_id: string, org_id: string, slug: string, name = slug) => ({ workspace_id, org_id, slug, name });
const om = (o: string, k: PrincipalKind, p: string, r: OrgRole) => ({ org_id: o, principal_kind: k, principal_id: p, role: r, created_at: NOW });
const wg = (w: string, o: string, k: PrincipalKind, p: string, r: OrgRole) => ({ workspace_id: w, org_id: o, principal_kind: k, principal_id: p, role: r, created_at: NOW });
const cm = (c: string, w: string, k: PrincipalKind, p: string, r: 'owner' | 'member') => ({ channel_id: c, workspace_id: w, principal_kind: k, principal_id: p, role: r, notify_pref: 'all' as const, joined_at: NOW });
const ch = (c: string, w: string, o: string) => ({ channel_id: c, workspace_id: w, org_id: o, slug: 'general', visibility: 'workspace' as const, join_policy: 'open' as const });
const ap = (p: string, w: string, a: string, name = 'Argon') => ({ principal_id: p, workspace_id: w, agent_identity_id: a, owner_user_id: 'u-owner', name });
const st = (s: string, w: string, p: string, a: string) => ({ seat_id: s, workspace_id: w, principal_id: p, agent_identity_id: a });
const refused = (r: { ok: boolean; refusal?: { code: string } }, code: string) => eq(!r.ok && r.refusal?.code, code);
function exec<T extends { ok: boolean; status?: string }>(r: T): Extract<T, { ok: true; status: 'executed' }> {
  eq(r.ok && r.status === 'executed', true);
  return r as Extract<T, { ok: true; status: 'executed' }>;
}

function appr<T extends { ok: boolean; status?: string }>(r: T): Extract<T, { ok: true; status: 'approval_required' }> {
  eq(r.ok && r.status === 'approval_required', true);
  return r as Extract<T, { ok: true; status: 'approval_required' }>;
}

function createFixture(): OrgAuthorityState {
  return {
    privateChannelsEnabled: true,
    organizations: [org('org-1', 'yulan', 'Yulan'), org('org-2', 'household', 'Household')],
    workspaces: [ws('ws-1a', 'org-1', 'ops'), ws('ws-1b', 'org-1', 'product'), ws('ws-2a', 'org-2', 'home')],
    channels: [ch('ch-1a-gen', 'ws-1a', 'org-1'), ch('ch-1b-gen', 'ws-1b', 'org-1'), ch('ch-2a-gen', 'ws-2a', 'org-2')],
    agentIdentities: [{ id: 'ag-1', owner_user_id: 'u-owner', display_name: 'Argon', created_at: NOW }, { id: 'ag-2', owner_user_id: 'u-owner', display_name: 'Codex', created_at: NOW }],
    orgMemberships: [
      om('org-1', 'user', 'u-owner', 'owner'), om('org-1', 'user', 'u-admin', 'admin'), om('org-1', 'user', 'u-member', 'member'),
      om('org-1', 'user', 'u-guest', 'guest'), om('org-1', 'agent', 'ag-1', 'admin'), om('org-2', 'user', 'u-owner', 'owner'), om('org-2', 'agent', 'ag-1', 'member'),
    ],
    workspaceGrants: [
      wg('ws-1a', 'org-1', 'user', 'u-owner', 'owner'), wg('ws-1b', 'org-1', 'user', 'u-owner', 'owner'), wg('ws-2a', 'org-2', 'user', 'u-owner', 'owner'),
      wg('ws-1a', 'org-1', 'user', 'u-admin', 'admin'), wg('ws-1a', 'org-1', 'user', 'u-member', 'member'), wg('ws-1a', 'org-1', 'agent', 'ag-1', 'admin'), wg('ws-2a', 'org-2', 'agent', 'ag-1', 'member'),
    ],
    agentPrincipals: [ap('ap-1a', 'ws-1a', 'ag-1'), ap('ap-2a', 'ws-2a', 'ag-1')],
    channelMemberships: [cm('ch-1a-gen', 'ws-1a', 'user', 'u-owner', 'owner'), cm('ch-1a-gen', 'ws-1a', 'user', 'u-member', 'member'), cm('ch-1a-gen', 'ws-1a', 'agent', 'ag-1', 'member')],
    seats: [st('seat-1a', 'ws-1a', 'ap-1a', 'ag-1'), st('seat-2a', 'ws-2a', 'ap-2a', 'ag-1')],
    seatHandles: [{ handle_id: 'h-1a', seat_id: 'seat-1a', workspace_id: 'ws-1a' }, { handle_id: 'h-2a', seat_id: 'seat-2a', workspace_id: 'ws-2a' }],
    signals: [{ signal_id: 'sig-1a-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-gen', from_principal_kind: 'user', from_principal_id: 'u-owner', kind: 'note', body: 'Init', created_at: NOW }],
    files: [{ file_id: 'file-1a-1', workspace_id: 'ws-1a', name: 'runbook.md', created_at: NOW }],
  };
}

function recDb() {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [], rpcCalls: Array<{ fn: string; params: unknown }> = [];
  let tx = 0;
  const db: OrgSqlExecutor = {
    query(sql, params = []) { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; },
    rpc(fn, params) { rpcCalls.push({ fn, params }); return { ok: true }; },
    withTransaction(fn) { tx += 1; return fn(db); },
  };
  return { db, queries, rpcCalls, getTx: () => tx };
}

const owner = usr('u-owner', 'owner@yulan.io'), admin = usr('u-admin', 'admin@yulan.io');
const member = usr('u-member', 'member@yulan.io'), guest = usr('u-guest', 'guest@yulan.io');
const ag1 = pa('ag-1'), ag2 = pa('ag-2'), clk = { testClockIso: '2026-10-22T00:00:00Z' };
const o1 = { org_id: 'org-1' }, o2 = { org_id: 'org-2' }, oe = { org_id: 'org-empty' }, w1a = { workspace_id: 'ws-1a' };

test('org CRUD, listing, last-org dual confirm, and delete cascade', () => {
  const s = createFixture();
  s.workspaceGrants.push(wg('ws-2a', 'org-2', 'agent', 'ag-2', 'member'));
  s.agentPrincipals!.push(ap('ap-2a-ag2', 'ws-2a', 'ag-2', 'Codex'));
  s.channelMemberships.push(cm('ch-2a-gen', 'ws-2a', 'agent', 'ag-2', 'member'));
  s.seats!.push(st('seat-2a-ag2', 'ws-2a', 'ap-2a-ag2', 'ag-2'));

  eq(orgList(s, owner).organizations.length, 2);
  deq(orgList(s, ag1).organizations.map((o) => o.role), ['admin', 'member']);

  const cr = orgCreate(s, owner, { id: 'org-3', slug: 'ridge-labs', display_name: 'Ridge Labs' });
  eq(cr.ok && cr.workspace === null, true);
  refused(orgCreate(s, owner, { slug: 'RIDGE-LABS', display_name: 'Dup' }), 'ORG_SLUG_TAKEN');
  refused(orgUpdate(s, member, { ...o1, display_name: 'Nope' }), 'ORG_ADMIN_REQUIRED');
  eq(orgUpdate(s, admin, { ...o1, display_name: 'Yulan Inc.' }).ok, true);
  refused(orgDelete(s, admin, o1), 'ORG_OWNER_REQUIRED');
  eq(orgDelete(s, owner, { org_id: 'org-3' }).ok, true);

  const del2 = exec(orgDelete(s, owner, o2));
  deq(del2.closed_seat_ids, ['seat-2a', 'seat-2a-ag2']);
  neq(s.workspaceGrants.find((g) => g.workspace_id === 'ws-2a' && g.principal_id === 'ag-2')?.revoked_at ?? null, null);
  neq(s.agentPrincipals?.find((p) => p.workspace_id === 'ws-2a' && p.agent_identity_id === 'ag-2')?.revoked_at ?? null, null);
  neq(s.channelMemberships.find((x) => x.workspace_id === 'ws-2a' && x.principal_id === 'ag-2')?.revoked_at ?? null, null);

  for (const a of [o1, { ...o1, allow_last_org: true }, { ...o1, confirm_slug: 'yulan' }] as const) {
    refused(orgDelete(s, owner, a), 'CANNOT_DELETE_LAST_ORG');
  }
  exec(orgDelete(s, owner, { ...o1, allow_last_org: true, confirm_slug: 'yulan' }));
});

test('unified org_memberships, human-only last-owner guard, and removal cascade', () => {
  const s = createFixture();
  const all = listMem(s, owner, { ...o1, filter: 'all' });
  eq(all.ok && all.members.length, 5);
  const ags = listMem(s, owner, { ...o1, filter: 'agent' });
  if (!ags.ok) assert.fail('Expected agent roster');
  deq(ags.members[0]?.active_seat_ids, ['seat-1a']);

  eq(setRole(s, owner, { ...o1, ...ag1, role: 'owner' }).ok, true);
  refused(setRole(s, owner, { ...o1, ...pu('u-owner'), role: 'admin' }), 'CANNOT_REMOVE_LAST_ORG_OWNER');
  refused(remMem(s, owner, { ...o1, ...pu('u-owner') }), 'CANNOT_REMOVE_LAST_ORG_OWNER');
  refused(setRole(s, admin, { ...o1, ...pu('u-admin'), role: 'owner' }), 'ORG_OWNER_REQUIRED');
  eq(setRole(s, admin, { ...o1, ...ag2, role: 'guest' }).ok, true);

  eq(setRole(s, owner, { ...o1, ...ag1, role: 'admin' }).ok, true);
  const remAg1 = exec(remMem(s, admin, { ...o1, ...ag1 }));
  deq(remAg1.closed_seat_ids, ['seat-1a']);
  eq(cro(s, ag1, 'org-1'), false);
  eq(cro(s, ag1, 'org-2'), true);
  eq(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
});

test('workspace grants, ambiguity resolver, agent_principals, and revocation', () => {
  const s = createFixture();
  s.workspaces.push(ws('ws-2b', 'org-2', 'ops'));
  s.workspaceGrants.push(wg('ws-2b', 'org-2', 'user', 'u-owner', 'owner'));

  const ambig = wsJoin(s, owner, { workspace_id: 'ops' });
  refused(ambig, 'AMBIGUOUS_WORKSPACE_SELECTOR');
  eq(!ambig.ok && ambig.refusal.choices?.length, 2);
  eq(wsJoin(s, owner, { workspace_id: 'yulan/ops' }).ok, true);
  refused(wsJoin(s, guest, w1a), 'GUEST_CANNOT_SELF_JOIN_WORKSPACE');

  const assign1b = exec(assignWs(s, admin, { workspace_id: 'ws-1b', ...ag1, role: 'member' }));
  eq(assign1b.agent_principal?.workspace_id, 'ws-1b');

  const remWs1a = exec(remWs(s, admin, { ...w1a, ...ag1 }));
  deq(remWs1a.closed_seat_ids, ['seat-1a']);
  eq(crw(s, ag1, 'ws-1a'), false);
  eq(crw(s, ag1, 'ws-1b'), true);
  eq(crw(s, ag1, 'ws-2a'), true);
  refused(wsJoin(s, ag1, w1a), 'WORKSPACE_ACCESS_REVOKED');

  eq(assignWs(s, admin, { ...w1a, ...ag1, role: 'admin' }).ok, true);
  eq(crw(s, ag1, 'ws-1a'), true);
  const apRows = (s.agentPrincipals ?? []).filter((p) => p.workspace_id === 'ws-1a' && p.agent_identity_id === 'ag-1');
  eq(apRows.length === 1 && apRows[0]?.revoked_at === null, true);

  eq(crw(s, ag2, 'ws-1a'), true);
  eq(remWs(s, admin, { ...w1a, ...ag2 }).ok, true);
  eq(crw(s, ag2, 'ws-1a'), false);
  eq(wsList(s, admin, w1a).ok, true);
  eq(wsLeave(s, member, w1a).ok, true);
});

test('invites & approvals: token+email+clock, no downgrade, agent reactivation, expiry', () => {
  const s = createFixture();
  eq(orgDelete(s, ag1, { ...o1, require_approval: false }).status, 'approval_required');
  eq(remMem(s, ag1, { ...o1, ...pu('u-member'), require_approval: false }).status, 'approval_required');

  const cardRes = appr(invCreate(s, ag1, { ...o1, email: 'newbie@yulan.io', role: 'admin', workspace_ids: ['ws-1a'], require_approval: false }));
  const aid = cardRes.approval.approval_id;
  assert.match(cardRes.card_signal?.body ?? '', /\[Approval Card\]/);
  refused(confirm(s, ag1, { approval_id: aid, decision: 'approve' }), 'HUMAN_OWNER_CONFIRMATION_REQUIRED');

  const conf = confirm(s, owner, { approval_id: aid, decision: 'approve' });
  if (!conf.ok || !conf.executed) assert.fail('Expected confirmed');
  const invRes = conf.result as { token: string; invite: { invite_id: string } };

  const uNew = usr('u-newbie', 'newbie@yulan.io');
  refused(invAccept(s, uNew, { invite_id: invRes.invite.invite_id }), 'ORG_INVITE_TOKEN_REQUIRED');
  refused(invAccept(s, pu('u-newbie'), { token: invRes.token, email: 'newbie@yulan.io' }), 'INVITE_EMAIL_MISMATCH');
  refused(invAccept(s, usr('u-newbie', 'other@yulan.io'), { token: invRes.token }), 'INVITE_EMAIL_MISMATCH');
  refused(invAccept(s, uNew, { token: invRes.token, now: '2026-10-21T00:01:00Z' }, { testClockIso: '2026-12-01T00:00:00Z' }), 'ORG_INVITE_EXPIRED');

  eq(invAccept(s, usr('u-newbie', 'Newbie@Yulan.io'), { token: invRes.token }, clk).ok, true);
  eq(crw(s, uNew, 'ws-1a'), true);

  const mInv = exec(invCreate(s, owner, { ...o1, role: 'member', workspace_ids: ['ws-1a'], now: NOW }));
  const ownerAcc = invAccept(s, owner, { token: mInv.token }, clk);
  eq(ownerAcc.ok && ownerAcc.membership.role, 'owner');

  eq(remWs(s, admin, { ...w1a, ...ag1 }).ok, true);
  eq(crw(s, ag1, 'ws-1a'), false);
  const agInv = exec(invCreate(s, owner, { ...o1, role: 'admin', workspace_ids: ['ws-1a'], now: NOW }));
  eq(invAccept(s, ag1, { token: agInv.token }, clk).ok, true);
  eq(crw(s, ag1, 'ws-1a'), true);

  const expCard = appr(dispatch(s, ag1, { kind: 'org_set_member_role', ...o2, ...pu('u-newbie'), role: 'owner' }));
  expCard.approval.expires_at = '2026-10-22T00:00:00Z';
  refused(confirm(s, owner, { approval_id: expCard.approval.approval_id, decision: 'approve', now: NOW }, { testClockIso: '2026-10-23T00:00:00Z' }), 'APPROVAL_REQUEST_EXPIRED');
  eq(expCard.approval.state, 'expired');

  const inv2 = exec(invCreate(s, owner, { ...o1, role: 'guest', workspace_ids: ['ws-1a'] }));
  eq(invRevoke(s, owner, { ...o1, invite_id: inv2.invite.invite_id }).ok, true);
  eq(invAccept(s, pu('u-late'), { token: inv2.token }).ok, false);
});

test('Org Logo pipeline: allowlist SVG sanitization and 64/128/256 renditions', () => {
  const s = createFixture(), lp = 'orgs/org-empty/logo';
  eq(orgCreate(s, owner, { id: 'org-empty', slug: 'zero-ws-org', display_name: 'Zero WS' }).ok, true);
  eq(s.workspaces.filter((w) => w.org_id === 'org-empty').length, 0);

  refused(prepLogo(s, member, { ...o1, content_type: 'image/png', size_bytes: 512 }), 'ORG_ADMIN_REQUIRED');
  refused(prepLogo(s, owner, { ...oe, content_type: 'image/png', size_bytes: MAX_BYTES + 1 }), 'ORG_LOGO_TOO_LARGE');

  const prep = exec(prepLogo(s, owner, { ...oe, content_type: 'image/png', size_bytes: 16 }));
  refused(finLogo(s, owner, { ...oe, upload_id: prep.upload.upload_id, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }), 'ORG_LOGO_MAGIC_BYTE_MISMATCH');

  const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20, 30, 40]);
  const finPng = exec(finLogo(s, owner, { ...oe, upload_id: prep.upload.upload_id, bytes: validPng }));
  deq(finPng.renditions, { 64: `${lp}/64.png`, 128: `${lp}/128.png`, 256: `${lp}/256.png` });
  const p64 = s.logoObjects![`${lp}/64.png`]!, p128 = s.logoObjects![`${lp}/128.png`]!, p256 = s.logoObjects![`${lp}/256.png`]!;
  deq(dims(p64.data, 'image/png'), { width: 64, height: 64 });
  deq(dims(p128.data, 'image/png'), { width: 128, height: 128 });
  deq(dims(p256.data, 'image/png'), { width: 256, height: 256 });
  neq(p64.sha256, p128.sha256);
  neq(p128.sha256, p256.sha256);

  const validWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
  eq(finLogo(s, owner, { ...oe, content_type: 'image/webp', bytes: validWebp }).ok, true);
  deq(dims(s.logoObjects![`${lp}/64.webp`]!.data, 'image/webp'), { width: 64, height: 64 });
  deq(dims(s.logoObjects![`${lp}/256.webp`]!.data, 'image/webp'), { width: 256, height: 256 });

  const dirtySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" onload="alert(1)"><script>evil()</script><style>@import url("https://evil.example/x.css");</style><image href="/outside.svg" /><use href="&#104;ttps://example.invalid/logo.svg" /><a xlink:href="&#x6a;avascript:alert(1)"><rect width="100" height="100" href="/rel.svg" onclick="steal()" fill="#145c46"/></a></svg>`;
  eq(finLogo(s, owner, { ...oe, content_type: 'image/svg+xml', bytes: dirtySvg }).ok, true);
  const r64 = String(s.logoObjects?.[`${lp}/64.svg`]?.data ?? ''), r256 = String(s.logoObjects?.[`${lp}/256.svg`]?.data ?? '');
  eq(/<script|<image|<use|<a\b|onload|onclick|href|outside\.svg|example\.invalid|&#/i.test(r256), false);
  assert.match(r64, /viewBox="0 0 512 512" width="64" height="64"/);
  assert.match(r256, /viewBox="0 0 512 512" width="256" height="256"/);
  const svgTag = r256.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  eq((svgTag.match(/\bwidth=/g) ?? []).length, 1);
  eq((svgTag.match(/\bheight=/g) ?? []).length, 1);

  eq(remLogo(s, owner, oe).ok, true);
  eq(s.organizations.find((o) => o.id === 'org-empty')?.logo_object_key, null);
});

test('org_move_workspace & SQL executor: lock order, SQL/RPC, transfer_members', () => {
  const s1 = createFixture(), { db, queries, rpcCalls, getTx } = recDb();
  refused(moveWs(s1, admin, { ...w1a, target_org_id: 'org-2', transfer_members: 'owners_only' }), 'ORG_MOVE_REQUIRES_DUAL_OWNER');

  const moved = exec(dispatch(s1, { kind: 'org_move_workspace', ...w1a, target_org_id: 'org-2', transfer_members: 'owners_only' }, owner, db));
  if (!('lock_order' in moved)) assert.fail('Expected move');
  deq(moved.lock_order, [...LOCK_ORDER]);
  deq(moved.closed_seat_ids, ['seat-1a']);
  eq(moved.preserved.workspace_id, 'ws-1a');
  deq(moved.preserved.channel_ids, ['ch-1a-gen']);
  deq(moved.preserved.signal_ids, ['sig-1a-1']);
  deq(moved.preserved.file_ids, ['file-1a-1']);
  eq(getTx(), 1);
  eq(rpcCalls[0]?.fn, 'org_move_workspace');
  eq(queries.some((q) => q.sql.includes('SELECT swarm.org_move_workspace($1, $2, $3, $4)')), true);

  const lockTables = queries.filter((q) => q.sql.includes('FOR UPDATE')).map((q) => q.sql.match(/FROM swarm\.([a-z_]+)/)?.[1]);
  deq(lockTables, ['organizations', 'workspaces', 'channels', 'org_memberships', 'workspace_principal_grants', 'channel_memberships', 'agent_principals', 'hosted_mcp_seats']);
  eq(crw(s1, admin, 'ws-1a'), false);
  eq(crw(s1, owner, 'ws-1a'), true);

  const s2 = createFixture();
  const movedAll = exec(moveWs(s2, owner, { ...w1a, target_org_id: 'org-2', transfer_members: 'all' }));
  deq(movedAll.closed_seat_ids, []);
  eq(crw(s2, admin, 'ws-1a'), true);
  eq(s2.seats?.find((x) => x.seat_id === 'seat-1a')?.revoked_at ?? null, null);
});
