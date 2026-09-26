import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  AGENT_PRESENCE_LABELS,
  classifyAgentPresence,
  type AgentPresenceRow,
} from "../../src/cloud/agent-presence.js";
import {
  AGENT_PRESENCE_TOUCH_INTERVAL_MS,
  agentPresenceTouchStatePath,
  checkAgentMessages,
} from "../../src/cloud/agent-check.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { CLI_BUILD_VERSION, withClientBuild } from "../../src/cloud/client-build.js";
import { DeliveryCommandClient } from "../../src/cloud/delivery.js";
import { WAKE_LEASE_STALE_MS } from "../../src/cloud/wake-lease-constants.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(repoRoot, "src");
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"P".repeat(43)}`;
let root: string;
let previousAgentStateDirectory: string | undefined;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-presence-client-"));
  previousAgentStateDirectory = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
});
after(async () => {
  if (previousAgentStateDirectory === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
  else process.env.SWARM_AGENT_STATE_DIR = previousAgentStateDirectory;
  await rm(root, { recursive: true, force: true });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : Promise.resolve(path.endsWith(".ts") ? [path] : []);
  }));
  return nested.flat();
}

function clientVersionWithoutBuild(source: string, file = "fixture.ts"): number[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "client_version") {
      let cursor: ts.Node | undefined = node.parent;
      let wrapped = false;
      while (cursor && !ts.isStatement(cursor)) {
        if (ts.isCallExpression(cursor) && ts.isIdentifier(cursor.expression) &&
            cursor.expression.text === "withClientBuild") wrapped = true;
        cursor = cursor.parent;
      }
      if (!wrapped) lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return lines;
}

test("the client build helper owns the source and every command envelope uses it", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.equal(CLI_BUILD_VERSION, packageJson.version);
  assert.deepEqual(withClientBuild({ command_id: "one", client_build: "wrong" }), {
    command_id: "one", client_build: packageJson.version,
  });
  assert.deepEqual(
    clientVersionWithoutBuild("JSON.stringify({ client_version: CLIENT_PROTOCOL_VERSION, command: {} });"),
    [1],
    "positive control: an unwrapped command envelope is detected",
  );

  const files = await typescriptFiles(srcRoot);
  const constructors: string[] = [];
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!source.includes("client_version:")) continue;
    constructors.push(relative(repoRoot, file));
    for (const line of clientVersionWithoutBuild(source, file)) {
      violations.push(`${relative(repoRoot, file)}:${line}`);
    }
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(constructors.sort(), [
    "src/cloud/agent-signal-receipts.ts",
    "src/cloud/auth.ts",
    "src/cloud/command-client.ts",
    "src/cloud/delivery.ts",
    "src/cloud/feedback.ts",
    "src/cloud/files.ts",
    "src/cloud/renewal.ts",
    "src/cloud/session-client.ts",
    "src/cloud/wake-lease.ts",
  ]);
});

test("only the channel and listener claim callers set a presence route", async () => {
  const callers: Array<{ file: string; route: string | null }> = [];
  for (const file of await typescriptFiles(srcRoot)) {
    const source = await readFile(file, "utf8");
    if (!source.includes(".claimAgentInbox(")) continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "claimAgentInbox") {
        const input = node.arguments[0];
        assert.ok(input && ts.isObjectLiteralExpression(input), `${file} claim input is explicit`);
        const route = input.properties.find(property => property.name?.getText(ast) === "route");
        assert.ok(route === undefined || ts.isPropertyAssignment(route));
        callers.push({
          file: relative(repoRoot, file),
          route: route && ts.isPropertyAssignment(route) && ts.isStringLiteral(route.initializer)
            ? route.initializer.text : null,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.deepEqual(callers.sort((a, b) => a.file.localeCompare(b.file)), [
    { file: "src/cloud/agent-channel.ts", route: "channel" },
    { file: "src/cloud/session-receiver.ts", route: null },
    { file: "src/listener/runtime.ts", route: "listener" },
  ]);
});

test("touch presence follows the server's minimal success contract", async () => {
  let envelope: Record<string, unknown> | null = null;
  const client = new DeliveryCommandClient({
    url: "https://cloud.example.test", anonKey: "public-test", profileId: "test-profile",
  },
    (async (_input, init) => {
      envelope = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch);
  assert.deepEqual(await client.touchPresence({
    workspaceId: WORKSPACE_ID,
    credential: TOKEN,
    commandId: "presence_touch_test",
  }), { httpStatus: 200 });
  assert.deepEqual((envelope as unknown as { command: unknown }).command, { kind: "touch_presence" });
  assert.equal((envelope as unknown as { client_build: unknown }).client_build, CLI_BUILD_VERSION);
});

async function profile(): Promise<string> {
  const directory = await mkdtemp(join(root, "profile-"));
  const credentialFile = join(directory, "credential.json");
  const profilePath = join(directory, "profile.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(credentialFile, JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: PRINCIPAL_ID,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN,
    expires_at: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  await writeFile(profilePath, JSON.stringify({
    version: 1,
    url: "https://cloud.example.test",
    anon_key: "public-test",
    workspace_id: WORKSPACE_ID,
    principal_id: PRINCIPAL_ID,
    credential_file: credentialFile,
  }), { mode: 0o600 });
  return profilePath;
}

function readResponse(body: Record<string, unknown>): Response {
  if (body.resource === "members") return new Response(JSON.stringify({
    members: [{ user_id: OWNER_ID, display_name: "Owner" }],
    agents: [{ principal_id: PRINCIPAL_ID, name: "Agent", owner_user_id: OWNER_ID }],
    identity: {
      credential_valid: true, principal_id: PRINCIPAL_ID,
      workspace_id: WORKSPACE_ID, owner_user_id: OWNER_ID,
    },
  }), { status: 200 });
  if (body.resource === "signals") return new Response(JSON.stringify({
    signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 },
  }), { status: 200 });
  throw new Error(`unexpected read: ${JSON.stringify(body)}`);
}

test("checks touch presence concurrently and throttle attempts for 60 seconds", async () => {
  const profilePath = await profile();
  let touches = 0;
  let touchStarted = false;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const command = body.command as Record<string, unknown> | undefined;
    if (command?.kind === "touch_presence") {
      touches += 1;
      touchStarted = true;
      assert.deepEqual(command, { kind: "touch_presence" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    assert.equal(touchStarted, true, "presence begins before either check read settles");
    return readResponse(body);
  };
  const first = await checkAgentMessages({ profilePath, fetcher, present: async () => {} });
  const second = await checkAgentMessages({ profilePath, fetcher, present: async () => {} });
  assert.deepEqual(second, first);
  assert.equal(touches, 1);

  const statePath = agentPresenceTouchStatePath(profilePath, PRINCIPAL_ID);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.version, 1);
  await writeFile(statePath, JSON.stringify({
    version: 1,
    last_attempt_at: Date.now() - AGENT_PRESENCE_TOUCH_INTERVAL_MS - 1,
  }), { mode: 0o600 });
  await checkAgentMessages({ profilePath, fetcher, present: async () => {} });
  assert.equal(touches, 2);

  const onboarding = await readFile(join(srcRoot, "onboarding-cli.ts"), "utf8");
  assert.match(onboarding, /runTurnHook[\s\S]*checkAgentMessages\(/,
    "the host hook uses the same presence-enabled check path");
});

test("a slow or refused presence touch cannot delay or change check output", async () => {
  for (const behavior of ["slow", "refused"] as const) {
    const profilePath = await profile();
    let touches = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const command = body.command as Record<string, unknown> | undefined;
      if (command?.kind === "touch_presence") {
        touches += 1;
        if (behavior === "refused") {
          return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
        }
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return readResponse(body);
    };
    const started = Date.now();
    const result = await checkAgentMessages({ profilePath, fetcher, present: async () => {} });
    const elapsed = Date.now() - started;
    assert.deepEqual(result.messages, []);
    assert.equal(result.has_more, false);
    assert.equal(touches, 1);
    assert.ok(elapsed < 500, `${behavior} presence delayed the check by ${elapsed}ms`);
  }
});

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const at = (age: number) => new Date(NOW - age).toISOString();
function row(overrides: Partial<AgentPresenceRow> = {}): AgentPresenceRow {
  return {
    last_command_at: at(10_000), client_build: "0.1.77",
    watcher_at: null, channel_at: null, listener_at: null, turn_at: null,
    last_ack_via: null, last_ack_at: null, current_client_build: "0.1.77",
    ...overrides,
  };
}

test("the pure presence classifier covers wake priority, ages, ACK, and client state", () => {
  for (const route of ["watcher", "channel", "listener"] as const) {
    const live = classifyAgentPresence(row({ [`${route}_at`]: at(WAKE_LEASE_STALE_MS) }), NOW);
    assert.equal(live.wake.kind, `live ${route}`);
    assert.equal(live.wake.age_ms, WAKE_LEASE_STALE_MS);
    const stale = classifyAgentPresence(row({ [`${route}_at`]: at(WAKE_LEASE_STALE_MS + 1) }), NOW);
    assert.equal(stale.wake.kind, `stale ${route}`);
  }

  const freshest = classifyAgentPresence(row({
    watcher_at: at(10_000), channel_at: at(5_000), listener_at: at(20_000), turn_at: at(1_000),
    last_ack_via: "leased", last_ack_at: at(2_000), last_command_at: at(3_000),
  }), NOW);
  assert.deepEqual(freshest.wake, {
    kind: "live channel", route: "channel", age_ms: 5_000, label: "live channel",
  });
  assert.deepEqual(freshest.last_call, { age_ms: 3_000, label: AGENT_PRESENCE_LABELS.lastCall });
  assert.deepEqual(freshest.last_ack, { route: "leased", age_ms: 2_000, label: AGENT_PRESENCE_LABELS.lastAck });
  assert.equal(freshest.client.kind, "current");

  const turn = classifyAgentPresence(row({ turn_at: at(7_000) }), NOW);
  assert.deepEqual(turn.wake, { kind: "turn", route: "turn", age_ms: 7_000, label: "turn" });
  assert.equal(classifyAgentPresence(row(), NOW).wake.kind, "none");
  assert.deepEqual(classifyAgentPresence(null, NOW), {
    wake: { kind: "none", route: null, age_ms: null, label: "none" },
    last_call: null,
    last_ack: null,
    client: { kind: "unknown", label: "unknown" },
  });

  assert.equal(classifyAgentPresence(row({ client_build: "0.1.76" }), NOW).client.kind, "update available");
  assert.equal(classifyAgentPresence(row({ client_build: null }), NOW).client.kind, "update available");
  assert.equal(classifyAgentPresence(row({ client_build: "0.1.77" }), NOW).client.kind, "current");
  assert.equal(classifyAgentPresence(row({ client_build: "0.1.78" }), NOW).client.kind, "current");
  assert.equal(classifyAgentPresence(row({ last_command_at: null, client_build: null }), NOW).client.kind, "unknown");
  assert.equal(classifyAgentPresence(row({ current_client_build: null }), NOW).client.kind, "unknown");
});
