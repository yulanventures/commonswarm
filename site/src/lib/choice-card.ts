// The decision card on an agent's choice ask: one box in the message, open, pending, answered or expired.
// Pure DOM. Labels, descriptions and Something else text are untrusted and enter only through textContent.
// Every row has a letter (A, B, C…) in display order; Something else is always the last row, with the next letter.
import { EMPTY_CHOICE_DRAFT, OTHER_TEXT_MAX, cleanOtherText, draftSubmission, orderedChoiceOptions,
  type AskChoiceState, type ChoiceDraft, type ChoiceOption, type ChoiceSubmission } from "./choices";

export type ChoiceCardStatus = "open" | "pending" | "answered" | "replied" | "expired" | "readonly";

export interface ChoiceCardVM {
  state: AskChoiceState;
  /** The viewer may answer: a person, the ask's addressee (or anyone reading a channel ask), not its asker. */
  interactive: boolean;
  /** Past the ask's `until`. */
  ended: boolean;
  /** Someone answered in words; there is no stored choice, and the server takes none now. */
  repliedInWords?: boolean;
  pending?: boolean;
  error?: string | null;
  draft?: ChoiceDraft;
  /** Who chose, from the server's answer: "you" or a name. Null when it isn't known. */
  chooser?: string | null;
  /** The answer's time, formatted, with its ISO value for <time datetime>. */
  answeredAt?: { text: string; iso: string } | null;
  /** Distinguishes two copies of one ask on a page (element ids). */
  scope?: string;
}

export interface ChoiceCardHandlers {
  submit: (submission: ChoiceSubmission) => void;
  /** Every draft change, so a repaint can rebuild the card as the person left it. */
  draft?: (draft: ChoiceDraft) => void;
}

/** The free-text row's label: the last row of every card, open or completed. */
export const CHOICE_OTHER_LABEL = "Something else";
/** The muted line under a multi-select card's question. Single choice has none: a tap answers. */
export const CHOICE_MULTI_HINT = "Choose all that apply";
/** The letter of the row at this display position: A for the first. */
export const choiceLetter = (index: number): string => String.fromCharCode(65 + index);

export function choiceCardStatus(vm: Pick<ChoiceCardVM, "state" | "interactive" | "ended" | "repliedInWords" | "pending">): ChoiceCardStatus {
  // Any known answer outlives the ask's `until`: Expired is only for one nobody answered.
  if (vm.state.answer !== null) return "answered";
  if (vm.repliedInWords) return "replied";
  if (vm.ended) return "expired";
  if (!vm.interactive) return "readonly";
  return vm.pending ? "pending" : "open";
}

/** The card's last line: who chose and when, or that it expired unanswered. Null when it has none. */
export function choiceCardFooter(vm: Pick<ChoiceCardVM, "state" | "interactive" | "ended" | "repliedInWords" | "pending" | "chooser">): string | null {
  const status = choiceCardStatus(vm);
  if (status === "answered") return vm.chooser ? `Chosen by ${vm.chooser}` : "Chosen";
  if (status === "expired") return "Expired · Not answered";
  if (status === "replied") return "Answered";
  return null;
}

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, "-");

