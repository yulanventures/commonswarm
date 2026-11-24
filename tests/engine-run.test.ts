import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../src/cloud/agent-credential-input.js";
import { arrivalWatchLockPath } from "../src/cloud/arrival-watch.js";
import { cloudTarget } from "../src/cloud/config.js";
import { listenerPaths } from "../src/listener/control.js";
import { CloudLinkError, type CloudLinkHandle, type OpenCloudLinkOptions } from "../src/engine/cloud-link.js";
import { RESTART_INTERRUPTED_REPLY } from "../src/engine/core.js";
import { SAFE_SYSTEM_PATH } from "../src/engine/launch.js";
import type { Clock, CloudPort, HarnessPort, IncomingMessage, ReplyCommand } from "../src/engine/ports.js";
import {
  ENGINE_EXIT_LEGACY_RECEIVER,
  ENGINE_EXIT_LIVE_DISABLED,
  ENGINE_EXIT_NOT_MANAGED,
  ENGINE_EXIT_OK,
  ENGINE_EXIT_SEAT_LOCKED,
  ENGINE_EXIT_SESSION_LOST,
  inspectEngineStatus,
  prepareHarnessSpawnRequest,
  renderEngineStatus,
  runEngine,
  type EngineContainmentOps,
  type EngineOperatorEvent,
  type EngineSignalName,
  type EngineSignalTarget,
} from "../src/engine/run.js";
import { probeSeatLock } from "../src/engine/seat-lock.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE_URL = "http://127.0.0.1:9999";
const ANON_KEY = "synthetic-anon-key";
const SENTINEL_TOKEN = `swm_agt_${"S".repeat(43)}`;
const SENTINEL_MSG = "TOP_SECRET_MESSAGE_BODY_ALPHA_991";
const SENTINEL_REPLY = "TOP_SECRET_REPLY_BODY_BETA_882";
const SENTINEL_SESSION_KEY = "SECRET_SESSION_PROOF_KEY_GAMMA_773";

class FakeSignalTarget implements EngineSignalTarget {
  private readonly emitter = new EventEmitter();
  on(signal: EngineSignalName, listener: () => void): void {
    this.emitter.on(signal, listener);
  }
  off(signal: EngineSignalName, listener: () => void): void {
    this.emitter.off(signal, listener);
  }
  emit(signal: EngineSignalName): void {
    this.emitter.emit(signal);
  }
  listenerCount(signal: EngineSignalName): number {
    return this.emitter.listenerCount(signal);
  }
}

class StepClock implements Clock {
  private t: number;
  constructor(start = Date.parse("2026-11-23T18:00:00.000Z")) {
    this.t = start;
  }
  now(): number {
    this.t += 10;
    return this.t;
  }
  peek(): number {
    return this.t;
  }
}

