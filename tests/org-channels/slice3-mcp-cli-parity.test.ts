import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type CliCallerContext,
  effCallerOrgRole,
  executeOrgChannelsCli,
  formatOrgChannelRefusal,
  parseOrgChannelsCliArgs,
  resetDefaultOrgChannelCliState,
} from '../../src/cloud/org-channels-cli.js';
import {
  ORG_CHANNEL_MCP_TOOLS,
  ORG_CHANNEL_TOOL_NAMES,
  type OrgChannelSlice3State,
  executeMultiOrgWhoami as whoami,
  executeOrgChannelMcpTool as mcp,
  isOrgChannelToolName,
  resolveMcpOrgWorkspaceChannel as resSel,
  validateOrgChannelToolArguments as valArgs,
} from '../../supabase/functions/mcp/org-channels-tools.js';
import type { OrgRole, PrincipalKind } from '../../src/protocol/org-channels-contract.js';

const { equal: eq, deepEqual: deq, ok } = assert;
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
  const cm = (principal_kind: PrincipalKind, principal_id: string, role: 'owner' | 'member') => ({ channel_id: 'ch-yulan-sec', workspace_id: WC, principal_kind, principal_id, role, notify_pref: 'all' as const, joined_at: NOW, revoked_at: null });
  return {
    privateChannelsEnabled: true,
    organizations: [org(OY, 'yulan', 'Yulan Ventures'), org(OA, 'acme', 'Acme Labs')],
    orgMemberships: ([
      [OY, 'user', 'u-tom', 'owner'], [OY, 'user', 'u-alice', 'admin'], [OY, 'user', 'u-bob', 'member'],
      [OY, 'user', 'u-guest', 'guest'], [OY, 'agent', 'ag-argon', 'admin'],
      [OA, 'user', 'u-tom', 'owner'], [OA, 'agent', 'ag-argon', 'member'],
    ] as const).map(om),
    workspaces: [ws(WC, OY, 'core', 'Yulan Core'), ws(WO, OY, 'ops', 'Yulan Ops'), ws(WA, OA, 'ops', 'Acme Ops')],
    workspaceGrants: ([
      [WC, OY, 'user', 'u-tom', 'owner'], [WC, OY, 'user', 'u-alice', 'admin'],
      [WC, OY, 'user', 'u-bob', 'member'], [WC, OY, 'agent', 'ag-argon', 'admin'],
      [WO, OY, 'user', 'u-tom', 'owner'], [WO, OY, 'agent', 'ag-argon', 'admin'],
      [WA, OA, 'user', 'u-tom', 'owner'], [WA, OA, 'agent', 'ag-argon', 'member'],
    ] as const).map(wg),
    channels: [ch('ch-yulan-gen', WC, OY, 'general'), ch('ch-yulan-sec', WC, OY, 'security', 'private'), ch('ch-yulan-ops-gen', WO, OY, 'general'), ch('ch-acme-gen', WA, OA, 'general')],
    channelMemberships: [cm('user', 'u-tom', 'owner'), cm('agent', 'ag-argon', 'member')],
    agentIdentities: [{ id: 'ag-argon', owner_user_id: 'u-tom', display_name: 'Argon', created_at: NOW }],
    agentPrincipals: [], seats: [], seatHandles: [],
    connectionPolicies: [{ connection_id: 'conn-argon', default_org_id: OY, default_workspace_id: WC, revoked_at: null }],
    fileChannelBindings: [{ file_id: 'file-sec-1', workspace_id: WC, channel_id: 'ch-yulan-sec' }],
    signals: [{ signal_id: 'sig-sec-1', workspace_id: WC, channel_id: 'ch-yulan-sec', thread_id: 'thr-sec-1' }],
  };
}

