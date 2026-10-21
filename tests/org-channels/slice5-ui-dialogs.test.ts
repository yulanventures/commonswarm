import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as P0 from '../../src/protocol/org-channels-contract.js';
import * as U from '../../site/src/components/app/live-dashboard/org-dialogs/approval-remedy-cards.js';

const { equal: eq, deepEqual: deq, ok } = assert;
const NOW = '2026-10-20T00:00:00Z', YV = 'Yulan Ventures', TL = 'Tom Langridge', AL = 'Argon Lead', OPS = 'Operations', HH = 'Langridge Household', SI = 'sec-incident';
const Y_OPS = { org_slug: 'yulan', workspace_slug: 'ops', workspace_name: OPS };
const org = (id: string, slug: string, display_name: string) => ({ id, slug, display_name, created_by: 'u', created_at: NOW, updated_at: NOW });
const ORG1 = org('org-1', 'yulan', 'Yulan'), ORG2 = org('org-2', 'household', 'Household'), WS1 = { workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: OPS };
const wg = (wid: string, ws: string, wn: string, role: U.OrgRole, active_seat_id?: string) => ({ workspace_id: wid, workspace_slug: ws, workspace_name: wn, role, active_seat_id });
const om = (oid: string, k: 'user' | 'agent', id: string, role: U.OrgRole) => ({ org_id: oid, principal_kind: k, principal_id: id, role, created_at: NOW });
const rf = (k: 'user' | 'agent', id: string, n: string, h: string, i: string, r: U.OrgRole, sp: string, g: U.OrgRosterMemberItem['workspace_grants'], x: Partial<U.OrgRosterMemberItem> = {}): U.OrgRosterMemberItem => ({ principal_kind: k, principal_id: id, display_name: n, handle: h, initials: i, role: r, specialty: sp, workspace_grants: g, ...x });
const m = (h: string, ...ps: RegExp[]) => ps.forEach((p) => assert.match(h, p));
const hh = (role: 'owner' | 'member') => [{ org_id: 'org-2', org_slug: 'household', org_name: HH, role }];
const ROSTER: U.OrgRosterMemberItem[] = [
  rf('user', 'u-owner', TL, '@tom', 'TL', 'owner', 'Owner', [wg('ws-1a', 'ops', OPS, 'owner'), wg('ws-1b', 'product', 'Product', 'owner')], { other_org_roles: hh('owner') }),
  rf('agent', 'ag-1', AL, '@argon-lead', 'AL', 'admin', 'UI', [wg('ws-1a', 'ops', OPS, 'admin', 'seat-1a')], { skills: ['Kylon UI Critique', 'Edge Security Audit'], provider: 'Gemini', model: 'Gemini 4 Argon', owner_user_id: 'u-owner', owner_display_name: TL, inherits_owner_access: true, connection_state: 'working', active_seat_id: 'seat-1a', active_seat_workspace_slug: 'ops', other_org_roles: hh('member') }),
  rf('user', 'u-guest', 'External Reviewer', '@reviewer', 'ER', 'guest', 'Guest', [wg('ws-1a', 'ops', OPS, 'guest')]),
  rf('user', 'inv-1', 'alex@yulan.io', 'invite:inv-1', 'AX', 'member', 'Pending', [], { invite_pending: true }),
];
const ST_MOVE = { organizations: [ORG1, ORG2], workspaces: [{ ...WS1 }], channels: [], agentIdentities: [{ id: 'ag-1', owner_user_id: 'u-owner', display_name: 'A', created_at: NOW }], orgMemberships: [om('org-1', 'user', 'u-owner', 'owner'), om('org-2', 'user', 'u-owner', 'owner'), om('org-1', 'agent', 'ag-1', 'admin')], workspaceGrants: [{ workspace_id: 'ws-1a', ...om('org-1', 'agent', 'ag-1', 'admin') }], channelMemberships: [], seats: [{ seat_id: 'seat-1a', workspace_id: 'ws-1a', principal_id: 'ap-1', agent_identity_id: 'ag-1' }] };
const bsp = (): U.OrgMembersScreenProps => ({ org_id: 'org-1', org_slug: 'yulan', org_name: YV, current_workspace_id: 'ws-1a', current_workspace_slug: 'ops', current_workspace_name: OPS, actor_role: 'owner', active_filter: 'all', selected_principal_id: 'ag-1', active_detail_tab: 'profile', available_workspaces: [WS1, { workspace_id: 'ws-1b', slug: 'product', name: 'Product' }], members: ROSTER });