interface TestFixture {
  readonly root: string;
  readonly profileDir: string;
  readonly profilePath: string;
  readonly credentialPath: string;
  readonly stateRoot: string;
  readonly listenerStateDir: string;
  readonly arrivalWatchStateDir: string;
  readonly sessionStateDir: string;
  readonly cwd: string;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), "engine-run-test-"));
  await chmod(root, 0o700);
  const profileDir = join(root, "profile");
  const stateRoot = join(root, "engine-state");
  const listenerStateDir = join(root, "listeners");
  const arrivalWatchStateDir = join(root, "arrival-cursors");
  const sessionStateDir = join(root, "sessions");
  const cwd = join(root, "work");
  for (const dir of [profileDir, stateRoot, listenerStateDir, arrivalWatchStateDir, sessionStateDir, cwd]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  const credentialPath = join(profileDir, "credential.json");
  const profilePath = join(profileDir, "profile.json");
  await writeFile(
    credentialPath,
    JSON.stringify({
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: PRINCIPAL_ID,
      token_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222",
      agent_token: SENTINEL_TOKEN,
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    profilePath,
    JSON.stringify({
      version: 1,
      url: BASE_URL,
      anon_key: ANON_KEY,
      workspace_id: WORKSPACE_ID,
      principal_id: PRINCIPAL_ID,
      credential_file: credentialPath,
    }),
    { mode: 0o600 },
  );
  return {
    root,
    profileDir,
    profilePath,
    credentialPath,
    stateRoot,
    listenerStateDir,
    arrivalWatchStateDir,
    sessionStateDir,
    cwd,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function noopContainment(calls?: string[]): EngineContainmentOps {
  return {
    async containPrevious() {
      calls?.push("containPrevious");
      return { outcome: "none" };
    },
    async recordHarness(opts) {
      calls?.push(`recordHarness:${opts.pid}`);
      return { version: 1, pid: opts.pid, pgid: opts.pid, startedAt: 1000, recordedAt: 1000 };
    },
    async clearHarnessRecord() {
      calls?.push("clearHarnessRecord");
    },
  };
}

interface FakeServerState {
  readonly queue: Array<{ readonly id: string; readonly text: string }>;
  readonly leased: Map<string, { readonly id: string; readonly text: string; readonly leaseId: string }>;
  readonly seen: Array<{ readonly messageId: string; readonly leaseId: string; readonly generation: number }>;
  readonly replies: Array<{ readonly command: ReplyCommand; readonly generation: number }>;
  readonly replyByCommandId: Map<string, ReplyCommand>;
  generation: number;
  leaseSeq: number;
  waiters: Array<() => void>;
}

function createFakeServer(messages: readonly { readonly id: string; readonly text: string }[]): FakeServerState {
  return {
    queue: [...messages],
    leased: new Map(),
    seen: [],
    replies: [],
    replyByCommandId: new Map(),
    generation: 0,
    leaseSeq: 0,
    waiters: [],
  };
}

function createFakeCloudOpener(
  server: FakeServerState,
  hooks?: {
    onOpen?: (generation: number, triggerAuthorityLost: () => void) => void;
    onClose?: (generation: number) => void;
    onClaim?: () => void;
  },
) {
  return async (opts: OpenCloudLinkOptions): Promise<CloudLinkHandle> => {
    server.generation += 1;
    const gen = server.generation;
    const sessionId = `10000000-0000-4000-8000-${String(gen).padStart(12, "0")}`;

    // Mirror measured server behavior: new session reclaims unacknowledged leases.
    if (server.leased.size > 0) {
      const reclaimed = [...server.leased.values()].map((item) => ({ id: item.id, text: item.text }));
      server.leased.clear();
      server.queue.unshift(...reclaimed);
    }

    let closed = false;
    let lost = false;
    const triggerAuthorityLost = (): void => {
      if (lost) return;
      lost = true;
      opts.onAuthorityLost();
    };
    hooks?.onOpen?.(gen, triggerAuthorityLost);

    const port: CloudPort = {
      async claim(signal?: AbortSignal): Promise<IncomingMessage | null> {
        hooks?.onClaim?.();
        while (!closed && !lost && !signal?.aborted) {
          if (server.queue.length > 0) {
            const next = server.queue.shift()!;
            server.leaseSeq += 1;
            const leaseId = `lease-${gen}-${server.leaseSeq}`;
            server.leased.set(next.id, { id: next.id, text: next.text, leaseId });
            return {
              id: next.id,
              text: next.text,
              leaseId,
              replyTarget: { kind: "private", inReplyTo: next.id },
            };
          }
          await new Promise<void>((resolveWait) => {
            let done = false;
            const wake = () => {
              if (done) return;
              done = true;
              signal?.removeEventListener("abort", wake);
              resolveWait();
            };
            server.waiters.push(wake);
            signal?.addEventListener("abort", wake, { once: true });
          });
        }
        return null;
      },
      async markSeen(messageId: string, leaseId: string): Promise<void> {
        if (lost) throw new Error("authority lost");
        const leased = server.leased.get(messageId);
        if (leased && leased.leaseId === leaseId) {
          server.leased.delete(messageId);
        }
        server.seen.push({ messageId, leaseId, generation: gen });
      },
      async postReply(command: ReplyCommand): Promise<void> {
        if (lost) throw new Error("authority lost");
        if (!server.replyByCommandId.has(command.commandId)) {
          server.replyByCommandId.set(command.commandId, command);
          server.replies.push({ command, generation: gen });
        }
      },
    };

    return {
      port,
      generation: gen,
      sessionId,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        for (const w of server.waiters.splice(0)) w();
        hooks?.onClose?.(gen);
      },
    };
  };
}

async function waitUntil(predicate: () => boolean, maxMs = 5_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

test("1. live gate refuses without CSWARM_ENGINE_ALLOW_LIVE=1 before taking lock or calling network", async () => {
  const f = await createFixture();
  try {
    let cloudOpened = false;
    const lines: string[] = [];
    const events: EngineOperatorEvent[] = [];

    const result = await runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      env: { PATH: process.env.PATH },
      writeStderr: (line) => lines.push(line),
      onOperatorEvent: (ev) => events.push(ev),
      openCloudLink: async () => {
        cloudOpened = true;
        throw new Error("network must not be called");
      },
    });

    assert.equal(result.reason, "live_disabled");
    assert.equal(result.exitCode, ENGINE_EXIT_LIVE_DISABLED);
    assert.equal(cloudOpened, false);
    assert.deepEqual(events.map((e) => e.event), ["stopped"]);
    assert.match(lines.join(""), /live runs are not enabled yet/i);
    await assert.rejects(stat(join(f.stateRoot, "locks")), { code: "ENOENT" });

    // Also exercise the real built CLI binary with --help and without CSWARM_ENGINE_ALLOW_LIVE.
    const cliPath = resolve("dist/cli.js");
    const help = spawnSync(process.execPath, [cliPath, "engine", "--help"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.root },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /cswarm engine run --harness <claude\|codex>/);
    assert.match(help.stdout, /cswarm engine status/);
    assert.match(help.stdout, /CSWARM_ENGINE_ALLOW_LIVE=1/);

    const gated = spawnSync(
      process.execPath,
      [cliPath, "engine", "run", "--harness", "claude", "--profile", f.profilePath],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.root, XDG_STATE_HOME: join(f.root, "xdg-state") },
      },
    );
    assert.equal(gated.status, ENGINE_EXIT_LIVE_DISABLED, gated.stderr);
    assert.match(gated.stderr, /live_disabled/);
    await assert.rejects(stat(join(f.root, "xdg-state", "cswarm", "engine", "locks")), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("2. second runner for the same seat exits at once while the first holds the lock; engine status reports lock state", async () => {
  const f = await createFixture();
  try {
    const server = createFakeServer([]);
    const signals1 = new FakeSignalTarget();
    let ready1 = false;

    const run1 = runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      signalTarget: signals1,
      writeStderr: () => {},
      onOperatorEvent: (ev) => {
        if (ev.event === "harness_ready") ready1 = true;
      },
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server),
      createHarness: () => ({
        runTurn: async () => "ok",
        interrupt: () => {},
        close: async () => {},
      }),
    });

    await waitUntil(() => ready1);

    const statusWhileHeld = await inspectEngineStatus({
      profilePath: f.profilePath,
      stateRoot: f.stateRoot,
    });
    assert.equal(statusWhileHeld.lockHeld, true);
    assert.equal(statusWhileHeld.lockState, "held");
    assert.match(renderEngineStatus(statusWhileHeld, false), /Lock: held/);

    // Second runner exits immediately with distinct exit code without touching network or containment.
    let secondCloudCalled = false;
    const secondStderr: string[] = [];
    const run2 = await runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      writeStderr: (line) => secondStderr.push(line),
      containment: noopContainment(),
      openCloudLink: async () => {
        secondCloudCalled = true;
        throw new Error("second runner must not call cloud");
      },
      createHarness: () => {
        throw new Error("second runner must not create harness");
      },
    });

    assert.equal(run2.reason, "seat_locked");
    assert.equal(run2.exitCode, ENGINE_EXIT_SEAT_LOCKED);
    assert.notEqual(run2.exitCode, ENGINE_EXIT_OK);
    assert.notEqual(run2.exitCode, ENGINE_EXIT_LIVE_DISABLED);
    assert.equal(secondCloudCalled, false);
    assert.match(secondStderr.join(""), /seat_locked/);

    signals1.emit("SIGTERM");
    const res1 = await run1;
    assert.equal(res1.reason, "stopped");
    assert.equal(res1.exitCode, ENGINE_EXIT_OK);

    const statusAfterStop = await inspectEngineStatus({
      profilePath: f.profilePath,
      stateRoot: f.stateRoot,
    });
    assert.equal(statusAfterStop.lockHeld, false);
    assert.equal(statusAfterStop.lockState, "free");
    assert.equal(statusAfterStop.lastStopReason, "stopped");
    assert.equal(statusAfterStop.lastExitCode, ENGINE_EXIT_OK);
  } finally {
    await f.cleanup();
  }
});

