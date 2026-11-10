/**
 * Claude Code channel as the default push path (owner request, Nov 10): the stdio round trip the brief names.
 * One channel event per message addressed to this seat, a restart that never re-sends a confirmed message,
 * a delivery for another seat that is never emitted, and pictures readable through the channel's file tool.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { saveAgentProfile, parseAgentConnection } from "../../src/cloud/agent-profile.js";
import { configureAgentReceive, readReceiveBinding, receiveHookEvent } from "../../src/cloud/agent-receive.js";
import { CHANNEL_FILE_TOOL, CHANNEL_RECEIPT_TOOL } from "../../src/cloud/agent-channel.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_AGENT = "abababab-abab-4bab-8bab-abababababab";
const FIRST = "11111111-aaaa-4aaa-8aaa-111111111111";
const SECOND = "22222222-aaaa-4aaa-8aaa-222222222222";
const FILE = "33333333-aaaa-4aaa-8aaa-333333333333";
const TOKEN = `swm_agt_${"C".repeat(43)}`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const CLI = process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js");

async function eventually(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const caller = new Error().stack?.split("\n")[2]?.trim() ?? "unknown caller";
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  assert.fail(`condition did not become true within ${timeout} ms (${caller})`);
}

const message = (id: string, toAgent: string, body: string) => ({
  id, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: toAgent, in_reply_to: null, about: null, kind: "note", body,
  created_at: new Date().toISOString(), until: new Date(Date.now() + 300_000).toISOString(),
});

/** A fake edge whose inbox is a queue: a claim returns the head until it is acked. */
async function fixture(queue: Array<Record<string, unknown>>) {
  const root = await mkdtemp(join(tmpdir(), "cswarm-channel-default-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const profile = join(root, "agent", "profile.json");
  const acks: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => {
      if (req.method === "GET" && (req.url ?? "").startsWith("/storage/v1/object/sign/")) {
        res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG));
        return;
      }
      const body = JSON.parse(raw);
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      let result: unknown;
      if (body.resource === "members") result = {
        members: [{ user_id: OWNER, display_name: "Owner" }],
        agents: [{ principal_id: AGENT, name: "Channel", owner_user_id: OWNER }],
        identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: OWNER },
      };
      else if (body.command?.kind === "claim_agent_inbox") {
        const head = queue[0];
        result = { ok: true, status: "accepted", event_ids: [], events: [],
          capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
          deliveries: head ? [{ signal: head, lease_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", leased_until: new Date(Date.now() + 60_000).toISOString(), sender_owner_relation: "same_owner" }] : [],
          pending_delivery_count: queue.length, terminal_delivery_failure_count: 0 };
      } else if (body.command?.kind === "ack_agent_delivery") {
        acks.push(body.command.signal_id);
        if (queue[0]?.id === body.command.signal_id) queue.shift();
        result = { ok: true, status: "accepted", event_ids: [], events: [], signal_id: body.command.signal_id, outcome: "observed" };
      } else if (body.command?.kind === "file_download_url") {
        result = { file_id: body.command.file_id, version_n: 1, name: "shot.png", size_bytes: PNG.length, content_type: "image/png",
          download_path: `/storage/v1/object/sign/swarm-files/${WS}/${body.command.file_id}/1?token=SECRET-DOWNLOAD-TOKEN`,
          download_url_expires_in_seconds: 300, content_warning: "untrusted" };
      } else { res.writeHead(400).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  await saveAgentProfile(profile, parseAgentConnection(JSON.stringify({
    version: 1, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, anon_key: "fixture-key", workspace_id: WS, principal_id: AGENT,
    credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT, token_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" },
  })));
  // The default: no preview flag is needed for Claude wake.
  const configured = await configureAgentReceive({ profilePath: profile, mode: "wake", provider: "claude", hostSessionId: "host-session", cwd,
    execution: { command: process.execPath, args: [CLI] } });
  const clients: Client[] = [];
  const start = async () => {
    const client = new Client({ name: "test-host-no-model", version: "1" });
    clients.push(client);
    const events: Array<{ content: string; meta: Record<string, string> }> = [];
    client.fallbackNotificationHandler = async n => {
      if (n.method === "notifications/claude/channel") events.push(n.params as { content: string; meta: Record<string, string> });
    };
    let stderr = "";
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "receive", "serve", "--profile", profile, "--host-session-id", "host-session"],
      env: { PATH: process.env.PATH ?? "", HOME: root, SWARM_AGENT_STATE_DIR: join(root, "renewal"), XDG_CONFIG_HOME: join(root, "config") }, stderr: "pipe" });
    transport.stderr?.on("data", chunk => stderr += chunk);
    await client.connect(transport);
    // A real Claude session's turn hook verifies the session after the channel starts; nothing is claimed before that.
    await delay(200);
    await receiveHookEvent(profile, "host-session", { session_id: "host-session", cwd, hook_event_name: "UserPromptSubmit" });
    return { client, events, transport, stderr: () => stderr };
  };
  const channelConfig = (await readReceiveBinding(profile, "host-session"))?.channel_config ?? null;
  return { configured, channelConfig, acks, start, closeAll: async () => { for (const c of clients) await c.close().catch(() => undefined); }, close: () => new Promise<void>(done => server.close(() => done())) };
}

