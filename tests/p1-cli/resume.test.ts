/**
 * Read-only reconnect and orphan-watcher controls.
 *
 * Reached by BOTH package.json's literal `npm test` list and
 * `npm run test:p1-cli` through tests/p1-cli/**\/*.test.ts.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  EXIT_NOTIFY_ORPHANED,
  NOTIFY_RESTART_COMMAND,
  NOTIFY_FLAG,
  NOTIFY_SIGNAL_EXIT_CODES,
  notifyRestartCommand,
  notifySignalStopSentence,
  fileArrivalCursorStore,
} from "../../src/cloud/arrival-watch.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { readAgentSignalDirectory } from "../../src/cloud/signals.js";
import {
  FileBrainDigestStore,
  FileHookSurfaceStore,
  listenerPaths,
  startListenerControlServer,
  readListenerStatusIfPresent,
  LISTENER_RUNNING_STATES,
  writeListenerStatus,
  type ListenerStatus,
} from "../../src/listener/index.js";
import {
  inspectResume,
  readOnlyListenerInspection,
  renderResume,
  resumeJson,
  findNotifyWatchers,
  parseParentProcessOutput,
  systemParentProcess,
  type ProcessTableAdapter,
  type ParentProcessAdapter,
  type StdoutConsumerAdapter,
} from "../../src/resume.js";
import { lsofStdoutConsumer, parseLsofStdout } from "../../src/stdout-consumer.js";
import { Arguments, BOOLEAN_FLAGS, NOTIFY_ACCEPTED_FLAGS, claudeUserPromptHookSnippet, notifyRestartOptions, waitForListenerStop } from "../../src/cli.js";
import { newSessionBinding, writeSessionContext } from "../../src/cloud/session-context.js";
import { generateSessionKey } from "../../src/cloud/session-proof.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SENDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OLD_SIGNAL = "11111111-1111-4111-8111-111111111111";
const NEW_SIGNAL = "22222222-2222-4222-8222-222222222222";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

for (const mode of ["slow", "dead", "dies_during_stop"] as const) test(`printed listener restart works when listener is ${mode}`, { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-wait-"));
  const bin = join(root, "bin");
  const stateDirectory = join(root, "listener state");
  const credentialFile = join(root, "agent.json");
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => raw += String(chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as { resource?: string };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body.resource === "members"
        ? { members: [], agents: [{ principal_id: PRINCIPAL, owner_user_id: OWNER, name: "Fixture seat" }],
          identity: { credential_valid: true, owner_user_id: OWNER, principal_id: PRINCIPAL, workspace_id: WORKSPACE } }
        : { signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } }));
    });
  });
  let control: Awaited<ReturnType<typeof startListenerControlServer>> | null = null;
  let shell: ChildProcess | null = null;
  let nextPid: number | null = null;
  const ownerSpawnAt = Date.now();
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const url = await listen(server);
    const target = cloudTarget(url, "public-test-key");
    const paths = listenerPaths({ profileId: target.profileId, workspaceId: WORKSPACE,
      principalId: PRINCIPAL, stateDirectory });
    const status = listenerStatus(paths.logPath);
    status.profileId = target.profileId;
    status.workspaceId = WORKSPACE;
    status.principalId = PRINCIPAL;
    assert.ok(owner.pid);
    status.pid = owner.pid;
    status.processStartedAt = ownerSpawnAt;
    status.startedAt = new Date().toISOString();
    status.provider = "claude";
    await writeListenerStatus(paths, status);
    if (mode !== "dead") control = await startListenerControlServer({ paths, status: () => status, stop: () => {
      status.state = "stopping";
      setTimeout(() => {
        if (mode === "dies_during_stop") {
          owner.kill("SIGKILL");
          void control?.close();
          return;
        }
        status.state = "stopped";
        status.stoppedAt = new Date().toISOString();
        void writeListenerStatus(paths, status).then(() => setTimeout(() => {
          owner.kill("SIGKILL");
          void control?.close();
        }, 300));
      }, 1_200);
    } });
    if (mode === "dead") {
      owner.kill("SIGKILL");
      await new Promise<void>(resolve => owner.once("close", () => resolve()));
    }
    await writeFile(credentialFile, credentialArtifact(), { mode: 0o600 });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cswarm"), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${resolve("src/cli.ts")}' "$@"\n`, { mode: 0o755 });
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), JSON.stringify(claudeUserPromptHookSnippet(PRINCIPAL)));
    const report: Parameters<typeof renderResume>[0] = { identity: { displayName: "Fixture", principalId: PRINCIPAL },
      listener: { checkedDirectory: paths.instanceDirectory, status, source: mode === "dead" ? "recorded_file" : "live_process" },
      watchers: [], brain: { digest: null, highWaterFile: join(root, "brain") },
      inbox: { count: 0, exact: true }, target, workspaceId: WORKSPACE, credentialFile,
      installedVersion: "0.1.77", stateDirectory };
    const printed = renderResume(report).split("\n").find(line => line.startsWith("cswarm listen stop "));
    assert.ok(printed);
    assert.match(printed, /--wait && cswarm listen start/);
    assert.equal(printed.split("--state-dir").length - 1, 2);
    shell = spawn("/bin/sh", ["-c", printed], { env: { ...process.env, HOME: root,
      CLAUDE_CONFIG_DIR: join(root, ".claude"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"), PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    shell.stderr?.on("data", chunk => stderr += String(chunk));
    shell.stdout?.on("data", chunk => stdout += String(chunk));
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { shell?.kill("SIGKILL"); reject(new Error("restart shell timeout")); }, 15_000);
      shell!.once("exit", value => { clearTimeout(timer); done(value); });
      shell!.once("error", reject);
    });
    assert.equal(code, 0, `${stderr}\n${JSON.stringify((await readListenerStatusIfPresent(paths))?.lastErrorCode)}\n${await readFile(paths.logPath, "utf8").catch(() => "no log")}`);
    if (mode !== "slow") {
      const stopOutput = stdout.split("Listener ready for agent")[0]!;
      assert.match(stopOutput, /^Listener failed/);
      assert.match(stopOutput, /CONNECTED: no\. Transport state is failed/);
      assert.doesNotMatch(stopOutput, /Listener running|CONNECTED: yes/);
    }
    const restarted = await readListenerStatusIfPresent(paths);
    assert.ok(restarted);
    assert.ok(LISTENER_RUNNING_STATES.includes(restarted.state));
    nextPid = restarted.pid;
    assert.notEqual(nextPid, process.pid);
    if (process.env.CSWARM_FOLD10_LISTENER_EVIDENCE) {
      await writeFile(process.env.CSWARM_FOLD10_LISTENER_EVIDENCE, `${JSON.stringify(restarted, null, 2)}\n`);
    }
  } finally {
    owner.kill("SIGKILL");
    if (owner.exitCode === null && owner.signalCode === null) await new Promise<void>(resolve => owner.once("close", () => resolve()));
    if (shell?.exitCode === null) shell.kill("SIGKILL");
    if (nextPid !== null) {
      try { process.kill(nextPid, "SIGTERM"); } catch { /* already gone */ }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { process.kill(nextPid, 0); await new Promise(done => setTimeout(done, 50)); }
        catch { break; }
      }
      try { process.kill(nextPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await control?.close().catch(() => undefined);
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("stop wait treats a slow control reply as unknown until socket and child exit", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stop-slow-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const paths = listenerPaths({ profileId: cloudTarget("http://127.0.0.1:54321", "anon").profileId,
    workspaceId: WORKSPACE, principalId: PRINCIPAL, stateDirectory: root });
  const status = listenerStatus(paths.logPath);
  let server: ReturnType<typeof createSocketServer> | null = null;
  try {
    assert.ok(child.pid);
    status.pid = child.pid;
    status.startedAt = new Date().toISOString();
    status.state = "stopping";
    await writeListenerStatus(paths, status);
    server = createSocketServer(socket => socket.on("data", () => {
      setTimeout(() => { if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, status })}\n`); }, 300);
    }));
    await new Promise<void>(resolve => server!.listen(paths.socketPath, resolve));
    let settled = false;
    const waiting = waitForListenerStop(paths, status, 2_000).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(settled, false);
    assert.equal((await readListenerStatusIfPresent(paths))?.state, "stopping");
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    assert.equal((await waiting)?.state, "failed");
    assert.equal((await readListenerStatusIfPresent(paths))?.state, "stopping");
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("close", () => resolve()));
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("stop wait times out on a live stopping child without rewriting status", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stop-stuck-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const paths = listenerPaths({ profileId: cloudTarget("http://127.0.0.1:54321", "anon").profileId,
    workspaceId: WORKSPACE, principalId: PRINCIPAL, stateDirectory: root });
  const status = listenerStatus(paths.logPath);
  try {
    assert.ok(child.pid);
    status.pid = child.pid;
    status.startedAt = new Date().toISOString();
    status.state = "stopping";
    await writeListenerStatus(paths, status);
    await assert.rejects(waitForListenerStop(paths, status, 600), error => {
      assert.match((error as Error).message, /listener stop timed out after 0.6 seconds; state stopping, pid /);
      assert.match((error as Error).message, new RegExp(String(child.pid)));
      return true;
    });
    assert.equal((await readListenerStatusIfPresent(paths))?.state, "stopping");
    process.kill(child.pid, 0);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("close", () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("stop wait treats a reused pid as gone and a recorded stopped state as complete", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stop-reused-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const paths = listenerPaths({ profileId: cloudTarget("http://127.0.0.1:54321", "anon").profileId,
    workspaceId: WORKSPACE, principalId: PRINCIPAL, stateDirectory: root });
  const status = listenerStatus(paths.logPath);
  try {
    assert.ok(child.pid);
    status.pid = child.pid;
    status.startedAt = "2020-01-01T00:00:00.000Z";
    status.processStartedAt = Date.parse(status.startedAt);
    status.state = "stopping";
    await writeListenerStatus(paths, status);
    assert.equal((await waitForListenerStop(paths, status, 900, Date.now() + 900, () => Date.now()))?.state, "failed");
    process.kill(child.pid, 0);
    status.state = "stopped";
    const start = Date.now();
    assert.equal(await waitForListenerStop(paths, status, 500), status);
    assert.ok(Date.now() - start < 200, "a recorded stopped listener needs no PID wait");
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("close", () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("stop wait keeps a live PID whose supervisor started over two seconds later", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stop-old-process-"));
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const paths = listenerPaths({ profileId: cloudTarget("http://127.0.0.1:54321", "anon").profileId,
    workspaceId: WORKSPACE, principalId: PRINCIPAL, stateDirectory: root });
  try {
    assert.ok(child.pid);
    await new Promise(resolve => setTimeout(resolve, 2_100));
    const status = listenerStatus(paths.logPath);
    status.pid = child.pid;
    status.processStartedAt = spawnedAt;
    status.startedAt = new Date().toISOString();
    status.state = "stopping";
    await writeListenerStatus(paths, status);
    await assert.rejects(waitForListenerStop(paths, status, 350, Date.now() + 350,
      () => spawnedAt), /timed out after 0.35 seconds; state stopping, pid/);
    process.kill(child.pid, 0);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("close", () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("EPERM means alive and still reaches the one stop deadline", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stop-eperm-"));
  const paths = listenerPaths({ profileId: cloudTarget("http://127.0.0.1:54321", "anon").profileId,
    workspaceId: WORKSPACE, principalId: PRINCIPAL, stateDirectory: root });
  const status = listenerStatus(paths.logPath);
  status.pid = 999_999_998;
  status.processStartedAt = Date.now();
  status.startedAt = new Date().toISOString();
  status.state = "stopping";
  const originalKill = process.kill;
  try {
    await writeListenerStatus(paths, status);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === status.pid && signal === 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    const start = Date.now();
    await assert.rejects(waitForListenerStop(paths, status, 300, start + 300,
      () => status.processStartedAt!), /timed out after 0.3 seconds; state stopping, pid 999999998/);
    assert.ok(Date.now() - start < 650);
  } finally {
    process.kill = originalKill;
    await rm(root, { recursive: true, force: true });
  }
});

test("recorded lsof fd 1 shapes classify without a false orphan", { timeout: 1_000 }, () => {
  const cases = [
    ["p12\nf1\ntunix\nn->0x30df\n", "live_reader"],
    ["p12\nf1\ntunix\nn->(none)\n", "orphaned"],
    ["p12\nf1\ntunix\nn/var/folders/s.sock\n", "cannot_determine"],
    ["p12\nf1\ntPIPE\nn->0x5c10\n", "cannot_determine"],
    ["p12\nf1\ntPIPE\nn\n", "cannot_determine"],
    ["p12\nf1\ntFIFO\nn/path\n", "cannot_determine"],
    ["p12\nf1\ntREG\nn/tmp/out\n", "not_pipe"],
    ["p12\nf1\ntCHR\nn/dev/null\n", "not_pipe"],
    ["", "cannot_determine"],
    ["p12\nf1\ntunix\nn->0x30df\nn->(none)\n", "live_reader"],
  ] as const;
  for (const [output, expected] of cases) assert.equal(parseLsofStdout(output), expected, output);
});

test("cancelling an in-flight stdout inspection kills its lsof child", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-lsof-abort-"));
  const pidFile = join(root, "pid");
  let childPid: number | undefined;
  try {
    const fixture = join(root, "fixture");
    await writeFile(fixture, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 30\n`, { mode: 0o755 });
    const controller = new AbortController();
    const inspection = lsofStdoutConsumer(1_500, fixture).inspect(process.pid, controller.signal);
    const deadline = Date.now() + 1_000;
    while (childPid === undefined && Date.now() < deadline) {
      try { childPid = Number(await readFile(pidFile, "utf8")); }
      catch { await new Promise((done) => setTimeout(done, 10)); }
    }
    assert.ok(childPid && Number.isInteger(childPid), "lsof fixture started");
    controller.abort();
    const result = await Promise.race([
      inspection,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("inspection ignored abort")), 400)),
    ]);
    assert.equal(result, "cannot_determine");
    let gone = false;
    for (let attempt = 0; attempt < 20 && !gone; attempt += 1) {
      try { process.kill(childPid!, 0); await new Promise((done) => setTimeout(done, 10)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true; else throw error; }
    }
    assert.equal(gone, true, "aborted lsof child exited");
  } finally {
    if (childPid !== undefined) {
      try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ps parent parser and adapter classify init, live, missing, unreadable, and EPERM", { timeout: 1_000 }, async () => {
  const error = (code: string) => Object.assign(new Error(code), { code });
  assert.equal(parseParentProcessOutput(" 1\n"), "parent_is_init");
  assert.equal(parseParentProcessOutput(""), "cannot_determine");
  assert.equal(parseParentProcessOutput("garbage"), "cannot_determine");
  assert.equal(parseParentProcessOutput("42\n", () => { throw error("EPERM"); }), "parent_alive");
  assert.equal(parseParentProcessOutput("42\n", () => { throw error("ESRCH"); }), "parent_missing");
  const seen: number[] = [];
  const parent = systemParentProcess({
    ps: async (pid) => ({ 10: "1\n", 11: "42\n", 12: "43\n", 13: "", 14: "44\n" })[pid as 10] ?? "",
    checkAlive: (pid) => {
      seen.push(pid);
      if (pid === 43) throw error("ESRCH");
      if (pid === 44) throw error("EPERM");
    },
  });
  assert.deepEqual(await Promise.all([10, 11, 12, 13, 14].map((pid) => parent.inspect(pid))),
    ["parent_is_init", "parent_alive", "parent_missing", "cannot_determine", "parent_alive"]);
  assert.deepEqual(seen, [42, 43, 44]);
});

function listenerStatus(logPath: string): ListenerStatus {
  return {
    version: 1,
    instanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    provider: "claude",
    permissionMode: "allow",
    profileId: cloudTarget("https://api.example.test", "anon").profileId,
    workspaceId: WORKSPACE,
    principalId: PRINCIPAL,
    pid: 4101,
    state: "ready",
    startedAt: "2026-09-01T10:00:00.000Z",
    readyAt: "2026-09-01T10:00:01.000Z",
    updatedAt: "2026-09-01T10:00:01.000Z",
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    providerVersion: null,
    providerLastMeasuredVersion: null,
    cswarmVersion: "0.1.42",
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 2,
    lastTerminalDeliveryFailureCount: 0,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "main",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath,
  };
}

function indexOrder(output: string, headings: readonly string[]): number[] {
  return headings.map((heading) => output.indexOf(`\n${heading}\n`));
}

test("resume pins each section, reports version drift and orphan pids, and changes no state", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-resume-state-"));
  const target = cloudTarget("https://api.example.test", "anon-for-resume");
  const credentialFile = "/tmp/resume-agent.json";
  const paths = listenerPaths({
    profileId: target.profileId,
    workspaceId: WORKSPACE,
    principalId: PRINCIPAL,
    stateDirectory: root,
  });
  try {
    await mkdir(paths.instanceDirectory, { recursive: true, mode: 0o700 });
    const status = listenerStatus(paths.logPath);
    await writeListenerStatus(paths, status);
    const digestStore = new FileBrainDigestStore(paths.instanceDirectory, PRINCIPAL);
    await digestStore.consume([
      { topic: "stable", version: 1, updatedAt: "2026-09-01T09:00:00.000Z" },
    ]);
    const before = {
      status: await readFile(paths.statusPath, "utf8"),
      digest: await readFile(digestStore.location, "utf8"),
    };

    const processTable: ProcessTableAdapter = {
      async list() {
        return [
          {
            pid: 5101,
            command: `node cswarm inbox --notify --agent-token-file ${credentialFile} --workspace-id ${WORKSPACE}`,
          },
          {
            pid: 5102,
            command: `node cswarm inbox --notify --principal-id ${PRINCIPAL} --agent-token-file /tmp/other.json`,
          },
          {
            pid: 5103,
            command: `node test-runner --case "inbox --notify" --token ${TOKEN}`,
          },
        ];
      },
    };
    const stdoutConsumer: StdoutConsumerAdapter = {
      async inspect(pid) {
        return pid === 5102 ? "orphaned" : "live_reader";
      },
    };
    const parentProcess: ParentProcessAdapter = { async inspect() { return "parent_alive"; } };
    const operations: string[] = [];
    const report = await inspectResume({
      target,
      workspaceId: WORKSPACE,
      credentialFile,
      installedVersion: "0.1.44",
      stateDirectory: root,
    }, {
      processTable,
      stdoutConsumer,
      parentProcess,
      async readIdentity() {
        operations.push("read_identity");
        return { displayName: "Rivet", principalId: PRINCIPAL };
      },
      async queryStatus(checked, command) {
        operations.push("read_listener_status");
        assert.equal(command, "status");
        assert.equal(checked.instanceDirectory, paths.instanceDirectory);
        return status;
      },
      async readStatus() {
        throw new Error("the live fixture must use its control response");
      },
      async readBrainTopics() {
        operations.push("read_brain_topics");
        return [
          { topic: "stable", version: 1, updatedAt: "2026-09-01T09:00:00.000Z" },
          { topic: "restart", version: 2, updatedAt: "2026-09-01T12:00:00.000Z" },
        ];
      },
      async readInboxCount(principalId, instanceDirectory) {
        operations.push("read_inbox");
        assert.equal(principalId, PRINCIPAL);
        assert.equal(instanceDirectory, paths.instanceDirectory);
        return { count: 2, exact: true };
      },
    });
    const output = renderResume(report);

    assert.match(output, new RegExp(`You are Rivet \\(${PRINCIPAL}\\)`));
    assert.match(output, /State: ready, reported by running PID 4101/);
    assert.match(output, /VERSION MISMATCH: listener runs 0\.1\.42; installed 0\.1\.44/);
    assert.match(output, /Found: 2/);
    assert.match(output, /PID 5101: stdout has a live pipe reader/);
    assert.match(output, /PID 5101: stdout has a live pipe reader; parent process is live/);
    assert.match(output, /PID 5102: ORPHAN: stdout pipe has no reader/);
    assert.match(output, /CommonSwarm did not kill anything\.\nkill 5102\n/);
    assert.match(output, /restart v2/);
    assert.doesNotMatch(output, /cswarm brain get <topic>/);
    assert.match(output, /without advancing it/);
    assert.match(output, /Unread directed asks and notes.*: 2/);
    assert.match(output, /No cursor, brain high-water, listener status, receipt, acknowledgement, or process was changed/);
    assert.doesNotMatch(output, new RegExp(TOKEN));
    assert.deepEqual(
      indexOrder(`\n${output}`, ["Identity", "Listener", "Notify watchers", "Brain digest", "Unread inbox"]),
      [...indexOrder(`\n${output}`, ["Identity", "Listener", "Notify watchers", "Brain digest", "Unread inbox"])].sort((a, b) => a - b),
    );
    assert.deepEqual(operations, [
      "read_identity",
      "read_listener_status",
      "read_brain_topics",
      "read_inbox",
    ]);
    assert.deepEqual({
      status: await readFile(paths.statusPath, "utf8"),
      digest: await readFile(digestStore.location, "utf8"),
    }, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the read-only listener fallback never rewrites a stale live-looking status", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-resume-listener-"));
  const target = cloudTarget("https://api.example.test", "anon");
  const paths = listenerPaths({
    profileId: target.profileId,
    workspaceId: WORKSPACE,
    principalId: PRINCIPAL,
    stateDirectory: root,
  });
  try {
    await mkdir(paths.instanceDirectory, { recursive: true, mode: 0o700 });
    await writeListenerStatus(paths, listenerStatus(paths.logPath));
    const before = await readFile(paths.statusPath, "utf8");
    const result = await readOnlyListenerInspection(paths, {
      async queryStatus() {
        throw new Error("fixture socket is gone");
      },
    });
    assert.equal(result.source, "recorded_file");
    assert.equal(result.status?.state, "ready");
    assert.equal(await readFile(paths.statusPath, "utf8"), before);
    assert.match(renderResume({
      identity: { displayName: "Rivet", principalId: PRINCIPAL },
      listener: result,
      watchers: [],
      brain: { digest: null, highWaterFile: join(paths.instanceDirectory, "brain-digest.json") },
      inbox: { count: 0, exact: true },
      target,
      workspaceId: WORKSPACE,
      credentialFile: "/tmp/agent.json",
      installedVersion: "0.1.44",
    }), /Running listener cswarm version: cannot determine because the process did not answer; status file recorded 0\.1\.42/);

    const missingPaths = listenerPaths({
      profileId: target.profileId,
      workspaceId: WORKSPACE,
      principalId: SENDER,
      stateDirectory: root,
    });
    const missing = await readOnlyListenerInspection(missingPaths, {
      async queryStatus() {
        throw new Error("fixture socket is absent");
      },
    });
    assert.equal(missing.source, "not_found");
    await assert.rejects(access(missingPaths.instanceDirectory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume prints lease age, generation and this-host ownership without calling renewal mail observation", { timeout: 1000 }, async () => {
  const report = {
    identity: { displayName: "Rivet", principalId: PRINCIPAL },
    listener: { checkedDirectory: "/tmp/isolated", status: null, source: "not_found" as const },
    watchers: [],
    brain: { digest: null, highWaterFile: "/tmp/isolated/brain.json" },
    inbox: { count: 0, exact: true },
    wakeLease: { lease: { watcher_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      host_label: "host-a", generation: 4, renewed_age_ms: 1200 },
      localWatcherId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      hostIdDirectory: "/tmp/isolated/state/cswarm/arrival-cursors" },
    target: cloudTarget("http://127.0.0.1:54321", "public-test-key"),
    workspaceId: WORKSPACE, credentialFile: "/tmp/isolated/agent.json", installedVersion: "0.1.77",
  };
  const human = renderResume(report);
  assert.match(human, /host-a, generation 4, renewed 1s ago; this host holds it: yes/);
  assert.match(human, /renewal does not prove this session reads its mail/i);
  const json = resumeJson(report) as { wake_lease: Record<string, unknown> };
  assert.equal(json.wake_lease.held_by_this_host, true);
  assert.equal(json.wake_lease.renewal_is_mail_observation, false);
  const hostile = { ...report, wakeLease: { ...report.wakeLease,
    lease: { ...report.wakeLease.lease, host_label: `safe\u001b[31m\u0085\u202e${"x".repeat(300)}` } } };
  const clean = (resumeJson(hostile) as { wake_lease: { host_label: string } }).wake_lease.host_label;
  assert.equal(clean.length, 120);
  assert.doesNotMatch(clean, /[\u001b\u0085\u202e]/);
  assert.match(renderResume(hostile), new RegExp(clean));
  const unreadable = { ...report, wakeLease: { ...report.wakeLease, machineIdUnavailable: true,
    hostIdFileState: "missing" as const } };
  assert.match(renderResume(unreadable), /no host-id file exists yet/);
  assert.match(renderResume(unreadable), /host-id state in \/tmp\/isolated\/state\/cswarm\/arrival-cursors separate on each machine/);
  assert.doesNotMatch(renderResume(report), /sharing that directory across machines/);
  assert.doesNotMatch(renderResume(unreadable), /existing host id was kept/);
  assert.match(renderResume({ ...report, wakeLease: { ...unreadable.wakeLease,
    hostIdFileState: "present" as const } }), /a host-id file exists but cannot be verified/);
  assert.match(renderResume({ ...report, wakeLease: { ...unreadable.wakeLease,
    hostIdFileState: "unreadable" as const } }), /could not read the machine id or verify the host-id file/);
  const lane = await readFile(new URL("../../docs/evidence/2026-09-25-item-g-lane2b/LANE.md", import.meta.url), "utf8");
  assert.match(lane, /state directory shared across machines is unsupported; each machine needs its own state directory/i);
  assert.equal(resumeJson(unreadable).host_machine_id_unavailable, true);
  assert.equal(resumeJson(unreadable).host_id_file_state, "missing");
  assert.equal(resumeJson({ ...report, wakeLease: { ...unreadable.wakeLease,
    hostIdFileState: "present" as const } }).host_id_file_state, "present");
  assert.equal(resumeJson({ ...report, wakeLease: { ...report.wakeLease,
    localWatcherId: null } }).wake_lease &&
    (resumeJson({ ...report, wakeLease: { ...report.wakeLease,
      localWatcherId: null } }).wake_lease as Record<string, unknown>).held_by_this_host, false);
});

test("lane labels the twelve client mutations as Fold 1 evidence", { timeout: 1000 }, async () => {
  const lane = await readFile(new URL("../../docs/evidence/2026-09-25-item-g-lane2b/LANE.md", import.meta.url), "utf8");
  assert.match(lane, /Fold 1 client mutations: twelve were run/);
});

test("resume reads host-id presence before describing an unreadable machine id", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-resume-host-id-"));
  const oldXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const inspect = async () => await inspectResume({
      target: cloudTarget("http://127.0.0.1:54321", "public-test-key"),
      workspaceId: WORKSPACE,
      credentialFile: join(root, "agent.json"),
      installedVersion: "0.1.77",
      stateDirectory: root,
    }, {
      async readIdentity() { return { displayName: "Rivet", principalId: PRINCIPAL }; },
      async readBrainTopics() { return []; },
      async readInboxCount() { return { count: 0, exact: true }; },
      async readWakeLease() { return null; },
      processTable: { async list() { return []; } },
      async queryStatus() { throw new Error("no listener"); },
      async readStatus() { return null; },
    });
    assert.equal((await inspect()).wakeLease?.hostIdFileState, "missing");
    assert.equal((await inspect()).wakeLease?.hostIdDirectory, join(root, "cswarm", "arrival-cursors"));
    const hostRoot = join(root, "cswarm", "arrival-cursors");
    await mkdir(hostRoot, { recursive: true });
    await writeFile(join(hostRoot, "host-id"), "{}\n");
    assert.equal((await inspect()).wakeLease?.hostIdFileState, "present");
    await rm(join(hostRoot, "host-id"));
    await mkdir(join(hostRoot, "host-id"));
    assert.equal((await inspect()).wakeLease?.hostIdFileState, "unreadable");
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldXdg;
    await rm(root, { recursive: true, force: true });
  }
});

function credentialArtifact(): string {
  return JSON.stringify({
    message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
    status: "accepted",
    principal_id: PRINCIPAL,
    token_id: "33333333-3333-4333-8333-333333333333",
    run_id: "44444444-4444-4444-8444-444444444444",
    agent_token: TOKEN,
    expires_at: "2030-01-01T00:00:00.000Z",
  });
}

async function writeCredential(root: string): Promise<string> {
  const path = join(root, "agent.json");
  await writeFile(path, credentialArtifact(), { mode: 0o600 });
  return path;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function spawnCli(
  args: readonly string[],
  root: string,
  xdg: string,
  extraEnv: Record<string, string> = {},
  cwd = process.cwd(),
): ChildProcess {
  return spawn(process.execPath, [
    "--import",
    import.meta.resolve("tsx"),
    resolve("src/cli.ts"),
    ...args,
  ], {
    cwd,
    env: { ...process.env, HOME: root, XDG_STATE_HOME: xdg, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(
  child: ChildProcess,
  stderr: () => string,
  timeoutMs = 10_000,
): Promise<number | null> {
  return await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out; stderr=${stderr()}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function signal(id = NEW_SIGNAL): Record<string, unknown> {
  return {
    id,
    workspace_id: WORKSPACE,
    from: SENDER,
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "Reconnect check",
    attachments: [],
    until: "2030-01-01T00:00:00.000Z",
    created_at: "2026-09-01T12:00:00.000Z",
    sender_owner_relation: "same_owner",
  };
}

function refuseResumeCommand(request: IncomingMessage, response: ServerResponse,
  requests: Array<{ path: string; resource: unknown }>): boolean {
  if (request.url !== "/functions/v1/command") return false;
  requests.push({ path: request.url, resource: "command POST" });
  request.resume();
  request.on("end", () => response.writeHead(409, { "content-type": "application/json" })
    .end(JSON.stringify({ error: "unexpected_command" })));
  return true;
}

test("resume fixture records and refuses a command POST", { timeout: 3000 }, async () => {
  const requests: Array<{ path: string; resource: unknown }> = [];
  const server = createServer((request, response) => {
    if (!refuseResumeCommand(request, response, requests)) response.writeHead(500).end();
  });
  const url = await listen(server);
  try {
    const result = await fetch(`${url}/functions/v1/command`, { method: "POST", body: "{}" });
    assert.equal(result.status, 409);
    assert.deepEqual(requests, [{ path: "/functions/v1/command", resource: "command POST" }]);
  } finally { await close(server); }
});

test("resume reuses the identity members response for session status", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-resume-members-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  let reads = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      reads += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        members: [], agents: [{ principal_id: PRINCIPAL, owner_user_id: OWNER, name: "Rivet",
          managed_at: null }],
        identity: { credential_valid: true, principal_id: PRINCIPAL, owner_user_id: OWNER,
          workspace_id: WORKSPACE },
      }));
    });
  });
  const url = await listen(server);
  try {
    const target = cloudTarget(url, "public-test-key");
    const report = await inspectResume({ target, workspaceId: WORKSPACE,
      credentialFile: join(root, "agent.json"), sessionCredential: TOKEN,
      installedVersion: "test", stateDirectory: join(root, "state") }, {
      async readIdentity() {
        const directory = await readAgentSignalDirectory(target, TOKEN, WORKSPACE);
        return { displayName: "Rivet", principalId: PRINCIPAL, sessionStatus: directory.sessionStatus };
      },
      async readBrainTopics() { return []; },
      async readInboxCount() { return { count: 0, exact: true }; },
      processTable: { async list() { return []; } },
      async queryStatus() { throw new Error("no listener"); },
      async readStatus() { return null; },
    });
    assert.equal(report.sessionContexts?.managed, false);
    assert.equal(reads, 1, "session status must use the first members response");
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("the real resume CLI uses only read resources and leaves local files byte-identical", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-resume-cli-"));
  const xdg = join(root, "state");
  const requests: Array<{ path: string; resource: unknown }> = [];
  const server = createServer((request, response) => {
    if (refuseResumeCommand(request, response, requests)) return;
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ path: request.url ?? "", resource: body.resource });
      response.writeHead(200, { "content-type": "application/json" });
      if (body.resource === "members") {
        response.end(JSON.stringify({
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: PRINCIPAL, name: "Rivet", owner_user_id: OWNER }],
          identity: {
            credential_valid: true,
            owner_user_id: OWNER,
            principal_id: PRINCIPAL,
            workspace_id: WORKSPACE,
          },
        }));
      } else if (body.resource === "files") {
        response.end(JSON.stringify({ files: [] }));
      } else if (body.resource === "signals") {
        response.end(JSON.stringify({
          signals: [signal(NEW_SIGNAL), signal(OLD_SIGNAL)],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }));
      } else if (body.resource === "agent_wake_lease") {
        response.end(JSON.stringify({ lease: null }));
      } else {
        response.writeHead(500).end(JSON.stringify({ error: "unexpected_resource" }));
      }
    });
  });
  const url = await listen(server);
  try {
    const credential = await writeCredential(root);
    const credentialBefore = await readFile(credential, "utf8");
    const target = cloudTarget(url, "anon-resume-cli");
    const paths = listenerPaths({
      profileId: target.profileId,
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL,
      stateDirectory: join(xdg, "cswarm", "listeners"),
    });
    await new FileHookSurfaceStore(paths.instanceDirectory).commit({
      signalIds: [NEW_SIGNAL],
    });
    const hookSurfacePath = join(paths.instanceDirectory, "hook-surface.json");
    const hookSurfaceBefore = await readFile(hookSurfacePath, "utf8");
    const child = spawnCli([
      "resume",
      "--agent-token-file",
      credential,
      "--url",
      url,
      "--anon-key",
      "anon-resume-cli",
      "--workspace-id",
      WORKSPACE,
    ], root, xdg);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: string) => stdout += chunk);
    child.stderr!.on("data", (chunk: string) => stderr += chunk);
    const code = await waitForExit(child, () => stderr);

    assert.equal(code, 0, stderr);
    assert.match(stdout, /You are Rivet/);
    assert.match(stdout, /No listener found under/);
    assert.match(stdout, /Found: 0/);
    assert.match(stdout, /Unread directed asks and notes.*: 1/);
    assert.deepEqual(requests, [
      { path: "/functions/v1/read", resource: "members" },
      { path: "/functions/v1/read", resource: "files" },
      { path: "/functions/v1/read", resource: "signals" },
      { path: "/functions/v1/read", resource: "agent_wake_lease" },
    ]);
    const commandProbe = await fetch(`${url}/functions/v1/command`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(commandProbe.status, 409);
    assert.deepEqual(requests.at(-1), { path: "/functions/v1/command", resource: "command POST" });
    assert.equal(await readFile(credential, "utf8"), credentialBefore);
    assert.equal(await readFile(hookSurfacePath, "utf8"), hookSurfaceBefore);
    await assert.rejects(access(join(paths.instanceDirectory, "brain-digest.json")));
    await assert.rejects(access(paths.statusPath));
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed notify reader exits with its stable code and does not advance the cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-epipe-"));
  const xdg = join(root, "state");
  const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          signals: [signal()],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }),
      );
    });
  });
  const url = await listen(server);
  const target = cloudTarget(url, "anon-epipe");
  const cursorStore = fileArrivalCursorStore({
    target,
    workspaceId: WORKSPACE,
    principalId: PRINCIPAL,
    stateDirectory: join(xdg, "cswarm", "arrival-cursors"),
  });
  try {
    const credential = await writeCredential(root);
    await cursorStore.write({
      created_at: "2026-09-01T11:00:00.000Z",
      id: OLD_SIGNAL,
    });
    const before = await readFile(cursorStore.location, "utf8");
    const child = spawnCli([
      "inbox",
      "--notify",
      "--agent-token-file",
      credential,
      "--url",
      url,
      "--anon-key",
      "anon-epipe",
      "--workspace-id",
      WORKSPACE,
    ], root, xdg);
    child.stderr!.setEncoding("utf8");
    let stderr = "";
    child.stderr!.on("data", (chunk: string) => stderr += chunk);
    /* Close the only reader before the read service returns the message. The
     * child's next stdout write reaches the real Darwin pipe and gets EPIPE. */
    child.stdout!.destroy();
    const code = await waitForExit(child, () => stderr);

    assert.equal(code, EXIT_NOTIFY_ORPHANED, stderr);
    assert.match(stderr, /\[notify_stdout_closed\]/);
    assert.match(stderr, /stopped before advancing its cursor/);
    assert.equal(await readFile(cursorStore.location, "utf8"), before);
    const stored = JSON.parse(before) as { cursor: { id: string } };
    assert.equal(stored.cursor.id, OLD_SIGNAL);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty inbox loses only its stdout reader and exits 74 without a signal", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-idle-"));
  const xdg = join(root, "state");
  let firstRead!: () => void;
  const read = new Promise<void>((resolveRead) => { firstRead = resolveRead; });
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }));
      firstRead();
    });
  });
  const url = await listen(server);
  let child: ChildProcess | undefined;
  try {
    const credential = await writeCredential(root);
    child = spawnCli(["inbox", "--notify", "--agent-token-file", credential,
      "--url", url, "--anon-key", "anon-idle", "--workspace-id", WORKSPACE], root, xdg,
    { NODE_ENV: "test", CSWARM_TEST_NOTIFY_CHECK_MS: "300" });
    let stderr = "";
    let stdout = "";
    child.stderr!.setEncoding("utf8");
    child.stdout!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => stderr += chunk);
    child.stdout!.on("data", (chunk: string) => stdout += chunk);
    const exit = waitForExit(child, () => stderr, 3_000);
    await read;
    child.stdout!.destroy();
    assert.equal(await exit, EXIT_NOTIFY_ORPHANED, stderr);
    assert.ok(requests >= 1);
    assert.equal(stdout, "", "an idle check must never send a stdout keepalive");
    assert.match(stderr, /\[notify_stdout_closed\]/);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed read still checks the stdout reader during retry backoff", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-retry-"));
  const xdg = join(root, "state");
  let firstRead!: () => void;
  const read = new Promise<void>((resolveRead) => { firstRead = resolveRead; });
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "unavailable" }));
      firstRead();
    });
  });
  const url = await listen(server);
  let child: ChildProcess | undefined;
  try {
    const credential = await writeCredential(root);
    child = spawnCli(["inbox", "--notify", "--agent-token-file", credential,
      "--url", url, "--anon-key", "anon-retry", "--workspace-id", WORKSPACE], root, xdg,
    { NODE_ENV: "test", CSWARM_TEST_NOTIFY_CHECK_MS: "300" });
    let stderr = "";
    let stdout = "";
    child.stderr!.setEncoding("utf8");
    child.stdout!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => stderr += chunk);
    child.stdout!.on("data", (chunk: string) => stdout += chunk);
    const exit = waitForExit(child, () => stderr, 3_000);
    await read;
    child.stdout!.destroy();
    assert.equal(await exit, EXIT_NOTIFY_ORPHANED, stderr);
    assert.ok(requests >= 1);
    assert.equal(stdout, "");
    assert.match(stderr, /\[notify_stdout_closed\]/);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("the restart sentence uses the CLI's notify flag constant", { timeout: 1_000 }, () => {
  assert.equal(NOTIFY_RESTART_COMMAND, `cswarm inbox --${NOTIFY_FLAG}`);
  assert.equal(notifyRestartCommand({ agentTokenFile: "/tmp/a b's.json" }),
    `cswarm inbox --notify --agent-token-file '/tmp/a b'"'"'s.json'`);
  assert.equal(notifyRestartCommand({ agentTokenFile: "/tmp/agent.json", workspaceId: WORKSPACE }),
    `cswarm inbox --notify --agent-token-file /tmp/agent.json --workspace-id ${WORKSPACE}`);
  assert.match(notifySignalStopSentence("SIGTERM", { agentTokenStdin: true }),
    /same way it was started, with the agent token on stdin\.$/);
  assert.doesNotMatch(notifySignalStopSentence("SIGTERM", { agentTokenStdin: true }), /^cswarm /m);
});

