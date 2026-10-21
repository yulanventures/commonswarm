import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CliCallerContext,
  executeOrgChannelsCli,
  formatOrgChannelRefusal,
  parseOrgChannelsCliArgs,
} from '../../src/cloud/org-channels-cli.js';
import {
  ORG_CHANNEL_MCP_TOOLS,
  ORG_CHANNEL_TOOL_NAMES,
  type OrgChannelSlice3State,
  executeMultiOrgWhoami,
  executeOrgChannelMcpTool,
  resolveMcpOrgWorkspaceChannel,
  validateOrgChannelToolArguments,
} from '../../supabase/functions/mcp/org-channels-tools.js';
import type { OrgRole, PrincipalKind } from '../../src/protocol/org-channels-contract.js';

const NOW = '2026-10-20T12:00:00.000Z';
const cli = (state: OrgChannelSlice3State, caller: CliCallerContext, argv: string[]) =>
  executeOrgChannelsCli(argv, { state, caller });

function makeFixture(): OrgChannelSlice3State {
  const om = (org_id: string, principal_kind: PrincipalKind, principal_id: string, role: OrgRole) => ({
    org_id, principal_kind, principal_id, role, created_at: NOW, revoked_at: null,
  });
  const wg = (workspace_id: string, org_id: string, principal_kind: PrincipalKind, principal_id: string, role: OrgRole) => ({
    workspace_id, org_id, principal_kind, principal_id, role, created_at: NOW, revoked_at: null,
  });
  const ch = (channel_id: string, workspace_id: string, org_id: string, slug: string, visibility: 'workspace' | 'private' = 'workspace') => ({
    channel_id, workspace_id, org_id, slug, visibility, join_policy: (visibility === 'private' ? 'invite_only' : 'open') as 'open' | 'invite_only', created_at: NOW,
  });
  return {
    privateChannelsEnabled: true,
    organizations: [
      { id: 'org-yulan', slug: 'yulan', display_name: 'Yulan Ventures', logo_object_key: null, logo_updated_at: null, created_by: 'u-tom', created_at: NOW, updated_at: NOW, archived_at: null },
      { id: 'org-acme', slug: 'acme', display_name: 'Acme Labs', logo_object_key: null, logo_updated_at: null, created_by: 'u-tom', created_at: NOW, updated_at: NOW, archived_at: null },
    ],
    orgMemberships: [
      om('org-yulan', 'user', 'u-tom', 'owner'),
      om('org-yulan', 'user', 'u-alice', 'admin'),
      om('org-yulan', 'user', 'u-bob', 'member'),
      om('org-yulan', 'user', 'u-guest', 'guest'),
      om('org-yulan', 'agent', 'ag-argon', 'admin'),
      om('org-acme', 'user', 'u-tom', 'owner'),
      om('org-acme', 'agent', 'ag-argon', 'member'),
    ],
    workspaces: [
      { workspace_id: 'ws-yulan-core', org_id: 'org-yulan', slug: 'core', name: 'Yulan Core', archived_at: null },
      { workspace_id: 'ws-yulan-ops', org_id: 'org-yulan', slug: 'ops', name: 'Yulan Ops', archived_at: null },
      { workspace_id: 'ws-acme-ops', org_id: 'org-acme', slug: 'ops', name: 'Acme Ops', archived_at: null },
    ],
    workspaceGrants: [
      wg('ws-yulan-core', 'org-yulan', 'user', 'u-tom', 'owner'),
      wg('ws-yulan-core', 'org-yulan', 'user', 'u-alice', 'admin'),
      wg('ws-yulan-core', 'org-yulan', 'user', 'u-bob', 'member'),
      wg('ws-yulan-core', 'org-yulan', 'agent', 'ag-argon', 'admin'),
      wg('ws-yulan-ops', 'org-yulan', 'user', 'u-tom', 'owner'),
      wg('ws-yulan-ops', 'org-yulan', 'agent', 'ag-argon', 'admin'),
      wg('ws-acme-ops', 'org-acme', 'user', 'u-tom', 'owner'),
      wg('ws-acme-ops', 'org-acme', 'agent', 'ag-argon', 'member'),
    ],
    channels: [
      ch('ch-yulan-gen', 'ws-yulan-core', 'org-yulan', 'general'),
      ch('ch-yulan-sec', 'ws-yulan-core', 'org-yulan', 'security', 'private'),
      ch('ch-yulan-ops-gen', 'ws-yulan-ops', 'org-yulan', 'general'),
      ch('ch-acme-gen', 'ws-acme-ops', 'org-acme', 'general'),
    ],
    channelMemberships: [
      { channel_id: 'ch-yulan-sec', workspace_id: 'ws-yulan-core', principal_kind: 'user', principal_id: 'u-tom', role: 'owner', notify_pref: 'all', joined_at: NOW, revoked_at: null },
      { channel_id: 'ch-yulan-sec', workspace_id: 'ws-yulan-core', principal_kind: 'agent', principal_id: 'ag-argon', role: 'member', notify_pref: 'all', joined_at: NOW, revoked_at: null },
    ],
    agentIdentities: [{ id: 'ag-argon', owner_user_id: 'u-tom', display_name: 'Argon', created_at: NOW }],
    agentPrincipals: [],
    seats: [],
    seatHandles: [],
    connectionPolicies: [{ connection_id: 'conn-argon', default_org_id: 'org-yulan', default_workspace_id: 'ws-yulan-core', revoked_at: null }],
    fileChannelBindings: [{ file_id: 'file-sec-1', workspace_id: 'ws-yulan-core', channel_id: 'ch-yulan-sec' }],
    signals: [{ signal_id: 'sig-sec-1', workspace_id: 'ws-yulan-core', channel_id: 'ch-yulan-sec', thread_id: 'thr-sec-1' }],
  };
}

