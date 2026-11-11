/** Browser-side batching for focused-viewport human receipt attestations. */

export const HUMAN_SEEN_BATCH_MAX = 50;
export const HUMAN_SEEN_FLUSH_MS = 750;

export interface HumanSeenIntersection {
  scope: string;
  signalId: string;
  isIntersecting: boolean;
}

export interface HumanSeenReporterOptions {
  hasFocus(): boolean;
  send(scope: string, signalIds: readonly string[]): Promise<void>;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel?(timer: ReturnType<typeof setTimeout>): void;
  flushMs?: number;
  /** Called whenever the set of rows this reporter still owes a report for changes. */
  changed?(): void;
}

/** Deduplicate ids and keep every command inside the edge's 50-id wire cap. */
export function humanSeenBatches(
  signalIds: readonly string[],
  maximum = HUMAN_SEEN_BATCH_MAX,
): string[][] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) return [];
  const unique = [...new Set(signalIds)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += maximum) {
    batches.push(unique.slice(start, start + maximum));
  }
  return batches;
}

/**
 * Track rows that intersect the transcript viewport. A row becomes reportable
 * only while the document has focus; a later focus event rechecks rows that
 * stayed visible while the tab was in the background.
 */
export class HumanSeenReporter {
  readonly #hasFocus: () => boolean;
  readonly #send: HumanSeenReporterOptions["send"];
  readonly #schedule: NonNullable<HumanSeenReporterOptions["schedule"]>;
  readonly #cancel: NonNullable<HumanSeenReporterOptions["cancel"]>;
  readonly #flushMs: number;
  readonly #visible = new Map<string, HumanSeenIntersection>();
  readonly #pending = new Map<string, HumanSeenIntersection>();
  readonly #reported = new Set<string>();
  readonly #inFlight = new Set<string>();
  readonly #changed: () => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;

  constructor(options: HumanSeenReporterOptions) {
    this.#hasFocus = options.hasFocus;
    this.#send = options.send;
    this.#schedule = options.schedule ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer));
    this.#flushMs = options.flushMs ?? HUMAN_SEEN_FLUSH_MS;
    this.#changed = options.changed ?? (() => {});
  }

  /** True while this row's seen report is queued or being sent (until the server acknowledges it or it is re-queued). */
  owes(scope: string, signalId: string): boolean {
    const key = this.#key({ scope, signalId });
    return this.#pending.has(key) || this.#inFlight.has(key);
  }

  #key(entry: Pick<HumanSeenIntersection, "scope" | "signalId">): string {
    return `${entry.scope}\u0000${entry.signalId}`;
  }

  #queue(entry: HumanSeenIntersection): void {
    if (!this.#hasFocus()) return;
    const key = this.#key(entry);
    if (this.#reported.has(key) || this.#pending.has(key) || this.#inFlight.has(key)) return;
    this.#pending.set(key, entry);
    this.#changed();
    if (this.#timer === null) {
      this.#timer = this.#schedule(() => void this.flush(), this.#flushMs);
    }
  }

  /** Apply one IntersectionObserver delivery. */
  intersections(entries: readonly HumanSeenIntersection[]): void {
    for (const entry of entries) {
      const key = this.#key(entry);
      if (!entry.isIntersecting) {
        this.#visible.delete(key);
        continue;
      }
      this.#visible.set(key, entry);
      this.#queue(entry);
    }
  }

  /** Recheck currently visible rows after the window receives focus. */
  focus(): void {
    if (!this.#hasFocus()) return;
    for (const entry of this.#visible.values()) this.#queue(entry);
  }

  /** Flush already-attested rows whenever document visibility changes. */
  visibilityChange(_visible: boolean): void {
    void this.flush();
  }

  /** Forget stale DOM nodes before a transcript rerender. */
  resetVisible(): void {
    this.#visible.clear();
  }

  /** Send pending attestations grouped by authenticated user/workspace scope. */
  async flush(): Promise<void> {
    // Clear the timer first, even while a send is in flight: a timer that fired during a send would otherwise stay set,
    // and with it set nothing ever schedules the rows queued meanwhile (the send's own reschedule checks for no timer).
    if (this.#timer !== null) {
      this.#cancel(this.#timer);
      this.#timer = null;
    }
    if (this.#flushing !== null) return await this.#flushing;
    if (this.#pending.size === 0) return;

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) this.#inFlight.add(this.#key(entry));
    this.#flushing = (async () => {
      const byScope = new Map<string, string[]>();
      for (const entry of pending) {
        const ids = byScope.get(entry.scope) ?? [];
        ids.push(entry.signalId);
        byScope.set(entry.scope, ids);
      }
      for (const [scope, signalIds] of byScope) {
        for (const batch of humanSeenBatches(signalIds)) {
          try {
            await this.#send(scope, batch);
            for (const signalId of batch) {
              this.#reported.add(this.#key({ scope, signalId }));
            }
          } catch {
            for (const signalId of batch) {
              const entry = { scope, signalId, isIntersecting: true };
              this.#pending.set(this.#key(entry), entry);
            }
          } finally {
            for (const signalId of batch) this.#inFlight.delete(this.#key({ scope, signalId }));
            this.#changed();
          }
        }
      }
    })();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = null;
      if (this.#pending.size > 0 && this.#timer === null) {
        this.#timer = this.#schedule(() => void this.flush(), this.#flushMs);
      }
    }
  }
}
