/**
 * WHICH MESSAGES LEAVE THE FEED WHEN THEIR `until` PASSES, AND WHICH STAY AS HISTORY.
 *
 * Every row still carries `until`, and it still decides who is woken and what an agent's inbox
 * holds. What it no longer decides is whether a person can read yesterday's conversation. A row
 * past its `until` is hidden only when it was never conversation in the first place:
 *
 *   1. a `working-on` status, which says what an agent is doing NOW;
 *   2. an agent's message to itself (`from_kind = 'agent'` and `to_agent = from`). Wake tests and
 *      attendance canaries are all of that shape, so no body has to be matched.
 *
 * Every other note and ask stays, addressed or not, in a channel, a thread or a DM.
 *
 * The browser applies this twice and both use this module, so they cannot drift: the paging
 * query asks the server for the rows (`signalHistoryFilter`), and the renderer drops what the
 * query cannot express (`signalIsReadable`). PostgREST cannot compare two columns, so rule 2 is
 * the part left to the renderer.
 */

/** Kinds that are conversation. A row of any other kind ends with its `until`. */
export const SIGNAL_HISTORY_KINDS = ["note", "ask"] as const;

/** The fields of a loaded row the rule reads. */
export interface HistorySignal {
  from: string;
  fromKind: string;
  toAgent: string | null;
  kind: string;
  until: string | null;
}

/** True when this row is a status or a machine's note to itself, and so ends with its `until`. */
export const signalEndsWithUntil = (signal: HistorySignal): boolean =>
  !(SIGNAL_HISTORY_KINDS as readonly string[]).includes(signal.kind) ||
  (signal.fromKind === "agent" && signal.toAgent !== null && signal.toAgent === signal.from);

/**
 * When this row will leave the feed, in epoch milliseconds, or `null` when it never will.
 * An `until` that does not parse is `NaN`: `signalIsReadable` hides such a row, as the feed
 * always has, and a caller scheduling a repaint must ignore it.
 */
export const signalLeavesAt = (signal: HistorySignal): number | null =>
  signal.until === null || !signalEndsWithUntil(signal) ? null : new Date(signal.until).getTime();

/** Whether the feed shows this row at `now`. */
export const signalIsReadable = (signal: HistorySignal, now: number): boolean => {
  const leavesAt = signalLeavesAt(signal);
  return leavesAt === null || leavesAt > now;
};

/**
 * The PostgREST `or=` filter for one page: rows with no `until`, rows still inside it, and
 * conversation of any age. It is deliberately wider than `signalIsReadable` by exactly rule 2.
 */
export const signalHistoryFilter = (cutoff: string): string =>
  `until.is.null,until.gt.${cutoff},kind.in.(${SIGNAL_HISTORY_KINDS.join(",")})`;

/**
 * Whether a message's `until` has passed. A row kept as history can still be past it: an ask
 * that ended unanswered is shown, and offers nothing to press. An `until` that does not parse
 * is not treated as passed.
 */
export const signalHasEnded = (signal: Pick<HistorySignal, "until">, now: number): boolean => {
  if (signal.until === null) return false;
  const until = new Date(signal.until).getTime();
  return Number.isFinite(until) && until <= now;
};