test("every notify parser flag survives in parsed start order without a token", { timeout: 1_000 }, () => {
  const unique = new Set(NOTIFY_ACCEPTED_FLAGS);
  assert.equal(unique.size, NOTIFY_ACCEPTED_FLAGS.length);
  for (const flag of NOTIFY_ACCEPTED_FLAGS) {
    const value = BOOLEAN_FLAGS.has(flag) ? [] : [flag === "agent-token-file" || flag === "session-context"
      ? "relative/file.json" : "public-value"];
    const args = new Arguments(["inbox", "--notify", ...(flag === NOTIFY_FLAG ? [] : [`--${flag}`, ...value])]);
    args.assertShape(NOTIFY_ACCEPTED_FLAGS, 1);
    const command = notifyRestartCommand(notifyRestartOptions(args));
    assert.ok(command.includes(`--${flag}`), flag);
    if (value.length) assert.ok(command.includes(flag === "agent-token-file" || flag === "session-context"
      ? resolve(value[0]!) : value[0]!), flag);
    assert.equal(command.includes(TOKEN), false);
  }
  const ordered = new Arguments(["inbox", "--json", "--force-file-store", "--url", "http://127.0.0.1:1", "--notify"]);
  ordered.assertShape(NOTIFY_ACCEPTED_FLAGS, 1);
  assert.equal(notifyRestartCommand(notifyRestartOptions(ordered)),
    "cswarm inbox --notify --json --force-file-store --url http://127.0.0.1:1");
  const profile = new Arguments(["inbox", "--notify", "--profile", "relative/profile.json", "--host-session-id", "public-session"]);
  const command = notifyRestartCommand(notifyRestartOptions(profile));
  assert.ok(command.includes(`--profile ${resolve("relative/profile.json")}`));
  assert.ok(command.includes("--host-session-id public-session"));
  assert.equal(command.includes("--agent-token-file"), false);
});

