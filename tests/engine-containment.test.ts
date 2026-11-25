import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AcpClient } from "../src/engine/acp.js";
import { AcpHarness } from "../src/engine/acp-harness.js";
import {
  ContainmentError,
  clearHarnessRecord,
  containPrevious,
  recordHarness,
} from "../src/engine/containment.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CONTAINMENT_URL = pathToFileURL(join(REPO_ROOT, "src/engine/containment.ts")).href;
const LOOKUP_TIMEOUT_MS = 2_000;
const SHORT_GRACE_MS = 200;
const TERM_GRACE_MS = 2_000;

const HELPER_SOURCE = `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(process.argv[2]);
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");

if (config.mode === "grandchild-ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
  emit({ event: "grandchild_ready", pid: process.pid });
} else if (config.mode === "harness-ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
  const grandchild = spawn(
    process.execPath,
    [process.argv[1], JSON.stringify({ mode: "grandchild-ignore-term" })],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const rl = createInterface({ input: grandchild.stdout });
  rl.once("line", (line) => {
    rl.close();
    grandchild.stdout.destroy();
    const ev = JSON.parse(line);
    emit({ event: "harness_ready", harnessPid: process.pid, grandchildPid: ev.pid });
  });
} else if (config.mode === "fake-engine") {
  const { recordHarness } = await import(${JSON.stringify(CONTAINMENT_URL)});
  const harness = spawn(
    process.execPath,
    [process.argv[1], JSON.stringify({ mode: "harness-ignore-term" })],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const rl = createInterface({ input: harness.stdout });
  rl.once("line", async (line) => {
    rl.close();
    harness.stdout.destroy();
    const ev = JSON.parse(line);
    try {
      await recordHarness({
        dir: config.dir,
        pid: ev.harnessPid,
        lookupTimeoutMs: config.lookupTimeoutMs,
      });
      emit({
        event: "recorded",
        enginePid: process.pid,
        harnessPid: ev.harnessPid,
        grandchildPid: ev.grandchildPid,
      });
    } catch (err) {
      try { process.kill(-ev.harnessPid, "SIGKILL"); } catch {}
      emit({
        event: "error",
        code: err && typeof err === "object" && "code" in err ? err.code : null,
        message: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });
  setInterval(() => {}, 60_000);
} else if (config.mode === "child-exit-on-term") {
  process.on("SIGTERM", () => {
    if (config.markerPath) writeFileSync(config.markerPath, "child_sigterm\\n", "utf8");
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
  emit({ event: "child_ready", pid: process.pid });
} else if (config.mode === "harness-exit-on-term") {
  process.on("SIGTERM", () => {
    if (config.markerPath) writeFileSync(config.markerPath, "sigterm\\n", "utf8");
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
  const child = spawn(
    process.execPath,
    [process.argv[1], JSON.stringify({ mode: "child-exit-on-term", markerPath: config.childMarkerPath })],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const rl = createInterface({ input: child.stdout });
  rl.once("line", (line) => {
    rl.close();
    child.stdout.destroy();
    const ev = JSON.parse(line);
    emit({ event: "ready", pid: process.pid, childPid: ev.pid });
  });
} else if (config.mode === "decoy" || config.mode === "short-lived") {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line === "ping") emit({ event: "pong", pid: process.pid });
    if (line === "exit") {
      rl.close();
      process.exit(0);
    }
  });
  rl.on("close", () => process.exit(0));
  emit({ event: "ready", pid: process.pid });
} else if (config.mode === "leader-exits-child-stays") {
  const member = spawn(
    process.execPath,
    [process.argv[1], JSON.stringify({ mode: "grandchild-ignore-term" })],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const memberRl = createInterface({ input: member.stdout });
  memberRl.once("line", (line) => {
    memberRl.close();
    member.stdout.destroy();
    const ev = JSON.parse(line);
    emit({ event: "ready", leaderPid: process.pid, memberPid: ev.pid });
  });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line === "exit") {
      rl.close();
      process.exit(0);
    }
  });
  rl.on("close", () => process.exit(0));
} else if (config.mode === "acp-check-record") {
  if (config.ignoreTerm) process.on("SIGTERM", () => {});
  let firstLineReport = null;
  const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (firstLineReport === null) {
      const existed = existsSync(config.recordPath);
      let recordedPid = null;
      if (existed) {
        try { recordedPid = JSON.parse(readFileSync(config.recordPath, "utf8")).pid ?? null; } catch {}
      }
      firstLineReport = { existed, recordedPid, myPid: process.pid, firstMethod: msg.method ?? null };
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
    } else if (msg.method === "session/prompt") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(firstLineReport) } },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  });
}
`;