test("3. legacy receiver markers refuse to start without killing them, and dead PIDs do not block", async () => {
  const f = await createFixture();
  try {
    const target = cloudTarget(BASE_URL, ANON_KEY);

    // 3a. Legacy listener status.json with live PID (current process.pid).
    const lPaths = listenerPaths({
      profileId: target.profileId,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      stateDirectory: f.listenerStateDir,
    });
    await mkdir(lPaths.instanceDirectory, { recursive: true, mode: 0o700 });
    await chmod(lPaths.instanceDirectory, 0o700);
    await writeFile(
      lPaths.statusPath,
      JSON.stringify({
        version: 1,
        instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        provider: "claude",
        profileId: target.profileId,
        workspaceId: WORKSPACE_ID,
        principalId: PRINCIPAL_ID,
        pid: process.pid,
        state: "ready",
        startedAt: "2026-11-23T18:00:00.000Z",
        readyAt: "2026-11-23T18:00:01.000Z",
        updatedAt: "2026-11-23T18:00:01.000Z",
        stoppedAt: null,
        lastSignalId: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        lastWorkerStderrTail: null,
        deliveryMode: "durable_claim",
        pendingDeliveryCount: 0,
        lastTerminalDeliveryFailureCount: 0,
        lastTerminalDeliveryFailureAt: null,
        lastClaimAt: null,
        lastAckAt: null,
        lastAckOutcome: null,
        consecutiveAckFailureCount: null,
        logPath: lPaths.logPath,
      }),
      { mode: 0o600 },
    );

    let cloudCalls = 0;
    const resListener = await runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      writeStderr: () => {},
      containment: noopContainment(),
      openCloudLink: async () => {
        cloudCalls += 1;
        throw new Error("should not reach cloud");
      },
      createHarness: () => {
        throw new Error("should not create harness");
      },
    });
    assert.equal(resListener.reason, "legacy_receiver_running");
    assert.equal(resListener.legacyReceiver, "listener");
    assert.equal(resListener.exitCode, ENGINE_EXIT_LEGACY_RECEIVER);
    assert.equal(cloudCalls, 0);
    // Marker file was not deleted and process was not killed.
    assert.equal((await stat(lPaths.statusPath)).isFile(), true);
    await rm(lPaths.statusPath);

    // 3b. Legacy receive-<scope>.json channel marker with live PID & fresh heartbeat.
    const clock = new StepClock();
    const receivePath = join(f.profileDir, "receive-testscope.json");
    await writeFile(
      receivePath,
      JSON.stringify({
        version: 1,
        profile: f.profilePath,
        host_session_id: "sess-1",
        provider: "claude",
        requested_mode: "wake",
        cwd: f.cwd,
        channel_pid: process.pid,
        channel_heartbeat_at: new Date(clock.peek()).toISOString(),
      }),
      { mode: 0o600 },
    );
    const resReceive = await runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      clock,
      writeStderr: () => {},
      containment: noopContainment(),
      openCloudLink: async () => {
        cloudCalls += 1;
        throw new Error("should not reach cloud");
      },
      createHarness: () => {
        throw new Error("should not create harness");
      },
    });
    assert.equal(resReceive.reason, "legacy_receiver_running");
    assert.equal(resReceive.legacyReceiver, "receive_channel");
    assert.equal(resReceive.exitCode, ENGINE_EXIT_LEGACY_RECEIVER);
    await rm(receivePath);

    // 3c. Legacy inbox --notify lock file with live PID.
    const notifyLock = arrivalWatchLockPath(target, WORKSPACE_ID, PRINCIPAL_ID, f.arrivalWatchStateDir);
    await writeFile(notifyLock, JSON.stringify({ version: 1, pid: process.pid }), { mode: 0o600 });
    const resNotify = await runEngine({
      harness: "codex",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      writeStderr: () => {},
      containment: noopContainment(),
      openCloudLink: async () => {
        cloudCalls += 1;
        throw new Error("should not reach cloud");
      },
      createHarness: () => {
        throw new Error("should not create harness");
      },
    });
    assert.equal(resNotify.reason, "legacy_receiver_running");
    assert.equal(resNotify.legacyReceiver, "inbox_notify");
    assert.equal(resNotify.exitCode, ENGINE_EXIT_LEGACY_RECEIVER);

    // 3d. Dead PID in the notify lock does NOT block startup.
    await writeFile(notifyLock, JSON.stringify({ version: 1, pid: 999_999_999 }), { mode: 0o600 });
    const signals = new FakeSignalTarget();
    const server = createFakeServer([]);
    const runPromise = runEngine({
      harness: "codex",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      signalTarget: signals,
      writeStderr: () => {},
      onOperatorEvent: (ev) => {
        if (ev.event === "harness_ready") signals.emit("SIGINT");
      },
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server),
      createHarness: () => ({
        runTurn: async () => "ok",
        interrupt: () => {},
        close: async () => {},
      }),
    });
    const resClean = await runPromise;
    assert.equal(resClean.reason, "stopped");
    assert.equal(resClean.exitCode, ENGINE_EXIT_OK);
  } finally {
    await f.cleanup();
  }
});

