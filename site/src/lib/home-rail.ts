// Home UI left rail (UI-SPEC.md 1.1 and 2.4, lane R). Pure DOM: (doc, vm, callbacks) => HTMLElement.
// User and agent text goes in through textContent only. The rail has no management controls and
// no presence dot on people; a person row opens People & agents, an agent row opens the Agent view.
import { agentOrb, personAvatar, statusLine } from "./home-primitives";
import type { AgentVM, CapsuleVM, Id, PersonVM, RailVM } from "./home-types";

export const RAIL_WORKSPACE_CAP = 6;
export const RAIL_OWNERSHIP_NOTE = "Every agent belongs to a person, who connects it.";
export const RAIL_CATCH_UP_PEOPLE_TITLE = "You and your agents";

type RailWorkspace = RailVM["workspaces"][number];
type RailPeople = NonNullable<RailVM["people"]>;

export interface RailCallbacks {
  /** Optional in-app navigation for plain clicks on rail links. Without it the links navigate natively. */
  navigate?: (href: string, event: MouseEvent) => void;
  /** Opens People & agents with this person selected. */
  openPerson: (personId: Id) => void;
  /** Opens the Agent view for this agent. */
  openAgent: (agentId: Id) => void;
  /** Lets the page keep the "Show N more" state across rebuilds. */
  toggleWorkspaces?: (expanded: boolean) => void;
}

/** Local to this lane; home-types.ts has no rail options. */
export interface RailOptions {
  newWorkspaceHref?: string;
  /** Where the brand row links. Default: the site home. */
  brandHref?: string;
  workspacesExpanded?: boolean;
}

/**
 * At most six workspaces show; the rest wait behind "Show N more". The current workspace is never
 * hidden: if it sits past the cap it takes the sixth place (in its own position), so the first five
 * show with it and the count is everything else.
 */
export function railWorkspaceRows(workspaces: readonly RailWorkspace[], expanded: boolean) {
  const currentIndex = workspaces.findIndex((workspace) => workspace.current);
  const leading = currentIndex >= RAIL_WORKSPACE_CAP ? RAIL_WORKSPACE_CAP - 1 : RAIL_WORKSPACE_CAP;
  const rows = workspaces.map((workspace, index) => ({ workspace, overflow: index >= leading && index !== currentIndex }));
  const overflowCount = rows.filter((row) => row.overflow).length;
  return { rows: rows.map((row) => ({ ...row, hidden: row.overflow && !expanded })), overflowCount };
}

/** Duplicate names carry enough of the UUID to distinguish every matching membership. */
export function railWorkspaceIdentifier(workspace: RailWorkspace, workspaces: readonly RailWorkspace[]): string | null {
  const matches = workspaces.filter(row => row.name.trim().toLocaleLowerCase() === workspace.name.trim().toLocaleLowerCase());
  if (matches.length < 2) return null;
  let length = 8;
  while (length < workspace.id.length && matches.some(row => row.id !== workspace.id && row.id.slice(0, length) === workspace.id.slice(0, length))) ++length;
  return workspace.id.slice(0, length);
}

export function railMoreLabel(overflowCount: number, expanded: boolean): string | null {
  if (overflowCount <= 0) return null;
  return expanded ? "Show fewer" : `Show ${overflowCount} more`;
}

