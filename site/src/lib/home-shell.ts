// Home UI shell (UI-SPEC.md 1.1 and 3.3, lane R): the workspace header, the stream header's channel
// menu, the phone top bar, the phone bottom nav and the tablet tab row. Pure DOM builders; user text
// goes in through textContent only. The shipped hooks (data-roster-open, data-workspace-view,
// data-workspace-settings-item, data-admin-access-open, data-channel-*) are kept so the page wiring
// can find them.
import { ALL_SIGNALS_SLUG, channelLabel } from "./channels";
import { capsule } from "./home-primitives";
import { orderCapsules } from "./home-rail";
import type { CapsuleVM, Id } from "./home-types";

export type WorkspacePane = "chat" | "todos" | "lists" | "files";
export type WorkspaceMenuItem = "wiki" | "settings" | "admin-access";

/** Local to this lane; home-types.ts has no shell view model. */
export interface WorkspaceShellVM {
  sample: boolean;
  workspaceId: Id;
  name: string;
  /** Everyone in the workspace with their agents (any order; the shell puts you first). */
  people: CapsuleVM[];
  pane: WorkspacePane;
  hrefs: { chat: string; todos: string; lists: string; files: string; wiki: string; workspaces: string };
  /** False while the to-dos read is absent: every To-dos entry hides. Nothing is faked. */
  todosAvailable: boolean;
  /** Which management doors the server allows this viewer. The menu claims nothing else. */
  menu: { settings: boolean; adminAccess: boolean };
}

export interface ShellCallbacks {
  /** Optional in-app navigation for plain clicks on shell links. Without it the links navigate natively. */
  navigate?: (href: string, event: MouseEvent) => void;
  /** Opens People & agents (the dialog, or the sheet on a phone). */
  openPeople: () => void;
  /** The phone "Workspaces" chevron. The page decides between history.back() and its parent route. */
  back?: (event: MouseEvent) => void;
  menu: (item: WorkspaceMenuItem) => void;
}

export const PANE_LABELS: Record<WorkspacePane, string> = { chat: "Chat", todos: "To-dos", lists: "Lists", files: "Files" };
const PANES: WorkspacePane[] = ["chat", "todos", "lists", "files"];

/** "Claude", "Claude and dot", "Claude, dot and Grok". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "You with Claude and dot · Nikki with Muse", two people, then "+N" for the rest. */
export function capsuleSubline(groups: readonly CapsuleVM[]): string {
  const ordered = orderCapsules(groups);
  const parts = ordered.slice(0, 2).map(({ person, agents }) => {
    const who = person.you ? "You" : person.firstName || person.name;
    return agents.length ? `${who} with ${joinNames(agents.map((agent) => agent.nestedLabel))}` : who;
  });
  if (ordered.length > 2) parts.push(`+${ordered.length - 2}`);
  return parts.join(" · ");
}

/** Chat, To-dos, Lists, Files. To-dos is left out while its read is absent. */
export function workspaceNavItems(vm: Pick<WorkspaceShellVM, "pane" | "hrefs" | "todosAvailable">) {
  return PANES.filter((pane) => pane !== "todos" || vm.todosAvailable)
    .map((pane) => ({ pane, label: PANE_LABELS[pane], href: vm.hrefs[pane], current: pane === vm.pane }));
}

/**
 * Wiki, then Workspace settings and Admin access and history only where allowed. A sample renders
 * no doors (UI-SPEC 2 and 3.3), so its menu is empty and the ⋯ button is left out.
 */
export function workspaceMenuItems(vm: Pick<WorkspaceShellVM, "sample" | "menu">): { item: WorkspaceMenuItem; label: string }[] {
  if (vm.sample) return [];
  return [
    { item: "wiki" as const, label: "Wiki" },
    ...(vm.menu.settings ? [{ item: "settings" as const, label: "Workspace settings" }] : []),
    ...(vm.menu.adminAccess ? [{ item: "admin-access" as const, label: "Admin access and history" }] : []),
  ];
}

/** The doors the shell renders. A sample has none: no People & agents button and no ⋯ menu. */
export function shellDoors(vm: Pick<WorkspaceShellVM, "sample" | "menu">): { people: boolean; menu: boolean } {
  return { people: !vm.sample, menu: workspaceMenuItems(vm).length > 0 };
}

/** Menu keyboard model: the next focused index for a key, or null when the key is not the menu's. */
export function menuFocusIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function link(doc: Document, href: string, className: string, callbacks: Pick<ShellCallbacks, "navigate">): HTMLAnchorElement {
  const element = node(doc, "a", className);
  element.href = href;
  element.addEventListener("click", (event) => {
    if (!callbacks.navigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    callbacks.navigate(href, event);
  });
  return element;
}

function chevron(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "hm-icon");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M14 6l-6 6 6 6");
  svg.append(path);
  return svg;
}

