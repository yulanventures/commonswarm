/**
 * Waiting on you channel panel: a closeable right column beside the conversation on desktop and a modal
 * dialog sheet on phone. Defaults to This channel, follows channel switches on desktop, and lets people
 * answer choice questions directly in each card without leaving chat.
 *
 * Pure DOM: every untrusted string (question body, channel/workspace/sender names, option labels and
 * descriptions, Something else text) enters only through textContent.
 */
import { buildChoiceCard } from "./choice-card";
import { cleanOtherText, OTHER_TEXT_MAX, splitChoicePrompt, STALE_ASK_CLOSE_BODY, type AskChoiceState, type ChoiceDraft, type ChoiceOption, type ChoiceSubmission } from "./choices";
import { formatWhen, initials, personFirstName, personTint } from "./home-names";
import type { WaitingArchivedEntry, WaitingArchivedOutcomeKind } from "./home/contract";
import { agentOrb, personAvatar } from "./home-primitives";
import type { AgentVM, PersonVM } from "./home-types";
import {
  classifyAskConversation,
  conversationParticipantKey,
  indexDirectConversations,
  type ClassifyAskOptions,
  type WaitingConversation,
  type WaitingParticipantRef,
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
  conversationParticipantKey,
  focusWaitingSurvey,
  indexDirectConversations,
  surveyDraftKey,
  surveyReadyEntries,
  surveySubmissionFromDraft,
  type ClassifyAskOptions,
  type SurveyDraft,
  type WaitingConversation,
  type WaitingParticipantRef,
  type WaitingSignalPlacement,
  type WaitingSurveyFocusTarget,
  type WaitingSurveyHandlers,
  type WaitingSurveyVM,
};

export type WaitingScope = "channel" | "workspace" | "all";

export interface WaitingPlace {
  workspaceId: string;
  workspaceName: string;
  kind: "channel" | "general" | "all" | "dm" | "group_dm";
  channelId: string | null;
  label: string;
  dm?: { kind: "person" | "agent"; id: string };
  conversationId?: string | null;
  participantKey?: string;
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

export interface WaitingPlainAskItem {
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
  draftText?: string;
  pending?: true;
  pendingMode?: "answer" | "stale";
  error?: string;
  retryable?: true;
}

export type WaitingTodoReason = "assigned" | "request" | "after" | "hold" | "agent_removed";
export type WaitingTodoPlacement = "channel" | "general" | "dm" | "group_dm" | "workspace";
export type WaitingPanelTab = "active" | "archived";
export type WaitingArchivedPlacement = "channel" | "general" | "dm" | "group_dm" | "workspace" | "redacted";
export type { WaitingArchivedOutcomeKind };

export interface WaitingDismissedPlaceholder {
  key: string;
  itemKind: "ask" | "todo" | "review";
  itemId: string;
  cardId: string;
  workspaceId: string;
  position: number;
  pendingUndo?: true;
}

export type WaitingDismissBatchVM =
  | { phase: "loading" }
  | { phase: "confirm"; total: number }
  | { phase: "running"; processed: number; total: number; stopping: boolean }
  | { phase: "done"; doneCount: number; total: number };

export interface WaitingArchivedItem {
  itemKey: string;
  kind: "ask" | "todo" | "review";
  id: string;
  todoId?: string | null;
  askKind?: "choice" | "plain" | null;
  workspaceId: string;
  workspaceName: string;
  title: string;
  from: PersonVM | AgentVM | null;
  outcomeKind: WaitingArchivedOutcomeKind;
  outcomeText: string;
  archivedAt: string;
  when: string;
  answeredByName?: string | null;
  answeredByViewer?: boolean;
  placement: WaitingArchivedPlacement;
  channelId?: string | null;
  conversationId?: string | null;
  channelLabel?: string;
  href?: string | null;
  restoring?: true;
  error?: string;
}

export interface WaitingArchivedVM {
  items: WaitingArchivedItem[];
  counts: WaitingPanelCounts;
  loading: boolean;
  loadingMore: boolean;
  complete: boolean;
  failed: boolean;
  unavailable?: boolean;
  hasMore: boolean;
}

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
  conversationId?: string | null;
  offerId?: string | null;
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
  tab?: WaitingPanelTab;
  scope: WaitingScope;
  place: WaitingPlace;
  items: WaitingAskItem[];
  plainAsks?: WaitingPlainAskItem[];
  todos?: WaitingTodoItem[];
  dismissedPlaceholders?: WaitingDismissedPlaceholder[];
  dismissBatch?: WaitingDismissBatchVM | null;
  archived?: WaitingArchivedVM | null;
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
  onTabChange?: (tab: WaitingPanelTab) => void;
  onScopeChange: (scope: WaitingScope) => void;
  onClose: () => void;
  onRetryLoad: () => void;
  onRetryArchived?: () => void;
  onLoadMoreArchived?: () => void;
  onOpenArchivedTodo?: (item: WaitingArchivedItem) => void;
  onRestoreArchived?: (item: WaitingArchivedItem) => void;
  onSubmitChoice: (item: WaitingAskItem, submission: ChoiceSubmission) => void;
  onRetryChoice: (item: WaitingAskItem) => void;
  onDraftChoice: (item: WaitingAskItem, draft: ChoiceDraft) => void;
  onDismissAsk?: (item: WaitingAskItem) => void;
  onSubmitPlainAsk?: (item: WaitingPlainAskItem, bodyText: string, mode: "answer" | "stale") => void;
  onRetryPlainAsk?: (item: WaitingPlainAskItem) => void;
  onDraftPlainAsk?: (item: WaitingPlainAskItem, text: string) => void;
  onDismissPlainAsk?: (item: WaitingPlainAskItem) => void;
  onMarkTodoDone?: (item: WaitingTodoItem) => void;
  onRetryTodo?: (item: WaitingTodoItem) => void;
  onOpenTodo?: (item: WaitingTodoItem) => void;
  onDismissTodo?: (item: WaitingTodoItem) => void;
  onUndoDismiss?: (placeholder: WaitingDismissedPlaceholder) => void;
  onDismissAllStart?: () => void;
  onDismissAllConfirm?: () => void;
  onDismissAllCancel?: () => void;
  onDismissAllStop?: () => void;
  onOpenCatchUp?: (href: string) => void;
  onStartSurvey?: () => void;
  surveyHandlers?: WaitingSurveyHandlers;
}

export const WAITING_PANEL_ID = "cs-waiting-panel";
export const WAITING_SHEET_ID = "cs-waiting-sheet";
export const WAITING_SHEET_MEDIA = "(max-width: 52rem), (max-height: 32rem)";

