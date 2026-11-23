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
import { isDeepStrictEqual } from "node:util";
import {
  MAX_MESSAGE_TEXT_BYTES,
  MESSAGE_TOO_LONG_REPLY,
  RESTART_INTERRUPTED_REPLY,
  TURN_FAILED_REPLY,
  compacted,
  reduceAll,
} from "../src/engine/core.js";
import { Journal, MAX_RECORD_BYTES } from "../src/engine/journal.js";
import {
  AuthorityLostError,
  type Clock,
  type CloudPort,
  type HarnessPort,
  type IdGenerator,
  type IncomingMessage,
  type OperatorPort,
  type OperatorReportKind,
  type ReplyCommand,
  type ReplyTarget,
} from "../src/engine/ports.js";
import { EngineRunner } from "../src/engine/runner.js";

const TEST_RUNNER_LIMITS = {
  replyRetryHorizonMs: 60_000,
  compactAfterRecords: 1_000,
  settledIdCap: 1_000,
} as const;

function privateTarget(inReplyTo: string): ReplyTarget {
  return { kind: "private", inReplyTo };
}

function threadTarget(threadRootId: string): ReplyTarget {
  return { kind: "thread", threadRootId };
}

function cloneCommand(command: ReplyCommand): ReplyCommand {
  const replyTarget: ReplyTarget =
    command.replyTarget.kind === "private"
      ? { kind: "private", inReplyTo: command.replyTarget.inReplyTo }
      : { kind: "thread", threadRootId: command.replyTarget.threadRootId };
  if ("status" in command) {
    return {
      commandId: command.commandId,
      replyTarget,
      status: command.status,
      body: command.body,
    };
  }
  return {
    commandId: command.commandId,
    replyTarget,
    body: command.body,
  };
}

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

type FailureMode = "network" | "authority";

interface EnqueueInput {
  readonly id: string;
  readonly text: string;
  readonly replyTarget?: ReplyTarget;
}

interface ServerMessage {
  readonly id: string;
  readonly text: string;
  readonly replyTarget: ReplyTarget;
  leaseId: string | null;
  leasedBySession: number | null;
  seen: boolean;
  seenLeaseId: string | null;
}

interface CloudConnectionOptions {
  readonly failClaim?: readonly FailureMode[];
  readonly failMarkSeen?: readonly FailureMode[];
  readonly failPostReply?: readonly FailureMode[];
  readonly alwaysFailClaim?: FailureMode;
  readonly alwaysFailPostReply?: FailureMode;
}

interface ConnectedCloud extends CloudPort {
  readonly sessionId: number;
  readonly calls: readonly string[];
  readonly callsAfterRefusal: number;
  disconnect(): void;
  markCutOff(): void;
}

class FakeCloud {
  readonly messages: ServerMessage[] = [];
  readonly claimed: Array<{ messageId: string; leaseId: string; sessionId: number }> = [];
  readonly seen: Array<{ messageId: string; leaseId: string; sessionId: number }> = [];
  readonly replies: ReplyCommand[] = [];
  readonly replyAttempts: ReplyCommand[] = [];
  readonly idempotencyViolations: string[] = [];
  readonly protocolErrors: string[] = [];
  maxConcurrentUnackedLeases = 0;

  private sessionSeq = 1;
  private leaseSeq = 0;
  private readonly commandsById = new Map<string, ReplyCommand>();
  private readonly claimWaiters = new Set<() => void>();
  private replyWaiters: Array<{ count: number; resolve: () => void }> = [];
  private seenWaiters: Array<{ messageId: string; resolve: () => void }> = [];

  enqueue(...items: readonly EnqueueInput[]): void {
    for (const item of items) {
      this.messages.push({
        id: item.id,
        text: item.text,
        replyTarget: item.replyTarget ?? privateTarget(item.id),
        leaseId: null,
        leasedBySession: null,
        seen: false,
        seenLeaseId: null,
      });
    }
    this.wakeClaimWaiters();
  }

  enqueueNumbered(count: number, startAt = 1): void {
    const batch: EnqueueInput[] = [];
    for (let i = startAt; i < startAt + count; i += 1) {
      batch.push({ id: `m-${i}`, text: `msg-${i}`, replyTarget: privateTarget(`m-${i}`) });
    }
    this.enqueue(...batch);
  }

  newSession(): void {
    this.sessionSeq += 1;
    for (const msg of this.messages) {
      if (!msg.seen && msg.leaseId !== null) {
        msg.leaseId = null;
        msg.leasedBySession = null;
      }
    }
    this.wakeClaimWaiters();
  }

