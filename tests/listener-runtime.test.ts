import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecureJsonFile } from "../src/cloud/storage.js";
import test from "node:test";
import ts from "typescript";
import {
  CommandHttpError,
  SIGNAL_REQUEST_TIMEOUT_MS,
  type SignalRecord,
} from "../src/cloud/command-client.js";
import { cloudTarget } from "../src/cloud/config.js";
import {
  DeliveryHttpError,
  DeliveryProtocolError,
  DeliveryTransportError,
  DELIVERY_REQUEST_TIMEOUT_MS,
  H0_SEAT_CLAIM_REFUSED_CODE,
  H0_SEAT_LISTENER_STOP_SENTENCE,
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_SESSION_PROOF_CODES,
  type DeliveryClaimResult,
  type DeliveryOutcome,
  type DeliveryRow,
} from "../src/cloud/delivery.js";
import {
  listenerFailureMessage,
  listenerStartPendingMessage,
  listenerStatusJson,
  renderListenerStatus,
  usage,
} from "../src/cli.js";
import {
  idlePollStatusSentence,
  IDLE_POLL_DEFAULT_MS,
  nextIdlePollMs,
} from "../src/cloud/idle-poll.js";
import {
  AgentCredentialSession,
  RenewalCredentialCheckError,
  RenewalReauthorisationRequired,
  RenewalRetryError,
  RenewalRevoked,
} from "../src/cloud/renewal.js";
import type { AgentCredentialRecord, AgentCredentialStore } from "../src/cloud/agent-credential.js";
import type {
  AgentSignalPage,
  SignalCursor,
} from "../src/cloud/signals.js";
import {
  CONFIRMED_CREDENTIAL_LOSS_CODES,
  isConfirmedCredentialHttpFailure,
  SIGNAL_READ_TIMEOUT_MS,
  SignalHttpError,
  LocalCredentialSecretAbsentError,
  SignalTransportError,
} from "../src/cloud/signals.js";
import { ACP_DEFAULT_REQUEST_TIMEOUT_MS } from "../src/host/bounds.js";
import { AcpHostError } from "../src/host/types.js";
import {
  runListenerRuntime as runListenerRuntimeActual,
  CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS,
  CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS,
  CREDENTIAL_LOSS_CONFIRM_WINDOW_MS,
  RENEWAL_WINDOW_RETRY_MS,
  RENEWAL_WINDOW_EXPIRY_MARGIN_MS,
  LISTENER_REQUEST_WAIT_FLOOR_MS,
  ListenerLeaseResponseError,
  LISTENER_CLAIM_REFUSALS_BEFORE_READ,
  LISTENER_DELIVERY_RETRY_MAX_MS,
  READ_FATAL_ANSWERS,
  COMMAND_FATAL_ANSWERS,
  ListenerH0SeatError,
  isRestartableListenerStop,
  LISTENER_IDLE_POLL_MS,
  LISTENER_DELIVERY_SAFETY_MARGIN_MS,
  LISTENER_HOST_PORTS_PROBE_MS,
  LISTENER_PROMPT_START_MINIMUM_MS,
  listenerPaths,
  readListenerStatus,
  queryListenerControl,
  runListenerSupervisor,
  claimCommandId,
  ackCommandId,
  FileListenerEffectStore,
  newReceivedAskRecord,
  newObservedNoteRecord,
  LISTENER_DELIVERY_HOLD_RELEASE_REASONS,
  LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES,
  LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES,
  LISTENER_DELIVERY_MAX_LEASE_MS,
  LISTENER_LEASE_CLOCK_SKEW_ALLOWANCE_MS,
  type ListenerActiveClaim,
  type ListenerDeliveryJournalRecord,
  type ListenerEffectRecord,
  type ListenerEffectStore,
  type ListenerPromptMode,
  type ListenerRuntimeEvent,
  type ListenerStatus,
  type ListenerRuntimeModel,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const SENDER_OPERATOR_ID = "44444444-4444-4444-8444-444444444444";

test("network response parser call graphs cannot throw an untagged Error", { timeout: 10_000 }, () => {
  const roots: Record<string, string[]> = {
    "src/cloud/signals.ts": ["agentSignalPage", "readAgentSignalDirectory"],
    "src/cloud/delivery.ts": ["parseClaimSuccess", "parseAckSuccess", "successBody"],
    "src/cloud/renewal.ts": ["requestSuccessor"],
  };
  const paths = [...Object.keys(roots), "src/cloud/attachments.ts"];
  const sources = new Map(paths.map((path) => [path,
    ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)]));
  const callable = new Map<string, ts.Node[]>();
  const imports = new Map<string, string>();
  for (const [path, source] of sources) {
    const register = (name: string, node: ts.Node): void => {
      const key = `${path}:${name}`;
      callable.set(key, [...(callable.get(key) ?? []), node]);
    };
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) register(node.name.text, node);
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) register(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        register(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    source.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) ||
          !node.moduleSpecifier.text.startsWith("./")) return;
      const importedPath = join("src/cloud", node.moduleSpecifier.text.replace(/\.js$/, ".ts"));
      if (!sources.has(importedPath)) return;
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          imports.set(`${path}:${element.name.text}`, `${importedPath}:${element.propertyName?.text ?? element.name.text}`);
        }
      }
    });
  }
  const visited = new Set<string>();
  const failures: string[] = [];
  const taggedOrCallbackOnly = new Set([
    "src/cloud/signals.ts:plainTransportError", // WeakSet and failure-code map
    "src/cloud/signals.ts:throwSignalHttp", // HTTP status/envelope WeakMaps
    "src/cloud/signals.ts:parseSignalRows", // callback diagnostic for a caught row
  ]);
  const visitFunction = (key: string): void => {
    if (visited.has(key)) return;
    const nodes = callable.get(key);
    assert.ok(nodes?.length, `${key}: parser root exists`);
    visited.add(key);
    const path = key.slice(0, key.lastIndexOf(":"));
    const source = sources.get(path)!;
    const walk = (node: ts.Node): void => {
      // A factory can return an Error for its caller to throw, so inspect all construction.
      if (!taggedOrCallbackOnly.has(key) && ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
          (node.expression.text === "Error" ||
            (path.endsWith("delivery.ts") && node.expression.text === "DeliveryProtocolError"))) {
        failures.push(`${key}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
        if (name !== null && name !== "renewalCommand") {
          const next = imports.get(`${path}:${name}`) ?? `${path}:${name}`;
          if (callable.has(next)) visitFunction(next);
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const node of nodes!) walk(node);
  };
  for (const [path, entries] of Object.entries(roots)) entries.forEach((name) => visitFunction(`${path}:${name}`));
  assert.deepEqual(failures, [], "plain Error construction in a response parser graph");
});

const defaultPendingMainQueue = {
  async enqueue() {
    return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
  },
};

async function runListenerRuntime(
  options: Parameters<typeof runListenerRuntimeActual>[0],
): ReturnType<typeof runListenerRuntimeActual> {
  let reads = 0;
  const origRead = options.readPage;
  const local = new AbortController();
  if (options.signal?.aborted) local.abort();
  else {
    options.signal?.addEventListener("abort", () => local.abort(), { once: true });
  }
  return await runListenerRuntimeActual({
    resolveSenderProvenance: async () => ({
      senderName: "Avery",
      operatorId: SENDER_OPERATOR_ID,
      operatorName: "Morgan",
    }),
    pendingMainQueue: defaultPendingMainQueue,
    ...options,
    signal: local.signal,
    ...(origRead
      ? {
        readPage: async (input: Parameters<NonNullable<typeof origRead>>[0]) => {
          reads += 1;
          if (reads > 8) local.abort();
          return await origRead(input);
        },
      }
      : {}),
  });
}

test("empty durable claims back off the idle wait and reset on a delivery", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const sleeps: number[] = [];
  const idleEvents: number[] = [];
  let claims = 0;
  let reads = 0;
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa80",
    "2026-07-30T00:00:01.000Z",
  );
  const lease: DeliveryRow = {
    signal: claimedNote,
    leaseId: "55555555-5555-4555-8555-555555555555",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "same_owner",
    recipientPosition: null,
    recipientCount: null,
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims <= 3) return claimResult([], 0);
        if (claims === 4) return claimResult([lease], 1);
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() {
        return { httpStatus: 200, signalId: claimedNote.id, outcome: "observed" as const };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    pollMs: IDLE_POLL_DEFAULT_MS,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onEvent: (event) => {
      if (event.type === "idle_poll") idleEvents.push(event.intervalMs);
    },
    readPage: async () => {
      reads += 1;
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(LISTENER_IDLE_POLL_MS, IDLE_POLL_DEFAULT_MS);
  assert.ok(
    reads >= 4,
    "the read edge POSTs on the same loop as the claim, after idleSleep",
  );
  const idleSleeps = sleeps.filter((ms) => ms > LISTENER_REQUEST_WAIT_FLOOR_MS);
  assert.deepEqual(
    idleSleeps.slice(0, 3),
    [
      nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 0),
      nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 1),
      nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 2),
    ],
  );
  assert.deepEqual(idleSleeps.slice(0, 3), [15_000, 30_000, 60_000]);
  const resetSleep = idleSleeps.find((ms, index) => index >= 3 && ms === IDLE_POLL_DEFAULT_MS);
  assert.equal(resetSleep, IDLE_POLL_DEFAULT_MS, "a delivery must reset the idle wait to the base");
  assert.ok(idleEvents.includes(15_000));
  assert.ok(idleEvents.includes(30_000));
  assert.ok(idleEvents.includes(60_000));
});

test("prompt-start lease budget reserves the provenance directory deadline", () => {
  assert.equal(
    LISTENER_PROMPT_START_MINIMUM_MS,
    SIGNAL_READ_TIMEOUT_MS +
      ACP_DEFAULT_REQUEST_TIMEOUT_MS +
      SIGNAL_REQUEST_TIMEOUT_MS +
      DELIVERY_REQUEST_TIMEOUT_MS +
      LISTENER_DELIVERY_SAFETY_MARGIN_MS,
  );
});

function ask(
  id: string,
  createdAt: string,
): SignalRecord {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    from: "33333333-3333-4333-8333-333333333333",
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: `ask-${id.slice(-4)}`,
    // Keep the shared non-expiry fixture far from wall-clock time. When this
    // was 2026-08-30, the gate began looping before its fetch-driven aborts.
    until: "2036-08-30T00:00:00.000Z",
    created_at: createdAt,
    sender_owner_relation: "same_owner",
  };
}

function note(
  id: string,
  createdAt: string,
): SignalRecord {
  return {
    ...ask(id, createdAt),
    kind: "note",
    body: `note-${id.slice(-4)}`,
  };
}

function journalRecord(
  active: ListenerActiveClaim | null = null,
): ListenerDeliveryJournalRecord {
  return {
    version: 1 as const,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    nextClaimOrdinal: 0,
    active,
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

class MemoryDeliveryJournal {
  record: ListenerDeliveryJournalRecord;
  readonly calls: string[] = [];
  readonly audit?: string[];

  constructor(active: ListenerActiveClaim | null = null, audit?: string[]) {
    this.record = journalRecord(active);
    this.audit = audit;
    if (active !== null) this.record.nextClaimOrdinal = active.claimOrdinal + 1;
  }

  async read() {
    this.calls.push("read");
    this.audit?.push("journal:read");
    return structuredClone(this.record);
  }

  async reserveClaim(now = new Date().toISOString()) {
    this.calls.push("reserve");
    this.audit?.push("journal:reserve");
    assert.equal(this.record.active, null);
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
    this.calls.push("attempt");
    this.audit?.push("journal:attempt");
    assert.ok(this.record.active);
    this.record.active.claimLastAttemptAt = now;
    this.record.updatedAt = now;
  }

  async recordLease(input: {
    signalId: string;
    leaseId: string;
    leasedUntil: string;
    signalFingerprint?: string;
    now?: string;
  }) {
    this.calls.push("lease");
    this.audit?.push("journal:lease");
    assert.ok(this.record.active);
    this.record.active = {
      ...this.record.active,
      phase: "leased",
      signalId: input.signalId,
      leaseId: input.leaseId,
      leasedUntil: input.leasedUntil,
      signalFingerprint: input.signalFingerprint ?? null,
    };
    this.record.updatedAt = input.now ?? new Date().toISOString();
  }

  async prepareAck(input: {
    outcome: "replied" | "observed" | "expired" | "failed_terminal";
    lastErrorCode: "provider_refused" | "local_effect_failed" | "host_session_failed" | "credential_unavailable" | null;
    preparedAt?: string;
    now?: string;
  }) {
    this.calls.push("prepareAck");
    this.audit?.push("journal:prepareAck");
    assert.ok(this.record.active?.leaseId);
    this.record.active = {
      ...this.record.active,
      phase: "ack_pending",
      ack: {
        commandId: ackCommandId(this.record.active.leaseId),
        outcome: input.outcome,
        lastErrorCode: input.lastErrorCode,
        preparedAt: input.preparedAt ?? input.now ?? new Date().toISOString(),
      },
    };
  }

  async clearActive(now = new Date().toISOString()) {
    this.calls.push("clear");
    this.audit?.push("journal:clear");
    this.record.active = null;
    this.record.updatedAt = now;
  }
}

function inactiveJournal() {
  return {
    async read() { return journalRecord(); },
    async reserveClaim() { throw new Error("reserve must not run"); },
    async recordClaimAttempt() { throw new Error("attempt must not run"); },
    async recordLease() { throw new Error("lease must not run"); },
    async prepareAck() { throw new Error("ack must not run"); },
    async clearActive() { throw new Error("clear must not run"); },
  };
}

function durablePage(
  signals: SignalRecord[] = [],
  pendingDeliveryCount = 0,
): AgentSignalPage {
  return page(signals, {
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    pendingDeliveryCount,
  });
}

function claimResult(
  deliveries: DeliveryRow[],
  pendingDeliveryCount: number,
  terminalDeliveryFailureCount = 0,
): DeliveryClaimResult {
  return {
    httpStatus: 200,
    capabilities: {
      deliveryClaim: true,
      deliveryAck: true,
      senderOwnerRelation: true,
    },
    deliveries,
    pendingDeliveryCount,
    terminalDeliveryFailureCount,
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

class RecordingStore extends MemoryStore {
  constructor(private readonly audit: string[]) {
    super();
  }
  override async read(id: string) {
    this.audit.push("effect:read");
    return await super.read(id);
  }
  override async write(record: ListenerEffectRecord) {
    this.audit.push("effect:write");
    await super.write(record);
  }
}

function leasedActive(input: {
  signalId: string;
  signal?: SignalRecord;
  leaseId?: string;
  leasedUntil?: string;
  phase?: "leased" | "ack_pending";
  outcome?: "replied" | "observed" | "expired" | "failed_terminal";
  lastErrorCode?: "provider_refused" | "local_effect_failed" | "host_session_failed" | "credential_unavailable" | null;
}): ListenerActiveClaim {
  const leaseId = input.leaseId ?? "55555555-5555-4555-8555-555555555555";
  const phase = input.phase ?? "leased";
  return {
    phase,
    claimOrdinal: 0,
    claimCommandId: claimCommandId(
      "44444444-4444-4444-8444-444444444444",
      0,
    ),
    claimCreatedAt: "2026-07-30T00:00:00.000Z",
    claimLastAttemptAt: "2026-07-30T00:00:01.000Z",
    signalId: input.signalId,
    leaseId,
    leasedUntil: input.leasedUntil ?? "2026-07-30T00:15:00.000Z",
    signalFingerprint: input.signal
      ? createHash("sha256").update(JSON.stringify([
        input.signal.id.toLowerCase(),
        input.signal.kind,
        input.signal.body,
        input.signal.until,
        input.signal.sender_owner_relation ?? "unknown",
      ])).digest("hex")
      : null,
    ack: phase === "ack_pending"
      ? {
        commandId: ackCommandId(leaseId),
        outcome: input.outcome ?? "observed",
        lastErrorCode: input.lastErrorCode ?? null,
        preparedAt: "2026-07-30T00:00:02.000Z",
      }
      : null,
  };
}

class FakeModel implements ListenerRuntimeModel {
  starts = 0;
  closes = 0;
  cancels = 0;
  prompts: Array<{ id: string; mode: ListenerPromptMode; prompt: string }> = [];

  async start() {
    this.starts += 1;
  }
  async prompt(
    signal: SignalRecord,
    mode: ListenerPromptMode,
    prompt: string,
  ) {
    this.prompts.push({ id: signal.id, mode, prompt });
    return {
      message: `reply-${signal.id.slice(-4)}`,
      stopReason: "end_turn" as const,
    };
  }
  cancel() {
    this.cancels += 1;
  }
  async close() {
    this.closes += 1;
  }
}

function page(
  signals: SignalRecord[],
  options: Partial<AgentSignalPage> = {},
): AgentSignalPage {
  const last = signals[signals.length - 1];
  return {
    signals,
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: false,
      deliveryAck: false,
    },
    legacyCursorFallback: false,
    rawCount: signals.length,
    nextCursor: last
      ? { created_at: last.created_at, id: last.id }
      : null,
    malformedRows: 0,
    pendingDeliveryCount: null,
    ...options,
  };
}

async function observedReadRetry(
  failure: Error,
): Promise<{
  retry: Extract<ListenerRuntimeEvent, { type: "read_retry" }>;
  recovered: Extract<ListenerRuntimeEvent, { type: "read_recovered" }>;
}> {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  let nowMs = Date.parse("2026-09-01T12:00:00.000Z");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    pollMs: 0,
    now: () => nowMs,
    random: () => 0,
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      nowMs += ms;
    },
    readPage: async () => {
      reads += 1;
      if (reads === 1) return page([]);
      if (reads === 2) throw failure;
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "cancelled");
  const retry = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_retry" }> =>
      event.type === "read_retry",
  );
  const recovered = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_recovered" }> =>
      event.type === "read_recovered",
  );
  assert.ok(retry, "the retry path was reached");
  assert.ok(recovered, "the successful read closed the retry episode");
  return { retry, recovered };
}

test("listener retry events classify HTTP, no-response, aborted, and host-port failures without text matching", async () => {
  const http = await observedReadRetry(new SignalHttpError(503));
  assert.equal(http.retry.failure.code, "http_status");
  assert.equal(http.retry.failure.httpStatus, 503);

  const noResponse = await observedReadRetry(new SignalTransportError());
  assert.equal(noResponse.retry.failure.code, "no_response");
  assert.equal(noResponse.retry.failure.httpStatus, null);

  const aborted = new DOMException("fake read abort", "AbortError");
  const abortEpisode = await observedReadRetry(aborted);
  assert.equal(abortEpisode.retry.failure.code, "aborted");
  assert.equal(abortEpisode.recovered.attempts, 1);
  assert.equal(abortEpisode.recovered.durationMs, abortEpisode.retry.delayMs);

  const noPorts = Object.assign(new Error("text does not classify this"), {
    code: "EADDRNOTAVAIL",
  });
  const portEpisode = await observedReadRetry(noPorts);
  assert.equal(portEpisode.retry.failure.code, "host_ports_exhausted");
  assert.equal(portEpisode.retry.delayMs, LISTENER_HOST_PORTS_PROBE_MS);
  assert.ok(portEpisode.retry.delayMs >= 60_000);
});

async function productionReadRetry(
  failingFetch: () => Promise<Response>,
): Promise<Extract<ListenerRuntimeEvent, { type: "read_retry" }>> {
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let fetchCalls = 0;
  const fetcher = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return await failingFetch();
  }) as typeof fetch;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    fetcher,
    pollMs: 0,
    random: () => 0,
    onEvent: (event) => { events.push(event); if (event.type === "read_retry") controller.abort(); },
    sleep: async () => {},
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(fetchCalls, 2, "the failure reached the production signal fetch");
  const retry = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_retry" }> =>
      event.type === "read_retry",
  );
  assert.ok(retry, "the production signal failure reached the retry event");
  return retry;
}

test("production listener reads preserve HTTP status, no response, and EADDRNOTAVAIL codes", async () => {
  const http = await productionReadRetry(async () =>
    new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
  );
  assert.equal(http.failure.code, "http_status");
  assert.equal(http.failure.httpStatus, 503);

  const noResponse = await productionReadRetry(async () => {
    throw new TypeError("fake socket closed before a response");
  });
  assert.equal(noResponse.failure.code, "no_response");

  const aborted = await productionReadRetry(async () => {
    throw new DOMException("fake provider abort", "AbortError");
  });
  assert.equal(aborted.failure.code, "aborted");

  const noPorts = await productionReadRetry(async () => {
    throw Object.assign(new Error("different message"), { code: "EADDRNOTAVAIL" });
  });
  assert.equal(noPorts.failure.code, "host_ports_exhausted");
  assert.equal(noPorts.delayMs, LISTENER_HOST_PORTS_PROBE_MS);
});

test("listener body-stall retry is classified through the production signal deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let fetchCalls = 0;
  let bodyStarted = false;
  const fetcher = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        signals: [],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        bodyStarted = true;
        return await new Promise<unknown>(() => {});
      },
    } as Response;
  }) as typeof fetch;
  const pending = runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    fetcher,
    pollMs: 0,
    random: () => 0,
    onEvent: (event) => { events.push(event); if (event.type === "read_retry") controller.abort(); },
    sleep: async () => {},
  });
  for (let turn = 0; turn < 100 && !bodyStarted; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(fetchCalls, 2, "the ready read and stalled read both reached fetch");
  assert.equal(bodyStarted, true, "the stalled body consumer was reached");
  t.mock.timers.tick(SIGNAL_READ_TIMEOUT_MS);
  const stop = await pending;
  assert.equal(stop.reason, "cancelled");
  const retry = events.find(
    (event): event is Extract<ListenerRuntimeEvent, { type: "read_retry" }> =>
      event.type === "read_retry",
  );
  assert.ok(retry, "the production body deadline reached the listener retry path");
  assert.equal(retry.failure.code, "body_timeout");
});

test("incomplete durable configuration fails before credential or provider work", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  let bearerCalls = 0;
  let readCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    credentialSession: {
      async bearer() {
        bearerCalls += 1;
        return "token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    readPage: async () => {
      readCalls += 1;
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "fatal");
  assert.equal(bearerCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(model.starts, 0);
});

test("cursor fallback queues direct notes without model or reply effects", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
    "2026-07-30T00:00:01.000Z",
  );
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page(reads === 1 ? [directNote] : []);
    },
    poster: {
      async post() {
        throw new Error("note must not post");
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  const record = await store.read(directNote.id);
  assert.ok(record);
  assert.equal(record.signalKind, "note");
  assert.equal(record.state, "routed_main");
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
  assert.deepEqual(
    events.filter((event) => event.type === "delivery_mode"),
    [{
      type: "delivery_mode",
      mode: "cursor_fallback",
      pendingDeliveryCount: null,
      ts: events.find((event) => event.type === "delivery_mode")?.ts,
    }],
  );
});

test("durable markers select durable mode before probe rows can be cursor-processed", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const probeAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
    "2026-07-30T00:00:01.000Z",
  );
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    deliveryJournal: inactiveJournal(),
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim not reached in mode test"); },
      async ackAgentDelivery() { throw new Error("ack not reached in mode test"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "delivery_mode") controller.abort();
    },
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      return page([probeAsk], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: true,
          deliveryAck: true,
        },
        pendingDeliveryCount: 4,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  const modes = events.filter((event) => event.type === "delivery_mode");
  assert.equal(modes.length, 1);
  assert.deepEqual(modes[0], {
    type: "delivery_mode",
    mode: "durable_claim",
    pendingDeliveryCount: 4,
    ts: modes[0]?.ts,
  });
});

test("claim without ACK capability retries before provider work", { timeout: 15_000 }, async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: "44444444-4444-4444-8444-444444444444",
    deliveryJournal: inactiveJournal(),
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    sleep: async () => { controller.abort(); },
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: true,
          deliveryAck: false,
        },
        pendingDeliveryCount: 0,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(reads, 1);
  assert.equal(model.starts, 0);
});

test("delivery events reduce into the closed supervisor status fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-runtime-events-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ts = "2026-07-30T00:00:01.000Z";
  const ackSnapshots: Array<{
    outcome: string | null;
    failures: number | null;
    human: string;
    json: Record<string, unknown>;
  }> = [];
  const status = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async (_signal, onEvent) => {
      onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
      onEvent({ type: "delivery_mode", mode: "durable_claim", pendingDeliveryCount: 3, ts });
      onEvent({
        type: "delivery_claim",
        signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 1,
        ts,
      });
      onEvent({ type: "delivery_terminal_failures", count: 1, ts });
      const ack = async (
        signalId: string,
        outcome: DeliveryOutcome,
        ackTs: string,
      ) => {
        onEvent({ type: "delivery_ack", signalId, outcome, ts: ackTs });
        const snapshot = await queryListenerControl(paths, "status");
        ackSnapshots.push({
          outcome: snapshot.lastAckOutcome,
          failures: snapshot.consecutiveAckFailureCount,
          human: renderListenerStatus(snapshot),
          json: listenerStatusJson(snapshot),
        });
      };
      const incident: Array<[string, DeliveryOutcome, string]> = [
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13", "failed_terminal", "2026-09-03T17:06:52.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14", "observed", "2026-09-03T17:12:52.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15", "failed_terminal", "2026-09-03T17:23:15.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16", "failed_terminal", "2026-09-03T17:24:30.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa17", "failed_terminal", "2026-09-03T17:52:30.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18", "failed_terminal", "2026-09-03T18:36:28.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19", "failed_terminal", "2026-09-03T18:37:12.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20", "failed_terminal", "2026-09-03T18:37:35.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21", "observed", "2026-09-03T18:38:24.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22", "failed_terminal", "2026-09-03T18:44:31.000Z"],
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23", "observed", "2026-09-03T18:45:38.000Z"],
      ];
      for (const event of incident) await ack(...event);
      /* Reaching `ready` again (a restartable blip, canary passed) must NOT clear
         the run. The permission canary is its own prompt: a provider can answer
         it and fail every real message, so `ready` is not provider proof. Without
         this pin, restoring `consecutiveAckFailureCount: 0` on `ready` leaves
         every other assertion in this file green. */
      onEvent({
        type: "ready",
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        ts: "2026-09-03T18:46:00.000Z",
      });
      const afterReady = await queryListenerControl(paths, "status");
      assert.equal(afterReady.consecutiveAckFailureCount, 8);
      assert.equal(afterReady.lastAckOutcome, "observed");
      const afterReadyHuman = renderListenerStatus(afterReady);
      assert.doesNotMatch(afterReadyHuman, /HANDLED: yes/);
      /* A negative alone passes if the line vanishes; pin the positive too. */
      assert.match(afterReadyHuman, /HANDLED: no\. Queued messages have not reached the session hook/);
      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa24", "queued", "2026-09-03T18:46:00.000Z");
      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa25", "expired", "2026-09-03T18:46:30.000Z");
      await ack("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa26", "replied", "2026-09-03T18:47:00.000Z");
      onEvent({
        type: "main_queue",
        signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
        pendingCount: 200,
        droppedOldest: true,
        droppedCount: 7,
        ts,
      });
      return { reason: "cancelled" };
    },
  });
  assert.equal(status.deliveryMode, "durable_claim");
  assert.equal(status.pendingDeliveryCount, null);
  assert.equal(status.lastTerminalDeliveryFailureCount, 1);
  assert.equal(status.lastTerminalDeliveryFailureAt, ts);
  assert.equal(status.lastClaimAt, ts);
  assert.equal(status.lastAckAt, "2026-09-03T18:47:00.000Z");
  assert.equal(status.lastAckOutcome, "replied");
  assert.equal(status.consecutiveAckFailureCount, 0);
  assert.deepEqual(
    ackSnapshots.map(({ outcome, failures }) => ({ outcome, failures })),
    [
      { outcome: "failed_terminal", failures: 1 },
      { outcome: "observed", failures: 1 },
      { outcome: "failed_terminal", failures: 2 },
      { outcome: "failed_terminal", failures: 3 },
      { outcome: "failed_terminal", failures: 4 },
      { outcome: "failed_terminal", failures: 5 },
      { outcome: "failed_terminal", failures: 6 },
      { outcome: "failed_terminal", failures: 7 },
      { outcome: "observed", failures: 7 },
      { outcome: "failed_terminal", failures: 8 },
      { outcome: "observed", failures: 8 },
      { outcome: "queued", failures: 8 },
      { outcome: "expired", failures: 8 },
      { outcome: "replied", failures: 0 },
    ],
  );
  const belowThreshold = ackSnapshots[2]!;
  assert.doesNotMatch(belowThreshold.human, /listener_delivery_failing/);
  assert.equal(belowThreshold.json.listenerLapse, false);
  const atThreshold = ackSnapshots[3]!;
  assert.match(atThreshold.human, /Listener LAPSE/);
  assert.match(atThreshold.human, /WARNING \[listener_delivery_failing\]/);
  assert.deepEqual(atThreshold.json.listenerLapseCodes, [
    "listener_delivery_failing",
  ]);
  const afterMeasuredIncident = ackSnapshots[10]!;
  assert.match(afterMeasuredIncident.human, /^Listener LAPSE/);
  assert.match(afterMeasuredIncident.human, /WARNING \[listener_delivery_failing\]/);
  /* The 18:47 state of the measured 2026-09-03 incident: the newest ack is the
     18:45:38 `observed` note. Observing a note starts no provider session, so it
     must NOT read as handled while the terminal-failure run stands. This assertion
     replaces one that required `HANDLED: yes` here — a green control pinning the
     exact false claim the lane exists to remove. */
  assert.doesNotMatch(afterMeasuredIncident.human, /HANDLED: yes/);
  assert.match(
    afterMeasuredIncident.human,
    /HANDLED: no\. Queued messages have not reached the session hook/,
  );
  assert.equal(afterMeasuredIncident.json.handledState, "not_handled");
  assert.equal(afterMeasuredIncident.json.lastAckOutcome, "observed");
  assert.equal(afterMeasuredIncident.json.consecutiveAckFailureCount, 8);
  /* An observed note must not be renamed a failed delivery, and must not be
     called handled while the run stands. Both halves are pinned: without the
     second, restoring `Last handled signal:` here would still pass. */
  assert.doesNotMatch(afterMeasuredIncident.human, /Last failed delivery signal/);
  assert.doesNotMatch(afterMeasuredIncident.human, /Last handled signal/);
  assert.match(
    afterMeasuredIncident.human,
    /Last acknowledged signal: [0-9a-f-]+\. Its outcome was observed\./,
  );
  assert.equal(afterMeasuredIncident.json.listenerLapse, true);
  assert.deepEqual(afterMeasuredIncident.json.listenerLapseCodes, [
    "listener_delivery_failing",
  ]);
  const afterReply = ackSnapshots.at(-1)!;
  assert.doesNotMatch(afterReply.human, /listener_delivery_failing/);
  assert.equal(afterReply.json.listenerLapse, false);
  assert.equal(status.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13");
  assert.equal(status.pendingForMainCount, 200);
  assert.equal(status.droppedForMainCount, 7);
});

test("durable claim persists one command id across retries, uses fresh bearers, and clears zero results", async () => {
  const model = new FakeModel();
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const callOrder: string[] = [];
  const claimIds: string[] = [];
  const delays: number[] = [];
  let reads = 0;
  let attempts = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        callOrder.push("claim");
        claimIds.push(request.commandId);
        attempts += 1;
        if (attempts === 1) throw new DeliveryTransportError("ambiguous");
        if (attempts === 2) {
          throw new DeliveryHttpError(429, "rate_limited", "retry", 750);
        }
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: {
      async bearer() {
        callOrder.push("bearer");
        return "token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return durablePage([], 1);
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(attempts, 3);
  assert.equal(new Set(claimIds).size, 1);
  assert.equal(
    claimIds[0],
    claimCommandId(journal.record.listenerInstanceId, 0),
  );
  assert.deepEqual(journal.calls.slice(0, 6), [
    "read",
    "reserve",
    "attempt",
    "attempt",
    "attempt",
    "clear",
  ]);
  for (const [index, value] of callOrder.entries()) {
    if (value === "claim") assert.equal(callOrder[index - 1], "bearer");
  }
  assert.ok(delays.includes(LISTENER_REQUEST_WAIT_FLOOR_MS));
  assert.equal(journal.record.active, null);
  assert.equal(model.prompts.length, 0);
});

test("claim-pending recovery replays the exact persisted command without reserving a new claim", async () => {
  const active: ListenerActiveClaim = {
    phase: "claim_pending",
    claimOrdinal: 7,
    claimCommandId: claimCommandId(
      "44444444-4444-4444-8444-444444444444",
      7,
    ),
    claimCreatedAt: "2026-07-30T00:00:00.000Z",
    claimLastAttemptAt: "2026-07-30T00:00:01.000Z",
    signalId: null,
    leaseId: null,
    leasedUntil: null,
    ack: null,
  };
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const ids: string[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        ids.push(request.commandId);
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:02.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(ids, [active.claimCommandId]);
  assert.equal(journal.calls.includes("reserve"), false);
  assert.equal(journal.record.nextClaimOrdinal, 8);
  assert.equal(journal.record.active, null);
});

test("C-1 composition: stale claim_pending clears before durable replay", async () => {
  const active: ListenerActiveClaim = {
    phase: "claim_pending",
    claimOrdinal: 7,
    claimCommandId: claimCommandId(
      "44444444-4444-4444-8444-444444444444",
      7,
    ),
    claimCreatedAt: "2026-07-30T00:00:00.000Z",
    claimLastAttemptAt: "2026-07-30T00:00:01.000Z",
    signalId: null,
    leaseId: null,
    leasedUntil: null,
    ack: null,
  };
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const ids: string[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        ids.push(request.commandId);
        if (request.commandId === active.claimCommandId) {
          throw new DeliveryProtocolError(
            "stored replay returned an already expired lease",
          );
        }
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:16:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 2) controller.abort();
      return durablePage();
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 stale claim_pending must clear instead of fatally replaying an expired lease",
  );
  assert.deepEqual(ids, [
    claimCommandId(journal.record.listenerInstanceId, 8),
  ]);
  assert.deepEqual(journal.calls.slice(0, 7), [
    "read",
    "clear",
    "read",
    "reserve",
    "attempt",
    "clear",
    "read",
  ]);
});

test("a claimed lease is persisted before any effect work begins", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14",
    "2026-07-30T00:00:01.000Z",
  );
  const lease: DeliveryRow = {
    signal: claimedAsk,
    leaseId: "55555555-5555-4555-8555-555555555555",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "cross_owner",
    recipientPosition: null,
    recipientCount: null,
  };
  const originalRecordLease = journal.recordLease.bind(journal);
  journal.recordLease = async (input) => {
    await originalRecordLease(input);
    controller.abort();
  };
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { return claimResult([lease], 1); },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return durablePage();
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(journal.record.active?.phase, "leased");
  assert.equal(journal.record.active?.signalId, claimedAsk.id);
  assert.equal(journal.record.active?.leaseId, lease.leaseId);
  assert.equal(model.prompts.length, 0);
  assert.deepEqual(journal.calls.slice(0, 4), [
    "read",
    "reserve",
    "attempt",
    "lease",
  ]);
});

test("C-1: an expired durable leased claim without an effect clears and re-claims", async () => {
  const signalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1";
  const active = leasedActive({
    signalId,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const claimIds: string[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        if (request.commandId === active.claimCommandId) {
          throw new DeliveryProtocolError("stored replay lease is no longer live");
        }
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 stale durable lease must recover instead of stopping fatally",
  );
  assert.equal(claimIds.includes(active.claimCommandId), false);
  assert.equal(journal.record.active, null);
});

test("D-041a: a corrupt recovered effect cannot block stale leased recovery", async (t) => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa041",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    signal: directNote,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041a-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041a",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directNote.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  const claimIds: string[] = [];
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        return claimResult([{
          signal: directNote,
          leaseId: "55555555-5555-4555-8555-555555555041",
          leasedUntil: "2026-07-30T00:17:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal"
      ? `D-041a recovery stopped fatally: ${stop.error.message}`
      : "D-041a corrupt effect must degrade to no terminal effect and clear the stale lease",
  );
  assert.equal(claimIds.includes(active.claimCommandId), false);
  assert.equal(ackCalls, 1);
  assert.equal((await store.read(directNote.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("D-041a enumeration: a requeued corrupt ask fails safely without a second reply", async (t) => {
  const directAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa043",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directAsk.id,
    signal: directAsk,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041a-ask-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041a-ask",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newReceivedAskRecord(
    directAsk,
    Date.parse("2026-07-30T00:00:02.000Z"),
  ));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directAsk.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  const model = new FakeModel();
  let postCalls = 0;
  let ackCalls = 0;
  let ackOutcome: string | null = null;
  let ackErrorCode: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: directAsk,
          leaseId: "55555555-5555-4555-8555-555555555043",
          leasedUntil: "2026-07-30T00:17:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        ackOutcome = request.outcome;
        ackErrorCode = request.lastErrorCode;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    poster: {
      async post() {
        postCalls += 1;
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb043" };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  assert.equal(postCalls, 0);
  assert.equal(ackCalls, 1);
  assert.equal(ackOutcome, "failed_terminal");
  assert.equal(ackErrorCode, "local_effect_failed");
  assert.equal((await store.read(directAsk.id))?.state, "failed");
  assert.equal((await store.read(directAsk.id))?.failureCode, "local_effect_corrupt");
  assert.equal(journal.record.active, null);
});

test("D-041 enumeration: a fresh claim repairs corruption without process-local recovery state", async (t) => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa044",
    "2026-07-30T00:00:01.000Z",
  );
  const journal = new MemoryDeliveryJournal();
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041-fresh-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041-fresh",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directNote.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: directNote,
          leaseId: "55555555-5555-4555-8555-555555555044",
          leasedUntil: "2026-07-30T00:17:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(ackCalls, 1);
  assert.ok(journal.calls.includes("lease"));
  assert.equal((await store.read(directNote.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("D-041 enumeration: cursor fallback consumes a corrupt-effect repair", async (t) => {
  const directAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa045",
    "2026-07-30T00:00:01.000Z",
  );
  const journal = new MemoryDeliveryJournal(leasedActive({
    signalId: directAsk.id,
    signal: directAsk,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  }));
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-d041-fallback-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileListenerEffectStore({
    profileId: "profile-d041-fallback",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await store.write(newReceivedAskRecord(
    directAsk,
    Date.parse("2026-07-30T00:00:02.000Z"),
  ));
  await writeFile(
    join(store.instanceDirectory, "effects", `${directAsk.id}.json`),
    "{corrupt",
  );

  const controller = new AbortController();
  const model = new FakeModel();
  let postCalls = 0;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    poster: {
      async post() {
        postCalls += 1;
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb045" };
      },
    },
    signal: controller.signal,
    onEvent(event) {
      if (event.type === "effect") controller.abort();
    },
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      return page(reads === 1 ? [] : [directAsk]);
    },
  });

  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  assert.equal(postCalls, 0);
  assert.equal((await store.read(directAsk.id))?.state, "failed");
  assert.equal((await store.read(directAsk.id))?.failureCode, "local_effect_corrupt");
  assert.equal(journal.record.active, null);
});

test("D-041b: fatal ACK replay recovers after the persisted lease horizon", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa042",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  let ackCalls = 0;

  const firstStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new DeliveryProtocolError("fatal prepared ACK");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(firstStop.reason, "fatal");
  assert.equal(journal.record.active?.phase, "ack_pending");

  const controller = new AbortController();
  const claimIds: string[] = [];
  const restartStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("expired ACK must not replay");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:01:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });

  assert.equal(
    restartStop.reason,
    "cancelled",
    "D-041b fatal ACK state must clear after lease expiry plus the safety margin",
  );
  assert.equal(ackCalls, 1);
  assert.equal(claimIds.includes(active.claimCommandId), false);
  assert.equal(journal.record.active, null);
});

test("C-1: an expired durable leased claim with a terminal effect ACKs before clearing", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad2",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    signal: directNote,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        throw new DeliveryProtocolError("expired claim replay must not run");
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 terminal durable recovery must ACK instead of replaying the expired claim",
  );
  assert.equal(ackCalls, 1);
  assert.equal(journal.record.active, null);
});

test("C-1 review: recovered terminal effects must match authoritative signal fields before ACK", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad9",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: "stale content under the same signal id",
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  let claimCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(
    ackCalls,
    0,
    "C-1 recovered terminal effect with mismatched immutable fields must not be ACKed",
  );
  assert.equal(claimCalls, 1);
});

test("C-1 composition: an expired leased claim with a resumable effect re-claims and finishes", async () => {
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad4",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: claimedAsk.id,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaad4_0",
    askBody: claimedAsk.body,
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "received",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: "cancelled",
    updatedAt: "2026-07-30T00:00:02.000Z",
  });
  const controller = new AbortController();
  const model = new FakeModel();
  let claimCalls = 0;
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-5555555555d4",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbd4" };
      },
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    `C-1 resumable recovery must not classify a nonterminal effect as terminal${
      stop.reason === "fatal" ? `: ${stop.error.message}` : ""
    }`,
  );
  assert.equal(claimCalls, 1);
  assert.equal(ackCalls, 1);
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
  assert.equal((await store.read(claimedAsk.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("C-1 composition: a live leased claim with a resumable effect replays after request spacing", async () => {
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad5",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: claimedAsk.id,
    leasedUntil: "2026-07-30T00:15:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaad5_0",
    askBody: claimedAsk.body,
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "prompting",
    promptAttempts: 1,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:02.000Z",
  });
  const controller = new AbortController();
  const model = new FakeModel();
  const claimIds: string[] = [];
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox(request) {
        claimIds.push(request.commandId);
        return claimResult([{
          signal: claimedAsk,
          leaseId: active.leaseId!,
          leasedUntil: active.leasedUntil!,
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => {},
    readPage: async () => durablePage([], 1),
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbd5" };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(
    claimIds,
    [active.claimCommandId],
    "C-1 live durable recovery must replay the stored claim",
  );
  assert.equal(ackCalls, 1);
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
  assert.equal((await store.read(claimedAsk.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("C-1 composition: an unverified terminal-shaped effect does not brick recovery", async () => {
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad6",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: claimedAsk.id,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaad6_0",
    askBody: claimedAsk.body,
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "done",
    promptAttempts: 1,
    postAttempts: 1,
    replyBody: "reply",
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:02.000Z",
  });
  const controller = new AbortController();
  let claimCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        controller.abort();
        return claimResult([], 0);
      },
      async ackAgentDelivery() { throw new Error("unverified effect must not ACK"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "C-1 unverified terminal-shaped effects must recover instead of stopping fatally",
  );
  assert.equal(claimCalls, 1);
  assert.equal(journal.record.active, null);
});

test("MAJOR-3: failureCode error ACKs local_effect_failed and the runtime survives", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const model = new FakeModel();
  model.prompt = async () => {
    throw new Error("ordinary model failure");
  };
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad3",
    "2026-07-30T00:00:01.000Z",
  );
  let ackCode: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-5555555555d3",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCode = request.lastErrorCode;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "MAJOR-3 unknown failure classification must not brick the listener",
  );
  assert.equal(ackCode, null);
  assert.equal(journal.record.active, null);
});

test("route=worker observes a durable note before prepareAck and network ACK", async () => {
  const audit: string[] = [];
  const journal = new MemoryDeliveryJournal(null, audit);
  const store = new RecordingStore(audit);
  const controller = new AbortController();
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15",
    "2026-07-30T00:00:01.000Z",
  );
  const delivery: DeliveryRow = {
    signal: { ...directNote, sender_owner_relation: "same_owner" },
    leaseId: "55555555-5555-4555-8555-555555555556",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "cross_owner",
    recipientPosition: null,
    recipientCount: null,
  };
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        audit.push("network:claim");
        return claimResult([delivery], 1);
      },
      async ackAgentDelivery(request) {
        audit.push("network:ack");
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    routeMode: "main",
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: { async post() { throw new Error("note must not post"); } },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackOutcome, "queued");
  const record = await store.read(directNote.id);
  assert.ok(record);
  assert.equal(record.state, "routed_main");
  assert.equal(record.senderOwnerRelation, "cross_owner");
  assert.equal(journal.record.active, null);
  const writeAt = audit.indexOf("effect:write");
  const prepareAt = audit.indexOf("journal:prepareAck");
  const ackAt = audit.indexOf("network:ack");
  assert.ok(writeAt >= 0 && writeAt < prepareAt);
  assert.ok(audit.lastIndexOf("effect:read", prepareAt) > writeAt);
  assert.ok(prepareAt < ackAt);
});

test("route=worker replies to a durable ask after persisting prepareAck", async () => {
  const audit: string[] = [];
  const journal = new MemoryDeliveryJournal(null, audit);
  const store = new RecordingStore(audit);
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16",
    "2026-07-30T00:00:01.000Z",
  );
  const delivery: DeliveryRow = {
    signal: claimedAsk,
    leaseId: "55555555-5555-4555-8555-555555555557",
    leasedUntil: "2026-07-30T00:15:00.000Z",
    senderOwnerRelation: "same_owner",
    recipientPosition: null,
    recipientCount: null,
  };
  let outcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { return claimResult([delivery], 1); },
      async ackAgentDelivery(request) {
        audit.push("network:ack");
        outcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    routeMode: "main",
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: {
      async post() {
        audit.push("effect:post");
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(outcome, "queued");
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
  assert.equal((await store.read(claimedAsk.id))?.state, "routed_main");
  assert.ok(audit.indexOf("journal:prepareAck") < audit.indexOf("network:ack"));
  assert.ok(audit.lastIndexOf("effect:read", audit.indexOf("journal:prepareAck")) >= 0);
});

test("route=main queues and acknowledges a durable ask without prompting the worker", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa92",
    "2026-07-30T00:00:01.000Z",
  );
  const queued: Array<{ signalId: string; observationPending?: true }> = [];
  const runtimeEvents: ListenerRuntimeEvent[] = [];
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555592",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue(entry) {
        queued.push({
          signalId: entry.signalId,
          ...(entry.observationPending === true ? { observationPending: true } : {}),
        });
        return { count: 200, added: true, droppedOldest: true, droppedCount: 4 };
      },
    },
    onEvent(event) {
      runtimeEvents.push(event);
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: { async post() { throw new Error("main route must not post a worker reply"); } },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(queued, [{ signalId: claimedAsk.id, observationPending: true }]);
  assert.equal(
    ackOutcome,
    "queued",
    "routing to the interactive session is not observation before hook output",
  );
  assert.equal(model.starts, 0, "main route must not start an ACP worker session");
  assert.equal(model.prompts.length, 0, "mutation control: forcing worker route must prompt once");
  assert.ok(runtimeEvents.some((event) =>
    event.type === "main_queue" && event.pendingCount === 200 &&
    event.droppedOldest && event.droppedCount === 4
  ), "a bounded-queue drop must reach the supervisor as a warning event");
  assert.equal((await store.read(claimedAsk.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("route=main queues a durable note before the hook observes it", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const controller = new AbortController();
  const model = new FakeModel();
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1",
    "2026-07-30T00:00:01.000Z",
  );
  const queued: Array<{
    signalId: string;
    kind?: "ask" | "note";
    observationPending?: true;
  }> = [];
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedNote,
          leaseId: "55555555-5555-4555-8555-5555555555c1",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue(entry) {
        queued.push({
          signalId: entry.signalId,
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          ...(entry.observationPending === true ? { observationPending: true } : {}),
        });
        return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
    poster: { async post() { throw new Error("main-routed note must not post"); } },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(queued, [{
    signalId: claimedNote.id,
    kind: "note",
    observationPending: true,
  }]);
  assert.equal(
    ackOutcome,
    "queued",
    "receipt cannot say observed before the interactive hook prints the note",
  );
  assert.equal(model.starts, 0);
  assert.equal(model.prompts.length, 0);
  assert.equal((await store.read(claimedNote.id))?.state, "routed_main");
  assert.equal(journal.record.active, null);
});

test("route=split queues an over-threshold note instead of claiming observation", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac2",
    "2026-07-30T00:00:01.000Z",
  );
  let queuedKind: "ask" | "note" | undefined;
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedNote,
          leaseId: "55555555-5555-4555-8555-5555555555c2",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue(entry) {
        queuedKind = entry.kind;
        return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(queuedKind, "note");
  assert.equal(ackOutcome, "queued");
  assert.equal(journal.record.active, null);
});

test("route=main queues an under-threshold note instead of observing it", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac4",
    "2026-07-30T00:00:01.000Z",
  );
  let ackOutcome: string | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedNote,
          leaseId: "55555555-5555-4555-8555-5555555555c4",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcome = request.outcome;
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue() {
        return { count: 1, added: true, droppedOldest: false, droppedCount: 0 };
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackOutcome, "queued");
  assert.equal(journal.record.active, null);
});

test("routed-main kill-between ordering: a pending persist failure leaves the lease unacked", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa93",
    "2026-07-30T00:00:01.000Z",
  );
  let ackCalls = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555593",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("mutation: ACK ran before the pending write completed");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    routeMode: "main",
    deferOverChars: null,
    pendingMainQueue: {
      async enqueue() {
        throw new Error("simulated crash before pending queue persistence");
      },
    },
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(
    stop.reason === "fatal" ? stop.error.message : "",
    /simulated crash before pending queue persistence/,
  );
  assert.equal(ackCalls, 0, "mutation: moving ACK before enqueue makes this 1");
  assert.equal(journal.record.active?.phase, "leased");
  assert.equal(await store.read(claimedAsk.id), null);
});

test("an authoritative claimed signal mismatch fails before engine write or ACK", async () => {
  const journal = new MemoryDeliveryJournal();
  const store = new MemoryStore();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa17",
    "2026-07-30T00:00:01.000Z",
  );
  store.records.set(claimedAsk.id, {
    version: 2,
    signalId: claimedAsk.id,
    signalKind: "ask",
    effectOrdinal: 0,
    commandId: "reply_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa17_0",
    askBody: "different durable body",
    askUntil: claimedAsk.until,
    senderOwnerRelation: "same_owner",
    state: "received",
    promptAttempts: 0,
    postAttempts: 0,
    replyBody: null,
    replyTruncated: false,
    replySignalId: null,
    failureCode: null,
    updatedAt: "2026-07-30T00:00:00.000Z",
  });
  let ackCalls = 0;
  const model = new FakeModel();
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555558",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "cross_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("must not ACK mismatch");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(stop.reason === "fatal" ? stop.error.message : "", /effect.*match/i);
  assert.equal(model.prompts.length, 0);
  assert.equal(ackCalls, 0);
  assert.equal(store.records.get(claimedAsk.id)?.askBody, "different durable body");
  assert.equal(journal.record.active?.phase, "leased");
});

test("ack_pending recovery retries one deterministic ACK body and clears only after success", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  const requests: Array<Record<string, unknown>> = [];
  let attempts = 0;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery(request) {
        requests.push({ ...request, credential: "redacted" });
        attempts += 1;
        if (attempts === 1) throw new DeliveryTransportError("ambiguous ACK");
        controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: true,
        },
        pendingDeliveryCount: 1,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0]?.commandId, active.ack?.commandId);
  assert.equal(journal.record.active, null);
});

test("route=main does not replay a pre-fix observed-note ACK after restart", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  const originalClear = journal.clearActive.bind(journal);
  journal.clearActive = async (now) => {
    await originalClear(now);
    controller.abort();
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim waits for the next loop"); },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new Error("a pre-fix observed ACK must not be sent on the main route");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    routeMode: "main",
    pendingMainQueue: {
      async enqueue() {
        throw new Error("recovery must wait for authoritative redelivery before queueing");
      },
    },
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:01:30.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackCalls, 0);
  assert.equal(journal.record.active, null, "redelivery remains available after lease cleanup");
});

test("MAJOR-4: delivery_unavailable at exact lease expiry clears stale state", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  let reads = 0;
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const originalClear = journal.clearActive.bind(journal);
  journal.clearActive = async (now) => {
    await originalClear(now);
    controller.abort();
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        throw new DeliveryHttpError(403, "delivery_unavailable", "unavailable");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:01:00.000Z"),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: true,
        },
        pendingDeliveryCount: 1,
      });
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "MAJOR-4 exact lease deadline must be stale rather than credential loss",
  );
  assert.equal(journal.record.active, null);
});

test("MAJOR-4: delivery_unavailable before lease expiry is retried, not a credential stop", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad4",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({
    signalId: directNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:15:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackAttempts = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        ackAttempts += 1;
        throw new DeliveryHttpError(403, "delivery_unavailable", "unavailable");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:00.000Z"),
    sleep: async () => {
      if (ackAttempts >= 2) controller.abort();
    },
    readPage: async () => durablePage([], 1),
  });
  assert.equal(stop.reason, "cancelled");
  assert.notEqual(stop.reason, "credential");
  assert.ok(ackAttempts >= 2);
  assert.equal(journal.record.active?.phase, "ack_pending");
});

test("ACK-only rollback waits past a recovered nonterminal lease before clearing and rewinding", async () => {
  const signalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20";
  const active = leasedActive({
    signalId,
    leasedUntil: "2026-07-30T00:01:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  const delays: number[] = [];
  const cursors: Array<SignalCursor | null> = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
    readPage: async ({ after }) => {
      cursors.push(after);
      reads += 1;
      if (reads > 1) controller.abort();
      return page([], {
        capabilities: {
          senderOwnerRelation: true,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: true,
        },
        pendingDeliveryCount: 1,
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(delays.some((delay) => delay >= 90_000));
  assert.equal(journal.record.active, null);
  assert.deepEqual(cursors.slice(0, 2), [null, null]);
});

test("caller abort during claim retry sleep starts no later delivery request", async () => {
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  let claimCalls = 0;
  let claimRetryPending = false;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claimCalls += 1;
        throw new DeliveryTransportError("ambiguous claim");
      },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    onEvent: (event) => { if (event.type === "claim_retry") claimRetryPending = true; },
    sleep: async () => {
      if (claimRetryPending) controller.abort();
    },
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claimCalls, 1);
  assert.equal(journal.record.active?.phase, "claim_pending");
});

test("caller abort during ACK retry sleep starts no later ACK request", async () => {
  const directNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21",
    "2026-07-30T00:00:01.000Z",
  );
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: directNote.id,
    body: directNote.body,
    until: directNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const controller = new AbortController();
  let ackCalls = 0;
  let ackRetryPending = false;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        ackCalls += 1;
        throw new DeliveryTransportError("ambiguous ACK");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    onEvent: (event) => { if (event.type === "ack_retry") ackRetryPending = true; },
    sleep: async () => {
      if (ackRetryPending) controller.abort();
    },
    readPage: async () => page([], {
      capabilities: {
        senderOwnerRelation: true,
        cursorAfter: true,
        deliveryClaim: false,
        deliveryAck: true,
      },
      pendingDeliveryCount: 1,
    }),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(ackCalls, 1);
  assert.equal(journal.record.active?.phase, "ack_pending");
});

test("a lease beyond the fixed server maximum fails before effect work", async () => {
  const journal = new MemoryDeliveryJournal();
  const model = new FakeModel();
  const claimedAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22",
    "2026-07-30T00:00:01.000Z",
  );
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: claimedAsk,
          leaseId: "55555555-5555-4555-8555-555555555559",
          leasedUntil: "2026-07-30T00:16:00.001Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery() { throw new Error("ACK must not run"); },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    readPage: async () => durablePage(),
  });
  assert.equal(stop.reason, "fatal");
  assert.match(stop.reason === "fatal" ? stop.error.message : "", /lease deadline/);
  assert.equal(model.prompts.length, 0);
  assert.equal(journal.record.active?.phase, "claim_pending");
});

test("MAJOR-4: a mid-run expired lease 403 clears stale state without credential stop", async () => {
  const oldNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23",
    "2026-07-30T00:00:01.000Z",
  );
  const oldActive = leasedActive({
    signalId: oldNote.id,
    phase: "ack_pending",
    outcome: "observed",
    leasedUntil: "2026-07-30T00:10:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(oldActive);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({
    signalId: oldNote.id,
    body: oldNote.body,
    until: oldNote.until,
    senderOwnerRelation: "same_owner",
    updatedAt: "2026-07-30T00:00:02.000Z",
  }));
  const newNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa24",
    "2026-07-30T00:00:03.000Z",
  );
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  let ackCalls = 0;
  let reads = 0;
  const controller = new AbortController();
  const originalClear = journal.clearActive.bind(journal);
  let clears = 0;
  journal.clearActive = async (now) => {
    clears += 1;
    await originalClear(now);
    if (clears > 1) controller.abort();
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: newNote,
          leaseId: "55555555-5555-4555-8555-555555555560",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackCalls += 1;
        if (ackCalls === 1) {
          return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
        }
        clock = Date.parse("2026-07-30T00:16:00.000Z");
        throw new DeliveryHttpError(403, "delivery_unavailable", "unavailable");
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store,
    model: new FakeModel(),
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) {
        return page([], {
          capabilities: {
            senderOwnerRelation: true,
            cursorAfter: true,
            deliveryClaim: false,
            deliveryAck: true,
          },
          pendingDeliveryCount: 1,
        });
      }
      return durablePage([], 1);
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    "MAJOR-4 mid-run stale delivery_unavailable must not report credential loss",
  );
  assert.equal(clears, 2);
  assert.equal(journal.record.active, null);
});

test("runtime retries an old read edge without starting or prompting a model", { timeout: 15_000 }, async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    sleep: async () => { controller.abort(); },
    readPage: async () => {
      reads += 1;
      return page([], {
        capabilities: {
          senderOwnerRelation: false,
          cursorAfter: true,
          deliveryClaim: false,
          deliveryAck: false,
        },
      });
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(reads, 1);
  assert.equal(model.starts, 0);
  assert.equal(model.prompts.length, 0);
  assert.equal(model.closes, 1);
});

test("unconfirmed HTTP 403 retries and recovers when the read succeeds", async () => {
  const model = new FakeModel();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    sleep: async () => undefined,
    onEvent: (event) => events.push(event),
    readPage: async () => {
      reads += 1;
      if (reads < 3) throw new SignalHttpError(403);
      return page([]);
    },
  });
  assert.ok(reads >= 3, "the read must be attempted again after the bare 403");
  assert.notEqual(stop.reason, "credential");
  assert.equal(stop.reason, "cancelled");
  assert.ok(events.some((event) => event.type === "ready"));
  assert.equal(model.starts, 0);
});

function forbiddenRead(): SignalHttpError {
  return new SignalHttpError(403, null, {
    error: "forbidden",
    requestId: null,
    retryable: null,
  });
}

function advancingClock(start = "2026-09-22T22:00:00.000Z") {
  const startMs = Date.parse(start);
  let clock = startMs;
  return {
    startMs,
    now: () => clock,
    elapsed: () => clock - startMs,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      clock += ms;
    },
  };
}

test("the credential confirmation window is at least ten minutes and three checks", () => {
  assert.ok(CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS >= 3);
  assert.ok(CREDENTIAL_LOSS_CONFIRM_WINDOW_MS >= 10 * 60_000);
  assert.equal(
    CREDENTIAL_LOSS_CONFIRM_WINDOW_MS,
    (CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS - 1) * CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS,
  );
  assert.equal(
    isConfirmedCredentialHttpFailure(403, "forbidden", "read"),
    true,
  );
  assert.equal(
    isConfirmedCredentialHttpFailure(403, "forbidden", "command"),
    false,
  );
  assert.equal(
    isConfirmedCredentialHttpFailure(401, "unauthenticated", "command"),
    true,
  );
});

test("runtime reports agent read revocation as a credential stop after the confirmation window", async () => {
  const model = new FakeModel();
  const clock = advancingClock();
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    now: clock.now,
    sleep: clock.sleep,
    readPage: async () => {
      reads += 1;
      throw forbiddenRead();
    },
  });
  assert.equal(reads, CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS);
  assert.equal(clock.elapsed(), CREDENTIAL_LOSS_CONFIRM_WINDOW_MS);
  assert.equal(stop.reason, "credential");
  assert.equal(model.starts, 0);
  assert.equal(model.closes, 1);
});

test("HTTP 403 forbidden across the confirmation window stops the listener with credential_stopped", async () => {
  const clock = advancingClock();
  const root = await mkdtemp(join(tmpdir(), "cswarm-credential-stop-"));
  try {
    const target = listenerPaths({
      profileId: "profile-credential-stop",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: root,
    });
    const during: ListenerStatus[] = [];
    let reads = 0;
    const status = await runListenerSupervisor({
      paths: target,
      profileId: "profile-credential-stop",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      now: clock.now,
      restart: { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
      run: async (signal, onEvent) => runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"),
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        credentialSession: { async bearer() { return "token"; } },
        store: new MemoryStore(),
        model: new FakeModel(),
        signal,
        onEvent,
        now: clock.now,
        sleep: async (ms, sleepSignal) => {
          during.push(await queryListenerControl(target, "status"));
          await clock.sleep(ms, sleepSignal);
        },
        readPage: async () => {
          reads += 1;
          throw forbiddenRead();
        },
      }),
    });
    assert.equal(reads, CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS);
    assert.equal(clock.elapsed(), CREDENTIAL_LOSS_CONFIRM_WINDOW_MS);
    assert.ok(during.length >= 1);
    assert.equal(during[0]?.state, "credential_check");
    assert.equal(
      during[0]?.credentialStopAt,
      new Date(clock.startMs + CREDENTIAL_LOSS_CONFIRM_WINDOW_MS).toISOString(),
    );
    const checking = renderListenerStatus(during[0]!);
    assert.match(checking, /^Listener credential check /);
    assert.match(checking, /The server refused this credential/);
    assert.match(checking, new RegExp(CONFIRMED_CREDENTIAL_LOSS_CODES.join(" or ")));
    assert.match(checking, /will stop at /);
    assert.match(checking, /a transient answer extends the check window/);
    assert.match(checking, /Run cswarm whoami with this credential/);
    assert.equal(status.state, "failed");
    assert.equal(status.lastErrorCode, "credential_stopped");
    assert.equal(status.credentialCheckEdge, "read");
    const rendered = renderListenerStatus(status);
    assert.match(rendered, /^Listener failed /);
    assert.match(rendered, /will not retry/);
    assert.match(rendered, /server refused this credential/);
    assert.match(rendered, /unauthenticated or forbidden/);
    assert.doesNotMatch(rendered, /listener_claim_throughput_lapse/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a confirmed credential loss then a successful read keeps the listener running", async () => {
  const clock = advancingClock();
  const root = await mkdtemp(join(tmpdir(), "cswarm-credential-recover-"));
  try {
    const target = listenerPaths({
      profileId: "profile-credential-recover",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: root,
    });
    let reads = 0;
    let running: ListenerStatus | null = null;
    const status = await runListenerSupervisor({
      paths: target,
      profileId: "profile-credential-recover",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      now: clock.now,
      run: async (signal, onEvent) => runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"),
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        credentialSession: { async bearer() { return "token"; } },
        store: new MemoryStore(),
        model: new FakeModel(),
        signal,
        onEvent,
        now: clock.now,
        sleep: async (ms, sleepSignal) => {
          if (reads >= 2 && running === null) {
            running = await queryListenerControl(target, "status");
            await queryListenerControl(target, "stop");
          }
          await clock.sleep(ms, sleepSignal);
        },
        readPage: async () => {
          reads += 1;
          if (reads === 1) throw forbiddenRead();
          return page([]);
        },
      }),
    });
    assert.ok(reads >= 2);
    const observed = running as ListenerStatus | null;
    assert.ok(observed, "the listener did not become ready again");
    assert.equal(observed.state, "ready");
    assert.equal(observed.credentialStopAt ?? null, null);
    assert.equal(status.state, "stopped");
    assert.notEqual(status.lastErrorCode, "credential_stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a transient failure during a credential check keeps the window going", async () => {
  const clock = advancingClock();
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    now: clock.now,
    sleep: clock.sleep,
    readPage: async () => {
      reads += 1;
      if (reads === 2) throw new SignalHttpError(500);
      throw forbiddenRead();
    },
  });
  assert.equal(stop.reason, "credential");
  assert.equal(reads, CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS + 1);
  assert.ok(clock.elapsed() > CREDENTIAL_LOSS_CONFIRM_WINDOW_MS);
});

test("cswarm listen stop ends a credential check at once", async () => {
  const clock = advancingClock();
  const root = await mkdtemp(join(tmpdir(), "cswarm-credential-stop-now-"));
  try {
    const target = listenerPaths({
      profileId: "profile-credential-stop-now",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: root,
    });
    let reads = 0;
    let asked = false;
    const status = await runListenerSupervisor({
      paths: target,
      profileId: "profile-credential-stop-now",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      now: clock.now,
      run: async (signal, onEvent) => runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"),
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        credentialSession: { async bearer() { return "token"; } },
        store: new MemoryStore(),
        model: new FakeModel(),
        signal,
        onEvent,
        now: clock.now,
        sleep: async (ms, sleepSignal) => {
          if (!asked) {
            asked = true;
            await queryListenerControl(target, "stop");
          }
          await clock.sleep(ms, sleepSignal);
        },
        readPage: async () => {
          reads += 1;
          throw forbiddenRead();
        },
      }),
    });
    assert.equal(reads, 1);
    assert.equal(status.state, "stopped");
    assert.notEqual(status.lastErrorCode, "credential_stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command-edge forbidden is not a confirmed credential loss", async () => {
  const clock = advancingClock();
  const controller = new AbortController();
  const journal = new MemoryDeliveryJournal();
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: clock.now,
    sleep: async (ms, sleepSignal) => {
      await clock.sleep(ms, sleepSignal);
    },
    readPage: async () => durablePage([], 0),
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims >= 4) controller.abort();
        throw new DeliveryHttpError(
          403,
          "forbidden",
          "delivery command failed (HTTP 403): forbidden",
        );
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(claims >= 4);
  assert.ok(clock.elapsed() < CREDENTIAL_LOSS_CONFIRM_WINDOW_MS);
});

test("real signal read HTTP codes enter the listener confirmation window", { timeout: 15_000 }, async () => {
  for (const [status, code] of [[401, "unauthenticated"], [403, "forbidden"]] as const) {
    const controller = new AbortController();
    const events: ListenerRuntimeEvent[] = [];
    let reads = 0;
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(),
      model: new FakeModel(),
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      fetcher: (async () => {
        reads += 1;
        return new Response(JSON.stringify({ error: code }), {
          status, headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      sleep: async () => { controller.abort(); },
    });
    assert.equal(stop.reason, "cancelled", `${status} must not stop at once`);
    assert.equal(reads, 1);
    assert.equal(events.filter((event) => event.type === "credential_check").length, 1);
  }
  const controller = new AbortController();
  let reads = 0;
  const bare = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    fetcher: (async () => {
      reads += 1;
      if (reads === 2) controller.abort();
      return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    sleep: async () => {},
  });
  assert.equal(bare.reason, "cancelled");
  assert.equal(reads, 2, "bare 403 retries");
});

test("claim-only delivery refusals force a read and expose revocation", { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  const journal = new MemoryDeliveryJournal();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    readPage: async () => {
      reads += 1;
      if (reads === 1) return durablePage([], 1);
      throw new SignalHttpError(403, null, { error: "forbidden", requestId: null, retryable: null });
    },
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        throw new DeliveryHttpError(403, "delivery_unavailable", "delivery unavailable");
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    sleep: async (_ms, signal) => {
      if (events.some((event) => event.type === "credential_check")) controller.abort();
      if (signal?.aborted) return;
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claims, LISTENER_CLAIM_REFUSALS_BEFORE_READ);
  assert.equal(reads, 2);
  assert.equal(events.filter((event) => event.type === "claim_retry").length, claims);
  assert.ok(events.some((event) => event.type === "credential_check"));
});

test("claim retry reports the actual wait during a credential check window", { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  const journal = new MemoryDeliveryJournal();
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let current = start;
  let claims = 0;
  let retryDelay: number | null = null;
  let observedWait: number | null = null;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID, listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal, credentialSession: { expiry: start + 20 * 60_000,
      async bearer() { return "token"; } }, store: new MemoryStore(), model: new FakeModel(),
    signal: controller.signal, now: () => current,
    onEvent: (event) => { if (event.type === "claim_retry") retryDelay = event.delayMs; },
    readPage: async () => durablePage([], 1),
    deliveryClient: {
      async claimAgentInbox() {
        claims++;
        if (claims === 1) throw new DeliveryHttpError(401, "unauthenticated", "credential refused");
        throw new DeliveryHttpError(503, "delivery_unavailable", "delivery unavailable");
      },
      async ackAgentDelivery() { throw new Error("ack must not run"); },
    },
    sleep: async (ms) => {
      if (retryDelay !== null) {
        observedWait = ms;
        controller.abort();
      }
      current += ms;
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claims, 2);
  assert.equal(retryDelay, RENEWAL_WINDOW_RETRY_MS);
  assert.equal(observedWait, retryDelay);
});

test("claim backoff reaches its cap across successful forced reads", { timeout: 15_000 }, async () => {
  for (const [httpStatus, code] of [[503, "delivery_unavailable"], [403, "forbidden"]] as const) {
    const root = await mkdtemp(join(tmpdir(), "cswarm-claim-backoff-"));
    try {
      const target = listenerPaths({
        profileId: `profile-claim-${httpStatus}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        stateDirectory: root,
      });
      const clock = advancingClock();
      const journal = new MemoryDeliveryJournal();
      const delays: number[] = [];
      const during: ListenerStatus[] = [];
      const events: ListenerRuntimeEvent[] = [];
      let pendingRetryDelay: number | null = null;
      let reads = 0;
      let lastReadAt: number | null = null;
      const final = await runListenerSupervisor({
        paths: target,
        profileId: `profile-claim-${httpStatus}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        now: clock.now,
        run: (signal, onEvent) => runListenerRuntime({
          target: cloudTarget("https://cloud.example.test", "anon"),
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          listenerInstanceId: journal.record.listenerInstanceId,
          deliveryJournal: journal,
          credentialSession: { async bearer() { return "token"; } },
          store: new MemoryStore(),
          model: new FakeModel(),
          signal,
          now: clock.now,
          random: () => 1,
          onEvent: (event) => {
            events.push(event);
            if (event.type === "claim_retry") pendingRetryDelay = event.delayMs;
            onEvent(event);
          },
          readPage: async () => { reads += 1; lastReadAt = clock.now(); return durablePage([], 1); },
          deliveryClient: {
            async claimAgentInbox() {
              assert.ok(lastReadAt !== null && clock.now() - lastReadAt >= LISTENER_REQUEST_WAIT_FLOOR_MS);
              throw new DeliveryHttpError(httpStatus, code, code);
            },
            async ackAgentDelivery() { throw new Error("ack must not run"); },
          },
          sleep: async (ms, sleepSignal) => {
            if (pendingRetryDelay !== null) {
              assert.equal(ms, pendingRetryDelay);
              pendingRetryDelay = null;
              delays.push(ms);
              during.push(await queryListenerControl(target, "status"));
            } else {
              assert.ok(ms >= LISTENER_REQUEST_WAIT_FLOOR_MS);
            }
            await clock.sleep(ms, sleepSignal);
            if (delays.length === 8) await queryListenerControl(target, "stop");
          },
        }),
      });
      assert.equal(final.state, "stopped");
      assert.ok(reads >= 3, "forced reads must continue to succeed");
      assert.deepEqual(delays, [1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
      assert.equal(Math.max(...delays), LISTENER_DELIVERY_RETRY_MAX_MS);
      assert.ok(during.every((status) => status.state === "claim_retry"));
      assert.deepEqual(during.map((status) => status.claimRetryCount), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.equal(events.filter((event) => event.type === "claim_retry_cleared").length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a failed forced read replaces the stale claim retry time", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-forced-read-status-"));
  try {
    const target = listenerPaths({ profileId: "forced-read-status", workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID, stateDirectory: root });
    const clock = advancingClock();
    const journal = new MemoryDeliveryJournal();
    let reads = 0;
    let observed: ListenerStatus | null = null;
    const final = await runListenerSupervisor({
      paths: target, profileId: "forced-read-status", workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID, targetUrl: "https://cloud.example.test", now: clock.now,
      run: (signal, onEvent) => runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"),
        workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
        listenerInstanceId: journal.record.listenerInstanceId, deliveryJournal: journal,
        credentialSession: { async bearer() { return "token"; } },
        store: new MemoryStore(), model: new FakeModel(), signal, now: clock.now,
        random: () => 1, onEvent,
        readPage: async () => {
          reads += 1;
          if (reads === 1) return durablePage([], 1);
          throw new SignalHttpError(503);
        },
        deliveryClient: {
          async claimAgentInbox() { throw new DeliveryHttpError(503, "temporarily_unavailable", "outage"); },
          async ackAgentDelivery() { throw new Error("ack must not run"); },
        },
        sleep: async (ms, sleepSignal) => {
          const status = await queryListenerControl(target, "status");
          if (status.lastRetryEdge === "read") {
            observed = status;
            await queryListenerControl(target, "stop");
          }
          await clock.sleep(ms, sleepSignal);
        },
      }),
    });
    assert.equal(final.state, "stopped");
    assert.ok(observed);
    const status = observed as ListenerStatus;
    assert.equal(status.state, "claim_retry");
    assert.equal(status.lastErrorCode, "http_503");
    assert.ok(Date.parse(status.nextAttemptAt!) > Date.parse(status.updatedAt));
    assert.match(renderListenerStatus(status), /^Listener retrying /);
    assert.match(renderListenerStatus(status), /https:\/\/cloud\.example\.test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup read failures name the cause and next attempt while retrying", { timeout: 15_000 }, async () => {
  for (const scenario of [
    { code: "http_400", status: 400 },
    { code: "http_404", status: 404 },
    { code: "http_426", status: 426 },
    { code: "malformed_response", status: 200 },
    { code: "sender_relation_capability_missing", status: null },
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "cswarm-start-read-"));
    try {
      const target = listenerPaths({
        profileId: `profile-${scenario.code}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        stateDirectory: root,
      });
      const clock = advancingClock();
      let retry: ListenerStatus | null = null;
      const final = await runListenerSupervisor({
        paths: target,
        profileId: `profile-${scenario.code}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        now: clock.now,
        run: (signal, onEvent) => runListenerRuntime({
          target: cloudTarget("https://cloud.example.test", "anon"),
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          credentialSession: { async bearer() { return "token"; } },
          store: new MemoryStore(),
          model: new FakeModel(),
          signal,
          now: clock.now,
          onEvent,
          random: () => 1,
          ...(scenario.status === null
            ? { readPage: async () => page([], { capabilities: {
              senderOwnerRelation: false, cursorAfter: true,
              deliveryClaim: false, deliveryAck: false,
            } }) }
            : { fetcher: (async () => new Response(
              scenario.status === 200 ? "<html>wrong backend</html>" : "{}",
              { status: scenario.status, headers: {
                "content-type": scenario.status === 200 ? "text/html" : "application/json",
              } },
            )) as typeof fetch }),
          sleep: async (ms) => {
            retry = await queryListenerControl(target, "status");
            assert.ok(ms > 0);
            await queryListenerControl(target, "stop");
          },
        }),
      });
      assert.equal(final.state, "stopped");
      const observed = retry as ListenerStatus | null;
      assert.ok(observed);
      assert.equal(observed.state, "starting");
      assert.equal(observed.lastErrorCode, scenario.code);
      assert.ok(observed.nextAttemptAt);
      assert.equal(observed.readHealth?.currentEpisodeAttempts, 1);
      assert.match(renderListenerStatus(observed), new RegExp(scenario.code));
      assert.match(renderListenerStatus(observed), /Check the target URL and|Leave the listener running/);
      assert.match(listenerStartPendingMessage(observed), new RegExp(scenario.code));
      assert.match(listenerStartPendingMessage(observed), /target URL/);
      if (scenario.code === "sender_relation_capability_missing") {
        assert.match(listenerStartPendingMessage(observed), /update\/deploy the read edge before starting a model/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("foreign read responses retry with bounded sleep instead of a permanent stop", { timeout: 15_000 }, async () => {
  for (const [status, body] of [
    [400, "{}"], [404, "{}"], [405, "<html>wrong backend</html>"],
    [408, "{}"], [409, "{}"], [413, "{}"], [421, "{}"],
    [422, "{}"], [426, "{}"], [200, "<html>wrong backend</html>"],
  ] as const) {
    const controller = new AbortController();
    let requests = 0;
    let sleeps = 0;
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(),
      model: new FakeModel(),
      signal: controller.signal,
      fetcher: (async () => {
        requests += 1;
        return new Response(body, { status, headers: { "content-type": status === 200 ? "text/html" : "application/json" } });
      }) as typeof fetch,
      sleep: async (ms) => {
        assert.ok(ms > 0 && ms <= 30_000);
        sleeps += 1;
        controller.abort();
      },
    });
    assert.equal(stop.reason, "cancelled", `HTTP ${status}`);
    assert.equal(requests, 1);
    assert.equal(sleeps, 1);
  }
});

test("foreign claim answers retry with a named next attempt and recover", { timeout: 15_000 }, async () => {
  for (const scenario of [
    { status: 200, body: "<html>wrong host</html>", code: "malformed_response" },
    { status: 404, body: '{"error":"missing_route"}', code: "http_404" },
    { status: 401, body: '{"error":"session_expired"}', code: "session_expired" },
    { status: 409, body: '{"error":"session_conflict"}', code: "session_conflict" },
    { status: 401, body: '{"error":"session_proof_missing"}', code: "session_proof_missing" },
    { status: 401, body: '{"error":"session_proof_invalid"}', code: "session_proof_invalid" },
    { status: 400, body: '{"error":"missing_route"}', code: "http_400" },
    ...[405, 408, 409, 413, 421, 422].map((status) => ({
      status, body: "<html>wrong host</html>", code: `http_${status}`,
    })),
    ...["session_proof_missing", "session_proof_invalid", "session_expired"].map((code) => ({
      status: 401, body: JSON.stringify({ error: code }), code,
    })),
    { status: 409, body: '{"error":"session_conflict"}', code: "session_conflict" },
    { status: 200, body: '{"status":"other","ok":true}', code: "malformed_response" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "cswarm-foreign-claim-"));
    try {
      const paths = listenerPaths({ profileId: `foreign-${scenario.status}-${scenario.code}`, workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, stateDirectory: root });
      const journal = new MemoryDeliveryJournal();
      const clock = advancingClock();
      const observed: ListenerStatus[] = [];
      let retryPending = false;
      let stopRequest: Promise<unknown> | null = null;
      const events: ListenerRuntimeEvent[] = [];
      let claims = 0;
      let reads = 0;
      const final = await runListenerSupervisor({
        paths,
        profileId: `foreign-${scenario.status}-${scenario.code}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        now: clock.now,
        run: (signal, onEvent) => runListenerRuntime({
          target: cloudTarget("https://cloud.example.test", "anon"),
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          listenerInstanceId: journal.record.listenerInstanceId,
          deliveryJournal: journal,
          credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
          store: new MemoryStore(),
          model: new FakeModel(),
          signal,
          now: clock.now,
          random: () => 1,
          onEvent: (event) => {
            events.push(event);
            if (event.type === "claim_retry") retryPending = true;
            onEvent(event);
            if (event.type === "delivery_claim" && claims === 2) stopRequest = queryListenerControl(paths, "stop");
          },
          readPage: async () => { reads += 1; return durablePage([], 1); },
          fetcher: (async () => {
            claims += 1;
            return claims === 1
              ? new Response(scenario.body, { status: scenario.status })
              : new Response(JSON.stringify({ status: "accepted", ok: true, capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 }, deliveries: [], pending_delivery_count: 0, terminal_delivery_failure_count: 0 }), { status: 200 });
          }) as typeof fetch,
          sleep: async (ms, sleepSignal) => {
            if (stopRequest !== null) await stopRequest;
            if (retryPending) {
              observed.push(await queryListenerControl(paths, "status"));
              retryPending = false;
            }
            await clock.sleep(ms, sleepSignal);
          },
        }),
      });
      assert.equal(final.state, "stopped");
      assert.equal(claims, 2);
      assert.ok(reads >= 1);
      assert.equal(events.filter((event) => event.type === "claim_retry").length, 1);
      assert.equal(observed[0]?.state, "claim_retry");
      assert.equal(observed[0]?.lastErrorCode, scenario.code);
      assert.ok(observed[0]?.nextAttemptAt);
      assert.match(renderListenerStatus(observed[0]!), /will try again at/);
      if (scenario.code.startsWith("session_")) {
        assert.match(renderListenerStatus(observed[0]!), /Start or renew the seat's session, or stop the listener/);
        assert.match(renderListenerStatus(observed[0]!), /CONNECTED: no/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("push wake retries a foreign claim without a preceding read", { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  let current = Date.parse("2026-09-22T22:00:00.000Z");
  const claimTimes: number[] = [];
  const journal = new MemoryDeliveryJournal();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  let claims = 0;
  const wake = {
    hasTopic: true,
    snapshot: () => ({ mode: "push", subscribedAt: "2026-09-22T22:00:00.000Z", reconnects: 0, lastWakeAt: null, lastReconcileAt: null, errorCode: null, topicRotatedAt: null, rateLimited: false }),
    next: async () => "wake",
    coalescingRemainingMs: () => 0,
    noteClaim() {}, noteWakeClaim() {}, noteReconcile() {}, markRateLimited() {},
    close: async () => {},
  } as unknown as NonNullable<Parameters<typeof runListenerRuntimeActual>[0]["wake"]>;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    now: () => current,
    wake,
    random: () => 1,
    readPage: async () => { reads += 1; return durablePage([], 1); },
    onEvent: (event) => { events.push(event); if (event.type === "delivery_claim" && claims === 3) controller.abort(); },
    fetcher: (async () => {
      claimTimes.push(current);
      current += 20;
      claims += 1;
      return claims === 2
        ? new Response('{"error":"missing_route"}', { status: 400 })
        : new Response(JSON.stringify({ status: "accepted", ok: true, capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 }, deliveries: [], pending_delivery_count: 0, terminal_delivery_failure_count: 0 }), { status: 200 });
    }) as typeof fetch,
    sleep: async (ms) => { assert.ok(ms >= LISTENER_REQUEST_WAIT_FLOOR_MS && ms <= LISTENER_DELIVERY_RETRY_MAX_MS); current += ms; },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(reads, 1);
  assert.equal(claims, 3);
  for (let i = 1; i < claimTimes.length; i++) {
    assert.ok(claimTimes[i]! - claimTimes[i - 1]! >= LISTENER_REQUEST_WAIT_FLOOR_MS);
  }
  assert.equal(events.find((event) => event.type === "claim_retry")?.code, "http_400");
});

test("a push wake that begins before renewal is due ends at the six-minute lead", { timeout: 15_000 }, async () => {
  const expiry = Date.parse("2026-07-30T01:00:00.000Z");
  const dueAt = expiry - 6 * 60_000;
  let current = dueAt - 5_000;
  const controller = new AbortController();
  const journal = new MemoryDeliveryJournal();
  const wakeWaits: Array<{ startedAt: number; until: number }> = [];
  const renewalTimes: number[] = [];
  const session = await AgentCredentialSession.open({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: expiry },
    store: renewalMemoryStore(), listenerMode: true, now: () => current, warn: () => {},
    fetcher: (async () => {
      renewalTimes.push(current);
      controller.abort();
      return new Response('{"error":"internal_error"}', { status: 500 });
    }) as typeof fetch,
  });
  assert.equal(session.renewalAt, dueAt);
  const wake = {
    hasTopic: true,
    snapshot: () => ({ mode: "push", subscribedAt: new Date(current).toISOString(), reconnects: 0,
      lastWakeAt: null, lastReconcileAt: null, errorCode: null, topicRotatedAt: null, rateLimited: false }),
    next: async ({ until }: { until: number }) => {
      wakeWaits.push({ startedAt: current, until });
      current = until;
      return "deadline";
    },
    coalescingRemainingMs: () => 0,
    noteClaim() {}, noteWakeClaim() {}, noteReconcile() {}, markRateLimited() {},
    close: async () => {},
  } as unknown as NonNullable<Parameters<typeof runListenerRuntimeActual>[0]["wake"]>;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID, listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal, credentialSession: session, store: new MemoryStore(),
    model: new FakeModel(), signal: controller.signal, now: () => current, wake,
    readPage: async () => durablePage([], 1),
    fetcher: (async () => new Response(JSON.stringify({ status: "accepted", ok: true,
      capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
      deliveries: [], pending_delivery_count: 0, terminal_delivery_failure_count: 0 }), { status: 200 })) as typeof fetch,
    sleep: async (ms) => { current += ms; },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(wakeWaits.length, 1);
  assert.ok(wakeWaits[0]!.startedAt < dueAt);
  assert.equal(wakeWaits[0]!.until, dueAt);
  assert.equal(renewalTimes.length, 1);
  assert.ok(renewalTimes[0]! >= dueAt && renewalTimes[0]! <= dueAt + LISTENER_REQUEST_WAIT_FLOOR_MS);
});

test("malformed read overflow and delivery marker retry", { timeout: 15_000 }, async () => {
  for (const body of [
    { signals: [{}, {}, {}, {}], capabilities: { sender_owner_relation: 1, cursor_after: 1 } },
    { signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1, delivery_claim: 2 } },
    { signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1, delivery_claim: 1, delivery_ack: 1 }, pending_delivery_count: "bad" },
  ]) {
    const controller = new AbortController();
    const events: ListenerRuntimeEvent[] = [];
    let reads = 0;
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(),
      model: new FakeModel(),
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      fetcher: (async () => {
        reads += 1;
        if (reads === 2) controller.abort();
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
      sleep: async (ms) => { assert.ok(ms > 0 && ms <= 30_000); },
    });
    assert.equal(stop.reason, "cancelled");
    assert.equal(reads, 2);
    assert.equal(events.find((event) => event.type === "read_retry")?.code, "malformed_response");
  }
});