test('MCP catalog exposes all 34 org/workspace/channel tools with universal selectors', () => {
  assert.equal(ORG_CHANNEL_TOOL_NAMES.length, 34);
  assert.equal(ORG_CHANNEL_MCP_TOOLS.length, 34);
  for (const tool of ORG_CHANNEL_MCP_TOOLS) {
    for (const sel of ['seat', 'seat_id', 'org', 'workspace', 'channel']) {
      assert.ok(sel in tool.inputSchema.properties, `${tool.name} missing selector ${sel}`);
    }
  }
  assert.throws(() => validateOrgChannelToolArguments('unknown_tool', {}), /Unknown org\/channel tool/);
  assert.throws(() => validateOrgChannelToolArguments('org_create', { slug: 'only-slug' }), /Missing required argument "display_name"/);
});

test('Multi-org pre-seat and post-seat whoami & discover work with zero side-effect writes and match CLI', () => {
  const s = makeFixture();
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-argon', connection_id: 'conn-argon' };

  const pre = executeMultiOrgWhoami(s, caller, {});
  assert.equal(pre.ok, true);
  if (!pre.ok) return;
  assert.equal(pre.active_seat, null);
  assert.equal(pre.organizations.length, 2);
  assert.equal(pre.organizations[0]?.role, 'admin');
  assert.equal(pre.organizations[1]?.role, 'member');
  assert.equal(s.agentPrincipals?.length ?? 0, 0);
  assert.equal(s.seats?.length ?? 0, 0);

  const cliWho = cli(s, caller, ['cswarm', 'whoami', '--json']);
  assert.equal(cliWho.exitCode, 0);
  assert.deepEqual(JSON.parse(cliWho.stdout), pre);

  const disc = executeOrgChannelMcpTool(s, caller, 'discover', {});
  assert.equal(disc.total_organizations, 2);
  assert.equal(disc.total_workspaces, 3);
  assert.equal(disc.total_channels, 4);
  assert.deepEqual(JSON.parse(cli(s, caller, ['discover', '--json']).stdout), disc);

  s.seats!.push({ seat_id: 'seat-1', workspace_id: 'ws-yulan-core', principal_id: 'ap-argon', agent_identity_id: 'ag-argon', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'seat_h_live', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: null });
  s.connectionPolicies![0]!.default_org_id = 'org-deleted';
  s.connectionPolicies![0]!.default_workspace_id = 'ws-deleted';

  const post = executeMultiOrgWhoami(s, { ...caller, seat: 'seat_h_live' }, {});
  assert.equal(post.ok, true);
  if (!post.ok) return;
  assert.equal(post.active_seat?.seat_id, 'seat-1');
  assert.equal(post.active_seat?.org_slug, 'yulan');
  assert.equal(post.default_org_id, null);
  assert.equal(post.default_workspace_id, null);
});