  getMessage(id: string): ServerMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  waitForReplies(count: number): Promise<void> {
    if (this.replies.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.replyWaiters.push({ count, resolve });
    });
  }

  waitForSeen(messageId: string): Promise<void> {
    if (this.seen.some((s) => s.messageId === messageId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.seenWaiters.push({ messageId, resolve });
    });
  }

  connect(options: CloudConnectionOptions = {}): ConnectedCloud {
    const sessionId = this.sessionSeq;
    let disconnected = false;
    let refused = false;
    let callsAfterRefusalCount = 0;
    const recordedCalls: string[] = [];
    const claimFailures = [...(options.failClaim ?? [])];
    const markSeenFailures = [...(options.failMarkSeen ?? [])];
    const postReplyFailures = [...(options.failPostReply ?? [])];
    const never = <T>(): Promise<T> => new Promise<T>(() => {});

    const recordCall = (op: string): void => {
      recordedCalls.push(op);
      if (refused) callsAfterRefusalCount += 1;
    };

    const nextFailure = (
      queue: FailureMode[],
      always?: FailureMode,
    ): FailureMode | undefined => (queue.length > 0 ? queue.shift() : always);

    const throwForMode = (mode: FailureMode, op: string): never => {
      if (mode === "authority") {
        refused = true;
        throw new AuthorityLostError(`Simulated authority loss on ${op}`);
      }
      throw new Error(`Simulated network error on ${op}`);
    };

    const conn: ConnectedCloud = {
      sessionId,
      get calls() {
        return recordedCalls;
      },
      get callsAfterRefusal() {
        return callsAfterRefusalCount;
      },
      disconnect: () => {
        disconnected = true;
      },
      markCutOff: () => {
        refused = true;
      },
      claim: async (signal?: AbortSignal): Promise<IncomingMessage | null> => {
        if (disconnected) return never();
        recordCall("claim");
        const mode = nextFailure(claimFailures, options.alwaysFailClaim);
        if (mode) throwForMode(mode, "claim");

        while (true) {
          if (disconnected) return never();
          if (signal?.aborted) return null;
          const next = this.messages.find((m) => !m.seen && m.leaseId === null);
          if (next) {
            this.leaseSeq += 1;
            const leaseId = `lease-${this.leaseSeq}`;
            next.leaseId = leaseId;
            next.leasedBySession = sessionId;
            const unackedLeased = this.messages.filter((m) => !m.seen && m.leaseId !== null).length;
            if (unackedLeased > this.maxConcurrentUnackedLeases) {
              this.maxConcurrentUnackedLeases = unackedLeased;
            }
            this.claimed.push({ messageId: next.id, leaseId, sessionId });
            return {
              id: next.id,
              text: next.text,
              leaseId,
              replyTarget: next.replyTarget,
            };
          }
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              this.claimWaiters.delete(onWake);
              resolve();
            };
            const onWake = () => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            this.claimWaiters.add(onWake);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
      },
      markSeen: async (messageId: string, leaseId: string): Promise<void> => {
        if (disconnected) return never();
        recordCall("markSeen");
        const mode = nextFailure(markSeenFailures);
        if (mode) throwForMode(mode, "markSeen");

        const msg = this.messages.find((m) => m.id === messageId);
        if (!msg) {
          this.protocolErrors.push(`markSeen unknown message ${messageId}`);
          throw new Error("Unknown message");
        }
        if (msg.seen) {
          this.protocolErrors.push(`markSeen already seen ${messageId}`);
          throw new Error("Message already acknowledged");
        }
        if (msg.leaseId !== leaseId || msg.leasedBySession !== sessionId) {
          this.protocolErrors.push(
            `markSeen stale lease ${leaseId} (expected ${msg.leaseId}) on session ${sessionId}`,
          );
          throw new Error("Stale lease or wrong session");
        }
        msg.seen = true;
        msg.seenLeaseId = leaseId;
        msg.leaseId = null;
        msg.leasedBySession = null;
        this.seen.push({ messageId, leaseId, sessionId });
        this.flushSeenWaiters(messageId);
      },
      postReply: async (command: ReplyCommand): Promise<void> => {
        if (disconnected) return never();
        recordCall("postReply");

        if (command.replyTarget.kind === "thread" && ("status" in command || command.status !== undefined)) {
          this.protocolErrors.push(`Thread reply carried status for ${command.commandId}`);
          throw new Error("Status is not allowed on thread replies");
        }
        if (
          command.replyTarget.kind === "private" &&
          command.status !== "answered" &&
          command.status !== "failed"
        ) {
          this.protocolErrors.push(`Private reply missing valid status for ${command.commandId}`);
          throw new Error("Private reply requires valid status");
        }

        const copy = cloneCommand(command);
        this.replyAttempts.push(copy);

        const mode = nextFailure(postReplyFailures, options.alwaysFailPostReply);
        if (mode) throwForMode(mode, "postReply");

        const existing = this.commandsById.get(copy.commandId);
        if (existing) {
          if (!isDeepStrictEqual(existing, copy)) {
            this.idempotencyViolations.push(`Command ${copy.commandId} retried with different content`);
            throw new Error("Idempotency conflict");
          }
          return;
        }
        this.commandsById.set(copy.commandId, copy);
        this.replies.push(copy);
        this.flushReplyWaiters();
      },
    };
    return conn;
  }

  private wakeClaimWaiters(): void {
    for (const wake of [...this.claimWaiters]) {
      this.claimWaiters.delete(wake);
      wake();
    }
  }

  private flushReplyWaiters(): void {
    const remaining: Array<{ count: number; resolve: () => void }> = [];
    for (const waiter of this.replyWaiters) {
      if (this.replies.length >= waiter.count) waiter.resolve();
      else remaining.push(waiter);
    }
    this.replyWaiters = remaining;
  }

  private flushSeenWaiters(messageId: string): void {
    const remaining: Array<{ messageId: string; resolve: () => void }> = [];
    for (const waiter of this.seenWaiters) {
      if (waiter.messageId === messageId) waiter.resolve();
      else remaining.push(waiter);
    }
    this.seenWaiters = remaining;
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
  closed = 0;

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

  close(): void {
    this.closed += 1;
  }

  waitForTurn(index: number): Promise<PendingTurn> {
    if (this.turns.length > index) return Promise.resolve(this.turns[index]);
    return new Promise<PendingTurn>((resolve) => {
      this.turnWaiters.push({ index, resolve });
    });
  }
}

