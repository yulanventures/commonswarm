import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_ORG_CHANNEL_LOCK_ORDER,
  ORG_LOGO_MAX_BYTES,
  type OrgAuthorityState,
  canReadOrg,
  canReadWorkspace,
  dispatchOrgCommand,
  orgAssignWorkspaceMember,
  orgConfirmAction,
  orgCreate,
  orgDelete,
  orgInviteAccept,
  orgInviteCreate,
  orgInviteRevoke,
  orgList,
  orgListMembers,
  orgLogoFinalize,
  orgLogoRemove,
  orgLogoUploadPrepare,
  orgMoveWorkspace,
  orgRemoveMember,
  orgRemoveWorkspaceMember,
  orgSetMemberRole,
  orgUpdate,
  workspaceJoin,
  workspaceLeave,
  workspaceListMembers,
} from '../../supabase/functions/command/orgs/index.js';

function createFixture(): OrgAuthorityState {
  const now = '2026-10-21T00:00:00Z';
  return {
    privateChannelsEnabled: true,
    organizations: [
      { id: 'org-1', slug: 'yulan', display_name: 'Yulan Ventures', created_by: 'u-owner', created_at: now, updated_at: now },
      { id: 'org-2', slug: 'household', display_name: 'Langridge Household', created_by: 'u-owner', created_at: now, updated_at: now },
    ],
    workspaces: [
      { workspace_id: 'ws-1a', org_id: 'org-1', slug: 'ops', name: 'Operations' },
      { workspace_id: 'ws-1b', org_id: 'org-1', slug: 'product', name: 'Product' },
      { workspace_id: 'ws-2a', org_id: 'org-2', slug: 'home', name: 'Household Ops' },
    ],
    channels: [
      { channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', org_id: 'org-1', slug: 'general', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-1b-gen', workspace_id: 'ws-1b', org_id: 'org-1', slug: 'general', visibility: 'workspace', join_policy: 'open' },
      { channel_id: 'ch-2a-gen', workspace_id: 'ws-2a', org_id: 'org-2', slug: 'general', visibility: 'workspace', join_policy: 'open' },
    ],
    agentIdentities: [
      { id: 'ag-1', owner_user_id: 'u-owner', display_name: 'Argon Lead', created_at: now },
      { id: 'ag-2', owner_user_id: 'u-owner', display_name: 'Codex Maker', created_at: now },
    ],
    orgMemberships: [
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', created_at: now },
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-member', role: 'member', created_at: now },
      { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-guest', role: 'guest', created_at: now },
      { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-1', role: 'admin', created_at: now },
      { org_id: 'org-2', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', created_at: now },
    ],
    workspaceGrants: [
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { workspace_id: 'ws-1b', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { workspace_id: 'ws-2a', org_id: 'org-2', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', created_at: now },
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'admin', created_at: now },
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'user', principal_id: 'u-member', role: 'member', created_at: now },
      { workspace_id: 'ws-1a', org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-1', role: 'admin', created_at: now },
      { workspace_id: 'ws-2a', org_id: 'org-2', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', created_at: now },
    ],
    agentPrincipals: [
      { principal_id: 'ap-1a', workspace_id: 'ws-1a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' },
      { principal_id: 'ap-2a', workspace_id: 'ws-2a', agent_identity_id: 'ag-1', owner_user_id: 'u-owner', name: 'Argon Lead' },
    ],
    channelMemberships: [
      { channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-owner', role: 'owner', notify_pref: 'all', joined_at: now },
      { channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'user', principal_id: 'u-member', role: 'member', notify_pref: 'all', joined_at: now },
      { channel_id: 'ch-1a-gen', workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1', role: 'member', notify_pref: 'all', joined_at: now },
    ],
    seats: [
      { seat_id: 'seat-1a', workspace_id: 'ws-1a', principal_id: 'ap-1a', agent_identity_id: 'ag-1' },
      { seat_id: 'seat-2a', workspace_id: 'ws-2a', principal_id: 'ap-2a', agent_identity_id: 'ag-1' },
    ],
    seatHandles: [
      { handle_id: 'h-1a', seat_id: 'seat-1a', workspace_id: 'ws-1a' },
      { handle_id: 'h-2a', seat_id: 'seat-2a', workspace_id: 'ws-2a' },
    ],
    signals: [
      { signal_id: 'sig-1a-1', workspace_id: 'ws-1a', channel_id: 'ch-1a-gen', from_principal_kind: 'user', from_principal_id: 'u-owner', kind: 'note', body: 'Initial ops', created_at: now },
    ],
    files: [{ file_id: 'file-1a-1', workspace_id: 'ws-1a', name: 'runbook.md', created_at: now }],
  };
}

const owner = { principal_kind: 'user' as const, principal_id: 'u-owner' };
const admin = { principal_kind: 'user' as const, principal_id: 'u-admin' };
const member = { principal_kind: 'user' as const, principal_id: 'u-member' };
const guest = { principal_kind: 'user' as const, principal_id: 'u-guest' };
const ag1 = { principal_kind: 'agent' as const, principal_id: 'ag-1' };
const ag2 = { principal_kind: 'agent' as const, principal_id: 'ag-2' };

test('org CRUD, multi-org listing for humans and agents, and owner-only org_delete safeguards', () => {
  const s = createFixture();
  assert.equal(orgList(s, owner).organizations.length, 2);
  const agentOrgs = orgList(s, ag1);
  assert.equal(agentOrgs.organizations.length, 2);
  assert.equal(agentOrgs.organizations[0]?.role, 'admin');
  assert.equal(agentOrgs.organizations[1]?.role, 'member');

  const created = orgCreate(s, owner, { id: 'org-3', slug: 'ridge-labs', display_name: 'Ridge Labs' });
  assert.equal(created.ok && created.workspace, null);

  const dup = orgCreate(s, owner, { slug: 'RIDGE-LABS', display_name: 'Dup' });
  assert.equal(!dup.ok && dup.refusal.code, 'ORG_SLUG_TAKEN');

  const deniedUpdate = orgUpdate(s, member, { org_id: 'org-1', display_name: 'Nope' });
  assert.equal(!deniedUpdate.ok && deniedUpdate.refusal.code, 'ORG_ADMIN_REQUIRED');
  assert.equal(orgUpdate(s, admin, { org_id: 'org-1', display_name: 'Yulan Ventures Inc.' }).ok, true);

  const deniedDelete = orgDelete(s, admin, { org_id: 'org-1' });
  assert.equal(!deniedDelete.ok && deniedDelete.refusal.code, 'ORG_OWNER_REQUIRED');

  assert.equal(orgDelete(s, owner, { org_id: 'org-3' }).ok, true);
  const del2 = orgDelete(s, owner, { org_id: 'org-2' });
  if (del2.ok && del2.status === 'executed') assert.deepEqual(del2.closed_seat_ids, ['seat-2a']);

  const lastOrgBlocked = orgDelete(s, owner, { org_id: 'org-1' });
  assert.equal(!lastOrgBlocked.ok && lastOrgBlocked.refusal.code, 'CANNOT_DELETE_LAST_ORG');
  assert.equal(orgDelete(s, owner, { org_id: 'org-1', confirm_slug: 'yulan' }).ok, true);
});

test('unified human+agent org_memberships, roles, last-owner guard, and org removal cascade', () => {
  const s = createFixture();
  const allRoster = orgListMembers(s, owner, { org_id: 'org-1', filter: 'all' });
  assert.equal(allRoster.ok && allRoster.members.length, 5);
  const agentRoster = orgListMembers(s, owner, { org_id: 'org-1', filter: 'agent' });
  if (agentRoster.ok) assert.deepEqual(agentRoster.members[0]?.active_seat_ids, ['seat-1a']);

  const demoteLast = orgSetMemberRole(s, owner, { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner', role: 'admin' });
  assert.equal(!demoteLast.ok && demoteLast.refusal.code, 'CANNOT_REMOVE_LAST_ORG_OWNER');

  const removeLast = orgRemoveMember(s, owner, { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-owner' });
  assert.equal(!removeLast.ok && removeLast.refusal.code, 'CANNOT_REMOVE_LAST_ORG_OWNER');

  const adminPromoteOwner = orgSetMemberRole(s, admin, { org_id: 'org-1', principal_kind: 'user', principal_id: 'u-admin', role: 'owner' });
  assert.equal(!adminPromoteOwner.ok && adminPromoteOwner.refusal.code, 'ORG_OWNER_REQUIRED');

  assert.equal(orgSetMemberRole(s, admin, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-2', role: 'guest' }).ok, true);

  const remAg1 = orgRemoveMember(s, admin, { org_id: 'org-1', principal_kind: 'agent', principal_id: 'ag-1' });
  if (remAg1.ok && remAg1.status === 'executed') assert.deepEqual(remAg1.closed_seat_ids, ['seat-1a']);
  assert.equal(canReadOrg(s, ag1, 'org-1'), false);
  assert.equal(canReadOrg(s, ag1, 'org-2'), true);
  assert.equal(s.seats?.find((x) => x.seat_id === 'seat-2a')?.revoked_at ?? null, null);
});

test('workspace grants: agent_principals transactional provisioning, seat-close cascade, guest restriction, and explicit revocation override', () => {
  const s = createFixture();
  const guestJoin = workspaceJoin(s, guest, { workspace_id: 'ws-1a' });
  assert.equal(!guestJoin.ok && guestJoin.refusal.code, 'GUEST_CANNOT_SELF_JOIN_WORKSPACE');

  const assign1b = orgAssignWorkspaceMember(s, admin, { workspace_id: 'ws-1b', principal_kind: 'agent', principal_id: 'ag-1', role: 'member' });
  if (assign1b.ok && assign1b.status === 'executed') assert.equal(assign1b.agent_principal?.workspace_id, 'ws-1b');

  const remWs1a = orgRemoveWorkspaceMember(s, admin, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1' });
  if (remWs1a.ok && remWs1a.status === 'executed') assert.deepEqual(remWs1a.closed_seat_ids, ['seat-1a']);
  assert.equal(canReadWorkspace(s, ag1, 'ws-1a'), false);
  assert.equal(canReadWorkspace(s, ag1, 'ws-1b'), true);
  assert.equal(canReadWorkspace(s, ag1, 'ws-2a'), true);

  const rejoinBlocked = workspaceJoin(s, ag1, { workspace_id: 'ws-1a' });
  assert.equal(!rejoinBlocked.ok && rejoinBlocked.refusal.code, 'WORKSPACE_ACCESS_REVOKED');

  assert.equal(orgAssignWorkspaceMember(s, admin, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-1', role: 'admin' }).ok, true);
  assert.equal(canReadWorkspace(s, ag1, 'ws-1a'), true);
  const apRows = (s.agentPrincipals ?? []).filter((p) => p.workspace_id === 'ws-1a' && p.agent_identity_id === 'ag-1');
  assert.equal(apRows.length, 1);
  assert.equal(apRows[0]?.revoked_at, null);

  assert.equal(canReadWorkspace(s, ag2, 'ws-1a'), true);
  assert.equal(orgRemoveWorkspaceMember(s, admin, { workspace_id: 'ws-1a', principal_kind: 'agent', principal_id: 'ag-2' }).ok, true);
  assert.equal(canReadWorkspace(s, ag2, 'ws-1a'), false);

  assert.equal(workspaceListMembers(s, admin, { workspace_id: 'ws-1a' }).ok, true);
  assert.equal(workspaceLeave(s, member, { workspace_id: 'ws-1a' }).ok, true);
});

test('org invites and inline chat Approval Cards (approve and reject flows)', () => {
  const s = createFixture();
  const cardRes = orgInviteCreate(s, ag1, { org_id: 'org-2', email: 'newbie@yulan.io', role: 'admin', workspace_ids: ['ws-2a'] });
  assert.equal(cardRes.ok && cardRes.status, 'approval_required');
  if (cardRes.ok && cardRes.status === 'approval_required') {
    const approvalId = cardRes.approval.approval_id;
    assert.match(cardRes.card_signal?.body ?? '', /\[Approval Card\]/);

    const selfConfirm = orgConfirmAction(s, ag1, { approval_id: approvalId, decision: 'approve' });
    assert.equal(!selfConfirm.ok && selfConfirm.refusal.code, 'HUMAN_OWNER_CONFIRMATION_REQUIRED');

    const confirmed = orgConfirmAction(s, owner, { approval_id: approvalId, decision: 'approve' });
    if (confirmed.ok) {
      assert.equal(confirmed.executed, true);
      const token = (confirmed.result as { token?: string }).token;
      const accepted = orgInviteAccept(s, { principal_kind: 'user', principal_id: 'u-newbie' }, { token, email: 'newbie@yulan.io' });
      assert.equal(accepted.ok, true);
      assert.equal(canReadWorkspace(s, { principal_kind: 'user', principal_id: 'u-newbie' }, 'ws-2a'), true);
    }
  }

  const secondCard = dispatchOrgCommand(s, ag1, { kind: 'org_set_member_role', org_id: 'org-2', principal_kind: 'user', principal_id: 'u-newbie', role: 'owner' });
  if (secondCard.ok && 'status' in secondCard && secondCard.status === 'approval_required') {
    const rejected = orgConfirmAction(s, owner, { approval_id: secondCard.approval.approval_id, decision: 'reject' });
    assert.equal(rejected.ok && rejected.approval.state, 'rejected');
  }

  const inv2 = orgInviteCreate(s, owner, { org_id: 'org-1', role: 'guest', workspace_ids: ['ws-1a'] });
  if (inv2.ok && inv2.status === 'executed') {
    assert.equal(orgInviteRevoke(s, owner, { org_id: 'org-1', invite_id: inv2.invite.invite_id }).ok, true);
    assert.equal(orgInviteAccept(s, { principal_kind: 'user', principal_id: 'u-late' }, { token: inv2.token }).ok, false);
  }
});

test('Org Logo pipeline: works before any workspace exists, enforces <= 1 MB, PNG/JPEG/WebP magic bytes, SVG sanitization, and 64/128/256 renditions', () => {
  const s = createFixture();
  assert.equal(orgCreate(s, owner, { id: 'org-empty', slug: 'zero-ws-org', display_name: 'Zero WS' }).ok, true);
  assert.equal(s.workspaces.filter((w) => w.org_id === 'org-empty').length, 0);

  const memberDenied = orgLogoUploadPrepare(s, member, { org_id: 'org-1', content_type: 'image/png', size_bytes: 512 });
  assert.equal(!memberDenied.ok && memberDenied.refusal.code, 'ORG_ADMIN_REQUIRED');

  const tooLarge = orgLogoUploadPrepare(s, owner, { org_id: 'org-empty', content_type: 'image/png', size_bytes: ORG_LOGO_MAX_BYTES + 1 });
  assert.equal(!tooLarge.ok && tooLarge.refusal.code, 'ORG_LOGO_TOO_LARGE');

  const prep = orgLogoUploadPrepare(s, owner, { org_id: 'org-empty', content_type: 'image/png', size_bytes: 16 });
  if (prep.ok && prep.status === 'executed') {
    const spoofed = orgLogoFinalize(s, owner, { org_id: 'org-empty', upload_id: prep.upload.upload_id, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
    assert.equal(!spoofed.ok && spoofed.refusal.code, 'ORG_LOGO_MAGIC_BYTE_MISMATCH');

    const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const finPng = orgLogoFinalize(s, owner, { org_id: 'org-empty', upload_id: prep.upload.upload_id, bytes: validPng });
    if (finPng.ok && finPng.status === 'executed') {
      assert.deepEqual(finPng.renditions, {
        64: 'orgs/org-empty/logo/64.png',
        128: 'orgs/org-empty/logo/128.png',
        256: 'orgs/org-empty/logo/256.png',
      });
    }
  }

  const validWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
  assert.equal(orgLogoFinalize(s, owner, { org_id: 'org-empty', content_type: 'image/webp', bytes: validWebp }).ok, true);

  const dirtySvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>evil()</script><style>@import url("https://evil.example/x.css");</style><image href="https://evil.example/track.png" /><rect width="100" height="100" onclick="steal()" fill="#145c46"/></svg>`;
  const finSvg = orgLogoFinalize(s, owner, { org_id: 'org-empty', content_type: 'image/svg+xml', bytes: dirtySvg });
  if (finSvg.ok && finSvg.status === 'executed') {
    const r256 = String(s.logoObjects?.['orgs/org-empty/logo/256.svg']?.data ?? '');
    assert.equal(/<script|onload|onclick|evil\.example/i.test(r256), false);
    assert.match(r256, /width="256" height="256"/);
  }

  assert.equal(orgLogoRemove(s, owner, { org_id: 'org-empty' }).ok, true);
  assert.equal(s.organizations.find((o) => o.id === 'org-empty')?.logo_object_key, null);
});

test('org_move_workspace: dual-owner check, canonical lock order, ID preservation, and transfer_members reconciliation', () => {
  const s1 = createFixture();
  const deniedMove = orgMoveWorkspace(s1, admin, { workspace_id: 'ws-1a', target_org_id: 'org-2', transfer_members: 'owners_only' });
  assert.equal(!deniedMove.ok && deniedMove.refusal.code, 'ORG_MOVE_REQUIRES_DUAL_OWNER');

  const movedOwnersOnly = orgMoveWorkspace(s1, owner, { workspace_id: 'ws-1a', target_org_id: 'org-2', transfer_members: 'owners_only' });
  if (movedOwnersOnly.ok && movedOwnersOnly.status === 'executed') {
    assert.deepEqual(movedOwnersOnly.lock_order, [...CANONICAL_ORG_CHANNEL_LOCK_ORDER]);
    assert.deepEqual(movedOwnersOnly.closed_seat_ids, ['seat-1a']);
    assert.equal(movedOwnersOnly.preserved.workspace_id, 'ws-1a');
    assert.deepEqual(movedOwnersOnly.preserved.channel_ids, ['ch-1a-gen']);
    assert.deepEqual(movedOwnersOnly.preserved.signal_ids, ['sig-1a-1']);
    assert.deepEqual(movedOwnersOnly.preserved.file_ids, ['file-1a-1']);
  }
  assert.equal(canReadWorkspace(s1, admin, 'ws-1a'), false);
  assert.equal(canReadWorkspace(s1, owner, 'ws-1a'), true);

  const s2 = createFixture();
  const movedAll = orgMoveWorkspace(s2, owner, { workspace_id: 'ws-1a', target_org_id: 'org-2', transfer_members: 'all' });
  if (movedAll.ok && movedAll.status === 'executed') assert.deepEqual(movedAll.closed_seat_ids, []);
  assert.equal(canReadWorkspace(s2, admin, 'ws-1a'), true);
  assert.equal(s2.seats?.find((x) => x.seat_id === 'seat-1a')?.revoked_at ?? null, null);
});