test('MCP catalog exposes 34 tools with strict schemas and runtime validation', () => {
  eq(ORG_CHANNEL_TOOL_NAMES.length, 34);
  eq(ORG_CHANNEL_MCP_TOOLS.length, 34);
  for (const t of ORG_CHANNEL_MCP_TOOLS) for (const sel of ['seat', 'seat_id', 'org', 'workspace', 'channel']) ok(sel in t.inputSchema.properties);
  const inv = ORG_CHANNEL_MCP_TOOLS.find((t) => t.name === 'org_invite_member')!;
  deq(inv.inputSchema.properties.workspace_ids, { type: 'array', items: { type: 'string' } });
  deq(inv.inputSchema.properties.request_approval, { type: 'boolean' });
  deq(ORG_CHANNEL_MCP_TOOLS.find((t) => t.name === 'whoami')!.inputSchema.properties.allowed_org_ids, { type: 'array', items: { type: 'string' } });

  assert.throws(() => valArgs('unknown_tool', {}), /Unknown org\/channel tool/);
  assert.throws(() => valArgs('org_create', { slug: 'only-slug' }), /Missing required argument "display_name"/);
  for (const [t, bad] of [
    ['org_set_member_role', { principal_id: 'u-bob', role: 'superadmin' }],
    ['channel_add_member', { principal_id: 'u-bob', role: 'admin' }],
    ['channel_create', { slug: 'ops', visibility: 'secret' }],
    ['channel_create', { slug: 'ops', join_policy: 'magic' }],
    ['channel_set_notify_pref', { notify_pref: 'loud' }],
    ['org_move_workspace', { target_org: 'acme', transfer_members: 'some' }],
    ['org_confirm_action', { approval_id: 'apr_1', decision: 'typo' }],
    ['org_invite_member', { workspace_ids: 'not-array' }],
    ['org_delete', { confirm_slug: 'yulan', request_approval: 'yes' }],
  ] as const) assert.throws(() => valArgs(t, bad), /INVALID_ARGUMENTS/);
});

test('Multi-org whoami, discover, selector checks, and CLI shared state', () => {
  const s = makeFixture(), caller = A('ag-argon', 'conn-argon');
  const pre = whoami(s, caller, {});
  eq(pre.ok, true);
  if (!pre.ok) return;
  eq(pre.active_seat, null);
  eq(pre.organizations[0]?.role, 'admin');
  eq(pre.organizations[1]?.role, 'member');
  eq((s.agentPrincipals?.length ?? 0) + (s.seats?.length ?? 0), 0);

  eq(rCode(whoami(s, caller, { org: 'yulan', workspace: 'acme/ops' }) as Record<string, unknown>), 'WORKSPACE_SEAT_MISMATCH');
  eq(rCode(whoami(s, U('u-bob'), { workspace: 'yulan/core', channel: 'security' }) as Record<string, unknown>), 'CHANNEL_ACCESS_DENIED');

  deq(JSON.parse(sh(s, caller, 'cswarm whoami --json').stdout), pre);
  const disc = mcp(s, caller, 'discover', {});
  eq(disc.total_organizations, 2);
  eq(disc.total_workspaces, 3);
  eq(disc.total_channels, 4);
  deq(JSON.parse(sh(s, caller, 'discover --json').stdout), disc);

  s.seats!.push({ seat_id: 'seat-1', workspace_id: 'ws-yulan-core', principal_id: 'ap-argon', agent_identity_id: 'ag-argon', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'seat_h_live', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: null });
  s.connectionPolicies![0]!.default_org_id = 'org-deleted';
  s.connectionPolicies![0]!.default_workspace_id = 'ws-deleted';

  const post = whoami(s, A('ag-argon', 'conn-argon', 'seat_h_live'), {});
  eq(post.ok, true);
  if (post.ok) {
    eq(post.active_seat?.seat_id, 'seat-1');
    eq(post.default_org_id, null);
    eq(post.default_workspace_id, null);
  }

  resetDefaultOrgChannelCliState();
  eq(executeOrgChannelsCli(['org', 'create', 'solo-org', '--name', 'Solo']).exitCode, 0);
  eq((JSON.parse(executeOrgChannelsCli(['org', 'list', '--json']).stdout).organizations as Array<{ slug: string }>)[0]?.slug, 'solo-org');
});

