import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as P0 from '../../src/protocol/org-channels-contract.js';
import * as M from '../../site/src/components/app/live-dashboard/org-dialogs/org-members-screen.js';
import * as D from '../../site/src/components/app/live-dashboard/org-dialogs/workspace-channel-dialogs.js';
import * as A from '../../site/src/components/app/live-dashboard/org-dialogs/approval-remedy-cards.js';

const eq = (a: unknown, b: unknown) => assert.equal(a, b);
const deq = (a: unknown, b: unknown) => assert.deepEqual(a, b);
const ok = (v: unknown, msg?: string) => assert.ok(v, msg);
const NOW = '2026-10-20T00:00:00Z', YV = 'Yulan Ventures', TL = 'Tom Langridge', AL = 'Argon Lead', OPS = 'Operations', HH = 'Langridge Household', SI = 'sec-incident';
const Y_OPS = { org_slug: 'yulan', workspace_slug: 'ops', workspace_name: OPS };
const org = (id: string, slug: string, display_name: string) => ({ id, slug, display_name, created_by: 'u-owner', created_at: NOW, updated_at: NOW });
const ORG1 = org('org-1', 'yulan', 'Yulan'), ORG2 = org('org-2', 'household', 'Household'), WS1 = { workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: OPS };
const wg = (workspace_id: string, workspace_slug: string, workspace_name: string, role: M.OrgRole, active_seat_id?: string) => ({ workspace_id, workspace_slug, workspace_name, role, active_seat_id });
const om = (org_id: string, principal_kind: 'user' | 'agent', principal_id: string, role: M.OrgRole) => ({ org_id, principal_kind, principal_id, role, created_at: NOW });
const rf = (principal_kind: 'user' | 'agent', principal_id: string, display_name: string, handle: string, initials: string, role: M.OrgRole, specialty: string, workspace_grants: M.OrgRosterMemberItem['workspace_grants'], x: Partial<M.OrgRosterMemberItem> = {}): M.OrgRosterMemberItem => ({ principal_kind, principal_id, display_name, handle, initials, role, specialty, workspace_grants, ...x });
const m = (h: string, ...ps: RegExp[]) => ps.forEach((p) => assert.match(h, p));
const hh = (role: 'owner' | 'member') => [{ org_id: 'org-2', org_slug: 'household', org_name: HH, role }];
const ROSTER: M.OrgRosterMemberItem[] = [
  rf('user', 'u-owner', TL, '@tom', 'TL', 'owner', 'Owner', [wg('ws-1a', 'ops', OPS, 'owner'), wg('ws-1b', 'product', 'Product', 'owner')], { other_org_roles: hh('owner') }),
  rf('agent', 'ag-1', AL, '@argon-lead', 'AL', 'admin', 'UI', [wg('ws-1a', 'ops', OPS, 'admin', 'seat-1a')], { skills: ['Kylon UI Critique', 'Edge Security Audit'], provider: 'Gemini', model: 'Gemini 4 Argon', owner_user_id: 'u-owner', owner_display_name: TL, inherits_owner_access: true, connection_state: 'working', active_seat_id: 'seat-1a', active_seat_workspace_slug: 'ops', other_org_roles: hh('member') }),
  rf('user', 'u-guest', 'External Reviewer', '@reviewer', 'ER', 'guest', 'Guest', [wg('ws-1a', 'ops', OPS, 'guest')]),
  rf('user', 'inv-1', 'alex@yulanventures.com', 'invite:inv-1', 'AX', 'member', 'Pending', [], { invite_pending: true }),
];
const baseScreenProps = (): M.OrgMembersScreenProps => ({ org_id: 'org-1', org_slug: 'yulan', org_name: YV, current_workspace_id: 'ws-1a', current_workspace_slug: 'ops', current_workspace_name: OPS, actor_role: 'owner', active_filter: 'all', selected_principal_id: 'ag-1', active_detail_tab: 'profile', available_workspaces: [{ workspace_id: 'ws-1a', slug: 'ops', name: OPS }, { workspace_id: 'ws-1b', slug: 'product', name: 'Product' }], members: ROSTER });