test('Universal selector precedence, WORKSPACE_SEAT_MISMATCH, AMBIGUOUS_WORKSPACE_SELECTOR, and signal/file channel checks', () => {
  const s = makeFixture();
  s.seats!.push({ seat_id: 'seat-1', workspace_id: 'ws-yulan-core', principal_id: 'ap-argon', agent_identity_id: 'ag-argon', revoked_at: null });
  s.seatHandles!.push(
    { handle_id: 'seat_h_live', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: null },
    { handle_id: 'seat_h_revoked', seat_id: 'seat-1', workspace_id: 'ws-yulan-core', revoked_at: NOW },
  );
  const caller = { principal_kind: 'agent' as const, principal_id: 'ag-argon', connection_id: 'conn-argon' };

  const byDefault = resolveMcpOrgWorkspaceChannel(s, caller, {});
  assert.equal(byDefault.ok && byDefault.source, 'connection_default');

  const bySeat = resolveMcpOrgWorkspaceChannel(s, caller, { seat: 'seat_h_live' });
  assert.equal(bySeat.ok && bySeat.source, 'seat');

  const revSeat = resolveMcpOrgWorkspaceChannel(s, caller, { seat: 'seat_h_revoked' });
  assert.equal(!revSeat.ok && revSeat.refusal.code, 'WORKSPACE_ACCESS_DENIED');

  const mismatch = resolveMcpOrgWorkspaceChannel(s, caller, { seat: 'seat_h_live', workspace: 'acme/ops' });
  assert.equal(!mismatch.ok && mismatch.refusal.code, 'WORKSPACE_SEAT_MISMATCH');

  const ambig = resolveMcpOrgWorkspaceChannel(s, { principal_kind: 'agent', principal_id: 'ag-argon' }, { workspace: 'ops' });
  assert.equal(ambig.ok, false);
  if (!ambig.ok) {
    assert.equal(ambig.refusal.code, 'AMBIGUOUS_WORKSPACE_SELECTOR');
    assert.deepEqual(ambig.refusal.choices?.map((c) => c.selector), ['yulan/ops', 'acme/ops']);
    assert.match(formatOrgChannelRefusal(ambig.refusal), /Matching workspaces: yulan\/ops, acme\/ops/);
  }

  const bob = { principal_kind: 'user' as const, principal_id: 'u-bob' };
  const sigDenied = resolveMcpOrgWorkspaceChannel(s, bob, { workspace: 'yulan/core', signal_id: 'sig-sec-1' });
  assert.equal(!sigDenied.ok && sigDenied.refusal.code, 'CHANNEL_ACCESS_DENIED');

  const fileDenied = resolveMcpOrgWorkspaceChannel(s, bob, { workspace: 'yulan/core', file_id: 'file-sec-1' });
  assert.equal(!fileDenied.ok && fileDenied.refusal.code, 'CHANNEL_ACCESS_DENIED');
});

