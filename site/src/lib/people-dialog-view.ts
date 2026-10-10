import { AGENT_HOSTS, HOSTED_LISTS_NOTE } from "./agent-hosts";
import { buildAgentModelEditor } from "./agent-model-editor";
import type { PeopleAgentStatus } from "./agent-status";
import { personTint } from "./home-names";

export interface PeopleDialogPerson { id: string; name: string; role: "owner" | "admin" | "member"; own: boolean; mayRemove: boolean }
export interface PeopleDialogAgent {
  id: string; name: string; ownerId: string; ownerName: string | null; model: string | null;
  app: string | null; hosted: boolean; status: PeopleAgentStatus; receive: string | null;
  lastActive: string; technical: string[]; grantRisk?: string | null; updateAvailable: boolean;
  access: { until: string | null } | null; accessReadState: "pending" | "succeeded" | "failed"; key: string | null; liveKey: boolean;
  own: boolean; mayManage: boolean; receipt: string;
}
export interface PeopleDialogInvite { id: string; kind: "invite" | "agent" | "pending"; name: string; detail: string; mayCancel: boolean }
/** `workspaceName` is the viewer's name for this workspace; it is used only in the role refusal copy. */
export interface PeopleDialogModel { people: PeopleDialogPerson[]; agents: PeopleDialogAgent[]; invites: PeopleDialogInvite[]; sample: boolean; pendingFailed: boolean; workspaceName?: string }
export type PeopleDialogRole = PeopleDialogPerson["role"];
/** The role-change action the builder emits. Integration maps it to the `change_role` command. */
export interface PeopleDialogRoleChange { kind: "change-role"; userId: string; role: PeopleDialogRole }
/** Open the dialog with one person or one agent selected. */
export interface PeopleDialogFocus { kind: "person" | "agent"; id: string }
/** Role drafts, outcomes, pending saves and initial focus are builder-owned and optional. */
export interface PeopleDialogState { selected: { type: "agent" | "person"; id: string } | null; collapsed: Set<string>; showAllAttention: boolean; query: string;
  roleDraft?: { userId: string; role: PeopleDialogRole; confirming: boolean; error?: string } | null; roleReceipt?: { userId: string; text: string } | null;
  roleRefusal?: { userId: string; name: string; text: string } | null;
  /** One entry per person whose role change is in flight. The entry object is the save's identity. */
  rolePending?: Map<string, { role: PeopleDialogRole }>; focusApplied?: string | null;
  /** Builder-owned: the layout of the last render. A page keeps role drafts without a selected person. */
  layout?: "dialog" | "page" }
/** The page layout's own navigation. Links keep real hrefs; `navigate` (when given) handles the click in place. */
export interface PeopleDialogPage {
  /** The workspace name and its home route: the back link. */
  homeLabel: string; homeHref: string;
  /** Back. When given, the back link calls it instead of following its href. */
  back?: (event: MouseEvent) => void;
  /** The existing add-an-agent route. Absent or null hides the action. */
  addAgentHref?: string | null;
  /** The existing agent page for one agent: each manageable agent row links to it as Manage. */
  agentHref?: (agentId: string) => string;
  navigate?: (href: string, event: MouseEvent) => void;
  /** The existing invite flow. Shown only to an owner or an admin, never in a sample. */
  invite?: () => void;
  /** The filter. When given, the page shows the filter field for more than ten people and agents, or while it has a value. */
  onQuery?: (value: string) => void;
}
export interface PeopleDialogOptions {
  /** Applied once per state object and focus value; clear `state.focusApplied` to apply the same focus again. */
  focus?: PeopleDialogFocus;
  /** The tint used for an agent everywhere else in the app; null is neutral (its owner left). Without tintFor: position in the agent list. */
  tintFor?: (agentId: string) => 0 | 1 | 2 | 3 | null;
  /** "dialog" (default) fills the roster dialog's list and detail. "page" renders the whole People & agents page into `root`
   * (header, person cards, invitations, and a side column that holds `detail`), with the same model, controls and confirmations. */
  layout?: "dialog" | "page";
  page?: PeopleDialogPage;
}
export type PeopleDialogAction = "resume" | "new-key" | "remove-agent" | "turn-off-key" | "withdraw" | "remove-person" | "cancel-invite" | "connected-apps" | "allow";
export type PeopleConfirmAction = "remove-agent" | "turn-off-key" | "withdraw" | "remove-person" | "cancel-invite";
export interface PeopleDialogCallbacks {
  render: () => void;
  action: (action: PeopleDialogAction, id: string, button: HTMLButtonElement, notice: HTMLElement) => Promise<void> | void;
  saveModel: (id: string, model: string | null) => Promise<void>;
  confirm: (action: PeopleConfirmAction, id: string, opener: HTMLButtonElement) => void;
  /** Role change. Reject with an error that carries the server's stable code; the role control is hidden without this callback. */
  changeRole?: (change: PeopleDialogRoleChange) => Promise<void>;
}

/** The filter includes a person's whole group when their name matches. Orphans stay separate. */
export function peopleDialogGroups(model: PeopleDialogModel, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (agent: PeopleDialogAgent) => [agent.name, agent.app, agent.model, agent.ownerName]
    .some((value) => value?.toLocaleLowerCase().includes(needle));
  const groups = model.people.map((person) => ({ person, agents: model.agents.filter((agent) =>
    agent.ownerId === person.id && (!needle || person.name.toLocaleLowerCase().includes(needle) || matches(agent))) }))
    .filter(({ person, agents }) => !needle || person.name.toLocaleLowerCase().includes(needle) || agents.length);
  const other = model.agents.filter((agent) => !model.people.some((person) => person.id === agent.ownerId) && (!needle || matches(agent)));
  const invites = model.invites.filter((invite) => !needle || invite.name.toLocaleLowerCase().includes(needle));
  const attention = [...groups.flatMap((group) => group.agents), ...other].filter((agent) => agent.status.attention);
  return { groups, other, invites, attention };
}
export function peopleDialogCounts(model: PeopleDialogModel): string {
  const attention = model.agents.filter((agent) => agent.status.attention).length;
  return `${model.people.length} ${model.people.length === 1 ? "person" : "people"} · ${model.agents.length} ${model.agents.length === 1 ? "agent" : "agents"}${attention ? ` · ${attention} need attention` : ""}`;
}
export function peopleDialogAccessUntil(agent: PeopleDialogAgent): string | null {
  if (!agent.own || agent.accessReadState !== "succeeded") return null;
  if (!agent.access) return "Not allowed.";
  const until = `Allowed until ${agent.access.until ?? "you withdraw it"}.`;
  // A hosted agent's approval exists and can be withdrawn, but it cannot use Lists & docs yet.
  return agent.hosted ? `${until} ${HOSTED_LISTS_NOTE}` : until;
}
/** The accessible-name suffix for an approved agent: usable access for a local agent, the hosted note otherwise. */
export function peopleDialogAccessLabel(agent: Pick<PeopleDialogAgent, "hosted">): string {
  return agent.hosted ? `, ${HOSTED_LISTS_NOTE}` : ", Can use Lists & docs";
}
export function peopleDialogCanAct(model: PeopleDialogModel, action: PeopleDialogAction, id: string): boolean {
  if (model.sample) return false;
  if (action === "remove-person") return model.people.some((person) => person.id === id && person.mayRemove && !person.own);
  if (action === "cancel-invite") return model.invites.some((invite) => invite.id === id && invite.mayCancel);
  const agent = model.agents.find((candidate) => candidate.id === id);
  if (!agent) return false;
  if (action === "withdraw") return agent.own && agent.accessReadState === "succeeded" && !!agent.access;
  if (action === "resume") return agent.mayManage && agent.status.kind === "paused" && agent.status.fix.allowed;
  if (action === "allow") return agent.own && agent.accessReadState === "succeeded" && !agent.access;
  if (action === "new-key" || action === "connected-apps") return agent.own;
  if (action === "turn-off-key") return agent.mayManage && agent.liveKey;
  return action === "remove-agent" && agent.mayManage;
}
export function peopleConfirmationCopy(action: PeopleConfirmAction, item: { name: string; hosted?: boolean; kind?: string }) {
  const name = item.name;
  if (action === "remove-agent") return { title: `Remove ${name}?`, button: `Remove ${name}`,
    stops: [`${name} will lose access to this space. Its identity and every connection will end.`, "This cannot be undone."],
    stays: [`Its history stays as “${name} (removed)”.`, ...(item.hosted ? ["Its owner can connect a new agent with the same name."] : [])] };
  if (action === "turn-off-key") return { title: `Turn off ${name}’s key?`, button: "Turn off key",
    stops: [`${name} stops when its current access ends.`, "This key cannot be used again."],
    stays: ["Its identity and history stay here.", "Its owner can get a new key to bring it back."] };
  if (action === "withdraw") return { title: "Withdraw Lists & docs?", button: "Withdraw access",
    stops: [`${name} will no longer be able to use Lists & docs here.`],
    stays: ["Existing lists, docs and history stay.", "You can allow access again on the Lists & docs card."] };
  if (action === "remove-person") return { title: `Remove ${name}?`, button: `Remove ${name}`,
    stops: [`${name} will lose membership of this space.`, "This removal cannot be undone; they would need a new invitation to join again. You may need to sign in again."],
    stays: ["History stays. Their other spaces are unaffected."] };
  return { title: item.kind === "invite" ? "Cancel this invitation?" : "Cancel this unused key?",
    button: item.kind === "invite" ? "Cancel invitation" : "Cancel key",
    stops: [item.kind === "invite" ? `The invitation for ${name} will no longer work. No one has joined with it.` : `The unused key for ${name} will no longer work. No agent has used it.`],
    stays: [item.kind === "invite" ? "You can send a new invitation later." : "You can create a new key later."] };
}

