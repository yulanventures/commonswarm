import { fail } from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  type OrgCallerContext,
  type OrgCommandOptions,
  type OrgSqlExecutor,
  orgConfirmAction,
  orgInviteAccept,
  orgInviteCreate,
  orgInviteRevoke,
  withOrgTx,
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

type CommandArg = OrgSlice1Command | ({ kind: string } & Record<string, unknown>);

function normalizeDispatchOptions(
  dbOrOptions?: OrgSqlExecutor | OrgCommandOptions,
): OrgCommandOptions {
  if (!dbOrOptions) return {};
  if ('query' in dbOrOptions && typeof dbOrOptions.query === 'function') {
    return { db: dbOrOptions };
  }
  return dbOrOptions as OrgCommandOptions;
}

export function dispatchOrgCommand(
  state: OrgAuthorityState,
  callerOrCommand: OrgCallerContext | CommandArg,
  commandOrCaller: CommandArg | OrgCallerContext,
  dbOrOptions?: OrgSqlExecutor | OrgCommandOptions,
) {
  const isFirstCaller =
    typeof callerOrCommand === 'object' &&
    callerOrCommand !== null &&
    'principal_kind' in callerOrCommand &&
    !('kind' in callerOrCommand);
  const caller = (isFirstCaller ? callerOrCommand : commandOrCaller) as OrgCallerContext;
  const command = (isFirstCaller ? commandOrCaller : callerOrCommand) as CommandArg;
  const opts = normalizeDispatchOptions(dbOrOptions);
  const db = opts.db;

  return withOrgTx(state, db, (tx) => {
    switch (command.kind) {
      case 'org_create':
        return orgCreate(state, caller, command as Parameters<typeof orgCreate>[2], tx);
      case 'org_update':
        return orgUpdate(state, caller, command as Parameters<typeof orgUpdate>[2], tx);
      case 'org_delete':
        return orgDelete(state, caller, command as Parameters<typeof orgDelete>[2], tx);
      case 'org_list':
        return orgList(state, caller);
      case 'org_list_members':
        return orgListMembers(state, caller, command as Parameters<typeof orgListMembers>[2]);
      case 'org_set_member_role':
        return orgSetMemberRole(
          state,
          caller,
          command as Parameters<typeof orgSetMemberRole>[2],
          tx,
        );
      case 'org_remove_member':
        return orgRemoveMember(state, caller, command as Parameters<typeof orgRemoveMember>[2], tx);
      case 'org_assign_workspace_member':
        return orgAssignWorkspaceMember(
          state,
          caller,
          command as Parameters<typeof orgAssignWorkspaceMember>[2],
          tx,
        );
      case 'org_remove_workspace_member':
        return orgRemoveWorkspaceMember(
          state,
          caller,
          command as Parameters<typeof orgRemoveWorkspaceMember>[2],
          tx,
        );
      case 'workspace_join':
        return workspaceJoin(state, caller, command as Parameters<typeof workspaceJoin>[2], tx);
      case 'workspace_leave':
        return workspaceLeave(state, caller, command as Parameters<typeof workspaceLeave>[2], tx);
      case 'workspace_list_members':
        return workspaceListMembers(
          state,
          caller,
          command as Parameters<typeof workspaceListMembers>[2],
        );
      case 'org_invite_create':
        return orgInviteCreate(state, caller, command as Parameters<typeof orgInviteCreate>[2], tx);
      case 'org_invite_accept':
        return orgInviteAccept(state, caller, command as Parameters<typeof orgInviteAccept>[2], {
          ...opts,
          db: tx,
        });
      case 'org_invite_revoke':
        return orgInviteRevoke(state, caller, command as Parameters<typeof orgInviteRevoke>[2], tx);
      case 'org_confirm_action':
        return orgConfirmAction(state, caller, command as Parameters<typeof orgConfirmAction>[2], {
          ...opts,
          db: tx,
        });
      case 'org_logo_upload_prepare':
        return orgLogoUploadPrepare(
          state,
          caller,
          command as Parameters<typeof orgLogoUploadPrepare>[2],
          tx,
        );
      case 'org_logo_finalize':
        return orgLogoFinalize(state, caller, command as Parameters<typeof orgLogoFinalize>[2], tx);
      case 'org_logo_remove':
        return orgLogoRemove(state, caller, command as Parameters<typeof orgLogoRemove>[2], tx);
      case 'org_move_workspace':
        return orgMoveWorkspace(
          state,
          caller,
          command as Parameters<typeof orgMoveWorkspace>[2],
          tx,
        );
      default:
        return fail('UNKNOWN_ORG_COMMAND', String(command.kind ?? 'command_kind'), {});
    }
  });
}

export const executeOrgCommand = dispatchOrgCommand;

export function readLogoDimensions(data: Uint8Array | string, ct: string): { width: number; height: number } | null {
  if (ct === 'image/svg+xml') {
    const tag = (typeof data === 'string' ? data : new TextDecoder().decode(data)).match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const w = Number(tag.match(/\bwidth="(\d+)"/i)?.[1] ?? 0), h = Number(tag.match(/\bheight="(\d+)"/i)?.[1] ?? 0);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (ct === 'image/png' && b.byteLength >= 24) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  if (ct === 'image/jpeg') {
    for (let i = 0; i + 8 < b.byteLength; i++) if (b[i] === 0xff && b[i + 1] === 0xc0) return { width: (b[i + 7]! << 8) | b[i + 8]!, height: (b[i + 5]! << 8) | b[i + 6]! };
  }
  if (ct === 'image/webp' && b.byteLength >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) {
    return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  return null;
}