/** Filters open asks (choice or historical plain-text) by the selected scope and active conversation. */
export function filterWaitingItems<T extends { workspaceId: string; conversation: WaitingConversation }>(
  items: readonly T[],
  scope: WaitingScope,
  place: WaitingPlace,
): T[] {
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
    if (place.kind === "dm" || place.kind === "group_dm") {
      if (item.conversation.kind !== "dm" && item.conversation.kind !== "group_dm") return false;
      const placeConvId = place.conversationId?.trim().toLowerCase() || null;
      const itemConvId = item.conversation.conversationId?.trim().toLowerCase() || null;
      if (placeConvId && itemConvId) {
        return itemConvId === placeConvId;
      }
      if (place.kind === "group_dm") {
        return (
          item.conversation.kind === "group_dm" &&
          Boolean(place.participantKey && item.conversation.participantKey === place.participantKey)
        );
      }
      if (item.conversation.kind !== "dm") return false;
      if (place.participantKey && item.conversation.participantKey) {
        return item.conversation.participantKey === place.participantKey;
      }
      if (place.dm) {
        return (
          item.conversation.partnerKind === place.dm.kind &&
          item.conversation.partnerId.toLowerCase() === place.dm.id.toLowerCase()
        );
      }
      return false;
    }
    return false;
  });
}

/** Filters waiting/assigned to-dos by scope. Channel-origin and #general-origin to-dos appear in
 *  their authoritative channel's This channel queue; DM-origin to-dos match only by authoritative
 *  conversation_id; genuinely workspace-only to-dos stay in All channels, All workspaces, and All
 *  messages so they never clutter an unrelated channel or DM. */
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
    if (place.kind === "dm" || place.kind === "group_dm") {
      const placeConvId = place.conversationId?.trim().toLowerCase() || null;
      const todoConvId = todo.conversationId?.trim().toLowerCase() || null;
      return (placement === "dm" || placement === "group_dm") && Boolean(placeConvId && todoConvId && todoConvId === placeConvId);
    }
    return false;
  });
}

/** Filters archived Waiting on you items by scope using exact channel/conversation isolation.
 *  Workspace-only and redacted (left-group/private) items stay out of This channel / This conversation
 *  and remain visible in All channels, All workspaces, and All messages. */
export function filterWaitingArchived(
  items: readonly WaitingArchivedItem[],
  scope: WaitingScope,
  place: WaitingPlace,
): WaitingArchivedItem[] {
  if (scope === "all") return [...items];
  if (scope === "workspace") return items.filter(item => item.workspaceId === place.workspaceId);
  if (place.kind === "all") return items.filter(item => item.workspaceId === place.workspaceId);
  return items.filter(item => {
    if (item.workspaceId !== place.workspaceId) return false;
    if (place.kind === "channel") {
      return item.placement === "channel" && item.channelId === place.channelId;
    }
    if (place.kind === "general") {
      return item.placement === "general";
    }
    if (place.kind === "dm" || place.kind === "group_dm") {
      const placeConvId = place.conversationId?.trim().toLowerCase() || null;
      const itemConvId = item.conversationId?.trim().toLowerCase() || null;
      return (item.placement === "dm" || item.placement === "group_dm") && Boolean(placeConvId && itemConvId && itemConvId === placeConvId);
    }
    return false;
  });
}

