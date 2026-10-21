import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { type CliCallerContext as Ctx, effCallerOrgRole as effRole, executeOrgChannelsCli as execCli, formatOrgChannelRefusal as fmtRef, parseOrgChannelsCliArgs as parseCli, resetDefaultOrgChannelCliState as resetCli } from '../../src/cloud/org-channels-cli.js';
import { ORG_CHANNEL_MCP_TOOLS as TOOLS, ORG_CHANNEL_TOOL_NAMES as NAMES, type OrgChannelSlice3State as St, enrichOrgChannelRefusal as enrich, executeMultiOrgWhoami as whoami, executeOrgChannelMcpTool as mcp, isOrgChannelToolName as isTool, resolveMcpOrgWorkspaceChannel as resSel, validateOrgChannelToolArguments as valArgs } from '../../supabase/functions/mcp/org-channels-tools.js';
import { buildOrgChannelRefusal as mkRef, type OrgRole, type PrincipalKind } from '../../src/protocol/org-channels-contract.js';

const eq = assert.equal, deq = assert.deepEqual, ok = assert.ok, NOW = '2026-10-20T12:00:00.000Z';
const OY = 'o-y', OA = 'o-a', WC = 'w-yc', WO = 'w-yo', WA = 'w-ao', AG = 'ag-argon', CN = 'cn-a', WYC = 'yulan/core';
const R: Record<string, OrgRole> = { o: 'owner', d: 'admin', m: 'member', g: 'guest' }, K = (k: string): PrincipalKind => (k === 'a' ? 'agent' : 'user');
const U = (principal_id: string, connection_id?: string): Ctx => ({ principal_kind: 'user', principal_id, connection_id });
const A = (principal_id = AG, connection_id?: string, seat?: string): Ctx => ({ principal_kind: 'agent', principal_id, connection_id, seat });
const cli = (state: St, caller: Ctx, argv: string[]) => execCli(argv, { state, caller });
const sh = (state: St, caller: Ctx, cmd: string) => cli(state, caller, cmd.split(' '));
const rCode = (r: Record<string, unknown>) => (r.refusal as { code: string }).code;
const rc = (s: St, c: Ctx, t: string, a: Record<string, unknown>) => rCode(mcp(s, c, t, a));
const rs = (s: St, c: Ctx, a: Record<string, string>) => rCode(resSel(s, c, a));

function makeFixture(): St {
  const org = (id: string, slug: string, display_name: string) => ({ id, slug, display_name, logo_object_key: null, logo_updated_at: null, created_by: 'u-tom', created_at: NOW, updated_at: NOW, archived_at: null });
  const ws = (workspace_id: string, org_id: string, slug: string, name: string) => ({ workspace_id, org_id, slug, name, archived_at: null });
  const ch = (channel_id: string, workspace_id: string, org_id: string, slug: string, visibility: 'workspace' | 'private' = 'workspace') => ({
    channel_id, workspace_id, org_id, slug, visibility, join_policy: (visibility === 'private' ? 'invite_only' : 'open') as 'open' | 'invite_only', ...(slug === 'general' ? { is_default: true } : {}), created_at: NOW,
  });
  return {
    privateChannelsEnabled: true, organizations: [org(OY, 'yulan', 'Yulan'), org(OA, 'acme', 'Acme')],
    orgMemberships: ([[OY, 'u', 'u-tom', 'o'], [OY, 'u', 'u-alice', 'd'], [OY, 'u', 'u-bob', 'm'], [OY, 'u', 'u-guest', 'g'], [OY, 'a', AG, 'd'], [OA, 'u', 'u-tom', 'o'], [OA, 'a', AG, 'm']] as const).map(([o, k, id, r]) => ({ org_id: o, principal_kind: K(k), principal_id: id, role: R[r]!, created_at: NOW, revoked_at: null })),
    workspaces: [ws(WC, OY, 'core', 'Core'), ws(WO, OY, 'ops', 'Ops'), ws(WA, OA, 'ops', 'Ops')],
    workspaceGrants: ([[WC, OY, 'u', 'u-tom', 'o'], [WC, OY, 'u', 'u-alice', 'd'], [WC, OY, 'u', 'u-bob', 'm'], [WC, OY, 'a', AG, 'd'], [WO, OY, 'u', 'u-tom', 'o'], [WO, OY, 'a', AG, 'd'], [WA, OA, 'u', 'u-tom', 'o'], [WA, OA, 'a', AG, 'm']] as const).map(([w, o, k, id, r]) => ({ workspace_id: w, org_id: o, principal_kind: K(k), principal_id: id, role: R[r]!, created_at: NOW, revoked_at: null })),
    channels: [ch('c-yg', WC, OY, 'general'), ch('c-ys', WC, OY, 'security', 'private'), ch('c-yo', WO, OY, 'general'), ch('c-ag', WA, OA, 'general')],
    channelMemberships: ([['u', 'u-tom', 'owner'], ['a', AG, 'member']] as const).map(([k, id, r]) => ({ channel_id: 'c-ys', workspace_id: WC, principal_kind: K(k), principal_id: id, role: r, notify_pref: 'all' as const, joined_at: NOW, revoked_at: null })),
    agentIdentities: [{ id: AG, owner_user_id: 'u-tom', display_name: 'Argon', created_at: NOW }],
    agentPrincipals: [], seats: [], seatHandles: [],
    connectionPolicies: [{ connection_id: CN, default_org_id: OY, default_workspace_id: WC, revoked_at: null }],
    fileChannelBindings: [{ file_id: 'f-s1', workspace_id: WC, channel_id: 'c-ys', bound_by_kind: 'user', created_at: NOW }],
    signals: [{ signal_id: 's-s1', workspace_id: WC, channel_id: 'c-ys', thread_id: 't-s1' }],
  };
}

