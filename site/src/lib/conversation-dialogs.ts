/**
 * Lazy-loaded Step 3C dialog bridge (New message picker + Channel/DM Members & Invite sheet).
 * Imported on demand by LiveDashboard so neither the dialog controllers nor their command
 * wrappers add to /app's initial JS bundle.
 *
 * Enforces HezSec Step 3C invariants:
 * - C2: Re-resolves active conversation after lazy load / manager check, runs a fresh
 *   authoritative read (access, joined, archive, manager) before every Add/Remove dispatch,
 *   admits promoted private-channel managers and creator-agent owners, and invalidates stale
 *   open sheets on route/list/role change.
 * - C3: Carries one operation lifetime across lazy load, submit, 401 auth retry, and final
 *   navigation, retiring it on close, replacement, or workspace/account reset, and preserves
 *   commandId across unchanged retries of an open action.
 */
import type { Session } from "@supabase/supabase-js";
import { channelLabel, GENERAL_CHANNEL_SLUG, type WorkspaceRole } from "./channels.js";
import {
  addChannelMembers,
  inviteToConversation,
  isPromotedPrivateChannelManager,
  listConversations,
  openConversation,
  removeChannelMember,
  removeFromConversation,
  type PinnedAccountContext,
} from "./commonswarm.js";
import type { ConversationKind, ConversationMemberRef, ConversationSummary } from "./conversations.js";
import {
  createConversationPickerController,
  type ConversationCandidate,
  type ConversationPickerController,
} from "./conversation-picker.js";
import {
  channelMembersPermissions,
  createChannelMembersDialogController,
  viewerCanManageConversationChannel,
  type ChannelMembersDialogController,
  type ChannelMembersPermissions,
  type ConversationMemberEntry,
} from "./channel-members-dialog.js";

export interface DialogWorkspaceRoster {
  viewerUserId: string;
  members: readonly { userId: string; displayName: string }[];
  people: ReadonlyMap<string, string>;
  agents: readonly { principalId: string; name: string; ownerUserId?: string | null }[];
}

export interface ChannelManageContext {
  channel: { createdByKind: "user" | "agent"; createdByPrincipal: string } | null;
  viewerRole: WorkspaceRole | null;
  ownedAgentIds: ReadonlySet<string>;
}

