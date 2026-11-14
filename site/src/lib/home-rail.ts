// Home UI left rail (UI-SPEC.md 1.1 and 2.4, lane R). Pure DOM: (doc, vm, callbacks) => HTMLElement.
// User and agent text goes in through textContent only. The rail has no management controls and
// no presence dot on people; a person row opens People & agents, an agent row opens the Agent view.
import { agentOrb, personAvatar, statusLine } from "./home-primitives";
import type { AgentVM, CapsuleVM, Id, PersonVM, RailVM } from "./home-types";
import { ARCHIVED_CHANNELS_LABEL, CHANNELS_LOAD_FAILED, CHANNELS_TITLE, NEW_CHANNEL_LABEL, STARRED_TITLE, channelLabel, channelRowName, railSlice } from "./channels";

export const RAIL_OWNERSHIP_NOTE = "Every agent belongs to a person, who connects it.";
export const RAIL_CATCH_UP_PEOPLE_TITLE = "You and your agents";
/** The selected workspace's channels, then people and agents as 1:1 Direct messages. Workspaces are switched in the
 *  picker above the rail, never here. */
export const RAIL_DIRECT_MESSAGES_TITLE = "Direct messages";

type RailWorkspace = RailVM["workspaces"][number];
type RailPeople = NonNullable<RailVM["people"]>;

export interface RailCallbacks {
  /** Optional in-app navigation for plain clicks on rail links. Without it the links navigate natively. */
  navigate?: (href: string, event: MouseEvent) => void;
  /** Opens People & agents with this person selected. */
  openPerson: (personId: Id) => void;
  /** Opens the Agent view for this agent. */
  openAgent: (agentId: Id) => void;
  /** Lets the page keep the channels' "Show N more" state across rebuilds. */
  toggleChannels?: (expanded: boolean) => void;
  /** Lets the page keep the Archived channels disclosure open across rebuilds. */
  toggleArchived?: (open: boolean) => void;
  /** A plain click on a channel row. Without it the row navigates natively. */
  selectChannel?: (channelId: string, event: MouseEvent) => void;
  /** The row's ⋯ button. The page decides the actions (rename, archive). */
  channelMenu?: (channelId: string, event: MouseEvent, button: HTMLElement) => void;
  /** Alt+Arrow on a row the viewer may move: one step up or down its list. */
  moveChannel?: (list: RailOrderList, channelId: string, step: -1 | 1) => void;
  /** A row dragged onto another row of the same list. */
  dropChannel?: (list: RailOrderList, channelId: string, ontoId: string) => void;
  /** The Channels heading's +. */
  newChannel?: (button: HTMLElement) => void;
  browseChannels?: (button: HTMLElement) => void;
  /** "Retry" after the channel list failed to load. */
  retryChannels?: () => void;
  /** Right-click (or Shift+F10 / the Menu key) on a Direct messages row. The page decides the actions. */
  contextMenu?: (target: { kind: "person" | "agent"; id: Id }, event: MouseEvent, row: HTMLElement) => void;
}

/** The rail model plus the agent whose page is open (home-types.ts RailVM is frozen). */
export type HomeRailVM = RailVM & {
  currentAgentId?: Id;
  /** The teammate whose 1:1 Direct Message is open in Chat. */
  currentDmId?: Id;
  /** The workspace Lead agent: tagged "Lead" in Direct messages. */
  leadAgentId?: Id;
  /** The selected workspace's channels. Absent where no workspace is selected (Catch up). */
  channels?: RailChannelsVM;
};

/** One channel row. `id` is the view id: GENERAL_CHANNEL_ID for #general, otherwise the channel's id. */
export interface RailChannelRowVM {
  id: string;
  slug: string;
  href: string;
  current: boolean;
  /** As the per-channel read reported it. null is unknown: no dot and no claim of "read". */
  unread: boolean | null;
  /** Rename and archive are offered (the creator, or a workspace owner or admin). */
  manageable: boolean;
  /** The viewer muted this channel: the row is quiet and never shows unread. */
  muted?: boolean;
  /** The viewer may move this row within its list: their own Starred order, or (an owner or admin) the shared one. */
  reorder?: RailOrderList;
}