test('Universal selector precedence, conflicts, and executable refusal hints', () => {
  const s = makeFixture(), caller = A('ag-argon', 'conn-argon');
  s.seats!.push({ seat_id: 'seat-1', workspace_id: 'ws-yulan-core', principal_id: 'ap-argon', agent_identity_id: 'ag-argon', revoked_at: null });
  s.seatHandles!.push(
    { handle_id: 'seat_h_live', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: null },
    { handle_id: 'seat_h_revoked', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: NOW },
  );

  eq((resSel(s, caller, {}) as { source?: string }).source, 'connection_default');
  eq((resSel(s, caller, { seat: 'seat_h_live' }) as { source?: string }).source, 'seat');
  eq(rCode(resSel(s, caller, { seat: 'seat_h_revoked' })), 'WORKSPACE_ACCESS_DENIED');
  eq(rCode(resSel(s, caller, { seat: 'seat_h_live', workspace: 'acme/ops' })), 'WORKSPACE_SEAT_MISMATCH');
  eq(rCode(mcp(s, caller, 'org_get', { org: 'yulan', workspace: 'acme/ops' })), 'WORKSPACE_SEAT_MISMATCH');

  const ambig = resSel(s, A('ag-argon'), { workspace: 'ops' });
  if (!ambig.ok) {
    eq(ambig.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    deq(ambig.refusal.choices?.map((c) => c.selector), ['yulan/ops', 'acme/ops']);
    assert.match(formatOrgChannelRefusal(ambig.refusal), /Matching workspaces: yulan\/ops, acme\/ops/);
    ok(isOrgChannelToolName(ambig.refusal.mcp_tool));
  }

  const sigDenied = resSel(s, U('u-bob'), { workspace: 'yulan/core', signal_id: 'sig-sec-1' });
  if (!sigDenied.ok) {
    eq(sigDenied.refusal.code, 'CHANNEL_ACCESS_DENIED');
    eq(sigDenied.refusal.mcp_tool, 'channel_add_member');
    eq(parseOrgChannelsCliArgs(sigDenied.refusal.grant_command_hint.split(' ')).tool, sigDenied.refusal.mcp_tool);
  }
  eq(rCode(resSel(s, U('u-bob'), { workspace: 'yulan/core', file_id: 'file-sec-1' })), 'CHANNEL_ACCESS_DENIED');
});

test('Org CRUD, owner protection, agent role cap, approvals, and logos', () => {
  const s = makeFixture(), tom = U('u-tom', 'conn-tom'), alice = U('u-alice'), argon = A('ag-argon', 'conn-argon');
  eq(sh(s, tom, 'org list').exitCode, 0);
  eq(sh(s, tom, 'org get yulan').exitCode, 0);

  const newOrgId = (sh(s, tom, 'org create ridge --name Ridge').payload.organization as { id: string }).id;
  eq(effCallerOrgRole(s, A('ag-argon'), newOrgId), 'member');
  eq(rCode(mcp(s, argon, 'org_update', { org: 'ridge', display_name: 'Hijacked' })), 'ORG_ADMIN_REQUIRED');

  const dirtySvg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>evil()</script><foreignObject><div>bad</div></foreignObject><image href="//evil.example/x.png"/><circle r="10" style="fill:url(//evil.example/p)"/></svg>';
  eq(cli(s, tom, ['org', 'logo', 'upload', '--org', 'ridge', '--content-type', 'image/svg+xml', '--svg', dirtySvg]).exitCode, 0);
  const logo = s.orgLogos?.[newOrgId]!;
  ok(!logo.sanitized_svg?.includes('<script>') && !logo.sanitized_svg?.includes('onload=') && !logo.sanitized_svg?.includes('foreignObject') && !logo.sanitized_svg?.includes('//evil.example'));
  eq(logo.rendition_blobs?.['64'].width, 64);
  eq(logo.rendition_blobs?.['256'].sha256.length, 64);

  eq(rCode(mcp(s, tom, 'org_logo_upload', { org: 'ridge', content_type: 'image/png', data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') })), 'INVALID_LOGO_FORMAT');
  eq(sh(s, tom, 'org logo remove --org ridge').exitCode, 0);

  eq(sh(s, argon, 'org switch acme --workspace ops').exitCode, 0);
  eq(s.connectionPolicies![0]!.default_org_id, 'org-acme');
  eq(sh(s, tom, 'org update ridge --name RidgeInc').exitCode, 0);

  eq(rCode(mcp(s, alice, 'org_invite_member', { org: 'yulan', principal_id: 'u-tom', role: 'member' })), 'ORG_OWNER_ROLE_REQUIRED');
  eq(rCode(mcp(s, tom, 'org_invite_member', { org: 'yulan', principal_id: 'u-tom', role: 'admin' })), 'LAST_ORG_OWNER_REQUIRED');

  eq(sh(s, tom, 'org invite carol@yulan.io --org yulan --principal u-carol --role guest --workspace ws-yulan-core').exitCode, 0);
  eq((sh(s, tom, 'org members --org yulan --kind guest').payload.members as unknown[]).length, 2);
  eq(sh(s, tom, 'org role u-carol member --org yulan').exitCode, 0);
  eq(sh(s, tom, 'org remove u-carol --org yulan').exitCode, 0);
  eq(rCode(mcp(s, tom, 'org_set_member_role', { org: 'yulan', principal_id: 'u-tom', role: 'admin' })), 'CANNOT_REMOVE_LAST_ORG_OWNER');

  const badReq = sh(s, argon, 'org set-role u-tom admin --org yulan --request-approval');
  assert.match(badReq.stdout, /pending_owner_approval/);
  const badAprId = (badReq.payload.approval as { approval_id: string }).approval_id;
  eq(mcp(s, tom, 'org_confirm_action', { approval_id: badAprId, decision: 'approve' }).ok, false);
  eq(s.approvalRequests?.find((a) => a.approval_id === badAprId)?.state, 'pending');

  const delReq = sh(s, argon, 'org delete ridge --confirm ridge');
  eq(delReq.payload.status, 'approval_required');
  assert.match(delReq.stdout, /pending_owner_approval/);
  const aprId = (delReq.payload.approval as { approval_id: string }).approval_id;
  eq(mcp(s, tom, 'org_confirm_action', { approval_id: aprId, decision: 'typo' }).ok, false);
  eq(s.approvalRequests?.find((a) => a.approval_id === aprId)?.state, 'pending');
  eq(sh(s, tom, `org confirm ${aprId} --approve`).payload.status, 'approved');
  ok(s.organizations.find((o) => o.id === newOrgId)?.archived_at);
});

test('Workspace grants, seat mismatch on join, revocation cascade, and move', () => {
  const s = makeFixture(), tom = U('u-tom'), guest = U('u-guest');
  eq(sh(s, tom, 'workspace list --org yulan').exitCode, 0);
  const defCh = sh(s, tom, 'workspace create research --org yulan --name Research').payload.default_channel as { slug: string; is_default?: boolean };
  eq(defCh.slug, 'general');
  eq(defCh.is_default, true);
  eq(rCode(sh(s, guest, 'workspace join yulan/research').payload), 'GUEST_WORKSPACE_GRANT_REQUIRED');

  eq(sh(s, tom, 'org invite ag-helper --org yulan --kind agent --role member').exitCode, 0);
  const grantAg = sh(s, tom, 'org members grant ag-helper --org yulan --workspace yulan/core --kind agent --role member');
  s.seats!.push({ seat_id: 'seat-helper', workspace_id: 'ws-yulan-core', principal_id: String(grantAg.payload.agent_principal_id), agent_identity_id: 'ag-helper', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'h-helper', seat_id: 'seat-helper', workspace_id: 'ws-yulan-core', revoked_at: null });

  eq(rCode(mcp(s, A('ag-helper', undefined, 'h-helper'), 'workspace_join', { workspace: 'yulan/research' })), 'WORKSPACE_SEAT_MISMATCH');

  const revAg = sh(s, tom, 'org members revoke ag-helper --org yulan --workspace yulan/core --kind agent');
  deq(revAg.payload.closed_seat_ids, ['seat-helper']);
  deq(revAg.payload.closed_handle_ids, ['h-helper']);
  eq(sh(s, tom, 'workspace members yulan/core').exitCode, 0);
  eq(sh(s, U('u-alice'), 'workspace join yulan/research').exitCode, 0);
  eq(sh(s, U('u-alice'), 'workspace leave yulan/research').exitCode, 0);
  eq(sh(s, tom, 'workspace move yulan/research --to-org acme').exitCode, 0);
  eq(s.workspaces.find((w) => w.slug === 'research')?.org_id, 'org-acme');
});

test('Channel lifecycle, private isolation, notify role preservation, and #general', () => {
  const s = makeFixture(), tom = U('u-tom'), bob = U('u-bob'), guest = U('u-guest'), argon = A('ag-argon', 'conn-argon');
  mcp(s, tom, 'org_assign_workspace_member', { org: 'yulan', workspace: 'core', principal_id: 'u-guest', role: 'guest' });
  eq(rCode(sh(s, guest, 'channel create guest-room --workspace yulan/core').payload), 'CHANNEL_CREATE_FORBIDDEN');

  const privId = (sh(s, argon, 'channel create war-room --workspace yulan/core --visibility private --topic Sev-1').payload.channel as { channel_id: string }).channel_id;
  eq((sh(s, tom, 'channel members war-room --workspace yulan/core').payload.members as unknown[]).length, 2);

  eq(sh(s, tom, 'channel notify mentions --workspace yulan/core --channel war-room').exitCode, 0);
  eq(s.channelMemberships.find((m) => m.channel_id === privId && m.principal_id === 'u-tom')?.role, 'owner');

  ok(!(sh(s, bob, 'channel list --workspace yulan/core').payload.channels as Array<{ slug: string }>).some((c) => c.slug === 'war-room'));
  eq(sh(s, bob, 'channel join war-room --workspace yulan/core').exitCode, 1);
  eq(sh(s, tom, 'channel add-member --workspace yulan/core --channel war-room --principal u-bob').exitCode, 0);
  eq(sh(s, bob, 'channel topic Resolved --workspace yulan/core --channel war-room').exitCode, 0);
  eq(sh(s, bob, 'channel notify mentions --workspace yulan/core --channel war-room').exitCode, 0);

  eq(rCode(mcp(s, tom, 'channel_rename', { workspace: 'yulan/core', channel: 'general', visibility: 'private' })), 'DEFAULT_CHANNEL_MUST_BE_PUBLIC');
  s.signals!.push({ signal_id: 'sig-gen-1', workspace_id: 'ws-yulan-core', channel_id: 'ch-yulan-gen' });
  eq(rCode(mcp(s, tom, 'channel_rename', { workspace: 'yulan/core', channel: 'general', visibility: 'private' })), 'CHANNEL_HAS_PUBLIC_HISTORY');

  eq(sh(s, bob, 'channel leave general --workspace yulan/core').exitCode, 1);
  eq(sh(s, tom, 'channel archive general --workspace yulan/core').exitCode, 1);
  eq(sh(s, tom, 'channel rename main --workspace yulan/core --channel general').exitCode, 1);

  eq(sh(s, tom, 'channel remove-member u-bob --workspace yulan/core --channel war-room').exitCode, 0);
  eq(sh(s, tom, 'channel archive war-room --workspace yulan/core').exitCode, 0);
  ok(s.channels.find((c) => c.channel_id === privId)?.archived_at);
  eq(parseOrgChannelsCliArgs(['cswarm', 'org', 'list', '--json']).tool, 'org_list');
});