async function makeTempDir(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "engine-core-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("1. 100 messages: each run once, replied once, in order; at most one unacked lease at any time", async (t) => {
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
  assert.deepEqual(await runner.stop(), { reason: "stopped" });

  assert.equal(cloud.maxConcurrentUnackedLeases, 1);
  assert.equal(cloud.idempotencyViolations.length, 0);
  assert.equal(cloud.protocolErrors.length, 0);
  assert.equal(harness.started.length, 100);
  assert.equal(cloud.seen.length, 100);
  assert.equal(cloud.replies.length, 100);
  for (let i = 1; i <= 100; i += 1) {
    assert.equal(harness.started[i - 1], `msg-${i}`);
    assert.equal(cloud.seen[i - 1].messageId, `m-${i}`);
    assert.deepEqual(cloud.replies[i - 1].replyTarget, privateTarget(`m-${i}`));
    assert.equal(cloud.replies[i - 1].status, "answered");
    assert.equal(cloud.replies[i - 1].body, `reply:msg-${i}`);
  }
});

test("2. crash after accepted before turn starts: forgotten locally, newSession redelivers and runs once", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue({ id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") });

  let clockCalls = 0;
  const cloud1 = cloud.connect();
  const crashingClock: Clock = {
    now() {
      clockCalls += 1;
      // Call 1: recover(), Call 2: acceptMessage(), Call 3: decideNext() -> simulate crash before turn_started.
      if (clockCalls === 3) {
        cloud1.disconnect();
        throw new Error("Simulated crash before turn_started");
      }
      return 1_000 + clockCalls;
    },
  };
  const harness1 = new FakeHarness({ autoReply: true });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness1,
    cloud: cloud1,
    clock: crashingClock,
  });
  await runner1.start();
  await runner1.done;

  // Verify m-1 was accepted but never started, and its first lease is still unacknowledged.
  assert.deepEqual(harness1.started, []);
  const midJournal = await Journal.open(journalPath);
  assert.deepEqual(
    midJournal.records.map((r) => r.type),
    ["message_accepted"],
  );
  await midJournal.close();
  assert.equal(cloud.getMessage("m-1")?.seen, false);
  const firstLease = cloud.getMessage("m-1")?.leaseId;
  assert.ok(firstLease);

  cloud.newSession();
  const harness2 = new FakeHarness({ autoReply: true });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await cloud.waitForReplies(1);
  assert.deepEqual(await runner2.stop(), { reason: "stopped" });

  const afterJournal = await Journal.open(journalPath);
  assert.ok(
    afterJournal.records.some((r) => r.type === "message_released" && r.messageId === "m-1"),
    "expected message_released record on recovery",
  );
  await afterJournal.close();

  assert.deepEqual(harness2.started, ["msg-1"]);
  assert.equal(cloud.replies.length, 1);
  assert.equal(cloud.replies[0].body, "reply:msg-1");
  assert.equal(cloud.replies[0].status, "answered");
  assert.equal(cloud.getMessage("m-1")?.seen, true);
  assert.notEqual(cloud.getMessage("m-1")?.seenLeaseId, firstLease);
  assert.equal(cloud.protocolErrors.length, 0);
});

