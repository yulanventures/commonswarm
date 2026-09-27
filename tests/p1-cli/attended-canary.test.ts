/** Attended watcher canary coverage. Reached by the test:p1-cli glob. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acquireArrivalWatchLock,
  arrivalWatchLockPath,
  releaseArrivalWatchLock,
  runArrivalWatch,
  type ArrivalCursorStore,
} from "../../src/cloud/arrival-watch.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { SignalReadTimeoutError } from "../../src/cloud/signals.js";
import { WakeLeaseReadError, type AgentWakeLease } from "../../src/cloud/wake-lease.js";
import { ListenerHttpClient } from "../../src/listener/http-client.js";
import {
  ATTENDED_CANARY_HOPS,
  renderAttendedAttendanceCanary,
  runAttendedAttendanceCanary,
} from "../../src/listener/attendance-canary.js";
import type { WakeHandle } from "../../src/listener/wake.js";
import {
  createLaneTempHome,
  removeLaneTempHome,
} from "../support/lane-temp-home.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const SIGNAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WATCHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const ACCEPTED_AT = "2026-09-27T12:00:00.000Z";
const TARGET = cloudTarget("https://cloud.example.test", "anon");
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

function acceptedSignal(): Record<string, unknown> {
  return {
    ok: true,
    status: "accepted",
    event_ids: [],
    events: [],
    signal: {
      id: SIGNAL_ID,
      workspace_id: WORKSPACE_ID,
      from: PRINCIPAL_ID,
      from_kind: "agent",
      to: null,
      to_agent: PRINCIPAL_ID,
      in_reply_to: null,
      about: null,
      kind: "note",
      body: "CommonSwarm attended-seat canary. Run cswarm check in this session; no reply is needed.",
      until: "2026-09-27T12:10:00.000Z",
      created_at: ACCEPTED_AT,
    },
  };
}

function receipt(observedAt: string | null = null): Record<string, unknown> {
  return {
    addressed: true,
    receipts: [{
      recipient_agent_principal_id: PRINCIPAL_ID,
      enqueued_at: ACCEPTED_AT,
      delivered_at: null,
      leased_until: null,
      acked_at: observedAt,
      ack_outcome: observedAt === null ? null : "observed",
      attempt_count: 0,
      lease_expiry_count: 0,
      last_error_code: null,
      pending_for_main_count: null,
    }],
  };
}

function fixture(receiptAt: (read: number) => string | null) {
  let receiptReads = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(
      Object.hasOwn(body, "command")
        ? acceptedSignal()
        : receipt(receiptAt(++receiptReads)),
    ), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher };
}

function lease(age: number): AgentWakeLease {
  return {
    watcher_id: WATCHER_ID,
    host_label: "test-host",
    generation: 7,
    renewed_age_ms: age,
  };
}

function arrivalPage(signals: SignalRecord[], withWake = true) {
  const last = signals.at(-1);
  return {
    signals,
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    legacyCursorFallback: false,
    rawCount: signals.length,
    nextCursor: last === undefined
      ? null
      : { created_at: last.created_at, id: last.id },
    malformedRows: 0,
    pendingDeliveryCount: signals.length,
    ...(withWake ? { wake: { topic: "cswarm-wake:test", event: "wake" as const } } : {}),
  };
}

test("attended canary hop contract is stable", () => {
  assert.deepEqual(ATTENDED_CANARY_HOPS, ["accepted", "watcher_polled", "observed"]);
});

test("healthy attended seat proves a post-acceptance renewal and observed check", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let leaseReads = 0;
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 200,
    watcherWaitMs: 500,
    fetcher: fixture(read => read >= 2 ? "2026-09-27T12:00:00.100Z" : null).fetcher,
    readWakeLease: async () => ++leaseReads === 1 ? lease(100) : lease(0),
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, null);
  assert.equal(result.watcherPollState, "proved");
  assert.equal(result.watcherPolledAt, "2026-09-27T12:00:00.100Z");
  assert.equal(result.observedAt, "2026-09-27T12:00:00.100Z");
  assert.match(renderAttendedAttendanceCanary(result), /Canary passed/);
});

test("watcher killed before the post stalls at watcher_polled with the restart step", async () => {
  let now = Date.parse(ACCEPTED_AT);
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 300,
    fetcher: fixture(() => null).fetcher,
    readWakeLease: async () => lease(now - Date.parse(ACCEPTED_AT) + 1),
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, "watcher_polled");
  const rendered = renderAttendedAttendanceCanary(result);
  assert.match(rendered, /restart `cswarm inbox --notify` under the same session Monitor/);
  assert.doesNotMatch(rendered, /listen start/);
});

test("lease response latency cannot make a pre-acceptance renewal look post-acceptance", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let leaseReads = 0;
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 300,
    fetcher: fixture(() => null).fetcher,
    readWakeLease: async () => {
      now += 40;
      leaseReads += 1;
      return lease(leaseReads === 1 ? 40 : leaseReads === 2
        ? 145
        : now - Date.parse(ACCEPTED_AT) + 5);
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, "watcher_polled");
  assert.equal(result.watcherPollState, "not_observed");
  assert.equal(result.watcherPolledAt, null);
});

for (const status of [503, null] as const) {
  test(`a ${status === null ? "transport" : "5xx"} lease read failure is distinct from a watcher stall`, async () => {
    let now = Date.parse(ACCEPTED_AT);
    const result = await runAttendedAttendanceCanary({
      target: TARGET,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      watcherId: WATCHER_ID,
      generation: 7,
      credential: async () => TOKEN,
      checkWaitMs: 100,
      watcherWaitMs: 300,
      fetcher: fixture(() => null).fetcher,
      readWakeLease: async () => {
        throw new WakeLeaseReadError(status, "wake lease read failed");
      },
      now: () => now,
      sleep: async ms => { now += ms; },
      pollMs: 100,
    });
    assert.equal(result.stalledAt, null);
    assert.equal(result.receiptReadErrorCode, null);
    assert.deepEqual(result.wakeLeaseReadError, { status });
    const rendered = renderAttendedAttendanceCanary(result);
    assert.match(rendered, status === null
      ? /WAKE LEASE READ: failed \(transport\)/
      : /WAKE LEASE READ: failed \(HTTP 503\)/);
    assert.match(rendered, /watcher polling is unknown/);
    assert.match(rendered, /retry `cswarm listen canary`/);
    assert.doesNotMatch(rendered, /WATCHER_POLLED: no/);
    assert.doesNotMatch(rendered, /restart `cswarm inbox --notify`/);
  });
}

test("a post-acceptance age reset proves watcher polling despite lease-read latency", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let leaseReads = 0;
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 500,
    fetcher: fixture(() => "2026-09-27T12:00:00.180Z").fetcher,
    readWakeLease: async () => {
      leaseReads += 1;
      if (leaseReads === 1) return lease(10_000);
      if (leaseReads === 2) {
        now += 80;
        return lease(150);
      }
      return lease(150 + now - Date.parse(ACCEPTED_AT));
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, null);
  assert.equal(result.watcherPollState, "proved");
  assert.equal(result.watcherPolledAt, "2026-09-27T12:00:00.180Z");
});

test("an over-deadline lease read does not create a receipt timeout", async () => {
  let now = Date.parse(ACCEPTED_AT);
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 300,
    fetcher: fixture(() => "2026-09-27T12:00:00.400Z").fetcher,
    readWakeLease: async () => {
      now += 400;
      return lease(now - Date.parse(ACCEPTED_AT) + 1);
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, "watcher_polled");
  assert.equal(result.receiptReadErrorCode, null);
});

test("a nearly exhausted watcher budget does not start a receipt read", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let receiptReads = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (Object.hasOwn(body, "command")) {
      return new Response(JSON.stringify(acceptedSignal()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    receiptReads += 1;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    return new Response(JSON.stringify(receipt()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 300,
    fetcher,
    readWakeLease: async () => {
      now += 290;
      return lease(291);
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, "watcher_polled");
  assert.equal(result.receiptReadErrorCode, null);
  assert.equal(receiptReads, 0);
  assert.doesNotMatch(renderAttendedAttendanceCanary(result), /RECEIPT READ/);
});

test("an earlier observed receipt remains conclusive if a later receipt read fails", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let leaseReads = 0;
  let receiptReads = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (Object.hasOwn(body, "command")) {
      return new Response(JSON.stringify(acceptedSignal()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    receiptReads += 1;
    if (receiptReads === 1) {
      return new Response(JSON.stringify(receipt("2026-09-27T12:00:00.050Z")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new TypeError("transport unavailable");
  };
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 300,
    fetcher,
    readWakeLease: async () => ++leaseReads === 1 ? lease(100) : lease(0),
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, null);
  assert.equal(result.observedAt, "2026-09-27T12:00:00.050Z");
  assert.equal(result.receiptReadErrorCode, null);
  assert.equal(receiptReads, 1, "a completed observed hop must not be reread");
  assert.doesNotMatch(renderAttendedAttendanceCanary(result), /RECEIPT READ/);
});

test("the watcher budget starts only after notify emits the accepted note", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let leaseReads = 0;
  let releaseEmission = () => {};
  const emitted = new Promise<void>(resolvePromise => {
    releaseEmission = resolvePromise;
  });
  let accepted = () => {};
  const acceptedHookRan = new Promise<void>(resolvePromise => {
    accepted = resolvePromise;
  });
  const canary = runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 300,
    fetcher: fixture(() => "2026-09-27T12:00:00.050Z").fetcher,
    readWakeLease: async () => ++leaseReads === 1 ? lease(100) : lease(0),
    afterAccepted: async () => {
      accepted();
      await emitted;
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  await acceptedHookRan;
  assert.equal(leaseReads, 0);
  now += 500;
  releaseEmission();
  const result = await canary;
  assert.equal(result.stalledAt, null);
  assert.equal(result.watcherPolledAt, "2026-09-27T12:00:00.600Z");
});

test("notify gives its attended canary an independent bounded HTTP client", async () => {
  const source = await readFile(CLI_PATH, "utf8");
  const notifySource = source.slice(
    source.indexOf("async function runInboxNotifyCommand"),
    source.indexOf("export const RUN_RECEIPT_1_ACCEPTED_FLAGS"),
  );
  assert.match(notifySource, /const \[httpClient, attendedCanaryHttpClient\] = \[new ListenerHttpClient\(\), new ListenerHttpClient\(\)\];/);
  assert.match(notifySource, /fetcher: attendedCanaryHttpClient\.fetch/);
  assert.match(notifySource, /for \(const client of \[httpClient, attendedCanaryHttpClient\]\) client\.close\(\);/);

  const pageReachesServer = async (separateClients: boolean): Promise<boolean> => {
    let acceptLease = () => {};
    const leaseAccepted = new Promise<void>(resolvePromise => {
      acceptLease = resolvePromise;
    });
    let acceptPage = () => {};
    const pageAccepted = new Promise<void>(resolvePromise => {
      acceptPage = resolvePromise;
    });
    const server = createServer((request, response) => {
      if (request.url === "/lease") {
        acceptLease();
        return;
      }
      acceptPage();
      response.writeHead(200).end("page");
    });
    const pageClient = new ListenerHttpClient();
    const canaryClient = separateClients ? new ListenerHttpClient() : pageClient;
    const abort = new AbortController();
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const leaseRequest = canaryClient.fetch(`${origin}/lease`, {
        signal: abort.signal,
      }).catch(() => null);
      await leaseAccepted;
      const pageRequest = pageClient.fetch(`${origin}/page`);
      const reached = await Promise.race([
        pageAccepted.then(() => true),
        new Promise<false>(resolvePromise => setTimeout(() => resolvePromise(false), 500)),
      ]);
      abort.abort();
      await leaseRequest;
      await pageRequest;
      return reached;
    } finally {
      abort.abort();
      pageClient.close();
      if (canaryClient !== pageClient) canaryClient.close();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    }
  };

  assert.equal(await pageReachesServer(false), false, "control: one socket queues the page behind the lease read");
  assert.equal(await pageReachesServer(true), true, "the independent client lets the page read proceed immediately");
});

test("notify readiness immediately reads the canary posted by onReady even when its wake was missed", async () => {
  const abort = new AbortController();
  let canaryPosted = false;
  let topicSet = false;
  let reads = 0;
  let waits = 0;
  const emitted: string[] = [];
  const canarySignal = acceptedSignal().signal as SignalRecord;
  const store: ArrivalCursorStore = {
    location: "memory",
    read: async () => undefined,
    write: async () => undefined,
  };
  const wake: WakeHandle = {
    get state() { return topicSet ? "subscribed" : "disconnected"; },
    get hasTopic() { return topicSet; },
    snapshot: () => ({
      mode: topicSet ? "push" : "poll",
      subscribedAt: topicSet ? ACCEPTED_AT : null,
      reconnects: 0,
      lastWakeAt: null,
      lastReconcileAt: null,
      errorCode: null,
      topicRotatedAt: null,
      rateLimited: false,
    }),
    next: async () => {
      waits += 1;
      abort.abort();
      return "deadline";
    },
    setTopic: () => { topicSet = true; },
    noteReconcile: () => undefined,
    noteClaim: () => undefined,
    noteWakeClaim: () => undefined,
    canClaimOnWake: () => true,
    coalescingRemainingMs: () => 0,
    overWakeBudget: () => false,
    markRateLimited: () => undefined,
    close: async () => undefined,
  };
  await runArrivalWatch({
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    store,
    signal: abort.signal,
    wake,
    readPage: async ({ baseline }) => {
      reads += 1;
      return arrivalPage(!baseline && canaryPosted ? [canarySignal] : []);
    },
    emit: async signal => {
      emitted.push(signal.id);
      abort.abort();
    },
    onReady: () => { canaryPosted = true; },
  });
  assert.deepEqual(emitted, [SIGNAL_ID]);
  assert.equal(reads, 2);
  assert.equal(waits, 0);
});

test("live watcher without a session check stalls at observed with the check step", async () => {
  let now = Date.parse(ACCEPTED_AT);
  let leaseReads = 0;
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: 7,
    credential: async () => TOKEN,
    checkWaitMs: 200,
    watcherWaitMs: 500,
    fetcher: fixture(() => null).fetcher,
    readWakeLease: async () => ++leaseReads === 1 ? lease(100) : lease(0),
    now: () => now,
    sleep: async ms => { now += ms; },
    pollMs: 100,
  });
  assert.equal(result.stalledAt, "observed");
  const rendered = renderAttendedAttendanceCanary(result);
  assert.match(rendered, /run `cswarm check` in the session/);
  assert.doesNotMatch(rendered, /listen start/);
});

test("a failed receipt read leaves observation unknown instead of reporting a stall", async () => {
  const run = async (receiptResponse: () => Response | Error, unproved = false) => {
    let now = Date.parse(ACCEPTED_AT);
    let leaseReads = 0;
    return await runAttendedAttendanceCanary({
      target: TARGET,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      watcherId: WATCHER_ID,
      generation: 7,
      credential: async () => TOKEN,
      checkWaitMs: 200,
      watcherWaitMs: 500,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (Object.hasOwn(body, "command")) {
          return new Response(JSON.stringify(acceptedSignal()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const response = receiptResponse();
        if (response instanceof Error) throw response;
        return response;
      },
      readWakeLease: async () => {
        if (unproved) throw new WakeLeaseReadError(404, "lease view not found");
        return ++leaseReads === 1 ? lease(100) : lease(0);
      },
      now: () => now,
      sleep: async ms => { now += ms; },
      pollMs: 100,
    });
  };

  for (const [result, code] of [
    [await run(() => new Response("{}", { status: 503 })), "http"],
    [await run(() => new SignalReadTimeoutError()), "timeout"],
    [await run(() => new Response("{}", { status: 503 }), true), "http"],
  ] as const) {
    assert.equal(result.stalledAt, null);
    assert.equal(result.receiptReadErrorCode, code);
    const rendered = renderAttendedAttendanceCanary(result);
    assert.match(rendered, new RegExp(`RECEIPT READ: failed \\(${code}\\)`));
    assert.match(rendered, /observation is unknown because the receipt read failed/);
    assert.match(rendered, /retry `cswarm listen canary` when the read works/);
    assert.doesNotMatch(rendered, /STALLED:/);
    assert.doesNotMatch(rendered, /run `cswarm check`/);
  }

  const successfulRead = await run(() => new Response(JSON.stringify(receipt()), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  assert.equal(successfulRead.receiptReadErrorCode, null);
  assert.equal(successfulRead.stalledAt, "observed");
  assert.match(renderAttendedAttendanceCanary(successfulRead), /run `cswarm check` in the session/);
});

test("401 and 403 wake-lease reads name credential recovery, not service reachability", async () => {
  const run = async (status: number) => {
    let now = Date.parse(ACCEPTED_AT);
    return await runAttendedAttendanceCanary({
      target: TARGET,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      watcherId: WATCHER_ID,
      generation: 7,
      credential: async () => TOKEN,
      checkWaitMs: 100,
      watcherWaitMs: 300,
      fetcher: fixture(() => null).fetcher,
      readWakeLease: async () => {
        throw new WakeLeaseReadError(status, "wake lease read failed");
      },
      now: () => now,
      sleep: async ms => { now += ms; },
    });
  };

  for (const status of [401, 403]) {
    const rendered = renderAttendedAttendanceCanary(await run(status));
    assert.match(rendered, new RegExp(`WAKE LEASE READ: failed \\(HTTP ${status}\\)`));
    assert.match(rendered, /service refused this credential/);
    assert.match(rendered, /re-establish this seat's credential/);
    assert.doesNotMatch(rendered, /when the read works|when the read service is reachable/);
  }

  const unavailable = renderAttendedAttendanceCanary(await run(503));
  assert.match(unavailable, /wake-lease service read failed/);
  assert.match(unavailable, /retry `cswarm listen canary` when the read works/);
  assert.doesNotMatch(unavailable, /re-establish this seat's credential/);
});

test("missing pre-2b lease view is unproved rather than a watcher failure", async () => {
  let now = Date.parse(ACCEPTED_AT);
  const result = await runAttendedAttendanceCanary({
    target: TARGET,
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    watcherId: WATCHER_ID,
    generation: null,
    credential: async () => TOKEN,
    checkWaitMs: 100,
    watcherWaitMs: 500,
    fetcher: fixture(() => "2026-09-27T12:00:00.050Z").fetcher,
    readWakeLease: async () => {
      throw new WakeLeaseReadError(404, "lease view not found");
    },
    now: () => now,
    sleep: async ms => { now += ms; },
  });
  assert.equal(result.stalledAt, null);
  assert.equal(result.watcherPollState, "unproved");
  assert.equal(result.wakeLeaseReadError, null);
  assert.match(renderAttendedAttendanceCanary(result), /watcher_polled remains unproved/);
});

test("on-demand canary does not post when the watcher lease read fails", async () => {
  const root = createLaneTempHome("attended-read-failure-root-");
  const home = createLaneTempHome("attended-read-failure-home-");
  const credentialPath = join(root, "agent.json");
  let signalPosts = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url === "/functions/v1/read") {
        response.writeHead(503, { "content-type": "application/json" }).end("{}");
        return;
      }
      signalPosts += 1;
      response.writeHead(500, { "content-type": "application/json" }).end("{}");
    });
  });
  try {
    await writeFile(credentialPath, JSON.stringify({
      message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
      status: "accepted",
      principal_id: PRINCIPAL_ID,
      token_id: "33333333-3333-4333-8333-333333333333",
      run_id: "44444444-4444-4444-8444-444444444444",
      agent_token: TOKEN,
      expires_at: "2030-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const target = cloudTarget(`http://127.0.0.1:${address.port}`, "anon");
    const stateRoot = join(home, "state", "cswarm", "arrival-cursors");
    await mkdir(stateRoot, { recursive: true });
    await chmod(join(home, "state"), 0o700);
    await chmod(join(home, "state", "cswarm"), 0o700);
    await chmod(stateRoot, 0o700);
    const lockPath = arrivalWatchLockPath(target, WORKSPACE_ID, PRINCIPAL_ID, stateRoot);
    await acquireArrivalWatchLock(lockPath, process.pid, WATCHER_ID);
    try {
      const child = spawn(process.execPath, [
        "--import", TSX_IMPORT, CLI_PATH,
        "listen", "canary",
        "--agent-token-file", credentialPath,
        "--url", target.url,
        "--anon-key", target.anonKey,
        "--workspace-id", WORKSPACE_ID,
        "--wait", "1",
      ], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_STATE_HOME: join(home, "state"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => stderr += chunk);
      const status = await new Promise<number | null>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("close", resolvePromise);
      });
      assert.equal(status, 1);
      assert.equal(signalPosts, 0);
      assert.match(stderr, /did not post a note because the wake-lease read failed \(HTTP 503\)/);
      assert.match(stderr, /The watcher's lease is unknown/);
      assert.match(stderr, /retry `cswarm listen canary`/);
    } finally {
      await releaseArrivalWatchLock(lockPath, process.pid);
    }
  } finally {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    removeLaneTempHome(root);
    removeLaneTempHome(home);
  }
});
