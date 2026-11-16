/**
 * Interactive agent replies: the fixed choices on an agent's ask, read through
 * swarm_read.ask_choices, and the person's answer. The options are untrusted plain text from the
 * stored ask; they're rendered with textContent only and never as markup or links.
 *
 * The read grew in v2 (multi-select, descriptions, a recommended option, "Other" text, who answered).
 * Every new field is optional here and falls back to what a v1 server means: single choice, no
 * descriptions, the answer's one option_id, no Other text.
 */
export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ChoiceAnswer {
  /** v1's single id; with v2 it is the first selected id, or "other" when only Other text was sent. */
  optionId: string;
  /** The chosen fixed options. Empty when the answer is Other text alone. */
  optionIds: string[];
  otherText: string | null;
  byViewer: boolean;
  /** Who answered, when the server says (v2). */
  actorUserId: string | null;
  /** When the answer was accepted, from the server; null until it has been read back. */
  at: string | null;
}

export interface AskChoiceState {
  signalId: string;
  multi: boolean;
  options: ChoiceOption[];
  answer: ChoiceAnswer | null;
}

/** What a person is preparing on an open ask: kept across repaints until it is sent or answered. */
export interface ChoiceDraft { selected: string[]; otherOpen: boolean; otherText: string }
export const EMPTY_CHOICE_DRAFT: ChoiceDraft = Object.freeze({ selected: [], otherOpen: false, otherText: "" }) as ChoiceDraft;

/** One answer as the person made it: fixed options and/or Other text. */
export interface ChoiceSubmission { optionIds: string[]; otherText: string | null }

/** The read caps one call at 50 asks. */
export const ASK_CHOICES_BATCH = 50;
export const OTHER_TEXT_MAX = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function optionalDescription(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 200 ? value : undefined;
}

function parseAnswer(raw: unknown, options: ChoiceOption[]): ChoiceAnswer | null | undefined {
  if (raw === null || raw === undefined) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a !== "object" || typeof a.option_id !== "string" || typeof a.by_viewer !== "boolean") return undefined;
  const known = new Set(options.map((option) => option.id));
  const otherText = typeof a.other_text === "string" && a.other_text.trim() ? a.other_text : null;
  // v2 sends option_ids, and then it alone names the chosen rows ("other" is a sentinel option_id there).
  let optionIds: string[];
  if (Array.isArray(a.option_ids) && a.option_ids.every((id) => typeof id === "string")) {
    optionIds = [...new Set(a.option_ids as string[])].filter((id) => known.has(id));
  } else {
    optionIds = known.has(a.option_id) ? [a.option_id] : [];
  }
  const at = typeof a.at === "string" && Number.isFinite(Date.parse(a.at)) ? a.at : null;
  const actorUserId = typeof a.actor_user_id === "string" && ANY_UUID_RE.test(a.actor_user_id) ? a.actor_user_id.toLowerCase() : null;
  return { optionId: a.option_id, optionIds, otherText, byViewer: a.by_viewer, actorUserId, at };
}

/** Rows from ask_choices, or null when the reply is unavailable or malformed. A malformed v2-only field falls back to its default. */
export function parseAskChoices(data: unknown): AskChoiceState[] | null {
  if (data === null || typeof data !== "object" || !Array.isArray((data as { asks?: unknown }).asks)) return null;
  const rows: AskChoiceState[] = [];
  for (const raw of (data as { asks: unknown[] }).asks) {
    if (raw === null || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.signal_id !== "string" || !UUID_RE.test(row.signal_id) || !Array.isArray(row.options) ||
        row.options.length < 2 || row.options.length > 6) return null;
    const options: ChoiceOption[] = [];
    let recommendedSeen = false;
    for (const option of row.options) {
      const o = option as Record<string, unknown> | null;
      if (!o || typeof o.id !== "string" || !OPTION_ID_RE.test(o.id) || typeof o.label !== "string" ||
          o.label.length < 1 || o.label.length > 80) return null;
      const parsed: ChoiceOption = { id: o.id, label: o.label };
      const description = optionalDescription(o.description);
      if (description !== undefined) parsed.description = description;
      // At most one is recommended; a second claim is ignored.
      if (o.recommended === true && !recommendedSeen) { parsed.recommended = true; recommendedSeen = true; }
      options.push(parsed);
    }
    const answer = parseAnswer(row.answer, options);
    if (answer === undefined) return null;
    rows.push({ signalId: row.signal_id.toLowerCase(), multi: row.multi === true, options, answer });
  }
  return rows;
}