test("3. crash mid-turn after seen landed: not replayed, one restart reply across two restarts, next runs", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue({ id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") });

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
  assert.equal(cloud.getMessage("m-1")?.seen, true);
  cloud1.disconnect();
  // Abandon runner1 without calling stop().

  cloud.newSession();
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

  cloud.newSession();
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

  cloud.newSession();
  const harness4 = new FakeHarness({ autoReply: true });
  const runner4 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness4,
    cloud: cloud.connect(),
    clock: makeClock(4_000),
  });
  await runner4.start();
  cloud.enqueue({ id: "m-2", text: "msg-2", replyTarget: privateTarget("m-2") });
  await cloud.waitForReplies(2);
  await runner4.stop();

  assert.deepEqual(harness1.started, ["msg-1"]);
  assert.deepEqual(harness2.started, []);
  assert.deepEqual(harness3.started, []);
  assert.deepEqual(harness4.started, ["msg-2"]);
  assert.equal(cloud.replies.length, 2);
  assert.deepEqual(cloud.replies[0].replyTarget, privateTarget("m-1"));
  assert.equal(cloud.replies[0].status, "failed");
  assert.equal(cloud.replies[0].body, RESTART_INTERRUPTED_REPLY);
  assert.deepEqual(cloud.replies[1].replyTarget, privateTarget("m-2"));
  assert.equal(cloud.replies[1].status, "answered");
  assert.equal(cloud.replies[1].body, "reply:msg-2");
  assert.equal(cloud.protocolErrors.length, 0);
});

test("4. crash mid-turn when seen did NOT land: redelivered under new lease, acked without running, one restart reply", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue({ id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") });

  const cloud1 = cloud.connect({ failMarkSeen: ["network"] });
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
  // Turn ran even though markSeen failed transiently; seen stays unconfirmed.
  assert.equal(cloud.getMessage("m-1")?.seen, false);
  const firstLease = cloud.getMessage("m-1")?.leaseId;
  assert.ok(firstLease);
  cloud1.disconnect();
  // Abandon runner1 without calling stop().

  cloud.newSession();
  const harness2 = new FakeHarness({ autoReply: true });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await cloud.waitForSeen("m-1");
  cloud.enqueue({ id: "m-2", text: "msg-2", replyTarget: privateTarget("m-2") });
  await cloud.waitForReplies(2);
  assert.deepEqual(await runner2.stop(), { reason: "stopped" });

  assert.deepEqual(harness1.started, ["msg-1"]);
  assert.deepEqual(harness2.started, ["msg-2"]);
  assert.equal(cloud.getMessage("m-1")?.seen, true);
  assert.notEqual(cloud.getMessage("m-1")?.seenLeaseId, firstLease);
  assert.equal(cloud.replies.length, 2);
  assert.deepEqual(cloud.replies[0].replyTarget, privateTarget("m-1"));
  assert.equal(cloud.replies[0].status, "failed");
  assert.equal(cloud.replies[0].body, RESTART_INTERRUPTED_REPLY);
  assert.deepEqual(cloud.replies[1].replyTarget, privateTarget("m-2"));
  assert.equal(cloud.replies[1].status, "answered");
  assert.equal(cloud.replies[1].body, "reply:msg-2");
  assert.equal(cloud.protocolErrors.length, 0);
});

test("5. reply post retries send identical command object in-process and after restart; private carries status, thread does not", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();

  // In-process retry for private reply (status: "answered").
  cloud.enqueue({ id: "m-priv-1", text: "priv-1", replyTarget: privateTarget("m-priv-1") });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ failPostReply: ["network"] }),
    clock: makeClock(1_000),
    generateId: makeIdGen("r1"),
  });
  await runner1.start();
  await cloud.waitForReplies(1);
  await runner1.stop();

  const priv1Attempts = cloud.replyAttempts.filter((a) => a.commandId === "r1-1");
  assert.equal(priv1Attempts.length, 2);
  assert.deepEqual(priv1Attempts[0], {
    commandId: "r1-1",
    replyTarget: { kind: "private", inReplyTo: "m-priv-1" },
    status: "answered",
    body: "reply:priv-1",
  });
  assert.deepEqual(priv1Attempts[1], priv1Attempts[0]);

  // Restart retry for thread reply (no status property at all).
  cloud.newSession();
  cloud.enqueue({ id: "m-thread-1", text: "thread-1", replyTarget: threadTarget("root-42") });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ alwaysFailPostReply: "network" }),
    clock: makeClock(2_000),
    generateId: makeIdGen("r2"),
  });
  await runner2.start();
  assert.deepEqual(await runner2.done, { reason: "cloud_failed" });

  cloud.newSession();
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

  const threadAttempts = cloud.replyAttempts.filter((a) => a.commandId === "r2-1");
  assert.equal(threadAttempts.length, 3);
  for (const attempt of threadAttempts) {
    assert.equal("status" in attempt, false);
    assert.deepEqual(attempt, {
      commandId: "r2-1",
      replyTarget: { kind: "thread", threadRootId: "root-42" },
      body: "reply:thread-1",
    });
  }

  // Interrupted thread turn also omits status and keeps identical commandId across restarts.
  cloud.newSession();
  cloud.enqueue({ id: "m-thread-2", text: "thread-2", replyTarget: threadTarget("root-99") });
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

  cloud.newSession();
  const runner5 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ alwaysFailPostReply: "network" }),
    clock: makeClock(5_000),
    generateId: makeIdGen("r5"),
  });
  await runner5.start();
  assert.deepEqual(await runner5.done, { reason: "cloud_failed" });

  cloud.newSession();
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

  const interruptedAttempts = cloud.replyAttempts.filter((a) => a.commandId === "r5-1");
  assert.equal(interruptedAttempts.length, 3);
  for (const attempt of interruptedAttempts) {
    assert.equal("status" in attempt, false);
    assert.deepEqual(attempt, {
      commandId: "r5-1",
      replyTarget: { kind: "thread", threadRootId: "root-99" },
      body: RESTART_INTERRUPTED_REPLY,
    });
  }

  assert.equal(cloud.idempotencyViolations.length, 0);
  assert.equal(cloud.protocolErrors.length, 0);
});

