import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { parseAgentConnection, profileTarget, readAgentProfile, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { newSessionBinding } from "../../src/cloud/session-context.js";
import { RenewalReauthorisationRequired, RenewalRevoked, RenewalSuspended, RenewalUpgradeRequiredError } from "../../src/cloud/renewal.js";
import { mapMcpError } from "../../src/mcp/server.js";
import { MCP_RESULT_MAX_BYTES, MCP_TOOLS, capMcpResult } from "../../src/mcp/tools.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = `swm_agt_${"C".repeat(43)}`;
const DENIED = ["profile", "host-session-id", "session-context", "agent-token-file", "agent-token-stdin", "url", "anon-key", "force-file-store", "workspace-id", "body-file", "body-stdin", "attach", "json", "wait", "follow", "notify", "ndjson", "hook", "force", "out"];
function assertDenySchemas(tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>) {
  for (const tool of tools) for (const bad of DENIED) for (const key of [bad, bad.replaceAll("-", "_")]) {
    assert.ok(!Object.hasOwn(tool.inputSchema.properties ?? {}, key), `${tool.name} advertised ${key}`);
  }
}

function signal(body: string, kind: string, id = ID) {
  return { id, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: AGENT,
    in_reply_to: null, about: null, kind, body, created_at: "2026-09-23T00:00:00.000Z",
    until: "2099-01-01T00:00:00.000Z", sender_owner_relation: "same_owner", channel_id: null };
}

async function fixture(incomingBody = "A teammate's full message", expiresAt = "2099-01-01T00:00:00.000Z") {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-"));
  const posts: Array<Record<string, any>> = [];
  let renewals = 0;
  const committed = new Map<string, object>();
  let readRefusal = false, sendRefusal = false, serverConflict = false, lostAttempts = 0, delayAnswer = false;
  const incoming = signal(incomingBody, "ask");
  const edge = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      const body = JSON.parse(raw);
      const send = (status: number, value: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (body.resource === "members") {
        if (readRefusal) return send(403, { error: "forbidden", message: "Read refused." });
        return send(200, { members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: AGENT, name: "Test agent", owner_user_id: OWNER }],
          identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS,
            workspace_name: "Test workspace", owner_user_id: OWNER, token_id: "SECRET-TOKEN-ID", grant_id: "SECRET-GRANT-ID" } });
      }
      if (body.resource === "signals") {
        if (readRefusal) return send(403, { error: "forbidden", message: "Read refused." });
        return send(200, { signals: body.after_id ? [] : [incoming], capabilities: { cursor_after: 1, sender_owner_relation: 1 } });
      }
      if (body.command?.kind === "renew_agent_token") {
        renewals++;
        return send(426, { error: "upgrade_required", min_client_version: "0.1.99" });
      }
      if (body.command?.kind === "post_signal") {
        posts.push(body);
        if (serverConflict) { serverConflict = false; return send(409, { error: "command_id_conflict", message: "Request ID conflicts with another command." }); }
        if (sendRefusal) return send(403, { error: "signal_refused", message: "Signal refused." });
        const previous = committed.get(body.command_id);
        const response = { status: "accepted", ok: true, event_ids: [], events: [], signal: {
          ...signal(body.command.body, body.command.signal_kind), from: AGENT, from_kind: "agent",
          in_reply_to: body.command.in_reply_to, channel_id: "SECRET-CHANNEL-ID" } };
        if (lostAttempts > 0) {
          // The write commits once, but every internal attempt loses its answer.
          if (!previous) committed.set(body.command_id, response);
          lostAttempts--;
          return send(503, { error: "temporary" });
        }
        if (previous) return send(200, previous);
        committed.set(body.command_id, response);
        if (delayAnswer) { delayAnswer = false; setTimeout(() => send(200, response), 250); return; }
        return send(200, response);
      }
      return send(400, { error: "unexpected" });
    });
  });
  await new Promise<void>(done => edge.listen(0, "127.0.0.1", done));
  const profile = join(root, "profile", "profile.json");
  await saveAgentProfile(profile, parseAgentConnection(JSON.stringify({ version: 1,
    url: `http://127.0.0.1:${(edge.address() as { port: number }).port}`, anon_key: "test-public-key",
    workspace_id: WS, principal_id: AGENT, credential: { message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted", principal_id: AGENT, token_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN,
      expires_at: expiresAt } })));
  const client = new Client({ name: "mcp-test-host", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/cli.js"), "mcp", "--profile", profile],
    env: { PATH: process.env.PATH ?? "", HOME: root, SWARM_AGENT_STATE_DIR: join(root, "renewal"),
      XDG_CONFIG_HOME: join(root, "config") }, stderr: "pipe" });
  let stderr = "";
  let stdout = "";
  transport.stderr?.on("data", chunk => stderr += chunk);
  await client.connect(transport);
  (transport as any)._process.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
  const close = async () => { await client.close(); await transport.close(); await new Promise<void>(done => edge.close(() => done())); await rm(root, { recursive: true, force: true }); };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>).find(item => item.type === "text")!;
    assert.ok(Buffer.byteLength(text.text) <= MCP_RESULT_MAX_BYTES + 128);
    assert.ok(!text.text.includes(TOKEN));
    assert.ok(!text.text.includes(profile));
    assert.ok(!text.text.includes("SECRET-GRANT-ID"));
    assert.ok(!text.text.includes("SECRET-TOKEN-ID"));
    assert.ok(!text.text.includes("cswarm check --"));
    return { result, value: JSON.parse(text.text) as Record<string, any> };
  };
  return { root, profile, posts, created: () => committed.size, renewals: () => renewals, client, transport, call, close, stderr: () => stderr, stdout: () => stdout,
    refuseReads: (value: boolean) => { readRefusal = value; }, refuseSends: (value: boolean) => { sendRefusal = value; },
    loseNextAnswer: () => { lostAttempts = 3; }, delayNextAnswer: () => { delayAnswer = true; },
    conflictNext: () => { serverConflict = true; } };
}

