import type {
  CallerContext,
  ChannelJoinPolicy,
  ChannelRole,
  ChannelVisibility,
  NotifyPref,
  OrgChannelAuthorityState,
  PrincipalKind,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  channelArchive,
  channelCreate,
  channelGet,
  channelList,
  channelRename,
  channelSetTopic,
  channelSetVisibility,
} from './crud.js';
import {
  type ChannelSignalRecord,
  type SignalKind,
  type SignalMention,
  postChannelSignal,
} from './delivery-filter.js';
import {
  authorizeFileDownloadUrl,
  bindFileToChannel,
} from './indirect-guards.js';
import {
  channelAddMember,
  channelJoin,
  channelLeave,
  channelListMembers,
  channelRemoveMember,
  channelSetNotifyPref,
} from './members.js';

export * from './crud.js';
export * from './members.js';
export * from './delivery-filter.js';
export * from './indirect-guards.js';

export {
  channelCreate as channel_create,
  channelList as channel_list,
  channelGet as channel_get,
  channelArchive as channel_archive,
  channelRename as channel_rename,
  channelSetTopic as channel_set_topic,
  channelSetVisibility as channel_set_visibility,
  channelJoin as channel_join,
  channelLeave as channel_leave,
  channelAddMember as channel_add_member,
  channelRemoveMember as channel_remove_member,
  channelListMembers as channel_list_members,
  channelSetNotifyPref as channel_set_notify_pref,
};

export type Slice2ChannelCommand =
  | {
      kind: 'channel_create';
      workspace_id: string;
      channel_id?: string;
      slug: string;
      purpose?: string | null;
      topic?: string | null;
      visibility?: ChannelVisibility;
      join_policy?: ChannelJoinPolicy;
      now?: string;
    }
  | {
      kind: 'channel_list';
      workspace_id: string;
      include_archived?: boolean;
    }
  | {
      kind: 'channel_get';
      workspace_id: string;
      channel_id?: string | null;
      slug?: string | null;
    }
  | {
      kind: 'channel_archive';
      workspace_id: string;
      channel_id: string;
      now?: string;
    }
  | {
      kind: 'channel_rename';
      workspace_id: string;
      channel_id: string;
      slug: string;
    }
  | {
      kind: 'channel_set_topic';
      workspace_id: string;
      channel_id: string;
      topic: string | null;
      purpose?: string | null;
    }
  | {
      kind: 'channel_set_visibility';
      workspace_id: string;
      channel_id: string;
      visibility: ChannelVisibility;
      join_policy?: ChannelJoinPolicy;
      signal_count?: number;
      bound_file_count?: number;
    }
  | {
      kind: 'channel_join';
      workspace_id: string;
      channel_id: string;
      notify_pref?: NotifyPref;
      now?: string;
    }
  | {
      kind: 'channel_leave';
      workspace_id: string;
      channel_id: string;
      now?: string;
    }
  | {
      kind: 'channel_add_member';
      workspace_id: string;
      channel_id: string;
      principal_kind: PrincipalKind;
      principal_id: string;
      role?: ChannelRole;
      notify_pref?: NotifyPref;
      now?: string;
    }
  | {
      kind: 'channel_remove_member';
      workspace_id: string;
      channel_id: string;
      principal_kind: PrincipalKind;
      principal_id: string;
      now?: string;
    }
  | {
      kind: 'channel_list_members';
      workspace_id: string;
      channel_id: string;
    }
  | {
      kind: 'channel_set_notify_pref';
      workspace_id: string;
      channel_id: string;
      notify_pref: NotifyPref;
      now?: string;
    }
  | {
      kind: 'channel_post_signal';
      signal_id?: string;
      workspace_id: string;
      channel_id?: string | null;
      thread_id?: string | null;
      thread_root_id?: string | null;
      in_reply_to?: string | null;
      signal_kind?: SignalKind;
      body: string;
      mentions?: SignalMention[];
      attachment_file_ids?: string[];
      seat_id?: string | null;
      existing_signals?: readonly ChannelSignalRecord[];
      candidate_recipients?: readonly CallerContext[];
      now?: string;
    }
  | {
      kind: 'channel_bind_file';
      file_id: string;
      workspace_id: string;
      channel_id: string;
      now?: string;
    }
  | {
      kind: 'channel_file_download_url';
      workspace_id: string;
      file_id: string;
      version_n?: number;
      ttl_seconds?: number;
    };

export const SLICE2_CHANNEL_COMMAND_KINDS = [
  'channel_create',
  'channel_list',
  'channel_get',
  'channel_archive',
  'channel_rename',
  'channel_set_topic',
  'channel_set_visibility',
  'channel_join',
  'channel_leave',
  'channel_add_member',
  'channel_remove_member',
  'channel_list_members',
  'channel_set_notify_pref',
  'channel_post_signal',
  'channel_bind_file',
  'channel_file_download_url',
] as const;

export function dispatchChannelCommand(
  s: OrgChannelAuthorityState,
  caller: CallerContext,
  cmd: Slice2ChannelCommand,
) {
  switch (cmd.kind) {
    case 'channel_create':
      return channelCreate(s, caller, cmd);
    case 'channel_list':
      return channelList(s, caller, cmd);
    case 'channel_get':
      return channelGet(s, caller, cmd);
    case 'channel_archive':
      return channelArchive(s, caller, cmd);
    case 'channel_rename':
      return channelRename(s, caller, cmd);
    case 'channel_set_topic':
      return channelSetTopic(s, caller, cmd);
    case 'channel_set_visibility':
      return channelSetVisibility(s, caller, cmd);
    case 'channel_join':
      return channelJoin(s, caller, cmd);
    case 'channel_leave':
      return channelLeave(s, caller, cmd);
    case 'channel_add_member':
      return channelAddMember(s, caller, cmd);
    case 'channel_remove_member':
      return channelRemoveMember(s, caller, cmd);
    case 'channel_list_members':
      return channelListMembers(s, caller, cmd);
    case 'channel_set_notify_pref':
      return channelSetNotifyPref(s, caller, cmd);
    case 'channel_post_signal':
      return postChannelSignal(s, caller, cmd);
    case 'channel_bind_file':
      return bindFileToChannel(s, caller, cmd);
    case 'channel_file_download_url':
      return authorizeFileDownloadUrl(s, caller, cmd);
  }
}
