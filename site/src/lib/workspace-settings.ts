import {
  CHANNEL_CREATION_LABELS,
  CHANNEL_CREATION_POLICIES,
  CHANNEL_CREATION_SAVED,
  CHANNEL_CREATION_TITLE,
  type ChannelCreationPolicy,
} from "./channels";

export interface WorkspaceSettingsOptions {
  name: string;
  workspaceId: string;
  memberCount: number;
  agentCount: number;
  canClose: boolean;
  /** Owners and admins may rename; the server decides. */
  canRename?: boolean;
  onRename?(name: string): Promise<void>;
  /**
   * Owners and admins: who may create channels. Absent for everyone else. `value` is `null` under a
   * policy this build does not know, and then neither choice is marked. `onChange` resolves with the
   * policy the server now holds.
   */
  channelPolicy?: {
    value: ChannelCreationPolicy | null;
    onChange(policy: ChannelCreationPolicy): Promise<ChannelCreationPolicy | null>;
  };
  /** Owners and admins: open the Clean up dialog. Absent for everyone else. */
  onCleanup?(): void;
  /** Starting state of More. Omitted on a redraw of the same workspace, it keeps More as the person left it. */
  moreOpen?: boolean;
  moveDestinations?: readonly { id: string; name: string }[];
  onMove?(orgId: string): Promise<void>;
  onCopy(): Promise<void>;
  onClose(): Promise<void>;
}

export interface WorkspaceSettingsControls {
  confirmInput: HTMLInputElement;
  closeButton: HTMLButtonElement;
}

interface PreviousRender {
  workspaceId: string;
  name: string;
  canClose: boolean;
  canRename: boolean;
}

interface TextDraft {
  value: string;
  focused: boolean;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none" | null;
}