export type RailOrderList = "starred" | "channels";

export interface RailChannelsVM {
  /** loading: the list for this workspace has not been read yet. failed: the latest read failed. */
  state: "loading" | "ready" | "failed";
  general: RailChannelRowVM;
  /** The places the viewer starred, in their own order. Each is left out of the list below, #general included. */
  starred?: RailChannelRowVM[];
  /** Live named channels that are not starred, in rail order. */
  channels: RailChannelRowVM[];
  /** Archived channels, in rail order. */
  archived: RailChannelRowVM[];
  mayCreate: boolean;
}

/** Local to this lane; home-types.ts has no rail options. */
export interface RailOptions {
  /** Where the brand row links. Default: the site home. */
  brandHref?: string;
  channelsExpanded?: boolean;
  archivedOpen?: boolean;
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

/** The viewer and the viewer's own agents only. The rail no longer narrows (it lists everyone the viewer
 *  shares a workspace with, home-map homeRailPeople); kept for callers that want the viewer's own group. */
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
function icon(doc: Document, name: "inbox" | "workspace" | "plus" | "archive"): HTMLElement {
  const mark = node(doc, "span", "hm-rail__icon");
  mark.dataset.icon = name;
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** Shared CommonSwarm mark. */
function brandMark(doc: Document): HTMLElement {
  const mark = node(doc, "span", "hm-rail__mark");
  mark.setAttribute("aria-hidden", "true");
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

function personRow(doc: Document, person: PersonVM, sample: boolean, callbacks: RailCallbacks, currentDmId?: Id): HTMLElement {
  const row = interactiveRow(doc, "hm-rail__person", sample, () => callbacks.openPerson(person.id));
  row.dataset.railPerson = person.id;
  if (!sample && callbacks.contextMenu) row.addEventListener("contextmenu", event => callbacks.contextMenu?.({ kind: "person", id: person.id }, event, row));
  if (currentDmId === person.id) row.setAttribute("aria-current", "page");
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

function agentRow(doc: Document, agent: AgentVM, sample: boolean, callbacks: RailCallbacks, currentAgentId?: Id, currentDmId?: Id, leadAgentId?: Id): HTMLLIElement {
  const item = node(doc, "li", "hm-rail__agent-item");
  const row = interactiveRow(doc, "hm-rail__agent", sample, () => callbacks.openAgent(agent.id));
  row.dataset.railAgent = agent.id;
  if (!sample && callbacks.contextMenu) row.addEventListener("contextmenu", event => callbacks.contextMenu?.({ kind: "agent", id: agent.id }, event, row));
  if (currentAgentId === agent.id || currentDmId === agent.id) row.setAttribute("aria-current", "page");
  row.dataset.agentState = agent.state.kind;
  row.setAttribute("aria-label", railAgentName(agent));
  const orb = node(doc, "span", "hm-rail__orb");
  orb.setAttribute("aria-hidden", "true");
  orb.append(agentOrb(doc, agent, { size: 22, badge: false }));
  const name = node(doc, "span", "hm-rail__name", agent.nestedLabel);
  name.title = agent.nestedLabel;
  const status = node(doc, "span", "hm-rail__status");
  status.append(statusLine(doc, agent.state, { form: "word" }));
  row.append(orb, name);
  if (leadAgentId === agent.id) { row.dataset.railLead = ""; row.append(node(doc, "span", "hm-rail__lead", "Lead")); }
  row.append(status);
  item.append(row);
  return item;
}

function group(doc: Document, capsule: CapsuleVM, sample: boolean, callbacks: RailCallbacks, currentAgentId?: Id, currentDmId?: Id, leadAgentId?: Id): HTMLLIElement {
  const item = node(doc, "li", "hm-rail__group");
  if (capsule.person.you) item.dataset.railViewer = "";
  item.append(personRow(doc, capsule.person, sample, callbacks, currentDmId));
  if (capsule.agents.length) {
    const agents = node(doc, "ul", "hm-rail__agents");
    agents.setAttribute("aria-label", `${capsule.person.you ? "Your" : `${capsule.person.firstName}’s`} agents`);
    for (const agent of capsule.agents) agents.append(agentRow(doc, agent, sample, callbacks, currentAgentId, currentDmId, leadAgentId));
    item.append(agents);
  }
  return item;
}

/** #general, then live channels; the compact list holds six rows (railSlice in channels.ts). */
export function railChannelRows(channels: RailChannelsVM, expanded: boolean) {
  return railSlice(channels.channels, channels.channels.findIndex((row) => row.current), expanded);
}

function channelLink(doc: Document, row: RailChannelRowVM, archived: boolean, callbacks: RailCallbacks): HTMLAnchorElement {
  const link = node(doc, "a", "hm-rail__link hm-rail__channel");
  link.href = row.href;
  link.dataset.railChannel = row.id;
  if (row.current) link.setAttribute("aria-current", "page");
  const muted = !archived && row.muted === true;
  const unread = archived ? null : muted ? false : row.unread;
  if (unread === true) link.dataset.unread = "";
  if (muted) link.dataset.muted = "";
  link.setAttribute("aria-label", channelRowName(row.slug, unread, muted));
  link.title = channelLabel(row.slug);
  const name = node(doc, "span", "hm-rail__name", row.slug);
  link.append(icon(doc, archived ? "archive" : "workspace"), name);
  if (unread === true) { const dot = node(doc, "span", "hm-rail__unread"); dot.setAttribute("aria-hidden", "true"); link.append(dot); }
  if (muted) { const off = node(doc, "span", "hm-rail__muted"); off.setAttribute("aria-hidden", "true"); link.append(off); }
  link.addEventListener("click", (event) => {
    if (!callbacks.selectChannel || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    callbacks.selectChannel(row.id, event);
  });
  return link;
}

/* The row being dragged, between dragstart and dragend. A drag's data cannot be read while it is over a
   target, so the rail remembers it; only one drag exists at a time. */
let draggedRow: { list: RailOrderList; id: string } | null = null;

/** A row the viewer may move: Alt+Arrow steps it, and it can be dragged onto another row of its list. */
function makeReorderable(item: HTMLLIElement, link: HTMLAnchorElement, row: RailChannelRowVM, list: RailOrderList, callbacks: RailCallbacks): void {
  item.dataset.railReorder = list;
  link.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  link.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    callbacks.moveChannel?.(list, row.id, event.key === "ArrowUp" ? -1 : 1);
  });
  if (!callbacks.dropChannel) return;
  item.draggable = true;
  item.addEventListener("dragstart", (event) => {
    draggedRow = { list, id: row.id };
    event.dataTransfer?.setData("text/plain", row.slug);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    item.dataset.railDragging = "";
  });
  item.addEventListener("dragend", () => { draggedRow = null; delete item.dataset.railDragging; });
  const accepts = (): boolean => draggedRow !== null && draggedRow.list === list && draggedRow.id !== row.id;
  item.addEventListener("dragover", (event) => {
    if (!accepts()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    item.dataset.railDrop = "";
  });
  item.addEventListener("dragleave", () => { delete item.dataset.railDrop; });
  item.addEventListener("drop", (event) => {
    delete item.dataset.railDrop;
    if (!accepts()) return;
    event.preventDefault();
    const moved = draggedRow!.id;
    draggedRow = null;
    callbacks.dropChannel?.(list, moved, row.id);
  });
}

/** One row: the link, and beside it (never inside it) the ⋯ button where an action exists. */
function channelItem(doc: Document, row: RailChannelRowVM, archived: boolean, sample: boolean, callbacks: RailCallbacks): HTMLLIElement {
  const item = node(doc, "li", "hm-rail__channel-item");
  const link = channelLink(doc, row, archived, callbacks);
  item.append(link);
  const reorder = !sample && !archived && callbacks.moveChannel ? row.reorder : undefined;
  if (reorder) makeReorderable(item, link, row, reorder, callbacks);
  if (!sample && (row.manageable || reorder) && callbacks.channelMenu) {
    const actions = node(doc, "button", "hm-rail__channel-actions");
    actions.type = "button";
    actions.dataset.railChannelMenu = row.id;
    actions.setAttribute("aria-haspopup", "menu");
    actions.setAttribute("aria-label", `${channelLabel(row.slug)} options`);
    actions.title = `${channelLabel(row.slug)} options`;
    const glyph = node(doc, "span", "", "⋯");
    glyph.setAttribute("aria-hidden", "true");
    actions.append(glyph);
    actions.addEventListener("click", (event) => callbacks.channelMenu?.(row.id, event, actions));
    item.append(actions);
  }
  return item;
}

/** The viewer's starred places, above Channels. Absent when nothing is starred: an empty heading says nothing. */
function starredSection(doc: Document, rows: readonly RailChannelRowVM[], sample: boolean, callbacks: RailCallbacks): HTMLElement {
  const section = node(doc, "section", "hm-rail__channels hm-rail__starred");
  section.dataset.homeStarred = "";
  section.setAttribute("aria-labelledby", "hm-rail-starred-title");
  const head = node(doc, "div", "hm-rail__section-head");
  const title = node(doc, "h2", "hm-rail__heading", STARRED_TITLE);
  title.id = "hm-rail-starred-title";
  head.append(title);
  const list = node(doc, "ul", "hm-rail__channel-list");
  list.dataset.homeStarredList = "";
  for (const row of rows) list.append(channelItem(doc, row, false, sample, callbacks));
  section.append(head, list);
  return section;
}

function channelsSection(doc: Document, vm: RailChannelsVM, sample: boolean, callbacks: RailCallbacks, options: RailOptions): HTMLElement {
  const section = node(doc, "section", "hm-rail__channels");
  section.dataset.homeChannels = vm.state;
  section.setAttribute("aria-labelledby", "hm-rail-channels-title");
  const head = node(doc, "div", "hm-rail__section-head");
  const title = node(doc, "h2", "hm-rail__heading", CHANNELS_TITLE);
  title.id = "hm-rail-channels-title";
  head.append(title);
  if (!sample && vm.mayCreate && callbacks.newChannel) {
    const create = node(doc, "button", "hm-rail__new");
    create.type = "button";
    create.dataset.homeNewChannel = "";
    create.setAttribute("aria-label", NEW_CHANNEL_LABEL);
    create.title = NEW_CHANNEL_LABEL;
    create.append(icon(doc, "plus"));
    create.addEventListener("click", () => callbacks.newChannel?.(create));
    head.append(create);
  }
  const list = node(doc, "ul", "hm-rail__channel-list");
  list.id = "hm-rail-channel-list";
  list.dataset.homeChannelList = "";
  if (!vm.starred?.some((row) => row.id === vm.general.id)) list.append(channelItem(doc, vm.general, false, sample, callbacks));
  section.append(head, list);
  if (vm.state === "loading") {
    list.setAttribute("aria-busy", "true");
    for (let index = 0; index < 3; index += 1) {
      const skeleton = node(doc, "li", "hm-rail__channel-skeleton");
      skeleton.setAttribute("aria-hidden", "true");
      list.append(skeleton);
    }
    return section;
  }
  let expanded = options.channelsExpanded === true;
  const { rows, hiddenCount } = railChannelRows(vm, expanded);
  for (const { row, overflow, hidden } of rows) {
    const item = channelItem(doc, row, false, sample, callbacks);
    if (overflow) item.dataset.railOverflow = "";
    item.hidden = hidden;
    list.append(item);
  }
  const moreLabel = railMoreLabel(hiddenCount, expanded);
  if (moreLabel) {
    const more = node(doc, "button", "hm-rail__more", moreLabel);
    more.type = "button";
    more.dataset.homeChannelsMore = "";
    more.setAttribute("aria-expanded", String(expanded));
    more.setAttribute("aria-controls", list.id);
    more.addEventListener("click", () => {
      expanded = !expanded;
      for (const item of list.querySelectorAll<HTMLLIElement>("[data-rail-overflow]")) item.hidden = !expanded;
      more.textContent = railMoreLabel(hiddenCount, expanded);
      more.setAttribute("aria-expanded", String(expanded));
      callbacks.toggleChannels?.(expanded);
    });
    section.append(more);
  }
  if (!sample && callbacks.browseChannels) {
    const browse = node(doc, "button", "hm-rail__more", "All channels");
    browse.type = "button"; browse.dataset.homeAllChannels = "";
    browse.setAttribute("aria-haspopup", "dialog"); browse.setAttribute("aria-controls", "dashboard-channel-directory");
    browse.addEventListener("click", () => callbacks.browseChannels?.(browse));
    section.append(browse);
  }
  if (vm.state === "failed") {
    const failed = node(doc, "div", "hm-rail__channels-failed");
    failed.setAttribute("role", "status");
    failed.append(node(doc, "span", "", CHANNELS_LOAD_FAILED));
    if (callbacks.retryChannels) {
      const retry = node(doc, "button", "hm-rail__more hm-rail__retry", "Retry");
      retry.type = "button";
      retry.dataset.homeChannelsRetry = "";
      retry.addEventListener("click", () => callbacks.retryChannels?.());
      failed.append(retry);
    }
    section.append(failed);
  }
  if (vm.archived.length) {
    let open = options.archivedOpen === true || vm.archived.some((row) => row.current);
    const toggle = node(doc, "button", "hm-rail__more hm-rail__archived-toggle");
    toggle.type = "button";
    toggle.dataset.homeArchivedToggle = "";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", "hm-rail-archived-list");
    const chevron = node(doc, "span", "hm-rail__disclosure", "▸");
    chevron.setAttribute("aria-hidden", "true");
    toggle.append(chevron, node(doc, "span", "hm-rail__name", ARCHIVED_CHANNELS_LABEL));
    const archived = node(doc, "ul", "hm-rail__channel-list hm-rail__archived-list");
    archived.id = "hm-rail-archived-list";
    archived.hidden = !open;
    for (const row of vm.archived) archived.append(channelItem(doc, row, true, sample, callbacks));
    toggle.addEventListener("click", () => {
      open = !open;
      archived.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      callbacks.toggleArchived?.(open);
    });
    section.append(toggle, archived);
  }
  return section;
}

/** The left rail: brand row, Catch up, the selected workspace's Channels, then Direct messages. The ownership line is
 *  read to screen readers only (the canvas design draws none), and is left out on an agent's page. */
export function buildHomeRail(doc: Document, vm: HomeRailVM, callbacks: RailCallbacks, options: RailOptions = {}): HTMLElement {
  const { currentAgentId, currentDmId, leadAgentId } = vm;
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

  if (vm.channels?.starred?.length && vm.channels.state !== "loading") nav.append(starredSection(doc, vm.channels.starred, vm.sample, callbacks));
  if (vm.channels) nav.append(channelsSection(doc, vm.channels, vm.sample, callbacks, options));
  root.append(nav);

  if (vm.people) {
    const people = orderRailPeople(vm.people);
    const section = node(doc, "section", "hm-rail__people");
    section.setAttribute("aria-labelledby", "hm-rail-people-title");
    const title = node(doc, "h2", "hm-rail__heading", people.title === "People & agents" ? RAIL_DIRECT_MESSAGES_TITLE : people.title);
    title.id = "hm-rail-people-title";
    const peopleList = node(doc, "ul", "hm-rail__people-list");
    peopleList.dataset.sidebarParticipantList = "";
    for (const capsule of people.groups) peopleList.append(group(doc, capsule, vm.sample, callbacks, currentAgentId, currentDmId, leadAgentId));
    if (people.other.length) {
      const item = node(doc, "li", "hm-rail__group hm-rail__group--other");
      const head = node(doc, "p", "hm-rail__other-head", "Other agents");
      head.id = "hm-rail-other-title";
      const agents = node(doc, "ul", "hm-rail__agents");
      agents.setAttribute("aria-labelledby", head.id);
      for (const agent of people.other) agents.append(agentRow(doc, agent, vm.sample, callbacks, currentAgentId, currentDmId, leadAgentId));
      item.append(head, agents);
      peopleList.append(item);
    }
    section.append(title, peopleList);
    if (!currentAgentId) section.append(node(doc, "p", "hm-rail__note", RAIL_OWNERSHIP_NOTE));
    root.append(section);
  }
  return root;
}
