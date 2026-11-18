/** People & agents: roster and viewer rights in, detail controls and callbacks out.
 * Hosted and local owners share the Lists & docs flow and one approval command; the server decides. */
import { reconnectPrompt } from "./agent-hosts";
import { buildAgentRenameField, type RenameOutcome } from "./agent-rename";
import { HOSTED_LISTS_NOTE } from "./hosted-lists-note";
import { buildAgentModelEditor } from "./agent-model-editor";
import type { PeopleAgentStatus } from "./agent-status";
import { personTint } from "./home-names";
import { buildPeoplePage } from "./people-page";
import { peopleInviteCancelLabel, peopleInviteConfirmCopy, type PeopleInvite } from "./people-invites";
import { peopleSearchResult, peopleTabOf, type PeopleTab } from "./people/tabs";
import { peopleTabView, type PeopleRead } from "./people/states";
import { buildPeopleInviteForm, buildPeopleInviteMade, newPeopleInviteDraft, type PeopleInviteDraft } from "./people/invite-form";

export interface PeopleDialogPerson { id: string; name: string; role: "owner" | "admin" | "member"; own: boolean; mayRemove: boolean }
export interface PeopleDialogAgent {
  id: string; name: string; ownerId: string; ownerName: string | null; model: string | null;
  app: string | null; hosted: boolean; status: PeopleAgentStatus; receive: string | null;
  lastActive: string; technical: string[]; grantRisk?: string | null; updateAvailable: boolean;
  access: { until: string | null } | null; accessReadState: "pending" | "succeeded" | "failed"; key: string | null; liveKey: boolean;
  own: boolean; mayManage: boolean; receipt: string;
  /** The agent's own name; `name` may carry a short id suffix where names repeat. */
  rawName?: string;
}
export type PeopleDialogInvite = PeopleInvite;
/** `workspaceName` is the viewer's name for this workspace; it is used only in the role refusal copy. */
export interface PeopleDialogModel { people: PeopleDialogPerson[]; agents: PeopleDialogAgent[]; invites: PeopleDialogInvite[]; sample: boolean; pendingFailed: boolean; workspaceName?: string;
  /** The read that brings people and agents. Absent means ready. */
  read?: PeopleRead }
export type PeopleDialogRole = PeopleDialogPerson["role"];
/** The role-change action the builder emits. Integration maps it to the `change_role` command. */
export interface PeopleDialogRoleChange { kind: "change-role"; userId: string; role: PeopleDialogRole }
/** Open the dialog with one person or one agent selected. */
export interface PeopleDialogFocus { kind: "person" | "agent"; id: string }
/** Role drafts, outcomes, pending saves and initial focus are builder-owned and optional. */
export interface PeopleDialogState { selected: { type: "agent" | "person"; id: string } | null; collapsed: Set<string>; showAllAttention: boolean; query: string;
  /** The open tab. The page builder settles it (Agents by default; no Invites in the sample workspace). */
  tab?: PeopleTab;
  roleDraft?: { userId: string; role: PeopleDialogRole; confirming: boolean; error?: string } | null; roleReceipt?: { userId: string; text: string } | null;
  roleRefusal?: { userId: string; name: string; text: string } | null;
  /** One entry per person whose role change is in flight. The entry object is the save's identity. */
  rolePending?: Map<string, { role: PeopleDialogRole }>; focusApplied?: string | null;
  /** Builder-owned: the row whose name is being edited, with its draft, the server's refusal and a save in flight. */
  rename?: { id: string; editor: number; value: string; error: string; pending: boolean } | null;
  /** Builder-owned: the hosted agent whose reconnect sentence is shown. */
  reconnect?: string | null;
  /** The invite form on the Invites tab, while it is open or its link is shown. */
  invite?: PeopleInviteDraft | null }
/** The page layout's own navigation. Links keep real hrefs; `navigate` (when given) handles the click in place. */
export interface PeopleDialogPage {
  /** The workspace name and its home route: the back link. */
  homeLabel: string; homeHref: string;
  /** The existing workspace overview, retained when the page replaces the desktop context. */
  workspacesHref?: string;
  /** Back. When given, the back link calls it instead of following its href. */
  back?: (event: MouseEvent) => void;
  /** The existing add-an-agent route. Absent or null hides the action. */
  addAgentHref?: string | null;
  /** The existing agent page for one agent: each manageable agent row links to it as Manage. */
  agentHref?: (agentId: string) => string;
  navigate?: (href: string, event: MouseEvent) => void;
  /** The older invite page. Used only when the dialog has no `createInvite`. Shown only to an owner or an admin, never in a sample. */
  invite?: () => void;
  /** The one-use link of the invite this dialog's form made, while it is still good. Never stored by the view. */
  madeInviteLink?: string;
  /** The page's search field; the integration owns the query and rerender. */
  onQuery?: (value: string) => void;
}
export interface PeopleDialogOptions {
  /** Applied once per state object and focus value; clear `state.focusApplied` to apply the same focus again. */
  focus?: PeopleDialogFocus;
  /** The tint used for an agent everywhere else in the app; null is neutral (its owner left). Without tintFor: position in the agent list. */
  tintFor?: (agentId: string) => 0 | 1 | 2 | 3 | null;
  /** The one layout: a roster with search, filters and actions in `root`, and the selected profile beside it.
   * Accepted so existing callers need no change; it selects nothing. Was: "page" builds one context roster and a main profile
   * into `root`; the real shell can project that roster without cloning its controls. */
  layout?: "page";
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
  /** rename_agent. A refusal resolves with the server's sentence; Rename is hidden without this callback. */
  rename?: (id: string, name: string, editor: number) => Promise<RenameOutcome>;
  /** Reads the invites again after a failed load. Retry is hidden without this callback. */
  reloadInvites?: () => Promise<void> | void;
  /** Reads people and agents again after a failed load. Retry is hidden without this callback. */
  reload?: () => Promise<void> | void;
  /** Makes an email invite from the form in the dialog. Answers with the new invite's id, or with the sentence to show. */
  createInvite?: (email: string) => Promise<{ madeId: string } | { error: string }>;
  /** The person is done with the link this dialog made: the integration forgets it. */
  forgetInvite?: () => void;
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
  return { groups, other, invites };
}
export function peopleDialogAccessUntil(agent: PeopleDialogAgent): string | null {
  if (!agent.own || agent.accessReadState !== "succeeded") return null;
  if (!agent.access) return agent.hosted ? HOSTED_LISTS_NOTE : "Not allowed.";
  const until = `Allowed until ${agent.access.until ?? "you withdraw it"}.`;
  // A hosted agent's approval exists and can be withdrawn, but it cannot use Lists & docs yet.
  return agent.hosted ? `${until} ${HOSTED_LISTS_NOTE}` : until;
}
/** The accessible-name suffix for an approved agent: usable access for a local agent, the hosted note otherwise. */
export function peopleDialogAccessLabel(agent: Pick<PeopleDialogAgent, "hosted">): string {
  return agent.hosted ? `, ${HOSTED_LISTS_NOTE}` : ", Can use Lists & docs";
}
/**
 * Rename and Reconnect are row controls, not dialog actions. Rename mirrors rename_agent's gate (the
 * agent's owner, or a workspace owner or admin: mayManage); the server still decides. Reconnect is the
 * owner's: a hosted agent is brought back from the owner's own chat app, a local one with a new setup
 * prompt for the same identity (the new-key action).
 */
