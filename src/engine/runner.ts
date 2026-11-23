import { randomUUID } from "node:crypto";
import {
  DEFAULT_QUEUE_CAP,
  acceptMessage,
  availableCapacity,
  compacted,
  confirmMessageSeen,
  confirmReplyPosted,
  decideNext,
  finishTurnWithFailure,
  finishTurnWithReply,
  initialState,
  recover,
  reduce,
  retryOwedReply,
  type Decision,
  type Effect,
  type EngineState,
} from "./core.js";
import { Journal } from "./journal.js";
import type {
  Clock,
  CloudPort,
  HarnessPort,
  IdGenerator,
  IncomingMessage,
  OperatorPort,
  OperatorReportKind,
} from "./ports.js";

const MAX_OPERATOR_ERROR_CHARS = 500;

export type StopReason = "stopped" | "cloud_failed" | "journal_failed" | "harness_port_failed";
export interface RunResult { readonly reason: StopReason; }

export interface RunnerOptions {
  readonly journalPath: string;
  readonly harness: HarnessPort;
  readonly cloud: CloudPort;
  readonly clock: Clock;
  readonly replyRetryHorizonMs: number;
  readonly compactAfterRecords: number;
  readonly settledIdCap: number;
  readonly queueCap?: number;
  readonly generateId?: IdGenerator;
  readonly operator?: OperatorPort;
}

function truncateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > MAX_OPERATOR_ERROR_CHARS ? raw.slice(0, MAX_OPERATOR_ERROR_CHARS) : raw;
}

function findEffect<T extends Effect["type"]>(
  effects: readonly Effect[],
  type: T,
): Extract<Effect, { type: T }> | undefined {
  return effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);
}

export class EngineRunner {
  private readonly options: RunnerOptions;
  private readonly queueCap: number;
  private readonly generateId: IdGenerator;
  private readonly claimAbort = new AbortController();
  private journal: Journal | null = null;
  private state: EngineState;
  private commitChain: Promise<void> = Promise.resolve();
  private recordsSinceCompact = 0;
  private started = false;
  private stopping = false;
  private failed = false;
  private stopReason: StopReason = "stopped";
  private journalClosed = false;
  private workerWake: (() => void) | null = null;
  private claimerWake: (() => void) | null = null;
  private lifecyclePromise: Promise<RunResult> = Promise.resolve({ reason: "stopped" });

  constructor(options: RunnerOptions) {
    if (!Number.isFinite(options.replyRetryHorizonMs) || options.replyRetryHorizonMs < 0) {
      throw new RangeError("Reply retry horizon must be a non-negative finite number");
    }
    if (!Number.isInteger(options.compactAfterRecords) || options.compactAfterRecords < 1) {
      throw new RangeError("Compaction threshold must be a positive integer");
    }
    this.options = options;
    this.queueCap = options.queueCap ?? DEFAULT_QUEUE_CAP;
    this.generateId = options.generateId ?? randomUUID;
    this.state = initialState({ settledIdCap: options.settledIdCap, queueCap: this.queueCap });
  }

  get done(): Promise<RunResult> { return this.lifecyclePromise; }
  get currentState(): EngineState { return this.state; }

  async start(): Promise<void> {
    if (this.started) throw new Error("Engine runner already started");
    this.started = true;

    const journal = await Journal.open(this.options.journalPath);
    this.journal = journal;
    this.recordsSinceCompact = journal.recordCount;

    const recovered = recover(journal.records, this.options.clock.now(), {
      queueCap: this.queueCap,
      replyRetryHorizonMs: this.options.replyRetryHorizonMs,
      settledIdCap: this.options.settledIdCap,
      generateId: this.generateId,
    });

    if (recovered.records.length > 0) {
      try {
        await journal.appendAll(recovered.records);
        this.recordsSinceCompact += recovered.records.length;
      } catch {
        await this.failDuringStart("journal_failed");
        return;
      }
    }
    this.state = recovered.state;

    for (const effect of recovered.effects) {
      if (effect.type === "report_unknown_outcome") {
        await this.reportUnknownOutcome(effect);
      } else if (effect.type === "post_reply") {
        const failReason = await this.executePostReply(effect);
        if (failReason !== null) {
          await this.failDuringStart(failReason);
          return;
        }
      }
    }

    if (!(await this.maybeCompact())) {
      this.lifecyclePromise = Promise.resolve(await this.finishShutdown());
      return;
    }

    this.lifecyclePromise = this.runLoops();
  }