test("4. refuses a seat that is not managed-enabled with the server reason and releases resources", async () => {
  const f = await createFixture();
  try {
    const serverMsg = "managed sessions are not enabled for this agent; an owner or admin must enable them first";
    const stderrLines: string[] = [];
    const events: EngineOperatorEvent[] = [];

    const result = await runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      writeStderr: (line) => stderrLines.push(line),
      onOperatorEvent: (ev) => events.push(ev),
      containment: noopContainment(),
      openCloudLink: async () => {
        throw new CloudLinkError("session_not_managed", serverMsg);
      },
      createHarness: () => {
        throw new Error("harness must not start when seat is not managed");
      },
    });

    assert.equal(result.reason, "seat_not_managed");
    assert.equal(result.exitCode, ENGINE_EXIT_NOT_MANAGED);
    assert.equal(result.serverReason, serverMsg);
    assert.ok(stderrLines.join("").includes(serverMsg));
    assert.ok(events.some((e) => e.event === "journal_closed"));
    assert.ok(events.some((e) => e.event === "seat_unlocked"));

    const lockState = await probeSeatLock({
      root: f.stateRoot,
      deployment: BASE_URL,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    });
    assert.equal(lockState, "free");
  } finally {
    await f.cleanup();
  }
});

test("5. startup and shutdown order asserted from operator events (text and --json)", async () => {
  const f = await createFixture();
  try {
    for (const jsonMode of [false, true]) {
      const server = createFakeServer([]);
      const signals = new FakeSignalTarget();
      const events: EngineOperatorEvent[] = [];
      const rawLines: string[] = [];
      const stepTrace: string[] = [];

      const runPromise = runEngine({
        harness: "claude",
        profilePath: f.profilePath,
        cwd: f.cwd,
        stateRoot: f.stateRoot,
        listenerStateDir: f.listenerStateDir,
        arrivalWatchStateDir: f.arrivalWatchStateDir,
        sessionStateDir: f.sessionStateDir,
        json: jsonMode,
        signalTarget: signals,
        writeStderr: (line) => rawLines.push(line),
        onOperatorEvent: (ev) => {
          events.push(ev);
          if (ev.event === "harness_ready") signals.emit("SIGHUP");
        },
        containment: noopContainment(stepTrace),
        openCloudLink: createFakeCloudOpener(server, {
          onOpen: (gen) => stepTrace.push(`cloudOpen:${gen}`),
          onClose: (gen) => stepTrace.push(`cloudClose:${gen}`),
        }),
        createHarness: () => ({
          runTurn: async () => "ok",
          interrupt: () => { stepTrace.push("harnessInterrupt"); },
          close: async () => { stepTrace.push("harnessClose"); },
        }),
      });

      const res = await runPromise;
      assert.equal(res.reason, "stopped");
      assert.equal(res.exitCode, ENGINE_EXIT_OK);

      const names = events.map((e) => e.event);
      assert.deepEqual(names, [
        "started",
        "seat_locked",
        "previous_contained",
        "journal_opened",
        "preflight_ok",
        "session_acquired",
        "harness_ready",
        "stopping",
        "harness_closed",
        "session_released",
        "journal_closed",
        "seat_unlocked",
        "stopped",
      ]);

      const acquired = events.find((e) => e.event === "session_acquired")!;
      assert.equal(acquired.generation, 1);
      assert.equal(events.at(-1)!.reason, "stopped");
      assert.equal(events.at(-1)!.exitCode, 0);

      // Containment ran before cloud open; harness close ran before clearHarnessRecord and cloudClose.
      assert.ok(stepTrace.indexOf("containPrevious") < stepTrace.indexOf("cloudOpen:1"));
      assert.ok(stepTrace.indexOf("harnessClose") < stepTrace.indexOf("clearHarnessRecord"));
      assert.ok(stepTrace.indexOf("clearHarnessRecord") < stepTrace.indexOf("cloudClose:1"));

      if (jsonMode) {
        assert.equal(rawLines.length, names.length);
        const parsed = rawLines.map((line) => JSON.parse(line) as EngineOperatorEvent);
        assert.deepEqual(parsed.map((e) => e.event), names);
      } else {
        assert.ok(rawLines.every((line) => line.startsWith("engine event=")));
      }
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
      assert.equal(signals.listenerCount("SIGHUP"), 0);
    }
  } finally {
    await f.cleanup();
  }
});

