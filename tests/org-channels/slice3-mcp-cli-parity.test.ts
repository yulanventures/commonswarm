import assert from 'node:assert/strict';
import test from 'node:test';
import { type CliCallerContext, effCallerOrgRole, executeOrgChannelsCli, formatOrgChannelRefusal, parseOrgChannelsCliArgs, resetDefaultOrgChannelCliState } from '../../src/cloud/org-channels-cli.js';
import { ORG_CHANNEL_MCP_TOOLS, ORG_CHANNEL_TOOL_NAMES, type OrgChannelSlice3State, executeMultiOrgWhoami as whoami, executeOrgChannelMcpTool as mcp, isOrgChannelToolName, resolveMcpOrgWorkspaceChannel as resSel, validateOrgChannelToolArguments as valArgs } from '../../supabase/functions/mcp/org-channels-tools.js';
import type { OrgRole, PrincipalKind } from '../../src/protocol/org-channels-contract.js';

const eq = (a: unknown, b: unknown) => assert.equal(a, b);
const deq = (a: unknown, b: unknown) => assert.deepEqual(a, b);
const ok = (a: unknown) => assert.ok(a);
const NOW = '2026-10-20T12:00:00.000Z';
const U = (principal_id: string, connection_id?: string): CliCallerContext => ({ principal_kind: 'user', principal_id, connection_id });
const A = (principal_id: string, connection_id?: string, seat?: string): CliCallerContext => ({ principal_kind: 'agent', principal_id, connection_id, seat });
const cli = (state: OrgChannelSlice3State, caller: CliCallerContext, argv: string[]) => executeOrgChannelsCli(argv, { state, caller });
const sh = (state: OrgChannelSlice3State, caller: CliCallerContext, cmd: string) => cli(state, caller, cmd.split(' '));
const rCode = (r: Record<string, unknown>) => (r.refusal as { code: string }).code;

function makeFixture(): OrgChannelSlice3State {
  const OY = 'org-yulan', OA = 'org-acme', WC = 'ws-yulan-core', WO = 'ws-yulan-ops', WA = 'ws-acme-ops';
  const org = (id: string, slug: string, display_name: string) => ({ id, slug, display_name, logo_object_key: null, logo_updated_at: null, created_by: 'u-tom', created_at: NOW, updated_at: NOW, archived_at: null });
  const om = ([org_id, principal_kind, principal_id, role]: readonly [string, PrincipalKind, string, OrgRole]) => ({ org_id, principal_kind, principal_id, role, created_at: NOW, revoked_at: null });
  const ws = (workspace_id: string, org_id: string, slug: string, name: string) => ({ workspace_id, org_id, slug, name, archived_at: null });
  const wg = ([workspace_id, org_id, principal_kind, principal_id, role]: readonly [string, string, PrincipalKind, string, OrgRole]) => ({ workspace_id, org_id, principal_kind, principal_id, role, created_at: NOW, revoked_at: null });
  const ch = (channel_id: string, workspace_id: string, org_id: string, slug: string, visibility: 'workspace' | 'private' = 'workspace') => ({
    channel_id, workspace_id, org_id, slug, visibility, join_policy: (visibility === 'private' ? 'invite_only' : 'open') as 'open' | 'invite_only', ...(slug === 'general' ? { is_default: true } : {}), created_at: NOW,
  });
  return {
    privateChannelsEnabled: true, organizations: [org(OY, 'yulan', 'Yulan'), org(OA, 'acme', 'Acme')],
    orgMemberships: ([[OY, 'user', 'u-tom', 'owner'], [OY, 'user', 'u-alice', 'admin'], [OY, 'user', 'u-bob', 'member'], [OY, 'user', 'u-guest', 'guest'], [OY, 'agent', 'ag-argon', 'admin'], [OA, 'user', 'u-tom', 'owner'], [OA, 'agent', 'ag-argon', 'member']] as const).map(om),
    workspaces: [ws(WC, OY, 'core', 'Core'), ws(WO, OY, 'ops', 'Ops'), ws(WA, OA, 'ops', 'Ops')],
    workspaceGrants: ([[WC, OY, 'user', 'u-tom', 'owner'], [WC, OY, 'user', 'u-alice', 'admin'], [WC, OY, 'user', 'u-bob', 'member'], [WC, OY, 'agent', 'ag-argon', 'admin'], [WO, OY, 'user', 'u-tom', 'owner'], [WO, OY, 'agent', 'ag-argon', 'admin'], [WA, OA, 'user', 'u-tom', 'owner'], [WA, OA, 'agent', 'ag-argon', 'member']] as const).map(wg),
    channels: [ch('ch-yulan-gen', WC, OY, 'general'), ch('ch-yulan-sec', WC, OY, 'security', 'private'), ch('ch-yulan-ops-gen', WO, OY, 'general'), ch('ch-acme-gen', WA, OA, 'general')],
    channelMemberships: ([['user', 'u-tom', 'owner'], ['agent', 'ag-argon', 'member']] as const).map(([principal_kind, principal_id, role]) => ({ channel_id: 'ch-yulan-sec', workspace_id: WC, principal_kind, principal_id, role, notify_pref: 'all' as const, joined_at: NOW, revoked_at: null })),
    agentIdentities: [{ id: 'ag-argon', owner_user_id: 'u-tom', display_name: 'Argon', created_at: NOW }],
    agentPrincipals: [], seats: [], seatHandles: [],
    connectionPolicies: [{ connection_id: 'conn-argon', default_org_id: OY, default_workspace_id: WC, revoked_at: null }],
    fileChannelBindings: [{ file_id: 'file-sec-1', workspace_id: WC, channel_id: 'ch-yulan-sec', bound_by_kind: 'user', created_at: NOW }],
    signals: [{ signal_id: 'sig-sec-1', workspace_id: WC, channel_id: 'ch-yulan-sec', thread_id: 'thr-sec-1' }],
  };
}