test("each message addressed to this seat arrives as one event; a restart never re-sends a confirmed one", { timeout: 40_000 }, async () => {
  const f = await fixture([message(FIRST, AGENT, "first"), message(SECOND, AGENT, "second")]);
  try {
    const config = JSON.parse(await readFile(String(f.channelConfig), "utf8"));
    assert.deepEqual(config.mcpServers.cswarm.env, { MCP_PROTOCOL_NEGOTIATION: "legacy" });
    assert.match(String(f.configured.start_command), /--dangerously-load-development-channels server:cswarm/u);

    const one = await f.start();
    await eventually(() => one.events.length === 1);
    const first = one.events[0]!;
    assert.equal(first.meta.message_id, FIRST);
    assert.equal(first.meta.signal_id, FIRST);
    assert.equal(first.meta.workspace_id, WS);
    assert.match(first.content, /<teammate-message>\nfirst\n<\/teammate-message>/u);
    assert.equal(JSON.stringify(first.meta).includes(TOKEN), false, "no credential in meta");
    await delay(500);
    assert.equal(one.events.length, 1, "one pending message at a time, not re-sent while unconfirmed");
    await one.client.callTool({ name: CHANNEL_RECEIPT_TOOL, arguments: { signal_id: FIRST, receipt: first.meta.receipt, host_session_id: "host-session" } });
    await eventually(() => one.events.length === 2);
    assert.equal(one.events[1]!.meta.message_id, SECOND);
    assert.deepEqual(f.acks, [FIRST]);
    await one.client.close();

    // Restart before the second is confirmed: it comes back once; the confirmed first never does.
    const two = await f.start();
    await eventually(() => two.events.length === 1);
    assert.equal(two.events[0]!.meta.message_id, SECOND);
    await two.client.callTool({ name: CHANNEL_RECEIPT_TOOL, arguments: { signal_id: SECOND, receipt: two.events[0]!.meta.receipt, host_session_id: "host-session" } });
    await eventually(() => f.acks.length === 2);
    await delay(500);
    assert.deepEqual(two.events.map(e => e.meta.message_id), [SECOND]);
    assert.deepEqual(f.acks, [FIRST, SECOND]);
    await two.client.close();
  } finally { await f.closeAll(); await f.close(); }
});

test("a delivery addressed to another seat is never emitted", { timeout: 30_000 }, async () => {
  const f = await fixture([message(FIRST, OTHER_AGENT, "for someone else")]);
  try {
    const run = await f.start();
    const closed = new Promise<void>(done => { run.transport.onclose = () => done(); });
    await Promise.race([closed, delay(8_000)]);
    assert.equal(run.events.length, 0);
    assert.deepEqual(f.acks, []);
    await run.client.close().catch(() => undefined);
  } finally { await f.closeAll(); await f.close(); }
});

test("the channel's file tool returns an attached picture as an image block, never the signed path", { timeout: 30_000 }, async () => {
  const f = await fixture([]);
  try {
    const run = await f.start();
    const read = await run.client.callTool({ name: CHANNEL_FILE_TOOL, arguments: { file_id: FILE } }) as unknown as { content: Array<Record<string, string>>; isError?: boolean };
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.deepEqual(read.content[1], { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
    assert.equal(JSON.stringify(read).includes("SECRET-DOWNLOAD-TOKEN"), false);
    const invalid = await run.client.callTool({ name: CHANNEL_FILE_TOOL, arguments: { file_id: "not-a-uuid" } });
    assert.equal(invalid.isError, true);
    await run.client.close();
  } finally { await f.closeAll(); await f.close(); }
});