test("6. 20 messages through full wiring with restart between turns and crash mid-turn: none lost, none run twice, interrupted reported once", async () => {
  const f = await createFixture();
  try {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      text: `msg-${i + 1}`,
    }));
    const server = createFakeServer(messages);
    const harnessRuns: string[] = [];

    // Run 1: process messages 1..6 cleanly, then SIGTERM between turns (when reply 6 is posted).
    const signals1 = new FakeSignalTarget();
    const run1 = runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      signalTarget: signals1,
      writeStderr: () => {},
      onOperatorEvent: (ev) => {
        if (ev.event === "reply_posted" && ev.messageId === messages[5]!.id) {
          signals1.emit("SIGTERM");
        }
      },
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server),
      createHarness: () => ({
        async runTurn(text, onHandedOver) {
          harnessRuns.push(text);
          onHandedOver?.();
          return `reply-for-${text}`;
        },
        interrupt() {},
        async close() {},
      }),
    });
    const res1 = await run1;
    assert.equal(res1.reason, "stopped");
    assert.equal(res1.exitCode, ENGINE_EXIT_OK);
    assert.equal(harnessRuns.length, 6);

    // Run 2: process messages 7..12, then simulate crash (escalated stop) WHILE message 13 is running!
    // Message 13 has durable turn_started in the journal; escalated stop aborts without posting a reply,
    // leaving turn_started active so Run 3 must recover it as interrupted once and never run it again.
    const signals2 = new FakeSignalTarget();
    let releaseTurn13!: () => void;
    let turn13Started = false;
    const run2 = runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      signalTarget: signals2,
      writeStderr: () => {},
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server),
      createHarness: () => ({
        async runTurn(text, onHandedOver) {
          harnessRuns.push(text);
          onHandedOver?.();
          if (text === "msg-13") {
            turn13Started = true;
            await new Promise<void>((resolveTurn) => {
              releaseTurn13 = resolveTurn;
            });
            throw new Error("killed mid-turn");
          }
          return `reply-for-${text}`;
        },
        interrupt() {
          releaseTurn13?.();
        },
        async close() {
          releaseTurn13?.();
        },
      }),
    });

    await waitUntil(() => turn13Started);
    // Double SIGTERM escalates child kill mid-turn, leaving turn 13 active in the journal.
    signals2.emit("SIGTERM");
    signals2.emit("SIGTERM");
    const res2 = await run2;
    assert.equal(res2.reason, "stopped");
    assert.equal(harnessRuns.length, 13);

    // Run 3: restart after mid-turn interruption -> posts interrupted notice for msg-13 once (without re-running it),
    // processes messages 14..20 in order, then stops cleanly.
    const signals3 = new FakeSignalTarget();
    const events3: EngineOperatorEvent[] = [];
    const run3 = runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      signalTarget: signals3,
      writeStderr: () => {},
      onOperatorEvent: (ev) => {
        events3.push(ev);
        if (ev.event === "reply_posted" && ev.messageId === messages[19]!.id) {
          signals3.emit("SIGTERM");
        }
      },
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server),
      createHarness: () => ({
        async runTurn(text, onHandedOver) {
          harnessRuns.push(text);
          onHandedOver?.();
          return `reply-for-${text}`;
        },
        interrupt() {},
        async close() {},
      }),
    });
    const res3 = await run3;
    assert.equal(res3.reason, "stopped");
    assert.equal(res3.exitCode, ENGINE_EXIT_OK);

    // Exactly 20 harness runs total, in strict order, none run twice!
    assert.deepEqual(
      harnessRuns,
      messages.map((m) => m.text),
    );
    // Exactly 20 replies total, in order: 1..12 normal, 13 interrupted notice once, 14..20 normal.
    assert.equal(server.replies.length, 20);
    for (let i = 0; i < 20; i += 1) {
      const expectedMsg = messages[i]!;
      const reply = server.replies[i]!.command;
      assert.deepEqual(reply.replyTarget, { kind: "private", inReplyTo: expectedMsg.id });
      if (i === 12) {
        assert.equal(reply.body, RESTART_INTERRUPTED_REPLY);
        assert.equal(reply.status, "failed");
      } else {
        assert.equal(reply.body, `reply-for-${expectedMsg.text}`);
        assert.equal(reply.status, "answered");
      }
    }
    // Interrupted notice emitted once in operator events and msg-13 was acknowledged seen.
    const interruptedNotices = events3.filter((e) => e.event === "interrupted_notice_posted");
    assert.equal(interruptedNotices.length, 1);
    assert.equal(interruptedNotices[0]!.messageId, messages[12]!.id);
    assert.ok(server.seen.some((s) => s.messageId === messages[12]!.id));
    assert.equal(server.queue.length, 0);
    assert.equal(server.leased.size, 0);

    const status = await inspectEngineStatus({ profilePath: f.profilePath, stateRoot: f.stateRoot });
    assert.deepEqual(status.journal, {
      exists: true,
      accepted: 0,
      running: 0,
      finished: 20,
      unposted: 0,
    });
    assert.equal(status.lockHeld, false);
    assert.equal(status.lastStopReason, "stopped");
  } finally {
    await f.cleanup();
  }
});

