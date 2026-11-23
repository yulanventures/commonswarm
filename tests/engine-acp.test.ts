import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AcpClient, AcpError, MAX_LINE_BYTES } from "../src/engine/acp.js";
import { AcpHarness } from "../src/engine/acp-harness.js";
import { TURN_FAILED_REPLY, type ReplyStatus } from "../src/engine/core.js";
import { LaunchError, SAFE_SYSTEM_PATH, prepareLaunch } from "../src/engine/launch.js";
import type { Clock, CloudPort, IncomingMessage } from "../src/engine/ports.js";
import { EngineRunner } from "../src/engine/runner.js";

const STANDIN_FILENAME = "engine-acp-standin.mjs";

const STANDIN_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const [scenario = "echo", statePath = "", obsPath = ""] = process.argv.slice(2);
const SESSION_ID = "sess-main-1";
const OTHER_SESSION_ID = "sess-other-9";

let nextReqId = 100;
let activePromptId = null;
const pendingClientReplies = new Map();
const recorded = {
  initializeParams: null,
  newSessionParams: null,
  cancellations: [],
  permissionReplies: [],
  methodErrors: [],
};

let obsSocket = null;
if (obsPath) {
  obsSocket = await new Promise((resolve, reject) => {
    const sock = createConnection(obsPath);
    sock.once("connect", () => {
      sock.off("error", reject);
      sock.on("error", () => {});
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

function emitEvent(ev) {
  if (obsSocket && !obsSocket.destroyed) {
    obsSocket.write(JSON.stringify(ev) + "\n");
  }
}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function sendChunk(sessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function sendClientRequest(method, params) {
  const id = nextReqId++;
  return new Promise((resolve) => {
    pendingClientReplies.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function saveState(path, data) {
  if (!path) return;
  writeFileSync(path, JSON.stringify(data), "utf8");
}

if (scenario === "hang-with-grandchild") {
  process.on("SIGTERM", () => {
    // Ignore SIGTERM to verify SIGKILL reaps both child and grandchild after grace.
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Response to a child->client request.
  if (msg.id !== undefined && msg.method === undefined) {
    const resolver = pendingClientReplies.get(msg.id);
    if (resolver) {
      pendingClientReplies.delete(msg.id);
      resolver(msg);
    }
    return;
  }

  if (msg.method === "initialize") {
    recorded.initializeParams = msg.params;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1 },
    });
    return;
  }

  if (msg.method === "session/new") {
    recorded.newSessionParams = msg.params;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: SESSION_ID },
    });
    return;
  }

  if (msg.method === "session/cancel") {
    recorded.cancellations.push(msg.params);
    emitEvent({ event: "cancel_seen", params: msg.params });
    if (scenario === "cancel-honour" && activePromptId !== null) {
      const replyId = activePromptId;
      activePromptId = null;
      send({ jsonrpc: "2.0", id: replyId, result: { stopReason: "cancelled" } });
    } else if (scenario === "cancel-exit" && activePromptId !== null) {
      activePromptId = null;
      if (obsSocket && !obsSocket.destroyed) {
        obsSocket.end(() => process.exit(0));
      } else {
        process.exit(0);
      }
    }
    return;
  }

  if (msg.method === "session/prompt") {
    void handlePrompt(msg.id, msg.params);
  }
});

async function handlePrompt(id, params) {
  const promptText = params?.prompt?.[0]?.text ?? "";

  if (scenario === "chunks-and-foreign") {
    sendChunk(SESSION_ID, "hello ");
    sendChunk(OTHER_SESSION_ID, "FOREIGN_SHOULD_BE_IGNORED");
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "UNATTRIBUTED_IGNORED" },
        },
      },
    });
    sendChunk(SESSION_ID, "world");
    saveState(statePath, recorded);
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "permission-crafted-reject") {
    const r1 = await sendClientRequest("session/request_permission", {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "tc-1", title: "run shell" },
      options: [
        { optionId: "opt-allow-trap", name: "reject", kind: "allow_once" },
        { optionId: "opt-reject-once", name: "deny once", kind: "reject_once" },
      ],
    });
    const r2 = await sendClientRequest("session/request_permission", {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "tc-2", title: "write file" },
      options: [
        { optionId: "opt-allow-trap-2", name: "reject", kind: "allow_always" },
        { optionId: "opt-reject-always", name: "deny always", kind: "reject_always" },
      ],
    });
    recorded.permissionReplies.push(r1, r2);
    saveState(statePath, recorded);
    sendChunk(SESSION_ID, "denied-ok");
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "permission-allow-only") {
    const r = await sendClientRequest("session/request_permission", {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "tc-3", title: "allow only" },
      options: [
        { optionId: "opt-allow-1", name: "reject", kind: "allow_once" },
        { optionId: "opt-allow-2", name: "reject_always", kind: "allow_always" },
      ],
    });
    recorded.permissionReplies.push(r);
    emitEvent({ event: "permission_reply", reply: r });
    return;
  }

  if (scenario === "permission-other-session") {
    const r = await sendClientRequest("session/request_permission", {
      sessionId: OTHER_SESSION_ID,
      toolCall: { toolCallId: "tc-4", title: "other session" },
      options: [
        { optionId: "opt-reject-1", name: "reject", kind: "reject_once" },
      ],
    });
    recorded.permissionReplies.push(r);
    emitEvent({ event: "permission_reply", reply: r });
    return;
  }

  if (scenario === "unsupported-methods") {
    const r1 = await sendClientRequest("fs/read_text_file", { path: "/etc/hosts" });
    const r2 = await sendClientRequest("fs/write_text_file", { path: "/tmp/x", content: "y" });
    const r3 = await sendClientRequest("terminal/create", { command: "id" });
    recorded.methodErrors.push(r1, r2, r3);
    saveState(statePath, recorded);
    sendChunk(SESSION_ID, "methods-checked");
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "report-env") {
    sendChunk(SESSION_ID, JSON.stringify(process.env));
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "hang-with-grandchild") {
    if (promptText === "after reopen") {
      sendChunk(SESSION_ID, JSON.stringify({ pid: process.pid, promptText }));
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    const grandchild = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);"],
      { stdio: "ignore" },
    );
    emitEvent({ event: "prompt_started", childPid: process.pid, grandchildPid: grandchild.pid });
    // Never respond to session/prompt.
    return;
  }

  if (scenario === "exit-once-then-succeed") {
    if (!existsSync(statePath)) {
      writeFileSync(statePath, "exited-once", "utf8");
      process.stderr.write("STDERR_SECRET_DIAGNOSTIC_DO_NOT_THROW");
      process.exit(42);
    }
    sendChunk(SESSION_ID, "recovered:" + promptText);
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "cancel-honour") {
    if (promptText === "long work") {
      activePromptId = id;
      emitEvent({ event: "prompt_started", pid: process.pid, promptText });
      return;
    }
    sendChunk(
      SESSION_ID,
      JSON.stringify({ pid: process.pid, promptText, cancellations: recorded.cancellations }),
    );
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "cancel-exit") {
    if (promptText === "long work") {
      activePromptId = id;
      emitEvent({ event: "prompt_started", pid: process.pid, promptText });
      return;
    }
    sendChunk(SESSION_ID, JSON.stringify({ pid: process.pid, promptText }));
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (scenario === "overlong-line") {
    saveState(statePath, { pid: process.pid });
    const sentinel = "OVERLONG_SECRET_SENTINEL_998877";
    const repeatCount = Math.ceil((1024 * 1024 + 64 * 1024) / sentinel.length);
    const huge = sentinel.repeat(repeatCount);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", pad: huge } }) + "\n");
    return;
  }

  if (scenario === "runner-mixed") {
    if (promptText === "FAIL_THIS_TURN") {
      send({ jsonrpc: "2.0", id, result: { stopReason: "refusal" } });
      return;
    }
    sendChunk(SESSION_ID, "ack:");
    sendChunk(SESSION_ID, promptText);
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  sendChunk(SESSION_ID, "echo:" + promptText);
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}
`;

async function makeTempStandin(t: { after: (fn: () => Promise<void> | void) => void }): Promise<{
  dir: string;
  standinPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "engine-acp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const standinPath = join(dir, STANDIN_FILENAME);
  await writeFile(standinPath, STANDIN_SOURCE, { mode: 0o600 });
  return { dir, standinPath };
}

interface StandinEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

class StandinChannel {
  readonly events: StandinEvent[] = [];
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private connections = 0;
  private disconnections = 0;
  private closed = false;
  private eventWaiters: Array<{
    eventName: string;
    resolve: (ev: StandinEvent) => void;
    reject: (err: Error) => void;
  }> = [];
  private disconnectWaiters: Array<{ count: number; resolve: () => void }> = [];

  private constructor(readonly socketPath: string, server: Server) {
    this.server = server;
    server.on("connection", (socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      let buf = "";
      socket.setEncoding("utf8");
      const parseLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        const ev = JSON.parse(line) as StandinEvent;
        this.events.push(ev);
        this.flushEventWaiters();
      };
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          parseLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      });
      socket.on("close", () => {
        if (buf.trim()) parseLine(buf);
        buf = "";
        this.sockets.delete(socket);
        this.disconnections += 1;
        this.flushDisconnectWaiters();
        if (this.disconnections >= this.connections) {
          const pending = this.eventWaiters.splice(0);
          for (const waiter of pending) {
            waiter.reject(new Error(`Stand-in disconnected before emitting event "${waiter.eventName}"`));
          }
        }
      });
    });
  }

  static async open(
    dir: string,
    t: { after: (fn: () => Promise<void> | void) => void },
    socketName = "obs.sock",
  ): Promise<StandinChannel> {
    const socketPath = join(dir, socketName);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const channel = new StandinChannel(socketPath, server);
    t.after(() => channel.close());
    return channel;
  }

  waitForEvent(eventName: string): Promise<StandinEvent> {
    const existing = this.events.find((ev) => ev.event === eventName);
    if (existing) return Promise.resolve(existing);
    if (this.closed || (this.connections > 0 && this.disconnections >= this.connections)) {
      return Promise.reject(new Error(`Stand-in disconnected before emitting event "${eventName}"`));
    }
    return new Promise<StandinEvent>((resolve, reject) => {
      this.eventWaiters.push({ eventName, resolve, reject });
    });
  }

  waitForDisconnect(expectedCount = Math.max(1, this.connections)): Promise<void> {
    if (this.disconnections >= expectedCount) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.disconnectWaiters.push({ count: expectedCount, resolve });
    });
  }

  private flushEventWaiters(): void {
    const remaining: typeof this.eventWaiters = [];
    for (const waiter of this.eventWaiters) {
      const match = this.events.find((ev) => ev.event === waiter.eventName);
      if (match) waiter.resolve(match);
      else remaining.push(waiter);
    }
    this.eventWaiters = remaining;
  }

  private flushDisconnectWaiters(): void {
    const remaining: typeof this.disconnectWaiters = [];
    for (const waiter of this.disconnectWaiters) {
      if (this.disconnections >= waiter.count) waiter.resolve();
      else remaining.push(waiter);
    }
    this.disconnectWaiters = remaining;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const waiter of this.eventWaiters.splice(0)) {
      waiter.reject(new Error(`StandinChannel closed before event "${waiter.eventName}"`));
    }
    for (const waiter of this.disconnectWaiters.splice(0)) {
      waiter.resolve();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
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

function makeClock(start = 1_000): Clock {
  let now = start;
  return {
    now() {
      now += 1;
      return now;
    },
  };
}

class FakeCloud {
  readonly pending: IncomingMessage[] = [];
  readonly seen: string[] = [];
  readonly replies: Array<{ messageId: string; text: string; status: ReplyStatus }> = [];

  private claimWaiter: (() => void) | null = null;
  private replyWaiters: Array<{ count: number; resolve: () => void }> = [];

  enqueue(...messages: readonly IncomingMessage[]): void {
    this.pending.push(...messages);
    const wake = this.claimWaiter;
    this.claimWaiter = null;
    wake?.();
  }

  waitForReplies(count: number): Promise<void> {
    if (this.replies.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.replyWaiters.push({ count, resolve });
    });
  }

  connect(): CloudPort {
    return {
      claim: async (limit: number, signal?: AbortSignal) => {
        while (this.pending.length === 0) {
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
          if (signal?.aborted) return [];
        }
        return this.pending.splice(0, limit);
      },
      markSeen: async (messageId: string) => {
        this.seen.push(messageId);
      },
      postReply: async (messageId: string, _commandId: string, text: string, status: ReplyStatus) => {
        this.replies.push({ messageId, text, status });
        const remaining: Array<{ count: number; resolve: () => void }> = [];
        for (const waiter of this.replyWaiters) {
          if (this.replies.length >= waiter.count) waiter.resolve();
          else remaining.push(waiter);
        }
        this.replyWaiters = remaining;
      },
    };
  }
}

test("1. turn returns concatenated chunks for this session and ignores chunks for other sessions", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);
  const statePath = join(dir, "state.json");

  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "chunks-and-foreign", statePath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => harness.close());

  const reply = await harness.runTurn("say hello");
  assert.equal(reply, "hello world");

  const recorded = JSON.parse(await readFile(statePath, "utf8")) as {
    initializeParams: { protocolVersion: number; clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean } };
    newSessionParams: { cwd: string; mcpServers: unknown[] };
  };
  assert.equal(recorded.initializeParams.protocolVersion, 1);
  assert.deepEqual(recorded.initializeParams.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.equal(recorded.newSessionParams.cwd, dir);
  assert.deepEqual(recorded.newSessionParams.mcpServers, []);
});

test("2. permission requests are deny-only: reject selected, crafted allow named 'reject' ignored, allow-only cancels and fails", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);

  // 2a. Crafted allow_once/allow_always named "reject" placed first -> still selects reject_once / reject_always.
  const craftedState = join(dir, "crafted.json");
  const craftedHarness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "permission-crafted-reject", craftedState],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => craftedHarness.close());

  const reply = await craftedHarness.runTurn("try tools");
  assert.equal(reply, "denied-ok");

  const craftedData = JSON.parse(await readFile(craftedState, "utf8")) as {
    permissionReplies: Array<{ result: { outcome: { outcome: string; optionId?: string } } }>;
  };
  assert.deepEqual(
    craftedData.permissionReplies.map((r) => r.result.outcome),
    [
      { outcome: "selected", optionId: "opt-reject-once" },
      { outcome: "selected", optionId: "opt-reject-always" },
    ],
  );

  // 2b. Offered only allow options -> answers cancelled, sends session/cancel, fails turn.
  const allowOnlyChannel = await StandinChannel.open(dir, t, "obs-2b.sock");
  const allowOnlyPrepared = await prepareLaunch({
    executable: process.execPath,
    args: [standinPath, "permission-allow-only", "", allowOnlyChannel.socketPath],
    cwd: dir,
  });
  const allowOnlyClient = await AcpClient.open({
    ...allowOnlyPrepared,
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => allowOnlyClient.close());

  await assert.rejects(
    () => allowOnlyClient.prompt("only allow"),
    (err: unknown) => err instanceof AcpError && err.code === "permission_denied_abort",
  );

  const allowOnlyPerm = await allowOnlyChannel.waitForEvent("permission_reply");
  assert.deepEqual(
    (allowOnlyPerm.reply as { result: { outcome: { outcome: string } } }).result.outcome,
    { outcome: "cancelled" },
  );

  const allowOnlyCancel = await allowOnlyChannel.waitForEvent("cancel_seen");
  assert.deepEqual([allowOnlyCancel.params], [{ sessionId: "sess-main-1" }]);

  // 2c. Permission request naming another session -> answers cancelled, sends session/cancel, fails turn.
  const otherChannel = await StandinChannel.open(dir, t, "obs-2c.sock");
  const otherPrepared = await prepareLaunch({
    executable: process.execPath,
    args: [standinPath, "permission-other-session", "", otherChannel.socketPath],
    cwd: dir,
  });
  const otherClient = await AcpClient.open({
    ...otherPrepared,
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => otherClient.close());

  await assert.rejects(
    () => otherClient.prompt("foreign perm"),
    (err: unknown) => err instanceof AcpError && err.code === "permission_denied_abort",
  );

  const otherPerm = await otherChannel.waitForEvent("permission_reply");
  assert.deepEqual(
    (otherPerm.reply as { result: { outcome: { outcome: string } } }).result.outcome,
    { outcome: "cancelled" },
  );
  const otherCancel = await otherChannel.waitForEvent("cancel_seen");
  assert.deepEqual([otherCancel.params], [{ sessionId: "sess-main-1" }]);
});

test("3. child requests for fs/read_text_file, fs/write_text_file, and terminal/create get method not found", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);
  const statePath = join(dir, "methods.json");

  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "unsupported-methods", statePath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => harness.close());

  const reply = await harness.runTurn("probe methods");
  assert.equal(reply, "methods-checked");

  const recorded = JSON.parse(await readFile(statePath, "utf8")) as {
    methodErrors: Array<{ error?: { code: number; message: string } }>;
  };
  assert.equal(recorded.methodErrors.length, 3);
  for (const response of recorded.methodErrors) {
    assert.equal(response.error?.code, -32601);
    assert.match(response.error?.message ?? "", /method not found/i);
  }
});

test("4. environment isolation strips parent secrets/SWARM/CSWARM vars and refuses TOKEN in extraEnv", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);

  const injectedParentVars: Record<string, string> = {
    PARENT_API_SECRET: "super-secret-value",
    SWARM_AGENT_TOKEN: "swm_agt_leaked",
    CSWARM_PROFILE: "/tmp/do-not-leak-profile.json",
    RANDOM_UNLISTED_VAR: "should-not-appear",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(injectedParentVars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const launchDesc = {
    executable: process.execPath,
    args: [standinPath, "report-env"],
    cwd: dir,
    configRootEnv: { name: "ENGINE_TEST_CONFIG_DIR", value: join(dir, "cfg") },
    extraEnv: { ENGINE_TEST_MODE: "isolated" },
  };
  const prepared = await prepareLaunch(launchDesc);
  const allowedKeys = new Set([
    "PATH",
    "HOME",
    "LANG",
    "TMPDIR",
    "ENGINE_TEST_CONFIG_DIR",
    "ENGINE_TEST_MODE",
  ]);
  for (const key of Object.keys(prepared.env)) {
    assert.ok(allowedKeys.has(key), `Unexpected env variable in prepared launch: ${key}`);
  }

  const harness = new AcpHarness({
    launch: launchDesc,
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => harness.close());

  const rawEnv = await harness.runTurn("dump env");
  const childEnv = JSON.parse(rawEnv) as Record<string, string>;

  assert.equal(childEnv.PARENT_API_SECRET, undefined);
  assert.equal(childEnv.SWARM_AGENT_TOKEN, undefined);
  assert.equal(childEnv.CSWARM_PROFILE, undefined);
  assert.equal(childEnv.RANDOM_UNLISTED_VAR, undefined);

  assert.equal(childEnv.ENGINE_TEST_CONFIG_DIR, join(dir, "cfg"));
  assert.equal(childEnv.ENGINE_TEST_MODE, "isolated");

  const resolvedExec = await realpath(process.execPath);
  const execDir = dirname(resolvedExec);
  const expectedPath = SAFE_SYSTEM_PATH.split(":").includes(execDir)
    ? SAFE_SYSTEM_PATH
    : `${SAFE_SYSTEM_PATH}:${execDir}`;
  assert.equal(childEnv.PATH, expectedPath);

  // macOS CoreFoundation/libSystem injects __CF_USER_TEXT_ENCODING inside the child process
  // on startup even when execve receives a minimal envp; verify nothing else appears.
  for (const key of Object.keys(childEnv)) {
    if (key === "__CF_USER_TEXT_ENCODING") continue;
    assert.ok(allowedKeys.has(key), `Unexpected env variable leaked to child: ${key}`);
  }

  await assert.rejects(
    () =>
      prepareLaunch({
        executable: process.execPath,
        args: [standinPath],
        cwd: dir,
        extraEnv: { MY_AUTH_TOKEN: "nope" },
      }),
    (err: unknown) => err instanceof LaunchError && err.code === "forbidden_env_name",
  );

  await assert.rejects(
    () =>
      prepareLaunch({
        executable: process.execPath,
        args: [standinPath],
        cwd: dir,
        configRootEnv: { name: "CSWARM_CONFIG_DIR", value: dir },
      }),
    (err: unknown) => err instanceof LaunchError && err.code === "forbidden_env_name",
  );
});

test("5. turn budget expiration sends session/cancel, fails turn, and reaps child and grandchild", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);
  const channel = await StandinChannel.open(dir, t, "obs-5.sock");

  let recordedPids: { childPid: number; grandchildPid: number } | null = null;
  t.after(() => {
    if (!recordedPids) return;
    for (const pid of [recordedPids.grandchildPid, recordedPids.childPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  });

  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "hang-with-grandchild", "", channel.socketPath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 150,
    killGraceMs: 150,
  });
  t.after(() => harness.close());

  const startedPromise = channel.waitForEvent("prompt_started");
  const turnPromise = harness.runTurn("hang forever");
  const started = await startedPromise;
  recordedPids = {
    childPid: started.childPid as number,
    grandchildPid: started.grandchildPid as number,
  };
  assert.ok(recordedPids.childPid > 0);
  assert.ok(recordedPids.grandchildPid > 0);

  await assert.rejects(
    () => turnPromise,
    (err: unknown) => err instanceof AcpError && err.code === "turn_budget_exceeded",
  );

  await channel.waitForDisconnect(1);
  const cancellations = channel.events
    .filter((ev) => ev.event === "cancel_seen")
    .map((ev) => ev.params);
  assert.deepEqual(cancellations, [{ sessionId: "sess-main-1" }]);

  assert.equal(isPidAlive(recordedPids.childPid), false, "child process survived close");
  assert.equal(
    isPidAlive(recordedPids.grandchildPid),
    false,
    "grandchild process survived close",
  );
});

test("6. child exit mid-turn fails promptly without throwing stderr, and next turn opens a fresh session", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);
  const markerPath = join(dir, "exited.marker");

  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "exit-once-then-succeed", markerPath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => harness.close());

  await assert.rejects(
    () => harness.runTurn("first"),
    (err: unknown) => {
      assert.ok(err instanceof AcpError);
      assert.equal(err.code, "child_exited");
      assert.equal(err.exitCode, 42);
      assert.equal(err.message, "ACP child exited with code 42");
      assert.equal(err.message.includes("STDERR_SECRET_DIAGNOSTIC"), false);
      return true;
    },
  );
  assert.match(harness.getStderrTail(), /STDERR_SECRET_DIAGNOSTIC_DO_NOT_THROW/);

  const reply = await harness.runTurn("second");
  assert.equal(reply, "recovered:second");
});

test("7a. interrupt() when stand-in honours cancel rejects as interrupted, keeps session open, and ignores idle/duplicate interrupts", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);

  // Direct AcpClient: idle interrupt is no-op, duplicate interrupt is no-op, session stays open.
  const clientChannel = await StandinChannel.open(dir, t, "obs-7a-client.sock");
  const prepared = await prepareLaunch({
    executable: process.execPath,
    args: [standinPath, "cancel-honour", "", clientChannel.socketPath],
    cwd: dir,
  });
  const client = await AcpClient.open({
    ...prepared,
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 10_000,
    killGraceMs: 500,
  });
  t.after(() => client.close());

  client.interrupt(); // No turn running: must be a no-op.

  const startedPromise = clientChannel.waitForEvent("prompt_started");
  const turnPromise = client.prompt("long work");
  const started = await startedPromise;
  assert.equal(started.promptText, "long work");

  client.interrupt();
  client.interrupt(); // Second interrupt while pending: must be a no-op.

  await assert.rejects(
    () => turnPromise,
    (err: unknown) => err instanceof AcpError && err.code === "interrupted" && err.stopReason === undefined,
  );
  assert.equal(client.isClosed, false);
  assert.equal(client.isExited, false);

  client.interrupt(); // No turn running after cancel: must be a no-op.

  const followUpRaw = await client.prompt("after cancel");
  const followUp = JSON.parse(followUpRaw) as {
    pid: number;
    promptText: string;
    cancellations: Array<{ sessionId: string }>;
  };
  assert.equal(followUp.pid, started.pid);
  assert.equal(followUp.promptText, "after cancel");
  assert.deepEqual(followUp.cancellations, [{ sessionId: "sess-main-1" }]);

  // AcpHarness: keeps the same session usable for the next turn when cancel is honoured.
  const harnessChannel = await StandinChannel.open(dir, t, "obs-7a-harness.sock");
  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "cancel-honour", "", harnessChannel.socketPath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 10_000,
    killGraceMs: 500,
  });
  t.after(() => harness.close());

  harness.interrupt(); // No session/turn yet: must be a no-op.

  const hStartedPromise = harnessChannel.waitForEvent("prompt_started");
  const hTurnPromise = harness.runTurn("long work");
  const hStarted = await hStartedPromise;

  harness.interrupt();
  harness.interrupt();

  await assert.rejects(
    () => hTurnPromise,
    (err: unknown) => err instanceof AcpError && err.code === "interrupted" && err.stopReason === undefined,
  );

  harness.interrupt(); // Idle between turns: must be a no-op.

  const hFollowUp = JSON.parse(await harness.runTurn("after cancel")) as {
    pid: number;
    promptText: string;
    cancellations: Array<{ sessionId: string }>;
  };
  assert.equal(hFollowUp.pid, hStarted.pid);
  assert.equal(hFollowUp.promptText, "after cancel");
  assert.deepEqual(hFollowUp.cancellations, [{ sessionId: "sess-main-1" }]);

  // Child exiting by itself in response to session/cancel rejects as interrupted and next turn reopens.
  const exitChannel = await StandinChannel.open(dir, t, "obs-7a-exit.sock");
  const exitHarness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "cancel-exit", "", exitChannel.socketPath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 10_000,
    killGraceMs: 500,
  });
  t.after(() => exitHarness.close());

  const exitStartedPromise = exitChannel.waitForEvent("prompt_started");
  const exitTurnPromise = exitHarness.runTurn("long work");
  const exitStarted = await exitStartedPromise;

  exitHarness.interrupt();

  await assert.rejects(
    () => exitTurnPromise,
    (err: unknown) => err instanceof AcpError && err.code === "interrupted",
  );
  await exitChannel.waitForDisconnect(1);
  assert.deepEqual(
    exitChannel.events.filter((ev) => ev.event === "cancel_seen").map((ev) => ev.params),
    [{ sessionId: "sess-main-1" }],
  );

  const reopened = JSON.parse(await exitHarness.runTurn("fresh after exit")) as {
    pid: number;
    promptText: string;
  };
  assert.notEqual(reopened.pid, exitStarted.pid);
  assert.equal(reopened.promptText, "fresh after exit");
});

test("7b. interrupt() when stand-in ignores cancel rejects as interrupted after grace, closes session, and reaps child and grandchild", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);

  const pidsToReap: number[] = [];
  t.after(() => {
    for (const pid of pidsToReap) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  });

  // Direct AcpClient: rejects as interrupted after grace, closes session, reaps child & grandchild.
  const clientChannel = await StandinChannel.open(dir, t, "obs-7b-client.sock");
  const prepared = await prepareLaunch({
    executable: process.execPath,
    args: [standinPath, "hang-with-grandchild", "", clientChannel.socketPath],
    cwd: dir,
  });
  const client = await AcpClient.open({
    ...prepared,
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 10_000,
    killGraceMs: 100,
  });
  t.after(() => client.close());

  const cStartedPromise = clientChannel.waitForEvent("prompt_started");
  const cTurnPromise = client.prompt("hang forever");
  const cStarted = await cStartedPromise;
  const cChildPid = cStarted.childPid as number;
  const cGrandchildPid = cStarted.grandchildPid as number;
  pidsToReap.push(cGrandchildPid, cChildPid);
  assert.ok(cChildPid > 0);
  assert.ok(cGrandchildPid > 0);

  client.interrupt();
  client.interrupt();

  await assert.rejects(
    () => cTurnPromise,
    (err: unknown) => err instanceof AcpError && err.code === "interrupted",
  );
  assert.equal(client.isClosed, true);

  await clientChannel.waitForDisconnect(1);
  assert.deepEqual(
    clientChannel.events.filter((ev) => ev.event === "cancel_seen").map((ev) => ev.params),
    [{ sessionId: "sess-main-1" }],
  );
  assert.equal(isPidAlive(cChildPid), false, "child process survived close");
  assert.equal(isPidAlive(cGrandchildPid), false, "grandchild process survived close");

  // AcpHarness: reaps unresponsive child/grandchild and opens a fresh session on the next turn.
  const harnessChannel = await StandinChannel.open(dir, t, "obs-7b-harness.sock");
  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "hang-with-grandchild", "", harnessChannel.socketPath],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 10_000,
    killGraceMs: 100,
  });
  t.after(() => harness.close());

  const hStartedPromise = harnessChannel.waitForEvent("prompt_started");
  const hTurnPromise = harness.runTurn("hang forever");
  const hStarted = await hStartedPromise;
  const hChildPid = hStarted.childPid as number;
  const hGrandchildPid = hStarted.grandchildPid as number;
  pidsToReap.push(hGrandchildPid, hChildPid);

  harness.interrupt();

  await assert.rejects(
    () => hTurnPromise,
    (err: unknown) => err instanceof AcpError && err.code === "interrupted",
  );
  await harnessChannel.waitForDisconnect(1);
  assert.deepEqual(
    harnessChannel.events.filter((ev) => ev.event === "cancel_seen").map((ev) => ev.params),
    [{ sessionId: "sess-main-1" }],
  );
  assert.equal(isPidAlive(hChildPid), false, "child process survived close");
  assert.equal(isPidAlive(hGrandchildPid), false, "grandchild process survived close");

  const reopened = JSON.parse(await harness.runTurn("after reopen")) as {
    pid: number;
    promptText: string;
  };
  assert.notEqual(reopened.pid, hChildPid);
  assert.equal(reopened.promptText, "after reopen");
});

test("8. executable checks refuse relative, group-writable, and non-executable paths, and resolve valid symlinks", async (t) => {
  const { dir } = await makeTempStandin(t);

  // Relative path refused.
  await assert.rejects(
    () => prepareLaunch({ executable: "bin/fake-tool", args: [], cwd: dir }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchError);
      assert.equal(err.code, "invalid_executable");
      assert.equal(err.message.includes("bin/fake-tool"), false);
      return true;
    },
  );

  // Group-writable executable refused.
  const groupWritable = join(dir, "group-writable.sh");
  await writeFile(groupWritable, "#!/bin/sh\nexit 0\n", { mode: 0o775 });
  await chmod(groupWritable, 0o775);
  await assert.rejects(
    () => prepareLaunch({ executable: groupWritable, args: [], cwd: dir }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchError);
      assert.equal(err.code, "executable_writable");
      assert.equal(err.message.includes(dir), false);
      return true;
    },
  );

  // Non-executable file refused.
  const nonExec = join(dir, "not-exec.sh");
  await writeFile(nonExec, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await chmod(nonExec, 0o644);
  await assert.rejects(
    () => prepareLaunch({ executable: nonExec, args: [], cwd: dir }),
    (err: unknown) => {
      assert.ok(err instanceof LaunchError);
      assert.equal(err.code, "executable_not_executable");
      assert.equal(err.message.includes(dir), false);
      return true;
    },
  );

  // Symlink to a good executable accepted and resolved path returned.
  const goodExec = join(dir, "good-exec.sh");
  const goodLink = join(dir, "good-link.sh");
  await writeFile(goodExec, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(goodExec, 0o755);
  await symlink(goodExec, goodLink);

  const prepared = await prepareLaunch({ executable: goodLink, args: ["--ok"], cwd: dir });
  assert.equal(prepared.executable, await realpath(goodExec));
  assert.deepEqual(prepared.args, ["--ok"]);
});

test("9. over-long line from child fails turn, closes session, and leaks none of the line content", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);
  const pidPath = join(dir, "overlong-pid.json");
  assert.equal(MAX_LINE_BYTES, 1024 * 1024);

  const prepared = await prepareLaunch({
    executable: process.execPath,
    args: [standinPath, "overlong-line", pidPath],
    cwd: dir,
  });
  const client = await AcpClient.open({
    ...prepared,
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => client.close());

  await assert.rejects(
    () => client.prompt("send huge line"),
    (err: unknown) => {
      assert.ok(err instanceof AcpError);
      assert.equal(err.code, "line_too_large");
      assert.equal(err.message.includes("OVERLONG_SECRET_SENTINEL"), false);
      return true;
    },
  );

  assert.equal(client.isClosed, true);
  const { pid } = JSON.parse(await readFile(pidPath, "utf8")) as { pid: number };
  assert.equal(isPidAlive(pid), false, "child should be closed after overlong line");
});

test("10. real EngineRunner with AcpHarness and fake cloud delivers 3 replies in order and fixed failure reply on turn failure", async (t) => {
  const { dir, standinPath } = await makeTempStandin(t);
  const journalPath = join(dir, "state", "journal.ndjson");
  const cloud = new FakeCloud();

  const harness = new AcpHarness({
    launch: {
      executable: process.execPath,
      args: [standinPath, "runner-mixed"],
      cwd: dir,
    },
    handshakeTimeoutMs: 5_000,
    turnBudgetMs: 5_000,
    killGraceMs: 500,
  });
  t.after(() => harness.close());

  cloud.enqueue(
    { id: "m-1", text: "first" },
    { id: "m-2", text: "second" },
    { id: "m-3", text: "third" },
    { id: "m-4", text: "FAIL_THIS_TURN" },
  );

  const runner = new EngineRunner({
    journalPath,
    harness,
    cloud: cloud.connect(),
    clock: makeClock(),
    replyRetryHorizonMs: 60_000,
    compactAfterRecords: 1_000,
    settledIdCap: 1_000,
  });
  await runner.start();
  await cloud.waitForReplies(4);
  const result = await runner.stop();
  assert.deepEqual(result, { reason: "stopped" });

  assert.deepEqual(cloud.replies, [
    { messageId: "m-1", text: "ack:first", status: "replied" },
    { messageId: "m-2", text: "ack:second", status: "replied" },
    { messageId: "m-3", text: "ack:third", status: "replied" },
    { messageId: "m-4", text: TURN_FAILED_REPLY, status: "failed" },
  ]);
});
