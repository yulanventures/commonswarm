import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import { ListenerHttpClient } from "../src/listener/http-client.js";
import {
  listenerPaths,
  readListenerStatus,
  type ListenerPaths,
  type ListenerStatus,
} from "../src/listener/index.js";

const AGENT_MESSAGE =
  "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.";

function runCli(
  args: string[],
  options: {
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

async function waitForListenerStatus(
  paths: ListenerPaths,
  check: (status: ListenerStatus) => boolean,
  timeoutMs = 10_000,
): Promise<ListenerStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: ListenerStatus | null = null;
  while (Date.now() < deadline) {
    last = await readListenerStatus(paths);
    if (last !== null && check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `listener status did not reach the required state within ${timeoutMs}ms; ` +
      `last observed: ${JSON.stringify(last)}`,
  );
}

function listenerProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForListenerProcessExit(
  pid: number,
  directory: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listenerProcessIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!listenerProcessIsAlive(pid)) return;
  throw new Error(
    `listener process ${pid} did not exit within ${timeoutMs}ms before removing ${directory}`,
  );
}

async function stopAndWaitForDetachedListener(
  args: string[],
  paths: ListenerPaths,
): Promise<void> {
  const status = await readListenerStatus(paths);
  const wasAlive = status !== null && listenerProcessIsAlive(status.pid);
  let stopFailure: unknown = null;
  try {
    const stopped = await runCli(args);
    if (wasAlive) assert.equal(stopped.code, 0, stopped.stderr);
  } catch (error) {
    stopFailure = error;
  }
  if (status) {
    try {
      await waitForListenerProcessExit(status.pid, paths.instanceDirectory);
    } catch (error) {
      stopFailure ??= error;
      // A failed stop still must not leave the detached fixture running.
      if (listenerProcessIsAlive(status.pid)) {
        process.kill(status.pid, "SIGTERM");
        try {
          await waitForListenerProcessExit(status.pid, paths.instanceDirectory, 2_000);
        } catch {
          if (listenerProcessIsAlive(status.pid)) process.kill(status.pid, "SIGKILL");
          await waitForListenerProcessExit(status.pid, paths.instanceDirectory, 2_000);
        }
      }
    }
  }
  if (stopFailure) throw stopFailure;
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

test("listener HTTP client rewrites redirected POST and strips cross-origin secrets", async () => {
  let sourceConnections = 0;
  let destinationConnections = 0;
  let sourceMethod = "";
  let sourceBody = "";
  let sourceAuthorization = "";
  let destinationMethod = "";
  let destinationBody = "";
  let destinationHeaders: IncomingHttpHeaders = {};

  const destination = createServer(async (request, response) => {
    destinationMethod = request.method ?? "";
    destinationHeaders = request.headers;
    for await (const chunk of request) destinationBody += chunk.toString();
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("redirected");
  });
  destination.on("connection", () => {
    destinationConnections += 1;
  });
  await new Promise<void>((resolveListen) => {
    destination.listen(0, "127.0.0.1", resolveListen);
  });
  const destinationAddress = destination.address();
  assert.ok(destinationAddress && typeof destinationAddress === "object");
  const destinationUrl = `http://127.0.0.1:${destinationAddress.port}/target`;

  const source = createServer(async (request, response) => {
    sourceMethod = request.method ?? "";
    sourceAuthorization = String(request.headers.authorization ?? "");
    for await (const chunk of request) sourceBody += chunk.toString();
    response.writeHead(301, { "location": destinationUrl });
    response.end();
  });
  source.on("connection", () => {
    sourceConnections += 1;
  });
  await new Promise<void>((resolveListen) => source.listen(0, "127.0.0.1", resolveListen));
  const sourceAddress = source.address();
  assert.ok(sourceAddress && typeof sourceAddress === "object");
  const httpClient = new ListenerHttpClient({ idleTimeoutMs: 1_000 });

  try {
    const response = await httpClient.fetch(
      `http://127.0.0.1:${sourceAddress.port}/command`,
      {
        method: "POST",
        headers: {
          "apikey": "public-secret",
          "authorization": "Bearer agent-secret",
          "content-type": "application/json",
          "cookie": "session=private",
        },
        body: '{"safe":true}',
      },
    );
    assert.equal(await response.text(), "redirected");
    assert.equal(response.redirected, true);
    assert.equal(response.url, destinationUrl);
    assert.equal(sourceMethod, "POST");
    assert.equal(sourceBody, '{"safe":true}');
    assert.equal(sourceAuthorization, "Bearer agent-secret");
    assert.equal(destinationMethod, "GET");
    assert.equal(destinationBody, "");
    assert.equal(destinationHeaders.apikey, undefined);
    assert.equal(destinationHeaders.authorization, undefined);
    assert.equal(destinationHeaders.cookie, undefined);
    assert.equal(destinationHeaders["content-type"], undefined);
    assert.equal(sourceConnections, 1);
    assert.equal(destinationConnections, 1);
    assert.deepEqual(httpClient.metrics(), {
      requests: 2,
      connectionsOpened: 2,
      connectionReuseRatio: 1,
    });
  } finally {
    httpClient.close();
    await closeTestServer(source);
    await closeTestServer(destination);
  }
});

test("listener HTTP client rejects forbidden and excessive redirects", async () => {
  let requests = 0;
  let connections = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request so every redirect can reuse the same connection.
    }
    requests += 1;
    response.writeHead(302, { "location": "/loop" });
    response.end();
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/loop`;
  const httpClient = new ListenerHttpClient({ idleTimeoutMs: 1_000 });

  try {
    await assert.rejects(
      httpClient.fetch(url, { redirect: "error" }),
      /fetch failed while following a redirect/,
    );
    assert.equal(requests, 1);
    await assert.rejects(
      httpClient.fetch(url),
      /fetch failed while following a redirect/,
    );
    assert.equal(requests, 22);
    assert.equal(connections, 1);
    assert.deepEqual(httpClient.metrics(), {
      requests: 22,
      connectionsOpened: 1,
      connectionReuseRatio: 22,
    });
  } finally {
    httpClient.close();
    await closeTestServer(server);
  }
});

function fakeGrokSource(
  options: { failPrompts?: boolean } = {},
): string {
  const failPrompts = options.failPrompts === true ? "true" : "false";
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const failPrompts = ${failPrompts};

if (process.argv.includes("--version")) {
  process.stdout.write("grok 0.2.117 (fake)\\n");
  process.exit(0);
}

const audit = join(dirname(fileURLToPath(import.meta.url)), "grok-audit.ndjson");
appendFileSync(audit, JSON.stringify({
  event: "spawn",
  sandbox: process.env.GROK_SANDBOX ?? null,
  cmux_hooks_disabled: process.env.CMUX_GROK_HOOKS_DISABLED ?? null,
  has_swarm_env: Object.keys(process.env).some((key) => key.startsWith("SWARM_")),
  has_secret_env: Object.values(process.env).some((value) =>
    typeof value === "string" && value.includes("swm_agt_")
  ),
  argv_has_secret: process.argv.some((value) => value.includes("swm_agt_")),
  cwd: process.cwd(),
  home: process.env.HOME ?? null,
  grok_home: process.env.GROK_HOME ?? null,
  claude_hooks: process.env.GROK_CLAUDE_HOOKS_ENABLED ?? null,
  cursor_hooks: process.env.GROK_CURSOR_HOOKS_ENABLED ?? null,
  memory: process.env.GROK_MEMORY ?? null,
  subagents: process.env.GROK_SUBAGENTS ?? null,
}) + "\\n");

let buffer = "";
let permissionId = 1000;
const pending = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");

function finishPrompt(hostId, text, optionId) {
  const canary = text.includes("CSWARM_CANARY_NOOP");
  const denied = optionId === "deny";
  appendFileSync(audit, JSON.stringify({
    event: "permission",
    canary,
    option_id: optionId,
    sandbox: process.env.GROK_SANDBOX ?? null,
    sender_local: text.includes('"name":"Local Agent"'),
    sender_remote: text.includes('"name":"Remote Agent"'),
    operator_local: text.includes('"name":"Local Operator"'),
    operator_remote: text.includes('"name":"Remote Operator"'),
    relation_same: text.includes('"sender_owner_relation":"same_owner"'),
    relation_cross: text.includes('"sender_owner_relation":"cross_owner"'),
    seeks_confirmation: text.includes("seek your operator's explicit confirmation"),
  }) + "\\n");
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: denied ? "denied" : "completed",
      },
    },
  });
  if (!canary && failPrompts) {
    send({
      jsonrpc: "2.0",
      id: hostId,
      error: {
        code: -32000,
        message: "provider session is unavailable",
      },
    });
    return;
  }
  if (!canary) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "fake listener reply" },
        },
      },
    });
  }
  send({
    jsonrpc: "2.0",
    id: hostId,
    result: { stopReason: "end_turn" },
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          _meta: { agentVersion: "0.2.117" },
        },
      });
      continue;
    }
    if (message.method === "session/new") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "fake-session",
          modes: {
            currentModeId: "auto",
            availableModes: [{ id: "auto" }, { id: "default" }],
          },
        },
      });
      continue;
    }
    if (message.method === "session/set_mode") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      continue;
    }
    if (message.method === "session/prompt") {
      const text = message.params?.prompt?.[0]?.text ?? "";
      const requestId = ++permissionId;
      pending.set(requestId, { hostId: message.id, text });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: {
            toolCallId: "tool-1",
            title: "Fake tool",
            kind: "shell",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      const optionId = message.result?.outcome?.optionId ?? "cancelled";
      finishPrompt(item.hostId, item.text, optionId);
    }
  }
});
`;
}

test("detached CLI completes durable claim reply ACK with one startup UUID and no secret leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-cli-listener-"));
  const workerCwd = await mkdtemp(join(tmpdir(), "cswarm-cli-worker-"));
  const grokPath = join(root, "fake-grok.mjs");
  const auditPath = join(root, "grok-audit.ndjson");
  const providerHome = join(root, "provider-home");
  await writeFile(grokPath, fakeGrokSource(), { mode: 0o700 });
  await chmod(grokPath, 0o700);
  await mkdir(providerHome, { mode: 0o700 });
  const authPath = join(providerHome, "auth.json");
  await writeFile(authPath, JSON.stringify({ access_token: "fake-local-login" }), {
    mode: 0o600,
  });
  await chmod(authPath, 0o600);

  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const tokenId = randomUUID();
  const runId = randomUUID();
  const token = `swm_agt_${"A".repeat(43)}`;
  const secretSentinel = "runtime-d-secret-sentinel";
  const artifact = JSON.stringify({
    message: AGENT_MESSAGE,
    status: "accepted",
    principal_id: principalId,
    token_id: tokenId,
    run_id: runId,
    agent_token: token,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const asks = [
    {
      id: randomUUID(),
      workspace_id: workspaceId,
      from: randomUUID(),
      from_kind: "agent",
      to: null,
      to_agent: principalId,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: `same-owner test ask ${secretSentinel}`,
      until: new Date(Date.now() + 10 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 2_000).toISOString(),
      sender_owner_relation: "same_owner",
    },
    {
      id: randomUUID(),
      workspace_id: workspaceId,
      from: randomUUID(),
      from_kind: "agent",
      to: null,
      to_agent: principalId,
      in_reply_to: null,
      about: null,
      kind: "ask",
      body: `cross-owner test ask ${secretSentinel}`,
      until: new Date(Date.now() + 10 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 1_000).toISOString(),
      sender_owner_relation: "cross_owner",
    },
  ];
  const posts: Array<Record<string, unknown>> = [];
  const declares: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  const acknowledgements: Array<Record<string, unknown>> = [];
  const acknowledgedSignalIds = new Set<string>();
  const leaseIds = asks.map(() => randomUUID());
  const authHeaders: string[] = [];
  let directoryReads = 0;
  let acceptedConnections = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    authHeaders.push(String(request.headers.authorization ?? ""));
    if (request.url === "/functions/v1/read") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      if (parsed.resource === "members") {
        directoryReads += 1;
        const localOwner = randomUUID();
        const remoteOwner = randomUUID();
        response.end(JSON.stringify({
          members: [
            { user_id: localOwner, display_name: "Local Operator" },
            { user_id: remoteOwner, display_name: "Remote Operator" },
          ],
          agents: [
            {
              principal_id: asks[0]!.from,
              name: "Local Agent",
              owner_user_id: localOwner,
            },
            {
              principal_id: asks[1]!.from,
              name: "Remote Agent",
              owner_user_id: remoteOwner,
            },
          ],
        }));
        return;
      }
      response.end(JSON.stringify({
        signals: [],
        capabilities: {
          sender_owner_relation: 1,
          cursor_after: 1,
          delivery_claim: 1,
          delivery_ack: 1,
        },
        pending_delivery_count: asks.length - acknowledgedSignalIds.size,
      }));
      return;
    }
    if (request.url === "/functions/v1/command") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const command = parsed.command as Record<string, unknown>;
      if (command.kind === "claim_agent_inbox") {
        claims.push(parsed);
        const index = asks.findIndex((ask) =>
          !acknowledgedSignalIds.has(ask.id)
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          status: "accepted",
          ok: true,
          capabilities: {
            delivery_claim: 1,
            delivery_ack: 1,
            sender_owner_relation: 1,
          },
          deliveries: index === -1
            ? []
            : [{
              signal: asks[index],
              lease_id: leaseIds[index],
              leased_until: new Date(Date.now() + 10 * 60_000).toISOString(),
              sender_owner_relation: asks[index]!.sender_owner_relation,
            }],
          pending_delivery_count: asks.length - acknowledgedSignalIds.size,
          terminal_delivery_failure_count: 0,
          event_ids: [],
          events: [],
          min_client_version: "0.1.0",
        }));
        return;
      }
      if (command.kind === "declare_agent_model") {
        declares.push(parsed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          status: "accepted",
          ok: true,
          event_ids: [],
          events: [],
        }));
        return;
      }
      if (command.kind === "ack_agent_delivery") {
        acknowledgements.push(parsed);
        acknowledgedSignalIds.add(String(command.signal_id));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          status: "accepted",
          ok: true,
          event_ids: [],
          events: [],
          signal_id: command.signal_id,
          outcome: command.outcome,
        }));
        return;
      }
      posts.push(parsed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        signal: {
          ...asks[0],
          id: randomUUID(),
          kind: "note",
          body: command.body,
          in_reply_to: command.in_reply_to,
          sender_owner_relation: undefined,
        },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("connection", () => {
    acceptedConnections += 1;
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const canonicalWorkerCwd = await realpath(workerCwd);
  const common = [
    "--url",
    url,
    "--anon-key",
    "public-anon",
    "--workspace-id",
    workspaceId,
    "--state-dir",
    root,
  ];
  const paths = listenerPaths({
    profileId: cloudTarget(url, "public-anon").profileId,
    workspaceId,
    principalId,
    stateDirectory: root,
  });

  try {
    const startArgs = [
      "listen",
      "start",
      "--allow-unattended",
      "--provider",
      "grok",
      "--agent-token-stdin",
      ...common,
      "--cwd",
      workerCwd,
      "--permissions",
      "allow",
      "--grok-executable",
      grokPath,
      "--json",
    ];
    const startOptions = {
      stdin: artifact,
      env: {
        GROK_HOME: providerHome,
        SWARM_AGENT_TOKEN: token,
        DATABASE_URL: "postgres://must-not-reach-listener",
      },
    };
    const starts = await Promise.all([
      runCli(startArgs, startOptions),
      runCli(startArgs, startOptions),
    ]);
    const successfulStarts = starts.filter((result) => result.code === 0);
    const refusedStarts = starts.filter((result) => result.code !== 0);
    assert.equal(successfulStarts.length, 1, JSON.stringify(starts));
    assert.equal(refusedStarts.length, 1, JSON.stringify(starts));
    assert.match(refusedStarts[0]!.stderr, /already running/i);
    const started = successfulStarts[0]!;
    assert.equal(started.code, 0, started.stderr);
    const startJson = JSON.parse(started.stdout) as Record<string, unknown>;
    assert.equal(startJson.state, "ready");
    assert.equal(startJson.principalId, principalId);

    await waitFor(() => acknowledgements.length === 2);
    assert.equal(posts.length, 0);
    assert.deepEqual(
      acknowledgements.map((entry) =>
        (entry.command as Record<string, unknown>).outcome
      ),
      ["queued", "queued"],
    );
    assert.equal(authHeaders.every((header) => header === `Bearer ${token}`), true);

    const deliveryCommands = [...claims, ...acknowledgements];
    assert.ok(claims.length >= 2);
    assert.equal(acknowledgements.length, 2);
    const deliveryInstanceIds = deliveryCommands.map((entry) =>
      String((entry.command as Record<string, unknown>).listener_instance_id)
    );
    assert.equal(
      deliveryInstanceIds.every((instanceId) => instanceId === startJson.instanceId),
      true,
    );

    const status = await runCli([
      "listen",
      "status",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]);
    assert.equal(status.code, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(statusJson.state, "ready");
    assert.equal(statusJson.instanceId, startJson.instanceId);
    assert.equal(statusJson.deliveryMode, "durable_claim");
    assert.equal(typeof statusJson.lastAckAt, "string");
    assert.equal(statusJson.connectionsOpened, 1);
    assert.equal(typeof statusJson.connectionReuseRatio, "number");
    assert.ok((statusJson.connectionReuseRatio as number) > 1);
    assert.equal(acceptedConnections, 1);

    const stopped = await runCli([
      "listen",
      "stop",
      ...common,
      "--principal-id",
      principalId,
      "--json",
    ]);
    assert.equal(stopped.code, 0, stopped.stderr);
    await waitFor(async () => {
      const current = await runCli([
        "listen",
        "status",
        ...common,
        "--principal-id",
        principalId,
        "--json",
      ]);
      return current.code === 0 &&
        (JSON.parse(current.stdout) as Record<string, unknown>).state === "stopped";
    });

    let auditRaw = "";
    try {
      auditRaw = await readFile(auditPath, "utf8");
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
    const audit = auditRaw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const spawns = audit.filter((row) => row.event === "spawn");
    assert.equal(spawns.length, 0);

    const safeLog = await readFile(paths.logPath, "utf8");
    const safeStatus = await readFile(paths.statusPath, "utf8");
    const journal = JSON.parse(
      await readFile(join(paths.instanceDirectory, "delivery-journal.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(journal.listenerInstanceId, startJson.instanceId);
    const userAndMetadataOutput = [
      ...starts.flatMap((result) => [result.stdout, result.stderr]),
      status.stdout,
      status.stderr,
      safeLog,
      safeStatus,
    ].join("\n");
    for (const sensitive of [
      secretSentinel,
      token,
      "same-owner test ask",
      "cross-owner test ask",
      "fake listener reply",
      ...asks.map((ask) => ask.from),
      ...leaseIds,
      ...deliveryCommands.map((entry) => String(entry.command_id)),
    ]) {
      assert.equal(
        userAndMetadataOutput.includes(sensitive),
        false,
        `sensitive value reached output: ${sensitive}`,
      );
    }
  } finally {
    try {
      await stopAndWaitForDetachedListener([
        "listen",
        "stop",
        ...common,
        "--principal-id",
        principalId,
        "--json",
      ], paths);
    } finally {
      await closeTestServer(server);
    }
    await rm(root, { recursive: true, force: true });
    await rm(workerCwd, { recursive: true, force: true });
  }
});

test("detached CLI cursor fallback queues into pending-for-main and does not post a worker reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-cli-cursor-fallback-"));
  const workerCwd = await mkdtemp(join(tmpdir(), "cswarm-cli-cursor-worker-"));
  const grokPath = join(root, "fake-grok.mjs");
  const providerHome = join(root, "provider-home");
  await writeFile(grokPath, fakeGrokSource(), { mode: 0o700 });
  await chmod(grokPath, 0o700);
  await mkdir(providerHome, { mode: 0o700 });
  await writeFile(
    join(providerHome, "auth.json"),
    JSON.stringify({ access_token: "fake-local-login" }),
    { mode: 0o600 },
  );

  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const token = `swm_agt_${"C".repeat(43)}`;
  const artifact = JSON.stringify({
    message: AGENT_MESSAGE,
    status: "accepted",
    principal_id: principalId,
    token_id: randomUUID(),
    run_id: randomUUID(),
    agent_token: token,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const ask = {
    id: randomUUID(),
    workspace_id: workspaceId,
    from: randomUUID(),
    from_kind: "agent",
    to: null,
    to_agent: principalId,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: "cursor fallback test ask",
    until: new Date(Date.now() + 10 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 1_000).toISOString(),
    sender_owner_relation: "same_owner",
  };
  const posts: Array<Record<string, unknown>> = [];
  const declares: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    if (request.url === "/functions/v1/read") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      if (parsed.resource === "members") {
        const ownerId = randomUUID();
        response.end(JSON.stringify({
          members: [{ user_id: ownerId, display_name: "Cursor Operator" }],
          agents: [{
            principal_id: ask.from,
            name: "Cursor Sender",
            owner_user_id: ownerId,
          }],
        }));
        return;
      }
      response.end(JSON.stringify({
        signals: [ask],
        capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }));
      return;
    }
    if (request.url === "/functions/v1/command") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const command = parsed.command as Record<string, unknown>;
      if (command.kind === "declare_agent_model") {
        // Deliberately refused: this test doubles as the best-effort proof.
        // A failed self-description must not cost receipt or reply below.
        declares.push(parsed);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      posts.push(parsed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        signal: {
          ...ask,
          id: randomUUID(),
          kind: "note",
          body: command.body,
          in_reply_to: command.in_reply_to,
          sender_owner_relation: undefined,
        },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const common = [
    "--url",
    url,
    "--anon-key",
    "public-anon",
    "--workspace-id",
    workspaceId,
    "--state-dir",
    root,
  ];
  const paths = listenerPaths({
    profileId: cloudTarget(url, "public-anon").profileId,
    workspaceId,
    principalId,
    stateDirectory: root,
  });

  try {
    const started = await runCli([
      "listen",
      "start",
      "--allow-unattended",
      "--provider",
      "grok",
      "--agent-token-stdin",
      ...common,
      "--cwd",
      workerCwd,
      "--grok-executable",
      grokPath,
      "--json",
    ], {
      stdin: artifact,
      env: { GROK_HOME: providerHome },
    });
    assert.equal(started.code, 0, started.stderr);
    const startJson = JSON.parse(started.stdout) as Record<string, unknown>;
    assert.equal(startJson.deliveryMode, "cursor_fallback");
    const queuePath = join(paths.instanceDirectory, "pending-for-main.json");
    await waitFor(async () => {
      try {
        const raw = JSON.parse(await readFile(queuePath, "utf8")) as {
          entries?: unknown[];
        };
        return (raw.entries?.length ?? 0) === 1;
      } catch {
        return false;
      }
    });
    assert.equal(posts.length, 0);
    assert.doesNotMatch(started.stdout + started.stderr, /swm_agt_/);
  } finally {
    try {
      await stopAndWaitForDetachedListener([
        "listen",
        "stop",
        ...common,
        "--principal-id",
        principalId,
        "--json",
      ], paths);
    } finally {
      await closeTestServer(server);
    }
    await rm(root, { recursive: true, force: true });
    await rm(workerCwd, { recursive: true, force: true });
  }
});

test("detached listener stops on upgrade_required with an update action", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-fold7-detached-"));
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const artifact = JSON.stringify({
    message: AGENT_MESSAGE, status: "accepted", principal_id: principalId,
    token_id: randomUUID(), run_id: randomUUID(), agent_token: `swm_agt_${"B".repeat(43)}`,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  let claims = 0;
  const server = createServer(async (request, response) => {
    let requestBody = "";
    for await (const chunk of request) requestBody += String(chunk);
    response.setHeader("content-type", "application/json");
    if (request.url === "/functions/v1/read") {
      response.writeHead(200);
      response.end(JSON.stringify({ signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1, delivery_claim: 1, delivery_ack: 1 }, pending_delivery_count: 1 }));
      return;
    }
    const command = JSON.parse(requestBody) as { command?: { kind?: string } };
    if (command.command?.kind === "claim_agent_inbox") claims++;
    response.writeHead(426);
    response.end('{"error":"upgrade_required","min_client_version":"999.0.0"}');
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const common = ["--url", url, "--anon-key", "public-anon", "--workspace-id", workspaceId, "--state-dir", root];
  const paths = listenerPaths({ profileId: cloudTarget(url, "public-anon").profileId, workspaceId, principalId, stateDirectory: root });
  try {
    const start = await runCli(["listen", "start", "--allow-unattended", "--provider", "grok", "--agent-token-stdin", ...common, "--json"], { stdin: artifact });
    assert.ok(start.code === 0 || (start.code === 1 && start.stderr.includes("upgrade_required")), start.stderr);
    const failed = await waitForListenerStatus(paths, (status) => status.state === "failed");
    assert.equal(failed.lastErrorCode, "upgrade_required");
    assert.equal(claims, 1);
    const human = await runCli(["listen", "status", ...common, "--principal-id", principalId]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /npm install -g commonswarm.*restart the listener/);
    const safeStatus = await readFile(paths.statusPath, "utf8");
    assert.doesNotMatch(safeStatus, /swm_agt_/);
    if (process.env.CSWARM_FOLD7_STATUS_PATH) await writeFile(process.env.CSWARM_FOLD7_STATUS_PATH, safeStatus);
  } finally {
    try {
      await stopAndWaitForDetachedListener(["listen", "stop", ...common, "--principal-id", principalId, "--json"], paths);
    } finally {
      await closeTestServer(server);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("detached listener renews after a 401 and server error before the old token expires", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-fold8-renewal-"));
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const runId = randomUUID();
  const oldExpiry = Date.now() + 8_000;
  const artifact = JSON.stringify({ message: AGENT_MESSAGE, status: "accepted", principal_id: principalId,
    token_id: randomUUID(), run_id: runId, agent_token: `swm_agt_${"A".repeat(43)}`,
    expires_at: new Date(oldExpiry).toISOString() });
  let renewals = 0;
  let reads = 0;
  const server = createServer(async (request, response) => {
    let requestBody = "";
    for await (const chunk of request) requestBody += String(chunk);
    response.setHeader("content-type", "application/json");
    if (request.url === "/functions/v1/read") {
      reads++;
      response.writeHead(200);
      response.end(JSON.stringify({ signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } }));
      return;
    }
    const command = JSON.parse(requestBody) as { command?: { kind?: string } };
    if (command.command?.kind === "renew_agent_token") {
      renewals++;
      if (renewals === 1) {
        response.writeHead(401);
        response.end('{"error":"unauthenticated"}');
      } else if (renewals === 2) {
        response.writeHead(500);
        response.end('{"error":"internal_error"}');
      } else {
        const issuedAt = Date.now();
        response.writeHead(200);
        response.end(JSON.stringify({ status: "accepted", ok: true, principal_id: principalId,
          token_id: randomUUID(), run_id: runId, agent_token: `swm_agt_${"B".repeat(43)}`,
          issued_at: new Date(issuedAt).toISOString(), expires_at: new Date(issuedAt + 60 * 60_000).toISOString() }));
      }
      return;
    }
    response.writeHead(400);
    response.end('{"error":"invalid_request"}');
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const common = ["--url", url, "--anon-key", "public-anon", "--workspace-id", workspaceId, "--state-dir", root];
  const paths = listenerPaths({ profileId: cloudTarget(url, "public-anon").profileId, workspaceId, principalId, stateDirectory: root });
  try {
    const start = await runCli(["listen", "start", "--allow-unattended", "--provider", "grok", "--agent-token-stdin", ...common, "--json"],
      { stdin: artifact, env: { XDG_STATE_HOME: root } });
    assert.equal(start.code, 0, start.stderr);
    const ready = await waitForListenerStatus(paths, (status) => status.state === "ready" && renewals >= 3 && reads > 0, 20_000)
      .catch((error: unknown) => { throw new Error(`renewals=${renewals} reads=${reads}: ${String(error)}`); });
    assert.ok(Date.now() < oldExpiry, "the successor was accepted before the old token expired");
    assert.equal(ready.state, "ready");
    const safeStatus = await readFile(paths.statusPath, "utf8");
    assert.doesNotMatch(safeStatus, /swm_agt_/);
    if (process.env.CSWARM_FOLD8_RENEWAL_STATUS_PATH) await writeFile(process.env.CSWARM_FOLD8_RENEWAL_STATUS_PATH, safeStatus);
    if (process.env.CSWARM_FOLD9_RENEWAL_STATUS_PATH) await writeFile(process.env.CSWARM_FOLD9_RENEWAL_STATUS_PATH, safeStatus);
    if (process.env.CSWARM_FOLD10_RENEWAL_STATUS_PATH) await writeFile(process.env.CSWARM_FOLD10_RENEWAL_STATUS_PATH, safeStatus);
    if (process.env.CSWARM_FOLD12_RENEWAL_STATUS_PATH) await writeFile(process.env.CSWARM_FOLD12_RENEWAL_STATUS_PATH, safeStatus);
  } finally {
    try {
      await stopAndWaitForDetachedListener(["listen", "stop", ...common, "--principal-id", principalId, "--json"], paths);
    } finally {
      await closeTestServer(server);
      await rm(root, { recursive: true, force: true });
    }
  }
});
