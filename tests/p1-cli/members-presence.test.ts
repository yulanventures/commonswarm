import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  agentPresenceFromMembersPayload,
  readWorkspaceAgentPresence,
} from "../../src/cloud/workspaces.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const;
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const HOSTILE_BUILD = `0.1.77\n\u001b[31mforged\u202e`;

const at = (now: number, ageMs: number): string =>
  new Date(now - ageMs).toISOString();

function presenceRows(now: number) {
  const base = {
    workspace_id: WORKSPACE,
    last_command_at: at(now, 12 * 60_000),
    client_build: "0.1.77",
    watcher_at: null,
    channel_at: null,
    listener_at: null,
    turn_at: null,
    last_ack_via: null,
    last_ack_at: null,
    current_client_build: "0.1.77",
  };
  return [
    { ...base, principal_id: AGENTS[0], watcher_at: at(now, 60_000) },
    {
      ...base,
      principal_id: AGENTS[1],
      channel_at: at(now, 4 * 60_000),
      client_build: "0.1.76",
    },
    {
      ...base,
      principal_id: AGENTS[2],
      turn_at: at(now, 2 * 60 * 60_000),
      current_client_build: null,
    },
    { ...base, principal_id: AGENTS[3], client_build: HOSTILE_BUILD },
  ];
}

async function runMembers(
  server: Server,
  json = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "members",
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--anon-key",
    "fixture-anon",
    "--workspace-id",
    WORKSPACE,
    "--agent-token-stdin",
    ...(json ? ["--json"] : []),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${TOKEN}\n`);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function cloudServer(options: { emptyAgents?: boolean; missingPresence?: boolean } = {}) {
  let presenceReads = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => raw += chunk);
    request.on("end", () => {
      if (request.url?.startsWith("/rest/v1/agent_presence")) {
        presenceReads += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "PGRST301" }));
        return;
      }
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      if (body.resource === "members") {
        const presence = new Map(
          presenceRows(Date.now()).map((row) => [row.principal_id, row]),
        );
        response.end(JSON.stringify({
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: (options.emptyAgents ? [] : AGENTS).map((principal_id, index) => ({
            principal_id,
            name: `Agent ${index + 1}`,
            owner_user_id: OWNER,
            ...(options.missingPresence ? {} : presence.get(principal_id)),
          })),
          identity: {
            credential_valid: true,
            principal_id: AGENTS[0],
            workspace_id: WORKSPACE,
            owner_user_id: OWNER,
          },
        }));
        return;
      }
      if (body.resource === "pending_access") {
        response.end(JSON.stringify({ pending: [] }));
        return;
      }
      response.writeHead(500).end(JSON.stringify({ error: "unexpected fixture request" }));
    });
  });
  return { server, presenceReads: () => presenceReads };
}

test("the workspace presence read is one member-scoped query", async () => {
  let requests = 0;
  const rows = presenceRows(Date.now());
  const result = await readWorkspaceAgentPresence(
    { url: "https://cloud.example.test", anonKey: "anon", profileId: "fixture" },
    "bearer",
    WORKSPACE,
    (async (input, init) => {
      requests += 1;
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/v1/agent_presence");
      assert.equal(url.searchParams.get("workspace_id"), `eq.${WORKSPACE}`);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer bearer");
      assert.equal(new Headers(init?.headers).get("accept-profile"), "swarm_read");
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as typeof fetch,
  );
  assert.equal(requests, 1);
  assert.equal(result.available, true);
  assert.equal(result.rows.length, 4);

  const missingRelation = await readWorkspaceAgentPresence(
    { url: "https://cloud.example.test", anonKey: "anon", profileId: "fixture" },
    "bearer",
    WORKSPACE,
    (async () => new Response(JSON.stringify({ code: "42P01" }), { status: 400 })) as typeof fetch,
  );
  assert.deepEqual(missingRelation, { available: false, rows: [] });
});

test("an empty agent projection means presence is available", () => {
  assert.deepEqual(
    agentPresenceFromMembersPayload({
      members: [{ user_id: OWNER, display_name: "Owner" }],
      agents: [],
    }),
    { available: true, rows: [] },
  );
  assert.deepEqual(
    agentPresenceFromMembersPayload({
      members: [{ user_id: OWNER, display_name: "Owner" }],
    }),
    { available: false, rows: [] },
    "only an omitted projection means the old server lacks presence",
  );
});

test("members does not report a missing presence view for an empty agent roster", async () => {
  const fixture = cloudServer({ emptyAgents: true });
  await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    const text = await runMembers(fixture.server);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Agents:\n- none yet/);
    assert.doesNotMatch(text.stdout, /presence: not available on this server/);

    const jsonResult = await runMembers(fixture.server, true);
    assert.equal(jsonResult.code, 0, jsonResult.stderr);
    const payload = JSON.parse(jsonResult.stdout) as {
      agents: unknown[];
      presence_error?: string;
    };
    assert.deepEqual(payload.agents, []);
    assert.equal(payload.presence_error, undefined);
  } finally {
    await closeServer(fixture.server);
  }
});

test("members text and JSON show every wake kind, client state, and escaped build", async () => {
  const fixture = cloudServer();
  await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    const text = await runMembers(fixture.server);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /presence: live watcher · last call: 12m ago · client build: 0\.1\.77/);
    assert.match(text.stdout, /presence: stale channel .*client build: 0\.1\.76 · update available/);
    assert.match(text.stdout, /presence: turn, last 2h ago/);
    assert.match(text.stdout, /presence: none/);
    assert.match(text.stdout, /client build: 0\.1\.77\\n\\u001b\[31mforged\\u202e · unknown/);
    assert.doesNotMatch(text.stdout, /\u001b|\u202e/);

    const jsonResult = await runMembers(fixture.server, true);
    assert.equal(jsonResult.code, 0, jsonResult.stderr);
    assert.doesNotMatch(jsonResult.stdout, /\u001b|\u202e/);
    const payload = JSON.parse(jsonResult.stdout) as {
      agents: Array<{ presence: Record<string, unknown> }>;
    };
    assert.deepEqual(
      payload.agents.map((agent) => (agent.presence.wake as { kind: string }).kind),
      ["live watcher", "stale channel", "turn", "none"],
    );
    assert.equal(
      (payload.agents[1]!.presence.client as { kind: string }).kind,
      "update available",
    );
    assert.equal(
      (payload.agents[3]!.presence.client as { kind: string }).kind,
      "unknown",
    );
    assert.equal(payload.agents[3]!.presence.client_build, "0.1.77\\n\\u001b[31mforged\\u202e");
    assert.equal(
      fixture.presenceReads(),
      0,
      "an agent command uses the authenticated members response, not PostgREST",
    );
  } finally {
    await closeServer(fixture.server);
  }
});

test("members keeps the roster on an old server and reports presence once", async () => {
  const fixture = cloudServer({ missingPresence: true });
  await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    const text = await runMembers(fixture.server);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Agent 1/);
    assert.equal(
      text.stdout.match(/presence: not available on this server/g)?.length,
      1,
    );
    const jsonResult = await runMembers(fixture.server, true);
    assert.equal(jsonResult.code, 0, jsonResult.stderr);
    const payload = JSON.parse(jsonResult.stdout) as {
      presence_error: string;
      agents: Array<{ presence: unknown }>;
    };
    assert.equal(payload.presence_error, "not available on this server");
    assert.ok(payload.agents.every((agent) => agent.presence === null));
    assert.equal(
      fixture.presenceReads(),
      0,
      "an old read edge remains compatible without probing PostgREST",
    );
  } finally {
    await closeServer(fixture.server);
  }
});
