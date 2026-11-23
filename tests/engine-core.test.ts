import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_MESSAGE_TEXT_BYTES,
  MESSAGE_TOO_LONG_REPLY,
  RESTART_INTERRUPTED_REPLY,
  TURN_FAILED_REPLY,
  compacted,
  reduceAll,
  type ReplyStatus,
} from "../src/engine/core.js";
import { Journal, MAX_RECORD_BYTES } from "../src/engine/journal.js";
import type {
  Clock,
  CloudPort,
  HarnessPort,
  IdGenerator,
  IncomingMessage,
  OperatorPort,
  OperatorReportKind,
} from "../src/engine/ports.js";
import { EngineRunner } from "../src/engine/runner.js";

const TEST_RUNNER_LIMITS = {
  replyRetryHorizonMs: 60_000,
  compactAfterRecords: 1_000,
  settledIdCap: 1_000,
} as const;

function makeIdGen(prefix = "cmd"): IdGenerator {
  let seq = 0;
  return () => {
    seq += 1;
    return `${prefix}-${seq}`;
  };
}

interface OperatorEvent {
  readonly kind: OperatorReportKind;
  readonly detail: Readonly<Record<string, unknown>>;
}

class FakeOperator implements OperatorPort {
  readonly events: OperatorEvent[] = [];

  report(kind: OperatorReportKind, detail: Readonly<Record<string, unknown>>): void {
    this.events.push({ kind, detail });
  }
}

function makeClock(start = 1_000): Clock {
  let now = start;
  return {
    now() {
      now += 1;
      return now;
    },
  };
}

interface RecordedReply {
  readonly messageId: string;
  readonly text: string;
  readonly status: ReplyStatus;
}

interface RecordedReplyAttempt extends RecordedReply {
  readonly commandId: string;
}

interface CloudConnectionOptions {
  readonly throwOnClaim?: boolean;
  readonly throwOnPostReply?: boolean;
  readonly failPostReplyTimes?: number;
  readonly hangPostReplyFor?: string;
  readonly onPostReplyHang?: () => void;
  readonly maxPerClaim?: number;
}

class FakeCloud {
  readonly pending: IncomingMessage[] = [];
  readonly claimedIds: string[] = [];
  readonly claimLimits: number[] = [];
  readonly seen: string[] = [];
  readonly replies: RecordedReply[] = [];
  readonly replyAttempts: RecordedReplyAttempt[] = [];

  private claimWaiter: (() => void) | null = null;
  private replyWaiters: Array<{ count: number; resolve: () => void }> = [];
  private claimedWaiters: Array<{ count: number; resolve: () => void }> = [];

  enqueue(...messages: readonly IncomingMessage[]): void {
    this.pending.push(...messages);
    const wake = this.claimWaiter;
    this.claimWaiter = null;
    wake?.();
  }

  enqueueNumbered(count: number, startAt = 1): void {
    const batch: IncomingMessage[] = [];
    for (let i = startAt; i < startAt + count; i += 1) {
      batch.push({ id: `m-${i}`, text: `msg-${i}` });
    }
    this.enqueue(...batch);
  }