test('schemas', () => {
  deq([NAMES.length, TOOLS.length], [34, 34]);
  for (const t of TOOLS) for (const sel of ['seat', 'seat_id', 'org', 'workspace', 'channel']) ok(sel in t.inputSchema.properties);
  const inv = TOOLS.find((t) => t.name === 'org_invite_member')!, arrT = { type: 'array', items: { type: 'string' } };
  deq([inv.inputSchema.properties.workspace_ids, inv.inputSchema.properties.request_approval, TOOLS.find((t) => t.name === 'whoami')!.inputSchema.properties.allowed_org_ids], [arrT, { type: 'boolean' }, arrT]);
  assert.throws(() => valArgs('unknown_tool', {}), /Unknown/);
  assert.throws(() => valArgs('org_create', { slug: 'only' }), /Missing/);
  for (const [t, bad] of [
    ['org_set_member_role', { principal_id: 'u', role: 'x' }], ['channel_add_member', { principal_id: 'u', role: 'admin' }],
    ['channel_create', { slug: 's', visibility: 'x' }], ['channel_create', { slug: 's', join_policy: 'x' }],
    ['channel_set_notify_pref', { notify_pref: 'x' }], ['org_move_workspace', { target_org: 'a', transfer_members: 'x' }],
    ['org_confirm_action', { approval_id: 'a', decision: 'x' }], ['org_invite_member', { workspace_ids: 'x' }], ['org_delete', { confirm_slug: 'y', request_approval: 'x' }],
  ] as const) assert.throws(() => valArgs(t, bad), /INVALID/);
});

test('whoami+cli', () => {
  const s = makeFixture(), c = A(AG, CN), pre = whoami(s, c, {});
  if (!pre.ok) assert.fail('whoami');
  deq([pre.active_seat, pre.organizations[0]?.role, pre.organizations[1]?.role, (s.agentPrincipals?.length ?? 0) + (s.seats?.length ?? 0)], [null, 'admin', 'member', 0]);
  deq([rCode(whoami(s, c, { org: 'yulan', workspace: 'acme/ops' }) as Record<string, unknown>), rCode(whoami(s, U('u-bob'), { workspace: WYC, channel: 'security' }) as Record<string, unknown>)], ['WORKSPACE_SEAT_MISMATCH', 'CHANNEL_ACCESS_DENIED']);
  deq(JSON.parse(sh(s, c, 'cswarm whoami --json').stdout), pre);
  const disc = mcp(s, c, 'discover', {});
  deq([disc.total_organizations, disc.total_workspaces, disc.total_channels, JSON.parse(sh(s, c, 'discover --json').stdout)], [2, 3, 4, disc]);

  s.seats!.push({ seat_id: 'seat-1', workspace_id: WC, principal_id: 'ap-argon', agent_identity_id: AG, revoked_at: null });
  s.seatHandles!.push({ handle_id: 'h-live', seat_id: 'seat-1', workspace_id: WC, revoked_at: null });
  Object.assign(s.connectionPolicies![0]!, { default_org_id: OA, default_workspace_id: 'ws-del' });
  const fb = whoami(s, c, {});
  if (fb.ok) deq([fb.default_org_id, fb.default_workspace_id], [OA, WA]);
  Object.assign(s.connectionPolicies![0]!, { default_org_id: 'org-del', default_workspace_id: 'ws-del' });
  const post = whoami(s, A(AG, CN, 'h-live'), {});
  if (!post.ok) assert.fail('post');
  deq([post.active_seat?.seat_id, post.default_org_id, post.default_workspace_id], ['seat-1', null, null]);

  let tx = '';
  eq(execCli(['org', 'list', '--json'], { transport: (t) => ((tx = t), { ok: true, organizations: [] }) }).exitCode, 0);
  eq(tx, 'org_list');
  resetCli();
  eq(execCli(['org', 'create', 'solo-org', '--name', 'Solo']).exitCode, 0);
  eq((JSON.parse(execCli(['org', 'list', '--json']).stdout).organizations as Array<{ slug: string }>)[0]?.slug, 'solo-org');
});