test("MCP stdio tool table, allow-lists, every happy path and refusal", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const listed = (await f.client.listTools()).tools;
    assert.deepEqual(listed.map(tool => tool.name), MCP_TOOLS.map(tool => tool.name));
    assertDenySchemas(listed);
    // Mutation control: adding one credential flag to an advertised schema trips the gate.
    const mutated = [{ name: listed[0].name, inputSchema: { properties: { ...listed[0].inputSchema.properties, profile: { type: "string" } } } }];
    assert.throws(() => assertDenySchemas(mutated), /advertised profile/);
    for (const tool of listed) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      for (const bad of DENIED) {
        for (const key of [bad, bad.replaceAll("-", "_")]) {
          const base = tool.name === "reply" ? { signal_id: ID, body: "answer", request_id: "request01" }
            : ["ask", "note", "working_on"].includes(tool.name) ? { body: "hello", request_id: "request01" } : {};
          await assert.rejects(f.client.callTool({ name: tool.name, arguments: { ...base, [key]: "forbidden" } }), (error: any) => error.code === -32602);
        }
      }
    }
    assert.deepEqual((await f.call("whoami")).value, { principal_id: AGENT, name: "Test agent", workspace_id: WS, workspace_name: "Test workspace" });
    const members = (await f.call("members")).value;
    assert.deepEqual(members.agents, [{ principal_id: AGENT, name: "Test agent" }]);
    assert.equal(members.members[0].name, "Owner");
    const check = (await f.call("check")).value;
    assert.equal(check.messages[0].body, "A teammate's full message");
    assert.equal(check.next_action, null);
    assert.equal((await f.call("check", { message_id: ID })).value.messages[0].body, "A teammate's full message");
    assert.equal((await f.call("check", { message_id: ID.toUpperCase() })).value.messages[0].body, "A teammate's full message");
    for (const [name, args] of Object.entries({ ask: { body: "question", to: "Owner", request_id: "request02" },
      note: { body: "note", request_id: "request03" }, reply: { signal_id: ID, body: "answer", request_id: "request04" },
      working_on: { body: "work", request_id: "request05" } })) {
      const result = (await f.call(name, args)).value;
      assert.deepEqual(Object.keys(result), ["signal_id", "kind", "created_at", "in_reply_to", "channel_id", "replayed"]);
      assert.equal(result.replayed, false);
    }
    assert.equal(f.posts.length, 4);
    assert.equal(f.posts[0].command.to_user_id, OWNER);
    assert.equal(f.posts[2].command.in_reply_to, ID);
    f.refuseReads(true);
    for (const name of ["whoami", "members", "check"]) assert.equal((await f.call(name)).result.isError, true);
    f.refuseReads(false); f.refuseSends(true);
    for (const name of ["ask", "note", "reply", "working_on"]) {
      const args = name === "reply" ? { signal_id: ID, body: "answer", request_id: `deny_${name}` }
        : { body: "hello", request_id: `deny_${name}` };
      const { result, value } = await f.call(name, args);
      assert.equal(result.isError, true); assert.equal(value.code, "signal_refused");
      assert.equal(value.status, 403); assert.equal(value.message, "Signal refused.");
    }
    assert.equal(f.stderr(), "");
    const rawLines = f.stdout().trim().split("\n");
    assert.ok(rawLines.length > 7);
    for (const line of rawLines) {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      assert.ok(Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
    }
    // Mutation control: one printable table-handler line must break stdout purity.
    assert.throws(() => [...rawLines, "Signal shared."].forEach(line => JSON.parse(line)), SyntaxError);
  } finally { await f.close(); }
});

