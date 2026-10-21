import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOrgChannelRefusal,
  canModifyChannelMembership,
  reconcileWorkspaceMove,
  validateChannelVisibilityTransition,
} from '../../src/protocol/org-channels-contract.js';
import {
  CREATION_MENU_ACTIONS,
  ORG_ROLES,
  ORG_ROSTER_FILTER_TABS,
  REVOCATION_SCOPE_DISCLOSURE,
  type OrgMembersScreenProps,
  type OrgRosterMemberItem,
  buildOrgMemberParityCommands,
  canChangeOrgRole,
  filterOrgRosterMembers,
  renderOrgMembersScreen,
} from '../../site/src/components/app/live-dashboard/org-dialogs/org-members-screen.js';
import {
  LOGO_RENDITION_SIZES,
  NOTIFY_PREF_OPTIONS,
  isTypedDeleteMatch,
  renderChannelMembersModal,
  renderCreateChannelModal,
  renderOrgLogoUploadModal,
  renderOrganizationCrudModal,
  renderWorkspaceMembersPanel,
  renderWorkspaceMoveModal,
  validateOrgLogoUpload,
} from '../../site/src/components/app/live-dashboard/org-dialogs/workspace-channel-dialogs.js';
import {
  buildApprovalCliCommand,
  buildApprovalMcpCall,
  renderActionableRefusalBanner,
  renderInlineApprovalCard,
} from '../../site/src/components/app/live-dashboard/org-dialogs/approval-remedy-cards.js';

function createRosterFixture(): OrgRosterMemberItem[] {
  return [
    {
      principal_kind: 'user',
      principal_id: 'u-owner',
      display_name: 'Tom Langridge',
      handle: '@tom',
      initials: 'TL',
      role: 'owner',
      specialty: 'Founder & Organization Owner',
      workspace_grants: [
        { workspace_id: 'ws-1a', workspace_slug: 'ops', workspace_name: 'Operations', role: 'owner' },
        { workspace_id: 'ws-1b', workspace_slug: 'product', workspace_name: 'Product', role: 'owner' },
      ],
      other_org_roles: [{ org_id: 'org-2', org_slug: 'household', org_name: 'Langridge Household', role: 'owner' }],
    },
    {
      principal_kind: 'agent',
      principal_id: 'ag-1',
      display_name: 'Argon Lead',
      handle: '@argon-lead',
      initials: 'AL',
      role: 'admin',
      specialty: 'Architecture & UI verification',
      provider: 'Gemini',
      model: 'Gemini 4 Argon',
      owner_user_id: 'u-owner',
      owner_display_name: 'Tom Langridge',
      inherits_owner_access: true,
      connection_state: 'working',
      active_seat_id: 'seat-1a',
      active_seat_workspace_slug: 'ops',
      workspace_grants: [
        { workspace_id: 'ws-1a', workspace_slug: 'ops', workspace_name: 'Operations', role: 'admin', active_seat_id: 'seat-1a' },
      ],
      other_org_roles: [{ org_id: 'org-2', org_slug: 'household', org_name: 'Langridge Household', role: 'member' }],
    },
    {
      principal_kind: 'user',
      principal_id: 'u-guest',
      display_name: 'External Reviewer',
      handle: '@reviewer',
      initials: 'ER',
      role: 'guest',
      specialty: 'Scoped audit guest',
      workspace_grants: [
        { workspace_id: 'ws-1a', workspace_slug: 'ops', workspace_name: 'Operations', role: 'guest' },
      ],
    },
    {
      principal_kind: 'user',
      principal_id: 'inv-1',
      display_name: 'alex@yulanventures.com',
      handle: 'invite:inv-1',
      initials: 'AX',
      role: 'member',
      specialty: 'Pending organization invite',
      invite_pending: true,
      workspace_grants: [],
    },
  ];
}