test('selectors', () => {
  const s = makeFixture(), c = A(AG, CN);
  s.seats!.push({ seat_id: 'seat-1', workspace_id: WC, principal_id: 'ap-argon', agent_identity_id: AG, revoked_at: null });
  s.seatHandles!.push({ handle_id: 'h-live', seat_id: 'seat-1', workspace_id: WC, revoked_at: null }, { handle_id: 'h-rev', seat_id: 'seat-1', workspace_id: WC, revoked_at: NOW });
  deq([(resSel(s, c, {}) as { source?: string }).source, (resSel(s, c, { seat: 'h-live' }) as { source?: string }).source], ['connection_default', 'seat']);
  deq([
    rs(s, c, { seat: 'h-rev' }), rs(s, c, { seat: 'h-live', seat_id: 's2' }), rs(s, c, { seat: 'h-live', workspace: 'acme/ops' }),
    rc(s, c, 'org_get', { org: 'yulan', workspace: 'acme/ops' }), rc(s, c, 'org_create', { slug: 'b', display_name: 'B', org: 'none' }),
  ], ['WORKSPACE_ACCESS_DENIED', 'WORKSPACE_SEAT_MISMATCH', 'WORKSPACE_SEAT_MISMATCH', 'WORKSPACE_SEAT_MISMATCH', 'ORG_ACCESS_DENIED']);
  const ambig = resSel(s, A(), { workspace: 'ops' });
  if (!ambig.ok) {
    deq([ambig.refusal.code, ambig.refusal.choices?.map((x) => x.selector), isTool(ambig.refusal.mcp_tool)], ['AMBIGUOUS_WORKSPACE_SELECTOR', ['yulan/ops', 'acme/ops'], true]);
    assert.match(fmtRef(ambig.refusal), /Matching workspaces: yulan\/ops, acme\/ops/);
  }
  const sigD = resSel(s, U('u-bob'), { workspace: WYC, signal_id: 's-s1' });
  if (!sigD.ok) deq([sigD.refusal.code, sigD.refusal.mcp_tool, parseCli(sigD.refusal.grant_command_hint.split(' ')).tool], ['CHANNEL_ACCESS_DENIED', 'channel_add_member', 'channel_add_member']);
  eq(parseCli(enrich(mkRef({ code: 'CHANNEL_ACCESS_DENIED', missing: 'ch', scope: { org: 'yulan', workspace: 'core' } })).grant_command_hint.split(' ')).tool, 'channel_add_member');
  eq(rs(s, U('u-bob'), { workspace: WYC, file_id: 'f-s1' }), 'CHANNEL_ACCESS_DENIED');
});

