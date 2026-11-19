/**
 * Waiting on you survey mode ("Review questions") and historical plain-text ask cards.
 *
 * Pure DOM: every untrusted string (question body, channel/workspace/sender names, option labels,
 * descriptions, and typed answers) enters only through textContent or input.value.
 */
import { CHOICE_MULTI_HINT, CHOICE_OTHER_LABEL, choiceLetter } from "./choice-card";
import {
  EMPTY_CHOICE_DRAFT,
  OTHER_TEXT_MAX,
  cleanOtherText,
  draftSubmission,
  orderedChoiceOptions,
  type ChoiceDraft,
  type ChoiceOption,
  type ChoiceSubmission,
} from "./choices";
import { agentOrb, personAvatar } from "./home-primitives";
import type { AgentVM, PersonVM } from "./home-types";
import type { WaitingAskItem, WaitingScope } from "./waiting-panel";

/** Private reply sent when clearing a stale historical or open question. */
export const STALE_ASK_CLOSE_BODY = "Closed as stale. Re-ask with choices if still needed.";

export interface SurveyDraft {
  choice: ChoiceDraft;
  plainText: string;
  stale: boolean;
  skipped: boolean;
}

export function emptySurveyDraft(choice?: ChoiceDraft): SurveyDraft {
  return {
    choice: choice
      ? { selected: [...choice.selected], otherOpen: choice.otherOpen, otherText: choice.otherText }
      : { selected: [...EMPTY_CHOICE_DRAFT.selected], otherOpen: false, otherText: "" },
    plainText: "",
    stale: false,
    skipped: false,
  };
}

export type SurveyResolution =
  | { kind: "choice"; submission: ChoiceSubmission; summary: string }
  | { kind: "plain"; body: string; summary: string }
  | { kind: "stale"; body: string; summary: string };

export interface SurveyReviewEntry {
  item: WaitingAskItem;
  index: number;
  resolution: SurveyResolution;
  error?: string;
}

export interface WaitingPlainAskHandlers {
  onSubmitPlain: (item: WaitingAskItem, body: string, stale: boolean) => void;
  onRetryPlain: (item: WaitingAskItem) => void;
  onDraftPlain: (item: WaitingAskItem, text: string) => void;
}

export interface WaitingSurveyVM {
  scope: WaitingScope;
  items: WaitingAskItem[];
  step: number;
  drafts: ReadonlyMap<string, SurveyDraft>;
  errors: ReadonlyMap<string, string>;
  sending: boolean;
  draftKey: (item: WaitingAskItem) => string;
}