test("7. session lost mid-run stops claiming, exits non-zero, and releases the seat lock", async () => {
  const f = await createFixture();
  try {
    const server = createFakeServer([
      { id: "40000000-0000-4000-8000-000000000001", text: "first" },
      { id: "40000000-0000-4000-8000-000000000002", text: "second" },
    ]);
    let triggerLost!: () => void;
    let claimsAfterLost = 0;
    let lostTriggered = false;
    let interruptCalled = false;
    let releaseFirstTurn!: () => void;
    let firstTurnStarted = false;
    const events: EngineOperatorEvent[] = [];

    const runPromise = runEngine({
      harness: "codex",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      writeStderr: () => {},
      onOperatorEvent: (ev) => events.push(ev),
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server, {
        onOpen: (_gen, trigger) => { triggerLost = trigger; },
        onClaim: () => { if (lostTriggered) claimsAfterLost += 1; },
      }),
      createHarness: () => ({
        async runTurn(_text, onHandedOver) {
          onHandedOver?.();
          firstTurnStarted = true;
          await new Promise<void>((r) => { releaseFirstTurn = r; });
          throw new Error("interrupted");
        },
        interrupt() {
          interruptCalled = true;
          releaseFirstTurn?.();
        },
        async close() {
          releaseFirstTurn?.();
        },
      }),
    });

    await waitUntil(() => firstTurnStarted);
    lostTriggered = true;
    triggerLost();

    const result = await runPromise;
    assert.equal(result.reason, "authority_lost");
    assert.equal(result.exitCode, ENGINE_EXIT_SESSION_LOST);
    assert.notEqual(result.exitCode, 0);
    assert.equal(interruptCalled, true);
    assert.equal(claimsAfterLost, 0);
    assert.equal(server.replies.length, 0);
    assert.ok(events.some((e) => e.event === "session_lost"));
    assert.ok(events.some((e) => e.event === "harness_closed"));
    assert.ok(events.some((e) => e.event === "journal_closed"));
    assert.ok(events.some((e) => e.event === "seat_unlocked"));

    const lockState = await probeSeatLock({
      root: f.stateRoot,
      deployment: BASE_URL,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    });
    assert.equal(lockState, "free");
  } finally {
    await f.cleanup();
  }
});

