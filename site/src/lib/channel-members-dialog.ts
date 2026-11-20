/**
 * Channel & conversation Members and Invite sheet (Step 3C).
 * Lazy-loaded on demand from LiveDashboard so /app initial JS stays lean.
 * Public channels use conversation_invite / conversation_remove; private channels use
 * channel_member_add / channel_member_remove; fixed-member DMs, group DMs, #general,
 * unjoined public channels, and archived channels render read-only with no Add/Remove.
 */
import {
  canInviteToConversation,
  CONVERSATION_INVITE_MAX,
  disambiguateMemberLabels,
  type ConversationActionResult,
  type ConversationMemberRef,
  type ConversationSummary,
} from "./conversations.js";
import type { WorkspaceRole } from "./channels.js";
import { memberRefKey, type ConversationCandidate } from "./conversation-picker.js";

export interface ConversationMemberEntry {
  kind: "user" | "agent";
  id: string;
  name: string;
  self?: boolean;
}

export interface ChannelMembersPermissions {
  canAdd: boolean;
  canRemove: boolean;
  route: "conversation" | "private_channel" | "readonly";
}

/**
 * Mirrors server `canManageChannel` (`supabase/functions/command/index.ts:11067-11112`):
 * admits workspace owners/admins, human creators, owners of the creator agent, and promoted
 * private-channel managers (`channel_members.is_manager = true`).
 */
export function viewerCanManageConversationChannel(args: {
  channel: { createdByKind: "user" | "agent"; createdByPrincipal: string } | null;
  conv: Pick<ConversationSummary, "kind" | "members">;
  viewerUserId: string | null;
  viewerRole: WorkspaceRole | null;
  ownedAgentIds?: ReadonlySet<string>;
  isPromotedPrivateManager?: boolean;
}): boolean {
  const { channel, conv, viewerUserId, viewerRole, ownedAgentIds, isPromotedPrivateManager } = args;
  if (!viewerUserId) return false;
  if (viewerRole === "owner" || viewerRole === "admin") return true;
  const viewerId = viewerUserId.toLowerCase();
  if (channel) {
    const creatorId = channel.createdByPrincipal.toLowerCase();
    if (channel.createdByKind === "user" && creatorId === viewerId) return true;
    if (channel.createdByKind === "agent" && ownedAgentIds?.has(creatorId)) return true;
  }
  if (conv.kind === "private_channel") {
    if (isPromotedPrivateManager === true) return true;
    if (conv.members.some((m) => !m.leftAt && m.kind === "user" && m.id.toLowerCase() === viewerId && m.isManager === true)) {
      return true;
    }
  }
  return false;
}

/**
 * Exact UI authorization matching Step 2a `conversations.ts` and `command/index.ts`:
 * - Live joined public channel: any joined member may invite; creator/owner/admin may remove.
 * - Live joined private channel: creator/owner/admin may add and remove via channel_member_*.
 * - Fixed-member DMs, group DMs, #general, unjoined public channels, and archived channels: read-only.
 */
export function channelMembersPermissions(
  conv: Pick<ConversationSummary, "kind" | "archivedAt" | "joined">,
  viewerCanManage: boolean,
): ChannelMembersPermissions {
  if (conv.archivedAt !== null || !conv.joined || !canInviteToConversation(conv.kind, conv.archivedAt !== null)) {
    return { canAdd: false, canRemove: false, route: "readonly" };
  }
  if (conv.kind === "public_channel") {
    return { canAdd: true, canRemove: viewerCanManage, route: "conversation" };
  }
  if (conv.kind === "private_channel") {
    return { canAdd: viewerCanManage, canRemove: viewerCanManage, route: "private_channel" };
  }
  return { canAdd: false, canRemove: false, route: "readonly" };
}

export function filterAddableMembers(
  candidates: readonly ConversationCandidate[],
  currentMembers: readonly Pick<ConversationMemberRef, "kind" | "id">[],
  query: string,
): ConversationCandidate[] {
  const existing = new Set(currentMembers.map(memberRefKey));
  const needle = query.trim().toLowerCase();
  return candidates.filter((candidate) => {
    if (existing.has(memberRefKey(candidate))) return false;
    return !needle || candidate.name.toLowerCase().includes(needle);
  });
}

export function canSelectInviteCandidate(
  selected: readonly Pick<ConversationMemberRef, "kind" | "id">[],
  candidate: Pick<ConversationMemberRef, "kind" | "id">,
): boolean {
  const key = memberRefKey(candidate);
  if (selected.some((item) => memberRefKey(item) === key)) return true;
  return selected.length < CONVERSATION_INVITE_MAX;
}