test("6. owed reply past the horizon is not sent; operator is told once", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const operator = new FakeOperator();
  cloud.enqueue({ id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") });

  const runner1 = new EngineRunner({
    journalPath,
    harness: new FakeHarness({ autoReply: true }),
    cloud: cloud.connect({ alwaysFailPostReply: "network" }),
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

  cloud.newSession();
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
  const reportsAfter2 = operator.events.filter((e) => e.kind === "unknown_reply_outcome");
  assert.equal(reportsAfter2.length, 1);
  assert.equal(reportsAfter2[0].detail.messageId, "m-1");
  assert.equal(reportsAfter2[0].detail.commandId, "cmd-1");

  cloud.newSession();
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
  assert.equal(
    operator.events.filter((e) => e.kind === "unknown_reply_outcome").length,
    1,
  );
});

test("7. harness error with path and token reaches no reply and no journal; operator gets truncated copy", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const operator = new FakeOperator();
  const harness = new FakeHarness({ autoReply: false });
  cloud.enqueue({ id: "m-1", text: "trigger-error", replyTarget: privateTarget("m-1") });

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

  assert.equal(cloud.replies.length, 1);
  assert.deepEqual(cloud.replies[0].replyTarget, privateTarget("m-1"));
  assert.equal(cloud.replies[0].status, "failed");
  assert.equal(cloud.replies[0].body, TURN_FAILED_REPLY);

  const rawJournal = await readFile(journalPath, "utf8");
  assert.equal(rawJournal.includes(secretPath), false);
  assert.equal(rawJournal.includes(secretToken), false);
  assert.equal(cloud.replies[0].body.includes(secretPath), false);
  assert.equal(cloud.replies[0].body.includes(secretToken), false);

  const failReports = operator.events.filter((e) => e.kind === "turn_failed");
  assert.equal(failReports.length, 1);
  assert.equal(failReports[0].detail.messageId, "m-1");
  assert.equal(failReports[0].detail.error, longError.slice(0, 500));
});

test("8. over-long message gets one failed reply, is acknowledged seen, and does not block the next", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const harness = new FakeHarness({ autoReply: true });
  const oversizedText = "x".repeat(MAX_MESSAGE_TEXT_BYTES + 1);

  cloud.enqueue(
    { id: "big-priv", text: oversizedText, replyTarget: privateTarget("big-priv") },
    { id: "big-thread", text: oversizedText, replyTarget: threadTarget("root-big") },
    { id: "m-2", text: "normal-msg", replyTarget: privateTarget("m-2") },
  );

  const runner = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness,
    cloud: cloud.connect(),
    clock: makeClock(1_000),
  });
  await runner.start();
  await cloud.waitForReplies(3);
  await runner.stop();

  assert.deepEqual(harness.started, ["normal-msg"]);
  assert.equal(cloud.getMessage("big-priv")?.seen, true);
  assert.equal(cloud.getMessage("big-thread")?.seen, true);
  assert.equal(cloud.getMessage("m-2")?.seen, true);

  assert.equal(cloud.replies.length, 3);
  assert.deepEqual(cloud.replies[0].replyTarget, privateTarget("big-priv"));
  assert.equal(cloud.replies[0].status, "failed");
  assert.equal(cloud.replies[0].body, MESSAGE_TOO_LONG_REPLY);

  assert.deepEqual(cloud.replies[1].replyTarget, threadTarget("root-big"));
  assert.equal("status" in cloud.replies[1], false);
  assert.equal(cloud.replies[1].body, MESSAGE_TOO_LONG_REPLY);

  assert.deepEqual(cloud.replies[2].replyTarget, privateTarget("m-2"));
  assert.equal(cloud.replies[2].status, "answered");
  assert.equal(cloud.replies[2].body, "reply:normal-msg");

  // Single record line over MAX_RECORD_BYTES is refused at journal append.
  const oversizedJournal = await Journal.open(join(dir, "oversized.ndjson"));
  await assert.rejects(
    () =>
      oversizedJournal.append({
        type: "turn_finished",
        messageId: "m-big",
        outcome: "replied",
        command: {
          commandId: "cmd-big",
          replyTarget: privateTarget("m-big"),
          status: "answered",
          body: "y".repeat(MAX_RECORD_BYTES),
        },
        at: 2_000,
      }),
    /maximum size/i,
  );
  await oversizedJournal.close();
  assert.equal(cloud.protocolErrors.length, 0);
});