test("the printed restart command starts a watcher against the same loopback read service", { timeout: 12_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-restart-"));
  const xdg = join(root, "state");
  const bin = join(root, "bin");
  let firstRead!: () => void;
  let secondRead!: () => void;
  const first = new Promise<void>((resolveRead) => { firstRead = resolveRead; });
  const second = new Promise<void>((resolveRead) => { secondRead = resolveRead; });
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }));
      if (requests === 1) firstRead();
      if (requests === 2) secondRead();
    });
  });
  const url = await listen(server);
  let original: ChildProcess | undefined;
  let restarted: ChildProcess | undefined;
  try {
    await mkdir(bin);
    const credential = join(root, "agent credential's file.json");
    await writeFile(credential, credentialArtifact(), { mode: 0o600 });
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    await writeFile(join(bin, "cswarm"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(import.meta.resolve("tsx"))} ${shellQuote(resolve("src/cli.ts"))} "$@"\n`,
      { mode: 0o755 });
    original = spawnCli(["inbox", "--notify", "--agent-token-file", "agent credential's file.json",
      "--url", url, "--anon-key", "anon-restart", "--workspace-id", WORKSPACE,
      "--json", "--force-file-store"], root, xdg, {}, root);
    let stderr = "";
    original.stderr!.setEncoding("utf8");
    original.stderr!.on("data", (chunk: string) => stderr += chunk);
    const originalExit = waitForExit(original, () => stderr, 4_000);
    await Promise.race([first, originalExit.then((code) => {
      assert.fail(`original watcher exited ${code} before reading: ${stderr}`);
    })]);
    original.kill("SIGTERM");
    assert.equal(await originalExit, 143, stderr);
    const printed = stderr.trim().split("\n").find(line => line.startsWith("cswarm inbox --notify "));
    assert.ok(printed, stderr);
    assert.ok(printed.includes("--agent-token-file"));
    assert.ok(printed.includes(root), "relative credential becomes absolute for another cwd");
    assert.ok(printed.includes("--json --force-file-store"));
    assert.ok(printed.includes("--workspace-id"));
    assert.ok(printed.includes(`--url ${url}`));
    assert.ok(printed.includes("--anon-key anon-restart"));
    assert.equal(stderr.includes(TOKEN), false, "the command must not print credential contents");
    restarted = spawn("/bin/sh", ["-c", printed], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, XDG_STATE_HOME: xdg, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let restartError = "";
    restarted.stderr!.setEncoding("utf8");
    restarted.stderr!.on("data", (chunk: string) => restartError += chunk);
    const restartedExit = waitForExit(restarted, () => restartError, 4_000);
    await Promise.race([second, restartedExit.then((code) => {
      assert.fail(`printed command exited ${code} before watching: ${restartError}`);
    })]);
    restarted.kill("SIGTERM");
    assert.equal(await restartedExit, 143, restartError);
    assert.ok(requests >= 2);
  } finally {
    if (original?.exitCode === null) original.kill("SIGKILL");
    if (restarted?.exitCode === null) restarted.kill("SIGKILL");
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

for (const startMode of ["stdin", "profile"] as const) {
  test(`the ${startMode} signal stop gives an executable command only when its credential source is known`, { timeout: 12_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), `cswarm-restart-${startMode}-`));
    const xdg = join(root, "state");
    const bin = join(root, "bin");
    let firstRead!: () => void;
    let secondRead!: () => void;
    const first = new Promise<void>((resolveRead) => { firstRead = resolveRead; });
    const second = new Promise<void>((resolveRead) => { secondRead = resolveRead; });
    let requests = 0;
    const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }));
        if (requests === 1) firstRead();
        if (requests === 2) secondRead();
      });
    });
    const url = await listen(server);
    let original: ChildProcess | undefined;
    let restarted: ChildProcess | undefined;
    try {
      await mkdir(bin);
      const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
      await writeFile(join(bin, "cswarm"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(import.meta.resolve("tsx"))} ${shellQuote(resolve("src/cli.ts"))} "$@"\n`,
        { mode: 0o755 });
      const profile = join(root, "profile.json");
      if (startMode === "profile") {
        await writeFile(join(root, "credential.json"), credentialArtifact(), { mode: 0o600 });
        await writeFile(profile, JSON.stringify({
          version: 1, url, anon_key: "anon-profile", workspace_id: WORKSPACE,
          principal_id: PRINCIPAL, credential_file: join(root, "credential.json"),
        }), { mode: 0o600 });
      }
      const flags = startMode === "stdin"
        ? ["--agent-token-stdin", "--url", url, "--anon-key", "anon-stdin", "--workspace-id", WORKSPACE]
        : ["--profile", profile];
      original = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/cli.ts"), "inbox", "--notify", ...flags], {
        cwd: root,
        env: { ...process.env, HOME: root, XDG_STATE_HOME: xdg },
        stdio: ["pipe", "pipe", "pipe"],
      });
      original.stdin!.end(startMode === "stdin" ? credentialArtifact() : "");
      let stderr = "";
      original.stderr!.setEncoding("utf8");
      original.stderr!.on("data", (chunk: string) => stderr += chunk);
      const originalExit = waitForExit(original, () => stderr, 4_000);
      await Promise.race([first, originalExit.then((code) => {
        assert.fail(`original watcher exited ${code} before reading: ${stderr}`);
      })]);
      original.kill("SIGTERM");
      assert.equal(await originalExit, 143, stderr);
      const printed = stderr.trim().split("\n").find(line => line.startsWith("cswarm inbox --notify "));
      assert.equal(stderr.includes(TOKEN), false);
      if (startMode === "stdin") {
        assert.match(stderr, /same way it was started, with the agent token on stdin/);
        assert.equal(printed, undefined, stderr);
        return;
      }
      assert.ok(printed, stderr);
      assert.ok(printed.includes(`--profile ${profile}`));
      assert.equal(printed.includes("--agent-token-file"), false);
      restarted = spawn("/bin/sh", ["-c", printed], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: root, XDG_STATE_HOME: xdg, PATH: `${bin}:${process.env.PATH ?? ""}` },
        stdio: ["pipe", "pipe", "pipe"],
      });
      restarted.stdin!.end("");
      let restartError = "";
      restarted.stderr!.setEncoding("utf8");
      restarted.stderr!.on("data", (chunk: string) => restartError += chunk);
      const restartedExit = waitForExit(restarted, () => restartError, 4_000);
      await Promise.race([second, restartedExit.then((code) => {
        assert.fail(`printed command exited ${code} before watching: ${restartError}`);
      })]);
      restarted.kill("SIGTERM");
      assert.equal(await restartedExit, 143, restartError);
      assert.ok(requests >= 2);
    } finally {
      if (original?.exitCode === null) original.kill("SIGKILL");
      if (restarted?.exitCode === null) restarted.kill("SIGKILL");
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a watcher started with session context prints that accepted flag", { timeout: 12_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-restart-context-"));
  const xdg = join(root, "state");
  let firstRead!: () => void;
  const read = new Promise<void>((done) => { firstRead = done; });
  const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw) as { resource?: string };
      response.writeHead(200, { "content-type": "application/json" });
      if (body.resource === "members") response.end(JSON.stringify({
        members: [], agents: [], identity: {
          credential_valid: true, owner_user_id: OWNER, principal_id: PRINCIPAL, workspace_id: WORKSPACE,
        },
      }));
      else if (body.resource === "signals") {
        response.end(JSON.stringify({ signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } }));
        firstRead();
      } else response.end(JSON.stringify({ error: "unexpected_resource" }));
    });
  });
  const url = await listen(server);
  let child: ChildProcess | undefined;
  try {
    const credential = await writeCredential(root);
    const contextPath = join(root, "session.json");
    await writeSessionContext(contextPath, {
      ...newSessionBinding({
        target: cloudTarget(url, "anon-context"), workspaceId: WORKSPACE, principalId: PRINCIPAL,
        provider: "codex", mode: "interactive", hostSessionId: "test-session", tokenFile: credential,
      }),
      generation: 1, session_key: generateSessionKey(),
    });
    child = spawnCli(["inbox", "--notify", "--agent-token-file", credential,
      "--url", url, "--anon-key", "anon-context", "--workspace-id", WORKSPACE,
      "--session-context", contextPath], root, xdg);
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => stderr += chunk);
    const exit = waitForExit(child, () => stderr, 4_000);
    await Promise.race([read, exit.then((code) => {
      assert.fail(`session-bound watcher exited ${code} before reading: ${stderr}`);
    })]);
    child.kill("SIGTERM");
    assert.equal(await exit, 143, stderr);
    const printed = stderr.trim().split("\n").find(line => line.startsWith("cswarm inbox --notify "));
    assert.ok(printed, stderr);
    assert.ok(printed.includes(`--session-context ${contextPath}`));
    assert.equal(stderr.includes(TOKEN), false);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