  waitForReplies(count: number): Promise<void> {
    if (this.replies.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.replyWaiters.push({ count, resolve });
    });
  }

  waitForClaimedCount(count: number): Promise<void> {
    if (this.claimedIds.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.claimedWaiters.push({ count, resolve });
    });
  }

  connect(options: CloudConnectionOptions = {}): CloudPort & { disconnect: () => void } {
    let disconnected = false;
    let remainingPostFailures = options.failPostReplyTimes ?? 0;
    const never = <T>(): Promise<T> => new Promise<T>(() => {});

    return {
      disconnect: () => {
        disconnected = true;
        this.claimWaiter = null;
      },
      claim: async (limit: number, signal?: AbortSignal) => {
        if (disconnected) return never();
        if (options.throwOnClaim) {
          throw new Error("Simulated cloud claim failure");
        }
        while (this.pending.length === 0) {
          if (disconnected) return never();
          if (signal?.aborted) return [];
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              if (this.claimWaiter === onWake) this.claimWaiter = null;
              resolve();
            };
            const onWake = () => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            this.claimWaiter = onWake;
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          if (disconnected) return never();
          if (signal?.aborted) return [];
        }
        const take =
          options.maxPerClaim !== undefined
            ? Math.min(limit, options.maxPerClaim)
            : limit;
        const batch = this.pending.splice(0, take);
        this.claimLimits.push(limit);
        for (const msg of batch) {
          this.claimedIds.push(msg.id);
        }
        this.flushClaimedWaiters();
        return batch;
      },
      markSeen: async (messageId: string) => {
        if (disconnected) return never();
        this.seen.push(messageId);
      },
      postReply: async (
        messageId: string,
        commandId: string,
        text: string,
        status: ReplyStatus,
      ) => {
        if (disconnected) return never();
        this.replyAttempts.push({ messageId, commandId, text, status });
        if (options.hangPostReplyFor === messageId) {
          options.onPostReplyHang?.();
          return never();
        }
        if (remainingPostFailures > 0) {
          remainingPostFailures -= 1;
          throw new Error("Simulated transient cloud post failure");
        }
        if (options.throwOnPostReply) {
          throw new Error("Simulated cloud post failure");
        }
        this.replies.push({ messageId, text, status });
        this.flushReplyWaiters();
      },
    };
  }

  private flushReplyWaiters(): void {
    const remaining: Array<{ count: number; resolve: () => void }> = [];
    for (const waiter of this.replyWaiters) {
      if (this.replies.length >= waiter.count) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.replyWaiters = remaining;
  }

  private flushClaimedWaiters(): void {
    const remaining: Array<{ count: number; resolve: () => void }> = [];
    for (const waiter of this.claimedWaiters) {
      if (this.claimedIds.length >= waiter.count) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.claimedWaiters = remaining;
  }
}

interface PendingTurn {
  readonly text: string;
  readonly resolve: (reply: string) => void;
  readonly reject: (err: Error) => void;
}

class FakeHarness implements HarnessPort {
  readonly started: string[] = [];
  readonly turns: PendingTurn[] = [];
  interrupted = 0;

  private readonly autoReply: boolean;
  private turnWaiters: Array<{ index: number; resolve: (turn: PendingTurn) => void }> = [];

  constructor(options: { autoReply?: boolean } = {}) {
    this.autoReply = options.autoReply ?? true;
  }

  runTurn(text: string): Promise<string> {
    this.started.push(text);
    if (this.autoReply) {
      return Promise.resolve(`reply:${text}`);
    }
    return new Promise<string>((resolve, reject) => {
      const turn: PendingTurn = { text, resolve, reject };
      this.turns.push(turn);
      const remaining: Array<{ index: number; resolve: (turn: PendingTurn) => void }> = [];
      for (const waiter of this.turnWaiters) {
        if (this.turns.length > waiter.index) {
          waiter.resolve(this.turns[waiter.index]);
        } else {
          remaining.push(waiter);
        }
      }
      this.turnWaiters = remaining;
    });
  }

  interrupt(): void {
    this.interrupted += 1;
  }

  waitForTurn(index: number): Promise<PendingTurn> {
    if (this.turns.length > index) {
      return Promise.resolve(this.turns[index]);
    }
    return new Promise<PendingTurn>((resolve) => {
      this.turnWaiters.push({ index, resolve });
    });
  }
}

async function flushEventLoop(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function makeTempDir(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "engine-core-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("1. 100 messages through the runner: every one replied to exactly once, in arrival order", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "state", "journal.ndjson");
  const cloud = new FakeCloud();
  const harness = new FakeHarness({ autoReply: true });
  cloud.enqueueNumbered(100);

  const runner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness,
    cloud: cloud.connect(),
    clock: makeClock(),
  });
  await runner.start();
  await cloud.waitForReplies(100);
  await runner.stop();

  assert.equal(harness.started.length, 100);
  assert.equal(cloud.seen.length, 100);
  assert.equal(cloud.replies.length, 100);
  for (let i = 1; i <= 100; i += 1) {
    assert.equal(cloud.seen[i - 1], `m-${i}`);
    assert.deepEqual(cloud.replies[i - 1], {
      messageId: `m-${i}`,
      text: `reply:msg-${i}`,
      status: "replied",
    });
  }
});

