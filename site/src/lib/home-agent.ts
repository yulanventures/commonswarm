import {
  agentOrb,
  notice,
  queueRow,
  statusLine,
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
  factsIntro,
  fixActionLabel,
  fixControlAllowed,
  footerNote,
  lastActiveLine,
  lineTitle,
  policyChangeLabel,
  removeLabel,
  steeringMay,
  switchWord,
  waitingLine,
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
  /** The viewer may remove this agent from the workspace (people dialog mayManage). */
  remove?: boolean;
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
  workPolicy?: "owner" | "anyone";
  receipt?: string;
  lineNotice?: string | null;
}

/** Local to this lane: home-types.ts has no page VM. */
export type AgentPageVM = AgentNotFoundVM | AgentFoundVM;

export interface AgentPageCallbacks {
  onWorkPolicy?: (value: "owner" | "anyone") => void;
  onManage?: (agent: AgentVM) => void;
  onQueueAction?: (action: QueueAction, row: QueueRowVM) => void;
  onFix?: (action: NonNullable<AgentStateVM["fix"]["action"]>, agent: AgentVM) => void;
  /** Not drawn on this page: Lists & docs shows as a plain fact row, and People & agents (the Manage action) changes it. */
  onListsToggle?: (row: SwitchRowVM) => void;
  /** Opens the existing removal confirmation; the danger line shows only when this is wired and may.remove is true. */
  onRemove?: (agent: AgentVM) => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The canvas's 16px padlock, drawn in currentColor; decorative. */
function lockIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [name, value] of [["width", "16"], ["height", "16"], ["viewBox", "0 0 16 16"], ["fill", "none"], ["stroke", "currentColor"],
    ["stroke-width", "1.6"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["focusable", "false"]]) svg.setAttribute(name, value);
  svg.setAttribute("class", "hm-agent__lock");
  const body = doc.createElementNS(SVG_NS, "rect");
  for (const [name, value] of [["x", "3"], ["y", "7"], ["width", "10"], ["height", "7"], ["rx", "1.8"]]) body.setAttribute(name, value);
  const shackle = doc.createElementNS(SVG_NS, "path");
  shackle.setAttribute("d", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2");
  svg.append(body, shackle);
  return svg;
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

function appendFact(doc: Document, list: HTMLDListElement, label: string, value: string, hook: string, detail = ""): HTMLElement {
  const row = el(doc, "div", "hm-agent__fact");
  const term = el(doc, "dt", "hm-agent__fact-label", label);
  term.dataset.hmFact = hook;
  // The canvas's ruled-row form: a 16px/600 label, then a 13px muted note on the same line.
  if (detail) term.append(" ", el(doc, "span", "hm-agent__fact-detail", detail));
  row.append(term, el(doc, "dd", "hm-agent__fact-value", value));
  list.append(row);
  return row;
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
  page.dataset.hmState = agent.state.kind;
  page.setAttribute("aria-labelledby", "hm-agent-title");

  // Header: the agent avatar and who owns it on the left, the measured status on the right.
  const header = el(doc, "header", "hm-agent__header");
  const who = el(doc, "div", "hm-agent__who");
  who.append(agentOrb(doc, agent, { size: 60, badge: true }));
  const intro = el(doc, "div", "hm-agent__intro");
  const title = heading(doc, "h1", "hm-agent__title", agent.label, "hm-agent-title");
  title.tabIndex = -1;
  const byline = el(doc, "div", "hm-agent__byline");
  const ownership = el(doc, "p", "hm-agent__ownership", vm.ownership);
  ownership.dataset.hmOwnership = "";
  const receive = el(doc, "p", "hm-agent__receive", vm.receive);
  receive.dataset.hmReceive = "";
  byline.append(ownership, receive);
  intro.append(title, byline);
  who.append(intro);
  const statusWrap = el(doc, "div", "hm-agent__status");
  // The fix is rendered once in What to do, alongside its available action.
  statusWrap.append(statusLine(doc, { ...agent.state, attention: false }, { form: "pill" }));
  // Keys, resume and removal live in People & agents: the header's outline action opens it.
  if (canAct) {
    const manage = actionButton(doc, AGENT_COPY.manage, "hm-agent__manage", () => {
      callbacks.onManage?.(agent);
    });
    manage.dataset.hmManage = "";
    statusWrap.append(manage);
  }
  header.append(who, statusWrap);
  page.append(header);

  const disconnected = agent.state.kind === "disconnected" && agent.state.word === "Disconnected";
  const banner = disconnected ? notice(doc, disconnectedBanner(agent.state.detail), "warning") : null;
  if (banner) {
    banner.classList.add("hm-agent__banner");
    banner.dataset.hmBanner = "";
  }

  if (agent.state.attention) {
    // One amber notice: what happened, what is waiting, and the one action that fixes it.
    const box = el(doc, "section", "hm-agent__fix");
    box.dataset.hmFix = "";
    box.setAttribute("aria-labelledby", "hm-agent-fix");
    const copy = el(doc, "div", "hm-agent__fix-copy");
    copy.append(heading(doc, "h2", "hm-agent__fix-title", AGENT_COPY.whatToDo, "hm-agent-fix"));
    if (banner) {
      copy.append(banner);
      // Only Up next is in the line; Not yet and At a set time stay out of it until they join.
      const waiting = vm.lineNotice ? null : waitingLine(vm.upNext.length);
      if (waiting) {
        const line = el(doc, "p", "hm-agent__fix-sentence", waiting);
        line.dataset.hmWaiting = "";
        copy.append(line);
      }
      if (agent.state.fix.sentence) copy.append(el(doc, "p", "hm-agent__fix-sentence", agent.state.fix.sentence));
    } else {
      copy.append(notice(doc, agent.state.fix.sentence, "warning"));
    }
    box.append(copy);
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
  } else if (banner) {
    const box = el(doc, "div", "hm-agent__fix");
    box.append(banner);
    page.append(box);
  }

  const body = el(doc, "div", "hm-agent__body");
  // The line: one card with Doing now, Up next, Not yet, At a set time and Done recently.
  const line = el(doc, "section", "hm-agent__line");
  line.setAttribute("aria-labelledby", "hm-agent-line");
  const lineHead = el(doc, "div", "hm-agent__line-head");
  lineHead.append(heading(doc, "h2", "hm-agent__h2", lineTitle(agent.nestedLabel), "hm-agent-line"));
  const footer = el(doc, "p", "hm-agent__footer", footerNote(agent.nestedLabel, vm.workspaceName));
  footer.dataset.hmFooter = "";
  lineHead.append(footer);
  line.append(lineHead);
  const empty = agentLineEmpty(vm);

  if (vm.lineNotice) line.append(el(doc, "p", "hm-agent__meta", vm.lineNotice));
  if (empty && !vm.lineNotice) {
    const vacant = el(doc, "p", "hm-agent__empty", emptyLine(agent.nestedLabel));
    vacant.dataset.hmEmpty = "";
    line.append(vacant);
  }

  const part = (hook: string, id: string, text: string) => {
    const section = el(doc, "section", "hm-agent__section");
    section.dataset[hook] = "";
    section.setAttribute("aria-labelledby", id);
    const label = el(doc, "h3", "hm-agent__eyebrow", text);
    label.id = id;
    section.append(label);
    return section;
  };

  if (vm.doingNow) {
    const section = part("hmDoing", "hm-agent-doing", AGENT_COPY.doingNow);
    const card = el(doc, "div", "hm-agent__doing");
    card.append(textLink(doc, vm.doingNow.href, vm.doingNow.title, "hm-agent__todo-link"));
    card.append(el(doc, "p", "hm-agent__meta", vm.doingNow.meta));
    if (vm.doingNow.detail) card.append(el(doc, "p", "hm-agent__detail", vm.doingNow.detail));
    section.append(card);
    line.append(section);
  }

  if (vm.upNext.length) {
    const section = part("hmUpNext", "hm-agent-up-next", AGENT_COPY.upNext);
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
    const section = part("hmNotYet", "hm-agent-not-yet", AGENT_COPY.notYet);
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
      item.append(nested, gate);
      list.append(item);
    }
    section.append(list);
    line.append(section);
  }

  if (vm.atSetTime.length) {
    const section = part("hmAtTime", "hm-agent-at-time", AGENT_COPY.atSetTime);
    const list = el(doc, "ul", "hm-agent__scheduled");
    for (const row of vm.atSetTime) {
      list.append(todoLinkRow(doc, row.href, row.title, row.whenLine));
    }
    section.append(list);
    line.append(section);
  }

  const done = doneRecentlyLimit(vm.doneRecently);
  if (done.length) {
    const section = part("hmDone", "hm-agent-done", AGENT_COPY.doneRecently);
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
  facts.append(el(doc, "p", "hm-agent__facts-intro", factsIntro(agent.nestedLabel, vm.workspaceName)));
  // The connection summary (the canvas's 14px/600 line): how it gets messages, then when it was last active.
  const summary = el(doc, "p", "hm-agent__facts-summary");
  // vm.receive is the full sentence (facts.receive shortens an unknown to "Not reported").
  const received = el(doc, "span", "", vm.receive);
  received.dataset.hmFact = "receive";
  const last = el(doc, "span", "", lastActiveLine(vm.facts.lastActive));
  last.dataset.hmFact = "last-active";
  summary.append(received, " ", last);
  facts.append(summary);
  // Plain ruled rows (the canvas's seat rows): the current values only. Changing Lists & docs happens in
  // People & agents, which the header's Manage action opens.
  const list = el(doc, "dl", "hm-agent__fact-list");
  if (vm.facts.model) appendFact(doc, list, AGENT_COPY.model, vm.facts.model, "model");
  if (canAct && agent.yours && vm.facts.listsAndDocs) {
    const row = vm.facts.listsAndDocs;
    const lists = appendFact(doc, list, row.label, switchWord(row.state), "lists", row.detail);
    lists.dataset.hmLists = "";
    lists.dataset.switchId = row.id;
  }
  if (agent.yours && vm.facts.postsHere) {
    const row = vm.facts.postsHere;
    appendFact(doc, list, row.label, switchWord(row.state), "posts", row.detail).dataset.switchId = row.id;
  }
  if (list.childElementCount) facts.append(list);
  aside.append(facts);

  let receiptHome: HTMLElement = facts;
  if (agent.yours && vm.workPolicy) {
    // The current policy as plain summary text. The one control that switches it is the summary's last
    // 15px line (People & agents has no work-policy control yet, so it stays here).
    const current = vm.workPolicy;
    const policyCard = el(doc, "section", "hm-agent__policy");
    policyCard.dataset.hmPolicy = current;
    policyCard.setAttribute("aria-labelledby", "hm-agent-policy");
    policyCard.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.policyTitle, "hm-agent-policy"));
    const summary = el(doc, "div", "hm-agent__policy-summary");
    const now = el(doc, "p", "hm-agent__policy-now");
    now.dataset.hmPolicyNow = "";
    now.append(el(doc, "strong", "", current === "owner" ? AGENT_COPY.policyOwner : AGENT_COPY.policyAnyone), ` in ${vm.workspaceName}`);
    summary.append(now);
    if (current === "owner") summary.append(el(doc, "p", "hm-agent__policy-offer", AGENT_COPY.policyOffer));
    if (canAct && callbacks.onWorkPolicy) {
      const next = current === "owner" ? "anyone" : "owner";
      const change = actionButton(doc, policyChangeLabel(next), "hm-agent__policy-change", () => {
        callbacks.onWorkPolicy?.(next);
      });
      change.dataset.hmPolicyChange = next;
      summary.append(change);
    }
    policyCard.append(summary);
    const lock = el(doc, "p", "hm-agent__policy-note");
    lock.append(lockIcon(doc), el(doc, "span", "", AGENT_COPY.policyLock));
    policyCard.append(lock);
    aside.append(policyCard);
    receiptHome = policyCard;
  }
  if (vm.receipt) { const receipt = el(doc, "p", "hm-agent__meta", vm.receipt); receipt.setAttribute("role", "status"); receiptHome.append(receipt); }

