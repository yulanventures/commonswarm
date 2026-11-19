/**
 * Waiting on you channel panel: a closeable right column beside the conversation on desktop and a modal
 * dialog sheet on phone. Defaults to This channel, follows channel switches on desktop, and lets people
 * answer choice questions directly in each card without leaving chat.
 *
 * Pure DOM: every untrusted string (question body, channel/workspace/sender names, option labels and
 * descriptions, Something else text) enters only through textContent.
 */
import { buildChoiceCard } from "./choice-card";
import type { AskChoiceState, ChoiceDraft, ChoiceOption, ChoiceSubmission } from "./choices";
import { agentOrb, personAvatar } from "./home-primitives";
import type { AgentVM, PersonVM } from "./home-types";
import {
  classifyAskConversation,
  type WaitingConversation,
  type WaitingSignalPlacement,
} from "./waiting-count";
import {
  focusWaitingSurvey,
  renderWaitingSurvey,
  surveyDraftKey,
  surveyReadyEntries,
  surveySubmissionFromDraft,
  type SurveyDraft,
  type WaitingSurveyFocusTarget,
  type WaitingSurveyHandlers,
  type WaitingSurveyVM,
} from "./waiting-survey";

export {
  classifyAskConversation,
  focusWaitingSurvey,
  surveyDraftKey,
  surveyReadyEntries,
  surveySubmissionFromDraft,
  type SurveyDraft,
  type WaitingConversation,
  type WaitingSignalPlacement,
  type WaitingSurveyFocusTarget,
  type WaitingSurveyHandlers,
  type WaitingSurveyVM,
};

export type WaitingScope = "channel" | "workspace" | "all";

export interface WaitingPlace {
  workspaceId: string;
  workspaceName: string;
  kind: "channel" | "general" | "all" | "dm";
  channelId: string | null;
  label: string;
  dm?: { kind: "person" | "agent"; id: string };
}

export interface WaitingAskItem {
  id: string;
  workspaceId: string;
  workspaceName: string;
  conversation: WaitingConversation;
  channelLabel: string;
  from: PersonVM | AgentVM;
  fromKind: "agent" | "user";
  fromId: string;
  what: string;
  when: string;
  createdAt: string;
  until: string;
  choices: {
    options: ChoiceOption[];
    multi: boolean;
    pending?: true;
    error?: string;
    draft?: ChoiceDraft;
    retryable?: true;
  };
}

export type WaitingTodoReason = "assigned" | "request" | "after" | "hold" | "agent_removed";
export type WaitingTodoPlacement = "channel" | "general" | "workspace";

export interface WaitingTodoItem {
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  state: "open" | "doing";
  dueOn: string | null;
  reason: WaitingTodoReason;
  href: string;
  canMarkDone: boolean;
  placement?: WaitingTodoPlacement;
  channelId?: string | null;
  channelLabel?: string;
  pending?: true;
  error?: string;
  retryable?: true;
}

export interface WaitingScopeCount {
  min: number;
  complete: boolean;
}

export interface WaitingPanelCounts {
  channel: WaitingScopeCount;
  workspace: WaitingScopeCount;
  all: WaitingScopeCount;
}

export interface WaitingPanelVM {
  scope: WaitingScope;
  place: WaitingPlace;
  items: WaitingAskItem[];
  todos?: WaitingTodoItem[];
  counts: WaitingPanelCounts;
  loading: boolean;
  complete: boolean;
  failed: boolean;
  truncated?: boolean;
  catchUpHref?: string;
  survey?: WaitingSurveyVM | null;
  statusMessage: string;
  statusSeq: number;
}

export interface WaitingPanelHandlers {
  onScopeChange: (scope: WaitingScope) => void;
  onClose: () => void;
  onRetryLoad: () => void;
  onSubmitChoice: (item: WaitingAskItem, submission: ChoiceSubmission) => void;
  onRetryChoice: (item: WaitingAskItem) => void;
  onDraftChoice: (item: WaitingAskItem, draft: ChoiceDraft) => void;
  onMarkTodoDone?: (item: WaitingTodoItem) => void;
  onRetryTodo?: (item: WaitingTodoItem) => void;
  onOpenTodo?: (item: WaitingTodoItem) => void;
  onOpenCatchUp?: (href: string) => void;
  onStartSurvey?: () => void;
  surveyHandlers?: WaitingSurveyHandlers;
}

