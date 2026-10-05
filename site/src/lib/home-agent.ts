import {
  agentOrb,
  notice,
  queueRow,
  statusLine,
  switchRow,
  type QueueAction,
} from "./home-primitives";
import type {
  AgentStateVM,
  AgentVM,
  Id,
  QueueRowVM,
  SwitchRowVM,
} from "./home-types";
import {
  AGENT_COPY,
  agentLineEmpty,
  disconnectedBanner,
  doneRecentlyLimit,
  emptyLine,
  fixActionLabel,
  fixControlAllowed,
  footerNote,
  steeringMay,
} from "./home-agent-copy";

export interface AgentDoingNowVM {
  todoId: Id;
  title: string;
  href: string;
  meta: string;
  detail: string;
}

export interface AgentGatedRowVM {
  todoId: Id;
  position: number;
  title: string;
  href: string;
  meta: string;
  gate: string;
  may: QueueRowVM["may"];
}

export interface AgentScheduledRowVM {
  todoId: Id;
  title: string;
  href: string;
  whenLine: string;
}

export interface AgentDoneRowVM {
  todoId: Id;
  title: string;
  href: string;
  meta: string;
}

export interface AgentFactsVM {
  model: string | null;
  receive: string;
  lastActive: string;
  listsAndDocs: SwitchRowVM | null;
  postsHere: SwitchRowVM | null;
}

export interface AgentActivityVM {
  ageLabel: string;
  phaseLabel: string | null;
  toolTitle: string | null;
  emptyMessage: string | null;
}

export interface AgentPageMay {
  steer: boolean;
}

export interface AgentNotFoundVM {
  found: false;
  homeHref: string;
  sample?: boolean;
}

export interface AgentFoundVM {
  found: true;
  sample: boolean;
  homeHref: string;
  agent: AgentVM;
  ownership: string;
  receive: string;
  workspaceName: string;
  doingNow: AgentDoingNowVM | null;
  upNext: QueueRowVM[];
  notYet: AgentGatedRowVM[];
  atSetTime: AgentScheduledRowVM[];
  doneRecently: AgentDoneRowVM[];
  facts: AgentFactsVM;
  activity: AgentActivityVM | null;
  may: AgentPageMay;
}

/** Local to this lane: home-types.ts has no page VM. */
export type AgentPageVM = AgentNotFoundVM | AgentFoundVM;