test('34 MCP tools with strict schemas and validation', () => {
  deq([ORG_CHANNEL_TOOL_NAMES.length, ORG_CHANNEL_MCP_TOOLS.length], [34, 34]);
  for (const t of ORG_CHANNEL_MCP_TOOLS) for (const sel of ['seat', 'seat_id', 'org', 'workspace', 'channel']) ok(sel in t.inputSchema.properties);
  const inv = ORG_CHANNEL_MCP_TOOLS.find((t) => t.name === 'org_invite_member')!, arrT = { type: 'array', items: { type: 'string' } };
  deq([inv.inputSchema.properties.workspace_ids, inv.inputSchema.properties.request_approval, ORG_CHANNEL_MCP_TOOLS.find((t) => t.name === 'whoami')!.inputSchema.properties.allowed_org_ids], [arrT, { type: 'boolean' }, arrT]);
  assert.throws(() => valArgs('unknown_tool', {}), /Unknown org\/channel tool/);
  assert.throws(() => valArgs('org_create', { slug: 'only' }), /Missing required argument "display_name"/);
  for (const [t, bad] of [
    ['org_set_member_role', { principal_id: 'u', role: 'x' }], ['channel_add_member', { principal_id: 'u', role: 'admin' }],
    ['channel_create', { slug: 's', visibility: 'x' }], ['channel_create', { slug: 's', join_policy: 'x' }],
    ['channel_set_notify_pref', { notify_pref: 'x' }], ['org_move_workspace', { target_org: 'a', transfer_members: 'x' }],
    ['org_confirm_action', { approval_id: 'a', decision: 'x' }], ['org_invite_member', { workspace_ids: 'x' }],
    ['org_delete', { confirm_slug: 'y', request_approval: 'x' }],
  ] as const) assert.throws(() => valArgs(t, bad), /INVALID_ARGUMENTS/);
});

test('Multi-org whoami, discover, selectors, and CLI state', () => {
  const s = makeFixture(), c = A('ag-argon', 'conn-argon'), pre = whoami(s, c, {});
  if (!pre.ok) assert.fail('whoami');
  deq([pre.active_seat, pre.organizations[0]?.role, pre.organizations[1]?.role, (s.agentPrincipals?.length ?? 0) + (s.seats?.length ?? 0)], [null, 'admin', 'member', 0]);
  deq([rCode(whoami(s, c, { org: 'yulan', workspace: 'acme/ops' }) as Record<string, unknown>), rCode(whoami(s, U('u-bob'), { workspace: 'yulan/core', channel: 'security' }) as Record<string, unknown>)], ['WORKSPACE_SEAT_MISMATCH', 'CHANNEL_ACCESS_DENIED']);
  deq(JSON.parse(sh(s, c, 'cswarm whoami --json').stdout), pre);
  const disc = mcp(s, c, 'discover', {});
  deq([disc.total_organizations, disc.total_workspaces, disc.total_channels, JSON.parse(sh(s, c, 'discover --json').stdout)], [2, 3, 4, disc]);

  s.seats!.push({ seat_id: 'seat-1', workspace_id: 'ws-yulan-core', principal_id: 'ap-argon', agent_identity_id: 'ag-argon', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'seat_h_live', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: null });
  Object.assign(s.connectionPolicies![0]!, { default_org_id: 'org-del', default_workspace_id: 'ws-del' });
  const post = whoami(s, A('ag-argon', 'conn-argon', 'seat_h_live'), {});
  if (!post.ok) assert.fail('post');
  deq([post.active_seat?.seat_id, post.default_org_id, post.default_workspace_id], ['seat-1', null, null]);

  resetDefaultOrgChannelCliState();
  eq(executeOrgChannelsCli(['org', 'create', 'solo-org', '--name', 'Solo']).exitCode, 0);
  eq((JSON.parse(executeOrgChannelsCli(['org', 'list', '--json']).stdout).organizations as Array<{ slug: string }>)[0]?.slug, 'solo-org');
});

