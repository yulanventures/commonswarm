// Home UI: the workspace right column (UI-SPEC.md 3.3, lane W). Pure derivation first, then thin DOM
// builders: (doc, vm, callbacks) => HTMLElement. User text goes in through textContent only; sample mode
// renders no actions; nothing here reads the network or the clock.
import type { AgentVM, ObjectCardVM, PersonVM } from "./home-types";
import { agentOrb, objectCard, personAvatar } from "./home-primitives";

/**
 * The refused Lists & docs door. The words are the Lists pane's own form (LiveDashboard.astro, the
 * `data-household-consent` form): same heading, same lead. That form lives in the Lists pane, so the
 * button here opens the pane at that form instead of repeating its choices.
 */
export const LISTS_DOOR_TITLE = "Turn on Lists & docs";
export const LISTS_DOOR_LEAD = "Lists, docs and files that you and your agents can read and change. Every saved version is kept, with who made it.";

/** UI-SPEC 3.3: To-dos show up to 6 open rows; Lists and Files show up to 5 each. */
export const SIDE_TODO_LIMIT = 6;
export const SIDE_OBJECT_LIMIT = 5;

export type SideTodoState = "open" | "doing" | "done" | "dropped";

/** One to-do as the right column needs it. `subline` arrives already worded ("Your Claude · 2nd in line"). */
export interface SideTodoVM { id: string; title: string; href: string; state: SideTodoState; mayComplete: boolean; subline: string;
  /** Who the to-do is assigned to, shown as a picture at the row's end (Space.dc.html). Absent or null: nobody. */
  who?: PersonVM | AgentVM | null }

/** `null` means the to-dos read is absent: every To-dos surface is then absent too (UI-SPEC 3.3 states). */
export interface SideTodosVM { items: SideTodoVM[]; allHref: string; canAdd: boolean; notice?: string }

/**
 * The Lists & docs read has four measured states. Only a measured refusal shows the door; a read that is
 * still pending or that failed says so and never guesses a denial.
 */
export type SideObjectsVM =
  | { state: "pending" }
  | { state: "refused" }
  | { state: "failed" }
  | { state: "ready"; lists: ObjectCardVM[]; files: ObjectCardVM[] };

/** An agent of the viewer's that may use Lists & docs here. `until` is null while it lasts until withdrawn. */
export interface SideSharedAgentVM { agent: AgentVM; until: string | null }

export interface SideCardsVM {
  sample: boolean;
  workspaceName: string;
  todos: SideTodosVM | null;
  objects: SideObjectsVM;
  /** The viewer's agents only: the access read is owner-scoped, so other people's agents never appear here. */
  sharedAgents: SideSharedAgentVM[];
  hrefs: { lists: string; files: string; wiki: string };
}

export interface SideCardsCallbacks {
  onComplete: (todoId: string) => void | Promise<void>;
  onAddTodo: () => void;
  onOpenLists: () => void;
}

export interface SideTodoSummary { shown: SideTodoVM[]; more: number }

/** Open to-dos only (R5: done and dropped leave every open list), in the order given, capped. */
export function sideOpenTodos(items: readonly SideTodoVM[], limit = SIDE_TODO_LIMIT): SideTodoSummary {
  const open = items.filter((item) => item.state === "open" || item.state === "doing");
  return { shown: open.slice(0, limit), more: Math.max(0, open.length - limit) };
}