test("2. restart while messages are queued: abandon runner mid-queue, restart loses none and runs none twice", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueueNumbered(6);

  let hitHang!: () => void;
  const hungMidQueue = new Promise<void>((resolve) => {
    hitHang = resolve;
  });

  const cloud1 = cloud.connect({
    hangPostReplyFor: "m-2",
    onPostReplyHang: hitHang,
  });
  const harness1 = new FakeHarness({ autoReply: true });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness1,
    cloud: cloud1,
    clock: makeClock(1_000),
  });
  await runner1.start();
  await hungMidQueue;
  cloud1.disconnect();
  // Abandon runner1 without calling runner1.stop().

  const harness2 = new FakeHarness({ autoReply: true });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await cloud.waitForReplies(6);
  await runner2.stop();

  assert.deepEqual(harness1.started, ["msg-1", "msg-2"]);
  assert.deepEqual(harness2.started, ["msg-3", "msg-4", "msg-5", "msg-6"]);
  assert.deepEqual(
    cloud.replies,
    [1, 2, 3, 4, 5, 6].map((i) => ({
      messageId: `m-${i}`,
      text: `reply:msg-${i}`,
      status: "replied",
    })),
  );
});

test("3. restart while a turn is running: interrupted once across further restarts, next message runs normally", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue({ id: "m-1", text: "msg-1" });

  const cloud1 = cloud.connect();
  const harness1 = new FakeHarness({ autoReply: false });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness1,
    cloud: cloud1,
    clock: makeClock(1_000),
  });
  await runner1.start();
  await harness1.waitForTurn(0);
  cloud1.disconnect();
  // Abandon runner1 with m-1 still hanging.

  const harness2 = new FakeHarness({ autoReply: true });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await runner2.stop();

  const harness3 = new FakeHarness({ autoReply: true });
  const runner3 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness3,
    cloud: cloud.connect(),
    clock: makeClock(3_000),
  });
  await runner3.start();
  await runner3.stop();

  const harness4 = new FakeHarness({ autoReply: true });
  const runner4 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness4,
    cloud: cloud.connect(),
    clock: makeClock(4_000),
  });
  await runner4.start();
  cloud.enqueue({ id: "m-2", text: "msg-2" });
  await cloud.waitForReplies(2);
  await runner4.stop();

  assert.deepEqual(harness1.started, ["msg-1"]);
  assert.deepEqual(harness2.started, []);
  assert.deepEqual(harness3.started, []);
  assert.deepEqual(harness4.started, ["msg-2"]);
  assert.deepEqual(cloud.replies, [
    {
      messageId: "m-1",
      text: RESTART_INTERRUPTED_REPLY,
      status: "failed",
    },
    {
      messageId: "m-2",
      text: "reply:msg-2",
      status: "replied",
    },
  ]);
});

test("4. finished turn whose reply post threw: posted after restart, not posted again on further restart", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue({ id: "m-1", text: "msg-1" });

  const harness1 = new FakeHarness({ autoReply: true });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness1,
    cloud: cloud.connect({ throwOnPostReply: true }),
    clock: makeClock(1_000),
  });
  await runner1.start();
  await runner1.done;

  assert.deepEqual(harness1.started, ["msg-1"]);
  assert.deepEqual(cloud.replies, []);

  const harness2 = new FakeHarness({ autoReply: true });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await runner2.stop();

  const harness3 = new FakeHarness({ autoReply: true });
  const runner3 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness3,
    cloud: cloud.connect(),
    clock: makeClock(3_000),
  });
  await runner3.start();
  await runner3.stop();

  assert.deepEqual(harness2.started, []);
  assert.deepEqual(harness3.started, []);
  assert.deepEqual(cloud.replies, [
    {
      messageId: "m-1",
      text: "reply:msg-1",
      status: "replied",
    },
  ]);
});

test("5. a message delivered twice is run once", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const harness = new FakeHarness({ autoReply: true });
  cloud.enqueue(
    { id: "dup-1", text: "hello" },
    { id: "dup-1", text: "hello" },
    { id: "m-2", text: "after" },
  );

  const runner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness,
    cloud: cloud.connect(),
    clock: makeClock(),
  });
  await runner.start();
  await cloud.waitForReplies(2);

  cloud.enqueue(
    { id: "dup-1", text: "hello" },
    { id: "m-3", text: "final" },
  );
  await cloud.waitForReplies(3);
  await runner.stop();

  assert.deepEqual(harness.started, ["hello", "after", "final"]);
  assert.deepEqual(
    cloud.replies.map((r) => r.messageId),
    ["dup-1", "m-2", "m-3"],
  );
});