/** Converts one server WaitingArchivedEntry row into a renderable WaitingArchivedItem (lives in the lazy panel chunk). */
export function mapWaitingArchivedEntry(
  entry: WaitingArchivedEntry,
  ctx: {
    workspaceId: string;
    workspaceName: string;
    channelLabel: string;
    href: string | null;
    viewerId?: string | null;
    now?: number;
  },
): WaitingArchivedItem {
  const name = entry.from?.name?.trim() || (entry.from?.kind === "agent" ? "Agent" : "Member");
  let from: PersonVM | AgentVM | null = null;
  if (entry.from) {
    if (entry.from.kind === "agent") {
      from = {
        id: entry.from.id,
        name,
        label: name,
        nestedLabel: name,
        ownerId: null,
        ownerFirstName: null,
        ownerInitial: "",
        yours: false,
        tint: personTint(entry.from.id),
        hosted: false,
        state: {
          kind: "idle",
          word: "Idle",
          detail: "",
          attention: false,
          fix: { action: null, allowed: false, askWho: null, sentence: "" },
        },
      };
    } else {
      from = {
        id: entry.from.id,
        name,
        firstName: personFirstName(name) || name,
        initials: initials(name),
        you: Boolean(ctx.viewerId && entry.from.id === ctx.viewerId),
        role: "member",
      };
    }
  }
  const title =
    entry.kind === "ask" && entry.ask_kind === "choice"
      ? ((splitChoicePrompt(entry.title).question ?? entry.title).trim() || entry.title)
      : entry.title.trim();
  return {
    itemKey: entry.item_key,
    kind: entry.kind,
    id: entry.id,
    todoId: entry.todo_id,
    askKind: entry.ask_kind,
    workspaceId: ctx.workspaceId,
    workspaceName: ctx.workspaceName,
    title,
    from,
    outcomeKind: entry.outcome_kind,
    outcomeText: entry.outcome_text,
    archivedAt: entry.archived_at,
    when: formatWhen(entry.archived_at, ctx.now ?? Date.now()),
    answeredByName: entry.answered_by?.name ?? null,
    answeredByViewer: entry.answered_by?.by_viewer,
    placement: entry.placement,
    channelId: entry.channel_id,
    conversationId: entry.conversation_id,
    channelLabel: ctx.channelLabel,
    href: ctx.href,
  };
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

function todoCardSignature(item: WaitingTodoItem, scope: WaitingScope, canDismiss: boolean): string {
  return JSON.stringify([
    item.id,
    item.workspaceId,
    item.workspaceName,
    item.placement ?? "workspace",
    item.channelId ?? "",
    item.conversationId ?? "",
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
    canDismiss,
  ]);
}

function buildTodoCard(
  doc: Document,
  item: WaitingTodoItem,
  scope: WaitingScope,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const canDismiss = Boolean(handlers.onDismissTodo);
  const card = node(doc, "article", "cs-waiting-card cs-waiting-card--todo");
  card.dataset.waitingTodo = item.id;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = todoCardSignature(item, scope, canDismiss);

  const todoHead = node(doc, "div", "cs-waiting-card__todo-head");
  const meta = node(doc, "div", "cs-waiting-card__todo-meta");
  const kind = node(doc, "span", "cs-waiting-card__todo-kind", todoReasonLabel(item.reason));
  meta.append(kind);
  const due = formatTodoDue(item.dueOn);
  if (due) meta.append(node(doc, "span", "cs-waiting-card__todo-due", due));
  const location = todoCardLocationText(item, scope);
  if (location) meta.append(node(doc, "span", "cs-waiting-card__place", location));
  todoHead.append(meta);
  if (canDismiss) {
    const dismiss = node(doc, "button", "cs-waiting-card__dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.dataset.waitingDismiss = item.reason === "request" ? "review" : "todo";
    dismiss.dataset.waitingDismissId = item.id;
    if (item.pending) dismiss.setAttribute("aria-disabled", "true");
    dismiss.addEventListener("click", () => {
      if (item.pending) return;
      handlers.onDismissTodo?.(item);
    });
    todoHead.append(dismiss);
  }

  const title = node(doc, "p", "cs-waiting-card__question", item.title);
  card.append(todoHead, title);

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

function cardLocationText(item: Pick<WaitingAskItem, "workspaceName" | "channelLabel">, scope: WaitingScope): string | null {
  if (scope === "channel") return null;
  if (scope === "workspace") return item.channelLabel || null;
  return item.channelLabel ? `${item.workspaceName} · ${item.channelLabel}` : item.workspaceName;
}

function cardSignature(item: WaitingAskItem, scope: WaitingScope, canDismiss: boolean): string {
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
    canDismiss,
  ]);
}

function plainAskCardSignature(item: WaitingPlainAskItem, scope: WaitingScope, canDismiss: boolean): string {
  return JSON.stringify([
    item.id,
    item.workspaceId,
    item.conversation,
    item.channelLabel,
    item.from.name,
    item.what,
    scope,
    item.pending ?? false,
    item.pendingMode ?? "",
    item.error ?? "",
    item.retryable ?? false,
    canDismiss,
  ]);
}

function dismissedPlaceholderSignature(placeholder: WaitingDismissedPlaceholder): string {
  return JSON.stringify([
    placeholder.key,
    placeholder.itemKind,
    placeholder.itemId,
    placeholder.pendingUndo ?? false,
  ]);
}

function buildDismissedPlaceholder(
  doc: Document,
  placeholder: WaitingDismissedPlaceholder,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const row = node(doc, "div", "cs-waiting-card cs-waiting-card--dismissed");
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  row.dataset.waitingDismissed = placeholder.key;
  row.dataset.waitingWorkspace = placeholder.workspaceId;
  row.dataset.waitingCardSig = dismissedPlaceholderSignature(placeholder);

  const label = node(doc, "span", "cs-waiting-dismissed__label", "Dismissed");
  const undo = node(doc, "button", "cs-waiting-dismissed__undo", placeholder.pendingUndo ? "Undoing…" : "Undo");
  undo.type = "button";
  undo.dataset.waitingUndo = placeholder.key;
  if (placeholder.pendingUndo) undo.setAttribute("aria-disabled", "true");
  undo.addEventListener("click", () => {
    if (placeholder.pendingUndo) return;
    handlers.onUndoDismiss?.(placeholder);
  });
  row.append(label, undo);
  return row;
}

function buildPlainAskCard(
  doc: Document,
  item: WaitingPlainAskItem,
  scope: WaitingScope,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const canDismiss = Boolean(handlers.onDismissPlainAsk);
  const card = node(doc, "article", "cs-waiting-card cs-waiting-card--plain");
  card.dataset.waitingPlainAsk = item.id;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = plainAskCardSignature(item, scope, canDismiss);

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
  const pending = item.pending === true;
  if (canDismiss) {
    const dismiss = node(doc, "button", "cs-waiting-card__dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.dataset.waitingDismiss = "ask";
    dismiss.dataset.waitingDismissId = item.id;
    if (pending) dismiss.setAttribute("aria-disabled", "true");
    dismiss.addEventListener("click", () => {
      if (pending) return;
      handlers.onDismissPlainAsk?.(item);
    });
    head.append(dismiss);
  }

  const question = node(doc, "p", "cs-waiting-card__question", item.what);

  const pendingStale = pending && item.pendingMode === "stale";
  const safeId = item.id.replace(/[^a-zA-Z0-9_-]/gu, "-");
  const form = node(doc, "form", "cs-waiting-plain__form");
  form.noValidate = true;

  const input = node(doc, "input", "cs-waiting-plain__input");
  input.type = "text";
  input.id = `cs-waiting-plain-input-${safeId}`;
  input.maxLength = OTHER_TEXT_MAX;
  input.autocomplete = "off";
  input.dataset.waitingPlainInput = item.id;
  input.setAttribute("aria-label", "Answer");
  input.placeholder = "Type your answer…";
  input.value = item.draftText ?? "";
  if (pending) input.readOnly = true;

  const actions = node(doc, "div", "cs-waiting-plain__actions");
  const clearBtn = node(doc, "button", "cs-waiting-plain__stale", pendingStale ? "Clearing…" : "Clear as stale");
  clearBtn.type = "button";
  clearBtn.id = `cs-waiting-plain-stale-${safeId}`;
  clearBtn.dataset.waitingPlainStale = item.id;
  if (pending) clearBtn.setAttribute("aria-disabled", "true");
  clearBtn.addEventListener("click", () => {
    if (pending) return;
    handlers.onSubmitPlainAsk?.(item, STALE_ASK_CLOSE_BODY, "stale");
  });

  const sendBtn = node(doc, "button", "cs-waiting-plain__send", pending && !pendingStale ? "Sending…" : "Send");
  sendBtn.type = "submit";
  sendBtn.id = `cs-waiting-plain-send-${safeId}`;
  sendBtn.dataset.waitingPlainSend = item.id;
  if (pending) sendBtn.setAttribute("aria-disabled", "true");

  const syncSend = () => {
    sendBtn.disabled = !pending && cleanOtherText(input.value) === null;
  };
  input.addEventListener("input", () => {
    if (pending) return;
    syncSend();
    handlers.onDraftPlainAsk?.(item, input.value);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending) return;
    const text = cleanOtherText(input.value);
    if (text === null) return;
    handlers.onSubmitPlainAsk?.(item, text, "answer");
  });
  syncSend();

  actions.append(clearBtn, sendBtn);
  form.append(input);
  if (item.error) {
    const err = node(doc, "p", "cs-waiting-card__error", item.error);
    err.setAttribute("role", "alert");
    form.append(err);
  }
  form.append(actions);
  card.append(head, question, form);

  if (item.error && item.retryable && !pending) {
    const retryRow = node(doc, "div", "cs-waiting-card__retry-row");
    const retry = node(doc, "button", "cs-waiting-card__retry", "Retry");
    retry.type = "button";
    retry.dataset.waitingPlainRetry = item.id;
    retry.addEventListener("click", () => handlers.onRetryPlainAsk?.(item));
    retryRow.append(retry);
    card.append(retryRow);
  }
  return card;
}

function buildAskCard(
  doc: Document,
  item: WaitingAskItem,
  scope: WaitingScope,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const canDismiss = Boolean(handlers.onDismissAsk);
  const card = node(doc, "article", "cs-waiting-card");
  card.dataset.waitingCard = item.id;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = cardSignature(item, scope, canDismiss);

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
  if (canDismiss) {
    const dismiss = node(doc, "button", "cs-waiting-card__dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.dataset.waitingDismiss = "ask";
    dismiss.dataset.waitingDismissId = item.id;
    if (item.choices.pending) dismiss.setAttribute("aria-disabled", "true");
    dismiss.addEventListener("click", () => {
      if (item.choices.pending) return;
      handlers.onDismissAsk?.(item);
    });
    head.append(dismiss);
  }

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

function archivedCardSignature(item: WaitingArchivedItem, scope: WaitingScope, canRestore: boolean): string {
  return JSON.stringify([
    scope,
    item.itemKey,
    item.kind,
    item.workspaceName,
    item.channelLabel ?? "",
    item.from ? item.from.name : "",
    item.title,
    item.outcomeKind,
    item.outcomeText,
    item.archivedAt,
    item.when,
    item.answeredByName ?? "",
    item.answeredByViewer ?? null,
    item.href ?? "",
    item.restoring ?? false,
    item.error ?? "",
    canRestore,
  ]);
}

function archivedMetaText(item: WaitingArchivedItem): string {
  const when = item.when || formatWhen(item.archivedAt, Date.now());
  const who = item.answeredByViewer === false && item.answeredByName ? item.answeredByName : "";
  if (item.outcomeKind === "answered") {
    return who ? `Answered by ${who} · ${when}` : `Answered · ${when}`;
  }
  return who ? `${who} · ${when}` : when;
}

function buildArchivedCard(
  doc: Document,
  item: WaitingArchivedItem,
  scope: WaitingScope,
  handlers: WaitingPanelHandlers,
): HTMLElement {
  const canRestore = item.outcomeKind === "dismissed" && Boolean(handlers.onRestoreArchived);
  const card = node(doc, "article", "cs-waiting-card cs-waiting-card--archived");
  card.dataset.waitingArchivedItem = item.itemKey;
  card.dataset.waitingArchivedKind = item.kind;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = archivedCardSignature(item, scope, canRestore);

  const head = node(doc, "div", "cs-waiting-card__head");
  if (item.from) {
    head.append(isAgent(item.from) ? agentOrb(doc, item.from, true) : personAvatar(doc, item.from));
  }
  const meta = node(doc, "div", "cs-waiting-card__meta");
  const byline = node(doc, "div", "cs-waiting-card__byline");
  const whoLabel = item.from
    ? item.from.name
    : item.kind === "review"
      ? "Review"
      : "To-do";
  byline.append(node(doc, "span", "cs-waiting-card__sender", whoLabel));
  const kindTag = item.kind === "review" ? "Review" : item.kind === "todo" ? "To-do" : null;
  if (kindTag && item.from) {
    byline.append(node(doc, "span", "cs-waiting-archived__kind", kindTag));
  }
  meta.append(byline);

  const placeText =
    scope === "all"
      ? [item.workspaceName, item.channelLabel].filter(Boolean).join(" · ")
      : scope === "workspace"
        ? (item.channelLabel ?? "")
        : "";
  if (placeText) {
    meta.append(node(doc, "span", "cs-waiting-card__place", placeText));
  }
  head.append(meta);

  const title = node(doc, "p", "cs-waiting-card__question", item.title);

  const tone =
    item.outcomeKind === "answered" || item.outcomeKind === "done" || item.outcomeKind === "accepted"
      ? "positive"
      : "muted";
  const outcome = node(doc, "div", "cs-waiting-archived__outcome");
  outcome.dataset.waitingArchivedOutcome = item.outcomeKind;
  outcome.dataset.outcomeTone = tone;
  outcome.append(node(doc, "p", "cs-waiting-archived__answer", item.outcomeText));
  const time = node(doc, "time", "cs-waiting-archived__meta", archivedMetaText(item));
  time.dateTime = item.archivedAt;
  time.title = item.archivedAt;
  outcome.append(time);

  card.append(head, title, outcome);

  if (item.error) {
    const err = node(doc, "p", "cs-waiting-card__error", item.error);
    err.setAttribute("role", "alert");
    card.append(err);
  }

  if (canRestore || item.href) {
    const actions = node(doc, "div", "cs-waiting-card__actions");
    if (canRestore) {
      const restore = node(doc, "button", "cs-waiting-panel__action", item.restoring ? "Restoring…" : "Restore");
      restore.type = "button";
      restore.dataset.waitingArchivedRestore = item.itemKey;
      if (item.restoring) restore.setAttribute("aria-disabled", "true");
      restore.addEventListener("click", () => {
        if (item.restoring) return;
        handlers.onRestoreArchived?.(item);
      });
      actions.append(restore);
    }
    if (item.href) {
      const open = node(doc, "a", "cs-waiting-panel__action", "Open");
      open.href = item.href;
      open.dataset.waitingArchivedOpen = item.itemKey;
      open.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!handlers.onOpenArchivedTodo) return;
        event.preventDefault();
        handlers.onOpenArchivedTodo(item);
      });
      actions.append(open);
    }
    card.append(actions);
  }
  return card;
}