export interface AgentPageCallbacks {
  onManage?: (agent: AgentVM) => void;
  onQueueAction?: (action: QueueAction, row: QueueRowVM) => void;
  onFix?: (action: NonNullable<AgentStateVM["fix"]["action"]>, agent: AgentVM) => void;
  onListsToggle?: (row: SwitchRowVM) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function heading(doc: Document, tag: "h1" | "h2", className: string, text: string, id?: string) {
  const node = el(doc, tag, className, text);
  if (id) node.id = id;
  return node;
}

function textLink(doc: Document, href: string, text: string, className: string) {
  const node = el(doc, "a", className, text);
  node.href = href;
  return node;
}

function actionButton(doc: Document, text: string, className: string, click: () => void) {
  const node = el(doc, "button", className, text);
  node.type = "button";
  node.addEventListener("click", click);
  return node;
}

function asQueueRow(row: AgentGatedRowVM): QueueRowVM {
  return {
    todoId: row.todoId,
    position: row.position,
    title: row.title,
    href: row.href,
    meta: row.meta,
    may: row.may,
  };
}

function notFoundPage(doc: Document, vm: AgentNotFoundVM): HTMLElement {
  const page = el(doc, "article", "hm-agent hm-agent--missing");
  page.dataset.hmAgent = "missing";
  const title = heading(doc, "h1", "hm-agent__title", AGENT_COPY.notFound);
  title.tabIndex = -1;
  const home = textLink(doc, vm.homeHref, AGENT_COPY.homeLink, "hm-agent__home");
  home.dataset.hmHome = "";
  page.append(title, home);
  return page;
}

function appendFact(doc: Document, list: HTMLDListElement, label: string, value: string, hook: string) {
  const term = el(doc, "dt", "hm-agent__fact-label", label);
  term.dataset.hmFact = hook;
  list.append(term, el(doc, "dd", "hm-agent__fact-value", value));
}

function todoLinkRow(doc: Document, href: string, title: string, meta: string, extra?: string) {
  const item = el(doc, "li", "hm-agent__done-item");
  const link = textLink(doc, href, title, "hm-agent__todo-link");
  item.append(link, el(doc, "p", "hm-agent__meta", meta));
  if (extra) item.append(el(doc, "p", "hm-agent__detail", extra));
  return item;
}

export function agentPage(doc: Document, vm: AgentPageVM, callbacks: AgentPageCallbacks = {}): HTMLElement {
  if (!vm.found) return notFoundPage(doc, vm);

  const { agent } = vm;
  const canSteer = !vm.sample && vm.may.steer && agent.yours;
  const canAct = !vm.sample;
  const page = el(doc, "article", "hm-agent");
  page.dataset.hmAgent = agent.id;
  page.dataset.hmYours = String(agent.yours);
  page.dataset.hmReadonly = String(!canSteer);
  page.setAttribute("aria-labelledby", "hm-agent-title");

  const header = el(doc, "header", "hm-agent__header");
  header.append(agentOrb(doc, agent, { size: 60, badge: true }));
  const intro = el(doc, "div", "hm-agent__intro");
  const title = heading(doc, "h1", "hm-agent__title", agent.label, "hm-agent-title");
  title.tabIndex = -1;
  const ownership = el(doc, "p", "hm-agent__ownership", vm.ownership);
  ownership.dataset.hmOwnership = "";
  intro.append(title, ownership);
  const statusWrap = el(doc, "div", "hm-agent__status");
  statusWrap.append(statusLine(doc, agent.state, { form: "pill" }));
  statusWrap.append(el(doc, "p", "hm-agent__status-detail", agent.state.detail));
  const receive = el(doc, "p", "hm-agent__receive", vm.receive);
  receive.dataset.hmReceive = "";
  intro.append(statusWrap, receive);
  header.append(intro);
  page.append(header);

  if (agent.state.kind === "disconnected" && agent.state.word === "Disconnected") {
    const banner = notice(doc, disconnectedBanner(agent.state.detail), "warning");
    banner.classList.add("hm-agent__banner");
    banner.dataset.hmBanner = "";
    page.append(banner);
  }

  if (agent.state.attention) {
    const box = el(doc, "section", "hm-agent__fix");
    box.dataset.hmFix = "";
    box.setAttribute("aria-labelledby", "hm-agent-fix");
    box.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.whatToDo, "hm-agent-fix"));
    box.append(notice(doc, agent.state.fix.sentence, "warning"));
    const fixAction = agent.state.fix.action;
    const label = fixActionLabel(fixAction);
    if (fixControlAllowed(agent.yours, vm.sample, agent.state.fix.allowed) && fixAction && label) {
      const button = actionButton(doc, label, "hm-agent__action", () => {
        callbacks.onFix?.(fixAction, agent);
      });
      button.dataset.hmFixAction = fixAction;
      box.append(button);
    }
    page.append(box);
  }

  const body = el(doc, "div", "hm-agent__body");
  const line = el(doc, "div", "hm-agent__line");
  const empty = agentLineEmpty(vm);

  if (empty) {
    const vacant = el(doc, "p", "hm-agent__empty", emptyLine(agent.nestedLabel));
    vacant.dataset.hmEmpty = "";
    line.append(vacant);
  }

  if (vm.doingNow) {
    const section = el(doc, "section", "hm-agent__section");
    section.dataset.hmDoing = "";
    section.setAttribute("aria-labelledby", "hm-agent-doing");
    section.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.doingNow, "hm-agent-doing"));
    const card = el(doc, "div", "hm-agent__doing");
    card.append(textLink(doc, vm.doingNow.href, vm.doingNow.title, "hm-agent__todo-link"));
    card.append(el(doc, "p", "hm-agent__meta", vm.doingNow.meta));
    card.append(el(doc, "p", "hm-agent__detail", vm.doingNow.detail));
    section.append(card);
    line.append(section);
  }

  if (vm.upNext.length) {
    const section = el(doc, "section", "hm-agent__section");
    section.dataset.hmUpNext = "";
    section.setAttribute("aria-labelledby", "hm-agent-up-next");
    section.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.upNext, "hm-agent-up-next"));
    const list = el(doc, "ul", "hm-agent__queue");
    for (const row of vm.upNext) {
      const gated: QueueRowVM = { ...row, may: steeringMay(agent.yours, vm.sample, vm.may.steer, row.may) };
      list.append(queueRow(doc, gated, (action, q) => {
        if (!canSteer) return;
        callbacks.onQueueAction?.(action, q);
      }));
    }
    section.append(list);
    line.append(section);
  }

  if (vm.notYet.length) {
    const section = el(doc, "section", "hm-agent__section");
    section.dataset.hmNotYet = "";
    section.setAttribute("aria-labelledby", "hm-agent-not-yet");
    section.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.notYet, "hm-agent-not-yet"));
    const list = el(doc, "div", "hm-agent__gated-list");
    for (const row of vm.notYet) {
      const item = el(doc, "div", "hm-agent__gated");
      const gate = el(doc, "p", "hm-agent__gate", row.gate);
      gate.dataset.hmGate = "";
      const nested = el(doc, "ul", "hm-agent__queue");
      const queued = asQueueRow(row);
      queued.may = steeringMay(agent.yours, vm.sample, vm.may.steer, row.may);
      nested.append(queueRow(doc, queued, (action, q) => {
        if (!canSteer) return;
        callbacks.onQueueAction?.(action, q);
      }));
      item.append(gate, nested);
      list.append(item);
    }
    section.append(list);
    line.append(section);
  }

  if (vm.atSetTime.length) {
    const section = el(doc, "section", "hm-agent__section");
    section.dataset.hmAtTime = "";
    section.setAttribute("aria-labelledby", "hm-agent-at-time");
    section.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.atSetTime, "hm-agent-at-time"));
    const list = el(doc, "ul", "hm-agent__scheduled");
    for (const row of vm.atSetTime) {
      list.append(todoLinkRow(doc, row.href, row.title, row.whenLine));
    }
    section.append(list);
    line.append(section);
  }

  const done = doneRecentlyLimit(vm.doneRecently);
  if (done.length) {
    const section = el(doc, "section", "hm-agent__section");
    section.dataset.hmDone = "";
    section.setAttribute("aria-labelledby", "hm-agent-done");
    section.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.doneRecently, "hm-agent-done"));
    const list = el(doc, "ul", "hm-agent__done");
    for (const row of done) list.append(todoLinkRow(doc, row.href, row.title, row.meta));
    section.append(list);
    line.append(section);
  }

  const aside = el(doc, "aside", "hm-agent__aside");
  const facts = el(doc, "section", "hm-agent__facts");
  facts.dataset.hmFacts = "";
  facts.setAttribute("aria-labelledby", "hm-agent-facts");
  facts.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.facts, "hm-agent-facts"));
  const list = el(doc, "dl", "hm-agent__fact-list");
  if (vm.facts.model) appendFact(doc, list, AGENT_COPY.model, vm.facts.model, "model");
  appendFact(doc, list, AGENT_COPY.receiveFact, vm.facts.receive, "receive");
  appendFact(doc, list, AGENT_COPY.lastActive, vm.facts.lastActive, "last-active");
  facts.append(list);
  if (canAct && agent.yours && vm.facts.listsAndDocs) {
    const lists = el(doc, "div", "hm-agent__lists");
    lists.dataset.hmLists = "";
    lists.append(switchRow(doc, vm.facts.listsAndDocs, (row) => {
      if (!canAct || !agent.yours) return;
      callbacks.onListsToggle?.(row);
    }));
    facts.append(lists);
  }
  if (vm.facts.postsHere) facts.append(switchRow(doc, vm.facts.postsHere, () => {}));
  aside.append(facts);

  const activity = el(doc, "section", "hm-agent__activity");
  activity.dataset.hmActivity = "";
  activity.setAttribute("aria-labelledby", "hm-agent-activity");
  activity.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.recentActivity, "hm-agent-activity"));
  const slot = el(doc, "div", "hm-agent__activity-slot");
  slot.dataset.agentActivity = "";
  if (vm.activity) {
    slot.append(el(doc, "p", "hm-agent__meta", vm.activity.ageLabel));
    if (vm.activity.phaseLabel) slot.append(el(doc, "p", "hm-agent__detail", vm.activity.phaseLabel));
    if (vm.activity.toolTitle) slot.append(el(doc, "p", "hm-agent__detail", vm.activity.toolTitle));
    if (vm.activity.emptyMessage) slot.append(el(doc, "p", "hm-agent__meta", vm.activity.emptyMessage));
  }
  activity.append(slot);
  aside.append(activity);

  if (canAct) {
    const manage = actionButton(doc, AGENT_COPY.manage, "hm-agent__manage", () => {
      callbacks.onManage?.(agent);
    });
    manage.dataset.hmManage = "";
    aside.append(manage);
  }

  body.append(line, aside);
  page.append(body);
  const footer = el(doc, "p", "hm-agent__footer", footerNote(agent.nestedLabel, vm.workspaceName));
  footer.dataset.hmFooter = "";
  page.append(footer);
  return page;
}
