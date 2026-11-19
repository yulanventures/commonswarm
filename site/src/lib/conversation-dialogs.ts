/**
 * Lazy-loaded Step 3C dialog bridge (New message picker + Channel/DM Members & Invite sheet).
 * Imported on demand by LiveDashboard so neither the dialog controllers nor their 5 command
 * wrappers add to /app's initial JS bundle.
 */
import type { Session } from "@supabase/supabase-js";
import { channelLabel, GENERAL_CHANNEL_SLUG } from "./channels.js";
import {
  addChannelMembers,
  inviteToConversation,
  openConversation,
  removeChannelMember,
  removeFromConversation,
} from "./commonswarm.js";
import type { ConversationMemberRef, ConversationSummary, OpenedConversation } from "./conversations.js";
import {
  createConversationPickerController,
  type ConversationCandidate,
  type ConversationPickerController,
} from "./conversation-picker.js";
import {
  channelMembersPermissions,
  createChannelMembersDialogController,
  type ChannelMembersDialogController,
  type ConversationMemberEntry,
} from "./channel-members-dialog.js";

export interface DialogWorkspaceRoster {
  viewerUserId: string;
  members: readonly { userId: string; displayName: string }[];
  people: ReadonlyMap<string, string>;
  agents: readonly { principalId: string; name: string }[];
}

export function buildConversationCandidates(roster: DialogWorkspaceRoster): ConversationCandidate[] {
  const viewerId = roster.viewerUserId.toLowerCase();
  const seen = new Set<string>();
  const users: ConversationCandidate[] = [];
  for (const member of roster.members) {
    const id = member.userId.toLowerCase();
    const key = `user:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (member.displayName || roster.people.get(member.userId) || "Member").trim();
    users.push({ kind: "user", id, name, self: id === viewerId });
  }
  for (const [userId, displayName] of roster.people.entries()) {
    const id = userId.toLowerCase();
    const key = `user:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    users.push({ kind: "user", id, name: displayName.trim() || "Member", self: id === viewerId });
  }
  users.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.name.localeCompare(b.name)));
  const liveAgents: ConversationCandidate[] = [];
  for (const agent of roster.agents) {
    const id = agent.principalId.toLowerCase();
    const key = `agent:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    liveAgents.push({ kind: "agent", id, name: agent.name.trim() || "Agent" });
  }
  liveAgents.sort((a, b) => a.name.localeCompare(b.name));
  return [...users, ...liveAgents];
}

export interface ConversationDialogsBridge {
  openNewMessage: (args: {
    dialog: HTMLDialogElement;
    workspaceId: string;
    pinnedUserId: string;
    roster: DialogWorkspaceRoster;
    lookupName: (ref: ConversationMemberRef) => string | null;
    getSession: () => Session | null;
    isCurrent: () => boolean;
    uuid: () => string;
    onOpened: (summary: ConversationSummary) => void;
    restoreFocus: () => void;
  }) => void;
  openMembers: (args: {
    dialog: HTMLDialogElement;
    workspaceId: string;
    pinnedUserId: string;
    conv: ConversationSummary;
    viewerCanManage: boolean;
    roster: DialogWorkspaceRoster;
    lookupName: (ref: ConversationMemberRef) => string | null;
    getSession: () => Session | null;
    isCurrent: () => boolean;
    uuid: () => string;
    onChanged: (nextMembers: ConversationMemberEntry[]) => void;
    restoreFocus: () => void;
  }) => void;
  closeAll: () => void;
}

export function createConversationDialogsBridge(): ConversationDialogsBridge {
  let pickerCtrl: ConversationPickerController | null = null;
  let membersCtrl: ChannelMembersDialogController | null = null;

  return {
    openNewMessage(args) {
      pickerCtrl ??= createConversationPickerController(args.dialog);
      pickerCtrl.open({
        viewerUserId: args.pinnedUserId,
        candidates: buildConversationCandidates(args.roster),
        onOpen: async (picked, newGroup) => {
          const session = args.getSession();
          if (!session || !args.isCurrent()) {
            return { ok: false, code: "other", message: "Sign in to start a conversation.", canStartNewGroup: false };
          }
          return await openConversation(session, args.uuid(), args.workspaceId, picked, newGroup);
        },
        onOpened: (opened) => {
          args.onOpened({
            conversationId: opened.conversationId,
            kind: opened.kind,
            channelId: null,
            slug: null,
            description: null,
            archivedAt: null,
            joined: true,
            generation: opened.generation,
            members: opened.members.map((m) => ({
              kind: m.kind,
              id: m.id,
              name: args.lookupName(m),
              leftAt: null,
            })),
            notifyLevel: "everything",
            starred: false,
            starRank: null,
            unreadCount: 0,
            mentionCount: 0,
            lastMessageAt: new Date().toISOString(),
            lastMessageId: null,
          });
        },
        restoreFocus: args.restoreFocus,
      });
    },
    openMembers(args) {
      const { conv, workspaceId, pinnedUserId } = args;
      const permissions = channelMembersPermissions(conv, args.viewerCanManage);
      const candidates = buildConversationCandidates(args.roster);
      const viewerIdLower = pinnedUserId.toLowerCase();
      const liveMembers = conv.members.filter((m) => !m.leftAt);
      const initialMembers: ConversationMemberEntry[] =
        conv.kind === "general" && liveMembers.length === 0
          ? candidates.map((c) => ({ kind: c.kind, id: c.id, name: c.name, self: c.self }))
          : liveMembers.map((m) => ({
            kind: m.kind,
            id: m.id.toLowerCase(),
            name: (m.name ?? args.lookupName(m) ?? (m.kind === "agent" ? "Agent" : "Member")).trim(),
            self: m.kind === "user" && m.id.toLowerCase() === viewerIdLower,
          }));
      const sheetTitle = conv.kind === "dm" || conv.kind === "group_dm"
        ? "Members"
        : `${channelLabel(conv.slug ?? GENERAL_CHANNEL_SLUG)} members`;
      membersCtrl ??= createChannelMembersDialogController(args.dialog);
      membersCtrl.open({
        title: sheetTitle,
        viewerUserId: pinnedUserId,
        permissions,
        members: initialMembers,
        candidates,
        onAdd: permissions.canAdd
          ? async (added) => {
            const session = args.getSession();
            if (!session || !args.isCurrent()) {
              return { ok: false, code: "other", message: "Sign in to add members." };
            }
            if (permissions.route === "private_channel" && conv.channelId) {
              return await addChannelMembers(session, args.uuid(), workspaceId, conv.channelId, added);
            }
            return await inviteToConversation(session, args.uuid(), workspaceId, conv.conversationId, added);
          }
          : undefined,
        onRemove: permissions.canRemove
          ? async (removed) => {
            const session = args.getSession();
            if (!session || !args.isCurrent()) {
              return { ok: false, code: "other", message: "Sign in to remove members." };
            }
            if (permissions.route === "private_channel" && conv.channelId) {
              return await removeChannelMember(session, args.uuid(), workspaceId, conv.channelId, removed);
            }
            return await removeFromConversation(session, args.uuid(), workspaceId, conv.conversationId, removed);
          }
          : undefined,
        onChanged: args.onChanged,
        restoreFocus: args.restoreFocus,
      });
    },
    closeAll() {
      pickerCtrl?.close(false);
      membersCtrl?.close(false);
    },
  };
}