test("8. SIGTERM during a turn performs ordered shutdown with harness group empty before lock release", async () => {
  const f = await createFixture();
  try {
    const server = createFakeServer([
      { id: "50000000-0000-4000-8000-000000000001", text: "in-flight-msg" },
      { id: "50000000-0000-4000-8000-000000000002", text: "should-not-claim" },
    ]);
    const signals = new FakeSignalTarget();
    const events: EngineOperatorEvent[] = [];
    let turnStarted = false;
    let finishTurn!: () => void;
    let lockStateInsideHarnessClose: string | null = null;
    let harnessGroupEmpty = false;
    const ranTexts: string[] = [];

    const runPromise = runEngine({
      harness: "claude",
      profilePath: f.profilePath,
      cwd: f.cwd,
      stateRoot: f.stateRoot,
      listenerStateDir: f.listenerStateDir,
      arrivalWatchStateDir: f.arrivalWatchStateDir,
      sessionStateDir: f.sessionStateDir,
      signalTarget: signals,
      writeStderr: () => {},
      onOperatorEvent: (ev) => events.push(ev),
      containment: noopContainment(),
      openCloudLink: createFakeCloudOpener(server),
      createHarness: () => ({
        async runTurn(text, onHandedOver) {
          ranTexts.push(text);
          onHandedOver?.();
          turnStarted = true;
          await new Promise<void>((r) => { finishTurn = r; });
          return "clean-reply";
        },
        interrupt() {},
        async close() {
          lockStateInsideHarnessClose = await probeSeatLock({
            root: f.stateRoot,
            deployment: BASE_URL,
            workspaceId: WORKSPACE_ID,
            principalId: PRINCIPAL_ID,
          });
          harnessGroupEmpty = true;
        },
      }),
    });

    await waitUntil(() => turnStarted);
    signals.emit("SIGTERM");
    finishTurn();

    const result = await runPromise;
    assert.equal(result.reason, "stopped");
    assert.equal(result.exitCode, ENGINE_EXIT_OK);
    assert.deepEqual(ranTexts, ["in-flight-msg"]);
    assert.equal(harnessGroupEmpty, true);
    assert.equal(lockStateInsideHarnessClose, "held", "seat lock must still be held while harness closes");

    const afterLock = await probeSeatLock({
      root: f.stateRoot,
      deployment: BASE_URL,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
    });
    assert.equal(afterLock, "free");

    const names = events.map((e) => e.event);
    assert.ok(names.indexOf("stopping") < names.indexOf("harness_closed"));
    assert.ok(names.indexOf("harness_closed") < names.indexOf("session_released"));
    assert.ok(names.indexOf("session_released") < names.indexOf("journal_closed"));
    assert.ok(names.indexOf("journal_closed") < names.indexOf("seat_unlocked"));
    assert.ok(names.indexOf("seat_unlocked") < names.indexOf("stopped"));
  } finally {
    await f.cleanup();
  }
});