export const WAITING_PANEL_ID = "cs-waiting-panel";
export const WAITING_SHEET_ID = "cs-waiting-sheet";
export const WAITING_SHEET_MEDIA = "(max-width: 52rem), (max-height: 32rem)";

/** Filters open choice asks by the selected scope and active conversation. */
export function filterWaitingItems(
  items: readonly WaitingAskItem[],
  scope: WaitingScope,
  place: WaitingPlace,
): WaitingAskItem[] {
  if (scope === "all") return [...items];
  if (scope === "workspace") return items.filter(item => item.workspaceId === place.workspaceId);
  return items.filter(item => {
    if (item.workspaceId !== place.workspaceId) return false;
    if (place.kind === "all") return true;
    if (place.kind === "channel") {
      return item.conversation.kind === "channel" && item.conversation.channelId === place.channelId;
    }
    if (place.kind === "general") {
      return item.conversation.kind === "general";
    }
    if (place.kind === "dm" && place.dm) {
      return (
        item.conversation.kind === "dm" &&
        item.conversation.partnerKind === place.dm.kind &&
        item.conversation.partnerId === place.dm.id
      );
    }
    return false;
  });
}

/** Filters waiting/assigned to-dos by scope. Channel-origin and #general-origin to-dos appear in
 *  their authoritative channel's This channel queue; genuinely workspace-only to-dos stay in All
 *  channels, All workspaces, and All messages so they never clutter an unrelated channel or DM. */
export function filterWaitingTodos(
  todos: readonly WaitingTodoItem[],
  scope: WaitingScope,
  place: WaitingPlace,
): WaitingTodoItem[] {
  if (scope === "all") return [...todos];
  if (scope === "workspace") return todos.filter(todo => todo.workspaceId === place.workspaceId);
  if (place.kind === "all") return todos.filter(todo => todo.workspaceId === place.workspaceId);
  return todos.filter(todo => {
    if (todo.workspaceId !== place.workspaceId) return false;
    const placement = todo.placement ?? "workspace";
    if (place.kind === "channel") {
      return placement === "channel" && todo.channelId === place.channelId;
    }
    if (place.kind === "general") {
      return placement === "general";
    }
    return false;
  });
}

function todoReasonLabel(reason: WaitingTodoReason): string {
  switch (reason) {
    case "request": return "To-do · Waiting for your answer";
    case "hold": return "To-do · On hold";
    case "after": return "To-do · Waiting";
    case "agent_removed": return "To-do · Agent removed";
    default: return "To-do · Assigned to you";
  }
}