export interface ChannelMembersDialogOptions {
  title: string;
  viewerUserId: string;
  permissions: ChannelMembersPermissions;
  members: readonly ConversationMemberEntry[];
  candidates: readonly ConversationCandidate[];
  newCommandId?: () => string;
  onAdd?: (members: ConversationMemberRef[], commandId: string) => Promise<ConversationActionResult>;
  onRemove?: (member: ConversationMemberRef, commandId: string) => Promise<ConversationActionResult>;
  onChanged?: (nextMembers: ConversationMemberEntry[]) => void;
  onRetire?: () => void;
  restoreFocus?: () => void;
}

export interface ChannelMembersDialogController {
  open: (options: ChannelMembersDialogOptions) => void;
  close: (restoreFocus?: boolean) => void;
}

export function createChannelMembersDialogController(dialog: HTMLDialogElement): ChannelMembersDialogController {
  const doc = dialog.ownerDocument;
  let activeOptions: ChannelMembersDialogOptions | null = null;
  let members: ConversationMemberEntry[] = [];
  let addOpen = false;
  let addQuery = "";
  let addSelected: ConversationCandidate[] = [];
  let confirmingRemoveKey: string | null = null;
  let busy = false;
  let errorText = "";
  let generation = 0;
  let suppressRestoreOnClose = false;
  let pendingAddKey = "";
  let pendingAddCommandId = "";
  let pendingRemoveKey = "";
  let pendingRemoveCommandId = "";
  let displayLabels = new Map<string, string>();
  const clearPendingAdd = (): void => { pendingAddKey = ""; pendingAddCommandId = ""; };
  const clearPendingRemove = (): void => { pendingRemoveKey = ""; pendingRemoveCommandId = ""; };
  const refreshDisplayLabels = (): void => {
    const byKey = new Map<string, { kind: "user" | "agent"; id: string; name: string }>();
    for (const c of activeOptions?.candidates ?? []) byKey.set(memberRefKey(c), c);
    for (const m of members) if (!byKey.has(memberRefKey(m))) byKey.set(memberRefKey(m), m);
    displayLabels = disambiguateMemberLabels([...byKey.values()]);
  };
  const labelFor = (entry: { kind: "user" | "agent"; id: string; name: string }): string =>
    displayLabels.get(memberRefKey(entry)) ?? entry.name;

  const head = doc.createElement("header");
  head.className = "cm-dialog-head";
  const title = doc.createElement("h2");
  title.id = "dashboard-conversation-members-title";
  title.dataset.conversationMembersTitle = "";
  title.textContent = "Members";
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "cm-close";
  closeButton.dataset.conversationMembersClose = "";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  head.append(title, closeButton);

  const error = doc.createElement("p");
  error.className = "dashboard__form-error cm-picker-error";
  error.setAttribute("role", "alert");
  error.dataset.conversationMembersError = "";
  error.hidden = true;

  const addToggleWrap = doc.createElement("div");
  addToggleWrap.className = "cm-members-toolbar";
  const addToggle = doc.createElement("button");
  addToggle.type = "button";
  addToggle.className = "dashboard__button dashboard__button--secondary cm-members-add-toggle";
  addToggle.dataset.conversationMembersAddToggle = "";
  addToggle.textContent = "Add people or agents";
  addToggleWrap.append(addToggle);

  const addPanel = doc.createElement("section");
  addPanel.className = "cm-members-add-panel";
  addPanel.dataset.conversationMembersAddPanel = "";
  addPanel.hidden = true;

  const searchLabel = doc.createElement("label");
  searchLabel.className = "hm-sr";
  searchLabel.htmlFor = "dashboard-conversation-members-search";
  searchLabel.textContent = "Search people and agents to add";

  const addSearch = doc.createElement("input");
  addSearch.id = "dashboard-conversation-members-search";
  addSearch.className = "cm-search";
  addSearch.type = "search";
  addSearch.placeholder = "Search people and agents";
  addSearch.autocomplete = "off";
  addSearch.dataset.conversationMembersSearch = "";

  const addList = doc.createElement("ul");
  addList.className = "cm-picker-list cm-members-add-list";
  addList.dataset.conversationMembersAddList = "";

  const addFooter = doc.createElement("div");
  addFooter.className = "cm-picker-footer";
  const addCancel = doc.createElement("button");
  addCancel.type = "button";
  addCancel.className = "dashboard__button dashboard__button--secondary";
  addCancel.dataset.conversationMembersAddCancel = "";
  addCancel.textContent = "Cancel";
  const addSubmit = doc.createElement("button");
  addSubmit.type = "button";
  addSubmit.className = "dashboard__button dashboard__button--primary";
  addSubmit.dataset.conversationMembersAddSubmit = "";
  addSubmit.textContent = "Add";
  addFooter.append(addCancel, addSubmit);
  addPanel.append(searchLabel, addSearch, addList, addFooter);

  const listWrap = doc.createElement("div");
  listWrap.className = "cm-directory-results";
  const memberList = doc.createElement("ul");
  memberList.className = "cm-members-list";
  memberList.dataset.conversationMembersList = "";
  listWrap.append(memberList);

  dialog.replaceChildren(head, error, addToggleWrap, addPanel, listWrap);

  const renderAddPanel = (): void => {
    if (!activeOptions) return;
    const canAdd = activeOptions.permissions.canAdd && typeof activeOptions.onAdd === "function";
    addToggleWrap.hidden = !canAdd || addOpen;
    addToggle.disabled = busy;
    addPanel.hidden = !canAdd || !addOpen;
    if (!canAdd || !addOpen) return;

    addSearch.disabled = busy;
    addCancel.disabled = busy;
    addSubmit.disabled = busy || addSelected.length === 0;
    addSubmit.setAttribute("aria-busy", String(busy));
    addSubmit.textContent = busy
      ? "Adding…"
      : addSelected.length > 0
        ? `Add (${addSelected.length})`
        : "Add";

    addList.replaceChildren();
    const filtered = filterAddableMembers(activeOptions.candidates, members, addQuery);
    if (filtered.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "cm-picker-empty";
      empty.textContent = addQuery.trim()
        ? "No matching people or agents to add."
        : "Everyone in this workspace is already a member.";
      addList.append(empty);
      return;
    }
    const selectedKeys = new Set(addSelected.map(memberRefKey));
    for (const candidate of filtered) {
      const key = memberRefKey(candidate);
      const isSelected = selectedKeys.has(key);
      const allowed = canSelectInviteCandidate(addSelected, candidate);
      const li = doc.createElement("li");
      li.className = "cm-picker-item";
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "cm-picker-row";
      button.dataset.conversationMembersCandidate = key;
      button.setAttribute("aria-pressed", String(isSelected));
      button.disabled = busy || (!isSelected && !allowed);

      const name = doc.createElement("span");
      name.className = "cm-picker-row__name";
      const displayName = labelFor(candidate);
      name.textContent = candidate.self ? `${displayName} (you)` : displayName;
      button.append(name);

      if (candidate.kind === "agent") {
        const badge = doc.createElement("span");
        badge.className = "cm-picker-badge";
        badge.textContent = "Agent";
        button.append(badge);
      }

      const mark = doc.createElement("span");
      mark.className = "cm-picker-check";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = isSelected ? "✓" : "";
      button.append(mark);

      button.addEventListener("click", () => {
        if (busy) return;
        if (selectedKeys.has(key)) {
          addSelected = addSelected.filter((entry) => memberRefKey(entry) !== key);
        } else if (canSelectInviteCandidate(addSelected, candidate)) {
          addSelected = [...addSelected, candidate];
        } else {
          return;
        }
        errorText = "";
        clearPendingAdd();
        render();
        const same = addList.querySelector<HTMLButtonElement>(`[data-conversation-members-candidate="${key}"]`);
        same?.focus({ preventScroll: true });
      });

      li.append(button);
      addList.append(li);
    }
  };

  const renderMemberList = (): void => {
    memberList.replaceChildren();
    if (!activeOptions) return;
    const viewerId = activeOptions.viewerUserId.toLowerCase();
    const canRemove = activeOptions.permissions.canRemove && typeof activeOptions.onRemove === "function";

    if (members.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "cm-picker-empty";
      empty.textContent = "No members yet.";
      memberList.append(empty);
      return;
    }

    for (const member of members) {
      const key = memberRefKey(member);
      const isSelf = member.self === true || (member.kind === "user" && member.id.toLowerCase() === viewerId);
      const li = doc.createElement("li");
      li.className = "cm-member-row";
      li.dataset.conversationMemberRow = key;

      const copy = doc.createElement("div");
      copy.className = "cm-member-row__copy";
      const displayName = labelFor(member);
      const name = doc.createElement("span");
      name.className = "cm-member-row__name";
      name.textContent = isSelf ? `${displayName} (you)` : displayName;
      copy.append(name);
      if (member.kind === "agent") {
        const badge = doc.createElement("span");
        badge.className = "cm-picker-badge";
        badge.textContent = "Agent";
        copy.append(badge);
      }
      li.append(copy);

      if (canRemove && !isSelf) {
        if (confirmingRemoveKey === key) {
          const confirm = doc.createElement("div");
          confirm.className = "cm-member-row__confirm";
          confirm.dataset.conversationMemberConfirm = key;

          const prompt = doc.createElement("span");
          prompt.className = "cm-member-row__confirm-text";
          prompt.textContent = `Remove ${displayName}?`;

          const cancelBtn = doc.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "dashboard__button dashboard__button--secondary cm-member-row__remove-cancel";
          cancelBtn.dataset.conversationMemberRemoveCancel = key;
          cancelBtn.disabled = busy;
          cancelBtn.textContent = "Cancel";
          cancelBtn.addEventListener("click", () => {
            if (busy) return;
            confirmingRemoveKey = null;
            clearPendingRemove();
            errorText = "";
            render();
            const removeTrigger = memberList.querySelector<HTMLButtonElement>(
              `[data-conversation-member-remove="${key}"]`,
            );
            removeTrigger?.focus({ preventScroll: true });
          });

          const confirmBtn = doc.createElement("button");
          confirmBtn.type = "button";
          confirmBtn.className = "dashboard__button dashboard__button--danger";
          confirmBtn.dataset.conversationMemberRemoveConfirm = key;
          confirmBtn.disabled = busy;
          confirmBtn.setAttribute("aria-busy", String(busy));
          confirmBtn.textContent = busy ? "Removing…" : "Remove";
          confirmBtn.addEventListener("click", () => {
            void submitRemove(member);
          });

          // Place Cancel under the original right-aligned Remove target so a repeated tap cancels
          // instead of hitting the destructive confirmation; Cancel still receives initial focus.
          confirm.append(prompt, confirmBtn, cancelBtn);
          li.append(confirm);
        } else {
          const removeBtn = doc.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "dashboard__button dashboard__button--secondary cm-member-row__remove";
          removeBtn.dataset.conversationMemberRemove = key;
          removeBtn.setAttribute("aria-label", `Remove ${displayName}`);
          removeBtn.disabled = busy;
          removeBtn.textContent = "Remove";
          removeBtn.addEventListener("click", () => {
            if (busy) return;
            if (confirmingRemoveKey !== key) clearPendingRemove();
            confirmingRemoveKey = key;
            errorText = "";
            render();
            const cancelBtn = memberList.querySelector<HTMLButtonElement>(
              `[data-conversation-member-remove-cancel="${key}"]`,
            );
            cancelBtn?.focus({ preventScroll: true });
          });
          li.append(removeBtn);
        }
      }

      memberList.append(li);
    }
  };

  const render = (): void => {
    closeButton.disabled = busy;
    error.textContent = errorText;
    error.hidden = errorText.length === 0;
    renderAddPanel();
    renderMemberList();
  };

  const submitAdd = async (): Promise<void> => {
    if (busy || !activeOptions?.onAdd || addSelected.length === 0) return;
    const opts = activeOptions;
    const runGen = generation;
    const picked = [...addSelected];
    const refs: ConversationMemberRef[] = picked.map((item) => ({ kind: item.kind, id: item.id.toLowerCase() }));
    const addKey = refs.map(memberRefKey).sort().join(",");
    if (pendingAddKey !== addKey || !pendingAddCommandId) {
      pendingAddKey = addKey;
      pendingAddCommandId = opts.newCommandId ? opts.newCommandId() : `${Date.now()}-add-${runGen}`;
    }
    const commandId = pendingAddCommandId;
    busy = true;
    errorText = "";
    render();
    let result: ConversationActionResult;
    try {
      result = await opts.onAdd!(refs, commandId);
    } catch (err) {
      result = {
        ok: false,
        code: "other",
        message: err instanceof Error && err.message ? err.message : "Could not add those members.",
      };
    }
    if (runGen !== generation) return;
    busy = false;
    if (result.ok) {
      clearPendingAdd();
      const existing = new Set(members.map(memberRefKey));
      for (const item of picked) {
        const key = memberRefKey(item);
        if (existing.has(key)) continue;
        existing.add(key);
        members = [...members, { kind: item.kind, id: item.id.toLowerCase(), name: item.name, self: item.self }];
      }
      refreshDisplayLabels();
      addSelected = [];
      addQuery = "";
      addSearch.value = "";
      addOpen = false;
      render();
      opts.onChanged?.([...members]);
      if (addToggle.isConnected && !addToggleWrap.hidden) addToggle.focus({ preventScroll: true });
      else if (closeButton.isConnected) closeButton.focus({ preventScroll: true });
      return;
    }
    errorText = result.message;
    render();
    if (addSubmit.isConnected && !addPanel.hidden) addSubmit.focus({ preventScroll: true });
  };

  const submitRemove = async (member: ConversationMemberEntry): Promise<void> => {
    if (busy || !activeOptions?.onRemove) return;
    const opts = activeOptions;
    const runGen = generation;
    const key = memberRefKey(member);
    const removedIndex = members.findIndex((entry) => memberRefKey(entry) === key);
    if (pendingRemoveKey !== key || !pendingRemoveCommandId) {
      pendingRemoveKey = key;
      pendingRemoveCommandId = opts.newCommandId ? opts.newCommandId() : `${Date.now()}-rm-${runGen}`;
    }
    const commandId = pendingRemoveCommandId;
    busy = true;
    errorText = "";
    render();
    let result: ConversationActionResult;
    try {
      result = await opts.onRemove!({ kind: member.kind, id: member.id.toLowerCase() }, commandId);
    } catch (err) {
      result = {
        ok: false,
        code: "other",
        message: err instanceof Error && err.message ? err.message : "Could not remove that member.",
      };
    }
    if (runGen !== generation) return;
    busy = false;
    if (result.ok) {
      clearPendingRemove();
      members = members.filter((entry) => memberRefKey(entry) !== key);
      confirmingRemoveKey = null;
      refreshDisplayLabels();
      render();
      opts.onChanged?.([...members]);
      const remaining = memberList.querySelectorAll<HTMLButtonElement>("[data-conversation-member-remove]");
      const target = remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)] ?? closeButton;
      if (target?.isConnected) target.focus({ preventScroll: true });
      return;
    }
    errorText = result.message;
    render();
    const cancelBtn = memberList.querySelector<HTMLButtonElement>(
      `[data-conversation-member-remove-cancel="${key}"]`,
    );
    if (cancelBtn?.isConnected) cancelBtn.focus({ preventScroll: true });
  };

  addToggle.addEventListener("click", () => {
    if (busy) return;
    addOpen = true;
    confirmingRemoveKey = null;
    clearPendingRemove();
    errorText = "";
    render();
    addSearch.focus({ preventScroll: true });
  });

  addSearch.addEventListener("input", () => {
    addQuery = addSearch.value;
    renderAddPanel();
  });

  addCancel.addEventListener("click", () => {
    if (busy) return;
    addOpen = false;
    addSelected = [];
    addQuery = "";
    addSearch.value = "";
    clearPendingAdd();
    errorText = "";
    render();
    if (addToggle.isConnected && !addToggleWrap.hidden) addToggle.focus({ preventScroll: true });
  });

  addSubmit.addEventListener("click", () => {
    void submitAdd();
  });

  const close = (restoreFocus = true): void => {
    generation += 1;
    busy = false;
    clearPendingAdd();
    clearPendingRemove();
    suppressRestoreOnClose = !restoreFocus;
    if (dialog.open) {
      dialog.close();
    } else {
      activeOptions?.onRetire?.();
    }
  };

  closeButton.addEventListener("click", () => close(true));

  dialog.addEventListener("cancel", (event) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    generation += 1;
    suppressRestoreOnClose = false;
  });

  dialog.addEventListener("close", () => {
    const restore = activeOptions?.restoreFocus;
    const retire = activeOptions?.onRetire;
    const shouldRestore = !suppressRestoreOnClose;
    suppressRestoreOnClose = false;
    generation += 1;
    busy = false;
    clearPendingAdd();
    clearPendingRemove();
    retire?.();
    if (shouldRestore) restore?.();
  });

  const open = (options: ChannelMembersDialogOptions): void => {
    activeOptions?.onRetire?.();
    generation += 1;
    activeOptions = options;
    members = [...options.members];
    addOpen = false;
    addQuery = "";
    addSelected = [];
    confirmingRemoveKey = null;
    busy = false;
    errorText = "";
    suppressRestoreOnClose = false;
    clearPendingAdd();
    clearPendingRemove();
    refreshDisplayLabels();
    addSearch.value = "";
    title.textContent = options.title;
    render();
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (options.permissions.canAdd && !addToggleWrap.hidden) addToggle.focus({ preventScroll: true });
    else closeButton.focus({ preventScroll: true });
  };

  return { open, close };
}