test('org+logos', () => {
  const s = makeFixture(), tom = U('u-tom', 'conn-tom'), alice = U('u-alice'), argon = A(AG, CN), shY = (c: Ctx, sub: string) => sh(s, c, `org ${sub} --org yulan`), rcY = (c: Ctx, t: string, a: Record<string, unknown>) => rc(s, c, t, { org: 'yulan', ...a });
  deq([sh(s, tom, 'org list').exitCode, sh(s, tom, 'org get yulan').exitCode], [0, 0]);
  const newOrgId = (sh(s, tom, 'org create ridge --name Ridge').payload.organization as { id: string }).id;
  deq([effRole(s, A(), newOrgId), rc(s, argon, 'org_update', { org: 'ridge', display_name: 'X' })], ['member', 'ORG_ADMIN_REQUIRED']);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>x()</script><foreignObject><div>b</div></foreignObject><image href="//evil.io/x.png"/><a href="&#x6a;avascript:x()"><circle r="9" style="fill:url(&#x2f;&#x2f;evil.io/p)"/></a></svg>';
  eq(cli(s, tom, ['org', 'logo', 'upload', '--org', 'ridge', '--content-type', 'image/svg+xml', '--svg', svg]).exitCode, 0);
  const logo = s.orgLogos?.[newOrgId]!, b64 = logo.rendition_blobs?.['64']!;
  ok(['<script>', 'onload=', 'foreignObject', 'evil.io', '&#x6a;'].every((bad) => !logo.sanitized_svg?.includes(bad)));
  deq([b64.width, Buffer.from(b64.data_base64, 'base64').subarray(8, 16).toString('ascii'), logo.rendition_blobs?.['256'].sha256.length], [64, 'WEBPVP8L', 64]);
  const mkPng = (r: number) => {
    const z = deflateSync(Uint8Array.from([0, r, 10, 20, 255])), b = Buffer.alloc(45 + z.length);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6]).copy(b);
    b.writeUInt32BE(z.length, 33); b.write('IDAT', 37); z.copy(b, 41);
    return b.toString('base64');
  };
  const upPng = (d: string) => mcp(s, tom, 'org_logo_upload', { org: 'ridge', content_type: 'image/png', data_base64: d });
  upPng(mkPng(200));
  const sha1 = s.orgLogos?.[newOrgId]?.rendition_blobs?.['64'].sha256;
  upPng(mkPng(25));
  assert.notEqual(sha1, s.orgLogos?.[newOrgId]?.rendition_blobs?.['64'].sha256);

  eq(rCode(upPng('iVBORw==')), 'INVALID_LOGO_FORMAT');
  deq([sh(s, tom, 'org logo remove --org ridge').exitCode, sh(s, argon, 'org switch acme --workspace ops').exitCode, sh(s, tom, 'org update ridge --name RidgeInc').exitCode], [0, 0, 0]);
  eq(s.connectionPolicies![0]!.default_org_id, OA);

  deq([
    rcY(alice, 'org_invite_member', { principal_id: 'u-tom', role: 'member' }),
    rcY(tom, 'org_invite_member', { principal_id: 'u-tom', role: 'admin' }),
    rcY(tom, 'org_invite_member', { principal_id: 'u-badws', role: 'member', workspace_ids: ['bad'] }),
  ], ['ORG_OWNER_ROLE_REQUIRED', 'LAST_ORG_OWNER_REQUIRED', 'WORKSPACE_ACCESS_DENIED']);
  ok(!s.orgMemberships.some((m) => m.principal_id === 'u-badws'));

  s.orgMemberships[0]!.role = 'guest';
  deq([effRole(s, argon, OY), rcY(argon, 'org_set_member_role', { principal_id: 'u-tom', role: 'admin' })], ['guest', 'ORG_ADMIN_REQUIRED']);
  s.orgMemberships[0]!.role = 'owner';

  eq(shY(tom, `invite c@y.io --principal u-c --role guest --workspace ${WC}`).exitCode, 0);
  deq([(shY(tom, 'members --kind guest').payload.members as unknown[]).length, shY(tom, 'role u-c member').exitCode, shY(tom, 'remove u-c').exitCode], [2, 0, 0]);
  eq(rcY(tom, 'org_set_member_role', { principal_id: 'u-tom', role: 'admin' }), 'CANNOT_REMOVE_LAST_ORG_OWNER');

  for (const [cmd, dec, end] of [['org set-role u-tom admin --org yulan --request-approval', 'approve', 'pending'], ['org delete ridge --confirm ridge', 'typo', 'approved']] as const) {
    const req = sh(s, argon, cmd), id = (req.payload.approval as { approval_id: string }).approval_id;
    assert.match(req.stdout, /pending_owner_approval/);
    eq(rc(s, tom, 'org_confirm_action', { approval_id: id, decision: 'approve', org: 'acme' }), 'WORKSPACE_SEAT_MISMATCH');
    deq([mcp(s, tom, 'org_confirm_action', { approval_id: id, decision: dec }).ok, s.approvalRequests?.find((a) => a.approval_id === id)?.state], [false, 'pending']);
    if (end === 'approved') eq(sh(s, tom, `org confirm ${id} --approve`).payload.status, 'approved');
  }
  ok(s.organizations.find((o) => o.id === newOrgId)?.archived_at);
});