test('Org CRUD, member/role management, owner approval flow, and logo upload before any workspace exists', () => {
  const s = makeFixture();
  const tom = { principal_kind: 'user' as const, principal_id: 'u-tom', connection_id: 'conn-tom' };
  const argon = { principal_kind: 'agent' as const, principal_id: 'ag-argon', connection_id: 'conn-argon' };

  assert.equal(cli(s, tom, ['org', 'list']).exitCode, 0);
  assert.equal(cli(s, tom, ['org', 'get', 'yulan']).exitCode, 0);

  const created = cli(s, tom, ['org', 'create', 'ridge-labs', '--name', 'Ridge Labs']);
  assert.equal(created.exitCode, 0);
  const newOrgId = (created.payload.organization as { id: string }).id;

  const dirtySvg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>evil()</script><circle r="10"/></svg>';
  assert.equal(cli(s, tom, ['org', 'logo', 'upload', '--org', 'ridge-labs', '--content-type', 'image/svg+xml', '--svg', dirtySvg]).exitCode, 0);
  const logo = s.orgLogos?.[newOrgId];
  assert.ok(logo && !logo.sanitized_svg?.includes('<script>') && !logo.sanitized_svg?.includes('onload='));

  const badPng = executeOrgChannelMcpTool(s, tom, 'org_logo_upload', { org: 'ridge-labs', content_type: 'image/png', data_base64: Buffer.from('bad').toString('base64') });
  assert.equal((badPng.refusal as { code: string }).code, 'INVALID_LOGO_FORMAT');
  assert.equal(cli(s, tom, ['org', 'logo', 'remove', '--org', 'ridge-labs']).exitCode, 0);

  assert.equal(cli(s, argon, ['org', 'switch', 'acme', '--workspace', 'ops']).exitCode, 0);
  assert.equal(s.connectionPolicies![0]!.default_org_id, 'org-acme');
  assert.equal(cli(s, tom, ['org', 'update', 'ridge-labs', '--name', 'Ridge Labs Inc']).exitCode, 0);

  assert.equal(cli(s, tom, ['org', 'invite', 'carol@yulan.io', '--org', 'yulan', '--principal', 'u-carol', '--role', 'guest', '--workspace', 'ws-yulan-core']).exitCode, 0);
  assert.equal((cli(s, tom, ['org', 'members', '--org', 'yulan', '--kind', 'guest']).payload.members as unknown[]).length, 2);
  assert.equal(cli(s, tom, ['org', 'role', 'u-carol', 'member', '--org', 'yulan']).exitCode, 0);
  assert.equal(cli(s, tom, ['org', 'remove', 'u-carol', '--org', 'yulan']).exitCode, 0);

  const lastOwner = executeOrgChannelMcpTool(s, tom, 'org_set_member_role', { org: 'yulan', principal_id: 'u-tom', role: 'admin' });
  assert.equal((lastOwner.refusal as { code: string }).code, 'CANNOT_REMOVE_LAST_ORG_OWNER');

  const delReq = cli(s, argon, ['org', 'delete', 'ridge-labs', '--confirm', 'ridge-labs']);
  assert.equal(delReq.payload.status, 'approval_required');
  const approvalId = (delReq.payload.approval as { approval_id: string }).approval_id;
  assert.equal(cli(s, tom, ['org', 'confirm', approvalId, '--approve']).payload.status, 'approved');
  assert.ok(s.organizations.find((o) => o.id === newOrgId)?.archived_at);
});

test('Workspace grants, revocation seat cascade, guest join refusal, and workspace move across orgs', () => {
  const s = makeFixture();
  const tom = { principal_kind: 'user' as const, principal_id: 'u-tom' };
  const guest = { principal_kind: 'user' as const, principal_id: 'u-guest' };

  assert.equal(cli(s, tom, ['workspace', 'list', '--org', 'yulan']).exitCode, 0);
  const wsCreated = cli(s, tom, ['workspace', 'create', 'research', '--org', 'yulan', '--name', 'Research']);
  assert.equal((wsCreated.payload.default_channel as { slug: string }).slug, 'general');

  const guestJoin = cli(s, guest, ['workspace', 'join', 'yulan/research']);
  assert.equal((guestJoin.payload.refusal as { code: string }).code, 'GUEST_WORKSPACE_GRANT_REQUIRED');

  assert.equal(cli(s, tom, ['org', 'invite', 'ag-helper', '--org', 'yulan', '--kind', 'agent', '--role', 'member']).exitCode, 0);
  const grantAg = cli(s, tom, ['org', 'members', 'grant', 'ag-helper', '--org', 'yulan', '--workspace', 'yulan/core', '--kind', 'agent', '--role', 'member']);
  assert.ok(grantAg.payload.agent_principal_id);

  s.seats!.push({ seat_id: 'seat-helper', workspace_id: 'ws-yulan-core', principal_id: String(grantAg.payload.agent_principal_id), agent_identity_id: 'ag-helper', revoked_at: null });
  s.seatHandles!.push({ handle_id: 'h-helper', seat_id: 'seat-helper', workspace_id: 'ws-yulan-core', revoked_at: null });

  const revAg = cli(s, tom, ['org', 'members', 'revoke', 'ag-helper', '--org', 'yulan', '--workspace', 'yulan/core', '--kind', 'agent']);
  assert.deepEqual(revAg.payload.closed_seat_ids, ['seat-helper']);
  assert.deepEqual(revAg.payload.closed_handle_ids, ['h-helper']);

  assert.equal(cli(s, tom, ['workspace', 'members', 'yulan/core']).exitCode, 0);
  assert.equal(cli(s, { principal_kind: 'user', principal_id: 'u-alice' }, ['workspace', 'join', 'yulan/research']).exitCode, 0);
  assert.equal(cli(s, { principal_kind: 'user', principal_id: 'u-alice' }, ['workspace', 'leave', 'yulan/research']).exitCode, 0);
  assert.equal(cli(s, tom, ['workspace', 'move', 'yulan/research', '--to-org', 'acme']).exitCode, 0);
  assert.equal(s.workspaces.find((w) => w.slug === 'research')?.org_id, 'org-acme');
});

