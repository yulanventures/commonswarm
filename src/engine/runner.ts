import {
  DEFAULT_QUEUE_CAP,
  acceptMessage,
  availableCapacity,
  confirmMessageSeen,
  confirmReplyPosted,
  decideNext,
  finishTurnWithFailure,
  finishTurnWithReply,
  initialState,
  recover,
  reduce,
  type Decision,
  type Effect,
  type EngineState,
} from "./core.js";
import { Journal } from "./journal.js";
import type { Clock, CloudPort, HarnessPort, IncomingMessage } from "./ports.js";

export interface RunnerOptions {
  readonly journalPath: string;
  readonly harness: HarnessPort;
  readonly cloud: CloudPort;
  readonly clock: Clock;
  readonly queueCap?: number;
}

export class EngineRunner {
  private readonly options: RunnerOptions;
  private readonly queueCap: number;
  private readonly claimAbort = new AbortController();
  private journal: Journal | null = null;
  private state: EngineState;
  private commitChain: Promise<void> = Promise.resolve();
  private started = false;
  private stopping = false;
  private failed = false;
  private journalClosed = false;
  private workerWake: (() => void) | null = null;
  private claimerWake: (() => void) | null = null;
  private lifecyclePromise: Promise<void> = Promise.resolve();

  constructor(options: RunnerOptions) {
    this.options = options;
    this.queueCap = options.queueCap ?? DEFAULT_QUEUE_CAP;
    this.state = initialState(this.queueCap);
  }

  get done(): Promise<void> {
    return this.lifecyclePromise;
  }

  get currentState(): EngineState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Engine runner already started");
    }
    this.started = true;

    const journal = await Journal.open(this.options.journalPath);
    this.journal = journal;

    const recovered = recover(journal.records, this.options.clock.now(), this.queueCap);
    this.state = recovered.state;

    if (recovered.records.length > 0) {
      await journal.appendAll(recovered.records);
    }

    for (const effect of recovered.effects) {
      if (effect.type !== "post_reply") continue;
      try {
        await this.executePostReply(effect);
      } catch {
        this.failStop();
        await this.finishShutdown();
        this.lifecyclePromise = Promise.resolve();
        return;
      }
    }

    this.lifecyclePromise = this.runLoops();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    this.claimAbort.abort();
    this.notifyClaimer();
    this.notifyWorker();
    await this.lifecyclePromise;
  }

  private async runLoops(): Promise<void> {
    const worker = this.workerLoop();
    const claimer = this.claimLoop();
    void claimer;
    await worker;
    await this.finishShutdown();
  }

  private async finishShutdown(): Promise<void> {
    await this.commitChain;
    this.journalClosed = true;
    if (this.journal !== null) {
      await this.journal.flush();
      await this.journal.close();
    }
  }

  private failStop(): void {
    this.failed = true;
    this.stopping = true;
    this.claimAbort.abort();
    this.notifyClaimer();
    this.notifyWorker();
  }

  private async commit(fn: (state: EngineState) => Decision): Promise<readonly Effect[]> {
    let effects: readonly Effect[] = [];
    const next = this.commitChain.then(async () => {
      if (this.journalClosed || this.journal === null) return;
      const decision = fn(this.state);
      if (decision.records.length > 0) {
        await this.journal.appendAll(decision.records);
        for (const record of decision.records) {
          this.state = reduce(this.state, record);
        }
      }
      effects = decision.effects;
    });
    this.commitChain = next.catch(() => {});
    await next;
    return effects;
  }

  private async executePostReply(
    effect: Extract<Effect, { type: "post_reply" }>,
  ): Promise<void> {
    await this.options.cloud.postReply(effect.messageId, effect.text, effect.status);
    await this.commit((s) =>
      confirmReplyPosted(s, effect.messageId, this.options.clock.now()),
    );
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
        if (!this.stopping) {
          this.failStop();
        }
        return;
      }

      if (this.stopping || this.failed) return;
      if (batch.length === 0) continue;

      let acceptedAny = false;
      for (const message of batch) {
        if (this.stopping || this.failed) return;
        try {
          await this.commit((s) => {
            const decision = acceptMessage(s, message, this.options.clock.now());
            if (decision.records.length > 0) {
              acceptedAny = true;
            }
            return decision;
          });
        } catch {
          this.failStop();
          return;
        }
      }

      if (acceptedAny) {
        this.notifyWorker();
      }
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
        this.failStop();
        return;
      }

      const startEffect = effects.find(
        (effect): effect is Extract<Effect, { type: "start_turn" }> =>
          effect.type === "start_turn",
      );
      if (!startEffect) continue;

      const seenEffect = effects.find(
        (effect): effect is Extract<Effect, { type: "mark_seen" }> =>
          effect.type === "mark_seen",
      );
      if (seenEffect) {
        try {
          await this.options.cloud.markSeen(seenEffect.messageId);
          await this.commit((s) =>
            confirmMessageSeen(s, seenEffect.messageId, this.options.clock.now()),
          );
        } catch {
          this.failStop();
          return;
        }
      }

      let replyEffects: readonly Effect[];
      try {
        const replyText = await this.options.harness.runTurn(startEffect.text);
        replyEffects = await this.commit((s) =>
          finishTurnWithReply(s, startEffect.messageId, replyText, this.options.clock.now()),
        );
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim().length > 0
            ? err.message
            : "Turn failed.";
        try {
          replyEffects = await this.commit((s) =>
            finishTurnWithFailure(
              s,
              startEffect.messageId,
              message,
              this.options.clock.now(),
            ),
          );
        } catch {
          this.failStop();
          return;
        }
      }

      for (const effect of replyEffects) {
        if (effect.type !== "post_reply") continue;
        try {
          await this.executePostReply(effect);
        } catch {
          this.failStop();
          return;
        }
      }

      this.notifyClaimer();
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.workerWake = resolve;
    });
  }

  private notifyWorker(): void {
    const wake = this.workerWake;
    this.workerWake = null;
    wake?.();
  }

  private waitForClaimSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.claimerWake = resolve;
    });
  }

  private notifyClaimer(): void {
    const wake = this.claimerWake;
    this.claimerWake = null;
    wake?.();
  }
}