test('Universal selector precedence, conflicts, and refusal hints', () => {
  const s = makeFixture(), caller = A('ag-argon', 'conn-argon');
  s.seats!.push({ seat_id: 'seat-1', workspace_id: 'ws-yulan-core', principal_id: 'ap-argon', agent_identity_id: 'ag-argon', revoked_at: null });
  s.seatHandles!.push(
    { handle_id: 'seat_h_live', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: null },
    { handle_id: 'seat_h_revoked', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: NOW },
  );
  deq([(resSel(s, caller, {}) as { source?: string }).source, (resSel(s, caller, { seat: 'seat_h_live' }) as { source?: string }).source], ['connection_default', 'seat']);
  deq([
    rCode(resSel(s, caller, { seat: 'seat_h_revoked' })),
    rCode(resSel(s, caller, { seat: 'seat_h_live', seat_id: 'seat-other' })),
    rCode(resSel(s, caller, { seat: 'seat_h_live', workspace: 'acme/ops' })),
    rCode(mcp(s, caller, 'org_get', { org: 'yulan', workspace: 'acme/ops' })),
  ], ['WORKSPACE_ACCESS_DENIED', 'WORKSPACE_SEAT_MISMATCH', 'WORKSPACE_SEAT_MISMATCH', 'WORKSPACE_SEAT_MISMATCH']);
  const ambig = resSel(s, A('ag-argon'), { workspace: 'ops' });
  if (!ambig.ok) {
    deq([ambig.refusal.code, ambig.refusal.choices?.map((c) => c.selector), isOrgChannelToolName(ambig.refusal.mcp_tool)], ['AMBIGUOUS_WORKSPACE_SELECTOR', ['yulan/ops', 'acme/ops'], true]);
    assert.match(formatOrgChannelRefusal(ambig.refusal), /Matching workspaces: yulan\/ops, acme\/ops/);
  }
  const sigD = resSel(s, U('u-bob'), { workspace: 'yulan/core', signal_id: 'sig-sec-1' });
  if (!sigD.ok) deq([sigD.refusal.code, sigD.refusal.mcp_tool, parseOrgChannelsCliArgs(sigD.refusal.grant_command_hint.split(' ')).tool], ['CHANNEL_ACCESS_DENIED', 'channel_add_member', 'channel_add_member']);
  eq(rCode(resSel(s, U('u-bob'), { workspace: 'yulan/core', file_id: 'file-sec-1' })), 'CHANNEL_ACCESS_DENIED');
});