test("foreign ACK answers retry and recover with a named next attempt", { timeout: 15_000 }, async () => {
  for (const scenario of [
    { status: 200, body: "<html>wrong host</html>", code: "malformed_response" },
    { status: 404, body: '{"error":"missing_route"}', code: "http_404" },
    ...DELIVERY_SESSION_PROOF_CODES.map((code) => ({
      status: code === "session_conflict" ? 409 : 401,
      body: JSON.stringify({ error: code }), code,
    })),
  ]) {
    const root = await mkdtemp(join(tmpdir(), "cswarm-foreign-ack-"));
    try {
      const paths = listenerPaths({ profileId: `ack-${scenario.code}`, workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, stateDirectory: root });
      const directNote = note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18", "2026-07-30T00:00:01.000Z");
      const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
      const journal = new MemoryDeliveryJournal(active);
      const store = new MemoryStore();
      await store.write(newObservedNoteRecord({ signalId: directNote.id, body: directNote.body, until: directNote.until, senderOwnerRelation: "same_owner", updatedAt: "2026-07-30T00:00:02.000Z" }));
      const clock = advancingClock("2026-07-30T00:00:30.000Z");
      const observed: ListenerStatus[] = [];
      let retryPending = false;
      let stopRequest: Promise<unknown> | null = null;
      let acks = 0;
      const final = await runListenerSupervisor({
        paths,
        profileId: `ack-${scenario.code}`,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        now: clock.now,
        run: (signal, onEvent) => runListenerRuntime({
          target: cloudTarget("https://cloud.example.test", "anon"),
          workspaceId: WORKSPACE_ID,
          principalId: PRINCIPAL_ID,
          listenerInstanceId: journal.record.listenerInstanceId,
          deliveryJournal: journal,
          credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
          store,
          model: new FakeModel(),
          signal,
          now: clock.now,
          random: () => 1,
          onEvent: (event) => {
            if (event.type === "ack_retry") retryPending = true;
            onEvent(event);
            if (event.type === "delivery_ack") stopRequest = queryListenerControl(paths, "stop");
          },
          readPage: async () => durablePage([], 1),
          fetcher: (async () => {
            acks += 1;
            return acks === 1
              ? new Response(scenario.body, { status: scenario.status })
              : new Response(JSON.stringify({ status: "accepted", ok: true, signal_id: directNote.id, outcome: "observed" }), { status: 200 });
          }) as typeof fetch,
          sleep: async (ms, sleepSignal) => {
            if (stopRequest !== null) await stopRequest;
            if (retryPending) {
              observed.push(await queryListenerControl(paths, "status"));
              retryPending = false;
            }
            await clock.sleep(ms, sleepSignal);
          },
        }),
      });
      assert.equal(final.state, "stopped");
      assert.equal(acks, 2);
      assert.equal(journal.record.active, null);
      assert.equal(observed[0]?.state, "ack_retry");
      assert.equal(observed[0]?.lastErrorCode, scenario.code);
      assert.ok(observed[0]?.nextAttemptAt);
      const sentence = renderListenerStatus(observed[0]!);
      if (scenario.code.startsWith("session_")) {
        assert.match(sentence, new RegExp(`${scenario.code}.*Start or renew the seat's session, or stop the listener`));
      } else {
        assert.match(sentence, /delivery acknowledgement failed.*will try again at/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("repeated ACK failures force a read without resetting ACK backoff", { timeout: 15_000 }, async () => {
  const directNote = note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19", "2026-07-30T00:00:01.000Z");
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({ signalId: directNote.id, body: directNote.body, until: directNote.until, senderOwnerRelation: "same_owner", updatedAt: "2026-07-30T00:00:02.000Z" }));
  const controller = new AbortController();
  const clock = advancingClock("2026-07-30T00:00:30.000Z");
  const sleeps: number[] = [];
  let pendingAckRetryDelay: number | null = null;
  let reads = 0;
  let acks = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    credentialSession: { async bearer() { return "token"; } },
    store, model: new FakeModel(), signal: controller.signal,
    now: clock.now, random: () => 1,
    onEvent: (event) => { if (event.type === "ack_retry") pendingAckRetryDelay = event.delayMs; },
    readPage: async () => { reads += 1; return durablePage([], 1); },
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        acks += 1;
        throw new DeliveryHttpError(503, "temporarily_unavailable", "outage");
      },
    },
    sleep: async (ms, signal) => {
      if (pendingAckRetryDelay !== null) {
        assert.equal(ms, pendingAckRetryDelay);
        pendingAckRetryDelay = null;
        sleeps.push(ms);
        if (sleeps.length === 4) controller.abort();
      } else {
        assert.ok(ms >= LISTENER_REQUEST_WAIT_FLOOR_MS);
      }
      await clock.sleep(ms, signal);
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(acks, 4);
  assert.ok(reads >= 2, `reads=${reads}`);
  assert.deepEqual(sleeps.slice(0, 4), [1_000, 1_000, 2_000, 4_000]);
});

test("repeated ACK failures let the read edge open the credential window", { timeout: 15_000 }, async () => {
  const directNote = note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20", "2026-07-30T00:00:01.000Z");
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({ signalId: directNote.id, body: directNote.body, until: directNote.until, senderOwnerRelation: "same_owner", updatedAt: "2026-07-30T00:00:02.000Z" }));
  const controller = new AbortController();
  const clock = advancingClock("2026-07-30T00:00:30.000Z");
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  let acks = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId, deliveryJournal: journal,
    credentialSession: { async bearer() { return "token"; } },
    store, model: new FakeModel(), signal: controller.signal,
    now: clock.now, random: () => 1,
    onEvent: (event) => events.push(event),
    readPage: async () => {
      reads += 1;
      if (reads === 1) return durablePage([], 1);
      throw new SignalHttpError(403, null, { error: "forbidden", requestId: null, retryable: null });
    },
    deliveryClient: {
      async claimAgentInbox() { throw new Error("claim must not run"); },
      async ackAgentDelivery() {
        acks += 1;
        throw new DeliveryHttpError(503, "temporarily_unavailable", "outage");
      },
    },
    sleep: async (ms, signal) => {
      if (events.some((event) => event.type === "credential_check")) controller.abort();
      await clock.sleep(ms, signal);
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(acks, 3);
  assert.equal(reads, 2);
  assert.ok(events.some((event) => event.type === "credential_check"));
});

test("a well-formed command refusal stays fatal", { timeout: 15_000 }, async () => {
  const journal = new MemoryDeliveryJournal();
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
    store: new MemoryStore(),
    model: new FakeModel(),
    readPage: async () => durablePage([], 1),
    fetcher: (async () => {
      claims += 1;
      return new Response('{"error":"invalid_request"}', { status: 400 });
    }) as typeof fetch,
  });
  assert.equal(stop.reason, "fatal");
  assert.equal(claims, 1);
  assert.equal(isRestartableListenerStop(stop), false);
});

test("each recognized read and command refusal is fatal while foreign answers retry", { timeout: 15_000 }, async () => {
  // Independently transcribed from the read and command edge producers. A
  // missing member in the runtime constant must fail before the behavior loop.
  const readPairs = [[400, "invalid_request"], [404, "channel_not_found"]] as const;
  const commandPairs = [[400, "invalid_request"], [403, H0_SEAT_CLAIM_REFUSED_CODE],
    [409, "command_id_conflict"], [409, "delivery_ack_conflict"],
    [409, "delivery_not_surfaced"], [413, "payload_too_large"],
    [426, "upgrade_required"]] as const;
  const pairKey = ([status, code]: readonly [number, string]) => `${status}:${code}`;
  assert.deepEqual(READ_FATAL_ANSWERS.refusals.map(pairKey).sort(), readPairs.map(pairKey).sort());
  assert.deepEqual(COMMAND_FATAL_ANSWERS.refusals.map(pairKey).sort(), commandPairs.map(pairKey).sort());
  for (const [status, code] of readPairs) {
    let reads = 0;
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(), model: new FakeModel(),
      fetcher: (async () => {
        reads += 1;
        return new Response(JSON.stringify({ error: code }), { status });
      }) as typeof fetch,
    });
    assert.equal(stop.reason, "fatal", `read ${status} ${code}`);
    assert.equal(reads, 1);
    assert.equal(isRestartableListenerStop(stop), false);
  }
  for (const [status, code] of commandPairs) {
    const journal = new MemoryDeliveryJournal();
    let claims = 0;
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
      listenerInstanceId: journal.record.listenerInstanceId,
      deliveryJournal: journal,
      credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
      store: new MemoryStore(), model: new FakeModel(),
      readPage: async () => durablePage([], 1),
      fetcher: (async () => {
        claims += 1;
        return new Response(JSON.stringify({ error: code }), { status });
      }) as typeof fetch,
    });
    assert.equal(stop.reason, "fatal", `command ${status} ${code}`);
    assert.equal(claims, 1);
    assert.equal(isRestartableListenerStop(stop), false);
  }
});