  if (vm.activity) {
    const activity = el(doc, "section", "hm-agent__activity");
    activity.dataset.hmActivity = "";
    activity.setAttribute("aria-labelledby", "hm-agent-activity");
    activity.append(heading(doc, "h2", "hm-agent__h2", AGENT_COPY.recentActivity, "hm-agent-activity"));
    const slot = el(doc, "div", "hm-agent__activity-slot");
    slot.dataset.agentActivity = "";
    slot.append(el(doc, "p", "hm-agent__meta", vm.activity.ageLabel));
    if (vm.activity.phaseLabel) slot.append(el(doc, "p", "hm-agent__detail", vm.activity.phaseLabel));
    if (vm.activity.toolTitle) slot.append(el(doc, "p", "hm-agent__detail", vm.activity.toolTitle));
    if (vm.activity.emptyMessage) slot.append(el(doc, "p", "hm-agent__meta", vm.activity.emptyMessage));
    activity.append(slot);
    aside.append(activity);
  }

  if (canAct && vm.may.remove && callbacks.onRemove) {
    const remove = actionButton(doc, removeLabel(agent.nestedLabel, vm.workspaceName), "hm-agent__remove", () => {
      callbacks.onRemove?.(agent);
    });
    remove.dataset.hmRemove = "";
    aside.append(remove);
  }

  body.append(line, aside);
  page.append(body);
  return page;
}