test('roster filters, creation menu, layout panes, and mobileView', () => {
  const sp = baseScreenProps(), rm = (p?: Partial<M.OrgMembersScreenProps>) => M.renderOrgMembersScreen({ ...sp, ...p });
  deq(M.ORG_ROSTER_FILTER_TABS.map((t) => t.label), ['All', 'People', 'Agents', 'Guests', 'Pending Invites']);
  deq(M.CREATION_MENU_ACTIONS.map((a) => a.label), ['New Agent', 'Invite a Person', 'Connect an Existing Agent']);
  for (const [f, n] of [['all', 3], ['people', 2], ['agents', 1], ['guests', 1], ['invites', 1]] as const) eq(M.filterOrgRosterMembers(ROSTER, f).length, n);

  const html = rm();
  m(html, /class="org-members-mode"[^>]*data-mobile-view="list"/, /class="sidebar roster-pane members-list-pane"/, /class="page-content detail-pane member-detail-pane"/, /class="identity"/, /Argon Lead/, /Owner: Tom Langridge/, /Active seat · seat-1a/, /\+ Invite Person/, /\+ Connect \/ Grant Agent/, /\+ Add to workspace/, /cswarm org invite ag-1 --org yulan --kind agent --role admin/, /cswarm org members grant ag-1 --org yulan --workspace yulan\/ops --kind agent --role admin/);
  ok(html.includes(M.REVOCATION_SCOPE_DISCLOSURE));
  m(rm({ mobileView: 'detail' }), /data-mobile-view="detail"/, /data-action="member-list-back"[^>]*>← Back to members</);
  m(rm({ active_detail_tab: 'skills' }), /Kylon UI Critique/, /Edge Security Audit/, /org_invite_member/, /org_assign_workspace_member/);
  m(rm({ pending_removal: { principal_id: 'ag-1', scope: 'organization' } }), /role="alertdialog"/, /aria-modal="true"/, /data-dialog="confirm-remove-org-member"/, /data-action="confirm-remove-member"/);
  m(rm({ members: [ROSTER[0]!, { ...ROSTER[1]!, connection_state: 'unavailable', active_seat_id: undefined, inherits_owner_access: false }] }), /Unavailable · connection offline/, /Direct workspace grants only \(does not inherit owner access\)/);
});

test('4-tier org role selector rules and CLI/MCP parity', () => {
  deq(M.ORG_ROLES, ['owner', 'admin', 'member', 'guest']);
  for (const [a, c, n, exp] of [['owner', 'admin', 'owner', true], ['owner', 'owner', 'admin', true], ['admin', 'member', 'admin', true], ['admin', 'member', 'owner', false], ['admin', 'owner', 'admin', false], ['member', 'guest', 'member', false], ['guest', 'guest', 'member', false]] as const) {
    eq(M.canChangeOrgRole(a, c, n), exp);
  }
  const p = M.buildOrgMemberParityCommands('yulan', 'ops', ROSTER[1]!);
  eq(p.cli_member_add, 'cswarm org invite ag-1 --org yulan --kind agent --role admin');
  eq(p.cli_workspace_grant, 'cswarm org members grant ag-1 --org yulan --workspace yulan/ops --kind agent --role admin');
  eq(p.mcp_member_add, 'org_invite_member');
  eq(p.mcp_workspace_grant, 'org_assign_workspace_member');
});