export interface OpenMembersSnapshot {
  conversationId: string;
  kind: ConversationKind;
  route: ChannelMembersPermissions["route"];
  channelId: string | null;
  archivedAt: string | null;
  joined: boolean;
  canAdd: boolean;
  canRemove: boolean;
  promotedPrivateManager: boolean;
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

export interface OperationLifetime {
  isAlive: () => boolean;
  retire: () => void;
  signal: AbortSignal;
}

export function createOperationLifetime(isHostAlive: () => boolean): OperationLifetime {
  let retired = false;
  const controller = new AbortController();
  return {
    signal: controller.signal,
    isAlive: () => !retired && !controller.signal.aborted && isHostAlive(),
    retire: () => {
      retired = true;
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

export interface ConversationDialogsBridge {
  openNewMessage: (args: {
    dialog: HTMLDialogElement;
    workspaceId: string;
    pinnedUserId: string;
    pinned?: PinnedAccountContext | null;
    roster: DialogWorkspaceRoster;
    lookupName: (ref: ConversationMemberRef) => string | null;
    getSession: () => Session | null;
    isHostAlive: () => boolean;
    uuid: () => string;
    onOpened: (summary: ConversationSummary, isAlive: () => boolean) => void;
    restoreFocus: () => void;
  }) => void;
  openMembers: (args: {
    dialog: HTMLDialogElement;
    workspaceId: string;
    pinnedUserId: string;
    pinned?: PinnedAccountContext | null;
    requestedConvId: string;
    resolveActiveConversation: () => ConversationSummary | null;
    resolveManageContext: (channelId: string | null) => ChannelManageContext;
    roster: DialogWorkspaceRoster;
    lookupName: (ref: ConversationMemberRef) => string | null;
    getSession: () => Session | null;
    isHostAlive: () => boolean;
    uuid: () => string;
    beginConversationsRead: () => number;
    commitConversationsRead: (generation: number, rows: ConversationSummary[]) => boolean;
    onOpenedSnapshot: (snapshot: OpenMembersSnapshot) => void;
    onClosed: () => void;
    onChanged: (nextMembers: ConversationMemberEntry[]) => void;
    restoreFocus: () => void;
  }) => Promise<void>;
  computePermissions: (args: {
    conv: ConversationSummary;
    viewerUserId: string;
    manageContext: ChannelManageContext;
    isPromotedPrivateManager?: boolean;
  }) => ChannelMembersPermissions;
  checkPromotedPrivateManager: (
    workspaceId: string,
    channelId: string,
    userId: string,
    options?: { pinned?: PinnedAccountContext | null; signal?: AbortSignal },
  ) => Promise<boolean>;
  closeMembers: (restoreFocus?: boolean) => void;
  closeAll: () => void;
}

export function createConversationDialogsBridge(): ConversationDialogsBridge {
  let pickerCtrl: ConversationPickerController | null = null;
  let membersCtrl: ChannelMembersDialogController | null = null;
  let pickerLifetime: OperationLifetime | null = null;
  let membersLifetime: OperationLifetime | null = null;

  const computePermissions: ConversationDialogsBridge["computePermissions"] = ({
    conv,
    viewerUserId,
    manageContext,
    isPromotedPrivateManager,
  }) => {
    const canManage = viewerCanManageConversationChannel({
      channel: manageContext.channel,
      conv,
      viewerUserId,
      viewerRole: manageContext.viewerRole,
      ownedAgentIds: manageContext.ownedAgentIds,
      isPromotedPrivateManager,
    });
    return channelMembersPermissions(conv, canManage);
  };

  return {
    computePermissions,
    checkPromotedPrivateManager: isPromotedPrivateChannelManager,
    openNewMessage(args) {
      pickerLifetime?.retire();
      const lifetime = createOperationLifetime(args.isHostAlive);
      pickerLifetime = lifetime;
      if (!lifetime.isAlive()) {
        lifetime.retire();
        return;
      }
      pickerCtrl ??= createConversationPickerController(args.dialog);
      pickerCtrl.open({
        viewerUserId: args.pinnedUserId,
        candidates: buildConversationCandidates(args.roster),
        newCommandId: args.uuid,
        onOpen: async (picked, newGroup, commandId) => {
          const session = args.getSession();
          if (!session || !lifetime.isAlive()) {
            return { ok: false, code: "other", message: "Action cancelled.", canStartNewGroup: false };
          }
          return await openConversation(session, commandId, args.workspaceId, picked, newGroup, {
            isAlive: lifetime.isAlive,
            signal: lifetime.signal,
            pinned: args.pinned,
          });
        },
        onOpened: (opened) => {
          if (!lifetime.isAlive()) return;
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
          }, lifetime.isAlive);
        },
        onRetire: () => {
          lifetime.retire();
          if (pickerLifetime === lifetime) pickerLifetime = null;
        },
        restoreFocus: args.restoreFocus,
      });
    },
    async openMembers(args) {
      membersLifetime?.retire();
      const lifetime = createOperationLifetime(args.isHostAlive);
      membersLifetime = lifetime;
      if (!lifetime.isAlive()) {
        lifetime.retire();
        return;
      }
      const resolvedInitial = args.resolveActiveConversation();
      if (!resolvedInitial || resolvedInitial.conversationId !== args.requestedConvId) {
        lifetime.retire();
        return;
      }

      const manageCtxInitial = args.resolveManageContext(resolvedInitial.channelId);
      let promotedManager = false;
      if (resolvedInitial.kind === "private_channel" && resolvedInitial.channelId) {
        const alreadyManager = viewerCanManageConversationChannel({
          channel: manageCtxInitial.channel,
          conv: resolvedInitial,
          viewerUserId: args.pinnedUserId,
          viewerRole: manageCtxInitial.viewerRole,
          ownedAgentIds: manageCtxInitial.ownedAgentIds,
        });
        if (!alreadyManager) {
          promotedManager = await isPromotedPrivateChannelManager(
            args.workspaceId,
            resolvedInitial.channelId,
            args.pinnedUserId,
            { pinned: args.pinned, signal: lifetime.signal },
          );
          if (!lifetime.isAlive()) return;
        }
      }

      // Re-resolve active conversation after any await (C2).
      const conv = args.resolveActiveConversation();
      if (!conv || conv.conversationId !== args.requestedConvId) {
        lifetime.retire();
        return;
      }
      const manageCtx = args.resolveManageContext(conv.channelId);
      const permissions = computePermissions({
        conv,
        viewerUserId: args.pinnedUserId,
        manageContext: manageCtx,
        isPromotedPrivateManager: promotedManager,
      });
      const convId = conv.conversationId;
      const channelId = conv.channelId;
      const initialKind = conv.kind;
      const initialRoute = permissions.route;
      const candidates = buildConversationCandidates(args.roster);
      const viewerIdLower = args.pinnedUserId.toLowerCase();
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

      // Fresh authoritative pre-dispatch gate (C2): checks active route, live access, joined,
      // archive, unchanged visibility/kind/command route, and role using the shared list generation.
      const revalidateForMutation = async (
        action: "add" | "remove",
      ): Promise<{ ok: true; freshConv: ConversationSummary; perms: ChannelMembersPermissions } | { ok: false; message: string }> => {
        if (!lifetime.isAlive()) return { ok: false, message: "Action cancelled." };
        const activeNow = args.resolveActiveConversation();
        if (!activeNow || activeNow.conversationId !== convId || activeNow.kind !== initialKind) {
          membersCtrl?.close(false);
          return { ok: false, message: "This channel changed. Reopen Members to continue." };
        }
        const readGen = args.beginConversationsRead();
        let freshRows: ConversationSummary[];
        try {
          freshRows = await listConversations(args.workspaceId, true, {
            pinned: args.pinned,
            signal: lifetime.signal,
            expectedUserId: args.pinnedUserId,
            isAlive: lifetime.isAlive,
          });
        } catch {
          return {
            ok: false,
            message: !lifetime.isAlive() ? "Action cancelled." : "Couldn't verify channel access. Try again.",
          };
        }
        if (!lifetime.isAlive()) return { ok: false, message: "Action cancelled." };
        if (!args.commitConversationsRead(readGen, freshRows)) {
          membersCtrl?.close(false);
          return { ok: false, message: "Channel state updated. Reopen Members to continue." };
        }
        const activeAfter = args.resolveActiveConversation();
        if (!activeAfter || activeAfter.conversationId !== convId) {
          membersCtrl?.close(false);
          return { ok: false, message: "This channel isn't available anymore." };
        }
        const freshConv = freshRows.find((c) => c.conversationId === convId) ?? null;
        if (!freshConv || !freshConv.joined || freshConv.archivedAt !== null || freshConv.kind !== initialKind) {
          membersCtrl?.close(false);
          return {
            ok: false,
            message: freshConv?.archivedAt
              ? "That channel is archived, so its members can't be changed."
              : freshConv && freshConv.kind !== initialKind
                ? "Channel visibility changed. Reopen Members to confirm."
                : "This channel isn't available anymore.",
          };
        }
        const freshManageCtx = args.resolveManageContext(freshConv.channelId);
        let freshPromoted = false;
        if (freshConv.kind === "private_channel" && freshConv.channelId) {
          const already = viewerCanManageConversationChannel({
            channel: freshManageCtx.channel,
            conv: freshConv,
            viewerUserId: args.pinnedUserId,
            viewerRole: freshManageCtx.viewerRole,
            ownedAgentIds: freshManageCtx.ownedAgentIds,
          });
          if (!already) {
            freshPromoted = await isPromotedPrivateChannelManager(
              args.workspaceId,
              freshConv.channelId,
              args.pinnedUserId,
              { pinned: args.pinned, signal: lifetime.signal },
            );
            if (!lifetime.isAlive()) return { ok: false, message: "Action cancelled." };
          }
        }
        const freshPerms = computePermissions({
          conv: freshConv,
          viewerUserId: args.pinnedUserId,
          manageContext: freshManageCtx,
          isPromotedPrivateManager: freshPromoted,
        });
        const allowed = freshPerms.route === initialRoute && (action === "add" ? freshPerms.canAdd : freshPerms.canRemove);
        if (!allowed) {
          membersCtrl?.close(false);
          return { ok: false, message: "You can no longer change members in this channel." };
        }
        return { ok: true, freshConv, perms: freshPerms };
      };

      membersCtrl ??= createChannelMembersDialogController(args.dialog);
      args.onOpenedSnapshot({
        conversationId: convId,
        kind: initialKind,
        route: initialRoute,
        channelId,
        archivedAt: conv.archivedAt,
        joined: conv.joined,
        canAdd: permissions.canAdd,
        canRemove: permissions.canRemove,
        promotedPrivateManager: promotedManager,
      });
      membersCtrl.open({
        title: sheetTitle,
        viewerUserId: args.pinnedUserId,
        permissions,
        members: initialMembers,
        candidates,
        newCommandId: args.uuid,
        onAdd: permissions.canAdd
          ? async (added, commandId) => {
            const gate = await revalidateForMutation("add");
            if (!gate.ok) return { ok: false, code: "forbidden", message: gate.message };
            const session = args.getSession();
            if (!session || !lifetime.isAlive()) {
              return { ok: false, code: "other", message: "Action cancelled." };
            }
            if (gate.perms.route === "private_channel" && gate.freshConv.channelId) {
              return await addChannelMembers(session, commandId, args.workspaceId, gate.freshConv.channelId, added, {
                isAlive: lifetime.isAlive,
                signal: lifetime.signal,
                pinned: args.pinned,
              });
            }
            return await inviteToConversation(session, commandId, args.workspaceId, convId, added, {
              isAlive: lifetime.isAlive,
              signal: lifetime.signal,
              pinned: args.pinned,
            });
          }
          : undefined,
        onRemove: permissions.canRemove
          ? async (removed, commandId) => {
            const gate = await revalidateForMutation("remove");
            if (!gate.ok) return { ok: false, code: "forbidden", message: gate.message };
            const session = args.getSession();
            if (!session || !lifetime.isAlive()) {
              return { ok: false, code: "other", message: "Action cancelled." };
            }
            if (gate.perms.route === "private_channel" && gate.freshConv.channelId) {
              return await removeChannelMember(session, commandId, args.workspaceId, gate.freshConv.channelId, removed, {
                isAlive: lifetime.isAlive,
                signal: lifetime.signal,
                pinned: args.pinned,
              });
            }
            return await removeFromConversation(session, commandId, args.workspaceId, convId, removed, {
              isAlive: lifetime.isAlive,
              signal: lifetime.signal,
              pinned: args.pinned,
            });
          }
          : undefined,
        onChanged: (nextMembers) => {
          if (!lifetime.isAlive()) return;
          args.onChanged(nextMembers);
        },
        onRetire: () => {
          lifetime.retire();
          if (membersLifetime === lifetime) membersLifetime = null;
          args.onClosed();
        },
        restoreFocus: args.restoreFocus,
      });
    },
    closeMembers(restoreFocus = false) {
      membersLifetime?.retire();
      membersLifetime = null;
      membersCtrl?.close(restoreFocus);
    },
    closeAll() {
      pickerLifetime?.retire();
      pickerLifetime = null;
      membersLifetime?.retire();
      membersLifetime = null;
      pickerCtrl?.close(false);
      membersCtrl?.close(false);
    },
  };
}