for (const [signalName, expectedCode] of Object.entries(NOTIFY_SIGNAL_EXIT_CODES) as Array<[keyof typeof NOTIFY_SIGNAL_EXIT_CODES, number]>) {
  test(`${signalName} stops an idle watcher with ${expectedCode} and one restart sentence`, { timeout: 8_000 }, async () => {
    assert.equal(expectedCode, 128 + osConstants.signals[signalName]);
    const root = await mkdtemp(join(tmpdir(), "cswarm-notify-signal-"));
    const xdg = join(root, "state");
    let firstRead!: () => void;
    const read = new Promise<void>((resolveRead) => { firstRead = resolveRead; });
    const server = createServer((request, response) => {
    if (request.url === "/functions/v1/command") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, status: "accepted", generation: 1 })));
      return;
    }
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }));
        firstRead();
      });
    });
    const url = await listen(server);
    let child: ChildProcess | undefined;
    try {
      const credential = await writeCredential(root);
      child = spawnCli(["inbox", "--notify", "--agent-token-file", credential,
        "--url", url, "--anon-key", "anon-signal", "--workspace-id", WORKSPACE], root, xdg);
      let stderr = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => stderr += chunk);
      const exit = waitForExit(child, () => stderr, 3_000);
      await read;
      child.kill(signalName);
      assert.equal(await exit, expectedCode, stderr);
      assert.equal(stderr.trim(), `cswarm: ${notifySignalStopSentence(signalName, {
        arguments: ["--agent-token-file", credential, "--url", url, "--anon-key", "anon-signal", "--workspace-id", WORKSPACE],
      }, "last-known")}`);
      assert.ok(stderr.includes(NOTIFY_RESTART_COMMAND));
      assert.doesNotMatch(stderr, /now\. Restart/, "the signal message is one sentence");
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("proven stdout evidence wins over parent evidence", { timeout: 5_000 }, async () => {
  const credential = "/tmp/fake-agent.json";
  const states = ["parent_is_init", "parent_missing", "parent_alive", "cannot_determine"] as const;
  const parentProcess: ParentProcessAdapter = {
    async inspect(pid) { return states[pid - 100]!; },
  };
  const watchers = await findNotifyWatchers({
    credentialPaths: [credential], principalId: PRINCIPAL,
    processTable: { async list() { return states.map((_, index) => ({
      pid: 100 + index, command: `cswarm inbox --notify --agent-token-file ${credential}`,
    })); } },
    stdoutConsumer: { async inspect() { return "live_reader"; } },
    parentProcess,
  });
  assert.deepEqual(watchers.map((watcher) => watcher.parent), states);
  assert.deepEqual(watchers.map((watcher) => watcher.stdout), states.map(() => "live_reader"));
  const report = {
    identity: { displayName: "Test", principalId: PRINCIPAL },
    listener: { checkedDirectory: "/tmp/none", status: null, source: "not_found" as const },
    watchers, brain: { digest: null, highWaterFile: "/tmp/none" },
    inbox: { count: 0, exact: true }, target: cloudTarget("http://127.0.0.1:1", "anon"),
    workspaceId: WORKSPACE, credentialFile: credential, installedVersion: "test",
  };
  const output = renderResume(report);
  assert.match(output, /PID 100: stdout has a live pipe reader; parent PID is 1/);
  assert.match(output, /PID 101: stdout has a live pipe reader; parent process no longer exists/);
  assert.doesNotMatch(output, /kill 100 101/);
  assert.match(output, /PID 102: stdout has a live pipe reader; parent process is live/);
  assert.match(output, /PID 103: stdout has a live pipe reader; parent process cannot be determined/);
  assert.deepEqual((resumeJson(report).notify_watchers as Array<{ state: string }>).map((watcher) => watcher.state),
    ["live_reader", "live_reader", "live_reader", "live_reader"]);
});