test("MCP managed principal requires the current host session and renewal errors stay typed", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const profile = await readAgentProfile(f.profile);
    const context = newSessionBinding({ target: profileTarget(profile), workspaceId: WS,
      principalId: AGENT, provider: "codex", mode: "interactive", hostSessionId: "current-host",
      tokenFile: profile.credential_file });
    const path = join(f.root, "config", "cswarm", "sessions", WS, AGENT, `${context.session_id}.json`);
    await mkdir(join(f.root, "config", "cswarm", "sessions", WS, AGENT), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ ...context, generation: 1 }), { mode: 0o600 });
    const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp", "--profile", f.profile], {
      env: { PATH: process.env.PATH ?? "", HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    child.stderr.on("data", chunk => stderr += chunk);
    child.stdout.on("data", chunk => stdout += chunk);
    const exit = await new Promise<number>((done, fail) => { child.once("error", fail); child.once("close", code => done(code ?? 1)); });
    assert.equal(exit, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /host_session_required/);
    for (const [error, code] of [
      [new RenewalReauthorisationRequired("horizon_reached", AGENT, "Ask the owner to authorise again."), "horizon_reached"],
      [new RenewalRevoked("renewal_revoked", "Credential revoked."), "renewal_revoked"],
      [new RenewalSuspended("renewal_suspended", "Renewal suspended."), "renewal_suspended"],
      [new RenewalUpgradeRequiredError("0.1.99"), "upgrade_required"],
    ] as const) {
      const mapped = mapMcpError(error, f.profile);
      assert.equal(mapped.code, code);
      assert.equal(mapped.message, error.message);
      assert.ok(mapped.next_step);
      if (error instanceof RenewalUpgradeRequiredError) assert.equal(mapped.status, 426);
    }
  } finally { await f.close(); }
});

test("MCP one-shot renewal refusal maps 426 and leaves the process serving", { timeout: 15_000 }, async () => {
  const f = await fixture(undefined, "2020-01-01T00:00:00.000Z");
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { result, value } = await f.call("whoami");
      assert.equal(result.isError, true);
      assert.equal(value.code, "upgrade_required");
      assert.equal(value.status, 426);
      assert.match(value.message, /Update cswarm/);
      assert.equal(f.renewals(), attempt, "one exchange per tool call");
    }
  } finally { await f.close(); }
});

test("MCP request IDs replay and an ambiguous send reports unknown", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const args = { body: "one intent", request_id: "sameid01" };
    assert.equal((await f.call("note", args)).value.replayed, false);
    assert.equal((await f.call("note", args)).value.replayed, true);
    assert.equal(new Set(f.posts.map(row => row.command_id)).size, 1);
    f.loseNextAnswer();
    const unknown = (await f.call("note", { body: "second intent", request_id: "sameid02" })).value;
    assert.deepEqual(unknown, { outcome: "unknown", retry_with_same_request_id: true });
    assert.equal(f.created(), 2, "the lost answer followed one committed signal");
    assert.equal((await f.call("note", { body: "second intent", request_id: "sameid02" })).value.replayed, true);
    assert.equal(f.created(), 2, "the retry replays the committed signal");
    const conflict = await f.call("note", { body: "changed", request_id: "sameid01" });
    assert.equal(conflict.result.isError, true);
    assert.equal(conflict.value.code, "command_id_conflict");
    f.conflictNext();
    const before = f.posts.length;
    const serverConflict = await f.call("note", { body: "server conflict", request_id: "sameid03" });
    assert.equal(serverConflict.result.isError, true);
    assert.equal(serverConflict.value.status, 409);
    assert.equal(serverConflict.value.code, "command_id_conflict");
    assert.equal(f.posts.length, before + 1, "a 409 must not mint another command ID");
  } finally { await f.close(); }
});

test("MCP check preview has a cached full-text tool and advances after the response", { timeout: 15_000 }, async () => {
  const fullBody = "Message " + "x".repeat(1_200);
  const f = await fixture(fullBody);
  try {
    const first = (await f.call("check")).value;
    assert.equal(first.messages[0].truncated, true);
    assert.deepEqual(first.messages[0].full_text_tool, { name: "check", arguments: { message_id: ID } });
    assert.equal(first.messages[0].body.length, 1_000);
    assert.equal((await f.call("check", { message_id: ID })).value.messages[0].body, fullBody);
    assert.deepEqual((await f.call("check")).value.messages, []);
    assert.deepEqual(capMcpResult({ body: "x".repeat(MCP_RESULT_MAX_BYTES) }), {
      truncated: true, message: "Result exceeds the MCP byte cap. Narrow the request or use the CLI outside the model session." });
  } finally { await f.close(); }
});

test("MCP cancellation after a send starts puts unknown on the stdio wire", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    f.delayNextAnswer();
    const abort = new AbortController();
    const call = f.client.callTool({ name: "note", arguments: { body: "cancelled intent", request_id: "cancel01" } }, undefined, { signal: abort.signal });
    const until = Date.now() + 5_000;
    while (f.posts.length === 0 && Date.now() < until) await new Promise(done => setTimeout(done, 5));
    assert.equal(f.posts.length, 1);
    abort.abort();
    await assert.rejects(call);
    await new Promise(done => setTimeout(done, 300));
    const messages = f.stdout().trim().split("\n").map(line => JSON.parse(line));
    assert.ok(messages.some(row => row.result?.content?.some((item: any) => item.text === '{"outcome":"unknown","retry_with_same_request_id":true}')));
    assert.equal(new Set(f.posts.map(row => row.command_id)).size, 1);
  } finally { await f.close(); }
});
