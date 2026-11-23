import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RESTART_INTERRUPTED_REPLY, type ReplyStatus } from "../src/engine/core.js";
import { Journal } from "../src/engine/journal.js";
import type { Clock, CloudPort, HarnessPort, IncomingMessage } from "../src/engine/ports.js";
import { EngineRunner } from "../src/engine/runner.js";

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

interface CloudConnectionOptions {
  readonly throwOnPostReply?: boolean;
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
    const never = <T>(): Promise<T> => new Promise<T>(() => {});

    return {
      disconnect: () => {
        disconnected = true;
        this.claimWaiter = null;
      },
      claim: async (limit: number, signal?: AbortSignal) => {
        if (disconnected) return never();
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
      postReply: async (messageId: string, text: string, status: ReplyStatus) => {
        if (disconnected) return never();
        if (options.hangPostReplyFor === messageId) {
          options.onPostReplyHang?.();
          return never();
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
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await runner2.stop();

  const harness3 = new FakeHarness({ autoReply: true });
  const runner3 = new EngineRunner({
    journalPath,
    harness: harness3,
    cloud: cloud.connect(),
    clock: makeClock(3_000),
  });
  await runner3.start();
  await runner3.stop();

  const harness4 = new FakeHarness({ autoReply: true });
  const runner4 = new EngineRunner({
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
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await runner2.stop();

  const harness3 = new FakeHarness({ autoReply: true });
  const runner3 = new EngineRunner({
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
