import {
  CANONICAL_ORG_CHANNEL_LOCK_ORDER,
  type CallerContext,
  type WorkspaceMoveTransferMode,
  agentOwner,
  cascadeWorkspaceMemberRemoval,
  fail,
  isLive,
  norm,
  orgRole,
  reconcileWorkspaceMove,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  createOrgApprovalCard,
  findLiveOrg,
  findLiveWorkspace,
  registerOrgActionExecutor,
} from './invites.js';

export function orgMoveWorkspace(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    workspace_id: string;
    source_org_id?: string;
    target_org_id: string;
    transfer_members?: WorkspaceMoveTransferMode;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const transferMode: WorkspaceMoveTransferMode = input.transfer_members ?? 'owners_only';
  if (transferMode !== 'all' && transferMode !== 'owners_only') {
    return fail('INVALID_TRANSFER_MEMBERS_MODE', 'all_or_owners_only', {
      org: input.target_org_id,
      workspace: input.workspace_id,
    });
  }

  const ws = findLiveWorkspace(state, input.workspace_id, input.source_org_id);
  if (!ws) {
    return fail('WORKSPACE_NOT_FOUND', 'workspace', {
      org: input.source_org_id ?? null,
      workspace: input.workspace_id,
    });
  }
  const sourceOrg = findLiveOrg(state, ws.org_id);
  const targetOrg = findLiveOrg(state, input.target_org_id);
  if (!sourceOrg || !targetOrg) {
    return fail('ORG_NOT_FOUND', 'target_organization', {
      org: input.target_org_id,
      workspace: ws.slug,
    });
  }

  if (sourceOrg.id === targetOrg.id) {
    return fail('WORKSPACE_ALREADY_IN_TARGET_ORG', 'distinct_target_org', {
      org: targetOrg.slug,
      workspace: ws.slug,
    });
  }

  if (
    state.workspaces.some(
      (w) =>
        w.org_id === targetOrg.id &&
        w.workspace_id !== ws.workspace_id &&
        isLive(w) &&
        norm(w.slug) === norm(ws.slug),
    )
  ) {
    return fail('WORKSPACE_SLUG_CONFLICT_IN_TARGET_ORG', 'unique_workspace_slug_in_target_org', {
      org: targetOrg.slug,
      workspace: ws.slug,
    });
  }

  if (caller.principal_kind === 'agent') {
    const ownerId = agentOwner(state, caller);
    const isDualOwner =
      Boolean(ownerId) &&
      orgRole(state, sourceOrg.id, 'user', ownerId!) === 'owner' &&
      orgRole(state, targetOrg.id, 'user', ownerId!) === 'owner';
    if (!isDualOwner) {
      return fail('ORG_MOVE_REQUIRES_DUAL_OWNER', 'dual_org_owner_role', {
        org: targetOrg.slug,
        workspace: ws.slug,
      });
    }
    return createOrgApprovalCard(state, caller, {
      org: sourceOrg,
      workspace_id: ws.workspace_id,
      action_kind: 'org_move_workspace',
      target_scope: {
        source_org: sourceOrg.slug,
        target_org: targetOrg.slug,
        workspace: ws.slug,
        transfer_members: transferMode,
      },
      payload: {
        workspace_id: ws.workspace_id,
        source_org_id: sourceOrg.id,
        target_org_id: targetOrg.id,
        transfer_members: transferMode,
      },
      now,
    });
  }

  if (
    orgRole(state, sourceOrg.id, 'user', caller.principal_id) !== 'owner' ||
    orgRole(state, targetOrg.id, 'user', caller.principal_id) !== 'owner'
  ) {
    return fail('ORG_MOVE_REQUIRES_DUAL_OWNER', 'dual_org_owner_role', {
      org: targetOrg.slug,
      workspace: ws.slug,
    });
  }

  // Acquire locks in canonical lock order:
  // organizations -> workspaces -> channels -> org_memberships -> workspace_principal_grants -> channel_memberships -> agent_principals -> seats
  state.lockLog ??= [];
  const acquiredLocks = [...CANONICAL_ORG_CHANNEL_LOCK_ORDER];
  state.lockLog.push(...acquiredLocks);

  const reconciled = reconcileWorkspaceMove(state, {
    workspace_id: ws.workspace_id,
    target_org_id: targetOrg.id,
    actor_user_id: caller.principal_id,
    transfer_members: transferMode,
    now,
  });
  if (!reconciled.ok) return reconciled;

  const closedSeats = [...reconciled.closed_seat_ids];

  if (transferMode === 'owners_only') {
    for (const cm of state.channelMemberships) {
      if (
        cm.workspace_id === ws.workspace_id &&
        isLive(cm) &&
        orgRole(state, targetOrg.id, cm.principal_kind, cm.principal_id) !== 'owner'
      ) {
        const extra = cascadeWorkspaceMemberRemoval(state, {
          workspace_id: ws.workspace_id,
          principal_kind: cm.principal_kind,
          principal_id: cm.principal_id,
          now,
        });
        for (const sid of extra.closed_seat_ids) {
          if (!closedSeats.includes(sid)) closedSeats.push(sid);
        }
      }
    }
    for (const ap of state.agentPrincipals ?? []) {
      if (
        ap.workspace_id === ws.workspace_id &&
        isLive(ap) &&
        orgRole(state, targetOrg.id, 'agent', ap.agent_identity_id) !== 'owner'
      ) {
        const extra = cascadeWorkspaceMemberRemoval(state, {
          workspace_id: ws.workspace_id,
          principal_kind: 'agent',
          principal_id: ap.agent_identity_id,
          now,
        });
        for (const sid of extra.closed_seat_ids) {
          if (!closedSeats.includes(sid)) closedSeats.push(sid);
        }
      }
    }
  }

  for (const ch of state.channels) {
    if (ch.workspace_id === ws.workspace_id && ch.org_id !== undefined) {
      ch.org_id = targetOrg.id;
    }
  }

  const preservedChannelIds = state.channels
    .filter((ch) => ch.workspace_id === ws.workspace_id)
    .map((ch) => ch.channel_id);
  const preservedSignalIds = (state.signals ?? [])
    .filter((sig) => sig.workspace_id === ws.workspace_id)
    .map((sig) => sig.signal_id);
  const preservedFileIds = Array.from(
    new Set([
      ...(state.files ?? [])
        .filter((f) => f.workspace_id === ws.workspace_id)
        .map((f) => f.file_id),
      ...(state.fileChannelBindings ?? [])
        .filter((b) => b.workspace_id === ws.workspace_id)
        .map((b) => b.file_id),
    ]),
  );

  return {
    ok: true as const,
    status: 'executed' as const,
    workspace_id: ws.workspace_id,
    source_org_id: sourceOrg.id,
    target_org_id: targetOrg.id,
    transfer_members: transferMode,
    lock_order: acquiredLocks,
    closed_seat_ids: closedSeats,
    preserved: {
      workspace_id: ws.workspace_id,
      channel_ids: preservedChannelIds,
      signal_ids: preservedSignalIds,
      file_ids: preservedFileIds,
    },
  };
}

registerOrgActionExecutor('org_move_workspace', (s, c, p) =>
  orgMoveWorkspace(s, c, p as Parameters<typeof orgMoveWorkspace>[2]),
);

export const org_move_workspace = orgMoveWorkspace;