test("an H0 seat claim stops with its own code and is not retried", async () => {
  const controller = new AbortController();
  const journal = new MemoryDeliveryJournal();
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model: new FakeModel(),
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims >= 3) controller.abort();
        throw new DeliveryHttpError(
          403,
          H0_SEAT_CLAIM_REFUSED_CODE,
          `delivery command failed (HTTP 403): ${H0_SEAT_CLAIM_REFUSED_CODE}`,
        );
      },
      async ackAgentDelivery() {
        throw new Error("ack must not run");
      },
    },
  });
  assert.equal(claims, 1);
  assert.equal(stop.reason, "fatal");
  if (stop.reason !== "fatal") return;
  assert.ok(stop.error instanceof ListenerH0SeatError);
  assert.equal(stop.error.code, H0_SEAT_CLAIM_REFUSED_CODE);
  assert.equal(isRestartableListenerStop(stop), false);
  const root = await mkdtemp(join(tmpdir(), "cswarm-h0-seat-"));
  try {
    const target = listenerPaths({
      profileId: "profile-h0-seat",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: root,
    });
    let runs = 0;
    const status = await runListenerSupervisor({
      paths: target,
      profileId: "profile-h0-seat",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      restart: { maxAttempts: 2, sleep: async () => undefined, random: () => 0 },
      run: async () => {
        runs += 1;
        return stop;
      },
    });
    assert.equal(runs, 1);
    assert.equal(status.state, "failed");
    assert.equal(status.lastErrorCode, H0_SEAT_CLAIM_REFUSED_CODE);
    const rendered = renderListenerStatus(status);
    assert.match(rendered, new RegExp(H0_SEAT_LISTENER_STOP_SENTENCE.replace(/[()]/g, "\\$&")));
    assert.doesNotMatch(rendered, /credential_stopped/);
    assert.equal(
      listenerFailureMessage(H0_SEAT_CLAIM_REFUSED_CODE),
      H0_SEAT_LISTENER_STOP_SENTENCE,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime drains pages, resets scan cursor, and posts stable replies", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const cursors: Array<SignalCursor | null> = [];
  const first = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "2026-07-30T00:00:01.000Z",
  );
  const second = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "2026-07-30T00:00:02.000Z",
  );
  const late = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    "2026-07-30T00:00:00.500Z",
  );
  let reads = 0;
  let bearerCalls = 0;
  const posts: Array<{ body: string; commandId: string }> = [];
  const fetcher = (async () => {
    bearerCalls += 0; // bearer is asserted separately; fetch sees no credential value.
    const body = posts.length === 0 ? "reply-aaa1" : `reply-aaa${posts.length + 1}`;
    return new Response(JSON.stringify({
      status: "accepted",
      ok: true,
      event_ids: [],
      signal: {
        ...first,
        id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${posts.length + 1}`,
        kind: "note",
        body,
        in_reply_to: first.id,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: {
      async bearer() {
        bearerCalls += 1;
        return "token";
      },
    },
    store,
    model,
    signal: controller.signal,
    pageLimit: 2,
    pollMs: 1,
    fetcher,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async ({ after }) => {
      cursors.push(after);
      reads += 1;
      if (reads === 1) return page([first, second]);
      if (reads === 2) return page([], { rawCount: 0, nextCursor: null });
      if (reads === 3) return page([late], { rawCount: 1 });
      controller.abort();
      return page([]);
    },
    poster: {
      async post({ body, commandId }) {
        bearerCalls += 1;
        posts.push({ body, commandId });
        return {
          signalId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${posts.length}`,
        };
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(cursors.slice(0, 4), [
    null,
    { created_at: second.created_at, id: second.id },
    null,
    null,
  ]);
  assert.deepEqual(model.prompts.map((item) => item.id), []);
  assert.equal(posts.length, 0);
  assert.equal(model.starts, 0);
  assert.ok(events.some((event) => event.type === "effect" && event.status === "routed_main"));
  assert.equal(events.filter((event) => event.type === "ready").length, 1);
  // Abort listener cancels immediately; finally also cancels (at least once).
  assert.ok(model.cancels >= 1);
  assert.equal(model.closes, 1);
});

test("runtime queues a page without posting a worker reply", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const callOrder: string[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: {
      async bearer() {
        callOrder.push("bearer");
        return "fresh-token";
      },
    },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    fetcher: (async () => {
      callOrder.push("fetch");
      throw new Error("listener must not post a worker reply");
    }) as typeof fetch,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page(
        reads === 1
          ? [ask(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
            "2026-07-30T00:00:01.000Z",
          )]
          : [],
      );
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
  assert.ok(callOrder.includes("bearer"));
  assert.equal(callOrder.includes("fetch"), false);
});

test("runtime abort cancels the unused model after a queued page", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) {
        return page([
          ask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", "2026-07-30T00:00:01.000Z"),
        ]);
      }
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
  assert.ok(model.cancels >= 1);
  assert.equal(model.closes, 1);
});

test("runtime emits only bounded malformed-row metadata", async () => {
  const model = new FakeModel();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async ({ onMalformedRow }) => {
      reads += 1;
      for (let index = 0; index < 5; index += 1) onMalformedRow(index);
      controller.abort();
      return page([]);
    },
  });
  assert.equal(stop.reason, "cancelled");
  const malformed = events.filter((event) => event.type === "malformed_row");
  assert.equal(malformed.length, 3);
  assert.deepEqual(
    malformed.map((event) => Object.keys(event).sort()),
    [
      ["index", "ts", "type"],
      ["index", "ts", "type"],
      ["index", "ts", "type"],
    ],
  );
});

