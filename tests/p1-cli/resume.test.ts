/**
 * Read-only reconnect and orphan-watcher controls.
 *
 * Reached by BOTH package.json's literal `npm test` list and
 * `npm run test:p1-cli` through tests/p1-cli/**\/*.test.ts.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
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
import {
  FileBrainDigestStore,
  FileHookSurfaceStore,
  listenerPaths,
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
import { parseLsofStdout } from "../../src/stdout-consumer.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SENDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OLD_SIGNAL = "11111111-1111-4111-8111-111111111111";
const NEW_SIGNAL = "22222222-2222-4222-8222-222222222222";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

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
    assert.match(output, /CommonSwarm did not kill anything: kill 5102/);
    assert.match(output, /restart v2/);
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
): ChildProcess {
  return spawn(process.execPath, [
    "--import",
    "tsx",
    resolve("src/cli.ts"),
    ...args,
  ], {
    cwd: process.cwd(),
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

test("the real resume CLI uses only read resources and leaves local files byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-resume-cli-"));
  const xdg = join(root, "state");
  const requests: Array<{ path: string; resource: unknown }> = [];
  const server = createServer((request, response) => {
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
    ]);
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
    /cswarm inbox --notify --agent-token-stdin with the same credential input on stdin\.$/);
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
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import tsx ${shellQuote(resolve("src/cli.ts"))} "$@"\n`,
      { mode: 0o755 });
    original = spawnCli(["inbox", "--notify", "--agent-token-file", credential,
      "--url", url, "--anon-key", "anon-restart", "--workspace-id", WORKSPACE], root, xdg);
    let stderr = "";
    original.stderr!.setEncoding("utf8");
    original.stderr!.on("data", (chunk: string) => stderr += chunk);
    const originalExit = waitForExit(original, () => stderr, 4_000);
    await first;
    original.kill("SIGTERM");
    assert.equal(await originalExit, 143, stderr);
    const match = stderr.trim().match(/with (cswarm inbox --notify .*)\.$/);
    assert.ok(match, stderr);
    assert.ok(match[1]!.includes("--agent-token-file"));
    assert.ok(match[1]!.includes("--workspace-id"));
    assert.ok(match[1]!.includes(`--url ${url}`));
    assert.ok(match[1]!.includes("--anon-key anon-restart"));
    assert.equal(stderr.includes(TOKEN), false, "the command must not print credential contents");
    restarted = spawn("/bin/sh", ["-c", match[1]!], {
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

for (const [signalName, expectedCode] of Object.entries(NOTIFY_SIGNAL_EXIT_CODES) as Array<[keyof typeof NOTIFY_SIGNAL_EXIT_CODES, number]>) {
  test(`${signalName} stops an idle watcher with ${expectedCode} and one restart sentence`, { timeout: 8_000 }, async () => {
    assert.equal(expectedCode, 128 + osConstants.signals[signalName]);
    const root = await mkdtemp(join(tmpdir(), "cswarm-notify-signal-"));
    const xdg = join(root, "state");
    let firstRead!: () => void;
    const read = new Promise<void>((resolveRead) => { firstRead = resolveRead; });
    const server = createServer((request, response) => {
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
        agentTokenFile: credential, workspaceId: WORKSPACE, url, anonKey: "anon-signal",
      })}`);
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
      assert.ok(output.includes(`then restart ${notifyRestartCommand({
        agentTokenFile: base.credentialFile, workspaceId: WORKSPACE,
        url: base.target.url, anonKey: base.target.anonKey,
      })}`));
    }
    if (expected === "cannot_determine") {
      assert.match(output, stdout === "cannot_determine" ? /unknown stdout reader/ : /unknown parent process/);
      if (stdout === "not_pipe") assert.doesNotMatch(output, /unknown stdout reader/);
    }
  }
});

test("lane record names the Linux idle-check limit", { timeout: 1_000 }, async () => {
  const record = await readFile("docs/evidence/2026-09-24-item-g-lane2a/LANE.md", "utf8");
  assert.match(record, /On Linux, `lsof` without `\+E` prints no peer/);
  assert.match(record, /never exits 74 from that check/);
});