test('roster filters & mobileView', () => {
  const sp = bsp(), rm = (p?: Partial<U.OrgMembersScreenProps>) => U.renderOrgMembersScreen({ ...sp, ...p });
  deq(U.ORG_ROSTER_FILTER_TABS.map((t) => t.label), ['All', 'People', 'Agents', 'Guests', 'Pending Invites']);
  deq(U.CREATION_MENU_ACTIONS.map((a) => a.label), ['New Agent', 'Invite a Person', 'Connect an Existing Agent']);
  for (const [f, n] of [['all', 3], ['people', 2], ['agents', 1], ['guests', 1], ['invites', 1]] as const) eq(U.filterOrgRosterMembers(ROSTER, f).length, n);
  const html = rm();
  m(html, /class="org-members-mode"[^>]*data-mobile-view="list"/, /roster-pane members-list-pane/, /detail-pane member-detail-pane/, /class="identity"/, /Argon Lead/, /Owner: Tom Langridge/, /Active seat · seat-1a/, /\+ Invite Person/, /\+ Connect \/ Grant Agent/, /\+ Add to workspace/, /cswarm org invite ag-1 --org yulan --kind agent --role admin/, /cswarm org members grant ag-1 --org yulan --workspace yulan\/ops --kind agent --role admin/);
  ok(html.includes(U.REVOCATION_SCOPE_DISCLOSURE));
  m(rm({ mobileView: 'detail' }), /data-mobile-view="detail"/, /data-action="member-list-back"[^>]*>← Back to members</);
  m(rm({ active_detail_tab: 'skills' }), /Kylon UI Critique/, /Edge Security Audit/, /org_invite_member/, /org_assign_workspace_member/);
  m(rm({ pending_removal: { principal_id: 'ag-1', scope: 'organization' } }), /role="alertdialog"/, /aria-modal="true"/, /data-dialog="confirm-remove-org-member"/, /data-action="confirm-remove-member"/);
  m(rm({ members: [ROSTER[0]!, { ...ROSTER[1]!, connection_state: 'unavailable', active_seat_id: undefined, inherits_owner_access: false }] }), /Unavailable · connection offline/, /Direct workspace grants only/);
});

test('4-tier org roles & parity', () => {
  deq(U.ORG_ROLES, ['owner', 'admin', 'member', 'guest']);
  for (const [a, c, n, exp] of [['owner', 'admin', 'owner', true], ['owner', 'owner', 'admin', true], ['admin', 'member', 'admin', true], ['admin', 'member', 'owner', false], ['admin', 'owner', 'admin', false], ['member', 'guest', 'member', false], ['guest', 'guest', 'member', false]] as const) eq(U.canChangeOrgRole(a, c, n), exp);
  const p = U.buildOrgMemberParityCommands('yulan', 'ops', ROSTER[1]!);
  eq(p.cli_member_add, 'cswarm org invite ag-1 --org yulan --kind agent --role admin');
  eq(p.cli_workspace_grant, 'cswarm org members grant ag-1 --org yulan --workspace yulan/ops --kind agent --role admin');
  eq(p.mcp_member_add, 'org_invite_member'); eq(p.mcp_workspace_grant, 'org_assign_workspace_member');
});