function renderWaitingArchivedBody(
  doc: Document,
  body: HTMLElement,
  vm: WaitingPanelVM,
  handlers: WaitingPanelHandlers,
): void {
  const archived = vm.archived;
  const items = archived?.items ?? [];
  if (!archived || items.length === 0) {
    const emptyState = archived?.unavailable
      ? "unavailable"
      : archived?.failed
        ? "failed"
        : !archived || archived.loading || archived.loadingMore || !archived.complete
          ? "loading"
          : archived.hasMore
            ? "more"
            : "empty";
    const counts = archived?.counts ?? {
      channel: { min: 0, complete: false },
      workspace: { min: 0, complete: false },
      all: { min: 0, complete: false },
    };
    const wsNum = formatScopeCount(counts.workspace);
    const allNum = formatScopeCount(counts.all);
    const emptyKey = JSON.stringify([
      "archived",
      emptyState,
      vm.scope,
      vm.place.label,
      vm.place.workspaceName,
      wsNum,
      allNum,
      counts.workspace.min,
      counts.all.min,
      archived?.hasMore ?? false,
      archived?.loadingMore ?? false,
      Boolean(handlers.onLoadMoreArchived),
    ]);
    if (body.dataset.waitingArchivedEmptyKey === emptyKey) return;
    body.dataset.waitingArchivedEmptyKey = emptyKey;

    const wrap = node(doc, "div", "cs-waiting-panel__state");
    wrap.dataset.waitingArchivedState = emptyState;
    if (emptyState === "unavailable") {
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", "Archived history is unavailable on this server."));
    } else if (emptyState === "failed") {
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", "Could not load archived items."));
      const retry = node(doc, "button", "cs-waiting-panel__action", "Retry");
      retry.type = "button";
      retry.dataset.waitingArchivedRetry = "";
      retry.addEventListener("click", () => (handlers.onRetryArchived ?? handlers.onRetryLoad)());
      wrap.append(retry);
    } else if (emptyState === "loading") {
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", "Loading…"));
    } else if (emptyState === "more") {
      const moreCopy =
        vm.scope === "channel"
          ? `No matches in ${vm.place.label} on the loaded archive pages.`
          : vm.scope === "workspace"
            ? `Older archived items in ${vm.place.workspaceName} are not loaded yet.`
            : "Older archived items are not loaded yet.";
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", moreCopy));
      const actions = node(doc, "div", "cs-waiting-panel__actions");
      if (handlers.onLoadMoreArchived) {
        const loadMore = node(doc, "button", "cs-waiting-panel__action cs-waiting-panel__more", "Load older");
        loadMore.type = "button";
        loadMore.dataset.waitingArchivedMore = "";
        loadMore.addEventListener("click", () => handlers.onLoadMoreArchived?.());
        actions.append(loadMore);
      }
      if (vm.scope === "channel" && counts.workspace.min > 0) {
        const showWs = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          wsNum ? `Show all channels (${wsNum})` : "Show all channels",
        );
        showWs.type = "button";
        showWs.dataset.waitingSwitchScope = "workspace";
        showWs.addEventListener("click", () => handlers.onScopeChange("workspace"));
        actions.append(showWs);
      } else if (vm.scope !== "all" && counts.all.min > 0) {
        const showAll = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          allNum ? `Show all workspaces (${allNum})` : "Show all workspaces",
        );
        showAll.type = "button";
        showAll.dataset.waitingSwitchScope = "all";
        showAll.addEventListener("click", () => handlers.onScopeChange("all"));
        actions.append(showAll);
      }
      if (actions.children.length > 0) wrap.append(actions);
    } else {
      const emptyCopy =
        vm.scope === "channel"
          ? `No archived items in ${vm.place.label}.`
          : vm.scope === "workspace"
            ? `No archived items in ${vm.place.workspaceName}.`
            : "No archived items yet.";
      wrap.append(node(doc, "p", "cs-waiting-panel__state-text", emptyCopy));
      if (vm.scope === "channel" && counts.workspace.min > 0) {
        const showWs = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          wsNum ? `Show all channels (${wsNum})` : "Show all channels",
        );
        showWs.type = "button";
        showWs.dataset.waitingSwitchScope = "workspace";
        showWs.addEventListener("click", () => handlers.onScopeChange("workspace"));
        wrap.append(showWs);
      } else if (vm.scope !== "all" && counts.all.min > 0) {
        const showAll = node(
          doc,
          "button",
          "cs-waiting-panel__action",
          allNum ? `Show all workspaces (${allNum})` : "Show all workspaces",
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

  delete body.dataset.waitingArchivedEmptyKey;
  let list = body.querySelector<HTMLElement>("[data-waiting-archived-list]");
  if (!list) {
    list = node(doc, "div", "cs-waiting-panel__list");
    list.dataset.waitingArchivedList = "";
    body.replaceChildren(list);
  }

  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(list.children)) {
    const el = child as HTMLElement;
    if (el.dataset.waitingArchivedItem) existing.set(el.dataset.waitingArchivedItem, el);
  }
  const keepKeys = new Set(items.map(i => i.itemKey));
  for (const [key, el] of existing) {
    if (!keepKeys.has(key)) el.remove();
  }

  let cursor: ChildNode | null = list.firstChild;
  for (const item of items) {
    const canRestore = item.outcomeKind === "dismissed" && Boolean(handlers.onRestoreArchived);
    const sig = archivedCardSignature(item, vm.scope, canRestore);
    let card = existing.get(item.itemKey);
    if (!card || card.dataset.waitingCardSig !== sig) {
      const built = buildArchivedCard(doc, item, vm.scope, handlers);
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

  const existingMore = body.querySelector<HTMLButtonElement>("[data-waiting-archived-more]");
  if (archived.hasMore && handlers.onLoadMoreArchived) {
    const btn = existingMore ?? node(doc, "button", "cs-waiting-panel__action cs-waiting-panel__more");
    btn.type = "button";
    btn.dataset.waitingArchivedMore = "";
    btn.disabled = archived.loadingMore;
    btn.textContent = archived.loadingMore ? "Loading…" : "Load older";
    btn.onclick = () => handlers.onLoadMoreArchived?.();
    if (!existingMore) body.append(btn);
  } else {
    existingMore?.remove();
  }

  const existingNotice = body.querySelector<HTMLElement>("[data-waiting-archived-incomplete]");
  if (archived.failed) {
    if (!existingNotice) {
      const notice = node(doc, "div", "cs-waiting-panel__incomplete");
      notice.dataset.waitingArchivedIncomplete = "";
      notice.append(node(doc, "p", "cs-waiting-panel__state-text", "Some archived items could not be loaded."));
      const retry = node(doc, "button", "cs-waiting-panel__action", "Retry");
      retry.type = "button";
      retry.dataset.waitingArchivedRetry = "";
      retry.addEventListener("click", () => (handlers.onRetryArchived ?? handlers.onRetryLoad)());
      notice.append(retry);
      body.append(notice);
    }
  } else {
    existingNotice?.remove();
  }
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

    const tabs = node(doc, "div", "cs-waiting-panel__tabs");
    tabs.dataset.waitingTabs = "";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Waiting view");
    tabs.hidden = true;
    for (const [tabVal, tabLabel] of [["active", "Waiting"], ["archived", "Archived"]] as const) {
      const btn = node(doc, "button", "cs-waiting-panel__tab", tabLabel);
      btn.id = `${WAITING_PANEL_ID}-tab-${tabVal}`;
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(tabVal === "active"));
      btn.setAttribute("aria-controls", `${WAITING_PANEL_ID}-body`);
      btn.dataset.waitingTab = tabVal;
      tabs.append(btn);
    }

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
    const batchControls = node(doc, "div", "cs-waiting-panel__batch");
    batchControls.dataset.waitingBatchControls = "";
    batchControls.hidden = true;
    controls.append(scope, reviewBtn, batchControls);

    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const cancelBtn = root?.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-cancel]");
      if (!cancelBtn || cancelBtn.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      cancelBtn.click();
    });

    // Visible confirmation banner and polite live region: announces "Sent" and stays visible after the last answer.
    const status = node(doc, "p", "cs-waiting-panel__status");
    status.dataset.waitingStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;

    const body = node(doc, "div", "cs-waiting-panel__body");
    body.id = `${WAITING_PANEL_ID}-body`;
    body.dataset.waitingBody = "";

    root.append(header, tabs, controls, status, body);
    container.replaceChildren(root);
  }

  const closeBtn = root.querySelector<HTMLButtonElement>("[data-waiting-close]");
  if (closeBtn) closeBtn.onclick = () => handlers.onClose();

  const activeTab: WaitingPanelTab = vm.tab === "archived" ? "archived" : "active";
  const showTabs = !vm.survey && (vm.archived !== undefined || Boolean(handlers.onTabChange));
  const tabsEl = root.querySelector<HTMLElement>("[data-waiting-tabs]");
  if (tabsEl) {
    tabsEl.hidden = !showTabs;
    const tabButtons = Array.from(tabsEl.querySelectorAll<HTMLButtonElement>("[data-waiting-tab]"));
    for (const btn of tabButtons) {
      const val = btn.dataset.waitingTab as WaitingPanelTab;
      const selected = val === activeTab;
      btn.setAttribute("aria-selected", String(selected));
      btn.tabIndex = selected ? 0 : -1;
      btn.onclick = () => {
        if (val !== activeTab) handlers.onTabChange?.(val);
      };
      btn.onkeydown = (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const nextVal: WaitingPanelTab =
          event.key === "Home" ? "active" : event.key === "End" ? "archived" : val === "active" ? "archived" : "active";
        const target = tabButtons.find(b => b.dataset.waitingTab === nextVal);
        target?.focus();
        if (nextVal !== activeTab) handlers.onTabChange?.(nextVal);
      };
    }
  }

  const placeEl = root.querySelector<HTMLElement>("[data-waiting-place]");
  if (placeEl) placeEl.textContent = placeHeadingText(vm);

  const activeCounts = activeTab === "archived" && vm.archived ? vm.archived.counts : vm.counts;
  const scopeEl = root.querySelector<HTMLSelectElement>("[data-waiting-scope]");
  if (scopeEl) {
    const isDirectPlace = vm.place.kind === "dm" || vm.place.kind === "group_dm";
    const labels: Record<WaitingScope, string> = {
      channel: scopeOptionText(isDirectPlace ? "This conversation" : "This channel", activeCounts.channel),
      workspace: scopeOptionText("All channels", activeCounts.workspace),
      all: scopeOptionText("All workspaces", activeCounts.all),
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

  const activeBatch = activeTab === "active" && !vm.survey ? (vm.dismissBatch ?? null) : null;
  const batchBusyHeader = activeBatch?.phase === "running";
  const reviewBtn = root.querySelector<HTMLButtonElement>("[data-waiting-review-start]");
  if (reviewBtn) {
    const showReview = !vm.survey && activeTab === "active" && !batchBusyHeader && vm.items.length >= 2 && Boolean(handlers.onStartSurvey);
    reviewBtn.hidden = !showReview;
    if (showReview) {
      reviewBtn.textContent = "Review questions";
      reviewBtn.onclick = () => handlers.onStartSurvey?.();
    }
  }

  const batchControls = root.querySelector<HTMLElement>("[data-waiting-batch-controls]");
  if (batchControls) {
    const visibleItemCount = vm.items.length + (vm.plainAsks?.length ?? 0) + (vm.todos?.length ?? 0);
    const canOfferDismissAll =
      !vm.survey && activeTab === "active" && visibleItemCount >= 2 && Boolean(handlers.onDismissAllStart);
    const headerMode =
      activeBatch?.phase === "loading"
        ? "loading"
        : activeBatch?.phase === "confirm"
          ? "confirm"
          : activeBatch?.phase === "running"
            ? "running"
            : canOfferDismissAll
              ? "button"
              : "hidden";
    batchControls.hidden = headerMode === "hidden";
    batchControls.dataset.waitingBatchMode = headerMode;
    if (headerMode === "hidden") {
      if (batchControls.children.length > 0) batchControls.replaceChildren();
    } else if (headerMode === "button" || headerMode === "loading") {
      let btn = batchControls.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all]");
      if (!btn) {
        btn = node(doc, "button", "cs-waiting-panel__dismiss-all", "Dismiss all");
        btn.type = "button";
        btn.dataset.waitingDismissAll = "";
        batchControls.replaceChildren(btn);
      }
      const busy = headerMode === "loading";
      if (btn.textContent !== "Dismiss all") btn.textContent = "Dismiss all";
      if (busy) {
        btn.setAttribute("aria-busy", "true");
        btn.setAttribute("aria-disabled", "true");
      } else {
        btn.removeAttribute("aria-busy");
        btn.removeAttribute("aria-disabled");
      }
      btn.onclick = () => {
        if (busy) return;
        handlers.onDismissAllStart?.();
      };
    } else if (headerMode === "confirm") {
      const total = activeBatch && activeBatch.phase === "confirm" ? activeBatch.total : 0;
      const promptText = `Dismiss all ${total}?`;
      const noteText = "You can restore items one by one from Archived.";
      const confirmText = `Dismiss ${total}`;
      let prompt = batchControls.querySelector<HTMLElement>("[data-waiting-batch-prompt]");
      let note = batchControls.querySelector<HTMLElement>("[data-waiting-batch-note]");
      let confirmBtn = batchControls.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-confirm]");
      let cancelBtn = batchControls.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-cancel]");
      if (!prompt || !note || !confirmBtn || !cancelBtn) {
        prompt = node(doc, "span", "cs-waiting-batch__prompt", promptText);
        prompt.dataset.waitingBatchPrompt = "";
        note = node(doc, "p", "cs-waiting-batch__note", noteText);
        note.dataset.waitingBatchNote = "";
        const actions = node(doc, "div", "cs-waiting-batch__actions");
        confirmBtn = node(doc, "button", "cs-waiting-card__todo-done cs-waiting-batch__confirm", confirmText);
        confirmBtn.type = "button";
        confirmBtn.dataset.waitingDismissAllConfirm = "";
        cancelBtn = node(doc, "button", "cs-waiting-panel__action cs-waiting-batch__cancel", "Cancel");
        cancelBtn.type = "button";
        cancelBtn.dataset.waitingDismissAllCancel = "";
        const onEsc = (event: KeyboardEvent) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          cancelBtn?.click();
        };
        confirmBtn.addEventListener("keydown", onEsc);
        cancelBtn.addEventListener("keydown", onEsc);
        actions.append(confirmBtn, cancelBtn);
        batchControls.replaceChildren(prompt, note, actions);
      } else {
        if (prompt.textContent !== promptText) prompt.textContent = promptText;
        if (note.textContent !== noteText) note.textContent = noteText;
        if (confirmBtn.textContent !== confirmText) confirmBtn.textContent = confirmText;
      }
      confirmBtn.onclick = () => handlers.onDismissAllConfirm?.();
      cancelBtn.onclick = () => handlers.onDismissAllCancel?.();
    } else {
      const running = activeBatch as Extract<WaitingDismissBatchVM, { phase: "running" }>;
      const progressText = `Dismissing ${running.processed} of ${running.total}`;
      const stopText = running.stopping ? "Stopping…" : "Stop";
      let progress = batchControls.querySelector<HTMLElement>("[data-waiting-batch-progress]");
      let stopBtn = batchControls.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-stop]");
      if (!progress || !stopBtn) {
        progress = node(doc, "span", "cs-waiting-batch__progress", progressText);
        progress.setAttribute("role", "status");
        progress.setAttribute("aria-live", "polite");
        progress.dataset.waitingBatchProgress = "";
        stopBtn = node(doc, "button", "cs-waiting-panel__action cs-waiting-batch__stop", stopText);
        stopBtn.type = "button";
        stopBtn.dataset.waitingDismissAllStop = "";
        batchControls.replaceChildren(progress, stopBtn);
      } else {
        if (progress.textContent !== progressText) progress.textContent = progressText;
        if (stopBtn.textContent !== stopText) stopBtn.textContent = stopText;
      }
      if (running.stopping) stopBtn.setAttribute("aria-disabled", "true");
      else stopBtn.removeAttribute("aria-disabled");
      stopBtn.onclick = () => {
        if (running.stopping) return;
        handlers.onDismissAllStop?.();
      };
    }
  }

  const statusEl = root.querySelector<HTMLElement>("[data-waiting-status]");
  if (statusEl) {
    const hasStatus = activeTab === "active" && vm.statusMessage.trim() !== "";
    statusEl.hidden = !hasStatus;
    if (statusEl.dataset.waitingStatusSeq !== String(vm.statusSeq) || statusEl.textContent !== vm.statusMessage) {
      statusEl.dataset.waitingStatusSeq = String(vm.statusSeq);
      statusEl.textContent = vm.statusMessage;
    }
  }

  const body = root.querySelector<HTMLElement>("[data-waiting-body]");
  if (!body) return;
  if (showTabs) {
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", `${WAITING_PANEL_ID}-tab-${activeTab}`);
  } else {
    body.removeAttribute?.("role");
    body.removeAttribute?.("aria-labelledby");
  }

  if (vm.survey && handlers.surveyHandlers) {
    delete body.dataset.waitingEmptyKey;
    delete body.dataset.waitingArchivedEmptyKey;
    renderWaitingSurvey(body, vm.survey, handlers.surveyHandlers);
    return;
  }
  delete body.dataset.waitingSurveySig;
  delete body.dataset.waitingSurveyTypingSig;

  if (activeTab === "archived") {
    delete body.dataset.waitingEmptyKey;
    renderWaitingArchivedBody(doc, body, vm, handlers);
    return;
  }
  delete body.dataset.waitingArchivedEmptyKey;

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

  const plainAsks = vm.plainAsks ?? [];
  const todos = vm.todos ?? [];
  const dismissedPlaceholders = vm.dismissedPlaceholders ?? [];
  const showBatchResult = activeBatch !== null && activeBatch.phase === "done";
  const batchRunning = activeBatch !== null && activeBatch.phase === "running";
  if (
    vm.items.length === 0 &&
    plainAsks.length === 0 &&
    todos.length === 0 &&
    dismissedPlaceholders.length === 0 &&
    !showBatchResult &&
    !batchRunning
  ) {
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
    else if (el.dataset.waitingPlainAsk) existing.set(`plain:${el.dataset.waitingPlainAsk}`, el);
    else if (el.dataset.waitingTodo) existing.set(`todo:${el.dataset.waitingTodo}`, el);
    else if (el.dataset.waitingDismissed) existing.set(`dismissed:${el.dataset.waitingDismissed}`, el);
    else if (el.dataset.waitingBatchResult !== undefined) existing.set("batch-result", el);
  }

  type ActiveRenderSlot =
    | { slotKind: "batch-result"; key: string; item: Extract<WaitingDismissBatchVM, { phase: "done" }> }
    | { slotKind: "ask"; key: string; item: WaitingAskItem }
    | { slotKind: "todo"; key: string; item: WaitingTodoItem }
    | { slotKind: "plain"; key: string; item: WaitingPlainAskItem }
    | { slotKind: "dismissed"; key: string; item: WaitingDismissedPlaceholder };

  const orderedSlots: ActiveRenderSlot[] = [
    ...vm.items.map(item => ({ slotKind: "ask" as const, key: `ask:${item.id}`, item })),
    ...todos.map(item => ({ slotKind: "todo" as const, key: `todo:${item.id}`, item })),
    ...plainAsks.map(item => ({ slotKind: "plain" as const, key: `plain:${item.id}`, item })),
  ];
  const sortedPlaceholders = [...dismissedPlaceholders].sort((a, b) => a.position - b.position);
  for (const placeholder of sortedPlaceholders) {
    const insertAt = Math.max(0, Math.min(placeholder.position, orderedSlots.length));
    orderedSlots.splice(insertAt, 0, {
      slotKind: "dismissed",
      key: `dismissed:${placeholder.key}`,
      item: placeholder,
    });
  }
  if (showBatchResult && activeBatch.phase === "done") {
    orderedSlots.unshift({
      slotKind: "batch-result",
      key: "batch-result",
      item: activeBatch,
    });
  }

  const keepKeys = new Set<string>(orderedSlots.map(slot => slot.key));
  const rawActive = doc.activeElement;
  const activeEl = rawActive && typeof (rawActive as HTMLElement).closest === "function" ? (rawActive as HTMLElement) : null;
  const activeCardEl = activeEl?.closest<HTMLElement>("[data-waiting-card], [data-waiting-plain-ask], [data-waiting-todo], [data-waiting-dismissed]") ?? null;
  const activeKey = activeCardEl?.dataset.waitingCard
    ? `ask:${activeCardEl.dataset.waitingCard}`
    : activeCardEl?.dataset.waitingPlainAsk
      ? `plain:${activeCardEl.dataset.waitingPlainAsk}`
      : activeCardEl?.dataset.waitingTodo
        ? `todo:${activeCardEl.dataset.waitingTodo}`
        : activeCardEl?.dataset.waitingDismissed
          ? `dismissed:${activeCardEl.dataset.waitingDismissed}`
          : null;
  const activeControlId = activeKey && activeEl?.id ? activeEl.id : null;

  for (const [key, el] of existing) {
    if (!keepKeys.has(key)) el.remove();
  }

  const canDismissAsk = Boolean(handlers.onDismissAsk);
  const canDismissPlain = Boolean(handlers.onDismissPlainAsk);
  const canDismissTodo = Boolean(handlers.onDismissTodo);

  let cursor: ChildNode | null = list.firstChild;
  for (const slot of orderedSlots) {
    const key = slot.key;
    let card = existing.get(key);
    if (slot.slotKind === "batch-result") {
      const batchRow = slot.item;
      const labelText =
        batchRow.doneCount === batchRow.total
          ? `Dismissed ${batchRow.doneCount}`
          : `Dismissed ${batchRow.doneCount} of ${batchRow.total}`;
      if (!card) {
        const built = node(doc, "div", "cs-waiting-card cs-waiting-card--dismissed cs-waiting-batch-result");
        built.setAttribute("role", "status");
        built.setAttribute("aria-live", "polite");
        built.dataset.waitingBatchResult = batchRow.phase;
        const label = node(doc, "span", "cs-waiting-dismissed__label", labelText);
        label.dataset.waitingBatchResultLabel = "";
        built.append(label);
        list.insertBefore(built, cursor);
        card = built;
      } else {
        card.dataset.waitingBatchResult = batchRow.phase;
        const label = card.querySelector<HTMLElement>("[data-waiting-batch-result-label]");
        if (label && label.textContent !== labelText) label.textContent = labelText;
      }
    } else if (slot.slotKind === "ask") {
      const sig = cardSignature(slot.item, vm.scope, canDismissAsk);
      if (card && card.dataset.waitingCardSig === sig) {
        const timeEl = card.querySelector<HTMLTimeElement>(".cs-waiting-card__when");
        if (timeEl && timeEl.textContent !== slot.item.when) timeEl.textContent = slot.item.when;
      } else {
        const built = buildAskCard(doc, slot.item, vm.scope, handlers);
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
    } else if (slot.slotKind === "todo") {
      const sig = todoCardSignature(slot.item, vm.scope, canDismissTodo);
      if (!card || card.dataset.waitingCardSig !== sig) {
        const built = buildTodoCard(doc, slot.item, vm.scope, handlers);
        if (card) {
          if (cursor === card) cursor = built;
          card.replaceWith(built);
        } else {
          list.insertBefore(built, cursor);
        }
        card = built;
      }
    } else if (slot.slotKind === "plain") {
      const sig = plainAskCardSignature(slot.item, vm.scope, canDismissPlain);
      if (card && card.dataset.waitingCardSig === sig) {
        const timeEl = card.querySelector<HTMLTimeElement>(".cs-waiting-card__when");
        if (timeEl && timeEl.textContent !== slot.item.when) timeEl.textContent = slot.item.when;
      } else {
        const built = buildPlainAskCard(doc, slot.item, vm.scope, handlers);
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
    } else {
      const sig = dismissedPlaceholderSignature(slot.item);
      if (!card || card.dataset.waitingCardSig !== sig) {
        const built = buildDismissedPlaceholder(doc, slot.item, handlers);
        if (card) {
          if (cursor === card) cursor = built;
          card.replaceWith(built);
        } else {
          list.insertBefore(built, cursor);
        }
        card = built;
      }
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
  lifetime(): number;
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
  let wasOpen = false;
  let lifetimeCounter = 0;
  let opener: HTMLElement | null = null;

  const isPhone = () => media.matches;
  const isOpen = () => enabled && (isPhone() ? dialog.open : expanded);
  const controlsId = () => (isPhone() ? WAITING_SHEET_ID : WAITING_PANEL_ID);
  const trackLifetime = (): boolean => {
    const nowOpen = isOpen();
    if (nowOpen !== wasOpen) {
      wasOpen = nowOpen;
      lifetimeCounter += 1;
    }
    return nowOpen;
  };

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
      trackLifetime();
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
    const openNow = trackLifetime();
    options.onStateChange?.(openNow);
  };

  const close = (restoreFocus = true) => {
    const prevOpen = isOpen();
    if (dialog.open) dialog.close();
    restorePanel();
    if (!isPhone()) expanded = false;
    if (panel) panel.hidden = true;
    trackLifetime();
    options.onStateChange?.(false);
    if (restoreFocus && prevOpen) focusOpener();
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
      trackLifetime();
      options.onStateChange?.(true);
      panel.querySelector<HTMLElement>("[data-waiting-close]")?.focus({ preventScroll: true });
    } else {
      expanded = true;
      restorePanel();
      panel.hidden = false;
      trackLifetime();
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
    const cancelConfirm = panel?.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-cancel]");
    if (cancelConfirm && !cancelConfirm.hidden) {
      cancelConfirm.click();
      return;
    }
    close(true);
  };

  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === dialog && dialog.open) close(true);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || isPhone() || !isOpen()) return;
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
    lifetime: () => lifetimeCounter,
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
      trackLifetime();
    },
  };
}