test("6. at the queue cap the runner claims nothing more until a turn finishes", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const harness = new FakeHarness({ autoReply: false });
  cloud.enqueueNumbered(5);

  const runner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness,
    cloud: cloud.connect({ maxPerClaim: 1 }),
    clock: makeClock(),
    queueCap: 3,
  });
  await runner.start();

  const turn1 = await harness.waitForTurn(0);
  await cloud.waitForClaimedCount(3);
  await flushEventLoop();

  assert.deepEqual(cloud.claimedIds, ["m-1", "m-2", "m-3"]);
  assert.equal(cloud.pending.length, 2);

  turn1.resolve("reply:msg-1");
  const turn2 = await harness.waitForTurn(1);
  await cloud.waitForClaimedCount(4);
  await flushEventLoop();

  assert.deepEqual(cloud.claimedIds, ["m-1", "m-2", "m-3", "m-4"]);
  assert.equal(cloud.pending.length, 1);

  turn2.resolve("reply:msg-2");
  const turn3 = await harness.waitForTurn(2);
  turn3.resolve("reply:msg-3");
  const turn4 = await harness.waitForTurn(3);
  turn4.resolve("reply:msg-4");
  const turn5 = await harness.waitForTurn(4);
  turn5.resolve("reply:msg-5");

  await cloud.waitForReplies(5);
  await runner.stop();

  assert.deepEqual(
    cloud.replies.map((r) => r.messageId),
    ["m-1", "m-2", "m-3", "m-4", "m-5"],
  );
});

test("7. journal: torn last line ignored, symlink refused, file created 0600", async (t) => {
  const dir = await makeTempDir(t);
  const journalDir = join(dir, "private");
  const journalPath = join(journalDir, "journal.ndjson");

  const journal1 = await Journal.open(journalPath);
  assert.equal((await stat(journalDir)).mode & 0o777, 0o700);
  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);

  await journal1.append({
    type: "message_accepted",
    messageId: "m-1",
    text: "hello",
    at: 100,
  });
  await journal1.append({
    type: "turn_started",
    messageId: "m-1",
    at: 101,
  });
  await journal1.close();

  await appendFile(journalPath, '{"type":"turn_finished","messageId":"m-1"', "utf8");

  const journal2 = await Journal.open(journalPath);
  assert.deepEqual(journal2.records, [
    { type: "message_accepted", messageId: "m-1", text: "hello", at: 100 },
    { type: "turn_started", messageId: "m-1", at: 101 },
  ]);

  await journal2.append({
    type: "turn_finished",
    messageId: "m-1",
    commandId: "cmd-1",
    outcome: "replied",
    replyText: "ok",
    at: 102,
  });
  await journal2.close();

  const journal3 = await Journal.open(journalPath);
  assert.equal(journal3.records.length, 3);
  await journal3.close();

  const realTarget = join(dir, "real.ndjson");
  const symlinkPath = join(dir, "link.ndjson");
  await writeFile(realTarget, "", { mode: 0o600 });
  await symlink(realTarget, symlinkPath);

  await assert.rejects(
    () => Journal.open(symlinkPath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /symlink/i);
      assert.equal(err.message.includes(symlinkPath), false);
      assert.equal(err.message.includes(dir), false);
      return true;
    },
  );
});

