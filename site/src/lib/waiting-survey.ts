/**
 * Multi-question survey review inside the Waiting on you column/sheet (PR 3).
 *
 * Lets people step through 2+ open choice questions with Back, Next, and Skip while keeping
 * session drafts across steps and panel closes, then review each answer paired with its
 * question and destination before sending only the filled-in answers. Failed answers stay
 * editable on the review step; skipped questions and unfinished to-dos stay open.
 *
 * Pure DOM: every untrusted string enters only through textContent or input.value.
 */
import { OTHER_TEXT_MAX, type ChoiceOption, type ChoiceSubmission } from "./choices";
import { agentOrb, personAvatar } from "./home-primitives";
import type { AgentVM, PersonVM } from "./home-types";
import type { WaitingAskItem, WaitingScope } from "./waiting-panel";

export interface SurveyDraft {
  optionIds: string[];
  otherOpen: boolean;
  otherText: string;
}

export interface WaitingSurveyVM {
  items: WaitingAskItem[];
  scope: WaitingScope;
  mode: "step" | "review";
  index: number;
  drafts: ReadonlyMap<string, SurveyDraft>;
  skipped: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  sending: boolean;
}

export interface WaitingSurveyHandlers {
  onExit: () => void;
  onStep: (index: number) => void;
  onDraftChange: (item: WaitingAskItem, draft: SurveyDraft, quiet?: boolean) => void;
  onSkip: (item: WaitingAskItem) => void;
  onReview: () => void;
  onEdit: (item: WaitingAskItem) => void;
  onSendAll: (entries: Array<{ item: WaitingAskItem; submission: ChoiceSubmission }>) => void;
}

export function surveyDraftKey(workspaceId: string, signalId: string): string {
  return `${workspaceId}:${signalId}`;
}

export function emptySurveyDraft(): SurveyDraft {
  return { optionIds: [], otherOpen: false, otherText: "" };
}

export function surveySubmissionFromDraft(draft: SurveyDraft | undefined): ChoiceSubmission | null {
  if (!draft) return null;
  const trimmed = draft.otherOpen ? draft.otherText.trim().slice(0, OTHER_TEXT_MAX) : "";
  const optionIds = draft.optionIds.filter(Boolean);
  if (optionIds.length === 0 && !trimmed) return null;
  return { optionIds, otherText: trimmed || null };
}

export function surveyReadyEntries(
  items: readonly WaitingAskItem[],
  drafts: ReadonlyMap<string, SurveyDraft>,
): Array<{ item: WaitingAskItem; submission: ChoiceSubmission }> {
  const out: Array<{ item: WaitingAskItem; submission: ChoiceSubmission }> = [];
  for (const item of items) {
    const sub = surveySubmissionFromDraft(drafts.get(surveyDraftKey(item.workspaceId, item.id)));
    if (sub) out.push({ item, submission: sub });
  }
  return out;
}

export function formatSurveyDestination(item: WaitingAskItem, scope: WaitingScope): string {
  if (scope === "all") {
    return item.channelLabel ? `${item.workspaceName} · ${item.channelLabel}` : item.workspaceName;
  }
  return item.channelLabel || item.workspaceName;
}

export function formatSurveyAnswerSummary(
  options: readonly ChoiceOption[],
  submission: ChoiceSubmission,
): string {
  const byId = new Map(options.map(opt => [opt.id, opt.label]));
  const parts: string[] = [];
  for (const id of submission.optionIds) {
    parts.push(byId.get(id) ?? id);
  }
  if (submission.otherText) {
    parts.push(`Other: ${submission.otherText}`);
  }
  return parts.join(" · ");
}

