import {
  SEAT_ADMIN_NO_END_DATE_LINE, SEAT_ADMIN_ROLE_COPY,
} from "../../../src/protocol/seat-admin-copy";
import type { SeatAdminLevel } from "../../../src/protocol/seat-admin";

export type SeatAdminRoleLevel = Exclude<SeatAdminLevel, "scoped">;
export type SeatAdminDuration = null | 1 | 7 | 30 | 90;
export interface SeatAdminScope { id: string; name: string }
export type SeatAdminAccess = { state: "off" } | { state: "on"; grantId: string } | { state: "unresolved" };
export interface SeatAdminSwitch {
  scope: SeatAdminScope;
  access: SeatAdminAccess;
  mayGrant: boolean;
  mayRemove: boolean;
  pending?: boolean;
}
export type SeatAdminPanelModel = { state: "hidden" } | {
  state: "loading" | "error" | "ready";
  agentName: string;
  workspace?: SeatAdminSwitch;
  organization?: SeatAdminSwitch;
  notice?: string;
  historyHref?: string;
};
export interface SeatAdminPanelActions {
  enable: (level: SeatAdminRoleLevel, opener: HTMLButtonElement) => void;
  remove: (grantId: string, opener: HTMLButtonElement) => void;
  retry: () => void;
  history?: (event: MouseEvent) => void;
}

const levelName = (level: SeatAdminRoleLevel): string => level === "workspace" ? "Workspace admin" : "Organization admin";
function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function action(doc: Document, text: string, run: () => void): HTMLButtonElement {
  const node = element(doc, "button", "sa-button", text);
  node.type = "button";
  node.addEventListener("click", run);
  return node;
}

/** Presentation only: the controller owns availability, eligibility and accepted grant state.
 * In particular, an unresolved active grant never becomes an unchecked switch. */
export function buildSeatAdminPanel(doc: Document, model: SeatAdminPanelModel, actions: SeatAdminPanelActions): HTMLElement | null {
  if (model.state === "hidden") return null;
  const panel = element(doc, "section", "sa-admin");
  panel.dataset.seatAdmin = model.state;
  panel.setAttribute("aria-label", `Admin access for ${model.agentName}`);
  panel.append(element(doc, "h3", "sa-admin__title", "Admin"));
  if (model.state !== "ready") {
    const status = element(doc, "p", "sa-admin__notice", model.state === "loading" ? "Checking admin access…" : "Couldn't check admin access.");
    status.setAttribute("role", model.state === "error" ? "alert" : "status");
    panel.append(status);
    if (model.state === "error") panel.append(action(doc, "Retry", actions.retry));
    return panel;
  }
  for (const level of ["workspace", "organization"] as const) {
    const item = model[level];
    if (!item || (item.access.state === "off" && !item.mayGrant)) continue;
    const row = element(doc, "div", "sa-admin__row");
    row.dataset.seatAdminLevel = level;
    const label = element(doc, "div", "sa-admin__label");
    label.append(element(doc, "strong", "", levelName(level)), element(doc, "span", "sa-admin__scope", item.scope.name));
    row.append(label);
    if (item.access.state === "unresolved" || (item.access.state === "on" && !item.access.grantId)) {
      row.append(element(doc, "span", "sa-admin__unresolved", "Not checked"));
    } else {
      const access = item.access;
      const on = access.state === "on";
      const toggle = action(doc, "", () => {
        if (toggle.disabled) return;
        if (access.state === "on") actions.remove(access.grantId, toggle);
        else actions.enable(level, toggle);
      });
      toggle.className = "sa-switch";
      toggle.dataset.seatAdminToggle = level;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(on));
      toggle.setAttribute("aria-label", `${levelName(level)} for ${model.agentName} in ${item.scope.name}`);
      toggle.disabled = !!item.pending || (on ? !item.mayRemove : !item.mayGrant);
      if (item.pending) row.setAttribute("aria-busy", "true");
      const track = element(doc, "span", "sa-switch__track");
      track.setAttribute("aria-hidden", "true");
      toggle.append(track);
      row.append(toggle);
    }
    panel.append(row);
  }
  if ([model.workspace, model.organization].some(item => item?.access.state === "unresolved" || (item?.access.state === "on" && !item.access.grantId))) {
    panel.append(action(doc, "Retry", actions.retry));
  }
  if (model.notice) {
    const notice = element(doc, "p", "sa-admin__notice", model.notice);
    notice.setAttribute("role", "status");
    panel.append(notice);
  }
  if (model.historyHref) {
    const history = element(doc, "a", "sa-admin__history", "Admin access and history");
    history.href = model.historyHref;
    if (actions.history) history.addEventListener("click", actions.history);
    panel.append(history);
  }
  return panel;
}