test('Org CRUD, owner protection, agent role cap, approvals, and logos', () => {
  const s = makeFixture(), tom = U('u-tom', 'conn-tom'), alice = U('u-alice'), argon = A('ag-argon', 'conn-argon');
  deq([sh(s, tom, 'org list').exitCode, sh(s, tom, 'org get yulan').exitCode], [0, 0]);
  const newOrgId = (sh(s, tom, 'org create ridge --name Ridge').payload.organization as { id: string }).id;
  deq([effCallerOrgRole(s, A('ag-argon'), newOrgId), rCode(mcp(s, argon, 'org_update', { org: 'ridge', display_name: 'Hijacked' }))], ['member', 'ORG_ADMIN_REQUIRED']);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>evil()</script><foreignObject><div>bad</div></foreignObject><image href="//evil.example/x.png"/><a href="&#x6a;avascript:alert(1)"><circle r="10" style="fill:url(&#x2f;&#x2f;evil.example/p)"/></a></svg>';
  eq(cli(s, tom, ['org', 'logo', 'upload', '--org', 'ridge', '--content-type', 'image/svg+xml', '--svg', svg]).exitCode, 0);
  const logo = s.orgLogos?.[newOrgId]!, b64 = logo.rendition_blobs?.['64']!;
  ok(['<script>', 'onload=', 'foreignObject', 'evil.example', '&#x6a;'].every((bad) => !logo.sanitized_svg?.includes(bad)));
  deq([b64.width, Buffer.from(b64.data_base64, 'base64').subarray(8, 16).toString('ascii'), logo.rendition_blobs?.['256'].sha256.length], [64, 'WEBPVP8L', 64]);

  eq(rCode(mcp(s, tom, 'org_logo_upload', { org: 'ridge', content_type: 'image/png', data_base64: 'iVBORw==' })), 'INVALID_LOGO_FORMAT');
  deq([sh(s, tom, 'org logo remove --org ridge').exitCode, sh(s, argon, 'org switch acme --workspace ops').exitCode, sh(s, tom, 'org update ridge --name RidgeInc').exitCode], [0, 0, 0]);
  eq(s.connectionPolicies![0]!.default_org_id, 'org-acme');

  deq([
    rCode(mcp(s, alice, 'org_invite_member', { org: 'yulan', principal_id: 'u-tom', role: 'member' })),
    rCode(mcp(s, tom, 'org_invite_member', { org: 'yulan', principal_id: 'u-tom', role: 'admin' })),
    rCode(mcp(s, tom, 'org_invite_member', { org: 'yulan', principal_id: 'u-badws', role: 'member', workspace_ids: ['bad'] })),
  ], ['ORG_OWNER_ROLE_REQUIRED', 'LAST_ORG_OWNER_REQUIRED', 'WORKSPACE_ACCESS_DENIED']);
  ok(!s.orgMemberships.some((m) => m.principal_id === 'u-badws'));

  s.orgMemberships.push({ org_id: 'org-yulan', principal_kind: 'user', principal_id: 'u-co', role: 'owner', created_at: NOW, revoked_at: null });
  eq(mcp(s, U('u-co'), 'org_set_member_role', { org: 'yulan', principal_id: 'u-tom', role: 'guest' }).ok, true);
  deq([effCallerOrgRole(s, argon, 'org-yulan'), rCode(mcp(s, argon, 'org_set_member_role', { org: 'yulan', principal_id: 'u-tom', role: 'admin' }))], ['guest', 'ORG_ADMIN_REQUIRED']);
  eq(mcp(s, U('u-co'), 'org_set_member_role', { org: 'yulan', principal_id: 'u-tom', role: 'owner' }).ok, true);
  s.orgMemberships = s.orgMemberships.filter((m) => m.principal_id !== 'u-co');

  eq(sh(s, tom, 'org invite carol@yulan.io --org yulan --principal u-carol --role guest --workspace ws-yulan-core').exitCode, 0);
  deq([(sh(s, tom, 'org members --org yulan --kind guest').payload.members as unknown[]).length, sh(s, tom, 'org role u-carol member --org yulan').exitCode, sh(s, tom, 'org remove u-carol --org yulan').exitCode], [2, 0, 0]);
  eq(rCode(mcp(s, tom, 'org_set_member_role', { org: 'yulan', principal_id: 'u-tom', role: 'admin' })), 'CANNOT_REMOVE_LAST_ORG_OWNER');

  for (const [cmd, dec, end] of [['org set-role u-tom admin --org yulan --request-approval', 'approve', 'pending'], ['org delete ridge --confirm ridge', 'typo', 'approved']] as const) {
    const req = sh(s, argon, cmd), id = (req.payload.approval as { approval_id: string }).approval_id;
    assert.match(req.stdout, /pending_owner_approval/);
    deq([mcp(s, tom, 'org_confirm_action', { approval_id: id, decision: dec }).ok, s.approvalRequests?.find((a) => a.approval_id === id)?.state], [false, 'pending']);
    if (end === 'approved') eq(sh(s, tom, `org confirm ${id} --approve`).payload.status, 'approved');
  }
  ok(s.organizations.find((o) => o.id === newOrgId)?.archived_at);
});