const ROLE_LABELS: Record<PeopleDialogRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const ROLE_RANK: Record<PeopleDialogRole, number> = { member: 0, admin: 1, owner: 2 };
/** The refusal codes `change_role` can return (src/protocol/workspace-commands.ts); `peopleRoleRefusal` has copy for each. */
export const PEOPLE_ROLE_REFUSAL_CODES = ["bad_state", "landing_authority_unresolved", "last_owner", "member_not_found", "role_forbidden"] as const;
export const peopleFirstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** The roles the viewer may give this person; empty means the control is not shown. The server still decides. */
export function peopleDialogRoleOptions(model: PeopleDialogModel, personId: string): PeopleDialogRole[] {
  if (model.sample) return [];
  const viewer = model.people.find((person) => person.own); const target = model.people.find((person) => person.id === personId);
  if (!viewer || !target || viewer.role === "member") return [];
  if (viewer.role === "owner") return ["owner", "admin", "member"];
  return target.role === "owner" ? [] : ["admin", "member"];
}
export const peopleDialogRoleLabel = (role: PeopleDialogRole) => ROLE_LABELS[role];
/** A person asked to lower their own role confirms first; raising or keeping it needs no question. */
export function peopleRoleSelfConfirmCopy(current: PeopleDialogRole, next: PeopleDialogRole): { question: string; button: string } | null {
  if (ROLE_RANK[next] >= ROLE_RANK[current]) return null;
  return next === "member" ? { question: "Make yourself a member? You will no longer manage people here.", button: "Make yourself a member" }
    : { question: "Make yourself an admin? You will no longer be able to change an owner’s role.", button: "Make yourself an admin" };
}
export function peopleRoleReceipt(name: string, role: PeopleDialogRole): string {
  return `${peopleFirstName(name)} is now ${role === "member" ? "a" : "an"} ${role}.`;
}
/** Reads the stable code a rejected change carries: the first of `code` and `reason` that names a known refusal, else `code`, else `reason`. Never the message. A fresh sign-in refusal is named by its class, before any code. */
export function peopleRoleErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  if ((error as { name?: unknown }).name === "FreshLoginRequired") return "fresh_auth_required";
  const { code, reason } = error as { code?: unknown; reason?: unknown };
  const found = [code, reason].filter((value): value is string => typeof value === "string");
  return found.find((value) => (PEOPLE_ROLE_REFUSAL_CODES as readonly string[]).includes(value)) ?? found[0] ?? null;
}
export function peopleRoleRefusal(code: string | null, name: string, workspaceName?: string): string {
  const first = peopleFirstName(name);
  if (code === "fresh_auth_required") return "Sign in again, then retry the role change. No membership change was recorded.";
  if (code === "last_owner") return `${workspaceName?.trim() || "This workspace"} needs at least one owner. Make someone else an owner first.`;
  if (code === "role_forbidden") return "Only an owner can change an owner’s role.";
  if (code === "member_not_found") return `${first} is no longer a member. Reload to check.`;
  if (code === "bad_state") return `${first} already has that role.`;
  if (code === "landing_authority_unresolved") return `${first} approves code changes in this workspace. Hand that to someone else first.`;
  return "The role change was not confirmed. Reload to check.";
}
/** Starts a save for one person. Returns its identity, or null while that person already has a save in flight. */
export function peopleRoleBeginSave(state: PeopleDialogState, userId: string, role: PeopleDialogRole): { role: PeopleDialogRole } | null {
  const pending = state.rolePending ??= new Map();
  if (pending.has(userId)) return null;
  const save = { role }; pending.set(userId, save); return save;
}
/** Ends a save. Returns false when it was superseded, so the caller drops its result. */
export function peopleRoleFinishSave(state: PeopleDialogState, userId: string, save: { role: PeopleDialogRole }): boolean {
  if (state.rolePending?.get(userId) !== save) return false;
  state.rolePending.delete(userId); return true;
}
/** Selects the focus target when it exists. Returns whether a target was applied. */
export function peopleDialogApplyFocus(model: PeopleDialogModel, state: PeopleDialogState, focus: PeopleDialogFocus): boolean {
  const key = `${focus.kind}:${focus.id}`;
  if (state.focusApplied === key) return false;
  if (focus.kind === "person") { if (!model.people.some((person) => person.id === focus.id)) return false; state.collapsed.delete(focus.id); }
  else { const agent = model.agents.find((candidate) => candidate.id === focus.id); if (!agent) return false; state.collapsed.delete(agent.ownerId); }
  state.selected = { type: focus.kind, id: focus.id }; state.focusApplied = key; return true;
}
const validTint = (value: unknown): value is 0 | 1 | 2 | 3 => value === 0 || value === 1 || value === 2 || value === 3;

/** An agent avatar shows the first letter of its name as written (the canvas shows "C", "d"), as the rail does. */
const letters = (name: string) => Array.from(name.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "C";
const personLetters = (name: string) => name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toLocaleUpperCase();
function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string) {
  const element = doc.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(doc: Document, text: string, click: (button: HTMLButtonElement) => void, className = "pd-text-button") {
  const element = node(doc, "button", className, text); element.type = "button";
  element.addEventListener("click", () => click(element)); return element;
}
function icon(doc: Document, kind: "close" | "back" | "invite") {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", kind === "back" ? "pd-icon pd-back-icon" : "pd-icon");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind === "close" ? "M6 6l12 12M18 6L6 18" : kind === "back" ? "M14 6l-6 6 6 6" : "M4 6h16v12H4zM4 7l8 6 8-6");
  svg.append(path); return svg;
}
/** No tint (null) is the neutral square of an agent whose owner left. */
function orb(doc: Document, agent: PeopleDialogAgent, tint: number | null) {
  const element = node(doc, "span", "pd-orb", letters(agent.name));
  if (tint !== null) element.dataset.tint = String(tint); element.setAttribute("aria-hidden", "true"); return element;
}
/** The page's 16px back chevron (canvas Members: stroke 1.8). */
function chevron(doc: Document) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "pd-page-back-icon"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M10 3L5 8l5 5"); svg.append(path); return svg;
}
/** A same-page link: a real href, handled in place when the page gives `navigate`. */
function link(doc: Document, text: string, href: string, className: string, navigate?: (href: string, event: MouseEvent) => void) {
  const element = node(doc, "a", className, text); element.href = href;
  if (navigate) element.addEventListener("click", (event) => { if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(href, event); });
  return element;
}
/** A person's avatar wears their colour (home-names personTint): the viewer blue, everyone else by id. */
function hue(face: HTMLElement, person: PeopleDialogPerson) {
  const tint = personTint(person.id, person.own); if (tint !== null) face.dataset.hue = String(tint); return face;
}
/** The measured status as a pill with a shape: active is the working dot, needs attention the offline diamond, the rest a hollow ring. */
function chip(doc: Document, status: PeopleAgentStatus) {
  const element = node(doc, "span", "pd-status");
  const shape = node(doc, "span", "pd-status-shape"); shape.setAttribute("aria-hidden", "true");
  shape.dataset.shape = status.attention ? "diamond" : status.kind === "active" ? "dot" : "ring";
  element.append(shape, node(doc, "span", "", status.label));
  element.dataset.agentStatus = status.kind; element.dataset.attention = String(status.attention); return element;
}

