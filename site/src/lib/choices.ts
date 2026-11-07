/**
 * Interactive agent replies: the fixed choices on an agent's ask, read through
 * swarm_read.ask_choices, and the person's answer. The options are untrusted plain text from the
 * stored ask; they're rendered with textContent only and never as markup or links.
 */
export interface ChoiceOption {
  id: string;
  label: string;
}

export interface AskChoiceState {
  signalId: string;
  options: ChoiceOption[];
  answer: { optionId: string; byViewer: boolean } | null;
}

/** The read caps one call at 50 asks. */
export const ASK_CHOICES_BATCH = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Rows from ask_choices, or null when the reply is unavailable or malformed. */
export function parseAskChoices(data: unknown): AskChoiceState[] | null {
  if (data === null || typeof data !== "object" || !Array.isArray((data as { asks?: unknown }).asks)) return null;
  const rows: AskChoiceState[] = [];
  for (const raw of (data as { asks: unknown[] }).asks) {
    if (raw === null || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.signal_id !== "string" || !UUID_RE.test(row.signal_id) || !Array.isArray(row.options) ||
        row.options.length < 2 || row.options.length > 6) return null;
    const options: ChoiceOption[] = [];
    for (const option of row.options) {
      const o = option as Record<string, unknown> | null;
      if (!o || typeof o.id !== "string" || !OPTION_ID_RE.test(o.id) || typeof o.label !== "string" ||
          o.label.length < 1 || o.label.length > 80) return null;
      options.push({ id: o.id, label: o.label });
    }
    let answer: AskChoiceState["answer"] = null;
    if (row.answer !== null && row.answer !== undefined) {
      const a = row.answer as Record<string, unknown>;
      if (typeof a.option_id !== "string" || typeof a.by_viewer !== "boolean") return null;
      answer = { optionId: a.option_id, byViewer: a.by_viewer };
    }
    rows.push({ signalId: row.signal_id.toLowerCase(), options, answer });
  }
  return rows;
}

/** The answered line: "You chose: Ship it", or "Answered: Ship it" for someone else's answer. */
export function choiceAnswerText(state: AskChoiceState): string | null {
  if (state.answer === null) return null;
  const option = state.options.find((candidate) => candidate.id === state.answer!.optionId);
  if (!option) return null;
  return `${state.answer.byViewer ? "You chose" : "Answered"}: ${option.label}`;
}