test('workspaces', () => {
  const s = makeFixture(), tom = U('u-tom'), guest = U('u-guest'), yr = 'yulan/research';
  eq(sh(s, tom, 'workspace list --org yulan').exitCode, 0);
  const defCh = sh(s, tom, 'workspace create research --org yulan --name Research').payload.default_channel as { slug: string; is_default?: boolean };
  deq([defCh.slug, defCh.is_default, rCode(sh(s, guest, `workspace join ${yr}`).payload)], ['general', true, 'GUEST_WORKSPACE_GRANT_REQUIRED']);
  eq(sh(s, tom, 'org invite ag-h --org yulan --kind agent --role member').exitCode, 0);
  const grantAg = sh(s, tom, `org members grant ag-h --org yulan --workspace ${WYC} --kind agent --role member`);
  s.seats!.push({ seat_id: 's-h', workspace_id: WC, principal_id: String(grantAg.payload.agent_principal_id), agent_identity_id: 'ag-h', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'h-h', seat_id: 's-h', workspace_id: WC, revoked_at: null });
  eq(rc(s, A('ag-h', undefined, 'h-h'), 'workspace_join', { workspace: yr }), 'WORKSPACE_SEAT_MISMATCH');
  const revAg = sh(s, tom, `org members revoke ag-h --org yulan --workspace ${WYC} --kind agent`);
  deq([revAg.payload.closed_seat_ids, revAg.payload.closed_handle_ids], [['s-h'], ['h-h']]);
  for (const [c, cmd] of [[tom, `workspace members ${WYC}`], [U('u-alice'), `workspace join ${yr}`], [U('u-alice'), `workspace leave ${yr}`], [tom, `workspace move ${yr} --to-org acme`]] as const) eq(sh(s, c, cmd).exitCode, 0);
  eq(s.workspaces.find((w) => w.slug === 'research')?.org_id, OA);
});

test('channels', () => {
  const s = makeFixture(), tom = U('u-tom'), bob = U('u-bob'), guest = U('u-guest'), argon = A(AG, CN), shC = (c: Ctx, sub: string) => sh(s, c, `channel ${sub} --workspace ${WYC}`), rcC = (c: Ctx, t: string, channel: string, a: Record<string, unknown>) => rc(s, c, t, { workspace: WYC, channel, ...a });
  mcp(s, tom, 'org_assign_workspace_member', { org: 'yulan', workspace: 'core', principal_id: 'u-guest', role: 'guest' });
  mcp(s, tom, 'org_assign_workspace_member', { org: 'yulan', workspace: 'ops', principal_id: 'u-bob', role: 'guest' });
  deq([rCode(shC(guest, 'create g1').payload), rCode(sh(s, bob, 'channel create g2 --workspace yulan/ops').payload)], ['CHANNEL_CREATE_FORBIDDEN', 'CHANNEL_CREATE_FORBIDDEN']);
  const privId = (shC(argon, 'create war-room --visibility private --topic Sev-1').payload.channel as { channel_id: string }).channel_id;
  deq([(shC(tom, 'members war-room').payload.members as unknown[]).length, shC(tom, 'notify mentions --channel war-room').exitCode], [2, 0]);
  eq(s.channelMemberships.find((m) => m.channel_id === privId && m.principal_id === 'u-tom')?.role, 'owner');
  ok(!(shC(bob, 'list').payload.channels as Array<{ slug: string }>).some((c) => c.slug === 'war-room'));
  deq(['join war-room', 'add-member --channel war-room --principal u-bob', 'topic Resolved --channel war-room', 'notify mentions --channel war-room'].map((c, i) => shC(i === 1 ? tom : bob, c).exitCode), [1, 0, 0, 0]);
  deq([
    rcC(bob, 'channel_add_member', 'war-room', { principal_id: 'u-bob', role: 'owner' }),
    rcC(bob, 'channel_add_member', 'general', { principal_id: 'u-bob', role: 'owner' }),
    rcC(bob, 'channel_remove_member', 'general', { principal_id: 'u-tom' }),
    rcC(tom, 'channel_rename', 'general', { visibility: 'private' }),
  ], ['PRIVATE_CHANNEL_INVITE_REQUIRED', 'CHANNEL_ADMIN_REQUIRED', 'CHANNEL_ADMIN_REQUIRED', 'DEFAULT_CHANNEL_MUST_BE_PUBLIC']);
  s.signals!.push({ signal_id: 'sig-gen-1', workspace_id: WC, channel_id: 'c-yg' });
  eq(rcC(tom, 'channel_rename', 'general', { visibility: 'private' }), 'CHANNEL_HAS_PUBLIC_HISTORY');
  for (const [c, sub] of [[bob, 'leave general'], [bob, 'archive war-room'], [guest, 'archive general'], [guest, 'topic B --channel general'], [tom, 'archive general'], [tom, 'rename m --channel general']] as const) eq(shC(c, sub).exitCode, 1);
  deq([shC(tom, 'remove-member u-bob --channel war-room').exitCode, shC(tom, 'archive war-room').exitCode, parseCli(['cswarm', 'org', 'list', '--json']).tool], [0, 0, 'org_list']);
  ok(s.channels.find((c) => c.channel_id === privId)?.archived_at && /Identity: ag-argon[\s\S]*Org yulan/.test(sh(s, argon, 'whoami').stdout));
});