test('Workspace grants, seat mismatch, cascade, and move', () => {
  const s = makeFixture(), tom = U('u-tom'), guest = U('u-guest');
  eq(sh(s, tom, 'workspace list --org yulan').exitCode, 0);
  const defCh = sh(s, tom, 'workspace create research --org yulan --name Research').payload.default_channel as { slug: string; is_default?: boolean };
  deq([defCh.slug, defCh.is_default, rCode(sh(s, guest, 'workspace join yulan/research').payload)], ['general', true, 'GUEST_WORKSPACE_GRANT_REQUIRED']);
  eq(sh(s, tom, 'org invite ag-h --org yulan --kind agent --role member').exitCode, 0);
  const grantAg = sh(s, tom, 'org members grant ag-h --org yulan --workspace yulan/core --kind agent --role member');
  s.seats!.push({ seat_id: 's-h', workspace_id: 'ws-yulan-core', principal_id: String(grantAg.payload.agent_principal_id), agent_identity_id: 'ag-h', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'h-h', seat_id: 's-h', workspace_id: 'ws-yulan-core', revoked_at: null });
  eq(rCode(mcp(s, A('ag-h', undefined, 'h-h'), 'workspace_join', { workspace: 'yulan/research' })), 'WORKSPACE_SEAT_MISMATCH');
  const revAg = sh(s, tom, 'org members revoke ag-h --org yulan --workspace yulan/core --kind agent');
  deq([revAg.payload.closed_seat_ids, revAg.payload.closed_handle_ids], [['s-h'], ['h-h']]);
  for (const [c, cmd] of [[tom, 'workspace members yulan/core'], [U('u-alice'), 'workspace join yulan/research'], [U('u-alice'), 'workspace leave yulan/research'], [tom, 'workspace move yulan/research --to-org acme']] as const) eq(sh(s, c, cmd).exitCode, 0);
  eq(s.workspaces.find((w) => w.slug === 'research')?.org_id, 'org-acme');
});

test('Channel lifecycle, private isolation, notify role, and #general', () => {
  const s = makeFixture(), tom = U('u-tom'), bob = U('u-bob'), guest = U('u-guest'), argon = A('ag-argon', 'conn-argon');
  mcp(s, tom, 'org_assign_workspace_member', { org: 'yulan', workspace: 'core', principal_id: 'u-guest', role: 'guest' });
  eq(rCode(sh(s, guest, 'channel create guest-room --workspace yulan/core').payload), 'CHANNEL_CREATE_FORBIDDEN');
  const privId = (sh(s, argon, 'channel create war-room --workspace yulan/core --visibility private --topic Sev-1').payload.channel as { channel_id: string }).channel_id;
  deq([(sh(s, tom, 'channel members war-room --workspace yulan/core').payload.members as unknown[]).length, sh(s, tom, 'channel notify mentions --workspace yulan/core --channel war-room').exitCode], [2, 0]);
  eq(s.channelMemberships.find((m) => m.channel_id === privId && m.principal_id === 'u-tom')?.role, 'owner');
  ok(!(sh(s, bob, 'channel list --workspace yulan/core').payload.channels as Array<{ slug: string }>).some((c) => c.slug === 'war-room'));
  deq(['channel join war-room', 'channel add-member --channel war-room --principal u-bob', 'channel topic Resolved --channel war-room', 'channel notify mentions --channel war-room'].map((c, i) => sh(s, i === 1 ? tom : bob, `${c} --workspace yulan/core`).exitCode), [1, 0, 0, 0]);
  eq(rCode(mcp(s, tom, 'channel_rename', { workspace: 'yulan/core', channel: 'general', visibility: 'private' })), 'DEFAULT_CHANNEL_MUST_BE_PUBLIC');
  s.signals!.push({ signal_id: 'sig-gen-1', workspace_id: 'ws-yulan-core', channel_id: 'ch-yulan-gen' });
  eq(rCode(mcp(s, tom, 'channel_rename', { workspace: 'yulan/core', channel: 'general', visibility: 'private' })), 'CHANNEL_HAS_PUBLIC_HISTORY');
  for (const [c, sub] of [[bob, 'leave general'], [bob, 'archive war-room'], [guest, 'archive general'], [guest, 'topic Blocked --channel general'], [tom, 'archive general'], [tom, 'rename main --channel general']] as const) eq(sh(s, c, `channel ${sub} --workspace yulan/core`).exitCode, 1);
  deq([sh(s, tom, 'channel remove-member u-bob --workspace yulan/core --channel war-room').exitCode, sh(s, tom, 'channel archive war-room --workspace yulan/core').exitCode], [0, 0]);
  ok(s.channels.find((c) => c.channel_id === privId)?.archived_at);
  assert.match(sh(s, argon, 'whoami').stdout, /Identity: ag-argon[\s\S]*Org yulan/);
  eq(parseOrgChannelsCliArgs(['cswarm', 'org', 'list', '--json']).tool, 'org_list');
});
