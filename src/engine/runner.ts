import { randomUUID } from "node:crypto";
import {
  acceptMessage,
  canClaim,
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
import {
  AuthorityLostError,
  type Clock,
  type CloudPort,
  type HarnessPort,
  type IdGenerator,
  type IncomingMessage,
  type OperatorPort,
  type OperatorReportKind,
} from "./ports.js";

const MAX_OPERATOR_ERROR_CHARS = 500;

export type StopReason = "stopped" | "authority_lost" | "cloud_failed" | "journal_failed" | "harness_port_failed";
export interface RunResult { readonly reason: StopReason; }

export interface RunnerOptions {
  readonly journalPath: string;
  readonly harness: HarnessPort;
  readonly cloud: CloudPort;
  readonly clock: Clock;
  readonly replyRetryHorizonMs: number;
  readonly compactAfterRecords: number;
  readonly settledIdCap: number;
  readonly generateId?: IdGenerator;
  readonly operator?: OperatorPort;
}

type RaceOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "err"; readonly err: unknown }
  | { readonly kind: "authority_lost" };

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
  private readonly generateId: IdGenerator;
  private readonly claimAbort = new AbortController();
  private readonly authorityLostPromise: Promise<void>;
  private resolveAuthorityLost: (() => void) | null = null;
  private journal: Journal | null = null;
  private state: EngineState;
  private recordsSinceCompact = 0;
  private started = false;
  private stopping = false;
  private failed = false;
  private authorityLost = false;
  private shutdownComplete = false;
  private stopReason: StopReason = "stopped";
  private interruptedHarness = false;
  private interruptPromise: Promise<void> | null = null;
  private lifecyclePromise: Promise<RunResult> = Promise.resolve({ reason: "stopped" });

  constructor(options: RunnerOptions) {
    if (!Number.isFinite(options.replyRetryHorizonMs) || options.replyRetryHorizonMs < 0) {
      throw new RangeError("Reply retry horizon must be a non-negative finite number");
    }
    if (!Number.isInteger(options.compactAfterRecords) || options.compactAfterRecords < 1) {
      throw new RangeError("Compaction threshold must be a positive integer");
    }
    this.options = options;
    this.generateId = options.generateId ?? randomUUID;
    this.state = initialState({ settledIdCap: options.settledIdCap });
    this.authorityLostPromise = new Promise<void>((resolve) => {
      this.resolveAuthorityLost = resolve;
    });
  }

  get done(): Promise<RunResult> { return this.lifecyclePromise; }
  get currentState(): EngineState { return this.state; }

  async start(): Promise<void> {
    if (this.started) throw new Error("Engine runner already started");
    this.started = true;
    if (this.authorityLost) return this.failDuringStart("authority_lost");

    const journal = await Journal.open(this.options.journalPath);
    this.journal = journal;
    this.recordsSinceCompact = journal.recordCount;
    if (this.authorityLost) return this.failDuringStart("authority_lost");

    const recovered = recover(journal.records, this.options.clock.now(), {
      replyRetryHorizonMs: this.options.replyRetryHorizonMs,
      settledIdCap: this.options.settledIdCap,
      generateId: this.generateId,
    });
    if (recovered.records.length > 0) {
      try {
        await journal.appendAll(recovered.records);
        this.recordsSinceCompact += recovered.records.length;
      } catch {
        return this.failDuringStart("journal_failed");
      }
    }
    this.state = recovered.state;

    for (const effect of recovered.effects) {
      if (this.authorityLost) return this.failDuringStart("authority_lost");
      if (effect.type === "report_unknown_outcome") {
        await this.reportUnknownOutcome(effect);
      } else if (effect.type === "post_reply") {
        const failReason = await this.executePostReply(effect);
        if (failReason !== null) return this.failDuringStart(failReason);
      }
    }

    if (this.authorityLost) return this.failDuringStart("authority_lost");
    if (!(await this.maybeCompact())) {
      this.lifecyclePromise = Promise.resolve(await this.finishShutdown());
      return;
    }
    this.lifecyclePromise = this.runLoop();
  }

  async stop(): Promise<RunResult> {
    if (!this.started) return { reason: this.stopReason };
    this.stopping = true;
    this.claimAbort.abort();
    return this.lifecyclePromise;
  }

  loseAuthority(): void {
    if (this.shutdownComplete || this.authorityLost) return;
    this.authorityLost = true;
    this.failed = true;
    this.stopping = true;
    this.stopReason = "authority_lost";
    this.claimAbort.abort();
    if (!this.interruptedHarness) {
      this.interruptedHarness = true;
      try {
        const res = this.options.harness.interrupt();
        if (res !== undefined) this.interruptPromise = Promise.resolve(res).catch(() => {});
      } catch {
        // Best-effort interrupt during authority loss.
      }
    }
    const resolve = this.resolveAuthorityLost;
    this.resolveAuthorityLost = null;
    resolve?.();
  }

  private async raceAuthority<T>(fn: () => Promise<T>): Promise<RaceOutcome<T>> {
    if (this.authorityLost) return { kind: "authority_lost" };
    const p = Promise.resolve().then(() => {
      if (this.authorityLost) return undefined as unknown as T;
      return fn();
    });
    p.catch(() => {});
    const outcome = await Promise.race([
      p.then((value) => ({ kind: "ok" as const, value }), (err: unknown) => ({ kind: "err" as const, err })),
      this.authorityLostPromise.then(() => ({ kind: "authority_lost" as const })),
    ]);
    return this.authorityLost ? { kind: "authority_lost" } : outcome;
  }

  private async failDuringStart(reason: Exclude<StopReason, "stopped">): Promise<void> {
    this.failStop(reason);
    this.lifecyclePromise = Promise.resolve(await this.finishShutdown());
  }

  private async finishShutdown(): Promise<RunResult> {
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
      this.journal = null;
    }
    if (this.interruptPromise !== null) await this.interruptPromise;
    try {
      await this.options.harness.close?.();
    } catch {
      // Best-effort harness teardown during runner shutdown.
    }
    this.shutdownComplete = true;
    const result: RunResult = { reason: this.stopReason };
    await this.reportOperator("runner_stopped", { reason: result.reason });
    return result;
  }

  private failStop(reason: Exclude<StopReason, "stopped">): void {
    if (reason === "authority_lost") {
      this.loseAuthority();
      return;
    }
    if (!this.failed) this.stopReason = reason;
    this.failed = true;
    this.stopping = true;
    this.claimAbort.abort();
  }

  private async reportOperator(kind: OperatorReportKind, detail: Readonly<Record<string, unknown>>): Promise<void> {
    try {
      await this.options.operator?.report(kind, detail);
    } catch {
      // Best-effort reporting; never alters runner state.
    }
  }

  private reportUnknownOutcome(effect: Extract<Effect, { type: "report_unknown_outcome" }>): Promise<void> {
    return this.reportOperator("unknown_reply_outcome", {
      messageId: effect.messageId,
      commandId: effect.commandId,
      owedAt: effect.owedAt,
      at: effect.at,
    });
  }

  private async commit(fn: (state: EngineState) => Decision): Promise<readonly Effect[]> {
    if (this.journal === null) return [];
    const decision = fn(this.state);
    if (decision.records.length > 0) {
      await this.journal.appendAll(decision.records);
      this.recordsSinceCompact += decision.records.length;
      for (const record of decision.records) this.state = reduce(this.state, record);
    }
    return decision.effects;
  }

  private async tryCommit(fn: (state: EngineState) => Decision): Promise<readonly Effect[] | null> {
    try {
      return await this.commit(fn);
    } catch {
      this.failStop("journal_failed");
      return null;
    }
  }

  private async maybeCompact(): Promise<boolean> {
    if (this.authorityLost) return false;
    if (this.journal === null || this.state.active !== null) return true;
    if (this.recordsSinceCompact < this.options.compactAfterRecords) return true;
    try {
      await this.journal.compact(compacted(this.state));
      this.recordsSinceCompact = 0;
      return true;
    } catch {
      this.failStop("journal_failed");
      return false;
    }
  }

  private async executeMarkSeen(messageId: string, leaseId: string): Promise<boolean> {
    const outcome = await this.raceAuthority(() => this.options.cloud.markSeen(messageId, leaseId));
    if (outcome.kind === "authority_lost") return false;
    if (outcome.kind === "err") {
      if (outcome.err instanceof AuthorityLostError) {
        this.loseAuthority();
        return false;
      }
      // Non-authority failure: seen stays unconfirmed; continue.
      return true;
    }
    return (await this.tryCommit((s) => confirmMessageSeen(s, messageId, leaseId, this.options.clock.now()))) !== null;
  }

  private async executePostReply(
    initialEffect: Extract<Effect, { type: "post_reply" }>,
  ): Promise<Exclude<StopReason, "stopped"> | null> {
    let effect = initialEffect;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.raceAuthority(() => this.options.cloud.postReply(effect.command));
      if (outcome.kind === "authority_lost") return "authority_lost";
      if (outcome.kind === "err") {
        if (outcome.err instanceof AuthorityLostError) {
          this.loseAuthority();
          return "authority_lost";
        }
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

  private async claimOne(): Promise<IncomingMessage | null> {
    if (this.authorityLost || this.stopping || this.failed) return null;
    const outcome = await this.raceAuthority(() => this.options.cloud.claim(this.claimAbort.signal));
    if (outcome.kind === "authority_lost") return null;
    if (outcome.kind === "err") {
      if (outcome.err instanceof AuthorityLostError) this.loseAuthority();
      else if (!this.stopping) this.failStop("cloud_failed");
      return null;
    }
    return outcome.value;
  }

  private async runPendingTurn(): Promise<boolean> {
    if (this.authorityLost) return false;
    const effects = await this.tryCommit((s) => decideNext(s, this.options.clock.now()));
    if (effects === null) return false;

    const startEffect = findEffect(effects, "start_turn");
    if (!startEffect) return true;

    let handedOver = false;
    let markSeenPromise: Promise<boolean> | null = null;
    const onHandedOver = (): void => {
      if (handedOver || this.authorityLost || this.failed) return;
      handedOver = true;
      markSeenPromise = this.executeMarkSeen(startEffect.messageId, startEffect.leaseId);
    };

    const turnOutcome = await this.raceAuthority(() => this.options.harness.runTurn(startEffect.text, onHandedOver));
    if (turnOutcome.kind === "authority_lost") {
      if (markSeenPromise !== null) await markSeenPromise;
      return false;
    }

    if (markSeenPromise !== null) {
      const seenOk = await markSeenPromise;
      if (!seenOk || this.authorityLost || this.failed) return false;
    }

    let replyText: string | null = null;
    let harnessError: string | null = null;
    if (turnOutcome.kind === "ok") {
      if (typeof turnOutcome.value !== "string") {
        this.failStop("harness_port_failed");
        return false;
      }
      replyText = turnOutcome.value;
    } else {
      harnessError = truncateError(turnOutcome.err);
    }

    const replyEffects = await this.tryCommit((s) =>
      replyText !== null
        ? finishTurnWithReply(s, startEffect.messageId, replyText, this.options.clock.now(), this.generateId)
        : finishTurnWithFailure(s, startEffect.messageId, this.options.clock.now(), this.generateId),
    );
    if (replyEffects === null) return false;

    if (harnessError !== null) {
      await this.reportOperator("turn_failed", { messageId: startEffect.messageId, error: harnessError });
    }
    if (this.authorityLost || this.failed) return false;
    if (!(await this.runPostReplyEffects(replyEffects))) return false;
    return this.maybeCompact();
  }

  private async runLoop(): Promise<RunResult> {
    while (!this.stopping && !this.failed && !this.authorityLost) {
      if (!canClaim(this.state)) {
        if (!(await this.runPendingTurn())) break;
        continue;
      }
      const message = await this.claimOne();
      if (this.authorityLost || this.stopping || this.failed || message === null) continue;

      const acceptEffects = await this.tryCommit((s) =>
        acceptMessage(s, message, this.options.clock.now(), this.generateId),
      );
      if (acceptEffects === null || this.authorityLost) break;

      if (acceptEffects.length > 0) {
        const seenEffect = findEffect(acceptEffects, "mark_seen");
        if (seenEffect && !(await this.executeMarkSeen(seenEffect.messageId, seenEffect.leaseId))) break;
        if (!(await this.runPostReplyEffects(acceptEffects))) break;
        if (!(await this.maybeCompact())) break;
        continue;
      }
      if (this.state.pending !== null && !(await this.runPendingTurn())) break;
    }
    return this.finishShutdown();
  }
}