  async stop(): Promise<RunResult> {
    if (!this.started) return { reason: "stopped" };
    this.stopping = true;
    this.claimAbort.abort();
    this.notifyClaimer();
    this.notifyWorker();
    return this.lifecyclePromise;
  }

  private async failDuringStart(reason: Exclude<StopReason, "stopped">): Promise<void> {
    this.failStop(reason);
    this.lifecyclePromise = Promise.resolve(await this.finishShutdown());
  }

  private async runLoops(): Promise<RunResult> {
    await Promise.all([this.workerLoop(), this.claimLoop()]);
    return this.finishShutdown();
  }

  private async finishShutdown(): Promise<RunResult> {
    await this.commitChain;
    this.journalClosed = true;
    if (this.journal !== null) {
      try {
        await this.journal.flush();
        await this.journal.close();
      } catch {
        if (!this.failed) {
          this.failed = true;
          this.stopReason = "journal_failed";
        }
      }
    }
    try {
      await this.options.harness.close?.();
    } catch {
      // Best-effort harness teardown during runner shutdown.
    }
    const result: RunResult = { reason: this.stopReason };
    await this.reportOperator("runner_stopped", { reason: result.reason });
    return result;
  }

  private failStop(reason: Exclude<StopReason, "stopped">): void {
    if (!this.failed) this.stopReason = reason;
    this.failed = true;
    this.stopping = true;
    this.claimAbort.abort();
    this.notifyClaimer();
    this.notifyWorker();
  }

