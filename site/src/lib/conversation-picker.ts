/**
 * New message / DM / Group DM picker dialog (Step 3C).
 * Lazy-loaded on demand from LiveDashboard so /app initial JS stays lean.
 * Enforces Step 2a `conversation_open` member limits (up to 9 including caller)
 * and exact #511 409 handling (`conversation_left` vs `conversation_member_left`).
 */
import {
  CONVERSATION_MEMBER_MAX,
  disambiguateMemberLabels,
  type ConversationMemberRef,
  type ConversationOpenResult,
  type OpenedConversation,
} from "./conversations.js";

export interface ConversationCandidate {
  kind: "user" | "agent";
  id: string;
  name: string;
  self?: boolean;
}

export interface ConversationPickerOptions {
  viewerUserId: string;
  candidates: readonly ConversationCandidate[];
  newCommandId?: () => string;
  onOpen: (members: ConversationMemberRef[], newGroup: boolean, commandId: string) => Promise<ConversationOpenResult>;
  onOpened: (conversation: OpenedConversation) => void;
  onRetire?: () => void;
  restoreFocus?: () => void;
}

export function memberRefKey(ref: Pick<ConversationMemberRef, "kind" | "id">): string {
  return `${ref.kind}:${ref.id.toLowerCase()}`;
}

export function filterConversationCandidates(
  candidates: readonly ConversationCandidate[],
  query: string,
): ConversationCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter((candidate) => candidate.name.toLowerCase().includes(needle));
}

/**
 * Whether `candidate` may be toggled in `selected` without exceeding CONVERSATION_MEMBER_MAX (9)
 * members including the caller. Deselecting an already-selected candidate is always allowed.
 */
export function canSelectConversationCandidate(
  selected: readonly ConversationCandidate[],
  candidate: Pick<ConversationMemberRef, "kind" | "id">,
  viewerUserId: string,
): boolean {
  const targetKey = memberRefKey(candidate);
  if (selected.some((item) => memberRefKey(item) === targetKey)) return true;
  const distinct = new Set<string>();
  const viewer = viewerUserId.trim().toLowerCase();
  if (viewer) distinct.add(`user:${viewer}`);
  for (const item of selected) distinct.add(memberRefKey(item));
  distinct.add(targetKey);
  return distinct.size <= CONVERSATION_MEMBER_MAX;
}