test("9. lost authority on claim, markSeen, and postReply stops at once with zero further cloud calls; restart recovers cleanly", async (t) => {
  // 9a. AuthorityLostError on claim
  {
    const dir = await makeTempDir(t);
    const journalPath = join(dir, "journal.ndjson");
    const cloud = new FakeCloud();
    cloud.enqueue({ id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") });

    const conn1 = cloud.connect({ failClaim: ["authority"] });
    const harness1 = new FakeHarness({ autoReply: true });
    const runner1 = new EngineRunner({
      ...TEST_RUNNER_LIMITS,
      journalPath,
      harness: harness1,
      cloud: conn1,
      clock: makeClock(1_000),
    });
    await runner1.start();
    assert.deepEqual(await runner1.done, { reason: "authority_lost" });
    assert.equal(harness1.interrupted, 1);
    assert.equal(harness1.closed, 1);
    assert.equal(conn1.callsAfterRefusal, 0);
    assert.deepEqual(harness1.started, []);

    cloud.newSession();
    const harness2 = new FakeHarness({ autoReply: true });
    const runner2 = new EngineRunner({
      ...TEST_RUNNER_LIMITS,
      journalPath,
      harness: harness2,
      cloud: cloud.connect(),
      clock: makeClock(2_000),
    });
    await runner2.start();
    await cloud.waitForReplies(1);
    await runner2.stop();

    assert.deepEqual(harness2.started, ["msg-1"]);
    assert.equal(cloud.replies.length, 1);
    assert.equal(cloud.replies[0].body, "reply:msg-1");
    assert.equal(cloud.protocolErrors.length, 0);
  }

  // 9b. AuthorityLostError on markSeen (turn_started was journaled before markSeen)
  {
    const dir = await makeTempDir(t);
    const journalPath = join(dir, "journal.ndjson");
    const cloud = new FakeCloud();
    cloud.enqueue(
      { id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") },
      { id: "m-2", text: "msg-2", replyTarget: privateTarget("m-2") },
    );

    const conn1 = cloud.connect({ failMarkSeen: ["authority"] });
    const harness1 = new FakeHarness({ autoReply: true });
    const runner1 = new EngineRunner({
      ...TEST_RUNNER_LIMITS,
      journalPath,
      harness: harness1,
      cloud: conn1,
      clock: makeClock(1_000),
    });
    await runner1.start();
    assert.deepEqual(await runner1.done, { reason: "authority_lost" });
    assert.equal(harness1.interrupted, 1);
    assert.equal(harness1.closed, 1);
    assert.equal(conn1.callsAfterRefusal, 0);
    assert.deepEqual(harness1.started, []);
    assert.equal(cloud.getMessage("m-1")?.seen, false);

    cloud.newSession();
    const harness2 = new FakeHarness({ autoReply: true });
    const runner2 = new EngineRunner({
      ...TEST_RUNNER_LIMITS,
      journalPath,
      harness: harness2,
      cloud: cloud.connect(),
      clock: makeClock(2_000),
    });
    await runner2.start();
    await cloud.waitForSeen("m-1");
    await cloud.waitForReplies(2);
    await runner2.stop();

    assert.deepEqual(harness2.started, ["msg-2"]);
    assert.equal(cloud.getMessage("m-1")?.seen, true);
    assert.equal(cloud.replies.length, 2);
    assert.equal(cloud.replies[0].body, RESTART_INTERRUPTED_REPLY);
    assert.equal(cloud.replies[0].status, "failed");
    assert.equal(cloud.replies[1].body, "reply:msg-2");
    assert.equal(cloud.replies[1].status, "answered");
    assert.equal(cloud.protocolErrors.length, 0);
  }

  // 9c. AuthorityLostError on postReply (no retry, zero calls after refusal; restart posts same reply once)
  {
    const dir = await makeTempDir(t);
    const journalPath = join(dir, "journal.ndjson");
    const cloud = new FakeCloud();
    cloud.enqueue({ id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") });

    const conn1 = cloud.connect({ failPostReply: ["authority"] });
    const harness1 = new FakeHarness({ autoReply: true });
    const runner1 = new EngineRunner({
      ...TEST_RUNNER_LIMITS,
      journalPath,
      harness: harness1,
      cloud: conn1,
      clock: makeClock(1_000),
      generateId: makeIdGen("auth"),
    });
    await runner1.start();
    assert.deepEqual(await runner1.done, { reason: "authority_lost" });
    assert.equal(harness1.interrupted, 1);
    assert.equal(harness1.closed, 1);
    assert.equal(conn1.callsAfterRefusal, 0);
    assert.deepEqual(harness1.started, ["msg-1"]);
    assert.equal(cloud.replies.length, 0);

    cloud.newSession();
    const harness2 = new FakeHarness({ autoReply: true });
    const runner2 = new EngineRunner({
      ...TEST_RUNNER_LIMITS,
      journalPath,
      harness: harness2,
      cloud: cloud.connect(),
      clock: makeClock(2_000),
      generateId: makeIdGen("after"),
    });
    await runner2.start();
    await cloud.waitForReplies(1);
    await runner2.stop();

    assert.deepEqual(harness2.started, []);
    assert.equal(cloud.replies.length, 1);
    assert.equal(cloud.replies[0].commandId, "auth-1");
    assert.equal(cloud.replies[0].body, "reply:msg-1");
    assert.equal(cloud.replies[0].status, "answered");
    assert.equal(cloud.idempotencyViolations.length, 0);
    assert.equal(cloud.protocolErrors.length, 0);
  }
});

test("10. loseAuthority() during a running turn interrupts, closes, makes zero further cloud calls, and recovers interrupted once", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue(
    { id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") },
    { id: "m-2", text: "msg-2", replyTarget: privateTarget("m-2") },
  );

  const conn1 = cloud.connect();
  const harness1 = new FakeHarness({ autoReply: false });
  const runner1 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness1,
    cloud: conn1,
    clock: makeClock(1_000),
  });
  await runner1.start();
  await harness1.waitForTurn(0);

  conn1.markCutOff();
  runner1.loseAuthority();
  assert.deepEqual(await runner1.done, { reason: "authority_lost" });
  assert.equal(harness1.interrupted, 1);
  assert.equal(harness1.closed, 1);
  assert.equal(conn1.callsAfterRefusal, 0);
  assert.equal(cloud.replies.length, 0);

  cloud.newSession();
  const harness2 = new FakeHarness({ autoReply: true });
  const runner2 = new EngineRunner({
    ...TEST_RUNNER_LIMITS,
    journalPath,
    harness: harness2,
    cloud: cloud.connect(),
    clock: makeClock(2_000),
  });
  await runner2.start();
  await cloud.waitForReplies(2);
  await runner2.stop();

  assert.deepEqual(harness1.started, ["msg-1"]);
  assert.deepEqual(harness2.started, ["msg-2"]);
  assert.equal(cloud.replies.length, 2);
  assert.equal(cloud.replies[0].body, RESTART_INTERRUPTED_REPLY);
  assert.equal(cloud.replies[0].status, "failed");
  assert.equal(cloud.replies[1].body, "reply:msg-2");
  assert.equal(cloud.replies[1].status, "answered");
  assert.equal(cloud.protocolErrors.length, 0);
});

test("11. graceful stop() during a turn lets it finish and post its reply; reason is stopped", async (t) => {
  const dir = await makeTempDir(t);
  const journalPath = join(dir, "journal.ndjson");
  const cloud = new FakeCloud();
  const operator = new FakeOperator();
  cloud.enqueue(
    { id: "m-1", text: "msg-1", replyTarget: privateTarget("m-1") },
    { id: "m-2", text: "msg-2", replyTarget: privateTarget("m-2") },
  );

  const harness = new FakeHarness({ autoReply: false });
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

  const stopPromise = runner.stop();
  assert.equal(harness.interrupted, 0);

  turn.resolve("finished-cleanly");
  const result = await stopPromise;
  assert.deepEqual(result, { reason: "stopped" });
  assert.deepEqual(await runner.done, { reason: "stopped" });
  assert.equal(harness.interrupted, 0);
  assert.equal(harness.closed, 1);
  assert.deepEqual(harness.started, ["msg-1"]);
  assert.equal(cloud.replies.length, 1);
  assert.equal(cloud.replies[0].body, "finished-cleanly");
  assert.equal(cloud.replies[0].status, "answered");
  assert.equal(cloud.getMessage("m-2")?.seen, false);
  assert.deepEqual(
    operator.events.filter((e) => e.kind === "runner_stopped"),
    [{ kind: "runner_stopped", detail: { reason: "stopped" } }],
  );
});

test("12. compaction drops settled text, still acks redelivered settled messages without running, and preserves active interruption", async (t) => {
  const dir = await makeTempDir(t);
  const journalDir = join(dir, "state");
  const journalPath = join(journalDir, "journal.ndjson");
  const cloud = new FakeCloud();
  cloud.enqueue(
    { id: "m-1", text: "secret-payload-one", replyTarget: privateTarget("m-1") },
    { id: "m-2", text: "secret-payload-two", replyTarget: privateTarget("m-2") },
    { id: "m-3", text: "secret-payload-three", replyTarget: privateTarget("m-3") },
  );

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

  cloud.newSession();
  cloud.enqueue({ id: "m-4", text: "secret-payload-four", replyTarget: privateTarget("m-4") });
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

  // Redeliver settled m-4 (simulate server having lost its seen flag) alongside new m-5.
  const m4 = cloud.getMessage("m-4");
  assert.ok(m4);
  m4.seen = false;
  m4.leaseId = null;
  m4.leasedBySession = null;
  cloud.newSession();
  cloud.enqueue({ id: "m-5", text: "in-flight-turn", replyTarget: threadTarget("root-5") });

  const conn2 = cloud.connect();
  const harness2 = new FakeHarness({ autoReply: false });
  const runner2 = new EngineRunner({
    journalPath,
    harness: harness2,
    cloud: conn2,
    clock: makeClock(2_000),
    replyRetryHorizonMs: 60_000,
    compactAfterRecords: 1_000,
    settledIdCap: 3,
  });
  await runner2.start();
  await harness2.waitForTurn(0);
  conn2.disconnect();

  assert.equal(m4.seen, true);
  assert.deepEqual(harness2.started, ["in-flight-turn"]);

  // Compact while m-5 is active (started, never finished).
  const journal = await Journal.open(journalPath);
  const activeState = reduceAll(journal.records, { settledIdCap: 3 });
  await journal.compact(compacted(activeState));
  await journal.close();

  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(journalDir), ["journal.ndjson"]);
  const compactedActiveText = await readFile(journalPath, "utf8");
  assert.equal(compactedActiveText.includes("in-flight-turn"), false);

  cloud.newSession();
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
  assert.deepEqual(cloud.replies[4].replyTarget, threadTarget("root-5"));
  assert.equal("status" in cloud.replies[4], false);
  assert.equal(cloud.replies[4].body, RESTART_INTERRUPTED_REPLY);
  assert.equal(cloud.protocolErrors.length, 0);
});

test("13. journal safety: torn last line ignored, corrupt middle refused, symlink refused, 0600 file and 0700 folder permissions", async (t) => {
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
    leaseId: "lease-1",
    replyTarget: privateTarget("m-1"),
    at: 100,
  });
  await journal1.append({
    type: "turn_started",
    messageId: "m-1",
    replyTarget: privateTarget("m-1"),
    at: 101,
  });
  await journal1.close();

  await appendFile(journalPath, '{"type":"turn_finished","messageId":"m-1"', "utf8");

  const journal2 = await Journal.open(journalPath);
  assert.deepEqual(journal2.records, [
    {
      type: "message_accepted",
      messageId: "m-1",
      text: "hello",
      leaseId: "lease-1",
      replyTarget: privateTarget("m-1"),
      at: 100,
    },
    {
      type: "turn_started",
      messageId: "m-1",
      replyTarget: privateTarget("m-1"),
      at: 101,
    },
  ]);

  await journal2.append({
    type: "turn_finished",
    messageId: "m-1",
    outcome: "replied",
    command: {
      commandId: "cmd-1",
      replyTarget: privateTarget("m-1"),
      status: "answered",
      body: "ok",
    },
    at: 102,
  });
  await journal2.close();

  const journal3 = await Journal.open(journalPath);
  assert.equal(journal3.records.length, 3);
  await journal3.close();

  // Corrupt middle record is refused, never skipped.
  const corruptPath = join(journalDir, "corrupt.ndjson");
  await writeFile(
    corruptPath,
    `${JSON.stringify({ type: "message_settled", messageId: "m-1", at: 1 })}\n{"bad":true}\n${JSON.stringify({ type: "message_settled", messageId: "m-2", at: 2 })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(() => Journal.open(corruptPath), /corrupt record/i);

  // Symlink refused without leaking local paths.
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

  // Existing folder with group or other permissions refused without leaking local paths.
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