test("9. operator output contains no message text, no credential, and no full home paths", async () => {
  const f = await createFixture();
  try {
    const server = createFakeServer([
      { id: "60000000-0000-4000-8000-000000000001", text: SENTINEL_MSG },
      { id: "60000000-0000-4000-8000-000000000002", text: `${SENTINEL_MSG}-fail` },
    ]);

    for (const jsonMode of [false, true]) {
      const modeStateRoot = join(f.stateRoot, jsonMode ? "json" : "text");
      await mkdir(modeStateRoot, { recursive: true, mode: 0o700 });
      await chmod(modeStateRoot, 0o700);
      const localServer = createFakeServer(server.queue);
      const signals = new FakeSignalTarget();
      const stderrLines: string[] = [];
      let turnNum = 0;

      const runPromise = runEngine({
        harness: "claude",
        profilePath: f.profilePath,
        cwd: f.cwd,
        stateRoot: modeStateRoot,
        listenerStateDir: f.listenerStateDir,
        arrivalWatchStateDir: f.arrivalWatchStateDir,
        sessionStateDir: f.sessionStateDir,
        json: jsonMode,
        signalTarget: signals,
        writeStderr: (line) => stderrLines.push(line),
        onOperatorEvent: (ev) => {
          if (ev.event === "reply_posted" && ev.messageId === "60000000-0000-4000-8000-000000000002") {
            signals.emit("SIGTERM");
          }
        },
        containment: noopContainment(),
        openCloudLink: createFakeCloudOpener(localServer),
        createHarness: () => ({
          async runTurn(_text, onHandedOver) {
            turnNum += 1;
            onHandedOver?.();
            if (turnNum === 2) {
              throw new Error(
                `boom ${SENTINEL_TOKEN} ${SENTINEL_SESSION_KEY} ${SENTINEL_MSG} ${f.profilePath} ${f.stateRoot}`,
              );
            }
            return SENTINEL_REPLY;
          },
          interrupt() {},
          async close() {},
        }),
      });

      const res = await runPromise;
      assert.equal(res.reason, "stopped");
      const allOutput = stderrLines.join("");
      assert.ok(allOutput.length > 0);
      assert.equal(allOutput.includes(SENTINEL_MSG), false, "message text leaked");
      assert.equal(allOutput.includes(SENTINEL_REPLY), false, "reply text leaked");
      assert.equal(allOutput.includes(SENTINEL_TOKEN), false, "agent token leaked");
      assert.equal(allOutput.includes(SENTINEL_SESSION_KEY), false, "session key leaked");
      assert.equal(allOutput.includes(f.root), false, "full root path leaked");
      assert.equal(allOutput.includes(f.profilePath), false, "profile path leaked");
      assert.equal(allOutput.includes(f.credentialPath), false, "credential path leaked");
    }
  } finally {
    await f.cleanup();
  }
});

test("10. spawn request for claude and codex: pinned absolute executable, fixed args, minimal env, no seat credential", async () => {
  const f = await createFixture();
  try {
    const binDir = join(f.root, "bin");
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    const fakeClaude = join(binDir, "claude-agent-acp");
    const fakeCodex = join(binDir, "codex-acp");
    await writeFile(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(fakeClaude, 0o700);
    await chmod(fakeCodex, 0o700);

    const seatDir = join(f.stateRoot, "seats", "seat-folder-abc");
    await mkdir(seatDir, { recursive: true, mode: 0o700 });

    const parentEnv: Record<string, string> = {
      HOME: f.root,
      LANG: "en_US.UTF-8",
      TMPDIR: tmpdir(),
      PATH: "/custom/untrusted/bin:/usr/bin:/bin",
      SWARM_AGENT_TOKEN: SENTINEL_TOKEN,
      CSWARM_SESSION_KEY: SENTINEL_SESSION_KEY,
      CSWARM_ENGINE_ALLOW_LIVE: "1",
      API_SECRET_KEY: "super-secret-key",
      DATABASE_PASSWORD: "super-secret-password",
      OPENAI_API_KEY: "sk-leaked-parent-key",
      ANTHROPIC_API_KEY: "sk-ant-leaked-parent-key",
      UNRELATED_VAR: "must-not-be-inherited",
    };

    for (const [harness, execPath, configVar] of [
      ["claude", fakeClaude, "CLAUDE_CONFIG_DIR"],
      ["codex", fakeCodex, "CODEX_HOME"],
    ] as const) {
      const req = await prepareHarnessSpawnRequest({
        harness,
        executable: execPath,
        cwd: f.cwd,
        seatDir,
        parentEnv,
      });

      assert.equal(req.harness, harness);
      assert.equal(req.mode, "deny_only");
      assert.equal(req.shell, false);
      assert.equal(req.prepared.executable.startsWith("/"), true);
      assert.equal(basename(req.prepared.executable), basename(execPath));
      assert.deepEqual(req.prepared.args, []);
      assert.equal(req.prepared.cwd, f.cwd);

      // Minimal allowlisted environment + engine-owned config root only.
      const envKeys = Object.keys(req.prepared.env).sort();
      assert.deepEqual(envKeys, ["HOME", "LANG", "PATH", "TMPDIR", configVar].sort());
      assert.ok(req.prepared.env.PATH!.startsWith(SAFE_SYSTEM_PATH));
      assert.equal(req.prepared.env.PATH!.includes("/custom/untrusted/bin"), false);
      assert.equal(req.prepared.env[configVar], join(seatDir, "config-root", harness));

      // No seat credential, session proof, or journal path anywhere in env or args.
      const serialized = JSON.stringify({ args: req.prepared.args, env: req.prepared.env });
      assert.equal(serialized.includes(SENTINEL_TOKEN), false);
      assert.equal(serialized.includes(SENTINEL_SESSION_KEY), false);
      assert.equal(serialized.includes("journal.ndjson"), false);
      assert.equal(serialized.includes("UNRELATED_VAR"), false);
      assert.equal(serialized.includes("CSWARM_"), false);
      assert.equal(serialized.includes("SWARM_"), false);
    }
  } finally {
    await f.cleanup();
  }
});