export function sideCapObjects(items: readonly ObjectCardVM[], limit = SIDE_OBJECT_LIMIT): { shown: ObjectCardVM[]; more: number } {
  return { shown: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

/** "Everyone in Home sees what is posted here, including what agents post." */
export function sharedEveryoneLine(workspaceName: string): string {
  return `Everyone in ${workspaceName} sees what is posted here, including what agents post.`;
}

/**
 * One line per agent of the viewer's own that may use Lists & docs. The line is the spec's exact sentence
 * while the approval lasts until withdrawn; with an end date it says so instead of promising more.
 */
export function sharedAgentLines(agents: readonly SideSharedAgentVM[]): string[] {
  return agents.filter(({ agent }) => agent.yours).map(({ agent, until }) => until
    ? `${agent.label} can use Lists & docs here until ${until}, or until you withdraw it.`
    : `${agent.label} can use Lists & docs here, until you withdraw it.`);
}

/** The to-dos surface exists only when the read does. */
export function sideShowsTodos(vm: Pick<SideCardsVM, "todos">): boolean { return vm.todos !== null; }

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
/**
 * One side card. Tom's ruling 4 ("Quiet forms"): a card's "All …" destination is its title, so with `href`
 * (and outside sample mode) the title text is that link and the card has no foot row.
 */
function section(doc: Document, key: string, title: string, href?: string): { root: HTMLElement; body: HTMLElement } {
  const root = node(doc, "section", "hm-side-card"); root.dataset.sideCard = key;
  const heading = node(doc, "h2", "hm-side-card__title"); heading.id = `hm-side-${key}-title`;
  if (href === undefined) heading.textContent = title;
  else { const anchor = node(doc, "a", "hm-side-card__title-link", title); anchor.href = href; anchor.dataset.sideLink = key; heading.append(anchor); }
  root.setAttribute("aria-labelledby", heading.id);
  const body = node(doc, "div", "hm-side-card__body");
  root.append(heading, body); return { root, body };
}
function link(doc: Document, text: string, href: string, hook: string, sample = false): HTMLElement {
  if (sample) return node(doc, "span", "hm-side-link", text);
  const anchor = node(doc, "a", "hm-side-link", text); anchor.href = href; anchor.dataset.sideLink = hook; return anchor;
}
function cardList(doc: Document, items: readonly ObjectCardVM[], label: string): HTMLUListElement {
  const list = node(doc, "ul", "hm-side-list"); list.setAttribute("aria-label", label);
  for (const item of items) { const row = node(doc, "li", "hm-side-list__item"); row.append(objectCard(doc, item)); list.append(row); }
  return list;
}
function check(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "hm-todo-row__tick"); svg.setAttribute("viewBox", "0 0 12 12"); svg.setAttribute("width", "12"); svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M2.5 6.2l2.4 2.4 4.6-5"); svg.append(path); return svg;
}

function plus(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 20 20", width: "20", height: "20", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(name, value);
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M10 4v12M4 10h12"); svg.append(path); return svg;
}

function todoRow(doc: Document, item: SideTodoVM, sample: boolean, callbacks: SideCardsCallbacks): HTMLElement {
  const row = node(doc, "li", "hm-todo-row"); row.dataset.sideTodo = item.id;
  if (item.mayComplete && !sample) {
    const label = node(doc, "label", "hm-todo-row__check");
    const input = node(doc, "input"); input.type = "checkbox"; input.className = "hm-todo-row__box"; input.dataset.sideTodoComplete = item.id;
    input.setAttribute("aria-label", `Mark ‘${item.title}’ done`);
    let busy = false;
    input.addEventListener("change", () => {
      if (busy) { input.checked = false; return; }
      busy = true;
      void Promise.resolve().then(() => callbacks.onComplete(item.id)).catch(() => undefined).finally(() => { busy = false; input.checked = false; });
    });
    label.append(input, node(doc, "span", "hm-todo-row__mark"));
    (label.querySelector(".hm-todo-row__mark") as HTMLElement).append(check(doc));
    row.append(label);
  }
  const text = sample ? node(doc, "span", "hm-todo-row__text") : Object.assign(node(doc, "a", "hm-todo-row__text"), { href: item.href }); text.dataset.sideTodoLink = item.id;
  const title = node(doc, "span", "hm-todo-row__title", item.title); title.title = item.title;
  text.append(title);
  if (item.subline) text.append(node(doc, "span", "hm-todo-row__sub", item.subline));
  row.append(text);
  if (item.who) {
    const who = node(doc, "span", "hm-todo-row__who");
    who.append("label" in item.who ? agentOrb(doc, item.who, { size: 26, badge: true }) : personAvatar(doc, item.who, 24));
    row.append(who);
  }
  return row;
}

/** The title row: the title (a link to the whole collection), how many rows are not shown, then any door. */
function headRow(doc: Document, root: HTMLElement, more: number): HTMLElement | null {
  const heading = root.querySelector("h2"); if (!heading) return null;
  const head = node(doc, "div", "hm-side-card__head"); heading.replaceWith(head); head.append(heading);
  if (more) head.append(node(doc, "span", "hm-side-card__more", `${more} more`));
  return head;
}

/** To-dos: up to 6 open rows and "+ Add a to-do"; the title opens all to-dos. Returns null when the read is absent. */
export function buildTodosCard(doc: Document, vm: SideCardsVM, callbacks: SideCardsCallbacks): HTMLElement | null {
  if (!vm.todos) return null;
  const { root, body } = section(doc, "todos", "To-dos", vm.sample ? undefined : vm.todos.allHref);
  const { shown, more } = sideOpenTodos(vm.todos.items);
  const head = headRow(doc, root, more);
  // The add door sits beside the title as a 44 px "+" (Space.dc.html); its name stays "Add a to-do".
  if (head && vm.todos.canAdd && !vm.sample) {
    const add = node(doc, "button", "hm-side-add"); add.type = "button"; add.dataset.sideAddTodo = "";
    add.setAttribute("aria-label", "Add a to-do"); add.title = "Add a to-do"; add.append(plus(doc));
    add.addEventListener("click", () => callbacks.onAddTodo()); head.append(add);
  }
  if (vm.todos.notice) body.append(node(doc, "p", "hm-side-card__empty", vm.todos.notice));
  else if (shown.length === 0) body.append(node(doc, "p", "hm-side-card__empty", "No open to-dos."));
  else { const list = node(doc, "ul", "hm-side-list hm-side-list--todos"); list.setAttribute("aria-label", "Open to-dos");
    for (const item of shown) list.append(todoRow(doc, item, vm.sample, callbacks)); body.append(list); }
  return root;
}

function objectsDoor(doc: Document, vm: SideCardsVM, callbacks: SideCardsCallbacks): HTMLElement {
  const state = vm.objects.state;
  const { root, body } = section(doc, "objects", state === "refused" ? LISTS_DOOR_TITLE : "Lists & docs");
  if (state === "refused") {
    body.append(node(doc, "p", "hm-side-card__empty", LISTS_DOOR_LEAD));
    if (!vm.sample) { const door = node(doc, "button", "hm-side-button hm-side-button--primary", LISTS_DOOR_TITLE); door.type = "button"; door.dataset.sideDoor = "";
      door.addEventListener("click", () => callbacks.onOpenLists()); body.append(door); }
  } else if (state === "failed") {
    body.append(node(doc, "p", "hm-side-card__empty", "Lists & docs could not check your access. Open it again to retry."));
    if (!vm.sample) body.append(link(doc, "Open Lists & docs", vm.hrefs.lists, "lists"));
  } else {
    const pending = node(doc, "p", "hm-side-card__empty", "Checking Lists & docs…"); root.setAttribute("aria-busy", "true"); body.append(pending);
  }
  return root;
}

/** Lists and Files (up to 5 each; the title opens all of them), or the single door when the read is refused. */
export function buildObjectsCards(doc: Document, vm: SideCardsVM, callbacks: SideCardsCallbacks): HTMLElement[] {
  const objects = vm.objects;
  if (objects.state !== "ready") return [objectsDoor(doc, vm, callbacks)];
  const make = (key: "lists" | "files", title: string, items: ObjectCardVM[]): HTMLElement => {
    const { root, body } = section(doc, key, title, vm.sample ? undefined : vm.hrefs[key]);
    const { shown, more } = sideCapObjects(items);
    headRow(doc, root, more);
    body.append(shown.length ? cardList(doc, vm.sample ? shown.map(item => Object.assign({ ...item }, { sample: true })) : shown, title) : node(doc, "p", "hm-side-card__empty", key === "lists" ? "No lists or docs yet." : "No files yet."));
    return root;
  };
  return [make("lists", "Lists", objects.lists), make("files", "Files", objects.files)];
}

/** "What’s shared here": the broad line for everyone, then one line per agent of the viewer's own. */
export function buildSharedCard(doc: Document, vm: SideCardsVM): HTMLElement {
  const { root, body } = section(doc, "shared", "What’s shared here");
  body.append(node(doc, "p", "hm-side-card__line", sharedEveryoneLine(vm.workspaceName)));
  for (const line of sharedAgentLines(vm.sharedAgents)) body.append(node(doc, "p", "hm-side-card__line", line));
  return root;
}

/** The right column in the order of UI-SPEC 3.3: To-dos, Lists, Files, What’s shared here, Wiki (ruling 4: one entry row, not a card). */
export function buildSideCards(doc: Document, vm: SideCardsVM, callbacks: SideCardsCallbacks): HTMLElement {
  const column = node(doc, "div", "hm-side"); column.dataset.homeSide = ""; if (vm.sample) column.dataset.sample = "true";
  const todos = buildTodosCard(doc, vm, callbacks); if (todos) column.append(todos);
  column.append(...buildObjectsCards(doc, vm, callbacks), buildSharedCard(doc, vm));
  const wiki = node(doc, "div", "hm-side-entry"); wiki.append(link(doc, "Wiki", vm.hrefs.wiki, "wiki", vm.sample)); column.append(wiki);
  return column;
}