test("default poster credential failures stop as credential with the identical error and no reply fetch", async () => {
  const families = [
    new RenewalReauthorisationRequired(
      "horizon_reached",
      null,
      "renewal reauthorisation required",
    ),
    new RenewalRevoked("forbidden", "credential revoked"),
    new LocalCredentialSecretAbsentError("reply credential secret is absent from the store"),
  ] as const;
  for (const [index, thrown] of families.entries()) {
    const model = new FakeModel();
    const store = new MemoryStore();
    let bearerCalls = 0;
    let fetchCalls = 0;
    const theAsk = ask(
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac${index}`,
      "2026-07-30T00:00:01.000Z",
    );
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: {
        async bearer() {
          bearerCalls += 1;
          if (bearerCalls === 1) return "token";
          throw thrown;
        },
      },
      store,
      model,
      // A reply fetch would call this; credential acquisition fails first.
      fetcher: (async () => {
        fetchCalls += 1;
        throw new Error("reply fetch must never run");
      }) as typeof fetch,
      sleep: async () => undefined,
      readPage: async () => page([theAsk]),
    });
    assert.equal(stop.reason, "credential");
    assert.equal(
      stop.reason === "credential" && stop.error,
      thrown,
      "the identical credential error must escape",
    );
    assert.equal(fetchCalls, 0, "no reply fetch may occur");
    const record = await store.read(theAsk.id);
    assert.ok(record);
    assert.equal(record.state, "routed_main");
    assert.equal(record.failureCode, null);
    assert.equal(record.postAttempts, 0);
    assert.equal(model.closes, 1);
  }
});

test("an injected poster throwing typed 401 with hostile text stops as credential, never cancelled", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad0",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new CommandHttpError(401, "server says operation cancelled");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "routed_main");
  assert.equal(record.failureCode, null);
});

test("the default-post HTTP 401/403 path queues without a worker reply post", async () => {
  for (const status of [401, 403]) {
    const model = new FakeModel();
    const store = new MemoryStore();
    const statusIds: Record<number, string> = {
      401: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04",
      403: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05",
    };
    const theAsk = ask(
      statusIds[status]!,
      "2026-07-30T00:00:01.000Z",
    );
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store,
      model,
      sleep: async () => undefined,
      readPage: async () => page([theAsk]),
      fetcher: (async () =>
        new Response(
          JSON.stringify({ message: "server says operation cancelled" }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
    });
    assert.equal(stop.reason, "cancelled", `status ${status}`);
    const record = await store.read(theAsk.id);
    assert.ok(record);
    assert.equal(record.state, "routed_main", `status ${status}`);
    assert.equal(record.failureCode, null, `status ${status}`);
  }
});

test("a trusted injected poster receives the same closed runtime credential classification", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  let scanCount = 0;
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf0",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new RenewalRevoked("forbidden", "credential revoked mid-reply");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => {
      scanCount += 1;
      if (scanCount > 1) controller.abort();
      return page([theAsk]);
    },
    poster: {
      async post() {
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "routed_main");
  assert.equal(record.failureCode, null);
});

test("an explicitly already-aborted runtime stays cancelled even for credential-shaped errors", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab00",
    "2026-07-30T00:00:01.000Z",
  );
  const thrown = new RenewalRevoked("forbidden", "credential revoked");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
    poster: {
      async post() {
        // A credential-shaped error surfaces after the caller already aborted:
        // the exact abort state is authoritative, so the stop is cancelled.
        controller.abort();
        throw thrown;
      },
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.notEqual(stop.reason, "credential");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "routed_main");
  assert.equal(record.failureCode, null);
});

test("runtime classifies noncredential secret wording only by the closed fleet convention", async () => {
  // Exact fleet wording is credential loss and stops resumable.
  const model = new FakeModel();
  const store = new MemoryStore();
  const exact = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01",
    "2026-07-30T00:00:01.000Z",
  );
  const exactStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    sleep: async () => undefined,
    readPage: async () => page([exact]),
    poster: {
      async post() {
        throw new Error("reply credential secret is absent from the store");
      },
    },
  });
  assert.equal(exactStop.reason, "cancelled");
  assert.equal((await store.read(exact.id))?.state, "routed_main");

  // Different wording is an ordinary terminal failure, not credential loss.
  const model2 = new FakeModel();
  const store2 = new MemoryStore();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const other = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02",
    "2026-07-30T00:00:01.000Z",
  );
  let reads = 0;
  const otherStop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: store2,
    model: model2,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads === 1) return page([other]);
      controller.abort();
      return page([]);
    },
    poster: {
      async post() {
        throw new Error("reply credential is missing");
      },
    },
  });
  assert.equal(otherStop.reason, "cancelled", "never a credential stop");
  const routed = events.find(
    (event) => event.type === "effect" && event.signalId === other.id,
  );
  assert.ok(routed && routed.type === "effect");
  assert.equal(routed.status, "routed_main");
});

test("the listener queues without forwarding a worker reply fetch", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03",
    "2026-07-30T00:00:01.000Z",
  );
  let requestSignal: AbortSignal | undefined;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  let reads = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    fetcher,
    sleep: async () => undefined,
    readPage: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return page(reads === 1 ? [theAsk] : []);
    },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(requestSignal, undefined, "no worker reply fetch starts");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "routed_main");
});

test("an already-aborted runtime caller never starts the reply fetch and stays resumable", async () => {
  const model = new FakeModel();
  const store = new MemoryStore();
  const controller = new AbortController();
  const theAsk = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab04",
    "2026-07-30T00:00:01.000Z",
  );
  let fetchCalls = 0;
  model.prompt = async () => {
    controller.abort();
    return { message: "reply", stopReason: "end_turn" as const };
  };
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store,
    model,
    signal: controller.signal,
    fetcher: (async () => {
      fetchCalls += 1;
      throw new Error("no reply fetch after an already-aborted caller");
    }) as typeof fetch,
    sleep: async () => undefined,
    readPage: async () => page([theAsk]),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(fetchCalls, 0, "no reply fetch may occur");
  const record = await store.read(theAsk.id);
  assert.ok(record);
  assert.equal(record.state, "routed_main");
});

test("a restart carries the failure run, so the printed remedy cannot erase the alarm", async () => {
  /* The lapse notice tells the operator to stop and start the listener. Seeding a
     fresh run on start made following that advice delete the evidence: the next
     `observed` note then printed `HANDLED: yes` on a provider that was still dead
     -- the 17:12:52 state of the measured 2026-09-03 incident, reached by doing
     exactly what the notice said. Operator-read state is durable by default. */
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-carry-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ts = "2026-09-03T18:00:00.000Z";
  const runOnce = async (
    body: (
      onEvent: (event: ListenerRuntimeEvent) => void,
    ) => Promise<void>,
  ) =>
    await runListenerSupervisor({
      paths,
      profileId: "profile-test",
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      run: async (_signal, onEvent) => {
        onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
        await body(onEvent);
        return { reason: "cancelled" };
      },
    });

  const first = await runOnce(async (onEvent) => {
    for (const [signalId, at] of [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01", "2026-09-03T18:10:00.000Z"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02", "2026-09-03T18:11:00.000Z"],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03", "2026-09-03T18:12:00.000Z"],
    ] as const) {
      onEvent({ type: "delivery_ack", signalId, outcome: "failed_terminal", ts: at });
    }
  });
  assert.equal(first.consecutiveAckFailureCount, 3);
  assert.match(renderListenerStatus(first), /WARNING \[listener_delivery_failing\]/);

  /* The restart the notice recommends, observed BEFORE any new ack. A later ack
     would set these fields itself, so asserting them after one would not reach
     the carry at all -- measured: dropping lastAckAt from the carry left that
     version of this test green. */
  const restarted = await runOnce(async () => {});
  assert.equal(restarted.consecutiveAckFailureCount, 3);
  assert.equal(restarted.lastAckOutcome, "failed_terminal");
  assert.equal(restarted.lastAckAt, "2026-09-03T18:12:00.000Z");
  assert.equal(restarted.lastSignalId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab03");
  const restartedHuman = renderListenerStatus(restarted);
  assert.doesNotMatch(restartedHuman, /at an unknown time/);
  assert.doesNotMatch(restartedHuman, /No signal has been handled yet/);

  /* Then one incoming note. */
  const second = await runOnce(async (onEvent) => {
    onEvent({
      type: "delivery_ack",
      signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab04",
      outcome: "observed",
      ts: "2026-09-03T18:20:00.000Z",
    });
  });
  assert.equal(second.lastAckOutcome, "observed");
  assert.equal(second.consecutiveAckFailureCount, 3);
  const human = renderListenerStatus(second);
  assert.doesNotMatch(human, /HANDLED: yes/);
  assert.match(human, /WARNING \[listener_delivery_failing\]/);
  /* The ack record must carry WHOLE. Carrying the outcome without its timestamp
     printed "the newest delivery acknowledgement was ..." above "No signal has
     been handled yet." on one screen. */
  assert.equal(second.lastAckAt, "2026-09-03T18:20:00.000Z");
  assert.doesNotMatch(human, /at an unknown time/);
  assert.doesNotMatch(human, /No signal has been handled yet/);
  /* The remedy is three verbs and is untested elsewhere: `listen stop` returns
     while `stopping`, and `listen start` refuses a stopping listener, so a
     printed `stop && start` pair races. It must also not name a terminal state
     the listener may never reach -- an unclean exit lands on `failed`. */
  assert.match(human, /Next: Read the failure codes in /);
  assert.match(human, /cswarm listen stop --workspace-id [0-9a-f-]+ --principal-id [0-9a-f-]+/);
  assert.match(human, /no longer running -- state stopped or failed, not stopping/);
  assert.match(human, /confirming with: cswarm listen status --workspace-id /);
  assert.doesNotMatch(human, /listen stop[^\n]*&&[^\n]*listen start/);

  /* A real reply still clears it across the same restart boundary. */
  const third = await runOnce(async (onEvent) => {
    onEvent({
      type: "delivery_ack",
      signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab05",
      outcome: "replied",
      ts: "2026-09-03T18:30:00.000Z",
    });
  });
  assert.equal(third.consecutiveAckFailureCount, 0);
  assert.doesNotMatch(renderListenerStatus(third), /listener_delivery_failing/);
  await rm(root, { recursive: true, force: true });
});

test("the outcome sentence names the acknowledged signal, not a newer effect", async () => {
  /* lastSignalId is advanced by `effect` before the ack for that signal lands, so
     for the whole prompt window the status held an older ack's outcome beside a
     newer signal id, and printed "Last failed delivery signal: <the newer one>".
     Found by a Gemini arm on 3b245ed. */
  const root = await mkdtemp(join(tmpdir(), "cswarm-ack-signal-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ts = "2026-09-04T10:00:00.000Z";
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac01";
  const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac02";
  let midWindow: ListenerStatus | undefined;
  const status = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async (_signal, onEvent) => {
      onEvent({ type: "ready", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, ts });
      onEvent({ type: "delivery_ack", signalId: A, outcome: "failed_terminal", ts: "2026-09-04T10:01:00.000Z" });
      /* B's effect runs before B's ack: the window the sentence used to lie in. */
      onEvent({
        type: "effect",
        signalId: B,
        status: "done",
        failureCode: null,
        ts: "2026-09-04T10:02:00.000Z",
      });
      midWindow = await queryListenerControl(paths, "status");
      return { reason: "cancelled" };
    },
  });
  assert.ok(midWindow);
  assert.equal(midWindow.lastSignalId, B);
  assert.equal(midWindow.lastAckSignalId, A);
  assert.equal(midWindow.lastAckOutcome, "failed_terminal");
  const human = renderListenerStatus(midWindow);
  assert.match(human, new RegExp(`Last failed delivery signal: ${A}\\.`));
  assert.doesNotMatch(human, new RegExp(`Last failed delivery signal: ${B}`));
  /* A restart carries the ack's own signal id with the rest of the ack record. */
  assert.equal(status.lastAckSignalId, A);
  const carried = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async () => ({ reason: "cancelled" }),
  });
  assert.equal(carried.lastAckSignalId, A);
  assert.match(renderListenerStatus(carried), new RegExp(`Last failed delivery signal: ${A}\\.`));
  await rm(root, { recursive: true, force: true });
});

test("a status written before lastAckOutcome existed is not called unacknowledged", async () => {
  /* Every fleet listener at the 0.1.51 upgrade has lastAckAt and lastSignalId
     from 0.1.50 and no lastAckOutcome. Restarting it carries the timestamp and
     not the outcome, and a new CLI reading a still-running 0.1.50 listener sees
     the same shape live. Both DID acknowledge something. Found by a Grok arm on
     4992dd8. */
  const root = await mkdtemp(join(tmpdir(), "cswarm-legacy-ack-"));
  const paths = listenerPaths({
    profileId: `profile-${randomUUID()}`,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory: root,
  });
  const ackedAt = "2026-09-02T22:00:00.000Z";
  const signal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaad01";
  /* A 0.1.50-shaped file: the shape the repo's own legacy-read test uses, plus
     the six delivery keys that version wrote, and none of the new ones. */
  const legacy = {
    version: 1,
    instanceId: randomUUID(),
    provider: "claude",
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    pid: 4242,
    state: "stopped",
    startedAt: "2026-09-02T21:00:00.000Z",
    readyAt: "2026-09-02T21:00:05.000Z",
    updatedAt: ackedAt,
    stoppedAt: "2026-09-02T23:00:00.000Z",
    lastSignalId: signal,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    logPath: paths.logPath,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: null,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: ackedAt,
    lastAckAt: ackedAt,
    routeMode: "main",
  };
  await writeSecureJsonFile(paths.statusPath, JSON.stringify(legacy));

  /* The new CLI reading the old file, no restart. */
  const asRead = await readListenerStatus(paths);
  assert.ok(asRead);
  assert.equal(asRead.lastAckAt, ackedAt);
  assert.equal(asRead.lastAckOutcome, null);
  const readHuman = renderListenerStatus(asRead);
  assert.doesNotMatch(readHuman, /No delivery acknowledgement is recorded/);
  assert.match(readHuman, new RegExp(`An acknowledgement was recorded at ${ackedAt}; its outcome was not recorded\\.`));
  assert.match(readHuman, /HANDLED: not yet measured/);

  /* The restart the upgrade implies: the carry brings lastAckAt, not an outcome. */
  const restarted = await runListenerSupervisor({
    paths,
    profileId: "profile-test",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    run: async () => ({ reason: "cancelled" }),
  });
  assert.equal(restarted.lastAckAt, ackedAt);
  assert.equal(restarted.lastAckOutcome, null);
  const restartedHuman = renderListenerStatus(restarted);
  assert.doesNotMatch(restartedHuman, /No delivery acknowledgement is recorded/);
  assert.match(restartedHuman, /its outcome was not recorded\./);
  await rm(root, { recursive: true, force: true });
});

/* Head-of-line blocking, measured 2026-09-04 on the lead's own seat: one
 * open-ended ask used the whole 10-minute turn budget and every later delivery
 * to that seat waited behind it. Two of the five asks in that hour were
 * byte-identical re-sends 1 to 6 minutes apart, because nothing showed the
 * sender that the seat was busy. These three tests pin the bound, the fields
 * that make the queue visible, and the receipt the release must not destroy. */

const HOLD_FIRST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01";
const HOLD_SECOND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02";

/** A worker that consumes the whole seat budget on one signal and yields nothing. */
class SeatHoggingModel implements ListenerRuntimeModel {
  starts = 0;
  closes = 0;
  cancels = 0;
  readonly prompts: string[] = [];
  constructor(
    private readonly hogSignalId: string,
    private readonly burn: () => void,
  ) {}
  async start() {
    this.starts += 1;
  }
  async prompt(signal: SignalRecord, _mode: ListenerPromptMode) {
    this.prompts.push(signal.id);
    if (signal.id === this.hogSignalId) {
      this.burn();
      // What a wedged ACP child produces: a transient timeout, so the ask stays
      // retryable and the pre-bound loop would keep the seat for the lease.
      throw new AcpHostError("timeout", "worker turn timed out");
    }
    return {
      message: `reply-${signal.id.slice(-4)}`,
      stopReason: "end_turn" as const,
    };
  }
  cancel() {
    this.cancels += 1;
  }
  async close() {
    this.closes += 1;
  }
}

test("a claimed delivery is queued for main and does not start a model", async () => {
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const second = ask(HOLD_SECOND_ID, "2026-07-30T00:00:02.000Z");
  const holdBudgetMs = 600_000;
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let clock = start;
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const model = new SeatHoggingModel(first.id, () => {
    clock += holdBudgetMs;
  });
  let claims = 0;
  let acked: Array<{ signalId: string; outcome: DeliveryOutcome }> = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        // The lease outlasts the hold budget on purpose: without the bound the
        // seat stays on the first delivery for the whole 15-minute lease.
        const row: DeliveryRow = claims === 1
          ? {
            signal: first,
            leaseId: "55555555-5555-4555-8555-555555555b01",
            leasedUntil: "2026-07-30T00:15:00.000Z",
            senderOwnerRelation: "same_owner",
            recipientPosition: null,
            recipientCount: null,
          }
          : {
            signal: second,
            leaseId: "55555555-5555-4555-8555-555555555b02",
            leasedUntil: "2026-07-30T00:25:00.000Z",
            senderOwnerRelation: "same_owner",
            recipientPosition: null,
            recipientCount: null,
          };
        return claimResult([row], claims === 1 ? 2 : 1);
      },
      async ackAgentDelivery(request) {
        acked.push({ signalId: request.signalId, outcome: request.outcome });
        controller.abort();
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: {
      async post() {
        return { signalId: "66666666-6666-4666-8666-666666666b02" };
      },
    },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 2),
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal" ? `stopped fatally: ${stop.error.message}` : "",
  );
  // The bound, stated as the reader reads it: the second delivery reached the
  // worker, and it did so without waiting out the first delivery's lease.
  assert.deepEqual(model.prompts, []);
  assert.equal(model.starts, 0);
  const released = events.filter(
    (event): event is Extract<
      ListenerRuntimeEvent,
      { type: "delivery_hold_released" }
    > => event.type === "delivery_hold_released",
  );
  assert.equal(released.length, 0);
  assert.deepEqual(acked, [{ signalId: first.id, outcome: "queued" }]);
});

test("the released delivery is not acknowledged with any outcome", async () => {
  // Generated from the wire vocabulary, so a new outcome cannot slip past this
  // by being absent from a typed list.
  const outcomes = [...DELIVERY_ACK_OUTCOMES];
  assert.ok(outcomes.includes("observed"));
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const holdBudgetMs = 300_000;
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const model = new SeatHoggingModel(first.id, () => {
    clock += holdBudgetMs;
  });
  const ackOutcomes: string[] = [];
  let claims = 0;
  await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims > 1) {
          controller.abort();
          return claimResult([], 1);
        }
        return claimResult([{
          signal: first,
          leaseId: "55555555-5555-4555-8555-555555555b03",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        ackOutcomes.push(request.outcome);
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: { async post() { throw new Error("no reply is ready"); } },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(ackOutcomes, ["queued"]);
  assert.equal(journal.record.active, null);
  const releases = events.filter((event): event is Extract<
    ListenerRuntimeEvent,
    { type: "delivery_hold_released" }
  > => event.type === "delivery_hold_released");
  assert.equal(releases.length, 0);
  assert.equal(model.starts, 0);
});

test("listen status shows the delivery in hand and how long the queue has waited", () => {
  const claimedAt = "2026-07-30T00:00:00.000Z";
  const nowMs = Date.parse("2026-07-30T00:04:00.000Z");
  const status = {
    version: 1,
    instanceId: "44444444-4444-4444-8444-444444444444",
    pid: 4242,
    profileId: "profile-hold",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    provider: "claude",
    state: "ready",
    startedAt: claimedAt,
    readyAt: claimedAt,
    updatedAt: claimedAt,
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastErrorReasonCode: null,
    providerExecutable: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    providerBundledAgentSdkVersion: null,
    providerBundledClaudeCodeVersion: null,
    providerMinimumRequiredVersion: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 3,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: claimedAt,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    currentDeliverySignalId: HOLD_FIRST_ID,
    currentDeliverySince: claimedAt,
    heldBackDeliveries: [],
    pendingDeliveryCountAt: claimedAt,
    routeMode: "main",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    idlePollMs: 30_000,
    logPath: "/tmp/cswarm-hold/listener.log",
  } as unknown as ListenerStatus;

  const evidence = {
    pendingForMainOldestAt: null,
    hookSurfaceExists: false,
    hookSurfaceAdvanced: false,
  };
  const json = listenerStatusJson(status, undefined, evidence, nowMs);
  assert.equal(json.currentDeliverySignalId, HOLD_FIRST_ID);
  assert.equal(json.currentDeliverySince, claimedAt);
  assert.equal(json.currentDeliveryElapsedMs, 240_000);
  assert.deepEqual(json.heldBackDeliveries, []);
  assert.equal(json.heldBackDeliveryCount, 0);
  assert.equal(json.pendingDeliveryCountAt, claimedAt);

  const human = renderListenerStatus(status, evidence, nowMs);
  assert.ok(
    human.includes(idlePollStatusSentence(30_000)),
    human,
  );
  assert.equal(json.idlePollMs, 30_000);
  assert.equal(json.idlePollSentence, idlePollStatusSentence(30_000));
  assert.ok(
    human.includes(`Working on delivery ${HOLD_FIRST_ID}, claimed 4m ago.`),
    human,
  );
  // The pending count carries the age of the observation that produced it.
  assert.ok(
    human.includes(
      "Pending deliveries reported by the service: 3. The service reported that 4m ago.",
    ),
    human,
  );
  /* An undated count is named as undated. An arm reached this window by killing
     a listener after the delivery-mode event and before its first claim. */
  const undated = renderListenerStatus(
    { ...status, pendingDeliveryCountAt: null },
    evidence,
    nowMs,
  );
  assert.ok(
    undated.includes(
      "Pending deliveries reported by the service: 3. When the service reported it was not recorded.",
    ),
    undated,
  );
  /* No waiting-to-be-claimed number is rendered at all. Two review rounds
     refuted every form of it; the retired wordings are named in cli.ts. */
  assert.ok(!human.includes("waiting behind it"), human);
  assert.ok(!human.includes("waiting to be claimed"), human);
  assert.ok(!human.includes("waited at least"), human);
  assert.ok(!human.includes("empty queue"), human);

  /* Each release reason gets its own clause, generated from the constant the
     runtime emits. A typed sentence said "used its turn budget" for both, which
     is false for lease_budget: that release runs no turn at all. */
  for (const reason of LISTENER_DELIVERY_HOLD_RELEASE_REASONS) {
    const heldBack = renderListenerStatus({
      ...status,
      pendingDeliveryCount: 2,
      currentDeliverySignalId: null,
      currentDeliverySince: null,
      heldBackDeliveries: [{ signalId: HOLD_FIRST_ID, at: claimedAt, reason }],
    }, evidence, nowMs);
    assert.ok(
      heldBack.includes(
        `Delivery ${HOLD_FIRST_ID} was handed back 4m ago because ${
          LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES[reason]
        }.`,
      ),
      heldBack,
    );
    /* Past tense only: the retired clause claimed the row still sat with the
       service, which is false once the service expires and acknowledges it. */
    assert.ok(!heldBack.includes("stays with the service"), heldBack);
    /* The retired clause verbatim, not the phrase "comes back": the lease_budget
       remedy legitimately says the row comes back under a new lease. A negative
       control has to name what was retired, or it outlaws correct wording. */
    assert.ok(
      !heldBack.includes("which decides when it comes back"),
      heldBack,
    );
    assert.ok(
      heldBack.includes(
        "This listener has not answered it. After the lease ends the service either delivers it again or terminates it. If this repeats, " +
          `${LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES[reason]}.`,
      ),
      heldBack,
    );
    /* The swap control: this reason's line must NOT carry the other reason's
       remedy. A single shared remedy passed a per-reason assertion that only
       checked "the right text is present"; it fails only when the wrong text is
       also required to be absent. */
    for (const other of LISTENER_DELIVERY_HOLD_RELEASE_REASONS) {
      if (other === reason) continue;
      assert.ok(
        !heldBack.includes(LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES[other]),
        `${reason} carried the ${other} remedy: ${heldBack}`,
      );
      assert.ok(
        !heldBack.includes(LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES[other]),
        `${reason} carried the ${other} clause: ${heldBack}`,
      );
    }
    /* No command is printed. The line renders only while the listener is ready
       or stopping, and `listen start` refuses in exactly those states, so a
       start command here would be refused by the process that printed it. */
    assert.ok(!heldBack.includes("cswarm listen start"), heldBack);
    /* The retired remedy named `cswarm receipt <id>`: not runnable as printed,
       because that verb requires an agent credential, and refused even with
       one, because the receipt read is author-only and this listener is the
       recipient. A remedy that names a command the reader cannot run is the
       same defect class as a typed enumeration inside a correct sentence. */
    assert.ok(!heldBack.includes("cswarm receipt"), heldBack);
    assert.ok(!heldBack.includes("still tracking"), heldBack);
  }
  for (
    const generated of [
      LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES,
      LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES,
    ]
  ) {
    assert.equal(
      new Set(Object.values(generated)).size,
      LISTENER_DELIVERY_HOLD_RELEASE_REASONS.length,
      "each reason needs its own wording, or the sentence stops discriminating",
    );
  }
  /* Only hold_budget names a setting. --turn-budget IS the seat bound, so
     raising it is the answer there; lease_budget needs nothing changed, because
     the row returns under a new lease of full length. A shared remedy gave half
     the vocabulary advice that cannot prevent its own release. */
  assert.ok(
    LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget.includes(
      "a larger --turn-budget",
    ),
    LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget,
  );
  /* The lease is named as the point where raising stops helping, with the
     reason, NOT as a ceiling. Nothing clamps the turn budget to the lease, and
     leaseSpent refuses to start a phase rather than interrupting a running one,
     so "up to the 15 minutes the service leases it for" described a cap the
     code does not enforce. A review arm read it exactly that way. */
  assert.ok(
    LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget.includes(
      `Past the ${LISTENER_DELIVERY_MAX_LEASE_MS / 60_000} minutes the service leases a delivery for it stops helping, because the turn then outlives its lease and the reply can no longer be acknowledged.`,
    ),
    LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget,
  );
  assert.ok(
    !LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.hold_budget.includes("up to the"),
    "the lease is not a cap the code enforces",
  );
  assert.ok(
    !LISTENER_DELIVERY_HOLD_RELEASE_REMEDIES.lease_budget.includes(
      "--turn-budget",
    ),
    "a lease_budget release is not fixed by changing the turn budget",
  );

  // More than one can be held back at once, so the extras are counted.
  const twoHeldBack = renderListenerStatus({
    ...status,
    pendingDeliveryCount: 2,
    currentDeliverySignalId: null,
    currentDeliverySince: null,
    heldBackDeliveries: [
      { signalId: HOLD_SECOND_ID, at: claimedAt, reason: "hold_budget" },
      { signalId: HOLD_FIRST_ID, at: claimedAt, reason: "lease_budget" },
    ],
  }, evidence, nowMs);
  assert.ok(
    twoHeldBack.includes(
      "This listener is still tracking 1 other handed-back delivery.",
    ),
    twoHeldBack,
  );
  /* At the cap the count still describes the set, so it stays true. The retired
     wording claimed every hand-back, which a capped set cannot know. */
  const atCap = renderListenerStatus({
    ...status,
    currentDeliverySignalId: null,
    currentDeliverySince: null,
    heldBackDeliveries: Array.from({ length: 16 }, (_unused, index) => ({
      signalId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "b")}`,
      at: claimedAt,
      reason: "hold_budget" as const,
    })),
  }, evidence, nowMs);
  assert.ok(
    atCap.includes("This listener is still tracking 15 other handed-back deliveries."),
    atCap,
  );

  const idle = renderListenerStatus({
    ...status,
    pendingDeliveryCount: 0,
    currentDeliverySignalId: null,
    currentDeliverySince: null,
  }, evidence, nowMs);
  assert.ok(idle.includes("No delivery is being worked on right now."), idle);
  assert.ok(!idle.includes("was handed back"), idle);
});