/** A non-secret intent. The controller creates the closed command payload and its command ID.
 * expiresAt is the date displayed for this confirmation, not a newly extended date on submit.
 * Auth return builds a new confirmation from days; it must never auto-submit the old draft. */
export interface SeatAdminGrantDraft {
  principalId: string;
  level: SeatAdminRoleLevel;
  scopeId: string;
  days: SeatAdminDuration;
  expiresAt: number | null;
}
export interface SeatAdminConfirmationOptions {
  principalId: string;
  agentName: string;
  level: SeatAdminRoleLevel;
  scopes: readonly SeatAdminScope[];
  scopeId?: string;
  days?: SeatAdminDuration;
  confirm: (draft: SeatAdminGrantDraft) => void;
  signIn: (draft: SeatAdminGrantDraft) => void;
  refresh: () => void;
  cancel?: () => void;
}
export interface SeatAdminConfirmationState {
  phase: "confirm" | "pending" | "error" | "reauthenticate" | "unknown";
  notice?: string;
}
let nextConfirmationId = 0;

/** Append dialog inside the app's token scope, then call open(). One instance per intent.
 * Navigation/account changes dispose it; auth return creates a new, reconfirmed intent.
 * No request, optimistic grant, feature flag or credential is owned by this renderer. */
export function buildSeatAdminConfirmation(doc: Document, options: SeatAdminConfirmationOptions) {
  const id = `seat-admin-confirm-${++nextConfirmationId}`;
  const dialog = element(doc, "dialog", "sa-confirm");
  dialog.dataset.seatAdminConfirm = options.level;
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  const form = element(doc, "form", "sa-confirm__form");
  const header = element(doc, "header", "sa-confirm__header");
  const title = element(doc, "h2", "", `Make ${options.agentName} ${options.level === "workspace" ? "a workspace" : "an organization"} admin?`);
  title.id = `${id}-title`;
  header.append(title);
  const body = element(doc, "div", "sa-confirm__body");
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "Admin permissions and end date");
  const scopeLabel = element(doc, "label", "sa-field");
  scopeLabel.append(element(doc, "span", "", options.level === "workspace" ? "Workspace" : "Organization"));
  const scope = element(doc, "select", "sa-select");
  scope.dataset.seatAdminScope = "";
  scope.required = true;
  const placeholder = element(doc, "option", "", options.level === "workspace" ? "Choose workspace" : "Choose organization");
  placeholder.value = "";
  placeholder.disabled = true;
  scope.append(placeholder);
  for (const item of options.scopes) {
    const option = element(doc, "option", "", item.name);
    option.value = item.id;
    scope.append(option);
  }
  scope.value = options.scopes.some(item => item.id === options.scopeId) ? options.scopeId! : "";
  scopeLabel.append(scope);
  body.append(scopeLabel);
  const copy = SEAT_ADMIN_ROLE_COPY[options.level === "workspace" ? "role:workspace_admin" : "role:organization_admin"];
  for (const [heading, lines] of [["Available now", copy.included], ["Included, not available yet", copy.deferred], ["Not allowed", copy.excluded]] as const) {
    const section = element(doc, "section", "sa-confirm__permissions");
    const list = element(doc, "ul", "");
    for (const line of lines) list.append(element(doc, "li", "", line));
    section.append(element(doc, "h3", "", heading), list);
    body.append(section);
  }
  const endLabel = element(doc, "label", "sa-field");
  endLabel.append(element(doc, "span", "", "End date"));
  const duration = element(doc, "select", "sa-select");
  duration.dataset.seatAdminDuration = "";
  for (const [value, text] of [["none", "No end date"], ["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]) {
    const option = element(doc, "option", "", text);
    option.value = value!;
    duration.append(option);
  }
  duration.value = options.days == null ? "none" : String(options.days);
  endLabel.append(duration);
  const endNote = element(doc, "p", "sa-confirm__end-note");
  endNote.id = `${id}-end`;
  duration.setAttribute("aria-describedby", endNote.id);
  let expiresAt: number | null = null;
  const updateEnd = () => {
    expiresAt = duration.value === "none" ? null : Date.now() + Number(duration.value) * 86_400_000;
    endNote.textContent = expiresAt === null ? SEAT_ADMIN_NO_END_DATE_LINE : `Ends ${new Intl.DateTimeFormat(doc.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" }).format(expiresAt)}.`;
  };
  duration.addEventListener("change", updateEnd);
  updateEnd();
  body.append(endLabel, endNote);
  const notice = element(doc, "p", "sa-confirm__notice");
  notice.hidden = true;
  notice.setAttribute("role", "status");
  const footer = element(doc, "footer", "sa-confirm__footer");
  const cancel = action(doc, "Cancel", () => { close(); options.cancel?.(); });
  const submit = element(doc, "button", "sa-button sa-button--primary", `Grant ${levelName(options.level).toLowerCase()}`);
  submit.type = "submit";
  submit.dataset.seatAdminGrant = "";
  const signIn = action(doc, "Sign in again", () => { const intent = draft(); if (intent) { signIn.disabled = true; options.signIn(intent); } });
  signIn.classList.add("sa-button--primary");
  const refresh = action(doc, "Refresh admin access", () => { refresh.disabled = true; options.refresh(); });
  refresh.classList.add("sa-button--primary");
  footer.append(cancel, submit, signIn, refresh);
  form.append(header, body, notice, footer);
  dialog.append(form);
  let state: SeatAdminConfirmationState = { phase: "confirm" };
  let opener: HTMLElement | null = null;
  function draft(): SeatAdminGrantDraft | null {
    if (!options.scopes.some(item => item.id === scope.value)) return null;
    const days = duration.value === "none" ? null : Number(duration.value);
    if (days !== null && ![1, 7, 30, 90].includes(days)) return null;
    return { principalId: options.principalId, level: options.level, scopeId: scope.value, days: days as SeatAdminDuration, expiresAt };
  }
  function setState(next: SeatAdminConfirmationState): void {
    state = next;
    dialog.dataset.seatAdminPhase = next.phase;
    form.setAttribute("aria-busy", String(next.phase === "pending"));
    scope.disabled = duration.disabled = !["confirm", "error"].includes(next.phase);
    submit.hidden = ["reauthenticate", "unknown"].includes(next.phase);
    submit.disabled = next.phase === "pending" || !draft();
    signIn.hidden = next.phase !== "reauthenticate";
    signIn.disabled = !draft();
    refresh.hidden = next.phase !== "unknown";
    refresh.disabled = false;
    cancel.textContent = next.phase === "pending" ? "Close" : "Cancel";
    notice.textContent = next.notice ?? (next.phase === "pending" ? "Saving admin access…" : next.phase === "reauthenticate" ? "Sign in again to confirm this admin access." : next.phase === "unknown" ? "The result couldn't be checked. Refresh admin access before trying again." : "");
    notice.hidden = !notice.textContent;
    notice.setAttribute("role", next.phase === "error" || next.phase === "unknown" ? "alert" : "status");
  }
  scope.addEventListener("change", () => setState(state));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!["confirm", "error"].includes(state.phase)) return;
    const intent = draft();
    if (!intent) { scope.reportValidity(); return; }
    setState({ phase: "pending" });
    options.confirm(intent);
  });
  function close(): void {
    if (dialog.open) dialog.close();
    if (opener?.isConnected && !opener.closest("[inert], [hidden]")) opener.focus({ preventScroll: true });
    opener = null;
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); options.cancel?.(); });
  setState(state);
  return {
    dialog, setState,
    open(from?: HTMLElement) {
      opener = from ?? (doc.activeElement instanceof HTMLElement ? doc.activeElement : null);
      dialog.showModal();
      cancel.focus({ preventScroll: true });
    },
    close,
    dispose() { opener = null; if (dialog.open) dialog.close(); dialog.remove(); },
  };
}