export interface WaitingFocusHint {
  kind:
    | "retry-todo"
    | "completed-todo"
    | "retry-plain"
    | "completed-plain"
    | "completed-ask"
    | "dismissed"
    | "restored-dismissed"
    | "batch-confirm"
    | "batch-cancel"
    | "batch-running"
    | "batch-done";
  todoId?: string;
  signalId?: string;
  dismissedKey?: string;
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
  if (hint.kind === "batch-confirm") {
    const confirmBtn = container.querySelector<HTMLElement>("[data-waiting-dismiss-all-confirm]");
    if (confirmBtn) return focusEl(confirmBtn);
  }
  if (hint.kind === "batch-cancel") {
    const dismissAllBtn = container.querySelector<HTMLElement>("[data-waiting-dismiss-all]");
    if (dismissAllBtn && !dismissAllBtn.hidden) return focusEl(dismissAllBtn);
  }
  if (hint.kind === "batch-running") {
    const stopBtn = container.querySelector<HTMLElement>("[data-waiting-dismiss-all-stop]");
    if (stopBtn) return focusEl(stopBtn);
  }
  if (hint.kind === "dismissed" && hint.dismissedKey) {
    const undo = Array.from(container.querySelectorAll<HTMLElement>("[data-waiting-undo]"))
      .find(el => el.dataset.waitingUndo === hint.dismissedKey);
    if (undo) return focusEl(undo);
  }
  if (hint.kind === "restored-dismissed") {
    const targetCard = hint.todoId
      ? Array.from(container.querySelectorAll<HTMLElement>("[data-waiting-todo]")).find(el => el.dataset.waitingTodo === hint.todoId)
      : hint.signalId
        ? Array.from(container.querySelectorAll<HTMLElement>("[data-waiting-card], [data-waiting-plain-ask]"))
            .find(el => el.dataset.waitingCard === hint.signalId || el.dataset.waitingPlainAsk === hint.signalId)
        : undefined;
    if (targetCard) {
      const control =
        targetCard.querySelector<HTMLElement>("[data-waiting-dismiss]")
        ?? Array.from(targetCard.querySelectorAll<HTMLElement>("button")).find(btn => !(btn as HTMLButtonElement).disabled);
      if (control) return focusEl(control);
    }
  }
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
  if (hint.kind === "retry-plain" && hint.signalId) {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-waiting-plain-ask]"));
    const card = cards.find(el => el.dataset.waitingPlainAsk === hint.signalId);
    if (card) {
      const target =
        card.querySelector<HTMLElement>("[data-waiting-plain-retry]")
        ?? card.querySelector<HTMLElement>("[data-waiting-plain-input]")
        ?? card.querySelector<HTMLElement>("[data-waiting-plain-stale]");
      if (target) return focusEl(target);
    }
  }
  const body = container.querySelector<HTMLElement>("[data-waiting-body]");
  const remainingCards = body
    ? Array.from(body.querySelectorAll<HTMLElement>("article")).filter(
        el =>
          el.dataset.waitingCard !== undefined ||
          el.dataset.waitingPlainAsk !== undefined ||
          el.dataset.waitingTodo !== undefined,
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