const previousRender = new WeakMap<HTMLElement, PreviousRender>();

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function findByDataset<T extends HTMLElement>(root: HTMLElement, attr: string, key: string): T | null {
  if (typeof root.querySelector === "function") {
    return root.querySelector<T>(`[data-${attr}]`);
  }
  type NodeLike = { children?: ArrayLike<NodeLike>; dataset?: Record<string, string> };
  const visit = (node: NodeLike): NodeLike | null => {
    if (node.dataset && key in node.dataset) return node;
    if (!node.children) return null;
    for (let i = 0; i < node.children.length; i += 1) {
      const hit = visit(node.children[i]);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root as unknown as NodeLike) as T | null;
}

function captureDraft(input: HTMLInputElement | null, active: Element | null | undefined): TextDraft | null {
  if (!input || input.disabled) return null;
  const focused = active === input;
  return {
    value: input.value,
    focused,
    start: focused ? (input.selectionStart ?? null) : null,
    end: focused ? (input.selectionEnd ?? null) : null,
    direction: focused ? (input.selectionDirection ?? null) : null,
  };
}

function restoreFocus(input: HTMLInputElement, draft: TextDraft | null): void {
  if (!draft?.focused) return;
  input.focus({ preventScroll: true });
  if (draft.start !== null && draft.end !== null && typeof input.setSelectionRange === "function") {
    input.setSelectionRange(draft.start, draft.end, draft.direction ?? undefined);
  }
}

/** Renders the real workspace settings panel and owns its exact-name close gate. */
export function renderWorkspaceSettings(
  root: HTMLElement,
  options: WorkspaceSettingsOptions,
): WorkspaceSettingsControls {
  const document = root.ownerDocument;
  const prev = previousRender.get(root);
  const sameWorkspace = prev?.workspaceId === options.workspaceId;
  const sameContext = options.moreOpen !== false && sameWorkspace && prev?.name === options.name;
  const canRename = Boolean(options.canRename && options.onRename);
  const prevMoreOpen = sameWorkspace &&
    findByDataset<HTMLDetailsElement>(root, "workspace-more", "workspaceMore")?.open === true;
  const closeDraft = sameContext && prev.canClose && options.canClose
    ? captureDraft(findByDataset<HTMLInputElement>(root, "workspace-close-confirm", "workspaceCloseConfirm"), document.activeElement)
    : null;
  const renameDraft = sameContext && prev.canRename && canRename
    ? captureDraft(findByDataset<HTMLInputElement>(root, "workspace-rename-input", "workspaceRenameInput"), document.activeElement)
    : null;

  const heading = document.createElement("h2");
  heading.className = "dashboard__workspace-settings-title";
  heading.textContent = options.name;
  const titleRow = document.createElement("div");
  titleRow.className = "dashboard__workspace-settings-title-row";
  titleRow.append(heading);
  let renameInput: HTMLInputElement | null = null;
  if (canRename && options.onRename) {
    const rename = renameControl(root, heading, titleRow, options.name, options.onRename);
    titleRow.append(rename.button);
    if (renameDraft !== null) renameInput = rename.openForm(renameDraft.value);
  }

  const counts = document.createElement("p");
  counts.className = "dashboard__workspace-settings-counts";
  counts.textContent = `${
    countLabel(options.memberCount, "person", "people")
  } · ${countLabel(options.agentCount, "agent", "agents")}`;

  const identity = document.createElement("div");
  identity.className = "dashboard__workspace-identity";
  const idLabel = document.createElement("p");
  idLabel.className = "dashboard__popover-label";
  idLabel.textContent = "Workspace ID";
  const id = document.createElement("code");
  id.className = "dashboard__workspace-id";
  id.dataset.channelId = "";
  id.textContent = options.workspaceId;
  const copy = document.createElement("button");
  copy.className = "dashboard__text-button";
  copy.type = "button";
  copy.dataset.copyWorkspaceId = "";
  copy.textContent = "Copy workspace ID";
  const copyStatus = document.createElement("span");
  copyStatus.className = "dashboard__copy-status";
  copyStatus.dataset.workspaceIdStatus = "";
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    try {
      await options.onCopy();
      copyStatus.textContent = "Copied";
    } catch {
      copyStatus.textContent = "Could not copy";
    }
  });

  const cleanup = document.createElement("section");
  cleanup.className = "dashboard__workspace-cleanup";
  if (options.onCleanup) {
    const cleanupButton = document.createElement("button");
    cleanupButton.type = "button";
    cleanupButton.className = "dashboard__text-button";
    cleanupButton.dataset.workspaceCleanupOpen = "";
    cleanupButton.textContent = "Clean up agents and files";
    const open = options.onCleanup;
    cleanupButton.addEventListener("click", () => open());
    cleanup.append(cleanupButton);
  } else {
    cleanup.hidden = true;
  }

  const danger = document.createElement("section");
  danger.className = "dashboard__workspace-danger";
  danger.dataset.workspaceCloseSection = "";
  const dangerTitle = document.createElement("h3");
  dangerTitle.textContent = "Close workspace";
  const warning = document.createElement("p");
  warning.textContent =
    "This hides the workspace for everyone and frees its free-tier slot. Members lose access. ";
  const support = document.createElement("a");
  support.href = "/support";
  support.textContent = "Contact support";
  warning.append(support, " if you need help.");
  const form = document.createElement("form");
  form.dataset.workspaceCloseForm = "";
  const label = document.createElement("label");
  label.textContent = `Type ${options.name} to confirm.`;
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.workspaceCloseConfirm = "";
  input.setAttribute(
    "aria-label",
    `Type ${options.name} to confirm workspace close`,
  );
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "dashboard__danger-button";
  button.dataset.workspaceCloseSubmit = "";
  button.textContent = "Close workspace";
  button.disabled = true;
  const status = document.createElement("p");
  status.className = "dashboard__form-error";
  status.dataset.workspaceCloseError = "";
  status.setAttribute("role", "alert");
  status.hidden = true;

  if (!options.canClose) {
    input.disabled = true;
    label.textContent = "Only a workspace owner can close this workspace.";
  }
  const syncGate = (): void => {
    button.disabled = !options.canClose || input.value !== options.name;
  };
  if (closeDraft !== null) {
    input.value = closeDraft.value;
    syncGate();
  }
  input.addEventListener("input", syncGate);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    syncGate();
    if (button.disabled) return;
    button.disabled = true;
    input.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Closing workspace…";
    status.hidden = true;
    status.textContent = "";
    try {
      await options.onClose();
    } catch (error) {
      status.textContent = error instanceof Error
        ? error.message
        : "Workspace close failed.";
      status.hidden = false;
      input.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Close workspace";
      syncGate();
    }
  });

  label.append(input);
  form.append(label, button, status);
  danger.append(dangerTitle, warning, form);
  identity.append(idLabel, id, copy, copyStatus);
  /* What a person comes here for stays in view: the name, who is in it, and who may create channels. Everything else
     is one press away under More: clean-up, moving the workspace, its ID, and closing it. More starts closed, so the
     one action that cannot be undone is never the first thing on screen; a redraw for the same workspace while the
     dialog is open keeps More open if the person already opened it. */
  const keepMoreOpen = options.moreOpen ?? prevMoreOpen;
  const more = document.createElement("details");
  more.className = "dashboard__workspace-more";
  more.dataset.workspaceMore = "";
  if (keepMoreOpen) more.open = true;
  const moreSummary = document.createElement("summary");
  moreSummary.textContent = "More";
  more.append(moreSummary, cleanup);
  root.replaceChildren(titleRow, counts);
  if (options.channelPolicy) root.append(channelPolicyControl(root, options.channelPolicy));
  root.append(more);
  if (options.moveDestinations?.length && options.onMove) {
    const form = document.createElement("form");
    form.className = "dashboard__workspace-move";
    form.dataset.workspaceMoveForm = "";
    const label = document.createElement("label");
    label.textContent = "Move to organization";
    const picker = document.createElement("select");
    picker.dataset.workspaceMoveDestination = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select organization";
    picker.append(placeholder);
    for (const destination of options.moveDestinations) {
      const option = document.createElement("option");
      option.value = destination.id;
      option.textContent = destination.name;
      picker.append(option);
    }
    label.append(picker);
    const move = document.createElement("button");
    move.type = "submit";
    move.className = "dashboard__text-button";
    move.textContent = "Move";
    move.disabled = true;
    const error = document.createElement("p");
    error.className = "dashboard__form-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    let busy = false;
    picker.addEventListener("change", () => {
      move.disabled = busy || !picker.value;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !picker.value) return;
      busy = true;
      move.disabled = true;
      picker.disabled = true;
      move.setAttribute("aria-busy", "true");
      error.hidden = true;
      try {
        await options.onMove!(picker.value);
      } catch (reason) {
        error.textContent = reason instanceof Error
          ? reason.message
          : "Workspace move failed.";
        error.hidden = false;
      } finally {
        busy = false;
        picker.disabled = false;
        move.disabled = !picker.value;
        move.removeAttribute("aria-busy");
      }
    });
    form.append(label, move, error);
    more.append(form);
  }
  // The workspace ID is for support and for setting up an agent by hand. Close workspace is last, with its typed
  // confirmation beside it.
  more.append(identity, danger);
  previousRender.set(root, {
    workspaceId: options.workspaceId,
    name: options.name,
    canClose: options.canClose,
    canRename,
  });
  if (renameInput) restoreFocus(renameInput, renameDraft);
  restoreFocus(input, closeDraft);
  return { confirmInput: input, closeButton: button };
}