test("resume uses parent evidence only when stdout is unproved", { timeout: 2_000 }, () => {
  const base: Parameters<typeof renderResume>[0] = {
    identity: { displayName: "Test", principalId: PRINCIPAL },
    listener: { checkedDirectory: "/tmp/none", status: null, source: "not_found" },
    watchers: [], brain: { digest: null, highWaterFile: "/tmp/none" },
    inbox: { count: 0, exact: true }, target: cloudTarget("http://127.0.0.1:1", "anon"),
    workspaceId: WORKSPACE, credentialFile: "/tmp/fake-agent.json", installedVersion: "test",
  };
  const cases = [
    ["live_reader", "parent_is_init", "live_reader"],
    ["live_reader", "parent_missing", "live_reader"],
    ["live_reader", "cannot_determine", "live_reader"],
    ["orphaned", "parent_alive", "orphaned"],
    ["orphaned", "cannot_determine", "orphaned"],
    ["cannot_determine", "parent_is_init", "orphaned"],
    ["not_pipe", "parent_missing", "orphaned"],
    ["cannot_determine", "parent_alive", "cannot_determine"],
    ["not_pipe", "cannot_determine", "cannot_determine"],
  ] as const;
  for (const [stdout, parent, expected] of cases) {
    const report = { ...base, watchers: [{ pid: 123, matchedBy: ["agent_token_file" as const], stdout, parent }] };
    const json = resumeJson(report).notify_watchers as Array<{ stdout: string; parent: string; state: string }>;
    assert.deepEqual(json.map(({ stdout, parent, state }) => [stdout, parent, state]),
      [[stdout, parent, expected]]);
    const output = renderResume(report);
    assert.equal(output.includes("kill 123"), expected === "orphaned", `${stdout}/${parent}`);
    if (expected === "orphaned") {
      assert.match(output, /Then start one watcher from this seat's live host session after its context is verified/);
      assert.doesNotMatch(output, /cswarm inbox --notify/);
    }
    if (expected === "cannot_determine") {
      assert.match(output, stdout === "cannot_determine" ? /unknown stdout reader/ : /unknown parent process/);
      if (stdout === "not_pipe") assert.doesNotMatch(output, /unknown stdout reader/);
    }
  }
});

test("the orphan stop command runs exactly as printed", { timeout: 3_000 }, async () => {
  const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    assert.ok(sleeper.pid);
    const report: Parameters<typeof renderResume>[0] = {
      identity: { displayName: "Test", principalId: PRINCIPAL },
      listener: { checkedDirectory: "/tmp/none", status: null, source: "not_found" },
      watchers: [{ pid: sleeper.pid, matchedBy: ["agent_token_file"], stdout: "orphaned", parent: "parent_alive" }],
      brain: { digest: null, highWaterFile: "/tmp/none" }, inbox: { count: 0, exact: true },
      target: cloudTarget("http://127.0.0.1:1", "anon"), workspaceId: WORKSPACE,
      credentialFile: "/tmp/fake-agent.json", installedVersion: "test",
    };
    const printed = renderResume(report).split("\n").find(line => line.startsWith("kill "));
    assert.equal(printed, `kill ${sleeper.pid}`);
    const sleeperExit = waitForExit(sleeper, () => "", 1_000);
    const shell = spawn("/bin/sh", ["-c", printed], { stdio: "ignore" });
    assert.equal(await waitForExit(shell, () => "", 1_000), 0);
    await sleeperExit;
  } finally { if (sleeper.exitCode === null) sleeper.kill("SIGKILL"); }
});

test("lane record names the Linux idle-check limit", { timeout: 1_000 }, async () => {
  const record = await readFile("docs/evidence/2026-09-24-item-g-lane2a/LANE.md", "utf8");
  assert.match(record, /On Linux, `lsof` without `\+E` prints no peer/);
  assert.match(record, /never exits 74 from that check/);
});