export type PeopleRowAction = PeopleDialogAction | "rename" | "reconnect";
export function peopleDialogCanAct(model: PeopleDialogModel, action: PeopleRowAction, id: string): boolean {
  if (model.sample) return false;
  if (action === "remove-person") return model.people.some((person) => person.id === id && person.mayRemove && !person.own);
  if (action === "cancel-invite") return model.invites.some((invite) => invite.id === id && invite.mayCancel);
  const agent = model.agents.find((candidate) => candidate.id === id);
  if (!agent) return false;
  if (action === "withdraw") return agent.own && agent.accessReadState === "succeeded" && !!agent.access;
  if (action === "resume") return agent.mayManage && agent.status.kind === "paused" && agent.status.fix.allowed;
  if (action === "allow") return agent.own && agent.accessReadState === "succeeded" && !agent.access;
  if (action === "new-key" || action === "connected-apps" || action === "reconnect") return agent.own;
  if (action === "rename") return agent.mayManage;
  if (action === "turn-off-key") return agent.liveKey && (agent.hosted ? agent.mayManage : agent.own);
  return action === "remove-agent" && agent.mayManage;
}
/** The `window.confirm` text of the withdraw button on the Lists & docs card. */
export function withdrawConfirmText(name: string, hosted: boolean): string {
  return hosted ? `Remove the stored Lists & docs approval for ${name}? ${HOSTED_LISTS_NOTE}`
    : `Withdraw Lists & docs access for ${name}? It can no longer see or change lists and docs here until you allow it again.`;
}
export function peopleConfirmationCopy(action: PeopleConfirmAction, item: { name: string; hosted?: boolean; kind?: string }) {
  const name = item.name;
  if (action === "cancel-invite") return peopleInviteConfirmCopy({ name, kind: (item.kind ?? "person") as PeopleInvite["kind"] });
  if (action === "remove-agent") return { title: `Remove ${name}?`, button: `Remove ${name}`,
    stops: item.hosted ? [`${name} will lose access to this space. Its identity and every connection will end.`, "This cannot be undone."] : [`${name} will lose access to this workspace immediately.`],
    stays: [`Its history stays as “${name} (removed)”.`, ...(item.hosted ? ["Its owner can connect a new agent with the same name."] : [])] };
  if (action === "turn-off-key") return { title: `Turn off ${name}’s key?`, button: "Turn off key",
    stops: [`${name} stops when its current access ends.`, "This key cannot be used again."],
    stays: ["Its identity and history stay here.", "Its owner can get a new key to bring it back."] };
  if (action === "withdraw" && item.hosted) return { title: "Withdraw Lists & docs?", button: "Withdraw access",
    stops: [`This removes the stored Lists & docs approval for ${name}.`],
    stays: ["Existing lists, docs and history stay.", HOSTED_LISTS_NOTE] };
  if (action === "withdraw") return { title: "Withdraw Lists & docs?", button: "Withdraw access",
    stops: [`${name} will no longer be able to use Lists & docs here.`],
    stays: ["Existing lists, docs and history stay.", "You can allow access again on the Lists & docs card."] };
  return { title: `Remove ${name}?`, button: `Remove ${name}`,
    stops: [`${name} will lose membership of this space.`, "This removal cannot be undone; they would need a new invitation to join again."],
    stays: ["History stays. Their other spaces are unaffected."] };
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
/** Reads the stable code a rejected change carries: the first of `code` and `reason` that names a known refusal, else `code`, else `reason`. Never the message. */
export function peopleRoleErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, reason } = error as { code?: unknown; reason?: unknown };
  const found = [code, reason].filter((value): value is string => typeof value === "string");
  return found.find((value) => (PEOPLE_ROLE_REFUSAL_CODES as readonly string[]).includes(value)) ?? found[0] ?? null;
}
export function peopleRoleRefusal(code: string | null, name: string, workspaceName?: string): string {
  const first = peopleFirstName(name);
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
  state.selected = { type: focus.kind, id: focus.id }; state.tab = peopleTabOf(focus.kind); state.focusApplied = key; return true;
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
/** The envelope that marks a person's invitation. */
function inviteIcon(doc: Document) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "pd-icon");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 6h16v12H4zM4 7l8 6 8-6");
  svg.append(path); return svg;
}
/** No tint (null) is the neutral square of an agent whose owner left. */
function orb(doc: Document, agent: PeopleDialogAgent, tint: number | null) {
  const element = node(doc, "span", "pd-orb", letters(agent.name));
  if (tint !== null) element.dataset.tint = String(tint); element.setAttribute("aria-hidden", "true"); return element;
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

/** The page heading can live in the shell context, outside the main page element. */
function pageHeading(doc: Document): HTMLElement | null {
  const page = doc.querySelector<HTMLElement>("[data-people-page]");
  const title = doc.querySelector<HTMLElement>("[data-people-context] #pd-page-title");
  const bounds = title?.getBoundingClientRect();
  return page?.getClientRects().length && !page.closest("[hidden],[inert]") && title?.getClientRects().length
    && bounds && bounds.width > 1 && bounds.height > 1 && !title.closest("[hidden],[inert]") ? title : null;
}

/** Each opened Rename field is a new editor; a save's answer applies only to the editor that sent it. */
let renameEditors = 0;

/** Real DOM builder. User text is always textContent or an input value, never HTML. */
export function renderPeopleDialog(root: HTMLElement, detail: HTMLElement, model: PeopleDialogModel, state: PeopleDialogState, callbacks: PeopleDialogCallbacks, options: PeopleDialogOptions = {}): void {
  const doc = root.ownerDocument;
  const appliedFocus = options.focus ? peopleDialogApplyFocus(model, state, options.focus) : false;
  const tintOf = (agent: PeopleDialogAgent) => { if (!options.tintFor) return model.agents.indexOf(agent) % 4; const tint = options.tintFor(agent.id); return validTint(tint) ? tint : null; };
  const active = doc.activeElement as HTMLElement | null;
  // The role question is rebuilt with everything else. If a refresh redraws it while it is open, the keyboard stays on
  // the button it was on instead of jumping back to the first one.
  const roleConfirmKept = active?.closest("dialog[data-role-confirm]") && active.hasAttribute("data-confirm-role") ? "[data-confirm-role]" : null;
  const focusRoleConfirm = (confirm: HTMLDialogElement) => ((roleConfirmKept ? confirm.querySelector<HTMLButtonElement>(`${roleConfirmKept}:not(:disabled)`) : null)
    ?? confirm.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? confirm).focus({ preventScroll: true });
  const hadFocus = !!active && (root.contains(active) || detail.contains(active));
  const refocusPrincipal = active?.closest<HTMLElement>("[data-agent-row]")?.dataset.agentRow;
  const focusKey = active && (root.contains(active) || detail.contains(active)) ? active.dataset.pdFocus : undefined;
  const typing = focusKey === "invite-email" ? active as HTMLInputElement : null;
  const inviteCaret = typing ? [typing.selectionStart ?? typing.value.length, typing.selectionEnd ?? typing.value.length] as const : null;
  const focusWithinDetail = !!active && detail.contains(active);
  const oldEditor = detail.querySelector<HTMLFormElement>("[data-model-editor]");
  const draft = oldEditor ? { id: oldEditor.dataset.modelEditor, value: oldEditor.querySelector<HTMLInputElement>("input")?.value } : null;
  const openActions = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>(".pd-row-actions[open]"), menu => menu.dataset.memberMenu));
  if (appliedFocus) openActions.clear();
  root.replaceChildren(); detail.replaceChildren();
  const outer = root.closest<HTMLDialogElement>("[data-roster-dialog]");
  // One roster node: the shell projects it into desktop context and returns it to this page on phones.
  const focusInvite = (key: string) => root.querySelector<HTMLElement>(`[data-pd-focus="${key}"]`)?.focus({ preventScroll: true });
  // Invite a person opens the form on the Invites tab; without `createInvite` it still leaves for the older page.
  const openInvite = () => { state.tab = "invites"; state.invite ??= newPeopleInviteDraft(); callbacks.render(); focusInvite("invite-email"); };
  // A link that is gone (cancelled, used or expired) takes its block with it; the list already shows the change.
  if (state.invite?.madeId && !options.page?.madeInviteLink) state.invite = null;
  const page = options.page ?? { homeLabel: model.workspaceName ?? "", homeHref: "" };
  const nav = callbacks.createInvite && !model.sample ? { ...page, invite: openInvite } : page;
  const { page: pageRoot, host, side } = buildPeoplePage(doc, model, state, nav, callbacks.render);
  root.append(pageRoot);
  const select = (type: "agent" | "person", id: string) => {
    host.querySelectorAll<HTMLDetailsElement>(".pd-row-actions[open]").forEach(menu => { menu.open = false; });
    if (type === "agent") { const agent = model.agents.find((candidate) => candidate.id === id); if (agent) state.collapsed.delete(agent.ownerId); }
    state.selected = state.selected?.id === id && state.selected.type === type ? null : { type, id };
    // Opening an agent from a person's profile (or the reverse) moves to its tab, so Back lands on its row.
    if (state.selected) state.tab = peopleTabOf(type);
    callbacks.render(); detail.scrollTop = 0;
    if (state.selected) detail.scrollIntoView?.({ block: "nearest" });
    (state.selected ? detail.querySelector<HTMLElement>("h2") : doc.getElementById(`pd-${type}-${id}`))?.focus({ preventScroll: false });
  };
  const back = () => { const selected = state.selected;
    const missingRow = selected && !doc.getElementById(`pd-${selected.type}-${selected.id}`);
    state.selected = null;
    if (missingRow) state.tab = peopleTabOf(selected.type);
    if (missingRow && state.query && options.page?.onQuery) options.page.onQuery(""); else callbacks.render();
    if (selected) (doc.getElementById(`pd-${selected.type}-${selected.id}`) ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title") ?? pageHeading(doc))?.focus({ preventScroll: false }); };
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
    if (state.selected?.type === "person" && state.selected.id === personId)
      (detail.querySelector<HTMLElement>(`[data-pd-focus="${key}"]`) ?? detail.querySelector<HTMLElement>("h2"))?.focus({ preventScroll: false }); };
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
      try { await callbacks.changeRole({ kind: "change-role", userId: person.id, role: next }); }
      catch (error) { refusal = peopleRoleRefusal(peopleRoleErrorCode(error), person.name, model.workspaceName); }
      if (!peopleRoleFinishSave(state, person.id, save)) return;
      if (refusal === null) { if (state.roleDraft?.userId === person.id) state.roleDraft = null; state.roleReceipt = { userId: person.id, text: peopleRoleReceipt(person.name, next) }; }
      else {
        state.roleRefusal = { userId: person.id, name: person.name, text: refusal };
        // Keep the attempted role in this person's select, unless the viewer has since started choosing a role for
        // someone else: a refusal for one person must not discard another person's unsaved choice.
        if (!state.roleDraft || state.roleDraft.userId === person.id) state.roleDraft = { userId: person.id, role: next, confirming: false, error: refusal };
      }
      callbacks.render();
      refocusRole(person.id, `role-${person.id}`);
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
  const { groups, other, invites } = peopleDialogGroups(model, state.query);
  const tab: PeopleTab = state.tab ?? "agents";
  const needle = state.query.trim().toLocaleLowerCase();
  // People lists a person when their own name matches; Agents keeps a matching owner's whole group.
  const shownPeople = groups.filter(({ person }) => !needle || person.name.toLocaleLowerCase().includes(needle));
  const shownAgents = groups.reduce((count, group) => count + group.agents.length, other.length);
  // Attention stays on each agent's own row (its pill, its sentence and its one next action), not in a summary.
  if (needle) {
    const result = node(doc, "p", "pd-roster-result pd-muted",
      peopleSearchResult(tab, tab === "people" ? shownPeople.length : tab === "agents" ? shownAgents : invites.length));
    result.setAttribute("role", "status"); host.append(result);
  }
  const grid = node(doc, "div", "pd-member-grid"); grid.dataset.memberList = "";
  // Rename in the row: the draft, the server's refusal and a save in flight live in state, so a roster refresh keeps them.
  const focusRow = (id: string) => doc.getElementById(`pd-agent-${id}`)?.focus({ preventScroll: false });
  const renameField = (agent: PeopleDialogAgent) => {
    const draft = state.rename!;
    const field = buildAgentRenameField(doc, { id: `pd-rename-${agent.id}`, label: "Name", current: agent.rawName ?? agent.name,
      value: draft.value, error: draft.error, pending: draft.pending, focusKey: `rename-input-${agent.id}`,
      onInput: (value) => { if (state.rename?.id === agent.id) { state.rename.value = value; state.rename.error = ""; } },
      onCancel: () => { state.rename = null; callbacks.render(); focusRow(agent.id); },
      onSubmit: (name) => void saveRename(agent.id, name) });
    field.form.classList.add("pd-rename"); field.form.dataset.renameAgent = agent.id;
    return field.form;
  };
  const renameInput = (id: string) => doc.getElementById(`pd-rename-${id}`) as HTMLInputElement | null;
  const saveRename = async (id: string, name: string) => {
    const rename = callbacks.rename;
    if (!rename || state.rename?.id !== id || state.rename.pending) return;
    // The answer belongs to this editor only: Cancel then Rename again on the same agent opens a new one.
    const editor = state.rename.editor;
    state.rename = { id, editor, value: name, error: "", pending: true }; callbacks.render();
    let outcome: RenameOutcome;
    try { outcome = await rename(id, name, editor); }
    catch (error) { outcome = { ok: false, message: error instanceof Error ? error.message : "The rename was not confirmed." }; }
    // Cancelled, reopened, or another row opened while the server answered: that field is not this answer's.
    if (state.rename?.id !== id || state.rename.editor !== editor) return;
    if (!outcome.ok) {
      state.rename = { id, editor, value: name, error: outcome.message, pending: false }; callbacks.render();
      renameInput(id)?.focus({ preventScroll: true }); return;
    }
    state.rename = null; callbacks.render(); focusRow(id);
  };
  // A hosted agent reconnects from its owner's chat app: the sentence to paste there, with Copy.
  const reconnectSentence = (agent: PeopleDialogAgent) => {
    const block = node(doc, "div", "pd-reconnect-sentence"); block.dataset.reconnectSentence = agent.id;
    const text = reconnectPrompt({ workspace: model.workspaceName ?? "", name: agent.rawName ?? agent.name });
    const sentence = node(doc, "p", "", text);
    const copy = button(doc, "Copy", (opener) => {
      void (async () => {
        try { await navigator.clipboard.writeText(text); opener.textContent = "Copied"; }
        catch {
          const range = doc.createRange(); range.selectNodeContents(sentence);
          const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
          opener.textContent = "Selected";
        }
      })();
    });
    copy.setAttribute("aria-label", `Copy the reconnect sentence for ${agent.name}`); copy.dataset.pdFocus = `reconnect-copy-${agent.id}`;
    const close = button(doc, "Close", () => { state.reconnect = null; callbacks.render(); focusRow(agent.id); });
    close.dataset.pdFocus = `reconnect-close-${agent.id}`;
    const controls = node(doc, "div", "pd-reconnect-actions"); controls.append(copy, close);
    block.append(sentence, controls);
    block.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); state.reconnect = null; callbacks.render(); focusRow(agent.id);
    });
    return block;
  };
  // Compact row: native disclosure opens the profile; its native actions disclosure retains the actions.
  const agentRow = (agent: PeopleDialogAgent) => {
    const approved = peopleDialogAccessUntil(agent) !== null && !!agent.access;
    const row = node(doc, "li", "pd-agent"); row.dataset.agentRow = agent.id; row.dataset.attention = String(agent.status.attention);
    const disclosure = button(doc, "", () => select("agent", agent.id), "pd-agent-disclosure"); disclosure.id = `pd-agent-${agent.id}`;
    disclosure.dataset.pdFocus = `agent-${agent.id}`;
    disclosure.setAttribute("aria-expanded", String(state.selected?.type === "agent" && state.selected.id === agent.id)); disclosure.setAttribute("aria-controls", detail.id);
    const secondary = agent.model ?? (agent.hosted ? "In a chat app" : "On a computer");
    const copy = node(doc, "span", "pd-agent-copy"); const nameLine = node(doc, "span", "pd-agent-name-line");
    // One line each: the name, then the measured status in words beside where the agent runs. Whose agent it is
    // is the group's heading. The full name is the row's title and the profile's heading.
    const name = node(doc, "strong", "pd-ellipsis", agent.name); name.title = agent.name; nameLine.append(name);
    const sentence = agent.status.attention && !model.sample ? agent.status.sentence : "";
    const details = node(doc, "span", "pd-agent-app pd-ellipsis");
    const word = node(doc, "span", "pd-agent-status", agent.status.label);
    word.dataset.agentStatus = agent.status.kind; word.dataset.attention = String(agent.status.attention);
    const where = [agent.app, secondary].filter(Boolean).join(" · ");
    details.append(word, doc.createTextNode(` · ${where}`)); details.title = `${agent.status.label} · ${where}`;
    // What the row does not show stays in its accessible name: what to do about it, and Lists & docs access.
    const supplement = sentence + (approved ? peopleDialogAccessLabel(agent) : "");
    copy.append(nameLine, doc.createTextNode(" "), details);
    disclosure.append(orb(doc, agent, tintOf(agent)), copy, node(doc, "span", "pd-sr-only", ` ${supplement}`)); row.append(disclosure);
    const notice = noticeFor(agent);
    const actions = node(doc, "span", "pd-agent-actions");
    const next = agent.status.attention ? fix(agent, notice) : null;
    // The one thing the row needs is a short button on the row; its accessible name says the whole of it.
    if (next) { next.classList.add("pd-reconnect", "pd-row-repair"); next.setAttribute("aria-label", `${next.textContent}: ${agent.name}`);
      if (agent.status.fix.action === "new-key") next.textContent = "New key"; row.append(next); }
    // One click per seat: an own agent not yet allowed into Lists & docs gets the action on its row, in the
    // repair slot, unless a repair already holds it.
    else if (!model.sample && peopleDialogCanAct(model, "allow", agent.id)) {
      // The row says what is allowed: for a connected agent this one tap grants it.
      const allow = actionButton("allow", agent, "Allow Lists & docs", notice, "data-row-allow-agent-access");
      allow.className = "pd-row-repair"; allow.setAttribute("aria-label", `Allow Lists & docs: ${agent.name}`);
      allow.dataset.pdFocus = `row-allow-${agent.id}`; row.append(allow);
    }
    const agentHref = options.page?.agentHref;
    // A row with a fix shows that one action, as the canvas does for a disconnected agent; its name still opens every detail.
    if (agentHref && agent.mayManage && !model.sample && !next) { const manage = link(doc, "Manage", agentHref(agent.id), "pd-pill-link", options.page?.navigate);
      manage.setAttribute("aria-label", `Manage ${agent.name}`); manage.dataset.pdFocus = `manage-${agent.id}`; actions.append(manage); }
    const closeMenu = () => host.querySelectorAll<HTMLDetailsElement>(".pd-row-actions[open]").forEach(menu => { menu.open = false; });
    if (callbacks.rename && peopleDialogCanAct(model, "rename", agent.id)) {
      const rename = button(doc, "Rename", () => {
        closeMenu(); state.reconnect = null;
        state.rename = { id: agent.id, editor: ++renameEditors, value: agent.rawName ?? agent.name, error: "", pending: false }; callbacks.render();
        const input = doc.getElementById(`pd-rename-${agent.id}`) as HTMLInputElement | null;
        input?.focus({ preventScroll: true }); input?.select();
      });
      rename.setAttribute("aria-label", `Rename ${agent.name}`); rename.dataset.pdFocus = `rename-${agent.id}`; actions.append(rename);
    }
    // Reconnect: a hosted agent comes back from its owner's chat app by a sentence; a local one with a new setup
    // prompt for the same identity. Not beside a row whose repair is already Get a new key.
    if (peopleDialogCanAct(model, "reconnect", agent.id) && !(next && agent.status.fix.action === "new-key")) {
      const reconnect = agent.hosted
        ? button(doc, "Reconnect", () => {
          closeMenu(); state.rename = null; state.reconnect = agent.id; callbacks.render();
          doc.querySelector<HTMLElement>(`[data-pd-focus="reconnect-copy-${agent.id}"]`)?.focus({ preventScroll: true });
        })
        : actionButton("new-key", agent, "Reconnect", notice);
      reconnect.className = "pd-text-button"; reconnect.setAttribute("aria-label", `Reconnect ${agent.name}`);
      reconnect.dataset.pdFocus = `reconnect-${agent.id}`; reconnect.dataset.reconnectAgent = agent.hosted ? "hosted" : "local"; actions.append(reconnect);
    }
    if (peopleDialogCanAct(model, "remove-agent", agent.id)) { const remove = actionButton("remove-agent", agent, "Remove from workspace", notice);
      remove.className = "pd-text-button"; remove.setAttribute("aria-label", `Remove ${agent.name}`); remove.dataset.pdFocus = `row-remove-agent-${agent.id}`; actions.append(remove); }
    if (actions.childElementCount) {
      const menu = node(doc, "details", "pd-row-actions"); const toggle = node(doc, "summary", "pd-actions-toggle");
      menu.dataset.memberMenu = agent.id; menu.open = openActions.has(agent.id);
      const glyph = node(doc, "span", "", "•••"); glyph.setAttribute("aria-hidden", "true");
      toggle.append(glyph, node(doc, "span", "pd-sr-only", `Actions for ${agent.name}`)); toggle.dataset.pdFocus = `actions-${agent.id}`;
      menu.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !menu.open || event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation(); menu.open = false; toggle.focus({ preventScroll: false });
      });
      menu.append(toggle, actions); row.append(menu);
    }
    if (state.rename?.id === agent.id && callbacks.rename && peopleDialogCanAct(model, "rename", agent.id)) row.append(renameField(agent));
    if (state.reconnect === agent.id && agent.hosted && peopleDialogCanAct(model, "reconnect", agent.id)) row.append(reconnectSentence(agent));
    if (state.selected?.id !== agent.id && agent.receipt) row.append(notice);
    const error = node(doc, "p", "pd-error"); error.setAttribute("role", "alert"); error.dataset.agentRowError = agent.id; error.hidden = true; row.append(error); return row;
  };
  // Person menus use the existing role editor and confirmed membership removal.
  const pageHead = (person: PeopleDialogPerson, head: HTMLElement, roleText: HTMLElement) => {
    roleText.classList.add("pd-sr-only");
    head.append(node(doc, "span", "pd-member-role", ROLE_LABELS[person.role]));
    const actions = node(doc, "span", "pd-agent-actions");
    if (callbacks.changeRole && peopleDialogRoleOptions(model, person.id).length) {
      const change = button(doc, "Change role", () => select("person", person.id));
      change.dataset.pdFocus = `row-role-${person.id}`; actions.append(change);
    }
    if (peopleDialogCanAct(model, "remove-person", person.id)) {
      const remove = button(doc, "Remove from workspace", opener => callbacks.confirm("remove-person", person.id, opener));
      remove.classList.add("pd-member-remove"); remove.dataset.pdFocus = `row-remove-person-${person.id}`; actions.append(remove);
    }
    if (actions.childElementCount) {
      const menu = node(doc, "details", "pd-row-actions"); menu.dataset.memberMenu = `person-${person.id}`;
      menu.open = openActions.has(menu.dataset.memberMenu);
      const toggle = node(doc, "summary", "pd-actions-toggle"); toggle.dataset.pdFocus = `person-actions-${person.id}`;
      const glyph = node(doc, "span", "", "•••"); glyph.setAttribute("aria-hidden", "true");
      toggle.append(glyph, node(doc, "span", "pd-sr-only", `Actions for ${person.name}`));
      menu.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !menu.open) return;
        event.preventDefault(); event.stopPropagation(); menu.open = false; toggle.focus();
      });
      menu.append(toggle, actions); head.append(menu);
    }
    if (state.selected?.type === "person" && state.selected.id === person.id) head.dataset.selected = "true";
  };
  const card = (person: PeopleDialogPerson | null, agents: PeopleDialogAgent[]) => {
    const element = node(doc, "section", "pd-member-card"); const head = node(doc, "div", "pd-person-head");
    if (person) {
      const personButton = button(doc, "", () => select("person", person.id), "pd-person-disclosure"); personButton.id = `pd-person-${person.id}`; personButton.dataset.pdFocus = `person-${person.id}`;
      personButton.setAttribute("aria-expanded", String(state.selected?.type === "person" && state.selected.id === person.id)); personButton.setAttribute("aria-controls", detail.id);
      const face = hue(node(doc, "span", "pd-initials", personLetters(person.name)), person); face.setAttribute("aria-hidden", "true");
      const copy = node(doc, "span", "pd-person-copy"); const name = node(doc, "strong", "pd-person-name", person.name); name.title = person.name;
      const roleText = node(doc, "span", "pd-muted", `${person.role[0].toUpperCase()}${person.role.slice(1)}${person.own ? " · You" : ""}`);
      copy.append(name, doc.createTextNode(" "), roleText); personButton.append(face, copy); head.append(personButton);
      pageHead(person, head, roleText);
    } else {
      const face = node(doc, "span", "pd-initials pd-neutral-avatar"); face.setAttribute("aria-hidden", "true");
      const copy = node(doc, "div", "pd-person-copy");
      copy.append(node(doc, "h3", "pd-person-name", "Other agents"), node(doc, "span", "pd-sr-only", "Their owner is no longer a member"));
      head.append(face, copy);
    }
    // People: one row per person. Agents: each owner's agents under a short heading, the viewer's own first.
    if (tab === "people") { element.append(head); return element; }
    const title = node(doc, "h3", "pd-group-title", !person ? "Other agents" : person.own ? "Yours" : `${peopleFirstName(person.name)}’s`);
    if (!person) title.append(node(doc, "span", "pd-sr-only", ". Their owner is no longer a member"));
    const list = node(doc, "ul", "pd-agents-list"); if (person) list.id = `pd-group-${person.id}`;
    title.id = `pd-group-title-${person?.id ?? "other"}`; list.setAttribute("aria-labelledby", title.id);
    agents.forEach((agent) => list.append(agentRow(agent)));
    element.append(title, list); return element;
  };
  // Every tab answers the same four ways: its rows, loading, empty, or could not load with Retry.
  const view = peopleTabView({ tab, read: model.sample ? "ready" : model.read ?? "ready", invitesFailed: model.pendingFailed,
    shown: tab === "people" ? shownPeople.length : tab === "agents" ? shownAgents : invites.length, searching: !!needle });
  const tabNote = (): HTMLElement | null => {
    if (!view.message) return null;
    const note = node(doc, "p", "pd-muted pd-tab-state", view.message); note.dataset.tabState = view.state;
    note.setAttribute("role", view.state === "error" ? "alert" : "status");
    const again = tab === "invites" ? callbacks.reloadInvites : callbacks.reload;
    if (view.retry && again) { const retry = button(doc, "Retry", async (opener) => {
        if (opener.disabled) return; opener.disabled = true; opener.setAttribute("aria-busy", "true");
        try { await again(); } finally { if (opener.isConnected) { opener.disabled = false; opener.removeAttribute("aria-busy"); } }
      }); retry.dataset.tabRetry = tab; retry.dataset.pdFocus = `retry-${tab}`; note.append(doc.createTextNode(" "), retry); }
    return note;
  };
  if (tab !== "invites") { const note = tabNote(); if (note) grid.append(note); }
  if (tab === "people") shownPeople.forEach(({ person, agents }) => grid.append(card(person, agents)));
  if (tab === "agents") {
    [...groups].sort((a, b) => Number(b.person.own) - Number(a.person.own)).forEach(({ person, agents }) => { if (agents.length) grid.append(card(person, agents)); });
    if (other.length) grid.append(card(null, other));
  }
  host.append(grid);
  // Invited: every invite says who made it and when, and every one the viewer may end has Cancel.
  const invited = node(doc, "section", "dashboard__roster-dialog-pending pd-invited"); invited.dataset.dialogAccessSection = "";
  const invitesOnly = tab === "invites" && !model.sample;
  invited.hidden = !invitesOnly; invited.setAttribute("aria-labelledby", "dashboard-roster-pending-title");
  const invitedTitle = node(doc, "h3", "pd-muted", "Invited · "); invitedTitle.id = "dashboard-roster-pending-title"; invitedTitle.tabIndex = -1;
  const count = node(doc, "span", "", String(invites.length)); count.dataset.dialogAccessCount = ""; invitedTitle.append(count);
  const inviteList = node(doc, "ul", "pd-invite-list"); inviteList.dataset.dialogAccessList = "";
  for (const invite of invites) {
    const row = node(doc, "li", "pd-invite"); row.dataset.inviteKind = invite.kind;
    const symbol = node(doc, "span", "pd-invite-symbol", invite.kind === "person" ? undefined : "↗"); symbol.setAttribute("aria-hidden", "true");
    if (invite.kind === "person") symbol.append(inviteIcon(doc));
    const copy = node(doc, "span", "pd-agent-copy"); const name = node(doc, "strong", "pd-ellipsis", invite.kind === "key" ? `Key for ${invite.name} not used yet` : invite.name); name.title = name.textContent ?? "";
    copy.append(name, node(doc, "span", "pd-muted", invite.detail)); row.append(symbol, copy);
    if (peopleDialogCanAct(model, "cancel-invite", invite.id)) { const cancel = button(doc, "Cancel", (opener) => callbacks.confirm("cancel-invite", invite.id, opener));
      cancel.dataset.pendingKind = invite.kind; cancel.dataset.pendingId = invite.id; cancel.dataset.pdFocus = `pending-${invite.kind}-${invite.id}`; cancel.setAttribute("aria-label", peopleInviteCancelLabel(invite)); row.append(cancel); }
    inviteList.append(row);
  }
  const inviteError = node(doc, "p", "pd-error"); inviteError.dataset.dialogAccessError = ""; inviteError.setAttribute("role", "alert"); inviteError.hidden = true;
  // With nothing to count, the tab's own line (none waiting, loading, could not load) is the whole answer.
  invitedTitle.hidden = invites.length === 0;
  const inviteDraft = state.invite ?? null; const madeLink = inviteDraft?.madeId ? options.page?.madeInviteLink ?? "" : "";
  if (inviteDraft && invitesOnly && callbacks.createInvite) {
    const closeInvite = () => { state.invite = null; callbacks.render(); focusInvite("page-invite"); };
    const handlers = {
      input: (value: string) => { inviteDraft.email = value; },
      cancel: closeInvite,
      done: () => { callbacks.forgetInvite?.(); closeInvite(); },
      submit: async () => {
        inviteDraft.busy = true; inviteDraft.error = ""; callbacks.render();
        let answer: { madeId: string } | { error: string };
        try { answer = await callbacks.createInvite!(inviteDraft.email.trim()); }
        catch { answer = { error: "The result is unknown. Check the list below before trying again." }; }
        inviteDraft.busy = false;
        if (state.invite !== inviteDraft) return;
        if ("madeId" in answer) { inviteDraft.madeId = answer.madeId; inviteDraft.email = inviteDraft.email.trim(); } else inviteDraft.error = answer.error;
        callbacks.render(); focusInvite("madeId" in answer ? "invite-copy" : "invite-email");
      },
      copy: async (shown: HTMLElement) => {
        const say = (text: string) => { inviteDraft.copied = text; const status = shown.parentElement?.querySelector<HTMLElement>(".pd-invite-copied"); if (status) status.textContent = text; };
        try { await doc.defaultView!.navigator.clipboard.writeText(madeLink); say("Copied. Send this link to them."); }
        catch { const range = doc.createRange(); range.selectNodeContents(shown); const selection = doc.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
          say("The link is selected. Copy it from here."); }
      },
    };
    invited.append(madeLink ? buildPeopleInviteMade(doc, inviteDraft, madeLink, handlers) : buildPeopleInviteForm(doc, inviteDraft, handlers));
  }
  invited.append(invitedTitle); if (invitesOnly) { const note = tabNote(); if (note) invited.append(note); }
  invited.append(inviteList, inviteError); host.append(invited);
  side.append(detail);

  if (state.roleReceipt && (state.selected?.type !== "person" || state.roleReceipt.userId !== state.selected.id)) {
    const receipt = node(doc, "p", "pd-receipt", state.roleReceipt.text);
    receipt.dataset.roleReceipt = ""; receipt.setAttribute("role", "status"); host.append(receipt);
  }
  if (state.roleRefusal && (state.selected?.type !== "person" || state.roleRefusal.userId !== state.selected.id)) {
    const refusal = node(doc, "p", "pd-error", `${state.roleRefusal.name}: ${state.roleRefusal.text}`);
    refusal.dataset.roleError = state.roleRefusal.userId; refusal.setAttribute("role", "alert"); host.append(refusal);
  }
  const selected = state.selected?.type === "agent" ? model.agents.find((agent) => agent.id === state.selected?.id) : model.people.find((person) => person.id === state.selected?.id);
  if (!selected) state.selected = null;
  detail.hidden = !state.selected; outer?.classList.toggle("has-detail", !!state.selected); pageRoot?.classList.toggle("has-detail", !!state.selected);
  const emptyProfile = side?.querySelector<HTMLElement>("[data-people-empty]"); if (emptyProfile) emptyProfile.hidden = !!state.selected;
  if (state.selected && selected) {
    const top = node(doc, "div", "pd-detail-top");
    const closeButton = button(doc, "", back, "pd-close-detail");
    const phoneLabel = node(doc, "span", "pd-close-phone"); const chevron = node(doc, "span", "", "‹"); chevron.setAttribute("aria-hidden", "true");
    phoneLabel.append(chevron, node(doc, "span", "pd-sr-only", "Back to "), doc.createTextNode("People"));
    closeButton.append(node(doc, "span", "pd-close-wide", "Close"), phoneLabel); closeButton.dataset.peopleProfileBack = "";
    top.append(closeButton); detail.append(top);
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
        const accessAction = peopleDialogCanAct(model, "withdraw", agent.id) ? actionButton("withdraw", agent, "Withdraw", notice, "data-withdraw-agent-access") : peopleDialogCanAct(model, "allow", agent.id) ? actionButton("allow", agent, "Allow", notice, "data-allow-agent-access") : undefined;
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
        if (peopleDialogCanAct(model, "turn-off-key", agent.id)) { const stop = actionButton("turn-off-key", agent, "Turn off key", notice, "data-revoke-grant"); stop.setAttribute("aria-label", `Turn off key for ${agent.name}`); actions.append(stop); }
        const remove = actionButton("remove-agent", agent, agent.hosted ? "Remove agent" : "Remove from this workspace", notice, "data-remove-agent"); remove.setAttribute("aria-label", `Remove agent: ${agent.name}`); actions.append(remove); danger.append(actions); detail.append(danger); }
      const error = node(doc, "p", "pd-error"); error.dataset.agentError = ""; error.setAttribute("role", "alert"); error.hidden = true; detail.append(error);
    } else {
      const person = selected as PeopleDialogPerson; const face = hue(node(doc, "span", "pd-initials", personLetters(person.name)), person);
      const role = node(doc, "p", "pd-muted", `${person.role[0].toUpperCase()}${person.role.slice(1)}${person.own ? " · You" : ""}`);
      const copy = node(doc, "div"); copy.append(title, role); identity.append(face, copy); detail.append(identity);
      if (state.roleReceipt?.userId === person.id) { const done = node(doc, "p", "pd-receipt", state.roleReceipt.text); done.dataset.roleReceipt = ""; done.setAttribute("role", "status"); detail.append(done); }
      const roles = callbacks.changeRole ? peopleDialogRoleOptions(model, person.id) : [];
      if (roles.length) { const control = roleControl(person, roles); detail.append(control);
        const confirm = control.querySelector<HTMLDialogElement>("dialog[data-role-confirm]");
        if (confirm && !confirm.open) { confirm.showModal(); focusRoleConfirm(confirm); } }
      detail.append(node(doc, "h3", "pd-section-title", "Agents in this space")); const agents = model.agents.filter((agent) => agent.ownerId === person.id);
      const list = node(doc, "ul", "pd-person-agents"); agents.forEach((agent) => { const entry = node(doc, "li"); entry.append(button(doc, agent.name, () => select("agent", agent.id))); list.append(entry); }); detail.append(list);
      if (!agents.length) detail.append(node(doc, "p", "pd-muted", "No agents added yet."));
      if (peopleDialogCanAct(model, "remove-person", person.id)) { const danger = node(doc, "section", "pd-danger-zone"); danger.append(node(doc, "h3", "", "Membership"));
        const remove = button(doc, "Remove person", (opener) => callbacks.confirm("remove-person", person.id, opener), "pd-danger-button"); remove.setAttribute("aria-label", `Remove person: ${person.name}`); remove.dataset.removeMember = person.id; remove.dataset.pdFocus = `remove-person-${person.id}`; danger.append(remove); detail.append(danger); }
    }
  }
  if (draft?.id && state.selected?.type === "agent" && state.selected.id === draft.id) {
    const edit = detail.querySelector<HTMLButtonElement>("[data-edit-model]");
    edit?.click(); const input = detail.querySelector<HTMLInputElement>("[data-model-editor] input");
    if (input && draft.value !== undefined) input.value = draft.value;
    if (active?.isConnected && !focusWithinDetail && !root.contains(active)) active.focus({ preventScroll: true });
  }
  { const confirm = root.querySelector<HTMLDialogElement>("dialog[data-role-confirm]");
    if (confirm && !confirm.open && confirm.isConnected) { confirm.showModal(); focusRoleConfirm(confirm); } }
  if (focusKey && !root.querySelector("dialog[open]")) { const target = [...(focusWithinDetail ? detail : root).querySelectorAll<HTMLElement>("[data-pd-focus]")].find((element) => element.dataset.pdFocus === focusKey);
    (target ?? (focusWithinDetail ? detail.querySelector<HTMLElement>("h2") : doc.getElementById(`pd-agent-${refocusPrincipal}`)) ?? outer?.querySelector<HTMLElement>("[data-add-agent-dialog]") ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title") ?? pageHeading(doc))?.focus({ preventScroll: true });
    if (doc.activeElement instanceof HTMLInputElement && doc.activeElement.type === "search") { const end = doc.activeElement.value.length; doc.activeElement.setSelectionRange(end, end); }
    const retyping = doc.activeElement as HTMLInputElement | null;
    if (inviteCaret && retyping?.dataset?.pdFocus === "invite-email") retyping.setSelectionRange(inviteCaret[0], inviteCaret[1]); }
  // A refresh replaces headings too. Restore focus only when this render dropped it to body;
  // another control or a nested/sibling dialog owns any focus it acquired meanwhile.
  if (hadFocus && (!doc.activeElement || doc.activeElement === doc.body) && !doc.querySelector("dialog[open]:not([data-roster-dialog])")) {
    const fallback = (focusWithinDetail ? detail.querySelector<HTMLElement>("#pd-detail-title") : null)
      ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title") ?? pageHeading(doc);
    if (fallback?.getClientRects().length && !fallback.closest("[hidden],[inert]")) fallback.focus({ preventScroll: true });
  }
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
  if (action === "remove-agent" && item.hosted && item.liveKey && alternative) { const option = node(doc, "section", "pd-alternative"); option.append(node(doc, "h3", "", "Would turning off the key be enough?"), node(doc, "p", "", `Keep ${item.name} and its history here. It stops when its current access ends; a new key can bring it back.`), button(doc, "Turn off key instead →", () => alternative())); dialog.append(option); }
  const notice = node(doc, "p", "pd-error"); notice.setAttribute("role", "alert"); notice.hidden = true;
  let pending = false;
  // The page layout has no outer dialog: its host is the current People & agents page (a render replaces the element).
  const pageHost = () => dialog.closest("[data-roster-dialog]") ? null : doc.querySelector<HTMLElement>("[data-people-page]");
  dialog.toggleAttribute("data-people-page-confirm", !!pageHost());
  const close = () => { if (pending) return; dialog.close();
    const outer = dialog.closest<HTMLDialogElement>("[data-roster-dialog]");
    const fallback = outer?.querySelector<HTMLElement>("#pd-detail-title") ?? outer?.querySelector<HTMLElement>("#dashboard-roster-title")
      ?? pageHost()?.querySelector<HTMLElement>("#pd-detail-title") ?? (pageHost() ? pageHeading(doc) : null);
    // A background refresh can redraw the roster while this question is open. Focus then returns to the same control
    // by its focus key, not to the heading because the node that opened the question is gone.
    const key = opener.dataset.pdFocus;
    const redrawn = !opener.isConnected && key ? [...(outer ?? pageHost() ?? doc.body).querySelectorAll<HTMLElement>("[data-pd-focus]")]
      .find((control) => control.dataset.pdFocus === key && control.getClientRects().length > 0) ?? null : null;
    const target = opener.isConnected ? opener : redrawn;
    if (target && !target.closest("[inert]")) target.focus({ preventScroll: true }); else fallback?.focus({ preventScroll: true }); };
  const actions = node(doc, "div", "pd-confirm-actions"); const cancel = button(doc, "Go back", close, "dashboard__button dashboard__button--secondary");
  const acceptLabel = pageHost() && action === "remove-agent" ? "Remove agent" : pageHost() && action === "remove-person" ? "Remove person" : copy.button;
  const accept = button(doc, acceptLabel, async () => {
    pending = true; notice.hidden = true;
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].forEach((control) => control.disabled = true);
    try { await commit(accept, notice); if (dialog.open) dialog.close();
      const outer = dialog.closest<HTMLDialogElement>("[data-roster-dialog]");
      if (outer?.open) {
        if (focusAfterCommit) focusAfterCommit();
        else (outer.querySelector<HTMLElement>("#pd-detail-title") ?? outer.querySelector<HTMLElement>("#dashboard-roster-title"))?.focus({ preventScroll: true });
      } else if (!outer) { const host = pageHost();
        if (host && focusAfterCommit) focusAfterCommit();
        else (host?.querySelector<HTMLElement>("#pd-detail-title") ?? (host ? pageHeading(doc) : null))?.focus({ preventScroll: true }); }
    }
    catch (error) { notice.hidden = false; notice.textContent = formatError(error); }
    finally { pending = false; [...dialog.querySelectorAll<HTMLButtonElement>("button")].forEach((control) => control.disabled = false); }
  }, action === "withdraw" ? "dashboard__button dashboard__button--primary" : "dashboard__button pd-danger-fill");
  if (acceptLabel !== copy.button) accept.setAttribute("aria-label", `${acceptLabel}: ${item.name}`);
  actions.append(cancel, accept); dialog.append(notice, actions);
  dialog.oncancel = (event) => { event.preventDefault(); event.stopPropagation(); close(); };
  if (!dialog.open) dialog.showModal(); cancel.focus({ preventScroll: true });
}