test('workspace move, SVG allowlist validation, and org/workspace CRUD', () => {
  const wsPanel = D.renderWorkspaceMembersPanel({ ...Y_OPS, workspace_id: 'ws-1a', actor_role: 'admin', workspace_members: [ROSTER[0]!, ROSTER[1]!], org_candidates: [ROSTER[2]!] });
  ok(wsPanel.includes(M.REVOCATION_SCOPE_DISCLOSURE));
  m(wsPanel, /Active seat seat-1a \(closes immediately on removal\)/);

  const moveHtml = D.renderWorkspaceMoveModal({ ...Y_OPS, workspace_id: 'ws-1a', source_org_id: 'org-1', source_org_slug: 'yulan', source_org_name: YV, target_orgs: [{ org_id: 'org-2', slug: 'household', display_name: HH, actor_is_owner: true }], selected_target_org_id: 'org-2', transfer_members: 'owners_only', affected_non_owner_count: 2, affected_agent_seat_count: 1 });
  m(moveHtml, /value="all"/, /value="owners_only" checked/, /Non-transferred principals lose grants &amp; active seats immediately/, /cswarm workspace move yulan\/ops --to-org household --transfer-members owners_only/);

  const moveRes = P0.reconcileWorkspaceMove(
    { organizations: [ORG1, ORG2], workspaces: [{ ...WS1 }], channels: [], agentIdentities: [{ id: 'ag-1', owner_user_id: 'u-owner', display_name: 'Argon', created_at: NOW }], orgMemberships: [om('org-1', 'user', 'u-owner', 'owner'), om('org-2', 'user', 'u-owner', 'owner'), om('org-1', 'agent', 'ag-1', 'admin')], workspaceGrants: [{ workspace_id: 'ws-1a', ...om('org-1', 'agent', 'ag-1', 'admin') }], channelMemberships: [], seats: [{ seat_id: 'seat-1a', workspace_id: 'ws-1a', principal_id: 'ap-1', agent_identity_id: 'ag-1' }] },
    { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' },
  );
  eq(moveRes.ok, true);
  if (moveRes.ok) deq(moveRes.closed_seat_ids, ['seat-1a']);

  deq(D.LOGO_RENDITION_SIZES, [64, 128, 256]);
  const logoHtml = D.renderOrgLogoUploadModal({ org_id: 'org-1', org_slug: 'yulan', org_name: YV, actor_role: 'owner' });
  for (const px of [64, 128, 256]) m(logoHtml, new RegExp(`orgs/org-1/logo/${px}\\.webp`));

  const checkSvg = (svgText: string) => D.validateOrgLogoUpload({ actorRole: 'admin', mimeType: 'image/svg+xml', sizeBytes: 512, svgText });
  for (const u of ['<svg onload="x()"><script>1</script></svg>', '<svg><a href="javascript:1"><rect/></a></svg>', '<svg><set attributeName="href" to="javascript:1"/></svg>', '<svg><x:script xmlns:x="http://www.w3.org/1999/xhtml">1</x:script></svg>', '<svg><rect fill="&#x6a;avascript:1"/></svg>', '<svg><style>@import url("https://e.x/x.css");</style></svg>', '<svg><use xlink:href="#x"/></svg>']) {
    deq(checkSvg(u), { ok: false, error: 'Unsafe SVG content refused' });
  }
  deq(checkSvg('<svg viewBox="0 0 64 64"><filter id="f"><feGaussianBlur/></filter></svg>'), { ok: false, error: 'Disallowed SVG element' });
  const cleanSvg = '<svg viewBox="0 0 64 64"><g><rect width="64" height="64"/><path d="M0 0L64 64"/><circle cx="32" cy="32" r="12"/></g></svg>';
  deq(checkSvg(cleanSvg), { ok: true, sanitizedSvg: cleanSvg });
  eq(D.validateOrgLogoUpload({ actorRole: 'member', mimeType: 'image/png', sizeBytes: 1024 }).ok, false);
  eq(D.validateOrgLogoUpload({ actorRole: 'owner', mimeType: 'image/png', sizeBytes: 2_000_000 }).ok, false);

  const crud = (mode: 'create' | 'rename' | 'delete', typed_delete_input?: string) => D.renderOrganizationCrudModal({ mode, org_slug: 'yulan', org_name: YV, actor_role: 'owner', typed_delete_input });
  const noDel = (s: string) => ok(!s.includes('typed-delete-box') && !s.includes('confirm-delete-org'));
  const cH = crud('create'), rH = crud('rename'), dE = crud('delete'), dOk = crud('delete', YV);
  m(cH, /Create Organization/, /name="initial_workspace_name"/, /data-action="submit-create-org"/); noDel(cH);
  m(rH, /Rename Yulan Ventures/, /data-action="submit-rename-org"[^>]*>Save changes</); noDel(rH);
  m(dE, /<dialog open aria-modal="true"/, /Delete Yulan Ventures/, /data-action="confirm-delete-org" disabled/);
  m(dOk, /Delete Yulan Ventures/, /class="button primary danger" data-action="confirm-delete-org"/);
  ok(!dOk.includes('data-action="confirm-delete-org" disabled'));
  m(D.renderCreateWorkspaceModal({ ...Y_OPS, org_name: YV, actor_role: 'admin' }), /<dialog open aria-modal="true"/, /data-dialog="create-workspace"/, /name="workspace_name"/, /#general/, /data-action="submit-create-workspace"/);
});

test('3-step private channel wizard and invite rules', () => {
  const rc = (step: 1 | 2 | 3) => D.renderCreateChannelModal({ ...Y_OPS, step, private_channels_enabled: true, visibility: 'private', channel_icon: 'lock', channel_slug: SI, topic: 'Security response', guidelines: 'Strict incident handling', available_principals: [{ principal_id: 'ag-1', principal_kind: 'agent', display_name: AL, role: 'admin' }], selected_principal_ids: ['ag-1'] });
  m(rc(1), /PRIVATE_CHANNELS_ENABLED: true/, /PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC/, /CHANNEL_HAS_PUBLIC_HISTORY/, /data-step-pane="1"\s*>/, /data-step-pane="2" hidden>/, /data-step-pane="3" hidden>/, /data-action="next-channel-step"\s*>Next step</, /data-action="submit-create-channel" disabled/);
  m(rc(2), /data-step-pane="1" hidden>/, /data-step-pane="2"\s*>/, /select name="channel_icon"/, /input type="text" name="channel_slug" value="sec-incident"/, /input type="text" name="channel_topic" value="Security response"/, /textarea name="channel_guidelines" rows="2">Strict incident handling<\/textarea>/, /data-action="submit-create-channel" disabled/);
  const s3 = rc(3);
  m(s3, /data-step-pane="3"\s*>/);
  ok(!s3.includes('data-action="submit-create-channel" disabled'));

  const flip = P0.validateChannelVisibilityTransition({ currentVisibility: 'private', nextVisibility: 'workspace', nextJoinPolicy: 'open' });
  eq(flip.ok, false);
  if (!flip.ok) eq(flip.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');

  deq(D.NOTIFY_PREF_OPTIONS.map((o) => o.id), ['all', 'mentions', 'mute']);
  m(D.renderChannelMembersModal({ org_slug: 'yulan', workspace_slug: 'ops', channel_id: 'ch-priv', channel_slug: SI, visibility: 'private', actor_channel_role: null, actor_org_role: 'admin', notify_pref: 'mentions', members: [{ principal_id: 'u-owner', principal_kind: 'user', display_name: 'Tom', channel_role: 'owner', notify_pref: 'all' }], typed_delete_input: 'wrong' }), /PRIVATE_CHANNEL_OWNER_REQUIRED/, /data-action="confirm-delete-channel" disabled/);
  eq(D.isTypedDeleteMatch(SI, 'wrong'), false);
  eq(D.isTypedDeleteMatch(SI, SI), true);

  const mod = P0.canModifyChannelMembership(
    { privateChannelsEnabled: true, organizations: [ORG1], workspaces: [{ ...WS1 }], channels: [{ channel_id: 'ch-priv', workspace_id: 'ws-1a', slug: SI, visibility: 'private', join_policy: 'invite_only' }], agentIdentities: [], orgMemberships: [om('org-1', 'user', 'u-admin', 'admin')], workspaceGrants: [{ workspace_id: 'ws-1a', ...om('org-1', 'user', 'u-admin', 'admin') }], channelMemberships: [] },
    { principal_kind: 'user', principal_id: 'u-admin' }, 'ch-priv', { principal_kind: 'agent', principal_id: 'ag-1' },
  );
  eq(mod.ok, false);
  if (!mod.ok) eq(mod.refusal.code, 'PRIVATE_CHANNEL_OWNER_REQUIRED');
});

test('inline approval card, refusal remedies, and controller state', () => {
  eq(A.buildApprovalCliCommand('appr_123', 'approve'), 'cswarm org confirm appr_123');
  eq(A.buildApprovalMcpCall('appr_123', 'approve').mcp_tool, 'org_confirm_action');

  m(
    A.renderInlineApprovalCard({ approval_id: 'appr_123', org_id: 'org-1', org_slug: 'yulan', requested_by_agent_identity_id: 'ag-1', agent_display_name: AL, owner_user_id: 'u-owner', owner_display_name: TL, action_kind: 'org_assign_workspace_member', action_summary: 'Grant access', target_scope: { org: 'yulan', workspace: 'ops', channel: SI }, payload: { principal_id: 'ag-2', principal_name: 'HezLead', role: 'admin', target_org_slug: 'household', transfer_members: 'owners_only' }, state: 'pending', created_at: NOW }),
    /yulan \/ ops \/ sec-incident/, /HezLead \(<code>ag-2<\/code>\)/, /Role: <span class="badge">admin<\/span>/, /Destination org: <code>household<\/code>/, /Transfer policy: <code>transfer_members=owners_only<\/code>/, /data-copy-cmd="org_confirm_action \{&quot;approval_id&quot;:&quot;appr_123&quot;,&quot;decision&quot;:&quot;approve&quot;\}"/,
  );

  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://evil.example/x', '//evil.example/x']) eq(A.sanitizeRemedyUrl(bad), 'https://commonswarm.com/app');
  eq(A.sanitizeRemedyUrl('/app/ops'), '/app/ops');
  eq(A.sanitizeRemedyUrl('https://commonswarm.com/app/ops'), 'https://commonswarm.com/app/ops');

  const chSel = (org_id: string, org_slug: string, workspace_id: string) => ({ org_id, org_slug, workspace_id, workspace_slug: 'ops', selector: `${org_slug}/ops` });
  const ref = P0.buildOrgChannelRefusal({ code: 'AMBIGUOUS_WORKSPACE_SELECTOR', missing: 'org_qualifier', scope: { workspace: 'ops' }, choices: [chSel('org-1', 'yulan', 'ws-1a'), chSel('org-2', 'household', 'ws-2a')] });
  m(A.renderActionableRefusalBanner(ref), /AMBIGUOUS_WORKSPACE_SELECTOR/, /https:\/\/commonswarm\.com\/app\/ops/, /workspace_list/, /cswarm workspaces list/);
  const hb = A.renderActionableRefusalBanner({ ...ref, remedy_url: 'javascript:alert(1)' });
  ok(!hb.includes('javascript:'));
  m(hb, /href="https:\/\/commonswarm\.com\/app"/);

  const ls = new Map<string, (ev: { key?: string }) => void>(), root = { innerHTML: '', addEventListener: (t: string, fn: (ev: { key?: string }) => void) => { ls.set(t, fn); } };
  const ctrl = D.mountOrgDialogsController(root, {
    members: baseScreenProps(),
    createChannel: { ...Y_OPS, step: 1, private_channels_enabled: true, visibility: 'private', channel_slug: SI, topic: 'Init', guidelines: 'G', available_principals: [], selected_principal_ids: [] },
    orgCrud: { mode: 'delete', org_slug: 'yulan', org_name: YV, actor_role: 'owner' },
    approvals: [{ approval_id: 'appr_123', org_id: 'org-1', requested_by_agent_identity_id: 'ag-1', owner_user_id: 'u-owner', action_kind: 'org_assign_workspace_member', target_scope: { org: 'yulan' }, payload: {}, state: 'pending', created_at: NOW }],
  });
  m(root.innerHTML, /data-action="confirm-delete-org" disabled/);
  ctrl.setChannelStep(2); ctrl.updateChannelDraft({ channel_slug: 'custom-room', topic: 'Updated' }); ctrl.setChannelStep(3);
  eq(ctrl.getState().createChannel?.channel_slug, 'custom-room');
  eq(ctrl.getState().createChannel?.topic, 'Updated');
  ctrl.setOrgDeleteInput(YV);
  ok(!root.innerHTML.includes('data-action="confirm-delete-org" disabled'));
  ctrl.requestRemoveFromOrg();
  m(root.innerHTML, /data-dialog="confirm-remove-org-member"/);
  ls.get('keydown')?.({ key: 'Escape' });
  eq(ctrl.getState().members?.pending_removal, null);
  ctrl.decideApproval('appr_123', 'approve');
  eq(ctrl.getState().approvals?.[0]?.state, 'approved');
});

test('Slice 5 token budget and Kylon v0.3 tokens', () => {
  const r = path.resolve(import.meta.dirname ?? '.', '../..'), d = 'site/src/components/app/live-dashboard/org-dialogs';
  for (const rel of ['org-members-screen.ts', 'workspace-channel-dialogs.ts', 'approval-remedy-cards.ts', 'org-dialogs.css', 'specimen.html'].map((f) => `${d}/${f}`).concat('tests/org-channels/slice5-ui-dialogs.test.ts')) {
    ok(Math.ceil(fs.readFileSync(path.join(r, rel), 'utf8').length / 4) <= 4500, rel);
  }
  const css = fs.readFileSync(path.join(r, `${d}/org-dialogs.css`), 'utf8');
  for (const t of ['canvas: #f5f5f2', 'surface: #ffffff', 'subtle: #f5f5f2', 'selected: #eeefea', 'ink: #282720', 'secondary: #655e53', 'muted: #716b60', 'line: #e9e7e2', 'control: #7e887c', 'accent: #697344', 'focus: #586339', 'sidebar: 390px']) ok(css.includes('--cs-' + t));
});