test("8. reply post retries (in-process and after restart) send identical commandId, text and status", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();

  // In-process retry: first postReply fails transiently, second succeeds.
  cloud.enqueue({ id: "m-1", text: "first" });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ failPostReplyTimes: 1 }),
    clock: makeClock(1_000),
    generateId: makeIdGen("r1"),
  });
  await runner1.start();
  await cloud.waitForReplies(1);
  await runner1.stop();

  const m1Attempts = cloud.replyAttempts.filter((a) => a.messageId === "m-1");
  assert.equal(m1Attempts.length, 2);
  assert.deepEqual(m1Attempts[0], {
    messageId: "m-1",
    commandId: "r1-1",
    text: "reply:first",
    status: "replied",
  });
  assert.deepEqual(m1Attempts[1], m1Attempts[0]);

  // Restart retry: postReply always fails in runner2, then succeeds in runner3.
  cloud.enqueue({ id: "m-2", text: "second" });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ throwOnPostReply: true }),
    clock: makeClock(2_000),
    generateId: makeIdGen("r2"),
  });
  await runner2.start();
  const r2Result = await runner2.done;
  assert.deepEqual(r2Result, { reason: "cloud_failed" });

  const runner3 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect(),
    clock: makeClock(3_000),
    generateId: makeIdGen("r3"),
  });
  await runner3.start();
  await cloud.waitForReplies(2);
  await runner3.stop();

  const m2Attempts = cloud.replyAttempts.filter((a) => a.messageId === "m-2");
  assert.ok(m2Attempts.length >= 2);
  for (const attempt of m2Attempts) {
    assert.deepEqual(attempt, {
      messageId: "m-2",
      commandId: "r2-1",
      text: "reply:second",
      status: "replied",
    });
  }

  // Interruption notice gets its commandId once when recorded, not regenerated on restart.
  cloud.enqueue({ id: "m-3", text: "third" });
  const cloud4 = cloud.connect();
  const harness4 = new FakeHarness({ autoReply: false });
  const runner4 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness4,
    cloud: cloud4,
    clock: makeClock(4_000),
    generateId: makeIdGen("r4"),
  });
  await runner4.start();
  await harness4.waitForTurn(0);
  cloud4.disconnect();

  const runner5 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ throwOnPostReply: true }),
    clock: makeClock(5_000),
    generateId: makeIdGen("r5"),
  });
  await runner5.start();
  assert.deepEqual(await runner5.done, { reason: "cloud_failed" });

  const runner6 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect(),
    clock: makeClock(6_000),
    generateId: makeIdGen("r6"),
  });
  await runner6.start();
  await cloud.waitForReplies(3);
  await runner6.stop();

  const m3Attempts = cloud.replyAttempts.filter((a) => a.messageId === "m-3");
  assert.ok(m3Attempts.length >= 2);
  for (const attempt of m3Attempts) {
    assert.deepEqual(attempt, {
      messageId: "m-3",
      commandId: "r5-1",
      text: RESTART_INTERRUPTED_REPLY,
      status: "failed",
    });
  }
});

test("9. owed reply older than horizon is not sent; operator told once across further restarts", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const operator = new FakeOperator();
  cloud.enqueue({ id: "m-1", text: "msg-1" });

  const runner1 = new EngineRunner({
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ throwOnPostReply: true }),
    clock: makeClock(1_000),
    replyRetryHorizonMs: 500,
    compactAfterRecords: 1_000,
    settledIdCap: 100,
    generateId: makeIdGen("cmd"),
    operator,
  });
  await runner1.start();
  assert.deepEqual(await runner1.done, { reason: "cloud_failed" });

  const attemptsBeforeRestart = cloud.replyAttempts.length;

  const runner2 = new EngineRunner({
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect(),
    clock: makeClock(5_000),
    replyRetryHorizonMs: 500,
    compactAfterRecords: 1_000,
    settledIdCap: 100,
    operator,
  });
  await runner2.start();
  await runner2.stop();

  assert.equal(cloud.replyAttempts.length, attemptsBeforeRestart);
  assert.equal(cloud.replies.length, 0);
  const unknownReportsAfter2 = operator.events.filter(
    (e) => e.kind === "unknown_reply_outcome",
  );
  assert.equal(unknownReportsAfter2.length, 1);
  assert.equal(unknownReportsAfter2[0].detail.messageId, "m-1");
  assert.equal(unknownReportsAfter2[0].detail.commandId, "cmd-1");

  const runner3 = new EngineRunner({
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect(),
    clock: makeClock(10_000),
    replyRetryHorizonMs: 500,
    compactAfterRecords: 1_000,
    settledIdCap: 100,
    operator,
  });
  await runner3.start();
  await runner3.stop();

  assert.equal(cloud.replyAttempts.length, attemptsBeforeRestart);
  const unknownReportsAfter3 = operator.events.filter(
    (e) => e.kind === "unknown_reply_outcome",
  );
  assert.equal(unknownReportsAfter3.length, 1);
});

