export interface WorkspaceSettingsOptions {
  name: string;
  workspaceId: string;
  memberCount: number;
  agentCount: number;
  canClose: boolean;
  /** Owners and admins may rename; the server decides. */
  canRename?: boolean;
  onRename?(name: string): Promise<void>;
  /** Owners and admins: open the Clean up dialog. Absent for everyone else. */
  onCleanup?(): void;
  moveDestinations?: readonly { id: string; name: string }[];
  onMove?(orgId: string): Promise<void>;
  onCopy(): Promise<void>;
  onClose(): Promise<void>;
}

export interface WorkspaceSettingsControls {
  confirmInput: HTMLInputElement;
  closeButton: HTMLButtonElement;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Renders the real workspace settings panel and owns its exact-name close gate. */
export function renderWorkspaceSettings(
  root: HTMLElement,
  options: WorkspaceSettingsOptions,
): WorkspaceSettingsControls {
  const document = root.ownerDocument;
  const heading = document.createElement("h2");
  heading.className = "dashboard__workspace-settings-title";
  heading.textContent = options.name;
  const titleRow = document.createElement("div");
  titleRow.className = "dashboard__workspace-settings-title-row";
  titleRow.append(heading);
  if (options.canRename && options.onRename) titleRow.append(renameControl(root, heading, titleRow, options.name, options.onRename));

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
  root.replaceChildren(titleRow, counts, identity, cleanup);
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
    root.append(form);
  }
  root.append(danger);
  return { confirmInput: input, closeButton: button };
}

/** A Rename button that swaps the title for a name field; Escape or Cancel puts the title back. */
function renameControl(root: HTMLElement, heading: HTMLElement, titleRow: HTMLElement, current: string,
  onRename: (name: string) => Promise<void>): HTMLButtonElement {
  const document = root.ownerDocument;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "dashboard__text-button";
  open.dataset.workspaceRename = "";
  open.textContent = "Rename";
  open.addEventListener("click", () => {
    const form = document.createElement("form");
    form.className = "dashboard__workspace-rename";
    form.dataset.workspaceRenameForm = "";
    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
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
    input.focus();
    input.select();
  });
  return open;
}