function title(doc: Document, text: string, id: string, className: string): HTMLHeadingElement {
  const heading = node(doc, "h1", className, text);
  heading.id = id;
  heading.tabIndex = -1;
  return heading;
}

function compactCapsules(doc: Document, people: readonly CapsuleVM[], limit: number): HTMLElement {
  const stack = node(doc, "span", "hm-capsule-stack");
  for (const group of orderCapsules(people).slice(0, limit)) stack.append(capsule(doc, group, { compact: true }));
  return stack;
}

/** The workspace ⋯ menu: a menu button with Wiki, Workspace settings and Admin access and history. */
export function buildWorkspaceMenu(doc: Document, vm: WorkspaceShellVM, callbacks: ShellCallbacks, idPrefix: string): HTMLElement {
  const wrap = node(doc, "div", "hm-menu");
  const trigger = node(doc, "button", "hm-menu__trigger", "⋯");
  trigger.type = "button";
  trigger.id = `${idPrefix}-menu-trigger`;
  trigger.setAttribute("aria-label", `More for ${vm.name}`);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const menu = node(doc, "ul", "hm-menu__list");
  menu.id = `${idPrefix}-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-labelledby", trigger.id);
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);
  const items: HTMLButtonElement[] = [];
  const close = (focusTrigger: boolean) => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) trigger.focus({ preventScroll: true });
  };
  const open = (index: number) => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    items[index]?.focus({ preventScroll: true });
  };
  for (const { item, label } of workspaceMenuItems(vm)) {
    const entry = node(doc, "li", "hm-menu__entry");
    entry.setAttribute("role", "none");
    const button = node(doc, "button", "hm-menu__item", label);
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    if (item === "wiki") button.dataset.workspaceView = "brain";
    if (item === "settings") {
      button.dataset.workspaceSettingsItem = "";
      button.dataset.workspaceDetailsTrigger = "";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "dashboard-workspace-details");
    }
    if (item === "admin-access") { button.dataset.adminAccessOpen = ""; button.dataset.adminAccessScope = "workspace"; }
    button.addEventListener("click", () => { close(false); callbacks.menu(item); });
    entry.append(button);
    menu.append(entry);
    items.push(button);
  }
  trigger.addEventListener("click", () => (menu.hidden ? open(0) : close(false)));
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowDown" ? 0 : items.length - 1);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(false); return; }
    const next = menuFocusIndex(items.indexOf(doc.activeElement as HTMLButtonElement), event.key, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
  });
  wrap.addEventListener("focusout", (event) => {
    if (!menu.hidden && !wrap.contains(event.relatedTarget as Node | null)) close(false);
  });
  wrap.append(trigger, menu);
  return wrap;
}

/** Desktop and tablet workspace header: H1, capsule subline, People & agents and the ⋯ menu. */
export function buildWorkspaceHeader(doc: Document, vm: WorkspaceShellVM, callbacks: ShellCallbacks): HTMLElement {
  const header = node(doc, "header", "hm-ws-header");
  header.dataset.homeWorkspaceHeader = vm.workspaceId;
  const copy = node(doc, "div", "hm-ws-header__copy");
  copy.append(title(doc, vm.name, "hm-ws-title", "hm-ws-header__title"), node(doc, "p", "hm-ws-header__subline", capsuleSubline(vm.people)));
  const actions = node(doc, "div", "hm-ws-header__actions");
  const faces = compactCapsules(doc, vm.people, 2);
  faces.setAttribute("aria-hidden", "true");
  actions.append(faces);
  const doors = shellDoors(vm);
  if (doors.people) {
    const people = node(doc, "button", "hm-ws-header__people", "People & agents");
    people.type = "button";
    people.dataset.rosterOpen = "";
    people.addEventListener("click", () => callbacks.openPeople());
    actions.append(people);
  }
  if (doors.menu) actions.append(buildWorkspaceMenu(doc, vm, callbacks, "hm-ws"));
  header.append(copy, actions);
  return header;
}

/** Local to this lane: the stream header's channel menu. */
export interface ChannelMenuVM { sample: boolean; label: string }

/**
 * Stream header "All messages ▾". A disclosure that holds the existing channel hooks: the page's
 * channel renderer fills [data-channel-list] and owns aria-current on [data-channel-place].
 */
export function buildChannelMenu(doc: Document, vm: ChannelMenuVM, callbacks: { toggle?: (open: boolean) => void } = {}): HTMLElement {
  const wrap = node(doc, "div", "hm-channel-menu");
  wrap.dataset.homeChannelMenu = "";
  const trigger = node(doc, "button", "hm-channel-menu__trigger");
  trigger.type = "button";
  trigger.id = "hm-channel-menu-trigger";
  trigger.setAttribute("aria-expanded", "false");
  const label = node(doc, "span", "hm-channel-menu__label", vm.label);
  label.dataset.channelMenuLabel = "";
  const caret = node(doc, "span", "hm-channel-menu__caret", "▾");
  caret.setAttribute("aria-hidden", "true");
  trigger.append(label, caret);
  const panel = node(doc, "div", "hm-channel-menu__panel");
  panel.id = "hm-channel-menu-panel";
  panel.hidden = true;
  trigger.setAttribute("aria-controls", panel.id);
  const all = node(doc, "button", "hm-channel-menu__item", channelLabel(ALL_SIGNALS_SLUG));
  all.type = "button";
  all.dataset.workspaceView = "signals";
  all.dataset.channelPlace = "";
  const list = node(doc, "div", "hm-channel-menu__list");
  list.dataset.channelList = "";
  const create = node(doc, "button", "hm-channel-menu__item hm-channel-menu__new");
  create.type = "button";
  create.dataset.channelNew = "";
  create.hidden = vm.sample;
  const plus = node(doc, "span", "", "+");
  plus.setAttribute("aria-hidden", "true");
  create.append(plus, node(doc, "span", "", "New channel"));
  panel.append(all, list, create);
  const set = (open: boolean, focusTrigger: boolean) => {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    callbacks.toggle?.(open);
    if (!open && focusTrigger) trigger.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", () => set(!!panel.hidden, false));
  panel.addEventListener("click", (event) => { if ((event.target as Element | null)?.closest("button")) set(false, false); });
  wrap.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.preventDefault(); event.stopPropagation(); set(false, true);
  });
  wrap.addEventListener("focusout", (event) => {
    if (!panel.hidden && !wrap.contains(event.relatedTarget as Node | null)) set(false, false);
  });
  wrap.append(trigger, panel);
  return wrap;
}

/** Phone top bar: 44 px "Workspaces" chevron, H1, compact capsule stack (opens People & agents), ⋯. */
export function buildPhoneTopBar(doc: Document, vm: WorkspaceShellVM, callbacks: ShellCallbacks): HTMLElement {
  const bar = node(doc, "header", "hm-phone-bar");
  bar.dataset.homePhoneBar = vm.workspaceId;
  const back = link(doc, vm.hrefs.workspaces, "hm-phone-bar__back", { navigate: callbacks.back ? (_href, event) => callbacks.back?.(event) : callbacks.navigate });
  back.dataset.homeBack = "";
  back.append(chevron(doc), node(doc, "span", "hm-sr", "Workspaces"));
  const doors = shellDoors(vm);
  const faces = compactCapsules(doc, vm.people, 2);
  faces.setAttribute("aria-hidden", "true");
  let people: HTMLElement;
  if (doors.people) {
    const button = node(doc, "button", "hm-phone-bar__people");
    button.type = "button";
    button.setAttribute("aria-label", `People & agents: ${capsuleSubline(vm.people)}`);
    button.addEventListener("click", () => callbacks.openPeople());
    people = button;
  } else {
    /* A sample shows who is here but opens nothing. */
    people = node(doc, "span", "hm-phone-bar__people hm-phone-bar__people--static");
    people.append(node(doc, "span", "hm-sr", capsuleSubline(vm.people)));
  }
  people.append(faces);
  bar.append(back, title(doc, vm.name, "hm-phone-title", "hm-phone-bar__title"), people);
  if (doors.menu) bar.append(buildWorkspaceMenu(doc, vm, callbacks, "hm-phone"));
  return bar;
}

/** Phone bottom nav or tablet tab row: links with aria-current="page", not ARIA tabs (they change the URL). */
export function buildWorkspaceNav(doc: Document, vm: WorkspaceShellVM, callbacks: Pick<ShellCallbacks, "navigate">, variant: "phone" | "tablet"): HTMLElement {
  const nav = node(doc, "nav", `hm-ws-nav hm-ws-nav--${variant}`);
  nav.setAttribute("aria-label", `${vm.name} sections`);
  nav.dataset.homeWorkspaceNav = variant;
  const list = node(doc, "ul", "hm-ws-nav__list");
  for (const item of workspaceNavItems(vm)) {
    const entry = node(doc, "li", "hm-ws-nav__entry");
    const anchor = link(doc, item.href, "hm-ws-nav__link", callbacks);
    anchor.dataset.homePane = item.pane;
    anchor.textContent = item.label;
    if (item.current) anchor.setAttribute("aria-current", "page");
    entry.append(anchor);
    list.append(entry);
  }
  nav.append(list);
  return nav;
}