test('unified People + Agents roster renders filters, creation menu, role selector, workspace grants, and seat-close disclosure', () => {
  const members = createRosterFixture();
  assert.deepEqual(
    ORG_ROSTER_FILTER_TABS.map((t) => t.label),
    ['All', 'People', 'Agents', 'Guests', 'Pending Invites'],
  );
  assert.deepEqual(
    CREATION_MENU_ACTIONS.map((a) => a.label),
    ['New Agent', 'Invite a Person', 'Connect an Existing Agent'],
  );

  assert.equal(filterOrgRosterMembers(members, 'all').length, 3);
  assert.equal(filterOrgRosterMembers(members, 'people').length, 2);
  assert.equal(filterOrgRosterMembers(members, 'agents').length, 1);
  assert.equal(filterOrgRosterMembers(members, 'guests').length, 1);
  assert.equal(filterOrgRosterMembers(members, 'invites').length, 1);

  const screenProps: OrgMembersScreenProps = {
    org_id: 'org-1',
    org_slug: 'yulan',
    org_name: 'Yulan Ventures',
    current_workspace_id: 'ws-1a',
    current_workspace_slug: 'ops',
    current_workspace_name: 'Operations',
    actor_role: 'owner',
    active_filter: 'all',
    selected_principal_id: 'ag-1',
    active_detail_tab: 'profile',
    available_workspaces: [
      { workspace_id: 'ws-1a', slug: 'ops', name: 'Operations' },
      { workspace_id: 'ws-1b', slug: 'product', name: 'Product' },
    ],
    members,
  };

  const html = renderOrgMembersScreen(screenProps);
  assert.match(html, /Argon Lead/);
  assert.match(html, /Owner: Tom Langridge/);
  assert.match(html, /Active seat · seat-1a/);
  assert.match(html, /\+ Invite Person/);
  assert.match(html, /\+ Connect \/ Grant Agent/);
  assert.match(html, /\+ Add to workspace/);
  assert.ok(html.includes(REVOCATION_SCOPE_DISCLOSURE));
  assert.match(html, /cswarm org member add @argon-lead --org yulan --role admin/);
  assert.match(html, /cswarm workspace grant @argon-lead --workspace yulan\/ops --role admin/);

  const skillsHtml = renderOrgMembersScreen({ ...screenProps, active_detail_tab: 'skills' });
  assert.match(skillsHtml, /cswarm_org_member_add/);
  assert.match(skillsHtml, /cswarm_workspace_grant/);
});

test('4-tier org role selector rules enforce Owner vs Admin boundaries', () => {
  assert.deepEqual(ORG_ROLES, ['owner', 'admin', 'member', 'guest']);
  assert.equal(canChangeOrgRole('owner', 'admin', 'owner'), true);
  assert.equal(canChangeOrgRole('owner', 'owner', 'admin'), true);
  assert.equal(canChangeOrgRole('admin', 'member', 'admin'), true);
  assert.equal(canChangeOrgRole('admin', 'member', 'owner'), false);
  assert.equal(canChangeOrgRole('admin', 'owner', 'admin'), false);
  assert.equal(canChangeOrgRole('member', 'guest', 'member'), false);
  assert.equal(canChangeOrgRole('guest', 'guest', 'member'), false);

  const parity = buildOrgMemberParityCommands('yulan', 'ops', createRosterFixture()[1]);
  assert.equal(parity.cli_member_add, 'cswarm org member add @argon-lead --org yulan --role admin');
  assert.equal(parity.cli_workspace_grant, 'cswarm workspace grant @argon-lead --workspace yulan/ops --role admin');
});