test("a fast first failure keeps the seat and retries inside the hold budget", async () => {
  /* Measured on a live listener started with --turn-budget 30s: a projected
   * bound (now + one phase minimum against the deadline) released the seat
   * after 74ms, because one phase minimum is about four minutes and never fits
   * inside a 30s budget. The delivery lost its retry budget without using any
   * of its seat time. The bound is elapsed hold, so this retries. */
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const holdBudgetMs = 30_000;
  let clock = Date.parse("2026-07-30T00:00:00.000Z");
  const journal = new MemoryDeliveryJournal();
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const prompts: string[] = [];
  let failures = 0;
  const model: ListenerRuntimeModel = {
    async start() {},
    async prompt(signal: SignalRecord) {
      prompts.push(signal.id);
      failures += 1;
      if (failures === 1) {
        // A worker child that dies in milliseconds: retryable, and nowhere near
        // the seat budget.
        clock += 74;
        throw new AcpHostError("child_exit", "worker child exited");
      }
      return {
        message: `reply-${signal.id.slice(-4)}`,
        stopReason: "end_turn" as const,
      };
    },
    cancel() {},
    async close() {},
  };
  const acked: string[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        return claimResult([{
          signal: first,
          leaseId: "55555555-5555-4555-8555-555555555b04",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        acked.push(request.outcome);
        controller.abort();
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: {
      async post() {
        return { signalId: "66666666-6666-4666-8666-666666666b04" };
      },
    },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal" ? `stopped fatally: ${stop.error.message}` : "",
  );
  assert.deepEqual(prompts, []);
  assert.deepEqual(acked, ["queued"]);
  assert.equal(
    events.filter((event) => event.type === "delivery_hold_released").length,
    0,
    "74ms of a 30s seat budget is not a spent budget",
  );
});

test("a stopped listener does not claim to be working on a delivery", async (t) => {
  /* The status file outlives the process. Without clearing the held delivery on
   * the terminal transition, `cswarm listen status` on a listener that stopped
   * mid-turn reads "Working on delivery X, claimed 3h ago" about a process that
   * no longer exists. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-stop-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-stop",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-stop",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_FIRST_ID,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:00.000Z",
      });
      const held = await queryListenerControl(paths, "status");
      assert.equal(held.currentDeliverySignalId, HOLD_FIRST_ID);
      assert.equal(held.currentDeliverySince, "2026-07-30T00:00:00.000Z");
      return { reason: "cancelled" as const };
    },
  });

  const stopped = await readListenerStatus(paths);
  assert.equal(stopped?.state, "stopped");
  assert.equal(stopped?.currentDeliverySignalId, null);
  assert.equal(stopped?.currentDeliverySince, null);
  /* The held-back facts go too: their sentences are rendered against READ time,
     so a process that stopped observing three hours ago would still report on
     them in the present tense. Both review arms raised this on 33cd24b. */
  assert.deepEqual(stopped?.heldBackDeliveries, []);
  const human = renderListenerStatus(stopped!, {
    pendingForMainOldestAt: null,
    hookSurfaceExists: false,
    hookSurfaceAdvanced: false,
  }, Date.parse("2026-07-30T03:00:00.000Z"));
  assert.ok(!human.includes("Working on delivery"), human);
  assert.ok(human.includes("No delivery is being worked on right now."), human);
  assert.ok(!human.includes("was handed back"), human);
  /* The pending count survives, and its own sentence dates it: both arms said
     an undated count on a listener that died hours ago reads as current. */
  assert.ok(human.includes("The service reported that 3h ago."), human);
});

test("the supervisor tracks a handed-back delivery until it comes back", async (t) => {
  /* Not a string test: this drives the supervisor's event handling and reads
   * the live control socket, so it pins the state machine both review arms
   * attacked on 33cd24b. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-track-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-track",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  const seen: Array<{
    step: string;
    heldBack: readonly string[];
    current: string | null | undefined;
    heldBackLine: string | undefined;
  }> = [];
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-track",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      const record = async (step: string) => {
        const snapshot = await queryListenerControl(paths, "status");
        seen.push({
          step,
          heldBack: (snapshot.heldBackDeliveries ?? []).map((entry) =>
            entry.signalId
          ),
          current: snapshot.currentDeliverySignalId,
          heldBackLine: renderListenerStatus(snapshot, {
            pendingForMainOldestAt: null,
            hookSurfaceExists: false,
            hookSurfaceAdvanced: false,
          }, Date.parse("2026-07-30T00:05:00.000Z")).split("\n").find((line) =>
            line.includes("was handed back")
          ),
        });
      };
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_FIRST_ID,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:00.000Z",
      });
      await record("claimed first");
      onEvent({
        type: "delivery_hold_released",
        signalId: HOLD_FIRST_ID,
        reason: "hold_budget",
        heldMs: 600_000,
        ts: "2026-07-30T00:00:01.000Z",
      });
      await record("released first");
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_SECOND_ID,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:02.000Z",
      });
      await record("claimed second");
      /* Two live held-back leases at once: the count grows and the newest one
         is named. A review arm built exactly this sequence against a version
         that tracked one id and derived a waiting count from it. */
      onEvent({
        type: "delivery_hold_released",
        signalId: HOLD_SECOND_ID,
        reason: "lease_budget",
        heldMs: 1_000,
        ts: "2026-07-30T00:00:03.000Z",
      });
      await record("released second");
      /* An empty claim while only held-back rows are pending. The status must
         not start calling them claimable, and must not forget them either. */
      onEvent({
        type: "delivery_claim",
        signalId: null,
        pendingDeliveryCount: 2,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:04.000Z",
      });
      await record("empty claim");
      /* A zero pending count is NOT evidence that a held-back row is gone. The
         service counts unacked rows whose signal until is still live, and
         unleases only once the lease deadline passes, so a hand-back whose TTL
         elapsed under its live lease is still leased, still unacked, and not in
         that count. Both round-4 arms proved this from the SQL against a
         version that trimmed the set to the count. */
      onEvent({
        type: "delivery_claim",
        signalId: null,
        pendingDeliveryCount: 0,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:05.000Z",
      });
      await record("zero pending count");
      return { reason: "cancelled" as const };
    },
  });

  assert.deepEqual(
    seen.map((entry) => [entry.step, entry.heldBack, entry.current]),
    [
      ["claimed first", [], HOLD_FIRST_ID],
      ["released first", [HOLD_FIRST_ID], null],
      ["claimed second", [HOLD_FIRST_ID], HOLD_SECOND_ID],
      /* Both are held back at once. A version that kept only the newest id
         forgot the first one as soon as the second was reclaimed. */
      ["released second", [HOLD_SECOND_ID, HOLD_FIRST_ID], null],
      ["empty claim", [HOLD_SECOND_ID, HOLD_FIRST_ID], null],
      ["zero pending count", [HOLD_SECOND_ID, HOLD_FIRST_ID], null],
    ],
  );
  assert.ok(
    seen[3]!.heldBackLine?.includes(
      `Delivery ${HOLD_SECOND_ID} was handed back 5m ago because ${
        LISTENER_DELIVERY_HOLD_RELEASE_CLAUSES.lease_budget
      }.`,
    ),
    seen[3]!.heldBackLine,
  );
  assert.ok(
    seen[3]!.heldBackLine?.includes(
      "This listener is still tracking 1 other handed-back delivery.",
    ),
    seen[3]!.heldBackLine,
  );
  // An empty claim with rows still pending keeps them named.
  assert.equal(seen[4]!.heldBackLine, seen[3]!.heldBackLine);
  // So does a zero count: it is not evidence about a live-leased hand-back.
  assert.equal(seen[5]!.heldBackLine, seen[3]!.heldBackLine);
  // At no point is any of them described as waiting to be claimed.
  assert.equal(
    seen.some((entry) => entry.heldBackLine?.includes("waiting")),
    false,
  );
});