interface HelperEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

class HelperProcess {
  readonly child: ChildProcess;
  private readonly queue: HelperEvent[] = [];
  private readonly waiters: Array<{ resolve: (ev: HelperEvent) => void; reject: (err: Error) => void }> = [];
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private stderr = "";
  private closed = false;

  constructor(helperPath: string, config: Record<string, unknown>, opts: { detached?: boolean; useTsx?: boolean } = {}) {
    const args = opts.useTsx
      ? ["--import", "tsx", helperPath, JSON.stringify(config)]
      : [helperPath, JSON.stringify(config)];
    this.child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      detached: opts.detached ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      const parsed = JSON.parse(line) as HelperEvent;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(parsed);
      else this.queue.push(parsed);
    });
    this.exited = once(this.child, "exit").then(([code, signal]) => {
      this.closed = true;
      rl.close();
      while (this.waiters.length > 0) {
        this.waiters.shift()!.reject(new Error(`helper exited early (code=${code}, signal=${signal}): ${this.stderr}`));
      }
      return { code: code as number | null, signal: signal as NodeJS.Signals | null };
    });
  }

  nextEvent(): Promise<HelperEvent> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error(`helper already exited: ${this.stderr}`));
    return new Promise((resolvePromise, reject) => {
      this.waiters.push({ resolve: resolvePromise, reject });
    });
  }

  send(line: string): void {
    this.child.stdin!.write(`${line}\n`);
  }

  waitExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exited;
  }

  async killAndWait(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined) {
      try { this.child.kill(signal); } catch { /* already gone */ }
    }
    await this.exited;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function forceKillTargets(targets: readonly number[]): void {
  for (const target of targets) {
    try { process.kill(target, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function withWorkspace(
  fn: (ctx: {
    readonly workDir: string;
    readonly stateDir: string;
    readonly helperPath: string;
    readonly trackProcess: (proc: HelperProcess) => HelperProcess;
    readonly trackKillTarget: (target: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "engine-containment-test-"));
  const stateDir = join(workDir, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await chmod(stateDir, 0o700);
  const helperPath = join(workDir, "engine-containment-helper.mjs");
  await writeFile(helperPath, HELPER_SOURCE, { mode: 0o600 });

  const trackedProcs: HelperProcess[] = [];
  const trackedTargets: number[] = [];
  const trackProcess = (proc: HelperProcess): HelperProcess => {
    trackedProcs.push(proc);
    return proc;
  };
  const trackKillTarget = (target: number): void => {
    trackedTargets.push(target);
  };

  try {
    await fn({ workDir, stateDir, helperPath, trackProcess, trackKillTarget });
  } finally {
    forceKillTargets(trackedTargets);
    await Promise.all(trackedProcs.map((proc) => proc.killAndWait("SIGKILL")));
    await rm(workDir, { recursive: true, force: true });
  }
}

test("1. takeover witness: orphaned harness and grandchild that ignore SIGTERM are killed and record removed", async () => {
  await withWorkspace(async ({ stateDir, helperPath, trackProcess, trackKillTarget }) => {
    const fakeEngine = trackProcess(
      new HelperProcess(
        helperPath,
        { mode: "fake-engine", dir: stateDir, lookupTimeoutMs: LOOKUP_TIMEOUT_MS },
        { useTsx: true },
      ),
    );
    const ev = await fakeEngine.nextEvent();
    assert.equal(ev.event, "recorded", `unexpected fake-engine event: ${JSON.stringify(ev)}`);
    const harnessPid = ev.harnessPid as number;
    const grandchildPid = ev.grandchildPid as number;
    trackKillTarget(-harnessPid);
    trackKillTarget(harnessPid);
    trackKillTarget(grandchildPid);

    fakeEngine.child.kill("SIGKILL");
    const engineExit = await fakeEngine.waitExit();
    assert.equal(engineExit.signal, "SIGKILL");

    assert.equal(isPidAlive(harnessPid), true, "orphaned harness must still be alive");
    assert.equal(isPidAlive(grandchildPid), true, "orphaned grandchild must still be alive");

    const result = await containPrevious({
      dir: stateDir,
      graceMs: SHORT_GRACE_MS,
      lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    assert.equal(result.outcome, "killed");
    assert.equal(isPidAlive(harnessPid), false, "harness must be dead after containment");
    assert.equal(isPidAlive(grandchildPid), false, "grandchild must be dead after containment");
    await assert.rejects(() => lstat(join(stateDir, "harness.json")), { code: "ENOENT" });
  });
});

test("2. harness group that exits on SIGTERM is contained without needing SIGKILL", async () => {
  await withWorkspace(async ({ workDir, stateDir, helperPath, trackProcess, trackKillTarget }) => {
    const markerPath = join(workDir, "sigterm-marker.txt");
    const childMarkerPath = join(workDir, "child-sigterm-marker.txt");
    const harness = trackProcess(
      new HelperProcess(
        helperPath,
        { mode: "harness-exit-on-term", markerPath, childMarkerPath },
        { detached: true },
      ),
    );
    const ev = await harness.nextEvent();
    assert.equal(ev.event, "ready");
    const pid = ev.pid as number;
    const childPid = ev.childPid as number;
    trackKillTarget(-pid);
    trackKillTarget(childPid);

    await recordHarness({ dir: stateDir, pid, lookupTimeoutMs: LOOKUP_TIMEOUT_MS });

    const result = await containPrevious({
      dir: stateDir,
      graceMs: TERM_GRACE_MS,
      lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    assert.equal(result.outcome, "killed");

    const exit = await harness.waitExit();
    assert.equal(exit.code, 0, "harness should exit cleanly on SIGTERM rather than SIGKILL");
    assert.equal(exit.signal, null);
    assert.equal(await readFile(markerPath, "utf8"), "sigterm\n");
    assert.equal(await readFile(childMarkerPath, "utf8"), "child_sigterm\n");
    assert.equal(isPidAlive(pid), false);
    assert.equal(isPidAlive(childPid), false);
    await assert.rejects(() => lstat(join(stateDir, "harness.json")), { code: "ENOENT" });
  });
});

test("3. recorded process already exited with empty group yields already_gone and removes record", async () => {
  await withWorkspace(async ({ stateDir, helperPath, trackProcess, trackKillTarget }) => {
    const proc = trackProcess(new HelperProcess(helperPath, { mode: "short-lived" }, { detached: true }));
    const ev = await proc.nextEvent();
    assert.equal(ev.event, "ready");
    const pid = ev.pid as number;
    trackKillTarget(-pid);

    await recordHarness({ dir: stateDir, pid, lookupTimeoutMs: LOOKUP_TIMEOUT_MS });
    proc.send("exit");
    await proc.waitExit();

    const first = await containPrevious({
      dir: stateDir,
      graceMs: SHORT_GRACE_MS,
      lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    assert.equal(first.outcome, "already_gone");
    await assert.rejects(() => lstat(join(stateDir, "harness.json")), { code: "ENOENT" });

    const second = await containPrevious({
      dir: stateDir,
      graceMs: SHORT_GRACE_MS,
      lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    assert.equal(second.outcome, "none");
  });
});

test("4. reused pid with different start time sends no signal, leaves decoy alive, and removes record", async () => {
  await withWorkspace(async ({ stateDir, helperPath, trackProcess, trackKillTarget }) => {
    const decoy = trackProcess(new HelperProcess(helperPath, { mode: "decoy" }, { detached: true }));
    const ev = await decoy.nextEvent();
    assert.equal(ev.event, "ready");
    const decoyPid = ev.pid as number;
    trackKillTarget(-decoyPid);

    const fakeRecord = {
      version: 1,
      pid: decoyPid,
      pgid: decoyPid,
      startedAt: 1_000_000_000_000,
      recordedAt: Date.now(),
    };
    await writeFile(join(stateDir, "harness.json"), `${JSON.stringify(fakeRecord)}\n`, { mode: 0o600 });

    const result = await containPrevious({
      dir: stateDir,
      graceMs: SHORT_GRACE_MS,
      lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    assert.equal(result.outcome, "reused_pid_no_signal");
    assert.equal(isPidAlive(decoyPid), true, "decoy must remain alive");

    decoy.send("ping");
    const pong = await decoy.nextEvent();
    assert.equal(pong.event, "pong");
    await assert.rejects(() => lstat(join(stateDir, "harness.json")), { code: "ENOENT" });
  });
});

test("5. leader gone while group member remains alive kills the member with outcome killed", async () => {
  await withWorkspace(async ({ stateDir, helperPath, trackProcess, trackKillTarget }) => {
    const leader = trackProcess(
      new HelperProcess(helperPath, { mode: "leader-exits-child-stays" }, { detached: true }),
    );
    const ev = await leader.nextEvent();
    assert.equal(ev.event, "ready");
    const leaderPid = ev.leaderPid as number;
    const memberPid = ev.memberPid as number;
    trackKillTarget(-leaderPid);
    trackKillTarget(memberPid);

    await recordHarness({ dir: stateDir, pid: leaderPid, lookupTimeoutMs: LOOKUP_TIMEOUT_MS });
    leader.send("exit");
    await leader.waitExit();

    assert.equal(isPidAlive(leaderPid), false, "leader must have exited");
    assert.equal(isPidAlive(memberPid), true, "group member must still be alive");

    const result = await containPrevious({
      dir: stateDir,
      graceMs: SHORT_GRACE_MS,
      lookupTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    assert.equal(result.outcome, "killed");
    assert.equal(isPidAlive(memberPid), false, "group member must be dead after containment");
    await assert.rejects(() => lstat(join(stateDir, "harness.json")), { code: "ENOENT" });
  });
});

test("6. malformed record throws containment_failed, leaves record in place, and sends no signal", async () => {
  await withWorkspace(async ({ stateDir, helperPath, trackProcess, trackKillTarget }) => {
    const decoy = trackProcess(new HelperProcess(helperPath, { mode: "decoy" }, { detached: true }));
    const ev = await decoy.nextEvent();
    assert.equal(ev.event, "ready");
    const decoyPid = ev.pid as number;
    trackKillTarget(-decoyPid);

    const recordPath = join(stateDir, "harness.json");
    const garbage = `{"version":1,"pid":${decoyPid},"pgid":${decoyPid},"startedAt":"corrupt"`;
    await writeFile(recordPath, garbage, { mode: 0o600 });

    await assert.rejects(
      () => containPrevious({ dir: stateDir, graceMs: SHORT_GRACE_MS, lookupTimeoutMs: LOOKUP_TIMEOUT_MS }),
      (err: unknown) => {
        assert.ok(err instanceof ContainmentError);
        assert.equal(err.code, "containment_failed");
        assert.equal(err.message.includes(stateDir), false);
        assert.equal(err.message.includes(String(decoyPid)), false);
        return true;
      },
    );

    assert.equal(await readFile(recordPath, "utf8"), garbage);
    assert.equal(isPidAlive(decoyPid), true, "decoy named in malformed record must stay alive");
    decoy.send("ping");
    assert.equal((await decoy.nextEvent()).event, "pong");
  });
});

test("7. recordHarness enforces 0600 and private dir; AcpClient onSpawned records before initialize and kills on rejection", async () => {
  await withWorkspace(async ({ workDir, stateDir, helperPath, trackProcess, trackKillTarget }) => {
    // 7a. Directory with group access is refused without leaking paths or pids.
    const badDir = join(workDir, "group-dir");
    await mkdir(badDir, { mode: 0o750 });
    await chmod(badDir, 0o750);
    const probe = trackProcess(new HelperProcess(helperPath, { mode: "decoy" }, { detached: true }));
    const probeEv = await probe.nextEvent();
    const probePid = probeEv.pid as number;
    trackKillTarget(-probePid);

    await assert.rejects(
      () => recordHarness({ dir: badDir, pid: probePid, lookupTimeoutMs: LOOKUP_TIMEOUT_MS }),
      (err: unknown) => {
        assert.ok(err instanceof ContainmentError);
        assert.equal(err.code, "containment_unsafe");
        assert.equal(err.message.includes(badDir), false);
        assert.equal(err.message.includes(String(probePid)), false);
        return true;
      },
    );
    await assert.rejects(() => lstat(join(badDir, "harness.json")), { code: "ENOENT" });

    // 7b. Rejecting onSpawned kills the spawned child group and fails open.
    const recordPath = join(stateDir, "harness.json");
    let rejectedPid: number | null = null;
    await assert.rejects(
      () =>
        AcpClient.open({
          executable: process.execPath,
          args: [helperPath, JSON.stringify({ mode: "acp-check-record", recordPath, ignoreTerm: true })],
          cwd: workDir,
          env: { PATH: "/usr/bin:/bin" },
          handshakeTimeoutMs: 5_000,
          turnBudgetMs: 5_000,
          killGraceMs: SHORT_GRACE_MS,
          onSpawned: async (pid) => {
            rejectedPid = pid;
            trackKillTarget(-pid);
            throw new Error("record_rejected");
          },
        }),
      /record_rejected/,
    );
    assert.ok(rejectedPid !== null, "onSpawned must have received child pid");
    assert.equal(isPidAlive(rejectedPid), false, "child must be dead when onSpawned rejects");

    // 7c. Through AcpHarness -> AcpClient onSpawned, harness.json (0600) exists before initialize arrives.
    const harness = new AcpHarness({
      launch: {
        executable: process.execPath,
        args: [helperPath, JSON.stringify({ mode: "acp-check-record", recordPath })],
        cwd: workDir,
      },
      handshakeTimeoutMs: 5_000,
      turnBudgetMs: 5_000,
      killGraceMs: SHORT_GRACE_MS,
      onSpawned: async (pid) => {
        trackKillTarget(-pid);
        await recordHarness({ dir: stateDir, pid, lookupTimeoutMs: LOOKUP_TIMEOUT_MS });
      },
    });
    try {
      const reply = await harness.runTurn("check");
      const report = JSON.parse(reply) as {
        existed: boolean;
        recordedPid: number | null;
        myPid: number;
        firstMethod: string | null;
      };
      assert.equal(report.firstMethod, "initialize");
      assert.equal(report.existed, true, "harness.json must exist before initialize arrives");
      assert.equal(report.recordedPid, report.myPid);
      const st = await lstat(recordPath);
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      await harness.close();
    }

    await clearHarnessRecord({ dir: stateDir });
    await assert.rejects(() => lstat(recordPath), { code: "ENOENT" });
    await clearHarnessRecord({ dir: stateDir });
  });
});