test('Channel lifecycle, private channel isolation, #general invariants, and visibility transition guards', () => {
  const s = makeFixture();
  const tom = { principal_kind: 'user' as const, principal_id: 'u-tom' };
  const bob = { principal_kind: 'user' as const, principal_id: 'u-bob' };
  const guest = { principal_kind: 'user' as const, principal_id: 'u-guest' };
  const argon = { principal_kind: 'agent' as const, principal_id: 'ag-argon', connection_id: 'conn-argon' };

  executeOrgChannelMcpTool(s, tom, 'org_assign_workspace_member', { org: 'yulan', workspace: 'core', principal_id: 'u-guest', role: 'guest' });
  assert.equal((cli(s, guest, ['channel', 'create', 'guest-room', '--workspace', 'yulan/core']).payload.refusal as { code: string }).code, 'CHANNEL_CREATE_FORBIDDEN');

  const priv = cli(s, argon, ['channel', 'create', 'incident-war-room', '--workspace', 'yulan/core', '--visibility', 'private', '--topic', 'Sev-1']);
  const privId = (priv.payload.channel as { channel_id: string }).channel_id;
  assert.equal((cli(s, tom, ['channel', 'members', 'incident-war-room', '--workspace', 'yulan/core']).payload.members as unknown[]).length, 2);

  assert.ok(!(cli(s, bob, ['channel', 'list', '--workspace', 'yulan/core']).payload.channels as Array<{ slug: string }>).some((c) => c.slug === 'incident-war-room'));
  assert.equal(cli(s, bob, ['channel', 'join', 'incident-war-room', '--workspace', 'yulan/core']).exitCode, 1);
  assert.equal(cli(s, tom, ['channel', 'add-member', '--workspace', 'yulan/core', '--channel', 'incident-war-room', '--principal', 'u-bob']).exitCode, 0);
  assert.equal(cli(s, bob, ['channel', 'topic', 'Resolved Sev-1', '--workspace', 'yulan/core', '--channel', 'incident-war-room']).exitCode, 0);
  assert.equal(cli(s, bob, ['channel', 'notify', 'mentions', '--workspace', 'yulan/core', '--channel', 'incident-war-room']).exitCode, 0);

  s.signals!.push({ signal_id: 'sig-gen-1', workspace_id: 'ws-yulan-core', channel_id: 'ch-yulan-gen' });
  const badPriv = executeOrgChannelMcpTool(s, tom, 'channel_rename', { workspace: 'yulan/core', channel: 'general', visibility: 'private' });
  assert.equal((badPriv.refusal as { code: string }).code, 'CHANNEL_HAS_PUBLIC_HISTORY');

  assert.equal(cli(s, bob, ['channel', 'leave', 'general', '--workspace', 'yulan/core']).exitCode, 1);
  assert.equal(cli(s, tom, ['channel', 'archive', 'general', '--workspace', 'yulan/core']).exitCode, 1);
  assert.equal(cli(s, tom, ['channel', 'rename', 'main', '--workspace', 'yulan/core', '--channel', 'general']).exitCode, 1);

  assert.equal(cli(s, tom, ['channel', 'remove-member', 'u-bob', '--workspace', 'yulan/core', '--channel', 'incident-war-room']).exitCode, 0);
  assert.equal(cli(s, tom, ['channel', 'archive', 'incident-war-room', '--workspace', 'yulan/core']).exitCode, 0);
  assert.ok(s.channels.find((c) => c.channel_id === privId)?.archived_at);
  assert.equal(parseOrgChannelsCliArgs(['cswarm', 'org', 'list', '--json']).tool, 'org_list');
});