/** Real DOM builder. User text is always textContent or an input value, never HTML. */
export function renderPeopleDialog(root: HTMLElement, detail: HTMLElement, model: PeopleDialogModel, state: PeopleDialogState, callbacks: PeopleDialogCallbacks, options: PeopleDialogOptions = {}): void {
  const doc = root.ownerDocument;
  if (options.focus) peopleDialogApplyFocus(model, state, options.focus);
  const page = options.layout === "page"; state.layout = page ? "page" : "dialog";
  const tintOf = (agent: PeopleDialogAgent) => { if (!options.tintFor) return model.agents.indexOf(agent) % 4; const tint = options.tintFor(agent.id); return validTint(tint) ? tint : null; };
  const active = doc.activeElement as HTMLElement | null;
  const refocusPrincipal = active?.closest<HTMLElement>("[data-agent-row]")?.dataset.agentRow;
  const focusKey = active && (root.contains(active) || detail.contains(active)) ? active.dataset.pdFocus : undefined;
  const focusWithinDetail = !!active && detail.contains(active);
  const oldEditor = detail.querySelector<HTMLFormElement>("[data-model-editor]");
  const draft = oldEditor ? { id: oldEditor.dataset.modelEditor, value: oldEditor.querySelector<HTMLInputElement>("input")?.value } : null;
  root.replaceChildren(); detail.replaceChildren();
  const outer = root.closest<HTMLDialogElement>("[data-roster-dialog]");
  // Page layout: header, then the roster column and a side column. `host` takes what the dialog puts in `root`.
  let host: HTMLElement = root; let pageRoot: HTMLElement | null = null; let side: HTMLElement | null = null;
  if (page) {
    const nav = options.page ?? { homeLabel: model.workspaceName ?? "", homeHref: "" };
    pageRoot = node(doc, "section", "pd-page"); pageRoot.dataset.peoplePage = ""; pageRoot.setAttribute("aria-labelledby", "pd-page-title");
    const head = node(doc, "header", "pd-page-head");
    const backLink = link(doc, "", nav.homeHref || "#", "pd-page-back", nav.back ? undefined : nav.navigate);
    if (nav.back) backLink.addEventListener("click", (event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); nav.back?.(event); });
    backLink.dataset.pdFocus = "page-back"; backLink.append(chevron(doc), node(doc, "span", "", nav.homeLabel || "Back"));
    const titleRow = node(doc, "div", "pd-page-title-row");
    const title = node(doc, "h1", "", nav.homeLabel ? `People & agents in ${nav.homeLabel}` : "People & agents"); title.id = "pd-page-title"; title.tabIndex = -1;
    const actions = node(doc, "div", "pd-page-actions");
    if (nav.invite && !model.sample && model.people.some((person) => person.own && person.role !== "member")) {
      const invite = button(doc, "Invite someone", () => nav.invite?.(), "pd-page-primary"); invite.dataset.peoplePageInvite = ""; invite.dataset.pdFocus = "page-invite"; actions.append(invite);
    }
    if (nav.addAgentHref && !model.sample) { const add = link(doc, "Add an agent", nav.addAgentHref, "pd-page-secondary", nav.navigate); add.dataset.peoplePageAddAgent = ""; add.dataset.pdFocus = "page-add-agent"; actions.append(add); }
    titleRow.append(title); if (actions.childElementCount) titleRow.append(actions);
    head.append(backLink, titleRow);
    if (nav.onQuery && (state.query || model.people.length + model.agents.length > 10)) {
      const search = node(doc, "input", "dashboard__roster-dialog-search pd-page-search"); search.type = "search"; search.value = state.query;
      search.setAttribute("aria-label", "Filter people and agents"); search.placeholder = "Find a person or agent…"; search.autocomplete = "off"; search.spellcheck = false;
      search.dataset.pdFocus = "page-search"; search.addEventListener("input", () => nav.onQuery?.(search.value)); head.append(search);
    }
    const columns = node(doc, "div", "pd-page-columns"); host = node(doc, "div", "pd-page-main"); side = node(doc, "div", "pd-page-side");
    columns.append(host, side); pageRoot.append(head, columns); root.append(pageRoot);
  }
  const select = (type: "agent" | "person", id: string) => {
    if (type === "agent") { const agent = model.agents.find((candidate) => candidate.id === id); if (agent) state.collapsed.delete(agent.ownerId); }
    state.selected = state.selected?.id === id && state.selected.type === type ? null : { type, id };
    callbacks.render(); detail.scrollTop = 0;
    if (page && state.selected) detail.scrollIntoView?.({ block: "nearest" });
    (state.selected ? detail.querySelector<HTMLElement>("h2") : doc.getElementById(`pd-${type}-${id}`))?.focus({ preventScroll: true });
  };
  const back = () => { const selected = state.selected; state.selected = null; callbacks.render();
    if (selected) (doc.getElementById(`pd-${selected.type}-${selected.id}`) ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title") ?? pageRoot?.querySelector<HTMLElement>("#pd-page-title"))?.focus({ preventScroll: true }); };
  const actionButton = (action: PeopleDialogAction, agent: PeopleDialogAgent, text: string, notice: HTMLElement, hook?: string) => {
    const element = button(doc, text, (opener) => {
      if (!peopleDialogCanAct(model, action, agent.id)) return;
      if (["remove-agent", "turn-off-key", "withdraw"].includes(action)) callbacks.confirm(action as PeopleConfirmAction, agent.id, opener);
      else void callbacks.action(action, agent.id, opener, notice);
    }, ["remove-agent", "turn-off-key"].includes(action) ? "pd-danger-button" : "pd-text-button");
    if (hook) element.setAttribute(hook, agent.id);
    element.dataset.pdFocus = `${action}-${agent.id}`; return element;
  };
  const noticeFor = (agent: PeopleDialogAgent) => {
    const notice = node(doc, "p", "pd-receipt", agent.receipt); notice.dataset.agentContentResult = "";
    notice.setAttribute("role", "status"); notice.hidden = !agent.receipt; return notice;
  };
  const fix = (agent: PeopleDialogAgent, notice: HTMLElement, summary = false) => {
    if (model.sample) return null;
    if (agent.status.fix.allowed && ["resume", "new-key"].includes(agent.status.fix.action ?? ""))
      return actionButton(agent.status.fix.action as "resume" | "new-key", agent, agent.status.fix.action === "resume" ? "Resume" : "Get a new key", notice,
        agent.status.fix.action === "new-key" ? "data-get-agent-prompt" : "data-resume-agent");
    return summary ? button(doc, "What to do", () => select("agent", agent.id)) : null;
  };
  const refocusRole = (personId: string, key: string) => {
    // The page layout keeps the role control on the person's card.
    const inline = doc.querySelector<HTMLElement>(`[data-people-page] .pd-person-head [data-pd-focus="${key}"]`); if (inline) { inline.focus({ preventScroll: true }); return; }
    if (state.selected?.type === "person" && state.selected.id === personId)
      (detail.querySelector<HTMLElement>(`[data-pd-focus="${key}"]`) ?? detail.querySelector<HTMLElement>("h2"))?.focus({ preventScroll: true }); };
  // Role: a native select and Save. Lowering your own role asks first, in a native alertdialog. A refusal is shown from its stable code.
  const roleControl = (person: PeopleDialogPerson, roles: PeopleDialogRole[]) => {
    const draft = state.roleDraft?.userId === person.id ? state.roleDraft : null;
    const locked = !!state.rolePending?.has(person.id);
    const holder = node(doc, "div", "hm-role");
    const commit = async (next: PeopleDialogRole) => {
      if (!callbacks.changeRole) return;
      const save = peopleRoleBeginSave(state, person.id, next); if (!save) return;
      if (state.roleReceipt?.userId === person.id) state.roleReceipt = null;
      if (state.roleRefusal?.userId === person.id) state.roleRefusal = null;
      state.roleDraft = { userId: person.id, role: next, confirming: draft?.confirming === true };
      callbacks.render();
      let refusal: string | null = null;
      let freshSignIn = false;
      try { await callbacks.changeRole({ kind: "change-role", userId: person.id, role: next }); }
      catch (error) {
        const code = peopleRoleErrorCode(error);
        freshSignIn = code === "fresh_auth_required";
        refusal = peopleRoleRefusal(code, person.name, model.workspaceName);
      }
      if (!peopleRoleFinishSave(state, person.id, save)) return;
      if (refusal === null) { if (state.roleDraft?.userId === person.id) state.roleDraft = null; state.roleReceipt = { userId: person.id, text: peopleRoleReceipt(person.name, next) }; }
      else {
        state.roleRefusal = { userId: person.id, name: person.name, text: refusal };
        if (state.layout === "page" || (state.selected?.type === "person" && state.selected.id === person.id)) state.roleDraft = { userId: person.id, role: next, confirming: false, error: refusal };
      }
      callbacks.render();
      // The sign-in controls sit outside this pane. Moving focus back to the role select covers them.
      if (freshSignIn) doc.querySelector<HTMLElement>("[data-member-reauth] button")?.focus({ preventScroll: true });
      else refocusRole(person.id, `role-${person.id}`);
    };
    const facts = node(doc, "dl", "pd-fact-sheet"); const row = node(doc, "div", "pd-fact-row");
    const label = node(doc, "dt", "", "Role"); label.id = `pd-role-label-${person.id}`;
    const choose = node(doc, "select", "hm-role-select"); choose.setAttribute("aria-labelledby", label.id); choose.dataset.roleSelect = person.id; choose.dataset.pdFocus = `role-${person.id}`;
    for (const role of roles) { const option = node(doc, "option", "", ROLE_LABELS[role]); option.value = role; choose.append(option); }
    const picked = () => roles.find((role) => role === choose.value) ?? person.role;
    choose.value = draft && roles.includes(draft.role) ? draft.role : person.role; choose.disabled = locked;
    const value = node(doc, "dd"); value.append(choose);
    const refusal = state.roleRefusal?.userId === person.id ? state.roleRefusal.text : null;
    const error = node(doc, "p", "pd-error", refusal ?? undefined); error.dataset.roleError = person.id; error.setAttribute("role", "alert"); error.hidden = !refusal || locked;
    const save = button(doc, locked ? "Saving…" : "Save", () => {
      if (state.rolePending?.has(person.id)) return;
      const next = picked(); if (next === person.role) return;
      if (person.own && peopleRoleSelfConfirmCopy(person.role, next)) { state.roleDraft = { userId: person.id, role: next, confirming: true }; callbacks.render(); }
      else void commit(next);
    }, "pd-text-button"); save.dataset.changeRole = person.id; save.dataset.pdFocus = `save-role-${person.id}`; save.disabled = locked || picked() === person.role;
    if (locked) save.setAttribute("aria-busy", "true");
    choose.addEventListener("change", () => { save.disabled = locked || picked() === person.role; state.roleDraft = { userId: person.id, role: picked(), confirming: false }; if (state.roleRefusal?.userId === person.id) state.roleRefusal = null; error.hidden = true; });
    const action = node(doc, "dd", "pd-fact-action"); action.append(save); row.append(label, value, action); facts.append(row); holder.append(facts, error);
    const copy = draft?.confirming && person.own ? peopleRoleSelfConfirmCopy(person.role, draft.role) : null;
    if (draft && copy) {
      const dialog = node(doc, "dialog", "pd-confirm hm-role-confirm"); dialog.setAttribute("role", "alertdialog"); dialog.dataset.roleConfirm = person.id;
      const question = node(doc, "p", "hm-role-question", copy.question); question.id = `pd-role-confirm-${person.id}`;
      dialog.setAttribute("aria-labelledby", question.id); dialog.setAttribute("aria-describedby", question.id);
      const goBack = () => { if (state.rolePending?.has(person.id)) return; state.roleDraft = { userId: person.id, role: draft.role, confirming: false }; callbacks.render(); refocusRole(person.id, `role-${person.id}`); };
      const cancel = button(doc, "Go back", goBack, "dashboard__button dashboard__button--secondary"); cancel.disabled = locked; cancel.dataset.roleConfirmBack = person.id;
      const accept = button(doc, copy.button, () => void commit(draft.role), "dashboard__button pd-danger-fill"); accept.disabled = locked; accept.dataset.confirmRole = person.id;
      const actions = node(doc, "div", "pd-confirm-actions hm-role-actions"); actions.append(cancel, accept); dialog.append(question, actions);
      dialog.oncancel = (event) => { event.preventDefault(); event.stopPropagation(); goBack(); };
      holder.append(dialog);
    }
    return holder;
  };
  const { groups, other, invites, attention } = peopleDialogGroups(model, state.query);
  // The page keeps attention on each agent's own row (its pill, its sentence and its one next action), not in a summary.
  if (!page && attention.length) {
    const box = node(doc, "section", "pd-attention"); const heading = node(doc, "h3", "", "⚠ Needs attention");
    heading.id = "pd-attention-title"; box.setAttribute("aria-labelledby", heading.id);
    const list = node(doc, "ul", "pd-attention-list"); list.id = "pd-attention-list";
    for (const agent of state.showAllAttention ? attention : attention.slice(0, 3)) {
      const row = node(doc, "li"); const jump = button(doc, "", () => {
        state.collapsed.delete(agent.ownerId); callbacks.render(); const target = doc.getElementById(`pd-agent-${agent.id}`);
        target?.scrollIntoView({ block: "nearest" }); target?.focus({ preventScroll: true });
      }, "pd-attention-jump");
      jump.append(node(doc, "strong", "", agent.name), node(doc, "span", "pd-muted", ` · ${agent.ownerName?.split(/\s+/)[0] ?? "Other agents"} — `), node(doc, "span", "pd-attention-reason", agent.status.label));
      jump.setAttribute("aria-label", `Find ${agent.name}, ${agent.ownerName ?? "Other agents"}: ${agent.status.label}`);
      const next = fix(agent, node(doc, "p"), true); row.append(jump); if (next) row.append(next); list.append(row);
    }
    box.append(heading, list);
    if (attention.length > 3) { const more = button(doc, state.showAllAttention ? "Show fewer" : `Show ${attention.length - 3} more`, () => {
      state.showAllAttention = !state.showAllAttention; callbacks.render(); root.querySelector<HTMLElement>('[data-pd-focus="more-attention"]')?.focus();
    }); more.dataset.pdFocus = "more-attention"; more.setAttribute("aria-expanded", String(state.showAllAttention)); more.setAttribute("aria-controls", list.id); box.append(more); }
    root.append(box);
  }
  if (!page && model.agents.length && !state.query.trim()) {
    const strip = node(doc, "ul", "pd-portraits");
    for (const person of model.people) {
      const agents = model.agents.filter((agent) => agent.ownerId === person.id);
      const entry = node(doc, "li"); const jump = button(doc, "", () => {
        state.collapsed.delete(person.id); callbacks.render(); doc.getElementById(`pd-person-${person.id}`)?.focus();
      }, "pd-portrait");
      const face = hue(node(doc, "span", "pd-initials", personLetters(person.name)), person); face.setAttribute("aria-hidden", "true");
      const needsAttention = agents.some((agent) => agent.status.attention);
      face.dataset.attention = String(needsAttention);
      if (needsAttention) {
        const mark = node(doc, "span", "pd-portrait-warning", "⚠"); mark.setAttribute("aria-hidden", "true"); face.append(mark);
        jump.append(node(doc, "span", "pd-sr-only", "Needs attention. "));
      }
      jump.append(face, node(doc, "strong", "pd-ellipsis", peopleFirstName(person.name)));
      const orbs = node(doc, "span", "pd-portrait-orbs"); agents.slice(0, 4).forEach((agent) => orbs.append(orb(doc, agent, tintOf(agent)))); jump.append(orbs);
      if (agents.length > 4) jump.append(node(doc, "span", "pd-muted", `+${agents.length - 4}`));
      jump.setAttribute("aria-label", `${person.name}, ${person.role}, ${agents.length} agents. ${needsAttention ? "Needs attention. " : ""}${agents.map((agent) => `${agent.name}: ${agent.status.label}`).join("; ")}`);
      entry.append(jump); strip.append(entry);
    }
    root.append(strip);
  }
  if (state.query.trim()) { const shown = groups.reduce((count, group) => count + group.agents.length, other.length);
    const result = node(doc, "p", "pd-muted", `${shown} of ${model.agents.length} agents shown · “${state.query.trim()}”`); result.setAttribute("role", "status"); host.append(result); }
  const grid = node(doc, "div", "pd-member-grid"); grid.dataset.memberList = "";
  const agentRow = (agent: PeopleDialogAgent) => {
    if (page) return pageAgentRow(agent);
    const approved = peopleDialogAccessUntil(agent) !== null && !!agent.access;
    const row = node(doc, "li", "pd-agent"); row.dataset.agentRow = agent.id; row.dataset.attention = String(agent.status.attention);
    const disclosure = button(doc, "", () => select("agent", agent.id), "pd-agent-disclosure"); disclosure.id = `pd-agent-${agent.id}`;
    disclosure.dataset.pdFocus = `agent-${agent.id}`;
    disclosure.setAttribute("aria-expanded", String(state.selected?.type === "agent" && state.selected.id === agent.id)); disclosure.setAttribute("aria-controls", detail.id);
    const secondary = agent.model ?? (agent.hosted ? "In a chat app" : "On a computer");
    disclosure.setAttribute("aria-label", `${agent.name}, ${agent.ownerName ? `${agent.ownerName}’s agent` : "Other agent"}, ${agent.app ? `${agent.app}, ` : ""}${secondary}, ${agent.status.label}${approved ? peopleDialogAccessLabel(agent) : ""}`);
    const copy = node(doc, "span", "pd-agent-copy"); const nameLine = node(doc, "span", "pd-agent-name-line");
    const name = node(doc, "strong", "pd-ellipsis", agent.name); name.title = agent.name; nameLine.append(name);
    if (approved && !agent.hosted) { const mark = node(doc, "span", "pd-access-mark", "▤"); mark.dataset.agentContentAccess = ""; mark.setAttribute("role", "img"); mark.setAttribute("aria-label", "Can use Lists & docs"); mark.title = "Can use Lists & docs"; nameLine.append(mark); }
    copy.append(nameLine, node(doc, "span", "pd-agent-app pd-ellipsis", secondary), chip(doc, agent.status));
    disclosure.append(orb(doc, agent, tintOf(agent)), copy, node(doc, "span", "pd-row-arrow", "›")); row.append(disclosure);
    const notice = noticeFor(agent);
    if (agent.status.attention && !model.sample) { const help = node(doc, "div", "pd-row-help"); help.append(node(doc, "p", "", agent.status.sentence)); const next = fix(agent, notice); if (next) help.append(next); row.append(help); }
    if (state.selected?.id !== agent.id && agent.receipt) row.append(notice);
    const error = node(doc, "p", "pd-error"); error.setAttribute("role", "alert"); error.dataset.agentRowError = agent.id; error.hidden = true; row.append(error); return row;
  };
  // Page row (canvas Members): the name block stays the disclosure (same id, name and controls); the status pill sits on
  // the name line, a problem's sentence replaces the secondary line, and the actions sit on the row: the one fix
  // (Resume / Get a new key) as the Reconnect pill, Manage (the agent page) and Remove (the same confirmation).
  const pageAgentRow = (agent: PeopleDialogAgent) => {
    const approved = peopleDialogAccessUntil(agent) !== null && !!agent.access;
    const row = node(doc, "li", "pd-agent"); row.dataset.agentRow = agent.id; row.dataset.attention = String(agent.status.attention);
    const disclosure = button(doc, "", () => select("agent", agent.id), "pd-agent-disclosure"); disclosure.id = `pd-agent-${agent.id}`;
    disclosure.dataset.pdFocus = `agent-${agent.id}`;
    disclosure.setAttribute("aria-expanded", String(state.selected?.type === "agent" && state.selected.id === agent.id)); disclosure.setAttribute("aria-controls", detail.id);
    const secondary = agent.model ?? (agent.hosted ? "In a chat app" : "On a computer");
    disclosure.setAttribute("aria-label", `${agent.name}, ${agent.ownerName ? `${agent.ownerName}’s agent` : "Other agent"}, ${agent.app ? `${agent.app}, ` : ""}${secondary}, ${agent.status.label}${approved ? peopleDialogAccessLabel(agent) : ""}`);
    const copy = node(doc, "span", "pd-agent-copy"); const nameLine = node(doc, "span", "pd-agent-name-line");
    const name = node(doc, "strong", "pd-ellipsis", agent.name); name.title = agent.name; nameLine.append(name);
    nameLine.append(chip(doc, agent.status));
    const sentence = agent.status.attention && !model.sample ? agent.status.sentence : "";
    const details = node(doc, "span", "pd-agent-app", sentence || [agent.app, secondary].filter(Boolean).join(" · "));
    // The canvas row draws no Lists & docs glyph: the disclosure's accessible name above carries "Can use Lists & docs" (the hosted note for a hosted agent),
    // and the agent's details (the side card) show the Lists & docs fact.
    copy.append(nameLine, details);
    disclosure.append(orb(doc, agent, tintOf(agent)), copy); row.append(disclosure);
    const notice = noticeFor(agent);
    const actions = node(doc, "span", "pd-agent-actions");
    const next = agent.status.attention ? fix(agent, notice) : null;
    if (next) { next.classList.add("pd-reconnect"); next.setAttribute("aria-label", `${next.textContent}: ${agent.name}`); actions.append(next); }
    const agentHref = options.page?.agentHref;
    // A row with a fix shows that one action, as the canvas does for a disconnected agent; its name still opens every detail.
    if (agentHref && agent.mayManage && !model.sample && !next) { const manage = link(doc, "Manage", agentHref(agent.id), "pd-pill-link", options.page?.navigate);
      manage.setAttribute("aria-label", `Manage ${agent.name}`); manage.dataset.pdFocus = `manage-${agent.id}`; actions.append(manage); }
    if (peopleDialogCanAct(model, "remove-agent", agent.id)) { const remove = actionButton("remove-agent", agent, "Remove", notice);
      remove.className = "pd-text-button"; remove.setAttribute("aria-label", `Remove ${agent.name}`); remove.dataset.pdFocus = `row-remove-agent-${agent.id}`; actions.append(remove); }
    if (actions.childElementCount) row.append(actions);
    if (state.selected?.id !== agent.id && agent.receipt) row.append(notice);
    const error = node(doc, "p", "pd-error"); error.setAttribute("role", "alert"); error.dataset.agentRowError = agent.id; error.hidden = true; row.append(error); return row;
  };
  // Page head (canvas Members): the person button keeps its id, controls and accessible name (name, then role); the role
  // words inside it are screen-reader text, and the role shows at the right as the role control or a quiet pill.
  const pageHead = (person: PeopleDialogPerson, agents: PeopleDialogAgent[], head: HTMLElement, personButton: HTMLButtonElement, roleText: HTMLElement) => {
    roleText.classList.add("pd-sr-only");
    const nameText = personButton.querySelector(".pd-person-name");
    if (person.own && nameText) { const you = node(doc, "span", "pd-you", "you"); you.setAttribute("aria-hidden", "true"); nameText.after(you); }
    const count = node(doc, "span", "pd-person-sub", agents.length ? `${agents.length} ${agents.length === 1 ? "agent" : "agents"}` : "No agents added yet"); count.setAttribute("aria-hidden", "true");
    roleText.after(count);
    const roles = callbacks.changeRole ? peopleDialogRoleOptions(model, person.id) : [];
    if (roles.length) { const control = roleControl(person, roles); control.dataset.own = String(person.own);
      const label = control.querySelector("dt"); if (label) { label.textContent = `${peopleFirstName(person.name)}’s role`; label.className = "pd-sr-only"; }
      head.append(control); }
    else { const pill = node(doc, "span", "pd-role-pill", ROLE_LABELS[person.role]); pill.setAttribute("aria-hidden", "true"); pill.dataset.role = person.role; head.append(pill); }
    if (peopleDialogCanAct(model, "remove-person", person.id)) {
      const remove = button(doc, "Remove", (opener) => callbacks.confirm("remove-person", person.id, opener), "pd-danger-button"); remove.setAttribute("aria-label", `Remove ${person.name}`);
      remove.dataset.removeMember = person.id; remove.dataset.pdFocus = `remove-person-${person.id}`; head.append(remove); }
  };
  const card = (person: PeopleDialogPerson | null, agents: PeopleDialogAgent[]) => {
    const element = node(doc, "section", "pd-member-card"); const head = node(doc, "div", "pd-person-head");
    if (person) {
      const personButton = button(doc, "", () => select("person", person.id), "pd-person-disclosure"); personButton.id = `pd-person-${person.id}`; personButton.dataset.pdFocus = `person-${person.id}`;
      personButton.setAttribute("aria-expanded", String(state.selected?.type === "person" && state.selected.id === person.id)); personButton.setAttribute("aria-controls", detail.id);
      const face = hue(node(doc, "span", "pd-initials", personLetters(person.name)), person); face.setAttribute("aria-hidden", "true");
      const copy = node(doc, "span", "pd-person-copy"); const name = node(doc, "strong", "pd-person-name", person.name); name.title = person.name;
      const roleText = node(doc, "span", "pd-muted", `${person.role[0].toUpperCase()}${person.role.slice(1)}${person.own ? " · You" : ""}`);
      copy.append(name, roleText); personButton.append(face, copy); head.append(personButton);
      if (page) pageHead(person, agents, head, personButton, roleText);
      else if (agents.length) { const toggle = button(doc, state.collapsed.has(person.id) ? "›" : "⌄", () => { state.collapsed.has(person.id) ? state.collapsed.delete(person.id) : state.collapsed.add(person.id); callbacks.render();
        root.querySelector<HTMLElement>(`[data-pd-focus="collapse-${person.id}"]`)?.focus(); }, "pd-collapse");
        toggle.dataset.pdFocus = `collapse-${person.id}`; toggle.setAttribute("aria-label", `${state.collapsed.has(person.id) ? "Show" : "Hide"} ${person.name}’s agents`);
        toggle.setAttribute("aria-expanded", String(!state.collapsed.has(person.id))); toggle.setAttribute("aria-controls", `pd-group-${person.id}`); head.append(toggle); }
    } else {
      const face = node(doc, "span", "pd-initials pd-neutral-avatar"); face.setAttribute("aria-hidden", "true");
      const copy = node(doc, "div", "pd-person-copy");
      copy.append(node(doc, "h3", "pd-person-name", "Other agents"), node(doc, "span", "pd-muted", "Their owner is no longer a member"));
      head.append(face, copy);
    }
    element.append(head);
    if (page && person && state.roleReceipt?.userId === person.id) { const done = node(doc, "p", "pd-receipt", state.roleReceipt.text); done.dataset.roleReceipt = ""; done.setAttribute("role", "status"); element.append(done); }
    const list = node(doc, "ul", "pd-agents-list"); if (person) list.id = `pd-group-${person.id}`;
    list.hidden = !page && !!person && state.collapsed.has(person.id); agents.forEach((agent) => list.append(agentRow(agent))); element.append(list);
    if (!agents.length) { const none = node(doc, "p", "pd-empty-person", "No agents added yet."); if (page) none.classList.add("pd-sr-only"); element.append(none); } return element;
  };
  if (model.agents.length || state.query.trim() || model.people.length > 1) groups.forEach(({ person, agents }) => grid.append(card(person, agents)));
  if (other.length) grid.append(card(null, other));
  if (!model.agents.length && !state.query.trim()) {
    const empty = node(doc, "section", "pd-empty"); const art = node(doc, "div", "pd-empty-art"); art.setAttribute("aria-hidden", "true");
    art.append(node(doc, "span", "pd-orbit"), node(doc, "span", "pd-initials", personLetters(model.people.find((person) => person.own)?.name ?? "Common Swarm")));
    for (let index = 0; index < 4; index++) { const ball = node(doc, "span", "pd-orb"); ball.dataset.tint = String(index); art.append(ball); }
    empty.append(art, node(doc, "h3", "", model.people.length <= 1 ? "It’s just you so far" : "A place for your agents, too"), node(doc, "p", "pd-muted", model.sample ? "People and their agents share a space here. Each agent has its own access to Lists & docs." : model.people.some((person) => person.own && person.role !== "member") ? "Add the agents you already use, and invite the people you share this space with." : "Add your first agent from an app you already use.")); const apps = node(doc, "div", "pd-app-chips"); apps.setAttribute("aria-label", "Apps that can join");
    AGENT_HOSTS.filter((host) => host.joiner === "primary").forEach((host) => apps.append(node(doc, "span", "", host.name))); empty.append(apps); grid.append(empty);
  }
  if (!groups.length && !other.length && !invites.length && state.query.trim()) { const empty = node(doc, "p", "pd-muted", "No people, agents or invitations match. Try another name."); empty.setAttribute("role", "status"); grid.append(empty); }
  host.append(grid);
  // Invited remains the same server-derived pending set, with plain presentation.
  const invited = node(doc, "section", "dashboard__roster-dialog-pending pd-invited"); invited.dataset.dialogAccessSection = "";
  invited.hidden = model.sample || (!invites.length && !model.pendingFailed); invited.setAttribute("aria-labelledby", "dashboard-roster-pending-title");
  const invitedTitle = node(doc, "h3", "pd-muted", "Invited · "); invitedTitle.id = "dashboard-roster-pending-title"; invitedTitle.tabIndex = -1;
  const count = node(doc, "span", "", String(invites.length)); count.dataset.dialogAccessCount = ""; invitedTitle.append(count);
  const inviteList = node(doc, "ul", "pd-invite-list"); inviteList.dataset.dialogAccessList = "";
  for (const invite of invites) {
    const row = node(doc, "li", "pd-invite"); const symbol = node(doc, "span", "pd-invite-symbol", invite.kind === "invite" ? undefined : "↗"); symbol.setAttribute("aria-hidden", "true");
    if (invite.kind === "invite") symbol.append(icon(doc, "invite"));
    const copy = node(doc, "span", "pd-agent-copy"); const name = node(doc, "strong", "pd-ellipsis", invite.kind === "agent" ? `Key for ${invite.name} not used yet` : invite.name); name.title = name.textContent ?? "";
    copy.append(name, node(doc, "span", "pd-muted", invite.detail)); row.append(symbol, copy);
    if (peopleDialogCanAct(model, "cancel-invite", invite.id)) { const cancel = button(doc, "Cancel", (opener) => callbacks.confirm("cancel-invite", invite.id, opener));
      cancel.dataset.pendingKind = invite.kind; cancel.dataset.pendingId = invite.id; cancel.dataset.pdFocus = `pending-${invite.kind}-${invite.id}`; cancel.setAttribute("aria-label", `Cancel ${invite.kind === "invite" ? "invite" : "unused key"} for ${invite.name}`); row.append(cancel); }
    inviteList.append(row);
  }
  const load = node(doc, "p", "pd-muted", "Invited: could not load"); load.dataset.pendingLoadNote = ""; load.hidden = !model.pendingFailed;
  const inviteError = node(doc, "p", "pd-error"); inviteError.dataset.dialogAccessError = ""; inviteError.setAttribute("role", "alert"); inviteError.hidden = true;
  invited.append(invitedTitle, inviteList, load, inviteError); host.append(invited);
  if (page && side) {
    // What removal does, from the confirmations' own facts. Nothing here claims what someone can see.
    host.append(node(doc, "p", "pd-page-note", "Removing a person or an agent cannot be undone. Their history stays here."));
    side.append(detail);
    const roles = node(doc, "section", "pd-side-card pd-roles"); const rolesTitle = node(doc, "h2", "", "Roles"); rolesTitle.id = "pd-roles-title"; roles.setAttribute("aria-labelledby", rolesTitle.id);
    const list = node(doc, "dl", "pd-roles-list");
    // From the enforced rules: peopleDialogRoleOptions, remove-person (mayRemove) and agent management (mayManage).
    for (const [term, text] of [["Owner", "manages people and agents, and can change anyone’s role."], ["Admin", "manages people and agents, except owners."],
      ["Member", "posts here and manages their own agents."], ["Agent", "belongs to the person who added it. They, an owner or an admin can remove it."]]) {
      const entry = node(doc, "div"); entry.append(node(doc, "dt", "", term), node(doc, "dd", "", text)); list.append(entry);
    }
    roles.append(rolesTitle, list); side.append(roles);
  }

  if (!page && state.roleReceipt && (state.selected?.type !== "person" || state.roleReceipt.userId !== state.selected.id)) {
    const receipt = node(doc, "p", "pd-receipt", state.roleReceipt.text);
    receipt.dataset.roleReceipt = ""; receipt.setAttribute("role", "status"); root.append(receipt);
  }
  if (!page && state.roleRefusal && (state.selected?.type !== "person" || state.roleRefusal.userId !== state.selected.id)) {
    const refusal = node(doc, "p", "pd-error", `${state.roleRefusal.name}: ${state.roleRefusal.text}`);
    refusal.dataset.roleError = state.roleRefusal.userId; refusal.setAttribute("role", "alert"); root.append(refusal);
  }
  if (!page && state.roleDraft && (state.selected?.type !== "person" || state.roleDraft.userId !== state.selected.id)) state.roleDraft = null;
  const selected = state.selected?.type === "agent" ? model.agents.find((agent) => agent.id === state.selected?.id) : model.people.find((person) => person.id === state.selected?.id);
  if (!selected) state.selected = null;
  detail.hidden = !state.selected; outer?.classList.toggle("has-detail", !!state.selected); pageRoot?.classList.toggle("has-detail", !!state.selected);
  if (state.selected && selected) {
    const top = node(doc, "div", "pd-detail-top");
    const backButton = button(doc, "", back, "pd-text-button pd-back");
    backButton.append(icon(doc, "back"), node(doc, "span", "", "Back to everyone"));
    const closeButton = button(doc, "", back, "pd-close-detail"); closeButton.append(icon(doc, "close"));
    // The page shows everyone beside the details, so it keeps only Close.
    closeButton.setAttribute("aria-label", `Close ${selected.name} details`); if (!page) top.append(backButton); top.append(closeButton); detail.append(top);
    const title = node(doc, "h2", "", selected.name); title.id = "pd-detail-title"; title.tabIndex = -1;
    const identity = node(doc, "div", "pd-detail-identity");
    if (state.selected.type === "agent") {
      const agent = selected as PeopleDialogAgent; identity.append(orb(doc, agent, tintOf(agent)));
      const copy = node(doc, "div"); copy.append(title, node(doc, "p", "pd-muted", agent.ownerName ? `${agent.ownerName.split(/\s+/)[0]}’s agent` : "Other agent"), chip(doc, agent.status)); identity.append(copy); detail.append(identity);
      const notice = noticeFor(agent); detail.append(notice);
      if (!agent.mayManage && !model.sample) detail.append(node(doc, "p", "pd-permission-note", `${agent.ownerName?.split(/\s+/)[0] ?? "The space owner or an admin"} manages this agent.`));
      if (agent.status.attention && !model.sample) { const guidance = node(doc, "section", "pd-guidance"); guidance.append(node(doc, "h3", "", "What to do"), node(doc, "p", "", agent.status.sentence)); const next = fix(agent, notice); if (next) guidance.append(next); detail.append(guidance); }
      const facts = node(doc, "dl", "pd-fact-sheet");
      const fact = (label: string, value: string, action?: HTMLElement) => { const row = node(doc, "div", "pd-fact-row"); row.append(node(doc, "dt", "", label), node(doc, "dd", "", value));
        if (action) { const holder = node(doc, "dd", "pd-fact-action"); holder.append(action); row.append(holder); } facts.append(row); };
      if (agent.app) fact("App", agent.app);
      const edit = agent.mayManage && !model.sample ? button(doc, "Change", () => {
        if (detail.querySelector("[data-model-editor]")) return;
        const editor = buildAgentModelEditor(doc, { agentName: agent.name, currentModel: agent.model,
          onCancel: () => { editor.remove(); edit?.focus(); }, onSave: async (modelValue) => {
            try { await callbacks.saveModel(agent.id, modelValue);
              if (state.selected?.type === "agent" && state.selected.id === agent.id) {
                detail.querySelector(`[data-model-editor]`)?.remove();
                detail.querySelector<HTMLElement>("[data-edit-model]")?.focus({ preventScroll: true });
              }
            }
            catch { const error = detail.querySelector<HTMLElement>("[data-agent-error]"); if (error) { error.textContent = "The model change was not confirmed. Reload to check."; error.hidden = false; } }
          } });
        const label = node(doc, "label", "", `Model for ${agent.name} · Leave empty to clear`); const input = editor.querySelector("input"); if (input) { input.id = "pd-model-input"; input.dataset.pdFocus = `model-${agent.id}`; label.htmlFor = input.id; input.placeholder = "Leave empty to clear"; } editor.prepend(label);
        editor.classList.add("pd-model-form"); editor.dataset.modelEditor = agent.id;
        const save = editor.querySelector<HTMLButtonElement>('button[type="submit"]'); if (save) save.dataset.pdFocus = `save-model-${agent.id}`;
        const cancel = editor.querySelector<HTMLButtonElement>('button[type="button"]'); if (cancel) cancel.dataset.pdFocus = `cancel-model-${agent.id}`;
        facts.after(editor); input?.focus();
      }) : undefined;
      if (edit) { edit.dataset.editModel = agent.id; edit.dataset.pdFocus = `edit-${agent.id}`; }
      fact("Model", agent.model ?? "Not set", edit); fact("Messages", agent.receive ?? "Message checks have not been reported."); fact("Last active", agent.lastActive);
      const accessFact = peopleDialogAccessUntil(agent);
      if (accessFact !== null) {
        const accessAction = peopleDialogCanAct(model, "withdraw", agent.id) ? actionButton("withdraw", agent, "Withdraw", notice, "data-withdraw-agent-access") : peopleDialogCanAct(model, "allow", agent.id) ? actionButton("allow", agent, "Allow…", notice) : undefined;
        accessAction?.classList.add("pd-quiet-link"); fact("Lists & docs", accessFact, accessAction);
      }
      if (agent.key !== null) fact("Key", agent.key, peopleDialogCanAct(model, "new-key", agent.id) ? actionButton("new-key", agent, "New key", notice, "data-get-agent-prompt") : undefined);
      detail.append(facts);
      if (agent.updateAvailable) detail.append(node(doc, "p", "pd-muted", "Update available."));
      if (agent.status.kind === "inactive" && agent.hosted && !model.sample) detail.append(node(doc, "p", "pd-muted", "Open the chat app you use it in and say: check CommonSwarm."));
      if (agent.hosted && peopleDialogCanAct(model, "connected-apps", agent.id)) { const connection = node(doc, "p", "pd-connection-note"); connection.append(actionButton("connected-apps", agent, "Connected apps →", notice), node(doc, "span", "", "Disconnecting its app ends access for every agent from that app.")); detail.append(connection); }
      const technical = node(doc, "details", "pd-technical"); technical.append(node(doc, "summary", "", "Technical details"));
      for (const value of agent.technical) { const fact = node(doc, "p", "", value);
        if (agent.grantRisk && value === agent.grantRisk) fact.dataset.grantRisk = agent.grantRisk;
        technical.append(fact);
      } detail.append(technical);
      if (agent.mayManage && !model.sample) { const danger = node(doc, "section", "pd-danger-zone"); danger.append(node(doc, "h3", "", "Stop or remove")); const actions = node(doc, "div", "pd-danger-actions");
        if (peopleDialogCanAct(model, "turn-off-key", agent.id)) actions.append(actionButton("turn-off-key", agent, `Turn off key for ${agent.name}`, notice, "data-revoke-grant"));
        actions.append(actionButton("remove-agent", agent, `Remove ${agent.name}`, notice, "data-remove-agent")); danger.append(actions); detail.append(danger); }
      const error = node(doc, "p", "pd-error"); error.dataset.agentError = ""; error.setAttribute("role", "alert"); error.hidden = true; detail.append(error);
    } else {
      const person = selected as PeopleDialogPerson; identity.append(hue(node(doc, "span", "pd-initials", personLetters(person.name)), person), title, node(doc, "p", "pd-muted", `${person.role[0].toUpperCase()}${person.role.slice(1)}${person.own ? " · You" : ""}`)); detail.append(identity);
      if (!page && state.roleReceipt?.userId === person.id) { const done = node(doc, "p", "pd-receipt", state.roleReceipt.text); done.dataset.roleReceipt = ""; done.setAttribute("role", "status"); detail.append(done); }
      const roles = callbacks.changeRole && !page ? peopleDialogRoleOptions(model, person.id) : [];
      if (roles.length) { const control = roleControl(person, roles); detail.append(control);
        const confirm = control.querySelector<HTMLDialogElement>("dialog[data-role-confirm]");
        if (confirm && !confirm.open) { confirm.showModal(); (confirm.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? confirm).focus({ preventScroll: true }); } }
      detail.append(node(doc, "h3", "pd-section-title", "Agents in this space")); const agents = model.agents.filter((agent) => agent.ownerId === person.id);
      const list = node(doc, "ul", "pd-person-agents"); agents.forEach((agent) => { const entry = node(doc, "li"); entry.append(button(doc, agent.name, () => select("agent", agent.id))); list.append(entry); }); detail.append(list);
      if (!agents.length) detail.append(node(doc, "p", "pd-muted", "No agents added yet."));
      if (!page && peopleDialogCanAct(model, "remove-person", person.id)) { const danger = node(doc, "section", "pd-danger-zone"); danger.append(node(doc, "h3", "", "Membership"));
        const remove = button(doc, `Remove ${person.name}`, (opener) => callbacks.confirm("remove-person", person.id, opener), "pd-danger-button"); remove.dataset.removeMember = person.id; remove.dataset.pdFocus = `remove-person-${person.id}`; danger.append(remove); detail.append(danger); }
    }
  }
  if (draft?.id && state.selected?.type === "agent" && state.selected.id === draft.id) {
    const edit = detail.querySelector<HTMLButtonElement>("[data-edit-model]");
    edit?.click(); const input = detail.querySelector<HTMLInputElement>("[data-model-editor] input");
    if (input && draft.value !== undefined) input.value = draft.value;
    if (active?.isConnected && !focusWithinDetail && !root.contains(active)) active.focus({ preventScroll: true });
  }
  if (page) { const confirm = root.querySelector<HTMLDialogElement>("dialog[data-role-confirm]");
    if (confirm && !confirm.open && confirm.isConnected) { confirm.showModal(); (confirm.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? confirm).focus({ preventScroll: true }); } }
  if (focusKey && !(page ? root : detail).querySelector("dialog[open]")) { const target = [...(focusWithinDetail ? detail : root).querySelectorAll<HTMLElement>("[data-pd-focus]")].find((element) => element.dataset.pdFocus === focusKey);
    (target ?? (focusWithinDetail ? detail.querySelector<HTMLElement>("h2") : doc.getElementById(`pd-agent-${refocusPrincipal}`)) ?? outer?.querySelector<HTMLElement>("[data-add-agent-dialog]") ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title") ?? pageRoot?.querySelector<HTMLElement>("#pd-page-title"))?.focus({ preventScroll: true });
    if (page && doc.activeElement instanceof HTMLInputElement && doc.activeElement.type === "search") { const end = doc.activeElement.value.length; doc.activeElement.setSelectionRange(end, end); } }
}

/** Native nested confirm, with its own Escape and a safe initial focus. */
export function showPeopleConfirmation(dialog: HTMLDialogElement, action: PeopleConfirmAction,
  item: { name: string; hosted?: boolean; kind?: string; liveKey?: boolean }, opener: HTMLElement,
  commit: (button: HTMLButtonElement, notice: HTMLElement) => Promise<void>,
  formatError: (error: unknown) => string, alternative?: () => void, focusAfterCommit?: () => void): void {
  const doc = dialog.ownerDocument; const copy = peopleConfirmationCopy(action, item);
  dialog.replaceChildren(); dialog.setAttribute("role", "alertdialog"); dialog.setAttribute("aria-labelledby", "pd-confirm-title"); dialog.setAttribute("aria-describedby", "pd-confirm-description");
  const symbol = node(doc, "span", "pd-confirm-icon", action === "withdraw" ? "▤" : "⚠"); symbol.setAttribute("aria-hidden", "true");
  const title = node(doc, "h2", "", copy.title); title.id = "pd-confirm-title";
  const facts = node(doc, "ul", "pd-confirm-facts"); facts.id = "pd-confirm-description";
  // A2 keeps the stop/stay sequence readable, with text alternatives for the dots.
  const addFact = (text: string, keep: boolean) => { const row = node(doc, "li", keep ? "keep" : "stop"); row.append(node(doc, "span", "pd-sr-only", keep ? "Stays or can be restored: " : "Stops or cannot be undone: "), node(doc, "span", "", text)); facts.append(row); };
  copy.stops.forEach((text, index) => { addFact(text, false); if (copy.stays[index]) addFact(copy.stays[index]!, true); });
  copy.stays.slice(copy.stops.length).forEach((text) => addFact(text, true)); dialog.append(symbol, title, facts);
  if (action === "remove-agent" && item.liveKey && alternative) { const option = node(doc, "section", "pd-alternative"); option.append(node(doc, "h3", "", "Would turning off the key be enough?"), node(doc, "p", "", `Keep ${item.name} and its history here. It stops when its current access ends; a new key can bring it back.`), button(doc, "Turn off key instead →", () => alternative())); dialog.append(option); }
  const notice = node(doc, "p", "pd-error"); notice.setAttribute("role", "alert"); notice.hidden = true;
  let pending = false;
  // The page layout has no outer dialog: its host is the current People & agents page (a render replaces the element).
  const pageHost = () => dialog.closest("[data-roster-dialog]") ? null : doc.querySelector<HTMLElement>("[data-people-page]");
  const close = () => { if (pending) return; dialog.close();
    const outer = dialog.closest<HTMLDialogElement>("[data-roster-dialog]");
    const fallback = outer?.querySelector<HTMLElement>("#pd-detail-title") ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title")
      ?? pageHost()?.querySelector<HTMLElement>("#pd-detail-title") ?? pageHost()?.querySelector<HTMLElement>("#pd-page-title");
    if (opener.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true }); else fallback?.focus({ preventScroll: true }); };
  const actions = node(doc, "div", "pd-confirm-actions"); const cancel = button(doc, "Go back", close, "dashboard__button dashboard__button--secondary");
  const accept = button(doc, copy.button, async () => {
    pending = true; notice.hidden = true;
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].forEach((control) => control.disabled = true);
    try { await commit(accept, notice); if (dialog.open) dialog.close();
      const outer = dialog.closest<HTMLDialogElement>("[data-roster-dialog]");
      if (outer?.open) {
        if (focusAfterCommit) focusAfterCommit();
        else (outer.querySelector<HTMLElement>("#pd-detail-title") ?? outer.querySelector<HTMLElement>("#dashboard-roster-title"))?.focus({ preventScroll: true });
      } else if (!outer) { const host = pageHost();
        if (host && focusAfterCommit) focusAfterCommit();
        else (host?.querySelector<HTMLElement>("#pd-detail-title") ?? host?.querySelector<HTMLElement>("#pd-page-title"))?.focus({ preventScroll: true }); }
    }
    catch (error) { notice.hidden = false; notice.textContent = formatError(error); }
    finally { pending = false; [...dialog.querySelectorAll<HTMLButtonElement>("button")].forEach((control) => control.disabled = false); }
  }, action === "withdraw" ? "dashboard__button dashboard__button--primary" : "dashboard__button pd-danger-fill");
  actions.append(cancel, accept); dialog.append(notice, actions);
  dialog.oncancel = (event) => { event.preventDefault(); event.stopPropagation(); close(); };
  if (!dialog.open) dialog.showModal(); cancel.focus({ preventScroll: true });
}
