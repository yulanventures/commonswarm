/**
 * A choice ask's label or description as the command edge stores it: the signal sanitizer's
 * rules, one line, except that a zero-width joiner inside an emoji sequence is kept (the shared
 * choice rule in src/protocol/choice-asks.ts), so the stored options, the "Selected" reply and the
 * ask_choices read-back show the same emoji the client sent. The general sanitizer is unchanged.
 */
import { choiceOneLine } from "../_shared/protocol.js";
// @ts-ignore TS5097: Deno requires the source extension; Node tests import this module through tsx.
import { sanitizeSignalText } from "../_shared/signal-text.ts";

export function choiceOptionText(value: string): string {
  return choiceOneLine(value, sanitizeSignalText);
}