function letterBadge(doc: Document, index: number): HTMLElement {
  const badge = node(doc, "span", "hm-decision__letter", choiceLetter(index)); badge.setAttribute("aria-hidden", "true");
  return badge;
}
/** The check on a ticked or chosen row, beside its filled letter, so selection never rests on colour alone. */
function checkMark(doc: Document): HTMLElement {
  const mark = node(doc, "span", "hm-decision__mark", "✓"); mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** The option's words: label, a quiet Recommended tag, and its description as a second line. */
function optionCopy(doc: Document, option: Pick<ChoiceOption, "label" | "description" | "recommended">): HTMLElement {
  const copy = node(doc, "span", "hm-decision__copy");
  const head = node(doc, "span", "hm-decision__head");
  head.append(node(doc, "span", "hm-decision__label", option.label));
  if (option.recommended) head.append(node(doc, "span", "hm-decision__tag", "Recommended"));
  copy.append(head);
  if (option.description) copy.append(node(doc, "span", "hm-decision__description", option.description));
  return copy;
}

function footer(doc: Document, text: string, at: ChoiceCardVM["answeredAt"]): HTMLElement {
  const foot = node(doc, "p", "hm-decision__foot", text);
  if (at && at.text) {
    const time = doc.createElement("time"); time.textContent = at.text;
    if (Number.isFinite(Date.parse(at.iso))) time.dateTime = at.iso;
    foot.append(" · ", time);
  }
  return foot;
}

/** Every offered row, read-only, Something else last: chosen rows carry a check and the word "chosen" for screen readers. */
function staticCard(doc: Document, vm: ChoiceCardVM, status: ChoiceCardStatus): HTMLElement {
  const root = node(doc, "div", "hm-decision");
  root.dataset.decision = vm.state.signalId; root.dataset.decisionState = status;
  root.dataset.decisionMode = vm.state.multi ? "multi" : "single";
  root.setAttribute("role", "group"); root.setAttribute("aria-label", "Choices");
  const list = node(doc, "ul", "hm-decision__options");
  const answer = vm.state.answer;
  const chosen = new Set(answer?.optionIds ?? []);
  const options = orderedChoiceOptions(vm.state.options);
  const row = (option: Pick<ChoiceOption, "label" | "description" | "recommended">, id: string | null, picked: boolean, index: number) => {
    const item = node(doc, "li", id === null ? "hm-decision__option hm-decision__option--other" : "hm-decision__option");
    if (id !== null) item.dataset.decisionOption = id; else item.dataset.decisionOther = "";
    item.dataset.chosen = String(picked);
    item.append(letterBadge(doc, index), optionCopy(doc, option));
    if (picked) item.append(checkMark(doc), node(doc, "span", "hm-sr-only", ", chosen"));
    list.append(item);
  };
  for (const [index, option] of options.entries()) row(option, option.id, chosen.has(option.id), index);
  // Something else stays the last row: chosen, with the typed text under it, or quiet when it wasn't used.
  const otherText = answer?.otherText ?? null;
  row({ label: CHOICE_OTHER_LABEL, ...(otherText ? { description: otherText } : {}) }, null, otherText !== null, options.length);
  root.append(list);
  const text = choiceCardFooter(vm);
  if (text) root.append(footer(doc, text, status === "answered" ? vm.answeredAt ?? null : null));
  return root;
}

/** Open card: rows that answer (single) or build a draft (multi), Something else last, one pending answer at a time. */
function openCard(doc: Document, vm: ChoiceCardVM, status: ChoiceCardStatus, handlers: ChoiceCardHandlers): HTMLElement {
  const multi = vm.state.multi;
  const pending = status === "pending";
  const draft: ChoiceDraft = { ...(vm.draft ?? EMPTY_CHOICE_DRAFT) };
  draft.selected = [...draft.selected];
  const base = `hm-decision-${safeId(vm.scope ?? "feed")}-${safeId(vm.state.signalId)}`;
  // The card holds the question (the caller puts it first); the form holds only the rows and Done, so no control
  // in the question can submit an answer.
  const root = node(doc, "div", "hm-decision");
  root.dataset.decision = vm.state.signalId; root.dataset.decisionState = status;
  root.dataset.decisionMode = multi ? "multi" : "single";
  root.setAttribute("role", "group"); root.setAttribute("aria-label", "Choices");
  if (pending) root.setAttribute("aria-busy", "true");
  if (multi) root.append(node(doc, "p", "hm-decision__hint", CHOICE_MULTI_HINT));
  const form = node(doc, "form", "hm-decision__form"); form.noValidate = true;
  const emit = () => handlers.draft?.({ ...draft, selected: [...draft.selected] });
  const block = (control: HTMLElement) => { if (pending) control.setAttribute("aria-disabled", "true"); };
  /* A native checkbox toggles on Space; Enter would submit the form instead, sending an answer that can't be
     taken back. Here Enter toggles it too. */
  const checkbox = (box: HTMLInputElement, toggled: () => void) => {
    box.addEventListener("click", (event) => { if (pending) event.preventDefault(); });
    box.addEventListener("change", toggled);
    box.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (pending) return;
      box.checked = !box.checked; toggled();
    });
  };
  /* A multi-select row: the native checkbox stays first in its label (focusable, laid over the letter); the letter
     fills and the check shows while it is ticked. */
  const checkRow = (box: HTMLInputElement, index: number, copy: HTMLElement, className = "hm-decision__option") => {
    const label = node(doc, "label", className);
    label.append(box, letterBadge(doc, index), copy, checkMark(doc));
    return label;
  };

  const options = orderedChoiceOptions(vm.state.options);
  const list = node(doc, "div", "hm-decision__options");
  for (const [index, option] of options.entries()) {
    if (multi) {
      const box = node(doc, "input", "hm-decision__check"); box.type = "checkbox";
      box.dataset.decisionOption = option.id; box.checked = draft.selected.includes(option.id); block(box);
      checkbox(box, () => {
        draft.selected = box.checked ? [...draft.selected.filter((id) => id !== option.id), option.id] : draft.selected.filter((id) => id !== option.id);
        sync(); emit();
      });
      list.append(checkRow(box, index, optionCopy(doc, option)));
    } else {
      const button = node(doc, "button", "hm-decision__option"); button.type = "button";
      // An id per row, so Waiting on you's rebuild returns focus to the same row.
      button.id = `${base}-option-${safeId(option.id)}`;
      button.dataset.decisionOption = option.id; block(button);
      button.append(letterBadge(doc, index), optionCopy(doc, option));
      button.addEventListener("click", () => { if (!pending) handlers.submit({ optionIds: [option.id], otherText: null }); });
      list.append(button);
    }
  }

  // Something else: a trigger row and, under it, the field it opens. Never an input inside a button or checkbox.
  const other = node(doc, "div", "hm-decision__other"); other.dataset.decisionOther = "";
  const fieldId = `${base}-other`;
  const field = node(doc, "div", "hm-decision__other-field"); field.id = fieldId;
  const input = node(doc, "input", "hm-decision__input"); input.type = "text"; input.maxLength = OTHER_TEXT_MAX;
  input.autocomplete = "off"; input.dataset.decisionOtherInput = ""; input.setAttribute("aria-label", CHOICE_OTHER_LABEL);
  input.placeholder = "Type your answer…";
  input.value = draft.otherText; if (pending) input.readOnly = true;
  field.append(input);
  let trigger: HTMLButtonElement | HTMLInputElement;
  if (multi) {
    const box = node(doc, "input", "hm-decision__check"); box.type = "checkbox"; box.dataset.decisionOtherTrigger = "";
    box.checked = draft.otherOpen; box.setAttribute("aria-controls", fieldId); block(box);
    checkbox(box, () => { setOpen(box.checked, true); });
    other.append(checkRow(box, options.length, optionCopy(doc, { label: CHOICE_OTHER_LABEL }), "hm-decision__option hm-decision__option--other"));
    trigger = box;
  } else {
    const button = node(doc, "button", "hm-decision__option hm-decision__option--other"); button.type = "button"; button.id = `${base}-other-row`;
    button.dataset.decisionOtherTrigger = ""; button.setAttribute("aria-controls", fieldId); block(button);
    // Open, it reads as picked: filled letter and a check (shown by its aria-expanded), like a ticked row.
    button.append(letterBadge(doc, options.length), optionCopy(doc, { label: CHOICE_OTHER_LABEL }), checkMark(doc));
    button.addEventListener("click", () => { if (!pending) setOpen(!draft.otherOpen, true); });
    other.append(button); trigger = button;
  }
  other.append(field); list.append(other); form.append(list);
  if (vm.error) { const error = node(doc, "p", "hm-decision__error", vm.error); error.setAttribute("role", "alert"); form.append(error); }
  /* One Done, last and at the right, only where an answer needs it: always on multi-select, and on single choice while
     Something else is open (a lettered row answers on its own tap). */
  const submit = node(doc, "button", "hm-button hm-decision__submit", pending ? "Sending…" : "Done"); submit.type = "submit";
  submit.dataset.primary = "true"; submit.dataset.decisionSubmit = ""; block(submit);
  form.append(submit);
  // An answer on its way is shown once (on Done when Done shows, else on this line) and always announced.
  const sending = pending ? node(doc, "p", "hm-decision__foot", "Sending…") : null;
  if (sending) { sending.setAttribute("role", "status"); form.append(sending); }
  root.append(form);

  function ready(): boolean {
    return multi ? draftSubmission(vm.state, draft) !== null : draft.otherOpen && cleanOtherText(draft.otherText) !== null;
  }
  function sync(): void {
    field.hidden = !draft.otherOpen;
    if (!multi) trigger.setAttribute("aria-expanded", String(draft.otherOpen));
    submit.hidden = !multi && !draft.otherOpen;
    if (sending) sending.className = submit.hidden ? "hm-decision__foot" : "hm-sr-only";
    // Done stays focusable while an answer is on its way; it is disabled only when there is nothing to send.
    submit.disabled = !pending && !ready();
  }
  function setOpen(open: boolean, focus: boolean): void {
    draft.otherOpen = open; sync(); emit();
    if (focus) (open ? input : trigger).focus({ preventScroll: true });
  }
  input.addEventListener("input", () => { if (pending) return; draft.otherText = input.value; sync(); emit(); });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || input.value.trim() !== "" || pending) return;
    event.preventDefault(); event.stopPropagation();
    if (multi) (trigger as HTMLInputElement).checked = false;
    setOpen(false, true);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending) return;
    const submission = multi ? draftSubmission(vm.state, draft) : (() => {
      const text = draft.otherOpen ? cleanOtherText(draft.otherText) : null;
      return text === null ? null : { optionIds: [], otherText: text };
    })();
    if (submission) handlers.submit(submission);
  });
  sync();
  return root;
}

/** The decision card for one choice ask, in whichever state it is in. */
export function buildChoiceCard(doc: Document, vm: ChoiceCardVM, handlers: ChoiceCardHandlers): HTMLElement {
  const status = choiceCardStatus(vm);
  return status === "open" || status === "pending" ? openCard(doc, vm, status, handlers) : staticCard(doc, vm, status);
}

/**
 * Puts the question at the top of a card as its bold title, and names the card's group by it. The title is the
 * caller's own node (the feed's sanitized Markdown), outside the form, so nothing in it can send an answer.
 */
export function setChoiceCardTitle(card: HTMLElement, title: HTMLElement, scope = "feed"): void {
  title.className = `${title.className} hm-decision__title`.trim();
  title.id = `hm-decision-${safeId(scope)}-${safeId(card.dataset.decision ?? "")}-title`;
  card.prepend(title);
  card.removeAttribute("aria-label"); card.setAttribute("aria-labelledby", title.id);
}