export interface WaitingSurveyHandlers {
  onExit: () => void;
  onStep: (nextStep: number, focusHeading: boolean) => void;
  onDraftChange: (item: WaitingAskItem, draft: SurveyDraft) => void;
  onSubmitAll: (entries: readonly SurveyReviewEntry[]) => void;
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

export function hasChoices(item: Pick<WaitingAskItem, "choices">): item is WaitingAskItem & {
  choices: NonNullable<WaitingAskItem["choices"]>;
} {
  return !!item.choices && item.choices.options.length > 0;
}

/** Resolves a question's current session draft into what will be sent, or null when skipped/unanswered. */
export function resolveSurveyDraft(
  item: Pick<WaitingAskItem, "choices">,
  draft: SurveyDraft | undefined,
): SurveyResolution | null {
  if (!draft || draft.skipped) return null;
  if (draft.stale) {
    return { kind: "stale", body: STALE_ASK_CLOSE_BODY, summary: "Clear as stale" };
  }
  if (hasChoices(item)) {
    const options = item.choices.options;
    const byId = new Map<string, ChoiceOption>(options.map(option => [option.id, option]));
    if (item.choices.multi) {
      const submission = draftSubmission({ multi: true, options }, draft.choice);
      if (!submission) return null;
      const parts = submission.optionIds
        .map(id => byId.get(id)?.label)
        .filter((label): label is string => Boolean(label));
      if (submission.otherText !== null) parts.push(`Other: ${submission.otherText}`);
      return { kind: "choice", submission, summary: parts.join(", ") };
    }
    if (draft.choice.otherOpen) {
      const otherText = cleanOtherText(draft.choice.otherText);
      if (otherText === null) return null;
      return {
        kind: "choice",
        submission: { optionIds: [], otherText },
        summary: `Other: ${otherText}`,
      };
    }
    const pickedId = draft.choice.selected.find(id => byId.has(id));
    if (!pickedId) return null;
    const picked = byId.get(pickedId)!;
    return {
      kind: "choice",
      submission: { optionIds: [picked.id], otherText: null },
      summary: picked.label,
    };
  }
  const body = cleanOtherText(draft.plainText);
  if (body === null) return null;
  return { kind: "plain", body, summary: body };
}

/** Label for the final review primary button, naming exact answer and stale-clear counts. */
export function surveySendLabel(entries: readonly Pick<SurveyReviewEntry, "resolution">[]): string {
  let answers = 0;
  let stale = 0;
  for (const entry of entries) {
    if (entry.resolution.kind === "stale") stale += 1;
    else answers += 1;
  }
  if (answers === 0 && stale === 0) return "Send answers";
  if (stale === 0) return `Send ${answers} ${answers === 1 ? "answer" : "answers"}`;
  if (answers === 0) return `Clear ${stale} stale`;
  return `Send ${answers} · Clear ${stale} stale`;
}

/** Polite status confirmation after a survey batch completes. */
export function surveyDoneMessage(sentAnswers: number, clearedStale: number): string {
  if (sentAnswers > 0 && clearedStale > 0) {
    return `Sent ${sentAnswers} · Cleared ${clearedStale} stale`;
  }
  if (clearedStale > 0) {
    return `Cleared ${clearedStale} stale ${clearedStale === 1 ? "question" : "questions"}`;
  }
  return sentAnswers === 1 ? "Sent" : `Sent ${sentAnswers} answers`;
}

function destinationText(item: WaitingAskItem, scope: WaitingScope): string {
  if (scope === "all") {
    return item.channelLabel
      ? `${item.from.name} · ${item.workspaceName} · ${item.channelLabel}`
      : `${item.from.name} · ${item.workspaceName}`;
  }
  return item.channelLabel ? `${item.from.name} · ${item.channelLabel}` : item.from.name;
}

function cardLocationText(item: WaitingAskItem, scope: WaitingScope): string | null {
  if (scope === "channel") return null;
  if (scope === "workspace") return item.channelLabel || null;
  return item.channelLabel ? `${item.workspaceName} · ${item.channelLabel}` : item.workspaceName;
}

function buildAskHead(doc: Document, item: WaitingAskItem, scope: WaitingScope): HTMLElement {
  const head = node(doc, "div", "cs-waiting-card__head");
  const avatar = isAgent(item.from) ? agentOrb(doc, item.from, { size: 24, badge: false }) : personAvatar(doc, item.from, 24);
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
  return head;
}

export function plainAskCardSignature(item: WaitingAskItem, scope: WaitingScope): string {
  return JSON.stringify([
    "plain",
    item.id,
    item.workspaceId,
    item.conversation,
    item.channelLabel,
    item.from.name,
    item.what,
    scope,
    item.plain?.pending ?? false,
    item.plain?.pendingMode ?? "",
    item.plain?.error ?? "",
    item.plain?.retryable ?? false,
  ]);
}

/** List-view card for a historical plain-text question (no choices): answer in place or clear as stale. */
export function buildPlainAskCard(
  doc: Document,
  item: WaitingAskItem,
  scope: WaitingScope,
  handlers: WaitingPlainAskHandlers,
): HTMLElement {
  const card = node(doc, "article", "cs-waiting-card cs-waiting-card--plain");
  card.dataset.waitingCard = item.id;
  card.dataset.waitingPlainCard = item.id;
  card.dataset.waitingWorkspace = item.workspaceId;
  card.dataset.waitingCardSig = plainAskCardSignature(item, scope);

  const head = buildAskHead(doc, item, scope);
  const question = node(doc, "p", "cs-waiting-card__question", item.what);

  const pending = item.plain?.pending === true;
  const pendingStale = pending && item.plain?.pendingMode === "stale";
  const form = node(doc, "form", "cs-waiting-plain__form");
  form.noValidate = true;

  const input = node(doc, "input", "cs-waiting-plain__input");
  input.type = "text";
  input.id = `cs-waiting-plain-input-${item.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  input.maxLength = OTHER_TEXT_MAX;
  input.autocomplete = "off";
  input.dataset.waitingPlainInput = item.id;
  input.setAttribute("aria-label", "Answer");
  input.placeholder = "Type your answer…";
  input.value = item.plain?.draftText ?? "";
  if (pending) input.readOnly = true;

  const actions = node(doc, "div", "cs-waiting-plain__actions");
  const clearBtn = node(doc, "button", "cs-waiting-plain__stale", pendingStale ? "Clearing…" : "Clear as stale");
  clearBtn.type = "button";
  clearBtn.id = `cs-waiting-plain-stale-${item.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  clearBtn.dataset.waitingPlainStale = item.id;
  if (pending) clearBtn.setAttribute("aria-disabled", "true");
  clearBtn.addEventListener("click", () => {
    if (pending) return;
    handlers.onSubmitPlain(item, STALE_ASK_CLOSE_BODY, true);
  });

  const sendBtn = node(doc, "button", "cs-waiting-plain__send", pending && !pendingStale ? "Sending…" : "Send");
  sendBtn.type = "submit";
  sendBtn.id = `cs-waiting-plain-send-${item.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  sendBtn.dataset.primary = "true";
  sendBtn.dataset.waitingPlainSend = item.id;
  if (pending) sendBtn.setAttribute("aria-disabled", "true");

  const syncSend = () => {
    sendBtn.disabled = !pending && cleanOtherText(input.value) === null;
  };
  input.addEventListener("input", () => {
    if (pending) return;
    syncSend();
    handlers.onDraftPlain(item, input.value);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending) return;
    const text = cleanOtherText(input.value);
    if (text === null) return;
    handlers.onSubmitPlain(item, text, false);
  });
  syncSend();

  actions.append(clearBtn, sendBtn);
  form.append(input);
  if (item.plain?.error) {
    const err = node(doc, "p", "hm-decision__error", item.plain.error);
    err.setAttribute("role", "alert");
    form.append(err);
  }
  form.append(actions);
  card.append(head, question, form);

  if (item.plain?.error && item.plain?.retryable && !pending) {
    const retryRow = node(doc, "div", "cs-waiting-card__retry-row");
    const retry = node(doc, "button", "cs-waiting-card__retry", "Retry");
    retry.type = "button";
    retry.dataset.waitingCardRetry = item.id;
    retry.addEventListener("click", () => handlers.onRetryPlain(item));
    retryRow.append(retry);
    card.append(retryRow);
  }
  return card;
}

function buildLetterMark(doc: Document, index: number): HTMLElement {
  const badge = node(doc, "span", "hm-decision__letter cs-waiting-survey__letter");
  badge.dataset.letter = choiceLetter(index);
  badge.setAttribute("aria-hidden", "true");
  return badge;
}

/**
 * Renders the Waiting on you survey ("Review questions") inside `body`:
 * - Steps 0..N-1: one question at a time with Back, Skip, Next (and Clear as stale).
 * - Step N: final review pairing each ready answer/stale-clear with its question and destination,
 *   plus a single Send button that sends only non-skipped answered/stale items.
 */
export function renderWaitingSurvey(
  body: HTMLElement,
  vm: WaitingSurveyVM,
  handlers: WaitingSurveyHandlers,
  focusHeading = false,
): void {
  const doc = body.ownerDocument;
  const total = vm.items.length;
  const clampedStep = total === 0 ? 0 : Math.max(0, Math.min(vm.step, total));
  const isReview = total > 0 && clampedStep >= total;

  const wrap = node(doc, "div", "cs-waiting-survey");
  wrap.dataset.waitingSurvey = isReview ? "review" : "step";

  const top = node(doc, "div", "cs-waiting-survey__top");
  const headingText = total === 0
    ? "Review questions"
    : isReview
      ? "Review answers"
      : `Question ${clampedStep + 1} of ${total}`;
  const heading = node(doc, "h3", "cs-waiting-survey__heading", headingText);
  heading.tabIndex = -1;
  heading.dataset.waitingSurveyHeading = "";

  const exitBtn = node(doc, "button", "cs-waiting-survey__exit", "Back to list");
  exitBtn.type = "button";
  exitBtn.dataset.waitingSurveyExit = "";
  if (vm.sending) exitBtn.setAttribute("aria-disabled", "true");
  exitBtn.addEventListener("click", () => {
    if (!vm.sending) handlers.onExit();
  });
  top.append(heading, exitBtn);
  wrap.append(top);

  if (total === 0) {
    wrap.append(node(doc, "p", "cs-waiting-panel__state-text", "No questions left to review."));
    body.replaceChildren(wrap);
    if (focusHeading) heading.focus({ preventScroll: true });
    return;
  }

  // Progress bar across questions (review step fills 100%).
  const progress = node(doc, "div", "cs-waiting-survey__progress");
  progress.setAttribute("aria-hidden", "true");
  const fill = node(doc, "span", "cs-waiting-survey__progress-fill");
  const pct = isReview ? 100 : Math.round(((clampedStep + 1) / total) * 100);
  fill.style.inlineSize = `${pct}%`;
  progress.append(fill);
  wrap.append(progress);

  if (!isReview) {
    const item = vm.items[clampedStep]!;
    const key = vm.draftKey(item);
    const current = vm.drafts.get(key) ?? emptySurveyDraft(item.choices?.draft);
    const draft: SurveyDraft = {
      choice: {
        selected: [...current.choice.selected],
        otherOpen: current.choice.otherOpen,
        otherText: current.choice.otherText,
      },
      plainText: current.plainText,
      stale: current.stale,
      skipped: current.skipped,
    };

    const card = node(doc, "article", "cs-waiting-card cs-waiting-survey__card");
    card.dataset.waitingSurveyCard = item.id;
    card.append(buildAskHead(doc, item, vm.scope));
    card.append(node(doc, "p", "cs-waiting-card__question", item.what));

    const emit = () => {
      handlers.onDraftChange(item, {
        choice: {
          selected: [...draft.choice.selected],
          otherOpen: draft.choice.otherOpen,
          otherText: draft.choice.otherText,
        },
        plainText: draft.plainText,
        stale: draft.stale,
        skipped: draft.skipped,
      });
    };

    const staleBtn = node(doc, "button", "cs-waiting-survey__stale", draft.stale ? "Marked as stale" : "Clear as stale");
    staleBtn.type = "button";
    staleBtn.dataset.waitingSurveyStale = item.id;
    staleBtn.setAttribute("aria-pressed", String(draft.stale));

    const syncStaleVisual = () => {
      staleBtn.textContent = draft.stale ? "Marked as stale" : "Clear as stale";
      staleBtn.setAttribute("aria-pressed", String(draft.stale));
    };

    if (hasChoices(item)) {
      const multi = item.choices.multi;
      const options = orderedChoiceOptions(item.choices.options);
      const group = node(doc, "div", "hm-decision cs-waiting-survey__choices");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", item.what);
      if (multi) group.append(node(doc, "p", "hm-decision__hint", CHOICE_MULTI_HINT));

      const list = node(doc, "div", "hm-decision__options");
      const optionControls: HTMLElement[] = [];

      const otherWrap = node(doc, "div", "hm-decision__other");
      const otherField = node(doc, "div", "hm-decision__other-field");
      const otherInput = node(doc, "input", "hm-decision__input");
      otherInput.type = "text";
      otherInput.maxLength = OTHER_TEXT_MAX;
      otherInput.autocomplete = "off";
      otherInput.dataset.waitingSurveyOtherInput = item.id;
      otherInput.setAttribute("aria-label", CHOICE_OTHER_LABEL);
      otherInput.placeholder = "Type your answer…";
      otherInput.value = draft.choice.otherText;
      otherField.append(otherInput);
      otherField.hidden = !draft.choice.otherOpen;

      let otherTrigger: HTMLButtonElement | HTMLInputElement;
      const syncChoiceVisuals = () => {
        for (const el of optionControls) {
          const optId = el.dataset.waitingSurveyOption;
          const active = !draft.stale && !!optId && draft.choice.selected.includes(optId);
          if (el.tagName === "INPUT") {
            (el as HTMLInputElement).checked = active;
          } else {
            el.setAttribute("aria-pressed", String(active));
            el.dataset.chosen = String(active);
          }
        }
        const otherActive = !draft.stale && draft.choice.otherOpen;
        otherField.hidden = !otherActive;
        if (otherTrigger.tagName === "INPUT") {
          (otherTrigger as HTMLInputElement).checked = otherActive;
        } else {
          otherTrigger.setAttribute("aria-expanded", String(otherActive));
          otherTrigger.setAttribute("aria-pressed", String(otherActive));
        }
        syncStaleVisual();
      };

      for (const [index, option] of options.entries()) {
        const copy = node(doc, "span", "hm-decision__copy");
        const head = node(doc, "span", "hm-decision__head");
        head.append(node(doc, "span", "hm-decision__label", option.label));
        if (option.recommended) head.append(" ", node(doc, "span", "hm-decision__tag", "Recommended"));
        copy.append(head);
        if (option.description) copy.append(" ", node(doc, "span", "hm-decision__description", option.description));

        if (multi) {
          const label = node(doc, "label", "hm-decision__option");
          const box = node(doc, "input", "hm-decision__check");
          box.type = "checkbox";
          box.dataset.waitingSurveyOption = option.id;
          box.checked = !draft.stale && draft.choice.selected.includes(option.id);
          box.addEventListener("change", () => {
            draft.stale = false;
            draft.skipped = false;
            draft.choice.selected = box.checked
              ? [...draft.choice.selected.filter(id => id !== option.id), option.id]
              : draft.choice.selected.filter(id => id !== option.id);
            syncChoiceVisuals();
            emit();
          });
          const check = node(doc, "span", "hm-decision__mark", "✓");
          check.setAttribute("aria-hidden", "true");
          label.append(box, buildLetterMark(doc, index), copy, check);
          optionControls.push(box);
          list.append(label);
        } else {
          const btn = node(doc, "button", "hm-decision__option cs-waiting-survey__option");
          btn.type = "button";
          btn.dataset.waitingSurveyOption = option.id;
          const selected = !draft.stale && !draft.choice.otherOpen && draft.choice.selected.includes(option.id);
          btn.setAttribute("aria-pressed", String(selected));
          btn.dataset.chosen = String(selected);
          const check = node(doc, "span", "hm-decision__mark", "✓");
          check.setAttribute("aria-hidden", "true");
          btn.append(buildLetterMark(doc, index), copy, check);
          btn.addEventListener("click", () => {
            draft.stale = false;
            draft.skipped = false;
            draft.choice.otherOpen = false;
            draft.choice.selected = draft.choice.selected[0] === option.id ? [] : [option.id];
            syncChoiceVisuals();
            emit();
          });
          optionControls.push(btn);
          list.append(btn);
        }
      }

      const otherCopy = node(doc, "span", "hm-decision__copy");
      const otherHead = node(doc, "span", "hm-decision__head");
      otherHead.append(node(doc, "span", "hm-decision__label", CHOICE_OTHER_LABEL));
      otherCopy.append(otherHead);
      const otherCheck = node(doc, "span", "hm-decision__mark", "✓");
      otherCheck.setAttribute("aria-hidden", "true");

      if (multi) {
        const label = node(doc, "label", "hm-decision__option hm-decision__option--other");
        const box = node(doc, "input", "hm-decision__check");
        box.type = "checkbox";
        box.dataset.waitingSurveyOtherTrigger = item.id;
        box.checked = !draft.stale && draft.choice.otherOpen;
        box.addEventListener("change", () => {
          draft.stale = false;
          draft.skipped = false;
          draft.choice.otherOpen = box.checked;
          syncChoiceVisuals();
          emit();
          if (box.checked) otherInput.focus({ preventScroll: true });
        });
        label.append(box, buildLetterMark(doc, options.length), otherCopy, otherCheck);
        otherWrap.append(label, otherField);
        otherTrigger = box;
      } else {
        const btn = node(doc, "button", "hm-decision__option hm-decision__option--other cs-waiting-survey__option");
        btn.type = "button";
        btn.dataset.waitingSurveyOtherTrigger = item.id;
        btn.setAttribute("aria-expanded", String(!draft.stale && draft.choice.otherOpen));
        btn.setAttribute("aria-pressed", String(!draft.stale && draft.choice.otherOpen));
        btn.append(buildLetterMark(doc, options.length), otherCopy, otherCheck);
        btn.addEventListener("click", () => {
          const nextOpen = !(draft.choice.otherOpen && !draft.stale);
          draft.stale = false;
          draft.skipped = false;
          draft.choice.otherOpen = nextOpen;
          if (nextOpen) draft.choice.selected = [];
          syncChoiceVisuals();
          emit();
          if (nextOpen) otherInput.focus({ preventScroll: true });
        });
        otherWrap.append(btn, otherField);
        otherTrigger = btn;
      }

      otherInput.addEventListener("input", () => {
        draft.stale = false;
        draft.skipped = false;
        draft.choice.otherOpen = true;
        draft.choice.otherText = otherInput.value;
        syncChoiceVisuals();
        emit();
      });

      staleBtn.addEventListener("click", () => {
        draft.stale = !draft.stale;
        draft.skipped = false;
        syncChoiceVisuals();
        emit();
      });

      list.append(otherWrap);
      group.append(list);
      card.append(group);
      syncChoiceVisuals();
    } else {
      const input = node(doc, "input", "cs-waiting-plain__input");
      input.type = "text";
      input.maxLength = OTHER_TEXT_MAX;
      input.autocomplete = "off";
      input.dataset.waitingSurveyPlainInput = item.id;
      input.setAttribute("aria-label", "Answer");
      input.placeholder = "Type your answer…";
      input.value = draft.plainText;
      input.addEventListener("input", () => {
        draft.plainText = input.value;
        if (cleanOtherText(input.value) !== null) draft.stale = false;
        draft.skipped = false;
        syncStaleVisual();
        emit();
      });
      staleBtn.addEventListener("click", () => {
        draft.stale = !draft.stale;
        draft.skipped = false;
        syncStaleVisual();
        emit();
      });
      card.append(input);
    }

    const staleRow = node(doc, "div", "cs-waiting-survey__stale-row");
    staleRow.append(staleBtn);
    card.append(staleRow);

    const err = vm.errors.get(item.id);
    if (err) {
      const alert = node(doc, "p", "hm-decision__error", err);
      alert.setAttribute("role", "alert");
      card.append(alert);
    }

    wrap.append(card);

    const nav = node(doc, "div", "cs-waiting-survey__nav");
    const backBtn = node(doc, "button", "cs-waiting-panel__action", "Back");
    backBtn.type = "button";
    backBtn.dataset.waitingSurveyBack = "";
    backBtn.disabled = clampedStep === 0;
    backBtn.addEventListener("click", () => {
      if (clampedStep > 0) handlers.onStep(clampedStep - 1, true);
    });

    const skipBtn = node(doc, "button", "cs-waiting-panel__action", "Skip");
    skipBtn.type = "button";
    skipBtn.dataset.waitingSurveySkip = "";
    skipBtn.addEventListener("click", () => {
      draft.skipped = true;
      emit();
      handlers.onStep(clampedStep + 1, true);
    });

    const isLast = clampedStep === total - 1;
    const nextBtn = node(doc, "button", "cs-waiting-survey__next", isLast ? "Review" : "Next");
    nextBtn.type = "button";
    nextBtn.dataset.primary = "true";
    nextBtn.dataset.waitingSurveyNext = "";
    nextBtn.addEventListener("click", () => {
      if (draft.skipped && resolveSurveyDraft(item, { ...draft, skipped: false }) !== null) {
        draft.skipped = false;
        emit();
      }
      handlers.onStep(clampedStep + 1, true);
    });

    nav.append(backBtn, skipBtn, nextBtn);
    wrap.append(nav);
  } else {
    // Final Review step: pair each ready answer/stale-clear with its question and destination.
    const entries: SurveyReviewEntry[] = [];
    let skippedCount = 0;
    for (let i = 0; i < vm.items.length; i += 1) {
      const item = vm.items[i]!;
      const draft = vm.drafts.get(vm.draftKey(item));
      const resolution = resolveSurveyDraft(item, draft);
      if (resolution) {
        entries.push({
          item,
          index: i,
          resolution,
          error: vm.errors.get(item.id),
        });
      } else {
        skippedCount += 1;
      }
    }

    if (entries.length === 0) {
      wrap.append(
        node(
          doc,
          "p",
          "cs-waiting-panel__state-text",
          "No answers ready to send yet. Go back to answer or mark stale questions.",
        ),
      );
    } else {
      const list = node(doc, "ul", "cs-waiting-survey__review-list");
      list.dataset.waitingSurveyReviewList = "";
      for (const entry of entries) {
        const li = node(doc, "li", "cs-waiting-survey__review-item");
        li.dataset.waitingSurveyReview = entry.item.id;

        const copy = node(doc, "div", "cs-waiting-survey__review-copy");
        copy.append(node(doc, "p", "cs-waiting-survey__review-dest", destinationText(entry.item, vm.scope)));
        copy.append(node(doc, "p", "cs-waiting-survey__review-q", entry.item.what));
        const answerEl = node(
          doc,
          "p",
          entry.resolution.kind === "stale"
            ? "cs-waiting-survey__review-answer cs-waiting-survey__review-answer--stale"
            : "cs-waiting-survey__review-answer",
          entry.resolution.summary,
        );
        copy.append(answerEl);
        if (entry.error) {
          const err = node(doc, "p", "hm-decision__error", entry.error);
          err.setAttribute("role", "alert");
          copy.append(err);
        }

        const editBtn = node(doc, "button", "cs-waiting-survey__edit", "Edit");
        editBtn.type = "button";
        editBtn.dataset.waitingSurveyEdit = entry.item.id;
        editBtn.setAttribute("aria-label", `Edit question ${entry.index + 1}`);
        if (vm.sending) editBtn.setAttribute("aria-disabled", "true");
        editBtn.addEventListener("click", () => {
          if (!vm.sending) handlers.onStep(entry.index, true);
        });

        li.append(copy, editBtn);
        list.append(li);
      }
      wrap.append(list);
    }

    if (skippedCount > 0) {
      wrap.append(
        node(
          doc,
          "p",
          "cs-waiting-survey__skipped",
          `${skippedCount} ${skippedCount === 1 ? "question" : "questions"} skipped · stays open`,
        ),
      );
    }

    const nav = node(doc, "div", "cs-waiting-survey__nav");
    const backBtn = node(doc, "button", "cs-waiting-panel__action", "Back");
    backBtn.type = "button";
    backBtn.dataset.waitingSurveyBack = "";
    if (vm.sending) backBtn.setAttribute("aria-disabled", "true");
    backBtn.addEventListener("click", () => {
      if (!vm.sending) handlers.onStep(total - 1, true);
    });

    const submitBtn = node(
      doc,
      "button",
      "cs-waiting-survey__submit",
      vm.sending ? "Sending…" : surveySendLabel(entries),
    );
    submitBtn.type = "button";
    submitBtn.dataset.primary = "true";
    submitBtn.dataset.waitingSurveySubmit = "";
    submitBtn.disabled = !vm.sending && entries.length === 0;
    if (vm.sending) submitBtn.setAttribute("aria-disabled", "true");
    submitBtn.addEventListener("click", () => {
      if (!vm.sending && entries.length > 0) handlers.onSubmitAll(entries);
    });

    nav.append(backBtn, submitBtn);
    wrap.append(nav);
  }

  body.replaceChildren(wrap);
  if (focusHeading) heading.focus({ preventScroll: true });
}