test("10. harness error with path and token never reaches reply or journal; operator gets truncated copy", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const operator = new FakeOperator();
  const harness = new FakeHarness({ autoReply: false });
  cloud.enqueue({ id: "m-1", text: "trigger-error" });

  const secretPath = "/Users/example/private/credentials.json";
  const secretToken = "sk-live-secret-token-9876543210";
  const longError = `Auth failed at ${secretPath} with ${secretToken} ${"z".repeat(600)}`;

  const runner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness,
    cloud: cloud.connect(),
    clock: makeClock(1_000),
    operator,
  });
  await runner.start();

  const turn = await harness.waitForTurn(0);
  turn.reject(new Error(longError));
  await cloud.waitForReplies(1);
  await runner.stop();

  assert.deepEqual(cloud.replies, [
    {
      messageId: "m-1",
      text: TURN_FAILED_REPLY,
      status: "failed",
    },
  ]);

  const rawJournal = await readFile(journalPath, "utf8");
  assert.equal(rawJournal.includes(secretPath), false);
  assert.equal(rawJournal.includes(secretToken), false);
  assert.equal(cloud.replies[0].text.includes(secretPath), false);
  assert.equal(cloud.replies[0].text.includes(secretToken), false);

  const failReports = operator.events.filter((e) => e.kind === "turn_failed");
  assert.equal(failReports.length, 1);
  assert.equal(failReports[0].detail.messageId, "m-1");
  assert.equal(typeof failReports[0].detail.error, "string");
  const reportedError = failReports[0].detail.error as string;
  assert.equal(reportedError.length, 500);
  assert.equal(reportedError, longError.slice(0, 500));
});

test("11. compaction drops settled text, keeps duplicate detection, preserves active turn interruption, stays 0600 with no temp file", async (t) => {
  const dir = await makeTempDir(t);
  const journalDir = join(dir, "state");
  const journalPath = join(journalDir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue(
    { id: "m-1", text: "secret-payload-one" },
    { id: "m-2", text: "secret-payload-two" },
    { id: "m-3", text: "secret-payload-three" },
  );

  // Trigger automatic compaction after 10 records with settledIdCap: 3 (oldest id dropped first).
  const runner1 = new EngineRunner({
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect(),
    clock: makeClock(1_000),
    replyRetryHorizonMs: 60_000,
    compactAfterRecords: 10,
    settledIdCap: 3,
  });
  await runner1.start();
  await cloud.waitForReplies(3);
  await runner1.stop();

  // Enqueue m-4 so m-3 and m-4 are also compacted and m-1 is evicted by settledIdCap: 3.
  cloud.enqueue({ id: "m-4", text: "secret-payload-four" });
  const runner1b = new EngineRunner({
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect(),
    clock: makeClock(1_500),
    replyRetryHorizonMs: 60_000,
    compactAfterRecords: 5,
    settledIdCap: 3,
  });
  await runner1b.start();
  await cloud.waitForReplies(4);
  await runner1b.stop();

  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(journalDir), ["journal.ndjson"]);
  const compactedText = await readFile(journalPath, "utf8");
  for (const secret of [
    "secret-payload-one",
    "secret-payload-two",
    "secret-payload-three",
    "secret-payload-four",
  ]) {
    assert.equal(compactedText.includes(secret), false);
  }
  assert.equal(compactedText.includes('"m-1"'), false);
  assert.equal(compactedText.includes('"m-4"'), true);

  // Restart on compacted journal: duplicate of settled m-4 is ignored; m-5 starts and hangs.
  const cloud2 = cloud.connect();
  const harness2 = new FakeHarness({ autoReply: false });
  const runner2 = new EngineRunner({
    journalPath,
    harness: harness2,
    cloud: cloud2,
    clock: makeClock(2_000),
    replyRetryHorizonMs: 60_000,
    compactAfterRecords: 1_000,
    settledIdCap: 3,
  });
  await runner2.start();
  cloud.enqueue(
    { id: "m-4", text: "duplicate-of-settled" },
    { id: "m-5", text: "in-flight-turn" },
  );
  await harness2.waitForTurn(0);
  cloud2.disconnect();
  assert.deepEqual(harness2.started, ["in-flight-turn"]);

  // Compact the journal while m-5 is active (started, never finished).
  const journal = await Journal.open(journalPath);
  const activeState = reduceAll(journal.records, { settledIdCap: 3 });
  await journal.compact(compacted(activeState));
  await journal.close();

  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(journalDir), ["journal.ndjson"]);

  // Recovering from that compacted journal reports m-5 interrupted and never replays it.
  const harness3 = new FakeHarness({ autoReply: true });
  const runner3 = new EngineRunner({
    journalPath,
    harness: harness3,
    cloud: cloud.connect(),
    clock: makeClock(3_000),
    replyRetryHorizonMs: 60_000,
    compactAfterRecords: 1_000,
    settledIdCap: 3,
  });
  await runner3.start();
  await cloud.waitForReplies(5);
  await runner3.stop();

  assert.deepEqual(harness3.started, []);
  assert.deepEqual(cloud.replies[4], {
    messageId: "m-5",
    text: RESTART_INTERRUPTED_REPLY,
    status: "failed",
  });
});