test("the pending count never trims the held-back set", async (t) => {
  /* An earlier version trimmed the set to the service's pending count, on the
   * argument that every held-back row is unacked so the count bounds them. Both
   * round-4 arms refuted it from the server SQL, and it is wrong in BOTH
   * directions. durable-delivery.ts step 7 counts unacked rows whose signal
   * `until > statement_timestamp()`; step 2 unleases only when
   * `leased_until <= statement_timestamp()`. So a hand-back whose TTL elapses
   * under its live lease is still leased, still unacked, and NOT counted -- a
   * low count dropped rows that were still held back, and because the set is
   * newest first the slice discarded the oldest, the one most likely to be
   * live. The count also includes rows that were never held back, so it could
   * sit above the set and trim nothing. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-trim-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-trim",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  const held: string[][] = [];
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-trim",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      const record = async () => {
        const snapshot = await queryListenerControl(paths, "status");
        held.push((snapshot.heldBackDeliveries ?? []).map((e) => e.signalId));
      };
      for (const [signalId, ts] of [
        [HOLD_FIRST_ID, "2026-07-30T00:00:00.000Z"],
        [HOLD_SECOND_ID, "2026-07-30T00:00:01.000Z"],
      ] as const) {
        onEvent({
          type: "delivery_claim",
          signalId,
          pendingDeliveryCount: 2,
          terminalDeliveryFailureCount: 0,
          ts,
        });
        onEvent({
          type: "delivery_hold_released",
          signalId,
          reason: "hold_budget",
          heldMs: 600_000,
          ts,
        });
      }
      await record();
      /* The service reports ONE unacked live row, then none. Neither number is
         evidence about either hand-back, so the set does not move. */
      for (const [pending, ts] of [
        [1, "2026-07-30T00:00:02.000Z"],
        [0, "2026-07-30T00:00:03.000Z"],
      ] as const) {
        onEvent({
          type: "delivery_claim",
          signalId: null,
          pendingDeliveryCount: pending,
          terminalDeliveryFailureCount: 0,
          ts,
        });
        await record();
      }
      /* Its OWN evidence does move it: this claim returned the older row. */
      onEvent({
        type: "delivery_claim",
        signalId: HOLD_FIRST_ID,
        pendingDeliveryCount: 1,
        terminalDeliveryFailureCount: 0,
        ts: "2026-07-30T00:00:04.000Z",
      });
      await record();
      return { reason: "cancelled" as const };
    },
  });

  assert.deepEqual(held, [
    [HOLD_SECOND_ID, HOLD_FIRST_ID],
    [HOLD_SECOND_ID, HOLD_FIRST_ID],
    [HOLD_SECOND_ID, HOLD_FIRST_ID],
    [HOLD_SECOND_ID],
  ]);
});