  private async reportOperator(
    kind: OperatorReportKind,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.options.operator?.report(kind, detail);
    } catch {
      // Best-effort reporting; never alters runner state.
    }
  }

  private reportUnknownOutcome(
    effect: Extract<Effect, { type: "report_unknown_outcome" }>,
  ): Promise<void> {
    return this.reportOperator("unknown_reply_outcome", {
      messageId: effect.messageId,
      commandId: effect.commandId,
      owedAt: effect.owedAt,
      at: effect.at,
    });
  }

  private async enqueueCommit<T>(task: () => Promise<T>): Promise<T> {
    const next = this.commitChain.then(task);
    this.commitChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private commit(fn: (state: EngineState) => Decision): Promise<readonly Effect[]> {
    return this.enqueueCommit(async () => {
      if (this.journalClosed || this.journal === null) return [];
      const decision = fn(this.state);
      if (decision.records.length > 0) {
        await this.journal.appendAll(decision.records);
        this.recordsSinceCompact += decision.records.length;
        for (const record of decision.records) this.state = reduce(this.state, record);
      }
      return decision.effects;
    });
  }

  private async maybeCompact(): Promise<boolean> {
    try {
      await this.enqueueCommit(async () => {
        if (this.journalClosed || this.journal === null || this.state.active !== null) return;
        if (this.recordsSinceCompact < this.options.compactAfterRecords) return;
        await this.journal.compact(compacted(this.state));
        this.recordsSinceCompact = 0;
      });
      return true;
    } catch {
      this.failStop("journal_failed");
      return false;
    }
  }

  private async executePostReply(
    initialEffect: Extract<Effect, { type: "post_reply" }>,
  ): Promise<Exclude<StopReason, "stopped"> | null> {
    let effect = initialEffect;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.options.cloud.postReply(effect.messageId, effect.commandId, effect.text, effect.status);
      } catch {
        if (this.stopping || attempt === 1) return "cloud_failed";
        let retryEffects: readonly Effect[];
        try {
          retryEffects = await this.commit((s) =>
            retryOwedReply(s, effect.messageId, this.options.clock.now(), this.options.replyRetryHorizonMs),
          );
        } catch {
          return "journal_failed";
        }
        const abandoned = findEffect(retryEffects, "report_unknown_outcome");
        if (abandoned) {
          await this.reportUnknownOutcome(abandoned);
          return null;
        }
        const retry = findEffect(retryEffects, "post_reply");
        if (!retry) return null;
        effect = retry;
        continue;
      }

      try {
        await this.commit((s) => confirmReplyPosted(s, effect.messageId, this.options.clock.now()));
      } catch {
        return "journal_failed";
      }
      return null;
    }
    return "cloud_failed";
  }

  private async runPostReplyEffects(effects: readonly Effect[]): Promise<boolean> {
    for (const effect of effects) {
      if (effect.type !== "post_reply") continue;
      const failReason = await this.executePostReply(effect);
      if (failReason !== null) {
        this.failStop(failReason);
        return false;
      }
    }
    return true;
  }

  private async claimLoop(): Promise<void> {
    while (!this.stopping && !this.failed) {
      const capacity = availableCapacity(this.state);
      if (capacity <= 0) {
        await this.waitForClaimSlot();
        continue;
      }

      let batch: readonly IncomingMessage[];
      try {
        batch = await this.options.cloud.claim(capacity, this.claimAbort.signal);
      } catch {
        if (!this.stopping) this.failStop("cloud_failed");
        return;
      }

      if (this.stopping || this.failed || batch.length === 0) continue;

      let acceptedAny = false;
      for (const message of batch) {
        if (this.stopping || this.failed) return;
        let effects: readonly Effect[];
        try {
          effects = await this.commit((s) => {
            const decision = acceptMessage(s, message, this.options.clock.now(), this.generateId);
            if (decision.records.some((r) => r.type === "message_accepted")) acceptedAny = true;
            return decision;
          });
        } catch {
          this.failStop("journal_failed");
          return;
        }

        if (effects.length > 0) {
          if (!(await this.runPostReplyEffects(effects))) return;
          if (!(await this.maybeCompact())) return;
        }
      }

      if (acceptedAny) this.notifyWorker();
    }
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopping && !this.failed) {
      if (this.state.queue.length === 0) {
        await this.waitForWork();
        continue;
      }

      let effects: readonly Effect[];
      try {
        effects = await this.commit((s) => decideNext(s, this.options.clock.now()));
      } catch {
        this.failStop("journal_failed");
        return;
      }

      const startEffect = findEffect(effects, "start_turn");
      if (!startEffect) continue;

      const seenEffect = findEffect(effects, "mark_seen");
      if (seenEffect) {
        try {
          await this.options.cloud.markSeen(seenEffect.messageId);
        } catch {
          this.failStop("cloud_failed");
          return;
        }
        try {
          await this.commit((s) => confirmMessageSeen(s, seenEffect.messageId, this.options.clock.now()));
        } catch {
          this.failStop("journal_failed");
          return;
        }
      }

      let replyText: string | null = null;
      let harnessError: string | null = null;
      try {
        const result = await this.options.harness.runTurn(startEffect.text);
        if (typeof result !== "string") {
          this.failStop("harness_port_failed");
          return;
        }
        replyText = result;
      } catch (err) {
        harnessError = truncateError(err);
      }

      let replyEffects: readonly Effect[];
      try {
        replyEffects = await this.commit((s) =>
          replyText !== null
            ? finishTurnWithReply(s, startEffect.messageId, replyText, this.options.clock.now(), this.generateId)
            : finishTurnWithFailure(s, startEffect.messageId, this.options.clock.now(), this.generateId),
        );
      } catch {
        this.failStop("journal_failed");
        return;
      }

      if (harnessError !== null) {
        await this.reportOperator("turn_failed", { messageId: startEffect.messageId, error: harnessError });
      }
      if (this.failed) return;
      if (!(await this.runPostReplyEffects(replyEffects))) return;
      if (!(await this.maybeCompact())) return;
      this.notifyClaimer();
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise<void>((resolve) => { this.workerWake = resolve; });
  }
  private notifyWorker(): void {
    const wake = this.workerWake;
    this.workerWake = null;
    wake?.();
  }
  private waitForClaimSlot(): Promise<void> {
    return new Promise<void>((resolve) => { this.claimerWake = resolve; });
  }
  private notifyClaimer(): void {
    const wake = this.claimerWake;
    this.claimerWake = null;
    wake?.();
  }
}