function formatTodoDue(dueOn: string | null): string | null {
  if (!dueOn) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dueOn);
  if (!match) return `Due ${dueOn}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(match[2]) - 1];
  const day = Number(match[3]);
  return month && day ? `Due ${month} ${day}` : `Due ${dueOn}`;
}

function todoCardLocationText(item: WaitingTodoItem, scope: WaitingScope): string | null {
  if (scope === "channel") return null;
  if (scope === "workspace") return item.channelLabel || null;
  return item.channelLabel ? `${item.workspaceName} · ${item.channelLabel}` : item.workspaceName;
}

function todoCardSignature(item: WaitingTodoItem, scope: WaitingScope): string {
  return JSON.stringify([
    item.id,
    item.workspaceId,
    item.workspaceName,
    item.placement ?? "workspace",
    item.channelId ?? "",
    item.channelLabel ?? "",
    item.title,
    item.state,
    item.dueOn ?? "",
    item.reason,
    item.href,
    item.canMarkDone,
    scope,
    item.pending ?? false,
    item.error ?? "",
    item.retryable ?? false,
  ]);
}

function buildTodoCard(
  doc: Document,
  item: WaitingTodoItem,
  scope: WaitingScope,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const card = node(doc, "article", "cs-waiting-card cs-waiting-card--todo");
  card.dataset.waitingTodo = item.id;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = todoCardSignature(item, scope);

  const meta = node(doc, "div", "cs-waiting-card__todo-meta");
  const kind = node(doc, "span", "cs-waiting-card__todo-kind", todoReasonLabel(item.reason));
  meta.append(kind);
  const due = formatTodoDue(item.dueOn);
  if (due) meta.append(node(doc, "span", "cs-waiting-card__todo-due", due));
  const location = todoCardLocationText(item, scope);
  if (location) meta.append(node(doc, "span", "cs-waiting-card__place", location));

  const title = node(doc, "p", "cs-waiting-card__question", item.title);
  card.append(meta, title);

  if (item.error) {
    const err = node(doc, "p", "cs-waiting-card__error", item.error);
    err.setAttribute("role", "alert");
    card.append(err);
  }

  const actions = node(doc, "div", "cs-waiting-card__actions");
  if (item.canMarkDone) {
    if (item.error && item.retryable && !item.pending) {
      const retry = node(doc, "button", "cs-waiting-card__todo-done", "Retry");
      retry.type = "button";
      retry.dataset.waitingTodoRetry = item.id;
      retry.addEventListener("click", () => (handlers.onRetryTodo ?? handlers.onMarkTodoDone)?.(item));
      actions.append(retry);
    } else {
      const done = node(doc, "button", "cs-waiting-card__todo-done", item.pending ? "Saving…" : "Mark done");
      done.type = "button";
      done.dataset.waitingTodoDone = item.id;
      if (item.pending) done.setAttribute("aria-disabled", "true");
      done.addEventListener("click", () => {
        if (item.pending) return;
        handlers.onMarkTodoDone?.(item);
      });
      actions.append(done);
    }
  }
  const open = node(doc, "a", "cs-waiting-panel__action", "Open");
  open.href = item.href;
  open.dataset.waitingTodoOpen = item.id;
  open.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!handlers.onOpenTodo) return;
    event.preventDefault();
    handlers.onOpenTodo(item);
  });
  actions.append(open);
  card.append(actions);
  return card;
}

function isAgent(who: PersonVM | AgentVM): who is AgentVM {
  return "state" in who;
}

function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function formatScopeCount(count: WaitingScopeCount): string {
  if (count.min > 99) return "99+";
  if (count.complete) return String(count.min);
  return count.min > 0 ? `${count.min}+` : "";
}

function scopeOptionText(base: string, count: WaitingScopeCount): string {
  const num = formatScopeCount(count);
  return num ? `${base} (${num})` : base;
}

function placeHeadingText(vm: WaitingPanelVM): string {
  if (vm.scope === "channel") return vm.place.label;
  if (vm.scope === "workspace") return vm.place.workspaceName;
  return "All workspaces";
}

function cardLocationText(item: WaitingAskItem, scope: WaitingScope): string | null {
  if (scope === "channel") return null;
  if (scope === "workspace") return item.channelLabel || null;
  return item.channelLabel ? `${item.workspaceName} · ${item.channelLabel}` : item.workspaceName;
}

function cardSignature(item: WaitingAskItem, scope: WaitingScope): string {
  return JSON.stringify([
    item.id,
    item.workspaceId,
    item.conversation,
    item.channelLabel,
    item.from.name,
    item.what,
    scope,
    item.choices.multi,
    item.choices.pending ?? false,
    item.choices.error ?? "",
    item.choices.retryable ?? false,
    item.choices.options.map(option => [option.id, option.label, option.description ?? "", option.recommended ?? false]),
  ]);
}

function buildAskCard(
  doc: Document,
  item: WaitingAskItem,
  scope: WaitingScope,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const card = node(doc, "article", "cs-waiting-card");
  card.dataset.waitingCard = item.id;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = cardSignature(item, scope);

  const head = node(doc, "div", "cs-waiting-card__head");
  const avatar = isAgent(item.from) ? agentOrb(doc, item.from, true) : personAvatar(doc, item.from);
  const meta = node(doc, "div", "cs-waiting-card__meta");
  const sender = node(doc, "span", "cs-waiting-card__sender", item.from.name);
  const time = node(doc, "time", "cs-waiting-card__when", item.when);
  if (Number.isFinite(Date.parse(item.createdAt))) time.dateTime = item.createdAt;
  const line = node(doc, "div", "cs-waiting-card__byline");
  line.append(sender, time);
  meta.append(line);

  const location = cardLocationText(item, scope);
  if (location) meta.append(node(doc, "span", "cs-waiting-card__place", location));
  head.append(avatar, meta);

  const question = node(doc, "p", "cs-waiting-card__question", item.what);

  const state: AskChoiceState = {
    signalId: item.id,
    multi: item.choices.multi,
    options: item.choices.options,
    answer: null,
  };
  const decision = buildChoiceCard(
    doc,
    {
      state,
      interactive: true,
      ended: false,
      pending: item.choices.pending,
      error: item.choices.error ?? null,
      draft: item.choices.draft,
      scope: "waiting-panel",
      submitLabel: "Send",
    },
    {
      submit: submission => handlers.onSubmitChoice(item, submission),
      draft: draft => handlers.onDraftChoice(item, draft),
    },
  );
  decision.setAttribute("aria-label", item.what);

  card.append(head, question, decision);

  if (item.choices.error && item.choices.retryable && !item.choices.pending) {
    const retryRow = node(doc, "div", "cs-waiting-card__retry-row");
    const retry = node(doc, "button", "cs-waiting-card__retry", "Retry");
    retry.type = "button";
    retry.dataset.waitingCardRetry = item.id;
    retry.addEventListener("click", () => handlers.onRetryChoice(item));
    retryRow.append(retry);
    card.append(retryRow);
  }
  return card;
}

/**
 * Renders or incrementally updates the Waiting on you panel inside `container`.
 * Unchanged cards keep their DOM nodes, typed drafts, and keyboard focus across refreshes.
 */
export function renderWaitingPanel(
  container: HTMLElement,
  vm: WaitingPanelVM,
  handlers: WaitingPanelHandlers,
): void {
  const doc = container.ownerDocument;
  let root = container.querySelector<HTMLElement>("[data-waiting-panel-root]");
  if (!root) {
    root = node(doc, "div", "cs-waiting-panel__inner");
    root.dataset.waitingPanelRoot = "";

    const header = node(doc, "header", "cs-waiting-panel__head");
    const headingGroup = node(doc, "div", "cs-waiting-panel__titles");
    const title = node(doc, "h2", "cs-waiting-panel__title", "Waiting on you");
    title.id = `${WAITING_PANEL_ID}-title`;
    const place = node(doc, "p", "cs-waiting-panel__place");
    place.dataset.waitingPlace = "";
    headingGroup.append(title, place);

    const closeBtn = node(doc, "button", "cs-waiting-panel__close", "×");
    closeBtn.type = "button";
    closeBtn.dataset.waitingClose = "";
    closeBtn.setAttribute("aria-label", "Close Waiting on you");
    header.append(headingGroup, closeBtn);

    const controls = node(doc, "div", "cs-waiting-panel__controls");
    controls.dataset.waitingControls = "";
    const scope = node(doc, "select", "cs-waiting-panel__scope");
    scope.dataset.waitingScope = "";
    scope.setAttribute("aria-label", "Scope");
    for (const value of ["channel", "workspace", "all"] as const) {
      const opt = doc.createElement("option");
      opt.value = value;
      scope.append(opt);
    }
    const reviewBtn = node(doc, "button", "cs-waiting-panel__review-btn");
    reviewBtn.type = "button";
    reviewBtn.dataset.waitingReviewStart = "";
    reviewBtn.hidden = true;
    controls.append(scope, reviewBtn);

    // Visible confirmation banner and polite live region: announces "Sent" and stays visible after the last answer.
    const status = node(doc, "p", "cs-waiting-panel__status");
    status.dataset.waitingStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;

    const body = node(doc, "div", "cs-waiting-panel__body");
    body.dataset.waitingBody = "";

    root.append(header, controls, status, body);
    container.replaceChildren(root);
  }

  const closeBtn = root.querySelector<HTMLButtonElement>("[data-waiting-close]");
  if (closeBtn) closeBtn.onclick = () => handlers.onClose();

  const placeEl = root.querySelector<HTMLElement>("[data-waiting-place]");
  if (placeEl) placeEl.textContent = placeHeadingText(vm);

  const scopeEl = root.querySelector<HTMLSelectElement>("[data-waiting-scope]");
  if (scopeEl) {
    const labels: Record<WaitingScope, string> = {
      channel: scopeOptionText("This channel", vm.counts.channel),
      workspace: scopeOptionText("All channels", vm.counts.workspace),
      all: scopeOptionText("All workspaces", vm.counts.all),
    };
    for (const opt of scopeEl.options) {
      const value = opt.value as WaitingScope;
      if (labels[value] && opt.textContent !== labels[value]) opt.textContent = labels[value];
    }
    if (scopeEl.value !== vm.scope) scopeEl.value = vm.scope;
    scopeEl.onchange = () => {
      const next = scopeEl.value as WaitingScope;
      if (next === "channel" || next === "workspace" || next === "all") handlers.onScopeChange(next);
    };
  }

  const controlsEl = root.querySelector<HTMLElement>("[data-waiting-controls]");
  if (controlsEl) controlsEl.hidden = Boolean(vm.survey);

  const reviewBtn = root.querySelector<HTMLButtonElement>("[data-waiting-review-start]");
  if (reviewBtn) {
    const showReview = !vm.survey && vm.items.length >= 2 && Boolean(handlers.onStartSurvey);
    reviewBtn.hidden = !showReview;
    if (showReview) {
      reviewBtn.textContent = "Review questions";
      reviewBtn.onclick = () => handlers.onStartSurvey?.();
    }
  }

  const statusEl = root.querySelector<HTMLElement>("[data-waiting-status]");
  if (statusEl) {
    const hasStatus = vm.statusMessage.trim() !== "";
    statusEl.hidden = !hasStatus;
    if (statusEl.dataset.waitingStatusSeq !== String(vm.statusSeq) || statusEl.textContent !== vm.statusMessage) {
      statusEl.dataset.waitingStatusSeq = String(vm.statusSeq);
      statusEl.textContent = vm.statusMessage;
    }
  }

  const body = root.querySelector<HTMLElement>("[data-waiting-body]");
  if (!body) return;

  if (vm.survey && handlers.surveyHandlers) {
    delete body.dataset.waitingEmptyKey;
    renderWaitingSurvey(body, vm.survey, handlers.surveyHandlers);
    return;
  }
  delete body.dataset.waitingSurveySig;
  delete body.dataset.waitingSurveyTypingSig;

  const buildCatchUpLink = (): HTMLAnchorElement | null => {
    if (!vm.catchUpHref) return null;
    const href = vm.catchUpHref;
    const link = node(doc, "a", "cs-waiting-panel__action", "Open Catch up");
    link.href = href;
    link.dataset.waitingOpenCatchup = "";
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!handlers.onOpenCatchUp) return;
      event.preventDefault();
      handlers.onOpenCatchUp(href);
    });
    return link;
  };

  const todos = vm.todos ?? [];
  if (vm.items.length === 0 && todos.length === 0) {
    const emptyState = vm.failed ? "failed" : vm.truncated ? "truncated" : vm.loading || !vm.complete ? "loading" : "empty";
    const wsNum = formatScopeCount(vm.counts.workspace);
    const allNum = formatScopeCount(vm.counts.all);
    const emptyKey = JSON.stringify([
      emptyState,
      vm.scope,
      vm.place.label,
      vm.place.workspaceName,
      wsNum,
      allNum,
      vm.counts.workspace.min,
      vm.counts.all.min,
      vm.catchUpHref ?? "",
    ]);
    if (body.dataset.waitingEmptyKey === emptyKey) return;
    body.dataset.waitingEmptyKey = emptyKey;

    const wrap = node(doc, "div", "cs-waiting-panel__state");
    wrap.dataset.waitingState = emptyState;
    if (emptyState === "failed") {
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", "Could not load waiting questions."));
      const retry = node(doc, "button", "cs-waiting-panel__action", "Retry");
      retry.type = "button";
      retry.dataset.waitingRetry = "";
      retry.addEventListener("click", () => handlers.onRetryLoad());
      wrap.append(retry);
    } else if (emptyState === "truncated") {
      const text =
        vm.scope === "channel"
          ? `Showing the oldest 100 questions; newer ones in ${vm.place.label} may not be listed yet.`
          : "Showing the oldest 100 questions; more are waiting.";
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", text));
      const actions = node(doc, "div", "cs-waiting-panel__actions");
      if (vm.scope === "channel" && vm.counts.workspace.min > 0) {
        const showWs = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          `Show all channels (${wsNum})`,
        );
        showWs.type = "button";
        showWs.dataset.waitingSwitchScope = "workspace";
        showWs.addEventListener("click", () => handlers.onScopeChange("workspace"));
        actions.append(showWs);
      } else if (vm.scope !== "all" && vm.counts.all.min > 0) {
        const showAll = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          `Show all workspaces (${allNum})`,
        );
        showAll.type = "button";
        showAll.dataset.waitingSwitchScope = "all";
        showAll.addEventListener("click", () => handlers.onScopeChange("all"));
        actions.append(showAll);
      }
      const catchUp = buildCatchUpLink();
      if (catchUp) actions.append(catchUp);
      if (actions.children.length > 0) wrap.append(actions);
    } else if (emptyState === "loading") {
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", "Loading…"));
    } else {
      const emptyCopy =
        vm.scope === "channel"
          ? `Nothing waiting in ${vm.place.label}.`
          : vm.scope === "workspace"
            ? `Nothing waiting in ${vm.place.workspaceName}.`
            : "Nothing waiting on you.";
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", emptyCopy));
      if (vm.scope === "channel" && vm.counts.workspace.min > 0) {
        const showWs = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          `Show all channels (${wsNum})`,
        );
        showWs.type = "button";
        showWs.dataset.waitingSwitchScope = "workspace";
        showWs.addEventListener("click", () => handlers.onScopeChange("workspace"));
        wrap.append(showWs);
      } else if (vm.scope !== "all" && vm.counts.all.min > 0) {
        const showAll = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          `Show all workspaces (${allNum})`,
        );
        showAll.type = "button";
        showAll.dataset.waitingSwitchScope = "all";
        showAll.addEventListener("click", () => handlers.onScopeChange("all"));
        wrap.append(showAll);
      }
    }
    body.replaceChildren(wrap);
    return;
  }

  delete body.dataset.waitingEmptyKey;
  let list = body.querySelector<HTMLElement>("[data-waiting-list]");
  if (!list) {
    list = node(doc, "div", "cs-waiting-panel__list");
    list.dataset.waitingList = "";
    body.replaceChildren(list);
  }

  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(list.children)) {
    const el = child as HTMLElement;
    if (el.dataset.waitingCard) existing.set(`ask:${el.dataset.waitingCard}`, el);
    else if (el.dataset.waitingTodo) existing.set(`todo:${el.dataset.waitingTodo}`, el);
  }

  const keepKeys = new Set<string>([
    ...vm.items.map(item => `ask:${item.id}`),
    ...todos.map(todo => `todo:${todo.id}`),
  ]);
  const rawActive = doc.activeElement;
  const activeEl = rawActive && typeof (rawActive as HTMLElement).closest === "function" ? (rawActive as HTMLElement) : null;
  const activeCardEl = activeEl?.closest<HTMLElement>("[data-waiting-card], [data-waiting-todo]") ?? null;
  const activeKey = activeCardEl?.dataset.waitingCard
    ? `ask:${activeCardEl.dataset.waitingCard}`
    : activeCardEl?.dataset.waitingTodo
      ? `todo:${activeCardEl.dataset.waitingTodo}`
      : null;
  const activeControlId = activeKey && activeEl?.id ? activeEl.id : null;

  for (const [key, el] of existing) {
    if (!keepKeys.has(key)) el.remove();
  }

  let cursor: ChildNode | null = list.firstChild;
  for (const item of vm.items) {
    const key = `ask:${item.id}`;
    const sig = cardSignature(item, vm.scope);
    let card = existing.get(key);
    if (card && card.dataset.waitingCardSig === sig) {
      const timeEl = card.querySelector<HTMLTimeElement>(".cs-waiting-card__when");
      if (timeEl && timeEl.textContent !== item.when) timeEl.textContent = item.when;
    } else {
      const built = buildAskCard(doc, item, vm.scope, handlers);
      if (card) {
        if (cursor === card) cursor = built;
        card.replaceWith(built);
      } else {
        list.insertBefore(built, cursor);
      }
      card = built;
      if (activeKey === key && activeControlId) {
        const restored = doc.getElementById(activeControlId);
        if (restored && card.contains(restored)) restored.focus({ preventScroll: true });
      }
    }
    if (card !== cursor) list.insertBefore(card, cursor);
    else cursor = cursor.nextSibling;
  }

  for (const todo of todos) {
    const key = `todo:${todo.id}`;
    const sig = todoCardSignature(todo, vm.scope);
    let card = existing.get(key);
    if (!card || card.dataset.waitingCardSig !== sig) {
      const built = buildTodoCard(doc, todo, vm.scope, handlers);
      if (card) {
        if (cursor === card) cursor = built;
        card.replaceWith(built);
      } else {
        list.insertBefore(built, cursor);
      }
      card = built;
    }
    if (card !== cursor) list.insertBefore(card, cursor);
    else cursor = cursor.nextSibling;
  }

  // Show an inline incomplete notice with Retry whenever some reads failed alongside already-loaded cards.
  const existingNotice = body.querySelector<HTMLElement>("[data-waiting-incomplete]");
  if (vm.failed && !vm.complete) {
    if (!existingNotice) {
      const notice = node(doc, "div", "cs-waiting-panel__incomplete");
      notice.dataset.waitingIncomplete = "";
      notice.append(node(doc, "p", "cs-waiting-panel__state-text", "Some waiting questions could not be loaded."));
      const retry = node(doc, "button", "cs-waiting-panel__action", "Retry");
      retry.type = "button";
      retry.dataset.waitingRetry = "";
      retry.addEventListener("click", () => handlers.onRetryLoad());
      notice.append(retry);
      body.append(notice);
    }
  } else {
    existingNotice?.remove();
  }

  // Show an inline truncation notice whenever the server's 100-question page left more waiting.
  const existingTruncated = body.querySelector<HTMLElement>("[data-waiting-truncated]");
  if (vm.truncated && !vm.complete && !vm.failed) {
    if (!existingTruncated) {
      const notice = node(doc, "div", "cs-waiting-panel__incomplete");
      notice.dataset.waitingTruncated = "";
      notice.append(node(doc, "p", "cs-waiting-panel__state-text", "Showing the oldest 100 questions; more are waiting."));
      const catchUp = buildCatchUpLink();
      if (catchUp) notice.append(catchUp);
      body.append(notice);
    }
  } else {
    existingTruncated?.remove();
  }
}

export interface WaitingSurfaceOptions {
  onBeforeOpen?: () => void;
  onStateChange?: (open: boolean) => void;
}

export interface WaitingSurface {
  setEnabled(active: boolean): void;
  open(opener?: HTMLElement | null): void;
  close(restoreFocus?: boolean): void;
  toggle(opener?: HTMLElement | null): void;
  isOpen(): boolean;
  isPhone(): boolean;
  controlsId(): string;
  destroy(): void;
}

/**
 * Presentation controller matching createChannelDetails: owns the desktop right column and the phone
 * modal <dialog> sheet, starts closed, stays open across channel switches on desktop, and restores focus
 * to the channel header button when closed.
 */
export function createWaitingSurface(
  app: HTMLElement,
  options: WaitingSurfaceOptions = {},
): WaitingSurface {
  const doc = app.ownerDocument;
  const panel = app.querySelector<HTMLElement>("[data-waiting-panel]");
  const media = doc.defaultView!.matchMedia(WAITING_SHEET_MEDIA);
  const dialog = doc.createElement("dialog");
  dialog.id = WAITING_SHEET_ID;
  dialog.className = "cs-waiting-sheet";
  dialog.setAttribute("aria-label", "Waiting on you");
  const anchor = doc.createComment("Waiting on you panel");

  let mounted = false;
  let enabled = false;
  let expanded = false;
  let opener: HTMLElement | null = null;

  const isPhone = () => media.matches;
  const isOpen = () => enabled && (isPhone() ? dialog.open : expanded);
  const controlsId = () => (isPhone() ? WAITING_SHEET_ID : WAITING_PANEL_ID);

  const restorePanel = () => {
    if (panel && anchor.parentNode && panel.parentNode !== anchor.parentNode) {
      anchor.after(panel);
    }
  };

  const focusOpener = () => {
    const visibleTriggers = Array.from(app.querySelectorAll<HTMLElement>("[data-waiting-open]")).filter(
      el => el.getClientRects().length > 0,
    );
    const target =
      opener?.isConnected && opener.getClientRects().length > 0 ? opener : visibleTriggers[0] ?? null;
    target?.focus({ preventScroll: true });
  };

  const sync = () => {
    if (!panel || !mounted) return;
    if (!enabled) {
      if (dialog.open) dialog.close();
      restorePanel();
      panel.hidden = true;
      options.onStateChange?.(false);
      return;
    }
    if (isPhone()) {
      panel.hidden = !dialog.open;
    } else {
      if (dialog.open) dialog.close();
      restorePanel();
      panel.hidden = !expanded;
    }
    options.onStateChange?.(isOpen());
  };

  const close = (restoreFocus = true) => {
    const wasOpen = isOpen();
    if (dialog.open) dialog.close();
    restorePanel();
    if (!isPhone()) expanded = false;
    if (panel) panel.hidden = true;
    options.onStateChange?.(false);
    if (restoreFocus && wasOpen) focusOpener();
  };

  const open = (trigger?: HTMLElement | null) => {
    if (!panel || !mounted || !enabled) return;
    if (trigger) opener = trigger;
    options.onBeforeOpen?.();
    if (isPhone()) {
      if (!dialog.open) {
        panel.hidden = false;
        dialog.append(panel);
        dialog.showModal();
      }
      options.onStateChange?.(true);
      panel.querySelector<HTMLElement>("[data-waiting-close]")?.focus({ preventScroll: true });
    } else {
      expanded = true;
      restorePanel();
      panel.hidden = false;
      options.onStateChange?.(true);
    }
  };

  const toggle = (trigger?: HTMLElement | null) => {
    if (isOpen()) close(true);
    else open(trigger);
  };

  const onResize = () => {
    if (!mounted) return;
    if (dialog.open && !isPhone()) {
      dialog.close();
      restorePanel();
      expanded = true;
    } else if (expanded && isPhone() && enabled) {
      expanded = false;
    }
    sync();
  };

  const onCancel = (event: Event) => {
    event.preventDefault();
    close(true);
  };

  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === dialog && dialog.open) close(true);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || isPhone() || !isOpen()) return;
    const active = doc.activeElement as (HTMLElement & { value?: string }) | null;
    if (!panel?.contains(active)) return;
    if (active?.tagName === "INPUT" && typeof active.value === "string" && active.value.trim() !== "") return;
    event.preventDefault();
    close(true);
  };

  return {
    setEnabled(active: boolean) {
      if (!panel) return;
      if (!mounted && !active) return;
      if (!mounted) {
        panel.id = WAITING_PANEL_ID;
        panel.before(anchor);
        app.append(dialog);
        dialog.addEventListener("cancel", onCancel);
        dialog.addEventListener("click", onBackdropClick);
        app.addEventListener("keydown", onKeydown);
        media.addEventListener("change", onResize);
        mounted = true;
      }
      if (enabled && !active && dialog.open) {
        dialog.close();
        restorePanel();
      }
      enabled = active;
      sync();
    },
    open,
    close,
    toggle,
    isOpen,
    isPhone,
    controlsId,
    destroy() {
      if (!mounted) return;
      if (dialog.open) dialog.close();
      restorePanel();
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdropClick);
      app.removeEventListener("keydown", onKeydown);
      media.removeEventListener("change", onResize);
      dialog.remove();
      anchor.remove();
      if (panel) panel.hidden = true;
      mounted = false;
      enabled = false;
      expanded = false;
    },
  };
}

export interface WaitingFocusHint {
  kind: "retry-todo" | "completed-todo" | "completed-ask";
  todoId?: string;
  prevIndex?: number;
}

/** Moves keyboard focus to a stable control inside the Waiting on you panel after an in-card
 *  action fails or removes a card, so focus never falls back to document.body (preserving Escape). */
export function focusWaitingPanelAfterAction(
  container: HTMLElement,
  hint: WaitingFocusHint,
): HTMLElement | null {
  const focusEl = (el: HTMLElement | null | undefined): HTMLElement | null => {
    if (!el) return null;
    el.focus({ preventScroll: true });
    return el;
  };
  if (hint.kind === "retry-todo" && hint.todoId) {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-waiting-todo]"));
    const card = cards.find(el => el.dataset.waitingTodo === hint.todoId);
    if (card) {
      const target =
        card.querySelector<HTMLElement>("[data-waiting-todo-retry]")
        ?? card.querySelector<HTMLElement>("[data-waiting-todo-done]")
        ?? card.querySelector<HTMLElement>("[data-waiting-todo-open]");
      if (target) return focusEl(target);
    }
  }
  const body = container.querySelector<HTMLElement>("[data-waiting-body]");
  const remainingCards = body
    ? Array.from(body.querySelectorAll<HTMLElement>("article")).filter(
        el => el.dataset.waitingCard !== undefined || el.dataset.waitingTodo !== undefined,
      )
    : [];
  if (remainingCards.length > 0) {
    const idx = Math.min(Math.max(0, hint.prevIndex ?? 0), remainingCards.length - 1);
    const nextCard = remainingCards[idx]!;
    const control =
      nextCard.querySelector<HTMLElement>("[data-waiting-todo-done]")
      ?? nextCard.querySelector<HTMLElement>("[data-waiting-todo-retry]")
      ?? nextCard.querySelector<HTMLElement>("[data-waiting-todo-open]")
      ?? Array.from(nextCard.querySelectorAll<HTMLElement>("button")).find(btn => !(btn as HTMLButtonElement).disabled)
      ?? nextCard.querySelector<HTMLElement>("a")
      ?? Array.from(nextCard.querySelectorAll<HTMLElement>("input")).find(inp => !(inp as HTMLInputElement).disabled);
    if (control) return focusEl(control);
  }
  const emptyAll = container.querySelector<HTMLElement>("[data-waiting-empty-all]");
  if (emptyAll) return focusEl(emptyAll);
  const scope = container.querySelector<HTMLSelectElement>("[data-waiting-scope]");
  if (scope && !scope.disabled) return focusEl(scope);
  return focusEl(container.querySelector<HTMLElement>("[data-waiting-close]"));
}