test("a pending count from the delivery-mode event is dated too", async (t) => {
  /* The exact arm sequence: the mode event writes pendingDeliveryCount from the
   * read page and never writes lastClaimAt, so dating the sentence from
   * lastClaimAt left this window undated. On a process killed here the line
   * read as a current count. */
  const stateDirectory = await mkdtemp(join(tmpdir(), "cswarm-hold-mode-"));
  t.after(async () => await rm(stateDirectory, { recursive: true, force: true }));
  const paths = listenerPaths({
    profileId: "profile-hold-mode",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    stateDirectory,
  });
  let duringRun: ListenerStatus | null = null;
  await runListenerSupervisor({
    paths,
    profileId: "profile-hold-mode",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    run: async (_signal, onEvent) => {
      onEvent({
        type: "delivery_mode",
        mode: "durable_claim",
        pendingDeliveryCount: 3,
        ts: "2026-07-30T00:00:00.000Z",
      });
      duringRun = await queryListenerControl(paths, "status");
      return { reason: "cancelled" as const };
    },
  });

  const observed = duringRun as ListenerStatus | null;
  assert.equal(observed?.pendingDeliveryCount, 3);
  assert.equal(observed?.lastClaimAt, null, "no claim has run yet");
  assert.equal(observed?.pendingDeliveryCountAt, "2026-07-30T00:00:00.000Z");
  const human = renderListenerStatus(observed!, {
    pendingForMainOldestAt: null,
    hookSurfaceExists: false,
    hookSurfaceAdvanced: false,
  }, Date.parse("2026-07-30T03:00:00.000Z"));
  assert.ok(
    human.includes(
      "Pending deliveries reported by the service: 3. The service reported that 3h ago.",
    ),
    human,
  );
});

test("the redelivery claim reads the same in help as in status", () => {
  /* Claim-family sweep. The status line was corrected to name both outcomes
   * after review arms showed "redelivers" is false when the signal's own TTL
   * elapsed under a live lease: the next claim expire-acknowledges it instead.
   * The help text carried the same retired claim and was not swept, which an
   * arm found on e5f75c9. */
  const help = usage();
  assert.ok(help.includes("--turn-budget"), "the flag is still documented");
  assert.ok(help.includes("--poll-interval"), "idle poll flag is documented");
  assert.ok(
    help.includes(
      "After the lease ends the service either\ndelivers the released one again or terminates it.",
    ),
    help,
  );
  assert.ok(!help.includes("the service redelivers the released one"), help);
});

test("a lease recovered across a restart keeps its original hold clock", async () => {
  /* The journal records claimCreatedAt in reserveClaim and keeps it through
   * recordLease, so the hold clock survives a restart. An earlier version
   * started it at now(), on the written claim that the original time "is not in
   * the journal" -- false, and a review arm found it. With a fresh clock a
   * delivery that had already spent its budget got the whole budget again on
   * every restart, which is how a seat bound stops being a bound.
   *
   * Anti-starvation still applies: the recovered lease gets ONE engine.process
   * because processAttempt is 0 again. The bound bites on the attempt after it,
   * with no further budget. */
  const first = ask(HOLD_FIRST_ID, "2026-07-30T00:00:01.000Z");
  const second = ask(HOLD_SECOND_ID, "2026-07-30T00:00:02.000Z");
  const holdBudgetMs = 600_000;
  // The claim happened 20 minutes before this process starts: the budget was
  // already spent by the listener that died.
  let clock = Date.parse("2026-07-30T00:20:00.000Z");
  const active = leasedActive({
    signalId: first.id,
    signal: first,
    leasedUntil: "2026-07-30T00:35:00.000Z",
  });
  const journal = new MemoryDeliveryJournal(active);
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const model = new SeatHoggingModel(first.id, () => {
    clock += 1_000;
  });
  let claims = 0;
  const acked: string[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryHoldBudgetMs: holdBudgetMs,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        return claims === 1
          ? claimResult([{
            signal: first,
            leaseId: active.leaseId!,
            leasedUntil: active.leasedUntil!,
            senderOwnerRelation: "same_owner",
            recipientPosition: null,
            recipientCount: null,
          }], 2)
          : claimResult([{
            signal: second,
            leaseId: "55555555-5555-4555-8555-555555555c02",
            // Within the server maximum lease of the clock at this moment.
            leasedUntil: "2026-07-30T00:34:00.000Z",
            senderOwnerRelation: "same_owner",
            recipientPosition: null,
            recipientCount: null,
          }], 1);
      },
      async ackAgentDelivery(request) {
        acked.push(request.signalId);
        controller.abort();
        return {
          httpStatus: 200,
          signalId: request.signalId,
          outcome: request.outcome,
        };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    poster: {
      async post() {
        return { signalId: "66666666-6666-4666-8666-666666666c02" };
      },
    },
    signal: controller.signal,
    now: () => clock,
    sleep: async () => undefined,
    readPage: async () => durablePage([], 2),
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal" ? `stopped fatally: ${stop.error.message}` : "",
  );
  const released = events.filter((event): event is Extract<
    ListenerRuntimeEvent,
    { type: "delivery_hold_released" }
  > => event.type === "delivery_hold_released");
  assert.equal(released.length, 0);
  assert.deepEqual(model.prompts, []);
  assert.deepEqual(acked, [first.id]);
});

test("a service that fans out reaches the prompt with this listener's own slot", async () => {
  /* THE LANE'S CLIENT CLAIM, end to end through the runtime rather than
   * through buildListenerPrompt alone. The fake service hands back two rows in
   * turn: one this listener holds at position 1 of a three-recipient set, and
   * one where the server reported no set at all. Both are addressed to this
   * listener's own principal, which is what the edge now answers for a
   * delivery row at any position. */
  const shared = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaf01",
    "2026-07-30T00:00:01.000Z",
  );
  const private_ = ask(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaf02",
    "2026-07-30T00:00:02.000Z",
  );
  const journal = new MemoryDeliveryJournal(null);
  const controller = new AbortController();
  const model = new FakeModel();
  let claims = 0;
  let acks = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"),
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId,
    deliveryJournal: journal,
    deliveryClient: {
      async claimAgentInbox() {
        claims += 1;
        if (claims === 1) {
          return claimResult([{
            signal: shared,
            leaseId: "55555555-5555-4555-8555-555555555f01",
            leasedUntil: "2026-07-30T00:15:00.000Z",
            senderOwnerRelation: "same_owner",
            recipientPosition: 1,
            recipientCount: 3,
          }], 2);
        }
        return claimResult([{
          signal: private_,
          leaseId: "55555555-5555-4555-8555-555555555f02",
          leasedUntil: "2026-07-30T00:15:00.000Z",
          senderOwnerRelation: "same_owner",
          recipientPosition: null,
          recipientCount: null,
        }], 1);
      },
      async ackAgentDelivery(request) {
        acks += 1;
        if (acks === 2) controller.abort();
        return { httpStatus: 200, signalId: request.signalId, outcome: request.outcome };
      },
    },
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(),
    model,
    signal: controller.signal,
    now: () => Date.parse("2026-07-30T00:02:31.000Z"),
    sleep: async () => undefined,
    readPage: async () => durablePage([], 1),
    poster: {
      async post() {
        return { signalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbf01" };
      },
    },
  });
  assert.equal(
    stop.reason,
    "cancelled",
    stop.reason === "fatal" ? `stopped fatally: ${stop.error.message}` : "",
  );
  assert.equal(acks, 2);
  assert.equal(model.prompts.length, 0);
  assert.equal(model.starts, 0);
});

test("a lease that ends a little past the maximum is tolerated as clock skew; well past is refused", async () => {
  const fixedNow = Date.parse("2026-07-30T00:00:00.000Z");
  const claimedNote = note(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa81",
    "2026-07-30T00:00:01.000Z",
  );
  const run = async (leasedUntilMs: number) => {
    const journal = new MemoryDeliveryJournal();
    const controller = new AbortController();
    let claims = 0;
    const lease: DeliveryRow = {
      signal: claimedNote,
      leaseId: "55555555-5555-4555-8555-555555555556",
      leasedUntil: new Date(leasedUntilMs).toISOString(),
      senderOwnerRelation: "same_owner",
      recipientPosition: null,
      recipientCount: null,
    };
    return await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      listenerInstanceId: journal.record.listenerInstanceId,
      deliveryJournal: journal,
      deliveryClient: {
        async claimAgentInbox() {
          claims += 1;
          if (claims === 1) return claimResult([lease], 1);
          controller.abort();
          return claimResult([], 0);
        },
        async ackAgentDelivery() {
          return { httpStatus: 200, signalId: claimedNote.id, outcome: "observed" as const };
        },
      },
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(),
      model: new FakeModel(),
      now: () => fixedNow,
      sleep: async () => {},
      signal: controller.signal,
      readPage: async () => ({
        signals: [],
        capabilities: { senderOwnerRelation: true, cursorAfter: true, deliveryClaim: true, deliveryAck: true },
        legacyCursorFallback: false,
        rawCount: 0,
        nextCursor: null,
        malformedRows: 0,
        pendingDeliveryCount: 0,
      }),
    });
  };
  // The server's clock 100 ms ahead of ours on an exactly-maximum lease: not fatal.
  const tolerated = await run(fixedNow + LISTENER_DELIVERY_MAX_LEASE_MS + 100);
  assert.notEqual(tolerated.reason, "fatal", JSON.stringify(tolerated));
  // Past the allowance the lease really is too long: fatal, same message as before.
  const refused = await run(
    fixedNow + LISTENER_DELIVERY_MAX_LEASE_MS + LISTENER_LEASE_CLOCK_SKEW_ALLOWANCE_MS + 1,
  );
  assert.equal(refused.reason, "fatal");
  assert.ok(refused.reason === "fatal" && refused.error instanceof ListenerLeaseResponseError);
  assert.equal(isRestartableListenerStop(refused), true);
  assert.match(String((refused as { error?: Error }).error?.message), /lease deadline is invalid/);
});

test("claim replay response contradictions carry the lease response tag", async () => {
  const stored = note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa87", "2026-07-30T00:00:01.000Z");
  for (const [answer, message] of [
    [claimResult([], 0), /did not return the stored lease/],
    [claimResult([{ signal: stored, leaseId: "55555555-5555-4555-8555-555555555599",
      leasedUntil: "2026-07-30T00:15:00.000Z", senderOwnerRelation: "same_owner",
      recipientPosition: null, recipientCount: null }], 1), /does not match the stored lease/],
  ] as const) {
    const journal = new MemoryDeliveryJournal(leasedActive({ signalId: stored.id, signal: stored }));
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID, listenerInstanceId: journal.record.listenerInstanceId,
      deliveryJournal: journal,
      deliveryClient: { async claimAgentInbox() { return answer; },
        async ackAgentDelivery() { throw new Error("ACK must not run"); } },
      credentialSession: { async bearer() { return "token"; } },
      store: new MemoryStore(), model: new FakeModel(),
      now: () => Date.parse("2026-07-30T00:00:30.000Z"),
      readPage: async () => durablePage([], 1), sleep: async () => {},
    });
    assert.equal(stop.reason, "fatal");
    assert.ok(stop.reason === "fatal" && stop.error instanceof ListenerLeaseResponseError);
    assert.equal(isRestartableListenerStop(stop), true);
    assert.match(stop.error.message, message);
  }
});

test("accepted claim with malformed pending count retries as a network response", { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  const journal = new MemoryDeliveryJournal();
  const events: ListenerRuntimeEvent[] = [];
  let claims = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId, deliveryJournal: journal,
    credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
    store: new MemoryStore(), model: new FakeModel(), signal: controller.signal,
    readPage: async () => durablePage([], 1), onEvent: (event) => events.push(event),
    fetcher: (async () => {
      claims++;
      if (claims === 2) controller.abort();
      return new Response(JSON.stringify({ status: "accepted", ok: true,
        capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
        deliveries: [], pending_delivery_count: "bad", terminal_delivery_failure_count: 0 }), { status: 200 });
    }) as typeof fetch,
    sleep: async (ms) => { assert.ok(ms > 0 && ms <= LISTENER_DELIVERY_RETRY_MAX_MS); },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(claims, 2);
  assert.equal(events.find((event) => event.type === "claim_retry")?.code, "malformed_response");
});

test("a full read page with malformed last row retries instead of stopping", { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let reads = 0;
  const valid = note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18", "2026-07-30T00:00:01.000Z");
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(), model: new FakeModel(), signal: controller.signal, pageLimit: 100,
    onEvent: (event) => events.push(event),
    fetcher: (async () => {
      reads++;
      if (reads === 2) controller.abort();
      return new Response(JSON.stringify({ signals: [...Array(99).fill(valid), { id: "bad" }],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 } }), { status: 200 });
    }) as typeof fetch,
    sleep: async (ms) => { assert.ok(ms > 0 && ms <= 30_000); },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(reads, 2);
  assert.equal(events.find((event) => event.type === "read_retry")?.code, "malformed_response");
});

