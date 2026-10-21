import {
  type CallerContext,
  fail,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  orgConfirmAction,
  orgInviteAccept,
  orgInviteCreate,
  orgInviteRevoke,
} from './invites.js';
import {
  orgCreate,
  orgDelete,
  orgList,
  orgUpdate,
} from './crud.js';
import {
  orgListMembers,
  orgRemoveMember,
  orgSetMemberRole,
} from './members.js';
import {
  orgAssignWorkspaceMember,
  orgRemoveWorkspaceMember,
  workspaceJoin,
  workspaceLeave,
  workspaceListMembers,
} from './workspace-grants.js';
import {
  orgLogoFinalize,
  orgLogoRemove,
  orgLogoUploadPrepare,
} from './logo.js';
import { orgMoveWorkspace } from './move-workspace.js';

export * from '../../../../src/protocol/org-channels-contract.js';
export * from './invites.js';
export * from './crud.js';
export * from './members.js';
export * from './workspace-grants.js';
export * from './logo.js';
export * from './move-workspace.js';

export const ORG_SLICE1_COMMAND_KINDS = [
  'org_create',
  'org_update',
  'org_delete',
  'org_list',
  'org_list_members',
  'org_set_member_role',
  'org_remove_member',
  'org_assign_workspace_member',
  'org_remove_workspace_member',
  'workspace_join',
  'workspace_leave',
  'workspace_list_members',
  'org_invite_create',
  'org_invite_accept',
  'org_invite_revoke',
  'org_confirm_action',
  'org_logo_upload_prepare',
  'org_logo_finalize',
  'org_logo_remove',
  'org_move_workspace',
] as const;

export type OrgSlice1CommandKind = (typeof ORG_SLICE1_COMMAND_KINDS)[number];

export type OrgSlice1Command =
  | ({ kind: 'org_create' } & Parameters<typeof orgCreate>[2])
  | ({ kind: 'org_update' } & Parameters<typeof orgUpdate>[2])
  | ({ kind: 'org_delete' } & Parameters<typeof orgDelete>[2])
  | { kind: 'org_list' }
  | ({ kind: 'org_list_members' } & Parameters<typeof orgListMembers>[2])
  | ({ kind: 'org_set_member_role' } & Parameters<typeof orgSetMemberRole>[2])
  | ({ kind: 'org_remove_member' } & Parameters<typeof orgRemoveMember>[2])
  | ({ kind: 'org_assign_workspace_member' } & Parameters<typeof orgAssignWorkspaceMember>[2])
  | ({ kind: 'org_remove_workspace_member' } & Parameters<typeof orgRemoveWorkspaceMember>[2])
  | ({ kind: 'workspace_join' } & Parameters<typeof workspaceJoin>[2])
  | ({ kind: 'workspace_leave' } & Parameters<typeof workspaceLeave>[2])
  | ({ kind: 'workspace_list_members' } & Parameters<typeof workspaceListMembers>[2])
  | ({ kind: 'org_invite_create' } & Parameters<typeof orgInviteCreate>[2])
  | ({ kind: 'org_invite_accept' } & Parameters<typeof orgInviteAccept>[2])
  | ({ kind: 'org_invite_revoke' } & Parameters<typeof orgInviteRevoke>[2])
  | ({ kind: 'org_confirm_action' } & Parameters<typeof orgConfirmAction>[2])
  | ({ kind: 'org_logo_upload_prepare' } & Parameters<typeof orgLogoUploadPrepare>[2])
  | ({ kind: 'org_logo_finalize' } & Parameters<typeof orgLogoFinalize>[2])
  | ({ kind: 'org_logo_remove' } & Parameters<typeof orgLogoRemove>[2])
  | ({ kind: 'org_move_workspace' } & Parameters<typeof orgMoveWorkspace>[2]);

export function isOrgSlice1CommandKind(kind: unknown): kind is OrgSlice1CommandKind {
  return typeof kind === 'string' && (ORG_SLICE1_COMMAND_KINDS as readonly string[]).includes(kind);
}

export function dispatchOrgCommand(
  state: OrgAuthorityState,
  caller: CallerContext,
  command: OrgSlice1Command | ({ kind: string } & Record<string, unknown>),
) {
  switch (command.kind) {
    case 'org_create':
      return orgCreate(state, caller, command as Parameters<typeof orgCreate>[2]);
    case 'org_update':
      return orgUpdate(state, caller, command as Parameters<typeof orgUpdate>[2]);
    case 'org_delete':
      return orgDelete(state, caller, command as Parameters<typeof orgDelete>[2]);
    case 'org_list':
      return orgList(state, caller);
    case 'org_list_members':
      return orgListMembers(state, caller, command as Parameters<typeof orgListMembers>[2]);
    case 'org_set_member_role':
      return orgSetMemberRole(state, caller, command as Parameters<typeof orgSetMemberRole>[2]);
    case 'org_remove_member':
      return orgRemoveMember(state, caller, command as Parameters<typeof orgRemoveMember>[2]);
    case 'org_assign_workspace_member':
      return orgAssignWorkspaceMember(
        state,
        caller,
        command as Parameters<typeof orgAssignWorkspaceMember>[2],
      );
    case 'org_remove_workspace_member':
      return orgRemoveWorkspaceMember(
        state,
        caller,
        command as Parameters<typeof orgRemoveWorkspaceMember>[2],
      );
    case 'workspace_join':
      return workspaceJoin(state, caller, command as Parameters<typeof workspaceJoin>[2]);
    case 'workspace_leave':
      return workspaceLeave(state, caller, command as Parameters<typeof workspaceLeave>[2]);
    case 'workspace_list_members':
      return workspaceListMembers(
        state,
        caller,
        command as Parameters<typeof workspaceListMembers>[2],
      );
    case 'org_invite_create':
      return orgInviteCreate(state, caller, command as Parameters<typeof orgInviteCreate>[2]);
    case 'org_invite_accept':
      return orgInviteAccept(state, caller, command as Parameters<typeof orgInviteAccept>[2]);
    case 'org_invite_revoke':
      return orgInviteRevoke(state, caller, command as Parameters<typeof orgInviteRevoke>[2]);
    case 'org_confirm_action':
      return orgConfirmAction(state, caller, command as Parameters<typeof orgConfirmAction>[2]);
    case 'org_logo_upload_prepare':
      return orgLogoUploadPrepare(
        state,
        caller,
        command as Parameters<typeof orgLogoUploadPrepare>[2],
      );
    case 'org_logo_finalize':
      return orgLogoFinalize(state, caller, command as Parameters<typeof orgLogoFinalize>[2]);
    case 'org_logo_remove':
      return orgLogoRemove(state, caller, command as Parameters<typeof orgLogoRemove>[2]);
    case 'org_move_workspace':
      return orgMoveWorkspace(state, caller, command as Parameters<typeof orgMoveWorkspace>[2]);
    default:
      return fail('UNKNOWN_ORG_COMMAND', String(command.kind ?? 'command_kind'), {});
  }
}

export const executeOrgCommand = dispatchOrgCommand;