/**
 * Who may create channels: two native radios that save on change. The choice moves at once; a
 * refusal puts it back and says why. A choice made while the last one is being saved is not taken.
 * The radios are never `disabled`: that drops keyboard focus, and putting it back when the answer
 * arrives could take it from wherever the person has gone meanwhile. Focus is left alone throughout.
 */
function channelPolicyControl(root: HTMLElement,
  policy: NonNullable<WorkspaceSettingsOptions["channelPolicy"]>): HTMLElement {
  const document = root.ownerDocument;
  const group = document.createElement("section");
  group.className = "dashboard__workspace-channel-policy";
  group.dataset.workspaceChannelPolicy = "";
  group.setAttribute("role", "radiogroup");
  const title = document.createElement("h3");
  title.id = "dashboard-workspace-channel-policy-title";
  title.textContent = CHANNEL_CREATION_TITLE;
  group.setAttribute("aria-labelledby", title.id);
  const status = document.createElement("p");
  status.className = "dashboard__workspace-channel-policy-status";
  status.dataset.workspaceChannelPolicyStatus = "";
  status.setAttribute("role", "status");
  let held = policy.value;
  let saving: ChannelCreationPolicy | null = null;
  const inputs = new Map<ChannelCreationPolicy, HTMLInputElement>();
  const show = (value: ChannelCreationPolicy | null): void => {
    for (const [key, input] of inputs) input.checked = key === value;
  };
  const rows = CHANNEL_CREATION_POLICIES.map((value) => {
    const label = document.createElement("label");
    label.className = "dashboard__workspace-channel-policy-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "workspace-channel-policy";
    input.value = value;
    input.dataset.workspaceChannelPolicyChoice = value;
    inputs.set(value, input);
    const name = document.createElement("span");
    name.textContent = CHANNEL_CREATION_LABELS[value];
    input.addEventListener("change", async () => {
      if (saving !== null) { show(saving); return; }
      if (!input.checked || value === held) return;
      saving = value;
      for (const other of inputs.values()) other.setAttribute("aria-disabled", "true");
      group.setAttribute("aria-busy", "true");
      status.textContent = "";
      delete status.dataset.problem;
      try {
        held = await policy.onChange(value);
        status.textContent = CHANNEL_CREATION_SAVED;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "CommonSwarm did not save that.";
        status.dataset.problem = "";
      } finally {
        saving = null;
        show(held);
        for (const other of inputs.values()) other.removeAttribute("aria-disabled");
        group.removeAttribute("aria-busy");
      }
    });
    label.append(input, name);
    return label;
  });
  show(held);
  group.append(title, ...rows, status);
  return group;
}