function renewalMemoryStore(): AgentCredentialStore {
  let record: AgentCredentialRecord | null = null;
  return {
    location: "memory://listener-renewal",
    read: async () => record,
    write: async (next) => { record = next; },
    delete: async () => { record = null; },
    withLock: async (work) => work(),
  };
}

async function renewingListenerSession(now: number, fetcher: typeof fetch): Promise<AgentCredentialSession> {
  return AgentCredentialSession.open({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: now + 3 * 60_000 },
    store: renewalMemoryStore(), fetcher, listenerMode: true, now: () => now, warn: () => {},
  });
}

test("renewal window retries before expiry and a successful successor keeps the listener alive past it", { timeout: 15_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  const oldExpiry = start + 3 * 60_000;
  let current = start;
  let renewals = 0;
  let reads = 0;
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const session = await AgentCredentialSession.open({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: oldExpiry },
    store: renewalMemoryStore(), listenerMode: true, now: () => current, warn: () => {},
    fetcher: (async () => {
      renewals++;
      if (renewals < 3) return new Response('{"error":"unauthenticated"}', { status: 401 });
      return new Response(JSON.stringify({ status: "accepted", ok: true,
        agent_token: "swm_agt_" + "B".repeat(43), token_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        principal_id: PRINCIPAL_ID, run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        issued_at: new Date(current).toISOString(), expires_at: new Date(current + 60 * 60_000).toISOString() }), { status: 200 });
    }) as typeof fetch,
  });
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    credentialSession: session, store: new MemoryStore(), model: new FakeModel(), signal: controller.signal,
    now: () => current, onEvent: (event) => events.push(event),
    readPage: async () => {
      reads++;
      if (reads === 1) current = oldExpiry + 1_000;
      else controller.abort();
      return page([]);
    },
    sleep: async (ms) => { assert.ok(ms <= 30_000, `renewal waited ${ms}ms`); current += ms; },
  });
  assert.equal(stop.reason, "cancelled", stop.reason === "fatal" ? stop.error.message : undefined);
  assert.equal(renewals, 3);
  assert.ok(reads >= 2);
  assert.ok(current > oldExpiry);
  assert.ok((session.expiry ?? 0) > oldExpiry);
  assert.ok(events.some((event) => event.type === "credential_check_cleared"));
});

test("generated renewal answer orderings keep a request floor and recover", { timeout: 30_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  const failures = ["ours", "foreign", "network", "server"] as const;
  type Answer = typeof failures[number] | "success";
  const answerSequences: Answer[][] = [];
  for (let code = 0; code < failures.length ** 3; code++) {
    answerSequences.push([failures[code % 4]!, failures[Math.floor(code / 4) % 4]!,
      failures[Math.floor(code / 16) % 4]!, "success"]);
  }
  const allAnswers: Answer[] = [...failures, "success"];
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) {
    for (let d = 0; d < 5; d++) for (let e = 0; e < 5; e++) {
      if (new Set([a, b, c, d, e]).size === 5) {
        answerSequences.push([allAnswers[a]!, allAnswers[b]!, allAnswers[c]!, allAnswers[d]!, allAnswers[e]!]);
      }
    }
  }
  assert.equal(answerSequences.length, 184);
  let sequences = 0;
  for (const lifetimeMs of [180_000, 210_000, 240_000, 270_000]) {
    for (const answers of answerSequences) {
      let current = start;
      const expiry = start + lifetimeMs;
      const deadline = expiry - RENEWAL_WINDOW_EXPIRY_MARGIN_MS;
      let calls = 0;
      const requestTimes: number[] = [];
      let reads = 0;
      const controller = new AbortController();
      const session = await AgentCredentialSession.open({
        target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
        presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: expiry },
        store: renewalMemoryStore(), listenerMode: true, now: () => current, warn: () => {},
        fetcher: (async () => {
          requestTimes.push(current);
          current += 20; // A fast but nonzero round trip exposes a zero-wait retry.
          const answer = answers[Math.min(calls++, answers.length - 1)];
          if (answer === "network") throw new TypeError("network unavailable");
          if (answer === "ours") return new Response('{"error":"unauthenticated"}', { status: 401 });
          if (answer === "foreign") return new Response("<html>wrong edge</html>", { status: 401 });
          if (answer === "server") return new Response('{"error":"internal_error"}', { status: 500 });
          return new Response(JSON.stringify({ status: "accepted", ok: true,
            agent_token: "swm_agt_" + "B".repeat(43), token_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            principal_id: PRINCIPAL_ID, run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            issued_at: new Date(current).toISOString(), expires_at: new Date(current + 60 * 60_000).toISOString() }), { status: 200 });
        }) as typeof fetch,
      });
      const stop = await runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID, credentialSession: session, store: new MemoryStore(),
        model: new FakeModel(), signal: controller.signal, now: () => current,
        onEvent: (event) => {
          if (event.type === "credential_check") {
            assert.ok(event.nextAttemptAt && Date.parse(event.nextAttemptAt) - Date.parse(event.ts) >= LISTENER_REQUEST_WAIT_FLOOR_MS);
          }
          if (event.type === "read_retry") assert.ok(event.delayMs >= LISTENER_REQUEST_WAIT_FLOOR_MS);
        },
        readPage: async () => {
          assert.ok(current - requestTimes[requestTimes.length - 1]! >= LISTENER_REQUEST_WAIT_FLOOR_MS);
          reads++;
          controller.abort();
          return page([]);
        },
        sleep: async (ms) => {
          if (session.expiry === expiry && current < deadline - LISTENER_REQUEST_WAIT_FLOOR_MS) {
            assert.ok(current + ms <= deadline,
              `${answers.join(",")} at ${lifetimeMs}ms slept ${ms}ms past deadline`);
            assert.ok(ms <= RENEWAL_WINDOW_RETRY_MS,
              `${answers.join(",")} at ${lifetimeMs}ms delayed renewal ${ms}ms`);
          }
          assert.ok(ms >= LISTENER_REQUEST_WAIT_FLOOR_MS);
          current += ms;
        },
      });
      assert.equal(stop.reason, "cancelled", stop.reason === "fatal" ? stop.error.message : answers.join(","));
      assert.equal(calls, answers.indexOf("success") + 1, answers.join(","));
      assert.ok(reads > 0, answers.join(","));
      assert.ok(current < expiry, answers.join(","));
      assert.ok((session.expiry ?? 0) > expiry, answers.join(","));
      for (let i = 1; i < requestTimes.length; i++) {
        assert.ok(requestTimes[i]! - requestTimes[i - 1]! >= LISTENER_REQUEST_WAIT_FLOOR_MS,
          `${answers.join(",")} issued requests ${requestTimes[i]! - requestTimes[i - 1]!}ms apart`);
      }
      const marginCalls = requestTimes.filter((time) => time >= deadline && time < expiry);
      assert.ok(marginCalls.length <= Math.ceil(RENEWAL_WINDOW_EXPIRY_MARGIN_MS / LISTENER_REQUEST_WAIT_FLOOR_MS) + 1);
      sequences++;
    }
  }
  assert.equal(sequences, 736);
});

test("generated failing renewals and a healthy null-store listener stay rate bounded through expiry", { timeout: 30_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  const expiry = start + 120_000;
  const deadline = expiry - RENEWAL_WINDOW_EXPIRY_MARGIN_MS;
  const failures = ["ours", "foreign", "network", "unsupported"] as const;
  let sequences = 0;
  for (let code = 0; code < failures.length ** 3; code++) {
    let current = start;
    const requestTimes: number[] = [];
    let calls = 0;
    const session = await AgentCredentialSession.open({
      target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
      presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: expiry },
      store: renewalMemoryStore(), listenerMode: true, now: () => current, warn: () => {},
      fetcher: (async () => {
        requestTimes.push(current);
        current += 20; // Every request costs 20 ms, including failures.
        assert.ok(++calls <= 130, `unbounded renewal sequence ${code}`);
        const answer = failures[Math.min(calls - 1, 2)]!;
        if (answer === "network") throw new TypeError("network unavailable");
        if (answer === "ours") return new Response('{"error":"unauthenticated"}', { status: 401 });
        if (answer === "foreign") return new Response("<html>wrong edge</html>", { status: 401 });
        return new Response('{"status":"rejected","reason":"renewal_unsupported"}', { status: 200 });
      }) as typeof fetch,
    });
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID, credentialSession: session, store: new MemoryStore(),
      model: new FakeModel(), now: () => current,
      onEvent: (event) => {
        if (event.type === "credential_check") {
          assert.ok(event.nextAttemptAt && Date.parse(event.nextAttemptAt) - Date.parse(event.ts) >= LISTENER_REQUEST_WAIT_FLOOR_MS);
        }
        if (event.type === "read_retry") assert.ok(event.delayMs >= LISTENER_REQUEST_WAIT_FLOOR_MS);
      },
      sleep: async (ms) => { current += ms; },
    });
    assert.equal(stop.reason, "credential", `sequence ${code}`);
    assert.ok(requestTimes.some((time) => time >= deadline && time < expiry), `sequence ${code} missed margin`);
    assert.ok(requestTimes.some((time) => time >= expiry), `sequence ${code} missed expiry`);
    for (let i = 1; i < requestTimes.length; i++) {
      assert.ok(requestTimes[i]! - requestTimes[i - 1]! >= LISTENER_REQUEST_WAIT_FLOOR_MS,
        `sequence ${code}: ${requestTimes[i]! - requestTimes[i - 1]!}ms apart`);
    }
    assert.ok(requestTimes.filter((time) => time >= deadline && time < expiry).length <=
      Math.ceil(RENEWAL_WINDOW_EXPIRY_MARGIN_MS / LISTENER_REQUEST_WAIT_FLOOR_MS) + 1);
    assert.equal(requestTimes.filter((time) => time >= expiry).length, 1);
    sequences++;
  }

  let current = start;
  const reads: number[] = [];
  const controller = new AbortController();
  const nullStore = await AgentCredentialSession.open({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: expiry },
    store: null, listenerMode: true, now: () => current, warn: () => {},
    fetcher: (async () => { assert.fail("a null store must not renew"); }) as typeof fetch,
  });
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID, credentialSession: nullStore, store: new MemoryStore(),
    model: new FakeModel(), signal: controller.signal, now: () => current,
    readPage: async () => {
      reads.push(current);
      current += 20;
      assert.ok(reads.length <= 130, "unbounded healthy null-store reads");
      if (current > expiry + 60_000) controller.abort();
      return page([]);
    },
    sleep: async (ms) => { current += ms; },
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(reads.some((time) => time >= deadline && time < expiry));
  assert.ok(reads.some((time) => time >= expiry));
  for (let i = 1; i < reads.length; i++) {
    assert.ok(reads[i]! - reads[i - 1]! >= LISTENER_REQUEST_WAIT_FLOOR_MS);
  }
  assert.ok(reads.filter((time) => time >= deadline && time < expiry).length <=
    Math.ceil(RENEWAL_WINDOW_EXPIRY_MARGIN_MS / LISTENER_REQUEST_WAIT_FLOOR_MS) + 1);
  assert.equal(sequences, 64);
});

test("generated confirmation windows stop only after the full span of confirmed answers", { timeout: 30_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let sequences = 0;
  for (let code = 0; code < 4 ** 3; code++) {
    let current = start;
    let calls = 0;
    const events: ListenerRuntimeEvent[] = [];
    const prefix = [code % 4, Math.floor(code / 4) % 4, Math.floor(code / 16) % 4];
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID, store: new MemoryStore(), model: new FakeModel(),
      now: () => current, random: () => 0, onEvent: (event) => events.push(event),
      credentialSession: { expiry: start + 30 * 60_000, async bearer() {
        const answer = prefix[calls++] ?? 0;
        if (answer === 1) throw new RenewalRetryError(start + 30 * 60_000);
        if (answer === 2) throw new SignalHttpError(500);
        if (answer === 3) throw new SignalHttpError(401);
        throw new RenewalCredentialCheckError(401, "unauthenticated");
      } },
      sleep: async (ms) => { current += ms; },
    });
    const checks = events.filter((event) => event.type === "credential_check");
    assert.equal(stop.reason, "credential", prefix.join(","));
    assert.ok(checks.length >= CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS, prefix.join(","));
    assert.ok(current >= Date.parse(checks[0]!.ts) + CREDENTIAL_LOSS_CONFIRM_WINDOW_MS,
      prefix.join(","));
    sequences++;
  }
  assert.equal(sequences, 64);
});

test("renewal window stops only after confirmed samples span the full window", { timeout: 15_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let current = start;
  let renewals = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    credentialSession: { expiry: start + 20 * 60_000, async bearer() {
      renewals++;
      throw new RenewalCredentialCheckError(401, "unauthenticated");
    } }, store: new MemoryStore(), model: new FakeModel(), now: () => current,
    sleep: async (ms) => { current += ms; },
  });
  assert.equal(stop.reason, "credential");
  assert.ok(renewals >= CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS);
  assert.ok(current - start >= CREDENTIAL_LOSS_CONFIRM_WINDOW_MS);
  assert.ok(current < start + 20 * 60_000);
});

test("expired predecessor stops on the next confirmed renewal answer", { timeout: 15_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let current = start;
  const expiry = start + 90_000;
  let renewals = 0;
  const events: ListenerRuntimeEvent[] = [];
  const session = await AgentCredentialSession.open({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    presented: { token: "swm_agt_" + "A".repeat(43), tokenId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: PRINCIPAL_ID, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expiresAt: expiry },
    store: renewalMemoryStore(), listenerMode: true, now: () => current, warn: () => {},
    fetcher: (async () => { renewals++; current += 1_000; return new Response('{"error":"unauthenticated"}', { status: 401 }); }) as typeof fetch,
  });
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID, credentialSession: session, store: new MemoryStore(), model: new FakeModel(),
    now: () => current, onEvent: (event) => events.push(event), sleep: async (ms) => { current += ms; },
  });
  assert.equal(stop.reason, "credential");
  assert.ok(current >= expiry);
  assert.ok(current < start + CREDENTIAL_LOSS_CONFIRM_WINDOW_MS);
  assert.ok(renewals >= 2);
  const check = events.find((event) => event.type === "credential_check");
  assert.ok(check?.nextAttemptAt);
  assert.ok(Date.parse(check.nextAttemptAt) > Date.parse(check.ts));
});

test("a read with the still-valid token clears a renewal credential sample", { timeout: 15_000 }, async () => {
  const start = Date.parse("2026-07-30T00:00:00.000Z");
  let current = start;
  let calls = 0;
  let reads = 0;
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    credentialSession: { expiry: start + 3 * 60_000, async bearer() {
      calls++;
      if (calls === 1) throw new RenewalCredentialCheckError(401, "unauthenticated");
      return "token";
    } },
    store: new MemoryStore(), model: new FakeModel(), signal: controller.signal,
    now: () => current, onEvent: (event) => events.push(event),
    readPage: async () => { reads++; return page([]); },
    sleep: async (ms) => { current += ms; if (reads > 0) controller.abort(); },
  });
  assert.equal(stop.reason, "cancelled");
  assert.ok(reads > 0);
  assert.ok(current < start + 3 * 60_000);
  assert.ok(events.some((event) => event.type === "credential_check"));
  assert.ok(events.some((event) => event.type === "credential_check_cleared"));
});

test("renewal 401 unauthenticated opens the listener credential window", { timeout: 15_000 }, async () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let renewals = 0;
  const session = await renewingListenerSession(now, (async () => {
    renewals++;
    return new Response('{"error":"unauthenticated"}', { status: 401 });
  }) as typeof fetch);
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    credentialSession: session, store: new MemoryStore(), model: new FakeModel(), signal: controller.signal,
    now: () => now, onEvent: (event) => events.push(event),
    sleep: async (ms) => { assert.equal(ms, RENEWAL_WINDOW_RETRY_MS); controller.abort(); },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(renewals, 1);
  assert.equal(events.find((event) => event.type === "credential_check")?.edge, "command");
  await assert.rejects(() => session.bearer(), RenewalCredentialCheckError);
});

test("foreign renewal 404 keeps retrying with expiry named in status", { timeout: 15_000 }, async () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const controller = new AbortController();
  const events: ListenerRuntimeEvent[] = [];
  let renewals = 0;
  const session = await renewingListenerSession(now, (async () => {
    renewals++;
    return new Response("<html>wrong host</html>", { status: 404 });
  }) as typeof fetch);
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    credentialSession: session, store: new MemoryStore(), model: new FakeModel(), signal: controller.signal,
    now: () => now, onEvent: (event) => events.push(event),
    sleep: async (ms) => { assert.ok(ms > 0 && ms <= 30_000); if (renewals >= 2) controller.abort(); },
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(renewals, 2);
  assert.equal(session.expiry, now + 3 * 60_000);
  const retry = events.find((event) => event.type === "read_retry");
  assert.equal(retry?.code, "renewal_retry");
  assert.equal(retry?.renewalExpiresAt, new Date(now + 3 * 60_000).toISOString());
});

test("renewal retry status names state and token expiry", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-renewal-status-"));
  try {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const paths = listenerPaths({ profileId: "renewal-status", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, stateDirectory: root });
    const session = await renewingListenerSession(now, (async () => new Response("<html>wrong host</html>", { status: 404 })) as typeof fetch);
    let observed: ListenerStatus | null = null;
    const final = await runListenerSupervisor({
      paths, profileId: "renewal-status", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
      now: () => now,
      run: (signal, onEvent) => runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
        credentialSession: session, store: new MemoryStore(), model: new FakeModel(), signal, now: () => now,
        onEvent, sleep: async () => { observed = await queryListenerControl(paths, "status"); await queryListenerControl(paths, "stop"); },
      }),
    });
    assert.equal(final.state, "stopped");
    const retryStatus = observed as ListenerStatus | null;
    assert.equal(retryStatus?.lastErrorCode, "renewal_retry");
    assert.equal(retryStatus?.renewalExpiresAt, new Date(now + 3 * 60_000).toISOString());
    assert.match(renderListenerStatus(retryStatus!), /Credential renewal is retrying.*current token expires at.*backoff of at least one second/);
    assert.match(renderListenerStatus(retryStatus!), /Reads and claims pause.*stops and needs a new credential/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrade_required stops claim with an install and restart action", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-listener-upgrade-"));
  try {
    const paths = listenerPaths({ profileId: "upgrade", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, stateDirectory: root });
    const journal = new MemoryDeliveryJournal();
    let claims = 0;
    const final = await runListenerSupervisor({
      paths, profileId: "upgrade", workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
      run: (signal, onEvent) => runListenerRuntime({
        target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
        listenerInstanceId: journal.record.listenerInstanceId, deliveryJournal: journal,
        credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
        store: new MemoryStore(), model: new FakeModel(), signal, onEvent,
        readPage: async () => durablePage([], 1),
        fetcher: (async () => { claims++; return new Response('{"error":"upgrade_required"}', { status: 426 }); }) as typeof fetch,
      }),
    });
    assert.equal(claims, 1);
    assert.equal(final.state, "failed");
    assert.equal(final.lastErrorCode, "upgrade_required");
    assert.match(renderListenerStatus(final), /npm install -g commonswarm.*restart the listener/);
    assert.match(listenerFailureMessage("upgrade_required"), /curl -fsSL https:\/\/commonswarm.com\/install.sh \| sh/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognized read 405 can recover after a redirect changes POST to GET", { timeout: 15_000 }, async () => {
  const controller = new AbortController();
  let reads = 0;
  const events: ListenerRuntimeEvent[] = [];
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    credentialSession: { async bearer() { return "token"; } },
    store: new MemoryStore(), model: new FakeModel(), signal: controller.signal,
    onEvent: (event) => events.push(event),
    fetcher: (async () => {
      reads++;
      if (reads === 1) return new Response('{"error":"method_not_allowed"}', { status: 405 });
      controller.abort();
      return new Response(JSON.stringify({ signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } }), { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(reads, 2);
  assert.equal(events.find((event) => event.type === "read_retry")?.code, "http_405");
});

test("upgrade_required also stops a prepared acknowledgement", { timeout: 15_000 }, async () => {
  const directNote = note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa28", "2026-07-30T00:00:01.000Z");
  const active = leasedActive({ signalId: directNote.id, phase: "ack_pending", outcome: "observed" });
  const journal = new MemoryDeliveryJournal(active);
  const store = new MemoryStore();
  await store.write(newObservedNoteRecord({ signalId: directNote.id, body: directNote.body,
    until: directNote.until, senderOwnerRelation: "same_owner", updatedAt: "2026-07-30T00:00:02.000Z" }));
  let acks = 0;
  const stop = await runListenerRuntime({
    target: cloudTarget("https://cloud.example.test", "anon"), workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID,
    listenerInstanceId: journal.record.listenerInstanceId, deliveryJournal: journal,
    credentialSession: { async bearer() { return "swm_agt_" + "A".repeat(43); } },
    store, model: new FakeModel(), now: () => Date.parse("2026-07-30T00:00:30.000Z"),
    readPage: async () => durablePage([], 1),
    fetcher: (async () => { acks++; return new Response('{"error":"upgrade_required"}', { status: 426 }); }) as typeof fetch,
  });
  assert.equal(acks, 1);
  assert.equal(stop.reason, "fatal");
  if (stop.reason === "fatal") assert.equal((stop.error as DeliveryHttpError).code, "upgrade_required");
  assert.equal(isRestartableListenerStop(stop), false);
});