/** Deduplicated `conversation_open` members payload. */
export function buildOpenMembersPayload(
  selected: readonly Pick<ConversationMemberRef, "kind" | "id">[],
): ConversationMemberRef[] {
  const seen = new Set<string>();
  const out: ConversationMemberRef[] = [];
  for (const item of selected) {
    const id = item.id.toLowerCase();
    const key = `${item.kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: item.kind, id });
  }
  return out;
}

export interface ConversationPickerController {
  open: (options: ConversationPickerOptions) => void;
  close: (restoreFocus?: boolean) => void;
}

export function createConversationPickerController(dialog: HTMLDialogElement): ConversationPickerController {
  const doc = dialog.ownerDocument;
  let activeOptions: ConversationPickerOptions | null = null;
  let selected: ConversationCandidate[] = [];
  let query = "";
  let busy = false;
  let errorText = "";
  let canStartNewGroup = false;
  let generation = 0;
  let suppressRestoreOnClose = false;
  let keepAliveOnClose = false;
  let pendingCommandKey = "";
  let pendingCommandId = "";
  let displayLabels = new Map<string, string>();
  const clearPendingCommand = (): void => {
    pendingCommandKey = "";
    pendingCommandId = "";
  };
  const labelFor = (item: Pick<ConversationCandidate, "kind" | "id" | "name" | "self">): string => {
    const base = displayLabels.get(memberRefKey(item)) ?? item.name;
    return item.self ? `${base} (you)` : base;
  };

  const head = doc.createElement("header");
  head.className = "cm-dialog-head";
  const title = doc.createElement("h2");
  title.id = "dashboard-conversation-picker-title";
  title.textContent = "New message";
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "cm-close";
  closeButton.dataset.conversationPickerClose = "";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  head.append(title, closeButton);

  const searchLabel = doc.createElement("label");
  searchLabel.className = "hm-sr";
  searchLabel.htmlFor = "dashboard-conversation-picker-search";
  searchLabel.textContent = "Search people and agents";

  const search = doc.createElement("input");
  search.id = "dashboard-conversation-picker-search";
  search.className = "cm-search";
  search.type = "search";
  search.placeholder = "Search people and agents";
  search.autocomplete = "off";
  search.dataset.conversationPickerSearch = "";

  const chips = doc.createElement("div");
  chips.className = "cm-picker-chips";
  chips.dataset.conversationPickerChips = "";
  chips.hidden = true;

  const listWrap = doc.createElement("div");
  listWrap.className = "cm-directory-results";
  const list = doc.createElement("ul");
  list.className = "cm-picker-list";
  list.dataset.conversationPickerList = "";
  listWrap.append(list);

  const error = doc.createElement("p");
  error.className = "dashboard__form-error cm-picker-error";
  error.setAttribute("role", "alert");
  error.dataset.conversationPickerError = "";
  error.hidden = true;

  const footer = doc.createElement("footer");
  footer.className = "cm-picker-footer";
  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "dashboard__button dashboard__button--secondary";
  cancelButton.dataset.conversationPickerCancel = "";
  cancelButton.textContent = "Cancel";

  const submitButton = doc.createElement("button");
  submitButton.type = "button";
  submitButton.className = "dashboard__button dashboard__button--primary";
  submitButton.dataset.conversationPickerSubmit = "";
  submitButton.textContent = "Open";

  const restartButton = doc.createElement("button");
  restartButton.type = "button";
  restartButton.className = "dashboard__button dashboard__button--primary";
  restartButton.dataset.conversationPickerRestart = "";
  restartButton.textContent = "Start new group";
  restartButton.hidden = true;

  footer.append(cancelButton, submitButton, restartButton);

  dialog.replaceChildren(head, searchLabel, search, chips, listWrap, error, footer);

  const renderChips = (): void => {
    chips.replaceChildren();
    chips.hidden = selected.length === 0;
    for (const item of selected) {
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "cm-picker-chip";
      chip.dataset.conversationPickerChip = memberRefKey(item);
      chip.disabled = busy;
      chip.setAttribute("aria-label", `Remove ${labelFor(item)}`);
      const label = doc.createElement("span");
      label.textContent = labelFor(item);
      const cross = doc.createElement("span");
      cross.className = "cm-picker-chip__x";
      cross.setAttribute("aria-hidden", "true");
      cross.textContent = "×";
      chip.append(label, cross);
      chip.addEventListener("click", () => {
        if (busy) return;
        const key = memberRefKey(item);
        const index = selected.findIndex((entry) => memberRefKey(entry) === key);
        if (index < 0) return;
        selected = selected.filter((entry) => memberRefKey(entry) !== key);
        errorText = "";
        canStartNewGroup = false;
        clearPendingCommand();
        render();
        const remaining = chips.querySelectorAll<HTMLButtonElement>("[data-conversation-picker-chip]");
        const nextFocus = remaining[Math.min(index, remaining.length - 1)] ?? search;
        nextFocus.focus({ preventScroll: true });
      });
      chips.append(chip);
    }
  };

  const renderList = (): void => {
    list.replaceChildren();
    if (!activeOptions) return;
    const filtered = filterConversationCandidates(activeOptions.candidates, query);
    if (filtered.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "cm-picker-empty";
      empty.textContent = query.trim() ? "No matching people or agents." : "No people or agents in this workspace.";
      list.append(empty);
      return;
    }
    const selectedKeys = new Set(selected.map(memberRefKey));
    for (const candidate of filtered) {
      const key = memberRefKey(candidate);
      const isSelected = selectedKeys.has(key);
      const allowed = canSelectConversationCandidate(selected, candidate, activeOptions.viewerUserId);
      const li = doc.createElement("li");
      li.className = "cm-picker-item";
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "cm-picker-row";
      button.dataset.conversationPickerOption = key;
      button.setAttribute("aria-pressed", String(isSelected));
      button.disabled = busy || (!isSelected && !allowed);

      const copy = doc.createElement("span");
      copy.className = "cm-picker-row__name";
      copy.textContent = labelFor(candidate);
      button.append(copy);

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
        if (busy || !activeOptions) return;
        if (selectedKeys.has(key)) {
          selected = selected.filter((entry) => memberRefKey(entry) !== key);
        } else if (canSelectConversationCandidate(selected, candidate, activeOptions.viewerUserId)) {
          selected = [...selected, candidate];
        } else {
          return;
        }
        errorText = "";
        canStartNewGroup = false;
        clearPendingCommand();
        render();
        const same = list.querySelector<HTMLButtonElement>(`[data-conversation-picker-option="${key}"]`);
        same?.focus({ preventScroll: true });
      });

      li.append(button);
      list.append(li);
    }
  };

  const renderControls = (): void => {
    search.disabled = busy;
    closeButton.disabled = busy;
    cancelButton.disabled = busy;
    error.textContent = errorText;
    error.hidden = errorText.length === 0;

    if (canStartNewGroup) {
      submitButton.hidden = true;
      restartButton.hidden = false;
      restartButton.disabled = busy || selected.length === 0;
      restartButton.setAttribute("aria-busy", String(busy));
      restartButton.textContent = busy ? "Starting…" : "Start new group";
    } else {
      restartButton.hidden = true;
      submitButton.hidden = false;
      submitButton.disabled = busy || selected.length === 0;
      submitButton.setAttribute("aria-busy", String(busy));
      submitButton.textContent = busy ? "Opening…" : "Open";
    }
  };

  const render = (): void => {
    renderChips();
    renderList();
    renderControls();
  };

  const submit = async (newGroup: boolean): Promise<void> => {
    if (busy || !activeOptions || selected.length === 0) return;
    const opts = activeOptions;
    const runGen = generation;
    const members = buildOpenMembersPayload(selected);
    if (members.length === 0) return;
    const cmdKey = `${newGroup ? "new" : "open"}:${members.map(memberRefKey).sort().join(",")}`;
    if (pendingCommandKey !== cmdKey || !pendingCommandId) {
      pendingCommandKey = cmdKey;
      pendingCommandId = opts.newCommandId ? opts.newCommandId() : `${Date.now()}-${runGen}`;
    }
    const commandId = pendingCommandId;
    busy = true;
    errorText = "";
    render();
    let result: ConversationOpenResult;
    try {
      result = await opts.onOpen(members, newGroup, commandId);
    } catch (err) {
      result = {
        ok: false,
        code: "other",
        message: err instanceof Error && err.message ? err.message : "Could not open conversation.",
        canStartNewGroup: false,
      };
    }
    if (runGen !== generation) return;
    busy = false;
    if (result.ok) {
      clearPendingCommand();
      suppressRestoreOnClose = true;
      keepAliveOnClose = true;
      if (dialog.open) dialog.close();
      opts.onOpened(result.conversation);
      return;
    }
    // Definite server refusals (409/403/400) retire the command id; only transient/unknown retries reuse it.
    if (result.code !== "other") clearPendingCommand();
    errorText = result.message;
    canStartNewGroup = result.canStartNewGroup === true;
    render();
    if (canStartNewGroup && restartButton.isConnected && !restartButton.hidden) {
      restartButton.focus({ preventScroll: true });
    } else if (submitButton.isConnected && !submitButton.hidden) {
      submitButton.focus({ preventScroll: true });
    }
  };

  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });

  submitButton.addEventListener("click", () => {
    void submit(false);
  });

  restartButton.addEventListener("click", () => {
    void submit(true);
  });

  const close = (restoreFocus = true): void => {
    generation += 1;
    busy = false;
    clearPendingCommand();
    suppressRestoreOnClose = !restoreFocus;
    keepAliveOnClose = false;
    if (dialog.open) {
      dialog.close();
    } else {
      activeOptions?.onRetire?.();
    }
  };

  closeButton.addEventListener("click", () => close(true));
  cancelButton.addEventListener("click", () => close(true));

  dialog.addEventListener("cancel", (event) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    generation += 1;
    suppressRestoreOnClose = false;
    keepAliveOnClose = false;
  });

  dialog.addEventListener("close", () => {
    const restore = activeOptions?.restoreFocus;
    const retire = activeOptions?.onRetire;
    const shouldRestore = !suppressRestoreOnClose;
    const shouldRetire = !keepAliveOnClose;
    suppressRestoreOnClose = false;
    keepAliveOnClose = false;
    generation += 1;
    busy = false;
    clearPendingCommand();
    if (shouldRetire) retire?.();
    if (shouldRestore) restore?.();
  });

  const open = (options: ConversationPickerOptions): void => {
    activeOptions?.onRetire?.();
    generation += 1;
    activeOptions = options;
    displayLabels = disambiguateMemberLabels(options.candidates);
    selected = [];
    query = "";
    busy = false;
    errorText = "";
    canStartNewGroup = false;
    suppressRestoreOnClose = false;
    clearPendingCommand();
    search.value = "";
    render();
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    search.focus({ preventScroll: true });
  };

  return { open, close };
}