/** A badge only for a measured count above zero. null (not measured) and 0 show nothing. */
export function needsYouBadge(count: number | null): { text: string; label: string } | null {
  if (count === null || !Number.isFinite(count) || count <= 0) return null;
  const whole = Math.floor(count);
  return { text: whole > 99 ? "99+" : String(whole), label: `${whole} ${whole === 1 ? "needs" : "need"} you` };
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const comparePeople = (left: PersonVM, right: PersonVM): number =>
  Number(right.you) - Number(left.you) || compareText(left.name.toLowerCase(), right.name.toLowerCase()) || compareText(left.id, right.id);
const compareAgents = (left: AgentVM, right: AgentVM): number =>
  compareText(left.nestedLabel.toLowerCase(), right.nestedLabel.toLowerCase()) || compareText(left.id, right.id);

/** You first with your agents, then everyone else alphabetically with theirs. */
export function orderCapsules(groups: readonly CapsuleVM[]): CapsuleVM[] {
  return [...groups].sort((left, right) => comparePeople(left.person, right.person))
    .map((group) => ({ person: group.person, agents: [...group.agents].sort(compareAgents) }));
}

/** The rail order: you, then everyone else alphabetically, then "Other agents" (owner left). */
export function orderRailPeople(people: RailPeople): RailPeople {
  return { title: people.title, groups: orderCapsules(people.groups), other: [...people.other].sort(compareAgents) };
}

/** On Catch up the section narrows to the viewer and the viewer's own agents. */
export function narrowRailPeopleToViewer(people: RailPeople): RailPeople {
  return {
    title: RAIL_CATCH_UP_PEOPLE_TITLE,
    groups: people.groups.filter((group) => group.person.you)
      .map((group) => ({ person: group.person, agents: group.agents.filter((agent) => agent.yours) })),
    other: [],
  };
}

export function railPersonName(person: PersonVM): string {
  return `${person.name}${person.you ? " (you)" : ""}${person.dashed ? ", invited" : ""}`;
}

/** The owner phrase the rail announces with an agent. Null when the owner has left. */
export function railAgentOwnerPhrase(agent: AgentVM): string | null {
  return agent.yours ? "your agent" : agent.ownerFirstName ? `${agent.ownerFirstName}’s agent` : null;
}

/** "Muse, Nikki’s agent, Idle, Active 2 hours ago". The measured detail is always in the name. */
export function railAgentName(agent: AgentVM): string {
  return [agent.nestedLabel, railAgentOwnerPhrase(agent), agent.state.word, agent.state.detail].filter((part) => part).join(", ");
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function link(doc: Document, href: string, className: string, callbacks: RailCallbacks): HTMLAnchorElement {
  const element = node(doc, "a", className);
  element.href = href;
  element.addEventListener("click", (event) => {
    if (!callbacks.navigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    callbacks.navigate(href, event);
  });
  return element;
}

/** A decorative 18px line icon. Its shape is a CSS mask in rail.css and its colour is currentColor. */
function icon(doc: Document, name: "inbox" | "workspace" | "plus"): HTMLElement {
  const mark = node(doc, "span", "hm-rail__icon");
  mark.dataset.icon = name;
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** The two-shape mark: a lime circle and an outlined rounded square, drawn by rail.css. */
function brandMark(doc: Document): HTMLElement {
  const mark = node(doc, "span", "hm-rail__mark");
  mark.setAttribute("aria-hidden", "true");
  mark.append(node(doc, "span", "hm-rail__mark-dot"), node(doc, "span", "hm-rail__mark-square"));
  return mark;
}

function badge(doc: Document, count: number | null): HTMLElement[] {
  const value = needsYouBadge(count);
  if (!value) return [];
  const mark = node(doc, "span", "hm-rail__badge", value.text);
  mark.setAttribute("aria-hidden", "true");
  return [mark, node(doc, "span", "hm-rail__sr", `, ${value.label}`)];
}

/** Sample mode renders no actions, so its rows are plain text. */
function interactiveRow(doc: Document, className: string, sample: boolean, open: () => void): HTMLElement {
  if (sample) return node(doc, "div", className);
  const row = node(doc, "button", className);
  row.type = "button";
  row.addEventListener("click", open);
  return row;
}

function personRow(doc: Document, person: PersonVM, sample: boolean, callbacks: RailCallbacks): HTMLElement {
  const row = interactiveRow(doc, "hm-rail__person", sample, () => callbacks.openPerson(person.id));
  row.dataset.railPerson = person.id;
  row.setAttribute("aria-label", railPersonName(person));
  const face = node(doc, "span", "hm-rail__face");
  face.setAttribute("aria-hidden", "true");
  face.append(personAvatar(doc, person, 24));
  const name = node(doc, "span", "hm-rail__name", person.name);
  name.title = person.name;
  row.append(face, name);
  if (person.you) row.append(node(doc, "span", "hm-rail__you", "you"));
  return row;
}

function agentRow(doc: Document, agent: AgentVM, sample: boolean, callbacks: RailCallbacks): HTMLLIElement {
  const item = node(doc, "li", "hm-rail__agent-item");
  const row = interactiveRow(doc, "hm-rail__agent", sample, () => callbacks.openAgent(agent.id));
  row.dataset.railAgent = agent.id;
  row.dataset.agentState = agent.state.kind;
  row.setAttribute("aria-label", railAgentName(agent));
  const orb = node(doc, "span", "hm-rail__orb");
  orb.setAttribute("aria-hidden", "true");
  orb.append(agentOrb(doc, agent, { size: 22, badge: false }));
  const name = node(doc, "span", "hm-rail__name", agent.nestedLabel);
  name.title = agent.nestedLabel;
  const status = node(doc, "span", "hm-rail__status");
  status.append(statusLine(doc, agent.state, { form: "word" }));
  row.append(orb, name, status);
  item.append(row);
  return item;
}

function group(doc: Document, capsule: CapsuleVM, sample: boolean, callbacks: RailCallbacks): HTMLLIElement {
  const item = node(doc, "li", "hm-rail__group");
  if (capsule.person.you) item.dataset.railViewer = "";
  item.append(personRow(doc, capsule.person, sample, callbacks));
  if (capsule.agents.length) {
    const agents = node(doc, "ul", "hm-rail__agents");
    agents.setAttribute("aria-label", `${capsule.person.you ? "Your" : `${capsule.person.firstName}’s`} agents`);
    for (const agent of capsule.agents) agents.append(agentRow(doc, agent, sample, callbacks));
    item.append(agents);
  }
  return item;
}

/** The left rail: brand row, Catch up, Workspaces, People & agents, the ownership line and New workspace. */
export function buildHomeRail(doc: Document, vm: RailVM, callbacks: RailCallbacks, options: RailOptions = {}): HTMLElement {
  const root = node(doc, "div", "hm-rail");
  root.dataset.homeRail = "";

  const brand = node(doc, "a", "hm-rail__brand");
  brand.href = options.brandHref ?? "/";
  brand.append(brandMark(doc), node(doc, "span", "hm-rail__brand-word", "CommonSwarm"));
  root.append(brand);

  const nav = node(doc, "nav", "hm-rail__nav");
  nav.setAttribute("aria-label", "Home");
  const catchUp = link(doc, vm.catchUp.href, "hm-rail__link hm-rail__catch-up", callbacks);
  catchUp.dataset.homeCatchUp = "";
  if (vm.catchUp.current) catchUp.setAttribute("aria-current", "page");
  catchUp.append(icon(doc, "inbox"), node(doc, "span", "hm-rail__name", "Catch up"), ...badge(doc, vm.catchUp.needsYou));
  nav.append(catchUp);

  const workspaces = node(doc, "section", "hm-rail__workspaces");
  workspaces.setAttribute("aria-labelledby", "hm-rail-workspaces-title");
  const workspacesTitle = node(doc, "h2", "hm-rail__heading", "Workspaces");
  workspacesTitle.id = "hm-rail-workspaces-title";
  const list = node(doc, "ul", "hm-rail__workspace-list");
  list.id = "hm-rail-workspace-list";
  list.dataset.homeWorkspaceList = "";
  let expanded = options.workspacesExpanded === true;
  const { rows, overflowCount } = railWorkspaceRows(vm.workspaces, expanded);
  for (const { workspace, overflow, hidden } of rows) {
    const item = node(doc, "li", "hm-rail__workspace-item");
    if (overflow) item.dataset.railOverflow = "";
    item.hidden = hidden;
    const row = link(doc, workspace.href, "hm-rail__link hm-rail__workspace", callbacks);
    row.dataset.railWorkspace = workspace.id;
    if (workspace.current) row.setAttribute("aria-current", "page");
    if (needsYouBadge(workspace.needsYou)) row.dataset.railAttention = "";
    const name = node(doc, "span", "hm-rail__name", workspace.name);
    name.title = workspace.name;
    row.append(icon(doc, "workspace"), name);
    const shortId = railWorkspaceIdentifier(workspace, vm.workspaces);
    if (shortId) { const identifier = node(doc, "span", "hm-rail__identifier", shortId); identifier.title = workspace.id; row.append(identifier); }
    row.append(...badge(doc, workspace.needsYou));
    item.append(row);
    list.append(item);
  }
  workspaces.append(workspacesTitle, list);
  const moreLabel = railMoreLabel(overflowCount, expanded);
  if (moreLabel) {
    const more = node(doc, "button", "hm-rail__more", moreLabel);
    more.type = "button";
    more.setAttribute("aria-expanded", String(expanded));
    more.setAttribute("aria-controls", list.id);
    more.addEventListener("click", () => {
      expanded = !expanded;
      for (const item of list.querySelectorAll<HTMLLIElement>("[data-rail-overflow]")) item.hidden = !expanded;
      more.textContent = railMoreLabel(overflowCount, expanded);
      more.setAttribute("aria-expanded", String(expanded));
      callbacks.toggleWorkspaces?.(expanded);
    });
    workspaces.append(more);
  }
  nav.append(workspaces);
  root.append(nav);

  if (vm.people) {
    const people = orderRailPeople(vm.catchUp.current ? narrowRailPeopleToViewer(vm.people) : vm.people);
    const section = node(doc, "section", "hm-rail__people");
    section.setAttribute("aria-labelledby", "hm-rail-people-title");
    const title = node(doc, "h2", "hm-rail__heading", people.title);
    title.id = "hm-rail-people-title";
    const peopleList = node(doc, "ul", "hm-rail__people-list");
    peopleList.dataset.sidebarParticipantList = "";
    for (const capsule of people.groups) peopleList.append(group(doc, capsule, vm.sample, callbacks));
    if (people.other.length) {
      const item = node(doc, "li", "hm-rail__group hm-rail__group--other");
      const head = node(doc, "p", "hm-rail__other-head", "Other agents");
      head.id = "hm-rail-other-title";
      const agents = node(doc, "ul", "hm-rail__agents");
      agents.setAttribute("aria-labelledby", head.id);
      for (const agent of people.other) agents.append(agentRow(doc, agent, vm.sample, callbacks));
      item.append(head, agents);
      peopleList.append(item);
    }
    section.append(title, peopleList, node(doc, "p", "hm-rail__note", RAIL_OWNERSHIP_NOTE));
    root.append(section);
  }
  /* New workspace is the outline button pinned to the foot of the rail. A sample has no doors. */
  if (!vm.sample) {
    const foot = node(doc, "div", "hm-rail__foot");
    const create = link(doc, options.newWorkspaceHref ?? "?v=new", "hm-rail__new", callbacks);
    create.dataset.homeNewWorkspace = "";
    create.append(icon(doc, "plus"), node(doc, "span", "hm-rail__new-label", "New workspace"));
    foot.append(create);
    root.append(foot);
  }
  return root;
}