/** The order rows are shown in: the recommended option first, the rest as the asker listed them. */
export function orderedChoiceOptions(options: readonly ChoiceOption[]): ChoiceOption[] {
  const recommended = options.filter((option) => option.recommended);
  return [...recommended, ...options.filter((option) => !option.recommended)];
}

/** The longest question the card takes as its title. */
export const CHOICE_TITLE_MAX = 240;
// A list, quote, table or heading on any line of a block.
const BLOCK_PREFIX_RE = /^[ \t]*(?:[-*+>|#]|\d+\.)/mu;

/**
 * A choice ask's body as the card shows it, split only when nothing can be lost or mis-titled:
 * - one plain block of at most 240 characters is the question alone (prose null): the card's title, shown once;
 * - two or more blocks whose last is one plain line ending in "?" (at most 240 characters): the blocks before it are
 *   prose, kept in the message above the card, and that line is the card's title;
 * - anything else (a code fence anywhere, a list, quote, table or heading where the question would be, a long or
 *   multi-line last block, or one that isn't a question): the whole body is prose and the card has no title.
 */
export function splitChoicePrompt(body: string): { prose: string | null; question: string | null } {
  // Leading blank lines and trailing space go; the prose keeps its own indentation (an indented code line stays code).
  const text = body.replace(/\r\n?/gu, "\n").replace(/^(?:[ \t]*\n)+/u, "").trimEnd();
  const whole = { prose: text, question: null };
  if (/```|~~~/u.test(text)) return whole;
  const plain = (block: string) => !BLOCK_PREFIX_RE.test(block) && Array.from(block).length <= CHOICE_TITLE_MAX;
  const separators = Array.from(text.matchAll(/\n[ \t]*\n/gu));
  const lastSeparator = separators[separators.length - 1];
  const prose = lastSeparator ? text.slice(0, lastSeparator.index).trimEnd() : "";
  if (!lastSeparator || !prose.trim()) {
    const question = text.trim();
    return plain(question) ? { prose: null, question } : whole;
  }
  // The prose is the body's own text up to the last blank line, never re-joined from trimmed blocks.
  const last = text.slice((lastSeparator.index ?? 0) + lastSeparator[0].length).trim();
  if (!last || !plain(last) || last.includes("\n") || !last.endsWith("?")) return whole;
  return { prose, question: last };
}

/** Trimmed Other text that can be sent, or null. Control characters are refused rather than silently changed. */
export function cleanOtherText(text: string): string | null {
  const trimmed = text.trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || Array.from(trimmed).length > OTHER_TEXT_MAX || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

/** The submission a draft would send, or null when it has nothing to send yet. */
export function draftSubmission(state: Pick<AskChoiceState, "multi" | "options">, draft: ChoiceDraft): ChoiceSubmission | null {
  const known = new Set(state.options.map((option) => option.id));
  const optionIds = state.multi ? draft.selected.filter((id, index, all) => known.has(id) && all.indexOf(id) === index) : [];
  const otherText = draft.otherOpen ? cleanOtherText(draft.otherText) : null;
  if (optionIds.length === 0 && otherText === null) return null;
  return { optionIds, otherText };
}

/**
 * The answer_choice command for one submission. A single fixed option keeps v1's exact shape, which
 * is all today's server accepts (it refuses any extra key). Multi-select and Other text need v2.
 */
export function answerChoiceCommand(signalId: string, multi: boolean, submission: ChoiceSubmission): Record<string, unknown> {
  if (!multi && submission.otherText === null && submission.optionIds.length === 1) {
    return { kind: "answer_choice", signal_id: signalId, option_id: submission.optionIds[0] };
  }
  return {
    kind: "answer_choice", signal_id: signalId,
    ...(submission.optionIds.length ? { option_ids: submission.optionIds } : {}),
    ...(submission.otherText !== null ? { other_text: submission.otherText } : {}),
  };
}

/** True when a command needs the v2 server (multi-select or Other text). */
export function answerNeedsV2(command: Record<string, unknown>): boolean {
  return !Object.hasOwn(command, "option_id");
}

/** The neutral line when a server without v2 refuses a multi-select or Other answer as invalid input. */
export const CHOICE_ANSWER_UNSUPPORTED = "This kind of answer can't be sent here yet. Pick one of the options instead.";
export const CHOICE_ANSWER_FAILED = "That answer couldn't be sent. Try again.";