test('workspace members panel, org_move_workspace transfer modes, org CRUD, and logo upload validation', () => {
  const members = createRosterFixture();
  const wsPanel = renderWorkspaceMembersPanel({
    org_slug: 'yulan',
    workspace_id: 'ws-1a',
    workspace_slug: 'ops',
    workspace_name: 'Operations',
    actor_role: 'admin',
    workspace_members: [members[0]!, members[1]!],
    org_candidates: [members[2]!],
  });
  assert.ok(wsPanel.includes(REVOCATION_SCOPE_DISCLOSURE));
  assert.match(wsPanel, /Active seat seat-1a \(closes immediately on removal\)/);

  const moveOwnersOnly = renderWorkspaceMoveModal({
    workspace_id: 'ws-1a',
    workspace_slug: 'ops',
    workspace_name: 'Operations',
    source_org_id: 'org-1',
    source_org_slug: 'yulan',
    source_org_name: 'Yulan Ventures',
    target_orgs: [
      { org_id: 'org-2', slug: 'household', display_name: 'Langridge Household', actor_is_owner: true },
    ],
    selected_target_org_id: 'org-2',
    transfer_members: 'owners_only',
    affected_non_owner_count: 2,
    affected_agent_seat_count: 1,
  });
  assert.match(moveOwnersOnly, /value="all"/);
  assert.match(moveOwnersOnly, /value="owners_only" checked/);
  assert.match(moveOwnersOnly, /Non-transferred principals lose grants &amp; active seats immediately/);
  assert.match(moveOwnersOnly, /cswarm workspace move yulan\/ops --to-org household --transfer-members owners_only/);

  // Verify protocol contract alignment for workspace move
  const now = '2026-10-20T00:00:00Z';
  const state = {
    organizations: [
      { id: 'org-1', slug: 'yulan', display_name: 'Yulan', created_by: 'u-owner', created_at: now, updated_at: now },
      { id: 'org-2', slug: 'household', display_name: 'Household', created_by: 'u-owner', created_at: now, updated_at: now },
    ],
    workspaces: [{ workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: 'Operations' }],
    channels: [],
    agentIdentities: [{ id: 'ag-1', owner_user_id: 'u-owner', display_name: 'Argon', created_at: now }],
    orgMemberships: [
      { org_id: 'org-1', principal_kind: 'user' as const, principal_id: 'u-owner', role: 'owner' as const, created_at: now },
      { org_id: 'org-2', principal_kind: 'user' as const, principal_id: 'u-owner', role: 'owner' as const, created_at: now },
      { org_id: 'org-1', principal_kind: 'agent' as const, principal_id: 'ag-1', role: 'admin' as const, created_at: now },
    ],
    workspaceGrants: [
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'agent' as const, principal_id: 'ag-1', role: 'admin' as const, created_at: now },
    ],
    channelMemberships: [],
    seats: [{ seat_id: 'seat-1a', workspace_id: 'ws-1a', principal_id: 'ap-1', agent_identity_id: 'ag-1' }],
  };
  const moveRes = reconcileWorkspaceMove(state, {
    workspace_id: 'ws-1a',
    target_org_id: 'org-2',
    actor_user_id: 'u-owner',
    transfer_members: 'owners_only',
  });
  assert.equal(moveRes.ok, true);
  if (moveRes.ok) assert.deepEqual(moveRes.closed_seat_ids, ['seat-1a']);

  // Organization CRUD & Logo upload modal (64/128/256 renditions, <= 1MB, SVG script strip)
  assert.deepEqual(LOGO_RENDITION_SIZES, [64, 128, 256]);
  const logoHtml = renderOrgLogoUploadModal({
    org_id: 'org-1',
    org_slug: 'yulan',
    org_name: 'Yulan Ventures',
    actor_role: 'owner',
  });
  assert.match(logoHtml, /orgs\/org-1\/logo\/64\.webp/);
  assert.match(logoHtml, /orgs\/org-1\/logo\/128\.webp/);
  assert.match(logoHtml, /orgs\/org-1\/logo\/256\.webp/);

  const svgCheck = validateOrgLogoUpload({
    actorRole: 'admin',
    mimeType: 'image/svg+xml',
    sizeBytes: 2048,
    svgText: '<svg onload="evil()"><script>alert(1)</script><rect width="64" height="64"/></svg>',
  });
  assert.equal(svgCheck.ok, true);
  assert.ok(!svgCheck.sanitizedSvg?.includes('<script>'));
  assert.ok(!svgCheck.sanitizedSvg?.includes('onload='));
  assert.equal(
    validateOrgLogoUpload({ actorRole: 'member', mimeType: 'image/png', sizeBytes: 1024 }).ok,
    false,
  );
  assert.equal(
    validateOrgLogoUpload({ actorRole: 'owner', mimeType: 'image/png', sizeBytes: 2_000_000 }).ok,
    false,
  );

  const orgCrudHtml = renderOrganizationCrudModal({
    mode: 'delete',
    org_slug: 'yulan',
    org_name: 'Yulan Ventures',
    actor_role: 'owner',
    typed_delete_input: 'Yulan Ventures',
  });
  assert.match(orgCrudHtml, /Delete Yulan Ventures/);
  assert.ok(!orgCrudHtml.includes('data-action="confirm-delete-org" disabled'));
});

