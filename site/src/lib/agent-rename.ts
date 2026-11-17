/*
 * RENAME AN AGENT IN PLACE: the joined card in the Add an agent panel and each agent row on People &
 * agents that the viewer may rename. The server's rename_agent command is the judge: the agent's owner
 * or a workspace owner or admin, a name unused in every workspace the agent belongs to, ignoring case.
 *
 * One native form: a text field, Save and Cancel. Enter saves, Escape (or Cancel, for touch) leaves
 * the name as it was. A refusal is the server's own sentence, shown under the field, and the draft
 * stays so the person can change it. Names reach the DOM only as values and text, never as markup.
 *
 * ONE COMMAND ID PER ATTEMPT. A new name is a new attempt with a fresh id. Only when an attempt's
 * outcome is unknown (the connection dropped) does Save with the same name send the same id again,
 * so the server replays the first answer instead of renaming twice. A decided answer (renamed or
 * refused) ends the attempt.
 */

export type RenameOutcome = { ok: true } | { ok: false; message: string };

export interface RenameField {
  form: HTMLFormElement;
  input: HTMLInputElement;
  setError(message: string): void;
  setPending(pending: boolean): void;
}

export interface RenameFieldOptions {
  /** Unique in the page: the field's id, and its error's id with "-error". */
  id: string;
  label: string;
  /** The agent's name now. */
  current: string;
  /** What the field shows: the current name, or a draft kept across a re-render. */
  value: string;
  error?: string;
  pending?: boolean;
  /** Extra hook for focus restoration across re-renders (people-dialog-view's data-pd-focus). */
  focusKey?: string;
  onInput?: (value: string) => void;
  /** The trimmed name; never called while pending, for an empty name, or for the name it opened with. */
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** Agent names are 1 to 80 characters (AGENT_NAME_RULE); the field says no more than the server allows. */
export const AGENT_NAME_MAX = 80;

export function buildAgentRenameField(doc: Document, options: RenameFieldOptions): RenameField {
  const form = doc.createElement("form");
  form.className = "hm-rename";
  form.dataset.agentRename = "";
  form.noValidate = true;
  const label = doc.createElement("label");
  label.className = "hm-rename__label";
  label.htmlFor = options.id;
  label.textContent = options.label;
  const row = doc.createElement("div");
  row.className = "hm-rename__row";
  const input = doc.createElement("input");
  input.className = "hm-rename__input";
  input.id = options.id;
  input.type = "text";
  input.maxLength = AGENT_NAME_MAX;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = options.value;
  input.dataset.renameInput = "";
  if (options.focusKey) input.dataset.pdFocus = options.focusKey;
  const error = doc.createElement("p");
  error.className = "hm-rename__error";
  error.id = `${options.id}-error`;
  error.setAttribute("role", "alert");
  error.dataset.renameError = "";
  const save = doc.createElement("button");
  save.type = "submit";
  save.className = "hm-rename__save";
  save.textContent = "Save";
  save.dataset.renameSave = "";
  if (options.focusKey) save.dataset.pdFocus = `${options.focusKey}-save`;
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "hm-rename__cancel";
  cancel.textContent = "Cancel";
  cancel.dataset.renameCancel = "";
  if (options.focusKey) cancel.dataset.pdFocus = `${options.focusKey}-cancel`;
  row.append(input, save, cancel);
  form.append(label, row, error);

  let pending = false;
  const setError = (message: string) => {
    error.textContent = message;
    error.hidden = message === "";
    if (message) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", error.id);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  };
  const setPending = (next: boolean) => {
    pending = next;
    save.disabled = next;
    input.readOnly = next;
  };
  setError(options.error ?? "");
  setPending(options.pending === true);

  input.addEventListener("input", () => {
    if (error.textContent) setError("");
    options.onInput?.(input.value);
  });
  cancel.addEventListener("click", () => options.onCancel());
  // The field may sit in a native dialog: Escape leaves the name, not the dialog.
  form.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    options.onCancel();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending) return;
    const name = input.value.trim();
    if (!name) {
      input.focus({ preventScroll: true });
      return;
    }
    if (name === options.current) {
      options.onCancel();
      return;
    }
    options.onSubmit(name);
  });
  return { form, input, setError, setPending };
}

/** The command id for each rename attempt, keyed by who renames which agent where. */
export class RenameAttempts {
  #open = new Map<string, { name: string; commandId: string }>();

  /** The same id while an attempt with this name is still unanswered; otherwise a fresh one. */
  commandId(key: string, name: string, fresh: () => string): string {
    const open = this.#open.get(key);
    if (open && open.name === name) return open.commandId;
    const commandId = fresh();
    this.#open.set(key, { name, commandId });
    return commandId;
  }

  /** The server answered: the next Save is a new attempt. */
  settle(key: string): void {
    this.#open.delete(key);
  }
}
