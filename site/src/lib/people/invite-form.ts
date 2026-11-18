/**
 * People & agents: inviting a person, inside the dialog. The form sits at the top of the Invites tab;
 * once the invite is made, its one-use link takes the form's place and the invite is in the list below.
 * The dialog is redrawn often, so everything here is drawn from the draft: no fact lives only in a node.
 * The link itself is never part of the draft; the integration hands it in while it is still good.
 */
export interface PeopleInviteDraft {
  email: string;
  busy: boolean;
  /** The refusal to show under the form. */
  error: string;
  /** The invite this form made. Its link is shown while the integration still holds it. */
  madeId: string;
  /** What Copy last said. */
  copied: string;
}
export const newPeopleInviteDraft = (): PeopleInviteDraft => ({ email: "", busy: false, error: "", madeId: "", copied: "" });

export interface PeopleInviteHandlers {
  input(value: string): void;
  submit(): void;
  cancel(): void;
  copy(link: HTMLElement): void;
  done(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
};

/** The email form. A text field with an email keyboard, so the caret can be put back after a redraw. */
export function buildPeopleInviteForm(doc: Document, draft: PeopleInviteDraft, on: PeopleInviteHandlers): HTMLFormElement {
  const form = el(doc, "form", "pd-invite-form"); form.noValidate = true; form.dataset.peopleInviteForm = "";
  const label = el(doc, "label", "", "Their email"); label.htmlFor = "pd-invite-email";
  const input = el(doc, "input", ""); input.id = "pd-invite-email"; input.type = "text"; input.inputMode = "email"; input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off"); input.spellcheck = false; input.value = draft.email; input.readOnly = draft.busy;
  input.dataset.pdFocus = "invite-email"; input.setAttribute("aria-describedby", "pd-invite-note pd-invite-sharing");
  input.addEventListener("input", () => on.input(input.value));
  const note = el(doc, "p", "pd-muted pd-invite-note",
    "The link works only for this email. They can read earlier messages, lists and files shared in this workspace."); note.id = "pd-invite-note";
  // Plain text for now: saying it only when it applies needs a read of the setting that this page does not have.
  const sharing = el(doc, "p", "pd-muted pd-invite-note",
    "Invites work only when workspace sharing in Lists & docs is set to ‘Me and people I invite’."); sharing.id = "pd-invite-sharing";
  const actions = el(doc, "div", "pd-invite-form-actions");
  const submit = el(doc, "button", "pd-invite-submit", draft.busy ? "Creating a private link…" : "Create invite link"); submit.type = "submit";
  // Busy is said, not disabled: a disabled button would drop keyboard focus in the middle of the request.
  if (draft.busy) submit.setAttribute("aria-disabled", "true");
  submit.dataset.pdFocus = "invite-submit";
  const cancel = el(doc, "button", "pd-invite-cancel", "Cancel"); cancel.type = "button"; cancel.disabled = draft.busy; cancel.dataset.pdFocus = "invite-cancel";
  cancel.addEventListener("click", () => on.cancel());
  actions.append(submit, cancel);
  const error = el(doc, "p", "pd-error", draft.error); error.setAttribute("role", "alert"); error.hidden = !draft.error; error.dataset.peopleInviteError = "";
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!draft.busy) on.submit(); });
  form.append(label, input, note, sharing, actions, error); return form;
}

/** The invite just made: its one-use link, Copy, and Done. */
export function buildPeopleInviteMade(doc: Document, draft: PeopleInviteDraft, link: string, on: PeopleInviteHandlers): HTMLElement {
  const made = el(doc, "div", "pd-invite-made"); made.dataset.peopleInviteMade = "";
  const receipt = el(doc, "p", "pd-invite-receipt", `Private one-use link for ${draft.email} · expires in 7 days`);
  const shown = el(doc, "pre", "pd-invite-link", link); shown.tabIndex = 0; shown.dataset.pdFocus = "invite-link"; shown.setAttribute("aria-label", "Invite link");
  const actions = el(doc, "div", "pd-invite-form-actions");
  const copy = el(doc, "button", "pd-invite-submit", "Copy invite link"); copy.type = "button"; copy.dataset.pdFocus = "invite-copy";
  copy.addEventListener("click", () => on.copy(shown));
  const done = el(doc, "button", "pd-invite-cancel", "Done"); done.type = "button"; done.dataset.pdFocus = "invite-done";
  done.addEventListener("click", () => on.done());
  actions.append(copy, done);
  const status = el(doc, "p", "pd-muted pd-invite-copied", draft.copied); status.setAttribute("role", "status");
  made.append(receipt, shown, actions, status); return made;
}
