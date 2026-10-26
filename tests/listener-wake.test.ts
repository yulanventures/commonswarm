/**
 * Fake-socket and parser controls for listener push delivery (L4).
 * Named in the npm test list.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import {
  type DeliveryClaimResult,
  type DeliveryRow,
} from "../src/cloud/delivery.js";
import {
  IDLE_POLL_DEFAULT_MS,
} from "../src/cloud/idle-poll.js";
import type { SignalRecord } from "../src/cloud/command-client.js";
import type { AgentSignalPage } from "../src/cloud/signals.js";
import {
  WAKE_EVENT,
  WAKE_TOPIC_PREFIX,
} from "../src/cloud/wake.js";
import { writeSecureJsonFile } from "../src/cloud/storage.js";
import {
  claimCommandId,
  emptyListenerWakeStatus,
  LISTENER_WAKE_MODE_POLL,
  listenerPaths,
  listenerWakeStatusSentence,
  parseListenerWake,
  readListenerStatus,
  REALTIME_SUBSCRIBE_STATUS,
  runListenerRuntime as runListenerRuntimeActual,
  WAKE_CLAIMS_PER_MINUTE_BUDGET,
  WAKE_ERROR_CODE_WAKE_BUDGET,
  writeListenerStatus,
  createWakeSubscriber,
  type ListenerActiveClaim,
  type ListenerDeliveryJournalRecord,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerPromptMode,
  type ListenerRuntimeModel,
  type ListenerStatus,
  type ListenerWakeStatus,
  type WakeRealtimeChannel,
  type WakeRealtimeClient,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

async function runListenerRuntime(
  options: Parameters<typeof runListenerRuntimeActual>[0],
): ReturnType<typeof runListenerRuntimeActual> {
  return await runListenerRuntimeActual({
    pendingMainQueue: {
      async enqueue() {
        return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
      },
    },
    ...options,
  });
}
const WAKE_TOPIC = `${WAKE_TOPIC_PREFIX}${"A".repeat(43)}`;
const WAKE_TOPIC_B = `${WAKE_TOPIC_PREFIX}${"B".repeat(43)}`;

class FakeChannel implements WakeRealtimeChannel {
  statusCb: ((status: string, err?: Error) => void) | null = null;
  wakeCb: ((message: { payload?: unknown }) => void) | null = null;
  autoSubscribe = false;
  holdUnsubscribe = false;
  private unsubResolve: (() => void) | null = null;
  constructor(readonly topic: string) {}
  on(
    _type: "broadcast",
    _filter: { event: string },
    callback: (message: { payload?: unknown }) => void,
  ): WakeRealtimeChannel {
    this.wakeCb = callback;
    return this;
  }
  subscribe(callback: (status: string, err?: Error) => void): WakeRealtimeChannel {
    this.statusCb = callback;
    if (this.autoSubscribe) callback(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
    return this;
  }
  unsubscribe(): void | Promise<void> {
    if (!this.holdUnsubscribe) return;
    return new Promise((resolve) => {
      this.unsubResolve = resolve;
    });
  }
  releaseUnsubscribe(): void {
    this.unsubResolve?.();
    this.unsubResolve = null;
  }
  emitStatus(status: string, err?: Error): void {
    this.statusCb?.(status, err);
  }
  emitWake(): void {
    this.wakeCb?.({ payload: { v: 1 } });
  }
}

class FakeRealtime implements WakeRealtimeClient {
  channelInstance: FakeChannel | null = null;
  channels: FakeChannel[] = [];
  authed: string | null = null;
  autoSubscribe = false;
  setAuth(token: string): void {
    this.authed = token;
  }
  channel(topic: string): FakeChannel {
    const channel = new FakeChannel(topic);
    channel.autoSubscribe = this.autoSubscribe;
    this.channelInstance = channel;
    this.channels.push(channel);
    return channel;
  }
  removeChannel(): void {}
  disconnect(): void {}
}

function durablePage(wake = true): AgentSignalPage {
  return {
    signals: [],
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    legacyCursorFallback: false,
    rawCount: 0,
    nextCursor: null,
    malformedRows: 0,
    pendingDeliveryCount: 0,
    ...(wake ? { wake: { topic: WAKE_TOPIC, event: WAKE_EVENT } } : {}),
  };
}

function claimResult(deliveries: DeliveryRow[] = []): DeliveryClaimResult {
  return {
    httpStatus: 200,
    capabilities: {
      deliveryClaim: true,
      deliveryAck: true,
      senderOwnerRelation: true,
    },
    deliveries,
    pendingDeliveryCount: deliveries.length,
    terminalDeliveryFailureCount: 0,
    wake: { topic: WAKE_TOPIC, event: WAKE_EVENT },
  };
}

class MemoryStore implements ListenerEffectStore {
  readonly records = new Map<string, ListenerEffectRecord>();
  async read(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async write(record: ListenerEffectRecord) {
    this.records.set(record.signalId, structuredClone(record));
  }
}

class FakeModel implements ListenerRuntimeModel {
  async start() {}
  async prompt(_signal: SignalRecord, _mode: ListenerPromptMode, _prompt: string) {
    return { message: "ok", stopReason: "end_turn" as const };
  }
  cancel() {}
  async close() {}
}

class MemoryJournal {
  record: ListenerDeliveryJournalRecord;
  constructor() {
    this.record = {
      version: 1,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: "44444444-4444-4444-8444-444444444444",
      nextClaimOrdinal: 0,
      active: null,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
  }
  async read() {
    return structuredClone(this.record);
  }
  async reserveClaim(now = new Date().toISOString()) {
    const ordinal = this.record.nextClaimOrdinal;
    const active: ListenerActiveClaim = {
      phase: "claim_pending",
      claimOrdinal: ordinal,
      claimCommandId: claimCommandId(this.record.listenerInstanceId, ordinal),
      claimCreatedAt: now,
      claimLastAttemptAt: null,
      signalId: null,
      leaseId: null,
      leasedUntil: null,
      ack: null,
    };
    this.record.active = active;
    this.record.nextClaimOrdinal += 1;
    this.record.updatedAt = now;
    return structuredClone(active);
  }
  async recordClaimAttempt(now = new Date().toISOString()) {
    assert.ok(this.record.active);
    this.record.active.claimLastAttemptAt = now;
    this.record.updatedAt = now;
  }
  async recordLease() {
    throw new Error("lease must not run in empty-claim tests");
  }
  async prepareAck() {
    throw new Error("ack must not run in empty-claim tests");
  }
  async clearActive(now = new Date().toISOString()) {
    this.record.active = null;
    this.record.updatedAt = now;
  }
}

function statusShell(paths: ReturnType<typeof listenerPaths>): ListenerStatus {
  const ts = "2026-07-30T00:00:00.000Z";
  return {
    version: 1,
    instanceId: randomUUID(),
    provider: "grok",
    profileId: "profile-test",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    pid: process.pid,
    state: "ready",
    startedAt: ts,
    readyAt: ts,
    updatedAt: ts,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "worker",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath: paths.logPath,
  };
}

test("WakeSubscriber latches a wake while nobody awaits next()", async () => {
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  assert.equal(fake.authed, "anon");
  fake.channelInstance!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.state, "subscribed");
  assert.equal(wake.snapshot().mode, "push");
  fake.channelInstance!.emitWake();
  fake.channelInstance!.emitWake();
  const first = await wake.next({ until: Date.now() + 1_000 });
  const second = await wake.next({ until: Date.now() });
  assert.equal(first, "wake");
  assert.equal(second, "deadline");
  const snap = wake.snapshot();
  assert.equal("topic" in snap, false);
  assert.equal(JSON.stringify(snap).includes("cswarm-wake:"), false);
  await wake.close();
});

test("CHANNEL_ERROR flips snapshot to poll without reading error.message", async () => {
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  fake.channelInstance!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  const until = Date.now() + 200;
  const waiting = wake.next({ until });
  fake.channelInstance!.emitStatus(
    REALTIME_SUBSCRIBE_STATUS.CHANNEL_ERROR,
    new Error("Unauthorized: " + WAKE_TOPIC),
  );
  assert.equal(await waiting, "state");
  const snap = wake.snapshot();
  assert.equal(snap.mode, "poll");
  assert.equal(snap.errorCode, "channel_error");
  assert.equal(JSON.stringify(snap).includes("cswarm-wake:"), false);
  await wake.close();
});

test("setTopic rotation records topicRotatedAt and joins the new channel", async () => {
  const fake = new FakeRealtime();
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  fake.channels[0]!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.snapshot().topicRotatedAt, null);
  wake.setTopic(WAKE_TOPIC_B);
  assert.equal(fake.channels.length, 2);
  assert.equal(fake.channels[1]!.topic, WAKE_TOPIC_B);
  fake.channels[1]!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  const snap = wake.snapshot();
  assert.equal(snap.mode, "push");
  assert.equal(snap.topicRotatedAt, new Date(nowMs).toISOString());
  assert.equal(JSON.stringify(snap).includes("cswarm-wake:"), false);
  await wake.close();
});

test("setTopic does not clobber a live subscribe when the old unsubscribe settles late", async () => {
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  const channelA = fake.channels[0]!;
  channelA.holdUnsubscribe = true;
  channelA.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.snapshot().mode, "push");
  wake.setTopic(WAKE_TOPIC_B);
  const channelB = fake.channels[1]!;
  channelB.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.state, "subscribed");
  assert.equal(wake.snapshot().mode, "push");
  channelA.releaseUnsubscribe();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(wake.state, "subscribed");
  assert.equal(wake.snapshot().mode, "push");
  assert.ok(wake.snapshot().topicRotatedAt);
  await wake.close();
});

test("wake claim budget is 50 per clock minute", () => {
  const fake = new FakeRealtime();
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  for (let i = 0; i < WAKE_CLAIMS_PER_MINUTE_BUDGET; i++) {
    assert.equal(wake.overWakeBudget(nowMs), false);
    wake.noteWakeClaim(nowMs);
  }
  assert.equal(wake.overWakeBudget(nowMs), true);
  assert.equal(WAKE_CLAIMS_PER_MINUTE_BUDGET, 50);
});

test("over-budget next() keeps the latch and snapshot is poll until the minute clears", async () => {
  let nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const fake = new FakeRealtime();
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  wake.setTopic(WAKE_TOPIC);
  fake.channelInstance!.emitStatus(REALTIME_SUBSCRIBE_STATUS.SUBSCRIBED);
  assert.equal(wake.snapshot().mode, "push");
  for (let i = 0; i < WAKE_CLAIMS_PER_MINUTE_BUDGET; i++) {
    wake.noteWakeClaim(nowMs);
  }
  const snap = wake.snapshot();
  assert.equal(snap.mode, "poll");
  assert.equal(snap.rateLimited, true);
  assert.equal(snap.errorCode, WAKE_ERROR_CODE_WAKE_BUDGET);
  assert.ok(snap.subscribedAt);
  const budgetLine = listenerWakeStatusSentence(snap, IDLE_POLL_DEFAULT_MS, null);
  assert.match(budgetLine, new RegExp(WAKE_ERROR_CODE_WAKE_BUDGET));
  assert.doesNotMatch(budgetLine, /not connected/);
  assert.doesNotMatch(budgetLine, /rate_limited/);
  fake.channelInstance!.emitWake();
  fake.channelInstance!.emitWake();
  assert.equal(await wake.next({ until: nowMs }), "deadline");
  assert.equal(await wake.next({ until: nowMs }), "deadline");
  nowMs += 60_000;
  assert.equal(wake.overWakeBudget(nowMs), false);
  assert.equal(wake.snapshot().mode, "push");
  assert.equal(wake.snapshot().rateLimited, false);
  assert.equal(await wake.next({ until: nowMs }), "wake");
  await wake.close();
});

test("70 wakes in one frozen minute stay at most 51 claims with no extra reads", async () => {
  const nowMs = Date.parse("2026-07-30T00:00:10.000Z");
  const fake = new FakeRealtime();
  fake.autoSubscribe = true;
  const wake = createWakeSubscriber({
    target: cloudTarget("https://cloud.example.test", "anon"),
    now: () => nowMs,
    createRealtime: () => fake,
  });
  const journal = new MemoryJournal();
  const controller = new AbortController();
  let claims = 0;
  let reads = 0;
  const wakeSnaps: ListenerWakeStatus[] = [];
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: journal.record.listenerInstanceId,
      deliveryJournal: journal,
      deliveryClient: {
        async claimAgentInbox() {
          claims += 1;
          fake.channelInstance?.emitWake();
          if (claims === 51) {
            for (let i = 0; i < 20; i++) fake.channelInstance?.emitWake();
          }
          if (claims >= 70) controller.abort();
          return claimResult([]);
        },
        async ackAgentDelivery() {
          throw new Error("ack must not run");
        },
      },
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(),
      model: new FakeModel(),
      signal: controller.signal,
      pollMs: IDLE_POLL_DEFAULT_MS,
      now: () => nowMs,
      sleep: async () => {},
      wake,
      onEvent: (event) => {
        if (event.type === "wake") wakeSnaps.push(event.wake);
      },
      readPage: async () => {
        reads += 1;
        return durablePage();
      },
    });
    assert.equal(stop.reason, "cancelled");
  } finally {
    clearTimeout(timer);
  }
  assert.ok(claims <= 51, `claims in one frozen minute: ${claims}`);
  assert.equal(reads, 1);
  const budgeted = wakeSnaps.at(-1);
  assert.ok(budgeted);
  assert.equal(budgeted.mode, LISTENER_WAKE_MODE_POLL);
  assert.equal(budgeted.rateLimited, true);
  await wake.close();
});

test("parseListenerWake is closed and refuses topic keys", () => {
  const good: ListenerWakeStatus = emptyListenerWakeStatus();
  assert.deepEqual(parseListenerWake(good, true), good);
  assert.equal(parseListenerWake({ ...good, extra: 1 }, true), null);
  assert.equal(parseListenerWake({ ...good, topic: WAKE_TOPIC }, true), null);
  assert.equal(parseListenerWake({ ...good, wakeTopic: WAKE_TOPIC }, true), null);
  assert.equal(
    parseListenerWake({ ...good, mode: "push", subscribedAt: null }, true),
    null,
  );
});

test("a status file cannot store a topic key or a topic-shaped lastErrorDetail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-wake-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-wake",
    workspaceId: randomUUID(),
    principalId: randomUUID(),
    stateDirectory: root,
  });
  const base = statusShell(paths);
  await writeListenerStatus(paths, { ...base, wake: emptyListenerWakeStatus() });
  await assert.rejects(
    writeListenerStatus(paths, { ...base, topic: WAKE_TOPIC } as unknown as ListenerStatus),
    /forbidden/,
  );
  const raw = JSON.parse(await readFile(paths.statusPath, "utf8")) as Record<string, unknown>;
  raw.lastErrorDetail = `Unauthorized: ${WAKE_TOPIC}`;
  await writeSecureJsonFile(paths.statusPath, JSON.stringify(raw));
  await assert.rejects(readListenerStatus(paths), /malformed/);
});