test('workspace move, SVG & CRUD', () => {
  const wsPanel = U.renderWorkspaceMembersPanel({ ...Y_OPS, workspace_id: 'ws-1a', actor_role: 'admin', workspace_members: [ROSTER[0]!, ROSTER[1]!], org_candidates: [ROSTER[2]!] });
  ok(wsPanel.includes(U.REVOCATION_SCOPE_DISCLOSURE)); m(wsPanel, /Active seat seat-1a \(closes immediately on removal\)/);
  m(U.renderWorkspaceMoveModal({ ...Y_OPS, workspace_id: 'ws-1a', source_org_id: 'org-1', source_org_slug: 'yulan', source_org_name: YV, target_orgs: [{ ...ORG2, org_id: 'org-2', actor_is_owner: true }], selected_target_org_id: 'org-2', transfer_members: 'owners_only', affected_non_owner_count: 2, affected_agent_seat_count: 1 }), /value="all"/, /value="owners_only" checked/, /Non-transferred principals lose grants &amp; active seats immediately/, /cswarm workspace move yulan\/ops --to-org household --transfer-members owners_only/);
  const mR = P0.reconcileWorkspaceMove(ST_MOVE, { workspace_id: 'ws-1a', target_org_id: 'org-2', actor_user_id: 'u-owner', transfer_members: 'owners_only' });
  eq(mR.ok, true); if (mR.ok) deq(mR.closed_seat_ids, ['seat-1a']);
  deq(U.LOGO_RENDITION_SIZES, [64, 128, 256]);
  const lH = U.renderOrgLogoUploadModal({ org_id: 'org-1', org_slug: 'yulan', org_name: YV, actor_role: 'owner' });
  for (const px of [64, 128, 256]) m(lH, new RegExp(`orgs/org-1/logo/${px}\\.webp`));
  const cSvg = (svgText: string) => U.validateOrgLogoUpload({ actorRole: 'admin', mimeType: 'image/svg+xml', sizeBytes: 512, svgText });
  for (const u of ['<svg onload="x()"><script>1</script></svg>', '<svg><a href="javascript:1"><rect/></a></svg>', '<svg><set attributeName="href" to="javascript:1"/></svg>', '<svg><x:script xmlns:x="http://www.w3.org/1999/xhtml">1</x:script></svg>', '<svg><rect fill="&#x6a;avascript:1"/></svg>', '<svg><style>@import url("https://e.x/x.css");</style></svg>', '<svg><use xlink:href="#x"/></svg>']) deq(cSvg(u), { ok: false, error: 'Unsafe SVG content refused' });
  deq(cSvg('<svg viewBox="0 0 64 64"><filter id="f"><feGaussianBlur/></filter></svg>'), { ok: false, error: 'Disallowed SVG element' });
  const cS = '<svg viewBox="0 0 64 64"><g><rect width="64" height="64"/><path d="M0 0L64 64"/><circle cx="32" cy="32" r="12"/></g></svg>';
  deq(cSvg(cS), { ok: true, sanitizedSvg: cS });
  eq(U.validateOrgLogoUpload({ actorRole: 'member', mimeType: 'image/png', sizeBytes: 1024 }).ok, false);
  eq(U.validateOrgLogoUpload({ actorRole: 'owner', mimeType: 'image/png', sizeBytes: 2_000_000 }).ok, false);
  const crud = (mode: 'create' | 'rename' | 'delete', td?: string) => U.renderOrganizationCrudModal({ mode, org_slug: 'yulan', org_name: YV, actor_role: 'owner', typed_delete_input: td });
  const noDel = (s: string) => ok(!s.includes('typed-delete-box') && !s.includes('confirm-delete-org'));
  const cH = crud('create'), rH = crud('rename'), dE = crud('delete'), dOk = crud('delete', YV);
  m(cH, /Create Organization/, /name="initial_workspace_name"/, /data-action="submit-create-org"/); noDel(cH);
  m(rH, /Rename Yulan Ventures/, /data-action="submit-rename-org"[^>]*>Save changes</); noDel(rH);
  m(dE, /<dialog open aria-modal="true"/, /Delete Yulan Ventures/, /data-action="confirm-delete-org" disabled/);
  m(dOk, /Delete Yulan Ventures/, /class="button primary danger" data-action="confirm-delete-org"/);
  ok(!dOk.includes('data-action="confirm-delete-org" disabled'));
  m(U.renderCreateWorkspaceModal({ ...Y_OPS, org_name: YV, actor_role: 'admin' }), /<dialog open aria-modal="true"/, /data-dialog="create-workspace"/, /name="workspace_name"/, /#general/, /data-action="submit-create-workspace"/);
});

test('3-step private channel wizard', () => {
  const rc = (step: 1 | 2 | 3) => U.renderCreateChannelModal({ ...Y_OPS, step, private_channels_enabled: true, visibility: 'private', channel_icon: 'lock', channel_slug: SI, topic: 'Security response', guidelines: 'Strict incident handling', available_principals: [ROSTER[1]!], selected_principal_ids: ['ag-1'] });
  m(rc(1), /PRIVATE_CHANNELS_ENABLED: true/, /PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC/, /CHANNEL_HAS_PUBLIC_HISTORY/, /data-step-pane="1"\s*>/, /data-step-pane="2" hidden>/, /data-step-pane="3" hidden>/, /data-action="next-channel-step"\s*>Next step</, /data-action="submit-create-channel" disabled/);
  m(rc(2), /data-step-pane="1" hidden>/, /data-step-pane="2"\s*>/, /select name="channel_icon"/, /name="channel_slug" value="sec-incident"/, /name="channel_topic" value="Security response"/, /textarea name="channel_guidelines" rows="2">Strict incident handling<\/textarea>/, /data-action="submit-create-channel" disabled/);
  const s3 = rc(3); m(s3, /data-step-pane="3"\s*>/); ok(!s3.includes('data-action="submit-create-channel" disabled'));
  const flip = P0.validateChannelVisibilityTransition({ currentVisibility: 'private', nextVisibility: 'workspace', nextJoinPolicy: 'open' });
  eq(flip.ok, false); if (!flip.ok) eq(flip.refusal.code, 'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
  deq(U.NOTIFY_PREF_OPTIONS.map((o) => o.id), ['all', 'mentions', 'mute']);
  m(U.renderChannelMembersModal({ org_slug: 'yulan', workspace_slug: 'ops', channel_id: 'ch-priv', channel_slug: SI, visibility: 'private', actor_channel_role: null, actor_org_role: 'admin', notify_pref: 'mentions', members: [{ ...ROSTER[0]!, channel_role: 'owner', notify_pref: 'all' }], typed_delete_input: 'wrong' }), /PRIVATE_CHANNEL_OWNER_REQUIRED/, /data-action="confirm-delete-channel" disabled/);
  eq(U.isTypedDeleteMatch(SI, 'wrong'), false); eq(U.isTypedDeleteMatch(SI, SI), true);
  const mod = P0.canModifyChannelMembership({ ...ST_MOVE, workspaces: [{ ...WS1 }], privateChannelsEnabled: true, channels: [{ channel_id: 'ch-priv', workspace_id: 'ws-1a', slug: SI, visibility: 'private', join_policy: 'invite_only' }], orgMemberships: [om('org-1', 'user', 'u-admin', 'admin')], workspaceGrants: [{ workspace_id: 'ws-1a', ...om('org-1', 'user', 'u-admin', 'admin') }] }, { principal_kind: 'user', principal_id: 'u-admin' }, 'ch-priv', { principal_kind: 'agent', principal_id: 'ag-1' });
  eq(mod.ok, false); if (!mod.ok) eq(mod.refusal.code, 'PRIVATE_CHANNEL_OWNER_REQUIRED');
});

test('approvals, refusals & controller', () => {
  const AP0: U.ApprovalCardData = { approval_id: 'appr_123', org_id: 'org-1', org_slug: 'yulan', requested_by_agent_identity_id: 'ag-1', agent_display_name: AL, owner_user_id: 'u-owner', owner_display_name: TL, action_kind: 'org_assign_workspace_member', action_summary: 'Grant access', target_scope: { org: 'yulan', workspace: 'ops', channel: SI }, payload: { principal_id: 'ag-2', principal_name: 'HezLead', role: 'admin', target_org_slug: 'household', transfer_members: 'owners_only' }, state: 'pending', created_at: NOW };
  eq(U.buildApprovalCliCommand('appr_123', 'approve'), 'cswarm org confirm appr_123');
  eq(U.buildApprovalMcpCall('appr_123', 'approve').mcp_tool, 'org_confirm_action');
  m(U.renderInlineApprovalCard(AP0), /yulan \/ ops \/ sec-incident/, /HezLead \(<code>ag-2<\/code>\)/, /Role: <span class="badge">admin<\/span>/, /Destination org: <code>household<\/code>/, /Transfer policy: <code>transfer_members=owners_only<\/code>/, /data-copy-cmd="org_confirm_action \{&quot;approval_id&quot;:&quot;appr_123&quot;,&quot;decision&quot;:&quot;approve&quot;\}"/);
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://evil.example/x', '//evil.example/x']) eq(U.sanitizeRemedyUrl(bad), 'https://commonswarm.com/app');
  eq(U.sanitizeRemedyUrl('/app/ops'), '/app/ops'); eq(U.sanitizeRemedyUrl('https://commonswarm.com/app/ops'), 'https://commonswarm.com/app/ops');
  const chSel = (oid: string, os: string, wid: string) => ({ org_id: oid, org_slug: os, workspace_id: wid, workspace_slug: 'ops', selector: `${os}/ops` });
  const ref = P0.buildOrgChannelRefusal({ code: 'AMBIGUOUS_WORKSPACE_SELECTOR', missing: 'org_qualifier', scope: { workspace: 'ops' }, choices: [chSel('org-1', 'yulan', 'ws-1a'), chSel('org-2', 'household', 'ws-2a')] });
  m(U.renderActionableRefusalBanner(ref), /AMBIGUOUS_WORKSPACE_SELECTOR/, /https:\/\/commonswarm\.com\/app\/ops/, /workspace_list/, /cswarm workspaces list/);
  const hb = U.renderActionableRefusalBanner({ ...ref, remedy_url: 'javascript:alert(1)' });
  ok(!hb.includes('javascript:')); m(hb, /href="https:\/\/commonswarm\.com\/app"/);

  let rej = false, wr = 0, foc = '';
  const prev = { textContent: '' }, delB = { disabled: true, setAttribute() {}, removeAttribute() {} };
  const b1 = { focus: () => { foc = 'first'; } }, b2 = { focus: () => { foc = 'last'; } }, ls = new Map<string, (e: Record<string, unknown>) => void>();
  const root: U.OrgDialogsMountNode = {
    get innerHTML() { return this._h ?? ''; }, set innerHTML(v: string) { this._h = v; wr++; }, _h: '',
    addEventListener: (t, fn) => { ls.set(t, fn as (e: Record<string, unknown>) => void); },
    querySelector: (s) => (s === '[data-channel-cli-preview]' ? prev : s === '[data-action="confirm-delete-org"]' ? delB : { focus: () => { foc = s; } }),
    querySelectorAll: () => [b1, b2],
  } as U.OrgDialogsMountNode & { _h: string };
  const ctrl = U.mountOrgDialogsController(root, {
    members: bsp(), createChannel: { ...Y_OPS, step: 1, private_channels_enabled: true, visibility: 'private', channel_slug: SI, topic: 'Init', guidelines: 'G', available_principals: [], selected_principal_ids: [] },
    orgCrud: { mode: 'delete', org_slug: 'yulan', org_name: YV, actor_role: 'owner' },
    approvals: [AP0],
    onAction: () => (rej ? { ok: false, refusal: ref } : { ok: true, decided_by: 'u-owner', decided_at: NOW }),
  });
  const w0 = wr;
  ls.get('input')?.({ target: { name: 'channel_slug', value: 'ops-war-room' } });
  ls.get('input')?.({ target: { name: 'typed_delete_input', value: YV, getAttribute: () => YV } });
  eq(wr, w0); m(prev.textContent, /cswarm channel create ops-war-room/); eq(delB.disabled, false);
  rej = true; ctrl.decideApproval('appr_123', 'approve');
  eq(ctrl.getState().approvals?.[0]?.state, 'pending'); eq(ctrl.getState().refusals?.length, 1);
  rej = false; ctrl.decideApproval('appr_123', 'approve');
  eq(ctrl.getState().approvals?.[0]?.state, 'approved');
  ctrl.requestRemoveFromOrg('workspace'); m(root.innerHTML ?? '', /data-pending-removal-scope="workspace"/); ctrl.confirmRemoveFromOrg();
  const agRem = ctrl.getState().members?.members.find((x) => x.principal_id === 'ag-1');
  ok(agRem); eq(agRem.workspace_grants.length, 0); eq(agRem.active_seat_id, null);
  ctrl.selectMember('u-owner'); eq(ctrl.getState().members?.mobileView, 'detail');
  ctrl.backToMemberList(); eq(ctrl.getState().members?.mobileView, 'list'); m(foc, /member-row\[data-member-id="u-owner"\]/);
  ctrl.openDialog('create-channel');
  ls.get('keydown')?.({ key: 'Tab', shiftKey: false, target: b2, preventDefault() {} }); eq(foc, 'first');
  ls.get('keydown')?.({ key: 'Escape' }); eq(ctrl.getState().activeDialog, 'closed:create-channel');
});

test('Slice 5 token budget', () => {
  const r = path.resolve(import.meta.dirname ?? '.', '../..'), d = 'site/src/components/app/live-dashboard/org-dialogs';
  for (const rel of ['org-members-screen.ts', 'workspace-channel-dialogs.ts', 'approval-remedy-cards.ts', 'org-dialogs-controller.ts', 'org-dialogs.css', 'specimen.html'].map((f) => `${d}/${f}`).concat('tests/org-channels/slice5-ui-dialogs.test.ts')) {
    ok(Math.ceil(fs.readFileSync(path.join(r, rel), 'utf8').length / 4) <= 4500, rel);
  }
  const css = fs.readFileSync(path.join(r, `${d}/org-dialogs.css`), 'utf8');
  for (const t of ['canvas: #f5f5f2', 'surface: #ffffff', 'subtle: #f5f5f2', 'selected: #eeefea', 'ink: #282720', 'secondary: #655e53', 'muted: #716b60', 'line: #e9e7e2', 'control: #7e887c', 'accent: #697344', 'focus: #586339', 'sidebar: 390px']) ok(css.includes('--cs-' + t));
});