test("12. over-long message is refused with one failed reply and does not block the next message", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const harness = new FakeHarness({ autoReply: true });
  const oversizedText = "x".repeat(MAX_MESSAGE_TEXT_BYTES + 1);

  cloud.enqueue(
    { id: "big-1", text: oversizedText },
    { id: "m-2", text: "normal-msg" },
  );

  const runner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness,
    cloud: cloud.connect(),
    clock: makeClock(1_000),
  });
  await runner.start();
  await cloud.waitForReplies(2);

  // Redelivering the same oversized message does not send a second refused reply.
  cloud.enqueue(
    { id: "big-1", text: oversizedText },
    { id: "m-3", text: "after-dup" },
  );
  await cloud.waitForReplies(3);
  await runner.stop();

  assert.deepEqual(harness.started, ["normal-msg", "after-dup"]);
  assert.deepEqual(cloud.replies, [
    {
      messageId: "big-1",
      text: MESSAGE_TOO_LONG_REPLY,
      status: "failed",
    },
    {
      messageId: "m-2",
      text: "reply:normal-msg",
      status: "replied",
    },
    {
      messageId: "m-3",
      text: "reply:after-dup",
      status: "replied",
    },
  ]);

  // Also verify single record line over 256 KiB is refused at journal append.
  const oversizedJournal = await Journal.open(join(dir, "oversized.ndjson"));
  await assert.rejects(
    () =>
      oversizedJournal.append({
        type: "turn_finished",
        messageId: "m-big",
        commandId: "cmd-big",
        outcome: "replied",
        replyText: "y".repeat(MAX_RECORD_BYTES),
        at: 2_000,
      }),
    /maximum size/i,
  );
  await oversizedJournal.close();
});

test("13. existing journal folder with group or other permissions is refused", async (t) => {
  const dir = await makeTempDir(t);

  const groupReadableDir = join(dir, "group-open");
  await mkdir(groupReadableDir, { mode: 0o750 });
  await chmod(groupReadableDir, 0o750);
  await assert.rejects(
    () => Journal.open(join(groupReadableDir, "journal.ndjson")),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /group or other permissions/i);
      assert.equal(err.message.includes(groupReadableDir), false);
      assert.equal(err.message.includes(dir), false);
      return true;
    },
  );

  const worldReadableDir = join(dir, "other-open");
  await mkdir(worldReadableDir, { mode: 0o705 });
  await chmod(worldReadableDir, 0o705);
  await assert.rejects(
    () => Journal.open(join(worldReadableDir, "journal.ndjson")),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /group or other permissions/i);
      assert.equal(err.message.includes(worldReadableDir), false);
      assert.equal(err.message.includes(dir), false);
      return true;
    },
  );
});

test("14. runner done result reports the right reason for a cloud failure and for a clean stop", async (t) => {
  const dir = await makeTempDir(t);

  // Clean stop
  const cleanCloud = new FakeCloud();
  const cleanOperator = new FakeOperator();
  cleanCloud.enqueue({ id: "m-1", text: "ok" });
  const cleanRunner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath: join(dir, "clean.ndjson"),
    harness: new FakeHarness({ autoReply: true }),
    cloud: cleanCloud.connect(),
    clock: makeClock(1_000),
    operator: cleanOperator,
  });
  await cleanRunner.start();
  await cleanCloud.waitForReplies(1);
  await cleanRunner.stop();
  assert.deepEqual(await cleanRunner.done, { reason: "stopped" });
  assert.deepEqual(
    cleanOperator.events.filter((e) => e.kind === "runner_stopped"),
    [{ kind: "runner_stopped", detail: { reason: "stopped" } }],
  );

  // Cloud failure
  const failingCloud = new FakeCloud();
  const failingOperator = new FakeOperator();
  const failingRunner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath: join(dir, "failing.ndjson"),
    harness: new FakeHarness({ autoReply: true }),
    cloud: failingCloud.connect({ throwOnClaim: true }),
    clock: makeClock(2_000),
    operator: failingOperator,
  });
  await failingRunner.start();
  assert.deepEqual(await failingRunner.done, { reason: "cloud_failed" });
  assert.deepEqual(
    failingOperator.events.filter((e) => e.kind === "runner_stopped"),
    [{ kind: "runner_stopped", detail: { reason: "cloud_failed" } }],
  );
});
