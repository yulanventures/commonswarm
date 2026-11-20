import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages } from "../../src/cloud/agent-check.js";
import { parseAgentConnection, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import {
  configureAgentReceive,
  readReceiveBinding,
  receiveHookEvent,
  receiveStatus,
  requestReceiveCanary,
} from "../../src/cloud/agent-receive.js";
import {
  acknowledgeNativeWakeOnCheck,
  assertFixedNativeWakePrompt,
  findProfileReceiveBinding,
  formatNativeWakePrompt,
  NativeWakeBridge,
  NATIVE_WAKE_DEBOUNCE_MS,
  NATIVE_WAKE_MIN_INTERVAL_MS,
  NATIVE_WAKE_RETRY_AFTER_MS,
  readNativeWakeState,
  resolveAuthorizedWakeBinding,
  type NativeWakeAdapter,
} from "../../src/cloud/native-wake.js";
import {
  CodexQueueAdapter,
  serveCodexWakeBridge,
} from "../../src/cloud/native-wake-codex.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const THREAD = "01a1d5ac-1111-4222-8333-444444444444";
const OTHER_THREAD = "01a1d5ac-1111-4222-8333-444444444445";
const SIGNAL_1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const SIGNAL_2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const TOKEN = `swm_agt_${"C".repeat(43)}`;

function connectionEnvelope(url = "http://127.0.0.1:9") {
  return parseAgentConnection(JSON.stringify({
    version: 1,
    url,
    anon_key: "fixture-key",
    workspace_id: WS,
    principal_id: AGENT,
    credential: {
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: AGENT,
      token_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222",
      agent_token: TOKEN,
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  }));
}

async function setupBoundCodexSeat(root: string, url = "http://127.0.0.1:9", thread = THREAD) {
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const profile = join(root, "agent", "profile.json");
  await saveAgentProfile(profile, connectionEnvelope(url), "TestWS", thread);
  await configureAgentReceive({
    profilePath: profile,
    mode: "wake",
    provider: "codex",
    hostSessionId: thread,
    cwd,
    execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
  });
  return { cwd, profile };
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("condition did not become true before deadline");
}

test("CodexQueueAdapter enforces fixed text only, UUID thread binding, and never passes --resume or --remote", async () => {
  const calls: Array<{ exe: string; args: readonly string[]; cwd: string }> = [];
  const adapter = new CodexQueueAdapter({
    codexExecutable: "/usr/local/bin/codex",
    runner: async (exe, args, opts) => {
      calls.push({ exe, args, cwd: opts.cwd });
      return { stdout: "queued\n", stderr: "" };
    },
  });

  const prompt = formatNativeWakePrompt(1);
  assert.equal(prompt, "New CommonSwarm messages (batch 1): run cswarm check");
  assert.equal(assertFixedNativeWakePrompt(prompt), 1);

  const ok = await adapter.sendWake({
    hostSessionId: THREAD,
    prompt,
    batch: 1,
    cwd: "/tmp",
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, [
    "queue",
    "--thread",
    THREAD,
    "--message",
    "New CommonSwarm messages (batch 1): run cswarm check",
  ]);
  assert.equal(calls[0]!.args.includes("--resume"), false);
  assert.equal(calls[0]!.args.includes("--remote"), false);

  const badUuid = await adapter.sendWake({
    hostSessionId: "not-a-uuid",
    prompt,
    batch: 1,
    cwd: "/tmp",
  });
  assert.equal(badUuid.ok, false);
  assert.equal(badUuid.code, "codex_thread_id_invalid");

  const injected = await adapter.sendWake({
    hostSessionId: THREAD,
    prompt: "New CommonSwarm messages (batch 1): run cswarm check && rm -rf /",
    batch: 1,
    cwd: "/tmp",
  });
  assert.equal(injected.ok, false);
  assert.equal(injected.code, "wake_prompt_unsafe");
  assert.equal(calls.length, 1);
});

test("NativeWakeBridge enforces 5s debounce, 2m floor, single pending wake, 15m single retry, wake_failed, and check ack", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-native-wake-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const { cwd, profile } = await setupBoundCodexSeat(root);
    let clock = Date.parse("2026-11-20T20:00:00.000Z");
    const sent: Array<{ batch: number; prompt: string }> = [];
    const adapter: NativeWakeAdapter = {
      route: "codex-queue",
      async sendWake(input) {
        sent.push({ batch: input.batch, prompt: input.prompt });
        return { ok: true };
      },
    };
    const bridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter,
      now: () => clock,
    });

    assert.deepEqual(await bridge.tick(), { action: "idle" });
    assert.equal(sent.length, 0);

    // Two arrivals 1s apart coalesce into ONE wake after 5s debounce.
    bridge.notifyArrival();
    clock += 1_000;
    bridge.notifyArrival();
    assert.equal((await bridge.tick()).action, "debouncing");
    assert.equal(sent.length, 0);

    clock += NATIVE_WAKE_DEBOUNCE_MS - 1_000;
    assert.deepEqual(await bridge.tick(), { action: "sent", batch: 1, retry: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.prompt, "New CommonSwarm messages (batch 1): run cswarm check");

    // Additional arrivals while batch 1 is unacked do NOT send a second wake.
    clock += 60_000;
    bridge.notifyArrival();
    assert.deepEqual(await bridge.tick(), { action: "pending", batch: 1 });
    assert.equal(sent.length, 1);

    // Before 15 minutes: still pending.
    clock = Date.parse("2026-11-20T20:00:05.000Z") + NATIVE_WAKE_RETRY_AFTER_MS - 1_000;
    assert.deepEqual(await bridge.tick(), { action: "pending", batch: 1 });
    assert.equal(sent.length, 1);

    // At 15 minutes: single retry fires (batch 2).
    clock += 1_000;
    assert.deepEqual(await bridge.tick(), { action: "sent", batch: 2, retry: true });
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.prompt, "New CommonSwarm messages (batch 2): run cswarm check");

    // Still unacked 10 minutes after retry: pending, no third wake.
    clock += 10 * 60_000;
    assert.deepEqual(await bridge.tick(), { action: "pending", batch: 2 });
    assert.equal(sent.length, 2);

    // Another 15 minutes with no check -> wake_failed, stops sending.
    clock += 5 * 60_000;
    assert.deepEqual(await bridge.tick(), { action: "wake_failed", batch: 2 });
    assert.equal(sent.length, 2);
    const failedState = await readNativeWakeState(profile, THREAD);
    assert.ok(failedState?.wake_failed_at !== null);

    // Running cswarm check clears pending_batch + wake_failed_at while preserving last_wake_at.
    await acknowledgeNativeWakeOnCheck({
      profilePath: profile,
      hostSessionId: THREAD,
      now: () => clock,
    });
    const clearedState = await readNativeWakeState(profile, THREAD);
    assert.equal(clearedState?.pending_batch, null);
    assert.equal(clearedState?.wake_failed_at, null);

    // New arrival right after batch 2 respects the 2-minute per-seat floor.
    clock = Date.parse(clearedState!.last_wake_at!) + 30_000;
    bridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    assert.equal((await bridge.tick()).action, "rate_limited");
    assert.equal(sent.length, 2);

    // Once 2 minutes have elapsed since last_wake_at, batch 3 sends.
    clock = Date.parse(clearedState!.last_wake_at!) + NATIVE_WAKE_MIN_INTERVAL_MS;
    assert.deepEqual(await bridge.tick(), { action: "sent", batch: 3, retry: false });
    assert.equal(sent.length, 3);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Condition 1: refuses unbound profiles, sibling directory bindings, mismatched seats, and opted-out turn mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-wake-cond1-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    // 1. Unbound profile refused by configureAgentReceive and resolveAuthorizedWakeBinding.
    const unboundCwd = join(root, "unbound-project");
    await mkdir(unboundCwd, { recursive: true });
    const unboundProfile = join(root, "unbound-agent", "profile.json");
    await saveAgentProfile(unboundProfile, connectionEnvelope(), "TestWS");
    await assert.rejects(
      configureAgentReceive({
        profilePath: unboundProfile,
        mode: "wake",
        provider: "codex",
        hostSessionId: THREAD,
        cwd: unboundCwd,
        execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
      }),
      { code: "profile_not_host_bound" },
    );
    const unboundAuth = await resolveAuthorizedWakeBinding({
      profilePath: unboundProfile,
      hostSessionId: THREAD,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
    });
    assert.equal(unboundAuth.ok, false);
    assert.equal(unboundAuth.code, "profile_not_host_bound");

    // 2. Sibling receive-*.json in the same directory is NEVER selected by findProfileReceiveBinding.
    await writeFile(
      join(dirname(unboundProfile), "receive-sibling.json"),
      JSON.stringify({
        version: 1,
        profile: unboundProfile,
        host_session_id: OTHER_THREAD,
        provider: "codex",
        requested_mode: "wake",
        cwd: unboundCwd,
      }),
      { mode: 0o600 },
    );
    assert.equal(await findProfileReceiveBinding(unboundProfile), null);

    // 3. Bound seat: mismatched workspace/principal/session refused; valid seat allowed.
    const { cwd, profile } = await setupBoundCodexSeat(root);
    const wrongWs = await resolveAuthorizedWakeBinding({
      profilePath: profile,
      hostSessionId: THREAD,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: OTHER_WS, principalId: AGENT },
    });
    assert.equal(wrongWs.ok, false);
    assert.equal(wrongWs.code, "wake_seat_mismatch");

    const wrongPrincipal = await resolveAuthorizedWakeBinding({
      profilePath: profile,
      hostSessionId: THREAD,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: OTHER_AGENT },
    });
    assert.equal(wrongPrincipal.ok, false);
    assert.equal(wrongPrincipal.code, "wake_seat_mismatch");

    const wrongThread = await resolveAuthorizedWakeBinding({
      profilePath: profile,
      hostSessionId: OTHER_THREAD,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
    });
    assert.equal(wrongThread.ok, false);
    assert.equal(wrongThread.code, "profile_other_session");

    // 4. Cached listener bridge stops waking immediately when operator switches to --mode turn.
    let clock = Date.parse("2026-11-20T20:10:00.000Z");
    let dispatchCount = 0;
    const bridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter: {
        route: "codex-queue",
        async sendWake() {
          dispatchCount += 1;
          return { ok: true };
        },
      },
      now: () => clock,
    });

    await configureAgentReceive({
      profilePath: profile,
      mode: "turn",
      provider: "codex",
      hostSessionId: THREAD,
      cwd,
      execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
    });
    bridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    const optedOut = await bridge.tick();
    assert.equal(optedOut.action, "binding_inactive");
    assert.equal(optedOut.code, "wake_opted_out");
    assert.equal(dispatchCount, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Condition 2: two concurrent listener paths share one atomic reservation, and failed/ambiguous queue results keep caps spent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-wake-cond2-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const { cwd, profile } = await setupBoundCodexSeat(root);
    let clock = Date.parse("2026-11-20T20:20:00.000Z");
    const dispatches: Array<{ caller: string; batch: number }> = [];

    let firstStartedResolve!: () => void;
    const firstDispatchStarted = new Promise<void>((done) => {
      firstStartedResolve = done;
    });
    let releaseFirstDispatch!: () => void;
    const holdFirstDispatch = new Promise<void>((done) => {
      releaseFirstDispatch = done;
    });

    // Two distinct bridge instances representing foreground `cswarm listen` and standalone `cswarm receive serve`.
    const listenBridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter: {
        route: "codex-queue",
        async sendWake(input) {
          dispatches.push({ caller: "listen", batch: input.batch });
          firstStartedResolve();
          await holdFirstDispatch;
          return { ok: true };
        },
      },
      now: () => clock,
    });
    const serveBridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter: {
        route: "codex-queue",
        async sendWake(input) {
          dispatches.push({ caller: "serve", batch: input.batch });
          return { ok: true };
        },
      },
      now: () => clock,
    });

    listenBridge.notifyArrival();
    serveBridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;

    // Start first dispatch and hold it open before releasing; second caller races in concurrently.
    const firstPromise = listenBridge.tick();
    await firstDispatchStarted;
    const secondDecision = await serveBridge.tick();
    assert.deepEqual(secondDecision, { action: "pending", batch: 1 });
    assert.equal(dispatches.length, 1, "second listener path must NOT spawn a duplicate subprocess");
    releaseFirstDispatch();
    assert.deepEqual(await firstPromise, { action: "sent", batch: 1, retry: false });
    assert.equal(dispatches.length, 1);

    // Acknowledge batch 1, advance past rate floor, and test refused/ambiguous queue result.
    await acknowledgeNativeWakeOnCheck({ profilePath: profile, hostSessionId: THREAD, now: () => clock });
    clock += NATIVE_WAKE_MIN_INTERVAL_MS;

    let ambiguousCalls = 0;
    const ambiguousBridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter: {
        route: "codex-queue",
        async sendWake() {
          ambiguousCalls += 1;
          return { ok: false, code: "codex_queue_failed", detail: "timed out ambiguously" };
        },
      },
      now: () => clock,
    });

    ambiguousBridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    const firstErr = await ambiguousBridge.tick();
    assert.equal(firstErr.action, "error");
    assert.equal(ambiguousCalls, 1);

    // Subsequent immediate ticks must NOT spin another subprocess; slot & rate floor remain spent.
    clock += 1_000;
    ambiguousBridge.notifyArrival();
    assert.deepEqual(await ambiguousBridge.tick(), { action: "pending", batch: 2 });
    assert.equal(ambiguousCalls, 1);

    // Even if cswarm check clears pending_batch immediately, last_wake_at keeps the 2-minute floor enforced.
    await acknowledgeNativeWakeOnCheck({ profilePath: profile, hostSessionId: THREAD, now: () => clock });
    clock += 10_000;
    ambiguousBridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    assert.equal((await ambiguousBridge.tick()).action, "rate_limited");
    assert.equal(ambiguousCalls, 1);

    // Wait past 2m floor -> initial attempt fails ambiguously (batch 3), then 15m later single retry fails ambiguously (batch 4).
    clock += NATIVE_WAKE_MIN_INTERVAL_MS;
    assert.equal((await ambiguousBridge.tick()).action, "error");
    assert.equal(ambiguousCalls, 2);

    clock += NATIVE_WAKE_RETRY_AFTER_MS;
    assert.equal((await ambiguousBridge.tick()).action, "error");
    assert.equal(ambiguousCalls, 3);

    // After the single retry failed ambiguously, NO third subprocess may run on subsequent ticks.
    clock += 5_000;
    assert.deepEqual(await ambiguousBridge.tick(), { action: "pending", batch: 4 });
    assert.equal(ambiguousCalls, 3);

    clock += NATIVE_WAKE_RETRY_AFTER_MS;
    assert.deepEqual(await ambiguousBridge.tick(), { action: "wake_failed", batch: 4 });
    assert.equal(ambiguousCalls, 3);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Opt-out/dispatch lock serialization: opting out while a wake is reserved causes zero codex queue calls, and opt-out waits for in-flight dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-wake-optout-race-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    // Part A: opt out AFTER a wake is durably reserved, BEFORE execFile -> zero codex queue calls!
    const { cwd, profile } = await setupBoundCodexSeat(root);
    let clock = Date.parse("2026-11-20T20:30:00.000Z");
    const codexCalls: Array<readonly string[]> = [];
    const adapter = new CodexQueueAdapter({
      codexExecutable: "codex",
      runner: async (_exe, args) => {
        codexCalls.push(args);
        return { stdout: "ok\n", stderr: "" };
      },
    });
    let reservedBatchSeen: number | null = null;
    const bridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter,
      now: () => clock,
      beforeDispatch: async (batch) => {
        const reserved = await readNativeWakeState(profile, THREAD);
        assert.equal(reserved?.pending_batch, batch, "wake must already be durably reserved before opt-out runs");
        reservedBatchSeen = batch;
        await configureAgentReceive({
          profilePath: profile,
          mode: "turn",
          provider: "codex",
          hostSessionId: THREAD,
          cwd,
          execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
        });
      },
    });
    bridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    const decision = await bridge.tick();
    assert.equal(reservedBatchSeen, 1);
    assert.equal(decision.action, "binding_inactive");
    assert.equal(decision.code, "wake_opted_out");
    assert.equal(codexCalls.length, 0, "opting out while a wake is reserved must produce ZERO codex queue calls");

    // Part B: opt-out shares the same receive lock as an in-flight codex queue call and never completes before dispatch finishes.
    await configureAgentReceive({
      profilePath: profile,
      mode: "wake",
      provider: "codex",
      hostSessionId: THREAD,
      cwd,
      execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
    });
    await acknowledgeNativeWakeOnCheck({ profilePath: profile, hostSessionId: THREAD, now: () => clock });
    clock += NATIVE_WAKE_MIN_INTERVAL_MS;

    let enteredExec!: () => void;
    const execEntered = new Promise<void>((done) => { enteredExec = done; });
    let releaseExec!: () => void;
    const execGate = new Promise<void>((done) => { releaseExec = done; });
    const heldAdapter = new CodexQueueAdapter({
      codexExecutable: "codex",
      runner: async (_exe, args) => {
        codexCalls.push(args);
        enteredExec();
        await execGate;
        return { stdout: "ok\n", stderr: "" };
      },
    });
    const heldBridge = new NativeWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      cwd,
      expectedProvider: "codex",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      adapter: heldAdapter,
      now: () => clock,
    });
    heldBridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    const dispatchPromise = heldBridge.tick();
    await execEntered;

    let optOutFinished = false;
    const optOutPromise = configureAgentReceive({
      profilePath: profile,
      mode: "turn",
      provider: "codex",
      hostSessionId: THREAD,
      cwd,
      execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
    }).then((res) => {
      optOutFinished = true;
      return res;
    });
    await delay(150);
    assert.equal(optOutFinished, false, "opt-out must wait on the shared receive lock while codex queue is in flight");
    releaseExec();
    assert.deepEqual(await dispatchPromise, { action: "sent", batch: 2, retry: false });
    await optOutPromise;
    assert.equal(optOutFinished, true);
    assert.equal(codexCalls.length, 1);

    // Once opt-out has completed, no further wake can ever be queued.
    await acknowledgeNativeWakeOnCheck({ profilePath: profile, hostSessionId: THREAD, now: () => clock });
    clock += NATIVE_WAKE_MIN_INTERVAL_MS;
    heldBridge.notifyArrival();
    clock += NATIVE_WAKE_DEBOUNCE_MS;
    const afterOptOut = await heldBridge.tick();
    assert.equal(afterOptOut.action, "binding_inactive");
    assert.equal(codexCalls.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("serveCodexWakeBridge survives a slow codex queue call past the heartbeat lock deadline, keeps polling, and still stops promptly on opt-out", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-slow-"));
  const previousHome = process.env.HOME;
  const previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.HOME = root;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");

  const inboxSignals: Array<Record<string, unknown>> = [];
  const codexInvocations: Array<readonly string[]> = [];
  let callNum = 0;
  let secondCallStarted!: () => void;
  const waitForSecondCall = new Promise<void>((done) => { secondCallStarted = done; });
  let releaseSecondCall!: () => void;
  const secondCallGate = new Promise<void>((done) => { releaseSecondCall = done; });

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !raw.trim()) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.resource === "members") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: AGENT, name: "CodexSeat", owner_user_id: OWNER }],
          identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: OWNER, workspace_name: "TestWS" },
        }));
        return;
      }
      if (body.resource === "signals") {
        const afterAt = typeof body.after_created_at === "string" ? Date.parse(body.after_created_at) : -Infinity;
        const afterId = typeof body.after_id === "string" ? body.after_id : "";
        const filtered = inboxSignals.filter((s) => {
          const ts = Date.parse(String(s.created_at));
          return ts > afterAt || (ts === afterAt && String(s.id) > afterId);
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          signals: filtered,
          pending_delivery_count: filtered.length,
          capabilities: { cursor_after: 1, delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
        }));
        return;
      }
      if (body.resource === "renewal_grants") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ grants: [] }));
        return;
      }
      const cmd = body.command as Record<string, unknown> | undefined;
      if (cmd?.kind === "touch_presence" || cmd?.kind === "ack_agent_delivery" || cmd?.kind === "signals_seen") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, status: "accepted", event_ids: [] }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unexpected" }));
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const abort = new AbortController();
  let serving: Promise<void> | undefined;
  let serveExited = false;
  try {
    const port = (server.address() as { port: number }).port;
    const { cwd, profile } = await setupBoundCodexSeat(root, `http://127.0.0.1:${port}`);
    serving = serveCodexWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      adapter: new CodexQueueAdapter({
        codexExecutable: "codex",
        runner: async (_exe, args, opts) => {
          callNum += 1;
          codexInvocations.push(args);
          if (callNum === 1) {
            // Hold longer than updateReceiveBinding's 2s lock timeout + multiple 150ms heartbeat ticks.
            await delay(2_500, undefined, { signal: opts.signal });
            assert.equal(opts.signal?.aborted ?? false, false, "heartbeat contention must NOT abort the slow codex queue subprocess");
          } else if (callNum === 2) {
            secondCallStarted();
            await secondCallGate;
          }
          return { stdout: "ok\n", stderr: "" };
        },
      }),
      debounceMs: 50,
      minIntervalMs: 100,
      pollMs: 60,
      heartbeatMs: 150,
      signal: abort.signal,
    }).finally(() => {
      serveExited = true;
    });

    await eventually(async () => receiveStatus(await readReceiveBinding(profile, THREAD)).channel_running);

    // 1. Trigger a slow (2.5s) codex queue call overlapping >15 heartbeat intervals and >2s lock deadline.
    const t0 = Date.now() + 1_000;
    inboxSignals.push({
      id: SIGNAL_1, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: AGENT,
      in_reply_to: null, about: null, kind: "ask", body: "SLOW_CALL_ONE",
      created_at: new Date(t0).toISOString(), until: "2099-01-01T00:00:00.000Z", sender_owner_relation: "same_owner",
    });
    await eventually(() => codexInvocations.length === 1);
    await delay(2_800);
    assert.equal(serveExited, false, "standalone receiver must survive slow codex queue call without self-stopping");
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).channel_running, true);

    // 2. Receiver continues polling: check acks batch 1, second DM triggers batch 2, and opt-out while call 2 is in flight stops cleanly.
    await checkAgentMessages({ profilePath: profile, hostSessionId: THREAD, present: async () => {} });
    inboxSignals.push({
      id: SIGNAL_2, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: AGENT,
      in_reply_to: null, about: null, kind: "ask", body: "SLOW_CALL_TWO",
      created_at: new Date(t0 + 5_000).toISOString(), until: "2099-01-01T00:00:00.000Z", sender_owner_relation: "same_owner",
    });
    await waitForSecondCall;
    let optOutDone = false;
    const optOutPromise = configureAgentReceive({
      profilePath: profile,
      mode: "turn",
      provider: "codex",
      hostSessionId: THREAD,
      cwd,
      execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
    }).then((res) => {
      optOutDone = true;
      return res;
    });
    await delay(150);
    assert.equal(optOutDone, false, "opt-out must still wait on the shared receive lock while slow call 2 is in flight");
    releaseSecondCall();
    await optOutPromise;
    await serving;
    assert.equal(serveExited, true, "receiver must stop promptly once opt-out completes");
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).channel_running, false);
    assert.equal(codexInvocations.length, 2);
  } finally {
    releaseSecondCall();
    abort.abort();
    await serving?.catch(() => undefined);
    if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = previousState;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("serveCodexWakeBridge refuses wake when wake mode is withdrawn during a held poll", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-withdraw-"));
  const previousHome = process.env.HOME;
  const previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.HOME = root;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");

  const codexInvocations: Array<readonly string[]> = [];
  let signalPollCount = 0;
  let heldPollStarted!: () => void;
  const waitForHeldPoll = new Promise<void>((done) => { heldPollStarted = done; });
  let releaseHeldPoll!: () => void;
  const heldPollGate = new Promise<void>((done) => { releaseHeldPoll = done; });

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !raw.trim()) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.resource === "members") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: AGENT, name: "CodexSeat", owner_user_id: OWNER }],
          identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: OWNER, workspace_name: "TestWS" },
        }));
        return;
      }
      if (body.resource === "signals") {
        signalPollCount += 1;
        if (signalPollCount === 1) {
          // Baseline poll returns empty immediately.
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            signals: [],
            pending_delivery_count: 0,
            capabilities: { cursor_after: 1, delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
          }));
          return;
        }
        // Hold second poll open until wake mode has been switched to turn, then deliver a fresh DM.
        heldPollStarted();
        void heldPollGate.then(() => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            signals: [{
              id: SIGNAL_1,
              workspace_id: WS,
              from: OWNER,
              from_kind: "user",
              to: null,
              to_agent: AGENT,
              in_reply_to: null,
              about: null,
              kind: "ask",
              body: "ARRIVED_DURING_HELD_POLL",
              created_at: new Date(Date.now() + 1_000).toISOString(),
              until: "2099-01-01T00:00:00.000Z",
              sender_owner_relation: "same_owner",
            }],
            pending_delivery_count: 1,
            capabilities: { cursor_after: 1, delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
          }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ grants: [] }));
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const abort = new AbortController();
  let serving: Promise<void> | undefined;
  try {
    const port = (server.address() as { port: number }).port;
    const { cwd, profile } = await setupBoundCodexSeat(root, `http://127.0.0.1:${port}`);
    serving = serveCodexWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      adapter: new CodexQueueAdapter({
        codexExecutable: "codex",
        runner: async (_exe, args) => {
          codexInvocations.push(args);
          return { stdout: "ok\n", stderr: "" };
        },
      }),
      debounceMs: 0,
      minIntervalMs: 100,
      pollMs: 50,
      heartbeatMs: 500,
      signal: abort.signal,
    });
    await waitForHeldPoll;

    // Operator switches to turn mode WHILE the poll request is in flight.
    await configureAgentReceive({
      profilePath: profile,
      mode: "turn",
      provider: "codex",
      hostSessionId: THREAD,
      cwd,
      execution: { command: process.execPath, args: [resolve("dist/cli.js")] },
    });

    releaseHeldPoll();
    await serving;
    assert.equal(codexInvocations.length, 0, "withdrawing wake mode during a held poll must prevent enqueueing");
  } finally {
    releaseHeldPoll();
    abort.abort();
    await serving?.catch(() => undefined);
    if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = previousState;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("serveCodexWakeBridge coalesces bursts, sends fixed-text wake, and verifies canary only after cswarm check", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-serve-"));
  const previousHome = process.env.HOME;
  const previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.HOME = root;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");

  const inboxSignals: Array<Record<string, unknown>> = [];
  const codexInvocations: Array<readonly string[]> = [];
  let seq = 1;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !raw.trim()) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      if (body.resource === "members") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: AGENT, name: "CodexSeat", owner_user_id: OWNER }],
          identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: OWNER, workspace_name: "TestWS" },
        }));
        return;
      }
      if (body.resource === "signals") {
        const afterAt = typeof body.after_created_at === "string" ? Date.parse(body.after_created_at) : -Infinity;
        const afterId = typeof body.after_id === "string" ? body.after_id : "";
        const filtered = inboxSignals.filter((s) => {
          const ts = Date.parse(String(s.created_at));
          return ts > afterAt || (ts === afterAt && String(s.id) > afterId);
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          signals: filtered,
          pending_delivery_count: filtered.length,
          capabilities: { cursor_after: 1, delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
        }));
        return;
      }
      if (body.resource === "renewal_grants") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ grants: [] }));
        return;
      }
      const cmd = body.command as Record<string, unknown> | undefined;
      if (cmd?.kind === "post_signal") {
        const created = {
          id: `dddddddd-dddd-4ddd-8ddd-00000000000${seq++}`,
          workspace_id: WS,
          from: AGENT,
          from_kind: "agent",
          to: null,
          to_agent: AGENT,
          in_reply_to: null,
          about: null,
          kind: "note",
          body: cmd.body,
          created_at: new Date(Date.now() + seq * 1000).toISOString(),
          until: new Date(Date.now() + 300_000).toISOString(),
          sender_owner_relation: "same_owner",
        };
        inboxSignals.push(created);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true,
          status: "accepted",
          event_ids: [],
          events: [],
          signal: created,
        }));
        return;
      }
      if (cmd?.kind === "touch_presence" || cmd?.kind === "ack_agent_delivery" || cmd?.kind === "signals_seen") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, status: "accepted", event_ids: [] }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unexpected" }));
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const abort = new AbortController();
  let serving: Promise<void> | undefined;
  try {
    const port = (server.address() as { port: number }).port;
    const { cwd, profile } = await setupBoundCodexSeat(root, `http://127.0.0.1:${port}`);
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).wake_route, "codex-queue");
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).wake_verified, false);

    const adapter = new CodexQueueAdapter({
      codexExecutable: "codex",
      runner: async (_exe, args) => {
        codexInvocations.push(args);
        return { stdout: "ok\n", stderr: "" };
      },
    });
    serving = serveCodexWakeBridge({
      profilePath: profile,
      hostSessionId: THREAD,
      adapter,
      debounceMs: 80,
      minIntervalMs: 100,
      pollMs: 80,
      heartbeatMs: 500,
      signal: abort.signal,
    });
    void serving.catch(() => undefined);
    await eventually(async () => receiveStatus(await readReceiveBinding(profile, THREAD)).channel_running);
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).wake_verified, false);

    // Acceptance 3 & 4: Two DMs in quick succession produce ONE fixed-text wake with ZERO message body.
    const t0 = Date.now() + 1_000;
    inboxSignals.push(
      {
        id: SIGNAL_1, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: AGENT,
        in_reply_to: null, about: null, kind: "ask", body: "SECRET_DM_BODY_ONE",
        created_at: new Date(t0).toISOString(), until: "2099-01-01T00:00:00.000Z", sender_owner_relation: "same_owner",
      },
      {
        id: SIGNAL_2, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: AGENT,
        in_reply_to: null, about: null, kind: "ask", body: "SECRET_DM_BODY_TWO",
        created_at: new Date(t0 + 10).toISOString(), until: "2099-01-01T00:00:00.000Z", sender_owner_relation: "same_owner",
      },
    );
    await eventually(() => codexInvocations.length === 1);
    await delay(200);
    assert.equal(codexInvocations.length, 1, "two quick DMs must coalesce into ONE wake");
    assert.deepEqual(codexInvocations[0], [
      "queue", "--thread", THREAD, "--message", "New CommonSwarm messages (batch 1): run cswarm check",
    ]);
    assert.equal(codexInvocations[0]!.join(" ").includes("SECRET_DM_BODY"), false);

    // Bound session runs cswarm check -> clears pending wake.
    const check1 = await checkAgentMessages({
      profilePath: profile,
      hostSessionId: THREAD,
      present: async () => {},
    });
    assert.equal(check1.messages.length, 2);
    assert.equal((await readNativeWakeState(profile, THREAD))!.pending_batch, null);

    // Acceptance 5: Canary verifies wake ONLY after Stop hook marks idle AND woken session runs cswarm check.
    await requestReceiveCanary(profile, THREAD);
    await delay(200);
    assert.equal(codexInvocations.length, 1, "canary must wait for idle before emitting");
    await receiveHookEvent(profile, THREAD, { session_id: THREAD, cwd, hook_event_name: "Stop" });
    await eventually(() => codexInvocations.length === 2);
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).wake_verified, false, "queuing canary alone does NOT mark wake_verified");

    // Woken Codex session runs cswarm check -> surfaces canary -> wake_verified flips to true.
    const check2 = await checkAgentMessages({
      profilePath: profile,
      hostSessionId: THREAD,
      present: async () => {},
    });
    assert.equal(check2.messages.length, 1);
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).wake_verified, true);
    assert.equal(receiveStatus(await readReceiveBinding(profile, THREAD)).wake_route, "codex-queue");

    // `cswarm whoami --profile ... --host-session-id ... --json` displays wake_route and wake_verified accurately.
    const whoamiRes = await promisify(execFile)(
      process.execPath,
      [resolve("dist/cli.js"), "whoami", "--profile", profile, "--host-session-id", THREAD, "--json"],
      { env: { ...process.env, HOME: root, SWARM_AGENT_STATE_DIR: join(root, "renewal") } },
    );
    const whoamiJson = JSON.parse(whoamiRes.stdout) as Record<string, unknown>;
    assert.equal(whoamiJson.wake_route, "codex-queue");
    assert.equal(whoamiJson.wake_verified, true);
  } finally {
    abort.abort();
    await serving;
    if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = previousState;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