function isAgent(who: PersonVM | AgentVM): who is AgentVM {
  return "state" in who;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function letterFor(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

function containsNode(root: Node, target: Node | null): boolean {
  let cur: Node | null = target;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parentNode;
  }
  return false;
}

type CapturedSurveyFocus =
  | { kind: "option"; id: string }
  | { kind: "other-toggle" }
  | { kind: "other-input"; start: number | null; end: number | null }
  | { kind: "edit"; id: string }
  | { kind: "attr"; selector: string };

function captureSurveyFocus(body: HTMLElement): CapturedSurveyFocus | null {
  const active = body.ownerDocument?.activeElement as HTMLElement | null;
  if (!active || !containsNode(body, active)) return null;
  const ds = active.dataset;
  if (!ds) return null;
  if (typeof ds.surveyOption === "string") return { kind: "option", id: ds.surveyOption };
  if (ds.surveyOtherToggle !== undefined) return { kind: "other-toggle" };
  if (ds.surveyOtherInput !== undefined) {
    const inp = active as HTMLInputElement;
    return {
      kind: "other-input",
      start: typeof inp.selectionStart === "number" ? inp.selectionStart : null,
      end: typeof inp.selectionEnd === "number" ? inp.selectionEnd : null,
    };
  }
  if (typeof ds.waitingSurveyEdit === "string") return { kind: "edit", id: ds.waitingSurveyEdit };
  if (ds.waitingSurveyBack !== undefined) return { kind: "attr", selector: "[data-waiting-survey-back]" };
  if (ds.waitingSurveySkip !== undefined) return { kind: "attr", selector: "[data-waiting-survey-skip]" };
  if (ds.waitingSurveyNext !== undefined) return { kind: "attr", selector: "[data-waiting-survey-next]" };
  if (ds.waitingSurveySend !== undefined) return { kind: "attr", selector: "[data-waiting-survey-send]" };
  if (ds.waitingSurveyExit !== undefined) return { kind: "attr", selector: "[data-waiting-survey-exit]" };
  return null;
}

function restoreSurveyFocus(wrap: HTMLElement, captured: CapturedSurveyFocus | null): void {
  if (!captured) return;
  let target: HTMLElement | null = null;
  if (captured.kind === "option") {
    target = Array.from(wrap.querySelectorAll<HTMLElement>("[data-survey-option]"))
      .find(el => el.dataset.surveyOption === captured.id) ?? null;
  } else if (captured.kind === "other-toggle") {
    target = wrap.querySelector<HTMLElement>("[data-survey-other-toggle]");
  } else if (captured.kind === "other-input") {
    target = wrap.querySelector<HTMLElement>("[data-survey-other-input]");
  } else if (captured.kind === "edit") {
    target = Array.from(wrap.querySelectorAll<HTMLElement>("[data-waiting-survey-edit]"))
      .find(el => el.dataset.waitingSurveyEdit === captured.id) ?? null;
  } else {
    target = wrap.querySelector<HTMLElement>(captured.selector);
  }
  if (!target || (target as HTMLButtonElement).disabled) return;
  target.focus({ preventScroll: true });
  if (captured.kind === "other-input" && captured.start !== null && captured.end !== null) {
    const inp = target as HTMLInputElement;
    if (typeof inp.setSelectionRange === "function") {
      try { inp.setSelectionRange(captured.start, captured.end); } catch { /* ignore */ }
    }
  }
}

function surveySignature(vm: WaitingSurveyVM, typingOtherItemId: string | null): string {
  const safeIndex = Math.max(0, Math.min(vm.index, Math.max(0, vm.items.length - 1)));
  return JSON.stringify([
    vm.mode,
    vm.scope,
    safeIndex,
    vm.sending,
    vm.items.map(item => {
      const d = vm.drafts.get(surveyDraftKey(item.workspaceId, item.id));
      const ignoreText = typingOtherItemId !== null && item.id === typingOtherItemId;
      return [
        item.id,
        item.workspaceId,
        item.workspaceName,
        item.channelLabel,
        item.what,
        ignoreText ? "<typing>" : item.when,
        item.from.name,
        item.choices.multi,
        item.choices.options.map(o => [o.id, o.label, o.description ?? "", o.recommended ?? false]),
        vm.errors.get(item.id) ?? "",
        d?.optionIds ?? [],
        d?.otherOpen ?? false,
        ignoreText ? "<typing>" : (d?.otherText ?? ""),
      ];
    }),
  ]);
}

export function renderWaitingSurvey(
  body: HTMLElement,
  vm: WaitingSurveyVM,
  handlers: WaitingSurveyHandlers,
): void {
  const doc = body.ownerDocument;
  const capturedFocus = captureSurveyFocus(body);
  const safeIdx = Math.max(0, Math.min(vm.index, Math.max(0, vm.items.length - 1)));
  const currentItemId = vm.mode === "step" ? (vm.items[safeIdx]?.id ?? null) : null;
  const fullSig = surveySignature(vm, null);
  const typingSig = surveySignature(vm, currentItemId);
  const hasSurveyDom = Boolean(body.querySelector("[data-waiting-survey]"));
  if (hasSurveyDom) {
    if (capturedFocus?.kind === "other-input" && body.dataset.waitingSurveyTypingSig === typingSig) {
      return;
    }
    if (capturedFocus?.kind !== "other-input" && body.dataset.waitingSurveySig === fullSig) {
      return;
    }
  }

  const commit = (wrap: HTMLElement): void => {
    body.dataset.waitingSurveySig = fullSig;
    body.dataset.waitingSurveyTypingSig = typingSig;
    body.replaceChildren(wrap);
    restoreSurveyFocus(wrap, capturedFocus);
  };

  const wrap = el(doc, "div", "cs-waiting-survey");
  wrap.dataset.waitingSurvey = vm.mode;

  const top = el(doc, "div", "cs-waiting-survey__top");
  const progress = el(
    doc,
    "p",
    "cs-waiting-survey__progress",
    vm.mode === "review"
      ? "Review answers"
      : `Question ${Math.min(vm.index + 1, vm.items.length)} of ${vm.items.length}`,
  );
  progress.setAttribute("aria-live", "polite");
  progress.dataset.waitingSurveyProgress = "";

  const exit = el(doc, "button", "cs-waiting-panel__action", "Back to list");
  exit.type = "button";
  exit.dataset.waitingSurveyExit = "";
  exit.disabled = vm.sending;
  exit.addEventListener("click", () => handlers.onExit());
  top.append(progress, exit);
  wrap.append(top);

  if (vm.mode === "review") {
    const ready = surveyReadyEntries(vm.items, vm.drafts);
    const skippedCount = vm.items.length - ready.length;
    const summaryText =
      skippedCount > 0
        ? `${ready.length} ready to send · ${skippedCount} skipped`
        : `${ready.length} ready to send`;
    wrap.append(el(doc, "p", "cs-waiting-panel__state-text", summaryText));

    const list = el(doc, "div", "cs-waiting-survey__review-list");
    for (const item of vm.items) {
      const key = surveyDraftKey(item.workspaceId, item.id);
      const sub = surveySubmissionFromDraft(vm.drafts.get(key));
      const err = vm.errors.get(item.id);
      const row = el(doc, "article", "cs-waiting-card cs-waiting-survey__review-item");
      row.dataset.waitingSurveyItem = item.id;
      row.append(
        el(doc, "span", "cs-waiting-card__place", formatSurveyDestination(item, vm.scope)),
        el(doc, "p", "cs-waiting-card__question", item.what),
      );
      if (sub) {
        row.append(
          el(doc, "p", "cs-waiting-survey__answer", formatSurveyAnswerSummary(item.choices.options, sub)),
        );
      } else {
        row.append(el(doc, "p", "cs-waiting-panel__state-text", "Skipped"));
      }
      if (err) {
        const alert = el(doc, "p", "cs-waiting-card__error", err);
        alert.setAttribute("role", "alert");
        row.append(alert);
      }
      const actions = el(doc, "div", "cs-waiting-card__actions");
      const edit = el(doc, "button", "cs-waiting-panel__action", sub ? "Edit" : "Answer");
      edit.type = "button";
      edit.dataset.waitingSurveyEdit = item.id;
      if (vm.sending) edit.setAttribute("aria-disabled", "true");
      edit.addEventListener("click", () => {
        if (vm.sending) return;
        handlers.onEdit(item);
      });
      actions.append(edit);
      row.append(actions);
      list.append(row);
    }
    wrap.append(list);

    const footer = el(doc, "div", "cs-waiting-survey__nav");
    const back = el(doc, "button", "cs-waiting-panel__action", "Back");
    back.type = "button";
    back.dataset.waitingSurveyBack = "";
    back.disabled = vm.items.length === 0;
    if (vm.sending) back.setAttribute("aria-disabled", "true");
    back.addEventListener("click", () => {
      if (vm.sending || vm.items.length === 0) return;
      handlers.onStep(Math.max(0, vm.items.length - 1));
    });

    const sendLabel = vm.sending
      ? "Sending…"
      : ready.length === 1
        ? "Send 1 answer"
        : `Send ${ready.length} answers`;
    const send = el(doc, "button", "cs-waiting-card__todo-done", sendLabel);
    send.type = "button";
    send.dataset.waitingSurveySend = "";
    if (vm.sending) {
      send.setAttribute("aria-disabled", "true");
    } else {
      send.disabled = ready.length === 0;
    }
    send.addEventListener("click", () => {
      if (vm.sending || ready.length === 0) return;
      handlers.onSendAll(ready);
    });

    footer.append(back, send);
    wrap.append(footer);
    commit(wrap);
    return;
  }

  const safeIndex = Math.max(0, Math.min(vm.index, vm.items.length - 1));
  const item = vm.items[safeIndex];
  if (!item) {
    commit(wrap);
    return;
  }
  const key = surveyDraftKey(item.workspaceId, item.id);
  const currentDraft = vm.drafts.get(key) ?? emptySurveyDraft();
  const selected = new Set(currentDraft.optionIds);

  const card = el(doc, "article", "cs-waiting-card cs-waiting-survey__card");
  card.dataset.waitingSurveyCard = item.id;

  const head = el(doc, "div", "cs-waiting-card__head");
  const avatar = isAgent(item.from) ? agentOrb(doc, item.from, true) : personAvatar(doc, item.from);
  const meta = el(doc, "div", "cs-waiting-card__meta");
  const line = el(doc, "div", "cs-waiting-card__byline");
  line.append(el(doc, "span", "cs-waiting-card__sender", item.from.name));
  const time = el(doc, "time", "cs-waiting-card__when", item.when);
  if (Number.isFinite(Date.parse(item.createdAt))) time.dateTime = item.createdAt;
  line.append(time);
  meta.append(line, el(doc, "span", "cs-waiting-card__place", formatSurveyDestination(item, vm.scope)));
  head.append(avatar, meta);

  card.append(head, el(doc, "p", "cs-waiting-card__question", item.what));
  if (item.choices.multi) {
    card.append(el(doc, "p", "cs-waiting-panel__state-text", "Choose all that apply"));
  }

  const optionsWrap = el(doc, "div", "cs-waiting-survey__options");
  item.choices.options.forEach((opt, i) => {
    const btn = el(doc, "button", "cs-waiting-survey__option");
    btn.type = "button";
    btn.dataset.surveyOption = opt.id;
    const isPressed = selected.has(opt.id);
    btn.setAttribute("aria-pressed", String(isPressed));
    const badge = el(doc, "span", "cs-waiting-survey__key", letterFor(i));
    badge.setAttribute("aria-hidden", "true");
    const content = el(doc, "span", "cs-waiting-survey__opt-copy");
    const rowTop = el(doc, "span", "cs-waiting-survey__opt-top");
    rowTop.append(el(doc, "span", "cs-waiting-survey__opt-label", opt.label));
    if (opt.recommended) rowTop.append(el(doc, "span", "cs-waiting-survey__rec", "Recommended"));
    content.append(rowTop);
    if (opt.description) content.append(el(doc, "span", "cs-waiting-survey__opt-desc", opt.description));
    btn.append(badge, content);
    btn.addEventListener("click", () => {
      if (item.choices.multi) {
        const nextIds = selected.has(opt.id)
          ? currentDraft.optionIds.filter(id => id !== opt.id)
          : [...currentDraft.optionIds, opt.id];
        handlers.onDraftChange(item, { ...currentDraft, optionIds: nextIds });
      } else {
        const nextIds = selected.has(opt.id) ? [] : [opt.id];
        handlers.onDraftChange(item, { optionIds: nextIds, otherOpen: false, otherText: "" });
      }
    });
    optionsWrap.append(btn);
  });

  // Inline "Something else" option + text box.
  const otherBtn = el(doc, "button", "cs-waiting-survey__option");
  otherBtn.type = "button";
  otherBtn.dataset.surveyOtherToggle = "";
  otherBtn.setAttribute("aria-pressed", String(currentDraft.otherOpen));
  const otherBadge = el(doc, "span", "cs-waiting-survey__key", letterFor(item.choices.options.length));
  otherBadge.setAttribute("aria-hidden", "true");
  otherBtn.append(otherBadge, el(doc, "span", "cs-waiting-survey__opt-label", "Something else"));
  otherBtn.addEventListener("click", () => {
    const nextOpen = !currentDraft.otherOpen;
    handlers.onDraftChange(item, {
      optionIds: item.choices.multi ? currentDraft.optionIds : (nextOpen ? [] : currentDraft.optionIds),
      otherOpen: nextOpen,
      otherText: nextOpen ? currentDraft.otherText : "",
    });
  });
  optionsWrap.append(otherBtn);
  card.append(optionsWrap);

  if (currentDraft.otherOpen) {
    const input = el(doc, "input", "cs-waiting-survey__input");
    input.type = "text";
    input.id = `cs-survey-other-${item.id}`;
    input.maxLength = OTHER_TEXT_MAX;
    input.dataset.surveyOtherInput = "";
    input.placeholder = "Write your answer…";
    input.setAttribute("aria-label", "Something else");
    input.value = currentDraft.otherText;
    input.addEventListener("input", () => {
      handlers.onDraftChange(item, {
        optionIds: item.choices.multi ? currentDraft.optionIds : [],
        otherOpen: true,
        otherText: input.value.slice(0, OTHER_TEXT_MAX),
      }, true);
    });
    card.append(input);
  }

  const err = vm.errors.get(item.id);
  if (err) {
    const alert = el(doc, "p", "cs-waiting-card__error", err);
    alert.setAttribute("role", "alert");
    card.append(alert);
  }

  wrap.append(card);

  const nav = el(doc, "div", "cs-waiting-survey__nav");
  const back = el(doc, "button", "cs-waiting-panel__action", "Back");
  back.type = "button";
  back.dataset.waitingSurveyBack = "";
  back.disabled = safeIndex === 0;
  back.addEventListener("click", () => handlers.onStep(Math.max(0, safeIndex - 1)));

  const skip = el(doc, "button", "cs-waiting-panel__action", "Skip");
  skip.type = "button";
  skip.dataset.waitingSurveySkip = "";
  skip.addEventListener("click", () => handlers.onSkip(item));

  const isLast = safeIndex >= vm.items.length - 1;
  const next = el(doc, "button", "cs-waiting-card__todo-done", isLast ? "Review answers" : "Next");
  next.type = "button";
  next.dataset.waitingSurveyNext = "";
  next.addEventListener("click", () => {
    if (isLast) handlers.onReview();
    else handlers.onStep(safeIndex + 1);
  });

  nav.append(back, skip, next);
  wrap.append(nav);
  commit(wrap);
}

export type WaitingSurveyFocusTarget = "step" | "other-input" | "review" | "failed-review" | "exit";

/** Keeps keyboard focus inside the Waiting on you panel across survey steps, review, failures,
 *  and exits so focus never falls back to document.body (preserving Escape on desktop). */
export function focusWaitingSurvey(
  container: HTMLElement,
  target: WaitingSurveyFocusTarget,
): HTMLElement | null {
  const focusEl = (el: HTMLElement | null | undefined): HTMLElement | null => {
    if (!el) return null;
    el.focus({ preventScroll: true });
    return el;
  };
  if (target === "other-input") {
    const input = container.querySelector<HTMLElement>("[data-survey-other-input]");
    if (input) return focusEl(input);
  }
  if (target === "failed-review") {
    const items = Array.from(container.querySelectorAll<HTMLElement>("[data-waiting-survey-item]"));
    const failed = items.find(row => Boolean(row.querySelector('[role="alert"]')));
    const edit = failed?.querySelector<HTMLElement>("[data-waiting-survey-edit]");
    if (edit) return focusEl(edit);
  }
  if (target === "review" || target === "failed-review") {
    const send = container.querySelector<HTMLButtonElement>("[data-waiting-survey-send]");
    if (send && !send.disabled) return focusEl(send);
    const edit = container.querySelector<HTMLElement>("[data-waiting-survey-edit]");
    if (edit) return focusEl(edit);
    const back = container.querySelector<HTMLButtonElement>("[data-waiting-survey-back]");
    if (back && !back.disabled) return focusEl(back);
  }
  if (target === "step") {
    const opt = container.querySelector<HTMLElement>("[data-survey-option]");
    if (opt) return focusEl(opt);
    const next = container.querySelector<HTMLElement>("[data-waiting-survey-next]");
    if (next) return focusEl(next);
  }
  if (target === "exit") {
    const reviewStart = container.querySelector<HTMLButtonElement>("[data-waiting-review-start]");
    if (reviewStart && !reviewStart.hidden) return focusEl(reviewStart);
    const scope = container.querySelector<HTMLSelectElement>("[data-waiting-scope]");
    if (scope && !scope.disabled) return focusEl(scope);
  }
  return focusEl(
    container.querySelector<HTMLElement>("[data-waiting-survey-exit]")
    ?? container.querySelector<HTMLElement>("[data-waiting-close]"),
  );
}