test('3-step private channel modal, PRIVATE_CHANNELS_ENABLED gate, channel owner invite rule, and typed delete confirmation', () => {
  const step1Html = renderCreateChannelModal({
    org_slug: 'yulan',
    workspace_slug: 'ops',
    workspace_name: 'Operations',
    step: 1,
    private_channels_enabled: true,
    visibility: 'private',
    channel_slug: 'sec-incident',
    topic: 'Security response',
    guidelines: 'Strict incident handling',
    available_principals: [
      { principal_id: 'ag-1', principal_kind: 'agent', display_name: 'Argon Lead', role: 'admin' },
    ],
    selected_principal_ids: ['ag-1'],
  });
  assert.match(step1Html, /PRIVATE_CHANNELS_ENABLED: true/);
  assert.match(step1Html, /PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC/);
  assert.match(step1Html, /CHANNEL_HAS_PUBLIC_HISTORY/);
  assert.match(step1Html, /1\. Visibility/);
  assert.match(step1Html, /2\. Name &amp; Guidelines/);
  assert.match(step1Html, /3\. Members &amp; Agents/);

  // Protocol visibility transition check matches UI copy
  const flipCheck = validateChannelVisibilityTransition({
    currentVisibility: 'private',
    nextVisibility: 'workspace',
    nextJoinPolicy: 'open',
  });
  assert.equal(flipCheck.ok, false);
  if (!flipCheck.ok) assert.equal(flipCheck.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');

  // Channel members modal: non-owner org admin is blocked from inviting to a private channel
  assert.deepEqual(
    NOTIFY_PREF_OPTIONS.map((o) => o.id),
    ['all', 'mentions', 'mute'],
  );
  const nonOwnerPrivateHtml = renderChannelMembersModal({
    org_slug: 'yulan',
    workspace_slug: 'ops',
    channel_id: 'ch-priv',
    channel_slug: 'sec-incident',
    visibility: 'private',
    actor_channel_role: null,
    actor_org_role: 'admin',
    notify_pref: 'mentions',
    members: [
      { principal_id: 'u-owner', principal_kind: 'user', display_name: 'Tom', channel_role: 'owner', notify_pref: 'all' },
    ],
    typed_delete_input: 'wrong-name',
  });
  assert.match(nonOwnerPrivateHtml, /PRIVATE_CHANNEL_OWNER_REQUIRED/);
  assert.match(nonOwnerPrivateHtml, /data-action="confirm-delete-channel" disabled/);

  assert.equal(isTypedDeleteMatch('sec-incident', 'wrong-name'), false);
  assert.equal(isTypedDeleteMatch('sec-incident', 'sec-incident'), true);

  // Protocol check confirms non-member admin cannot modify private channel membership
  const modCheck = canModifyChannelMembership(
    {
      privateChannelsEnabled: true,
      organizations: [{ id: 'org-1', slug: 'yulan', display_name: 'Yulan', created_by: 'u-owner', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' }],
      workspaces: [{ workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: 'Operations' }],
      channels: [{ channel_id: 'ch-priv', workspace_id: 'ws-1a', slug: 'sec-incident', visibility: 'private', join_policy: 'invite_only' }],
      agentIdentities: [],
      orgMemberships: [{ org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', created_at: '2026-10-20T00:00:00Z' }],
      workspaceGrants: [{ workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', created_at: '2026-10-20T00:00:00Z' }],
      channelMemberships: [],
    },
    { principal_kind: 'user', principal_id: 'u-admin' },
    'ch-priv',
    { principal_kind: 'agent', principal_id: 'ag-1' },
  );
  assert.equal(modCheck.ok, false);
  if (!modCheck.ok) assert.equal(modCheck.refusal.code, 'PRIVATE_CHANNEL_OWNER_REQUIRED');
});

test('inline Approval Card and Actionable Refusal Remedy Banner render copyable CLI/MCP commands', () => {
  assert.equal(buildApprovalCliCommand('appr_123', 'approve'), 'cswarm org confirm appr_123');
  assert.equal(buildApprovalMcpCall('appr_123', 'approve').mcp_tool, 'org_confirm_action');

  const approvalHtml = renderInlineApprovalCard({
    approval_id: 'appr_123',
    org_id: 'org-1',
    org_slug: 'yulan',
    workspace_id: 'ws-1a',
    workspace_slug: 'ops',
    requested_by_agent_identity_id: 'ag-1',
    agent_display_name: 'Argon Lead',
    owner_user_id: 'u-owner',
    owner_display_name: 'Tom Langridge',
    action_kind: 'org_assign_workspace_member',
    action_summary: 'Grant workspace access in yulan/ops',
    target_scope: { org: 'yulan', workspace: 'ops' },
    payload: { principal_id: 'ag-2', role: 'member' },
    state: 'pending',
    created_at: '2026-10-21T00:00:00Z',
  });
  assert.match(approvalHtml, /cswarm org confirm appr_123/);
  assert.match(approvalHtml, /org_confirm_action/);
  assert.match(approvalHtml, /Approve/);
  assert.match(approvalHtml, /Reject/);

  const refusal = buildOrgChannelRefusal({
    code: 'AMBIGUOUS_WORKSPACE_SELECTOR',
    missing: 'org_qualifier',
    scope: { workspace: 'ops' },
    choices: [
      { org_id: 'org-1', org_slug: 'yulan', workspace_id: 'ws-1a', workspace_slug: 'ops', selector: 'yulan/ops' },
      { org_id: 'org-2', org_slug: 'household', workspace_id: 'ws-2a', workspace_slug: 'ops', selector: 'household/ops' },
    ],
  });
  const refusalHtml = renderActionableRefusalBanner(refusal);
  assert.match(refusalHtml, /AMBIGUOUS_WORKSPACE_SELECTOR/);
  assert.match(refusalHtml, /https:\/\/commonswarm\.com\/app\/ops/);
  assert.match(refusalHtml, /cswarm_list_workspaces/);
  assert.match(refusalHtml, /cswarm workspaces list/);
  assert.match(refusalHtml, /yulan\/ops/);
  assert.match(refusalHtml, /household\/ops/);
});

test('all Slice 5 files obey the <= 4,500 token budget and Kylon v0.3 token contract', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const sliceFiles = [
    'site/src/components/app/live-dashboard/org-dialogs/org-members-screen.ts',
    'site/src/components/app/live-dashboard/org-dialogs/workspace-channel-dialogs.ts',
    'site/src/components/app/live-dashboard/org-dialogs/approval-remedy-cards.ts',
    'site/src/components/app/live-dashboard/org-dialogs/org-dialogs.css',
    'site/src/components/app/live-dashboard/org-dialogs/specimen.html',
    'tests/org-channels/slice5-ui-dialogs.test.ts',
  ];

  for (const rel of sliceFiles) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    const tokens = Math.ceil(content.length / 4);
    assert.ok(tokens <= 4500, `${rel} exceeds 4,500 tokens: measured ${tokens} tokens (${content.length} chars)`);
  }

  const css = fs.readFileSync(
    path.join(root, 'site/src/components/app/live-dashboard/org-dialogs/org-dialogs.css'),
    'utf8',
  );
  for (const expectedToken of [
    '--cs-canvas: #f5f5f2',
    '--cs-surface: #ffffff',
    '--cs-subtle: #f5f5f2',
    '--cs-selected: #eeefea',
    '--cs-ink: #282720',
    '--cs-secondary: #655e53',
    '--cs-muted: #716b60',
    '--cs-line: #e9e7e2',
    '--cs-control: #7e887c',
    '--cs-accent: #697344',
    '--cs-focus: #586339',
  ]) {
    assert.ok(css.includes(expectedToken), `Missing Kylon v0.3 token in org-dialogs.css: ${expectedToken}`);
  }
});
