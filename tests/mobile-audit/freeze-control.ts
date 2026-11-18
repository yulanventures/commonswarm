/**
 * The frozen-receipt control of a focused mobile-audit run, judged apart from the run so it can be tested.
 *
 * A focused run captures each batch twice: once with normal polling and once with delivery receipts frozen. The frozen
 * pass is a control for the hover witnesses on message rows, so it has something to control only where receipts are
 * read again and again. A batch of other screens (a route, a dialog with no feed) makes no receipt call to intercept;
 * requiring the control there failed every such run.
 *
 * A frozen batch owes the control when either is true:
 *  - it captured a screen declared to measure message rows (the runner derives this from its hover witnesses), or
 *  - the same batch, captured with normal polling, was seen repeating a receipt read (`polled`).
 * The first holds even if the receipt call is renamed and nothing is seen at all; the second covers every other screen
 * that shows a feed.
 */
export interface FreezeCount {
  pass: string; viewport: string; theme: string;
  /** Receipt calls the frozen pass saw, first responses it fetched, and calls it answered from a first response. */
  intercepted: number; fetched: number; replayed: number;
  /** The screens this batch captured. */
  screens: string[];
  /** Repeated receipt reads seen in the same batch with normal polling. */
  polled: number;
}

const owesControl = (count: FreezeCount, measuresFeed: (screenId: string) => boolean): boolean =>
  count.polled > 0 || count.screens.some(measuresFeed);

/** The frozen batches that owed the control and did not exercise it: none intercepted, or none replayed. */
export function idleFreezeBatches(counts: readonly FreezeCount[], measuresFeed: (screenId: string) => boolean): FreezeCount[] {
  return counts.filter(count => owesControl(count, measuresFeed) && (count.intercepted === 0 || count.replayed === 0));
}

/**
 * Null when the control did its job, or had none to do; otherwise what to report.
 * When a selected screen measures message rows, at least one frozen batch must have captured such a screen: a run that
 * selected a feed screen and froze nothing controlled nothing.
 */
export function freezeControlProblem(selected: readonly string[], counts: readonly FreezeCount[], measuresFeed: (screenId: string) => boolean): string | null {
  const idle = idleFreezeBatches(counts, measuresFeed);
  const missing = selected.some(measuresFeed) && !counts.some(count => count.screens.some(measuresFeed));
  if (idle.length === 0 && !missing) return null;
  return `the receipt freeze control was not exercised in ${idle.map(c => `${c.pass} ${c.viewport} ${c.theme}`).join(", ") || "any pass"}; see diagnostic.freeze`;
}