/** A Rename button that swaps the title for a name field; Escape or Cancel puts the title back. */
function renameControl(root: HTMLElement, heading: HTMLElement, titleRow: HTMLElement, current: string,
  onRename: (name: string) => Promise<void>): { button: HTMLButtonElement; openForm(draft?: string): HTMLInputElement } {
  const document = root.ownerDocument;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "dashboard__text-button";
  open.dataset.workspaceRename = "";
  open.textContent = "Rename";
  const openForm = (draft?: string): HTMLInputElement => {
    const form = document.createElement("form");
    form.className = "dashboard__workspace-rename";
    form.dataset.workspaceRenameForm = "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = draft ?? current;
    input.maxLength = 80;
    input.required = true;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Workspace name");
    input.dataset.workspaceRenameInput = "";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "dashboard__button--primary";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "dashboard__text-button";
    cancel.textContent = "Cancel";
    const error = document.createElement("p");
    error.className = "dashboard__form-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    let busy = false;
    const next = (): string => input.value.replace(/\s+/g, " ").trim();
    const sync = (): void => { save.disabled = busy || !next() || next() === current; };
    const restore = (): void => { titleRow.replaceChildren(heading, open); open.focus(); };
    input.addEventListener("input", () => { error.hidden = true; sync(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); restore(); } });
    cancel.addEventListener("click", () => { if (!busy) restore(); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      sync();
      if (save.disabled) return;
      busy = true;
      sync();
      input.disabled = true;
      save.setAttribute("aria-busy", "true");
      try {
        await onRename(next());
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : "The rename was not confirmed. Reload to check.";
        error.hidden = false;
        busy = false;
        input.disabled = false;
        save.removeAttribute("aria-busy");
        sync();
        input.focus();
      }
    });
    form.append(input, save, cancel, error);
    titleRow.replaceChildren(form);
    sync();
    if (draft === undefined) {
      input.focus();
      input.select();
    }
    return input;
  };
  open.addEventListener("click", () => { openForm(); });
  return { button: open, openForm };
}
