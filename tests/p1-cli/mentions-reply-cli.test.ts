/** cswarm note, ask and reply against a server that answers the way the read and command functions
 * do: @Name and --mention become `mentions` on public posts, and a reply goes in the thread of a
 * message everyone in its channel can read and privately otherwise. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const WORKSPACE = "3ab184b3-fbb4-4ee9-afad-3842a604439a";
const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WREN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DANA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TWIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const DIRECT = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const OWN = "66666666-6666-4666-8666-666666666666";
const BY_GONE = "77777777-7777-4777-8777-777777777777";
const BY_WREN = "88888888-8888-4888-8888-888888888888";
const GONE = "99999999-9999-4999-8999-999999999999";
const TOKEN = `swm_agt_${"c".repeat(43)}`;

const scratch = mkdtempSync(join(tmpdir(), "cswarm-mentions-"));
chmodSync(scratch, 0o700);
const tokenPath = join(scratch, "agent.json");
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
after(() => rmSync(scratch, { recursive: true, force: true }));

function row(id: string, fields: Record<string, unknown> = {}) {
  return {
    id, workspace_id: WORKSPACE, from: DANA, from_kind: "user", to: null, to_agent: null, in_reply_to: null,
    reply_status: null, about: null, kind: "note", body: "x", attachments: [], until: "2099-01-01T00:00:00.000Z",
    created_at: "2026-11-16T00:00:00.000Z", chain_hop: 0, channel_id: null, thread_root_id: null,
    broadcast_to_channel: false, recipients: [], audience: "workspace", sender_owner_relation: "cross_owner", ...fields,
  };
}

const MESSAGES = new Map([
  [ROOT, row(ROOT)],
  [CHILD, row(CHILD, { thread_root_id: ROOT })],
  [DIRECT, row(DIRECT, { to_agent: SELF, recipients: [{ kind: "agent", id: SELF }], audience: "private" })],
  [OWN, row(OWN, { from: SELF, from_kind: "agent" })],
  [BY_GONE, row(BY_GONE, { from: GONE, from_kind: "agent" })],
  [BY_WREN, row(BY_WREN, { from: WREN, from_kind: "agent" })],
]);

async function cloud(options: { twins?: boolean; legacyRead?: boolean } = {}) {
  const posts: Record<string, unknown>[] = [];
  const reads: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/functions/v1/read") {
        reads.push(body);
        if (body.resource === "members") {
          return reply(200, {
            members: [{ user_id: DANA, display_name: "Dana" }, ...(options.twins ? [{ user_id: TWIN, display_name: "Wren" }] : [])],
            agents: [{ principal_id: SELF, name: "Self" }, { principal_id: WREN, name: "Wren" }],
            identity: { credential_valid: true, principal_id: SELF, workspace_id: WORKSPACE, workspace_name: "Test", owner_user_id: DANA },
          });
        }
        if (body.resource === "signals" && Object.hasOwn(body, "signal_id")) {
          if (options.legacyRead) return reply(400, { error: "invalid_request" });
          const found = MESSAGES.get(body.signal_id);
          return reply(200, { signals: found ? [found] : [], capabilities: {} });
        }
        return reply(200, { signals: [], capabilities: {} });
      }
      if (request.url === "/functions/v1/command" && body.command?.kind === "post_signal") {
        posts.push(body.command);
        const command = body.command;
        if (command.in_reply_to === HIDDEN) return reply(403, { error: "forbidden" });
        const mentioned = (command.mentions ?? []) as Array<{ kind: string; id: string }>;
        // A mention of an agent no longer live: the bare 403. Agents in BY_WREN's thread: the hop limit.
        if (mentioned.some((m) => m.id === GONE)) return reply(403, { error: "forbidden" });
        if (command.thread_root_id === BY_WREN && mentioned.some((m) => m.kind === "agent")) {
          return reply(409, { error: "mention_hop_limit", message: "Agents have exchanged 6 messages in a row in this thread." });
        }
        return reply(200, { status: "accepted", ok: true, event_ids: [], signal: row("55555555-5555-4555-8555-555555555555", {
          from: SELF, from_kind: "agent", body: command.body, kind: command.signal_kind,
          in_reply_to: command.in_reply_to, thread_root_id: command.thread_root_id ?? null,
          to: null, to_agent: null, audience: command.in_reply_to ? "private" : "workspace",
        }) });
      }
      reply(400, { error: "invalid_request" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, posts, reads,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function cli(url: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args,
    "--url", url, "--anon-key", "test-anon", "--workspace-id", WORKSPACE, "--agent-token-file", tokenPath], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_STATE_HOME: join(scratch, "state"),
      SWARM_AGENT_STATE_DIR: join(scratch, "agent-state"), SWARM_CLOUD_URL: "", SWARM_CLOUD_ANON_KEY: "", SWARM_CLOUD_WORKSPACE_ID: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? -1)));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test("note and ask send the body's @Name tags and each --mention as mentions, deduplicated in order", async () => {
  const fake = await cloud();
  try {
    let result = await cli(fake.url, ["note", "@Wren and @dana, see this", "--mention", "Dana", "--mention", WREN, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.posts.at(-1)!.mentions, [{ kind: "agent", id: WREN }, { kind: "user", id: DANA }]);
    assert.deepEqual(JSON.parse(result.stdout).mentions, [{ kind: "agent", id: WREN }, { kind: "user", id: DANA }]);
    result = await cli(fake.url, ["ask", "can you look, @Wren?", "--channel", "ops"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.posts.at(-1)!.mentions, [{ kind: "agent", id: WREN }]);
    assert.equal(fake.posts.at(-1)!.parent_signal_id, undefined, "a mentioned ask carries no ask-chain parent");
    assert.match(result.stdout, /Mentioned: Wren\./);
    // No tag that names anyone: no mentions key and no roster read.
    const readsBefore = fake.reads.length;
    result = await cli(fake.url, ["note", "write to me@wren.example", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(Object.hasOwn(fake.posts.at(-1)!, "mentions"), false);
    assert.equal(fake.reads.filter((read) => read.resource === "members").length,
      fake.reads.slice(0, readsBefore).filter((read) => read.resource === "members").length);
    result = await cli(fake.url, ["note", "@nobody here", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(Object.hasOwn(fake.posts.at(-1)!, "mentions"), false);
  } finally { await fake.close(); }
});

test("an ambiguous tag, an unknown --mention, or --mention with --to is refused before sending", async () => {
  const fake = await cloud({ twins: true });
  try {
    let result = await cli(fake.url, ["note", "@Wren look"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /"@Wren" names more than one person or agent here, so it mentions nobody\. Mention one of them by id:/);
    assert.ok(result.stderr.includes(`agent ${WREN}`) && result.stderr.includes(`user ${TWIN}`), result.stderr);
    result = await cli(fake.url, ["note", "look", "--mention", "Nobody"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /"Nobody" is not the name of a member or agent/);
    result = await cli(fake.url, ["note", "look", "--to", "Dana", "--mention", "Dana"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--mention goes on a message everyone in the channel can read/);
    assert.equal(fake.posts.length, 0);
  } finally { await fake.close(); }
});

test("reply lands in the thread of a channel message and privately on an addressed one", async () => {
  const fake = await cloud();
  try {
    let result = await cli(fake.url, ["reply", ROOT, "on it @Wren", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.posts.at(-1), { kind: "post_signal", signal_kind: "note", body: "on it @Wren",
      to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null, thread_root_id: ROOT,
      mentions: [{ kind: "user", id: DANA }, { kind: "agent", id: WREN }] }, "the author it answers comes first");
    assert.equal(JSON.parse(result.stdout).placement, "thread");
    assert.deepEqual(fake.reads.find((read) => read.signal_id === ROOT), { resource: "signals", workspace_id: WORKSPACE,
      inbox: false, about: null, kind: null, in_reply_to: null, since: null, limit: 1, include_stale: true, signal_id: ROOT });

    result = await cli(fake.url, ["reply", CHILD, "same thread", "--thread", "--broadcast-to-channel", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.posts.at(-1)!.thread_root_id, ROOT, "a reply to a message inside a thread roots on the thread");
    assert.deepEqual(fake.posts.at(-1)!.mentions, [{ kind: "user", id: DANA }], "and notifies that message's author");
    assert.equal(fake.posts.at(-1)!.broadcast_to_channel, true);

    result = await cli(fake.url, ["reply", ROOT, "just you", "--private", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.posts.at(-1)!.in_reply_to, ROOT);
    assert.equal(fake.posts.at(-1)!.reply_status, "answered");
    assert.equal(Object.hasOwn(fake.posts.at(-1)!, "thread_root_id"), false);

    result = await cli(fake.url, ["reply", DIRECT, "answer @Wren", "--thread", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.posts.at(-1)!.in_reply_to, DIRECT);
    assert.equal(Object.hasOwn(fake.posts.at(-1)!, "mentions"), false, "a private reply mentions nobody");
    assert.match(JSON.parse(result.stdout).advisory, /addressed, so it has no thread/);
    result = await cli(fake.url, ["reply", DIRECT, "answer", "--thread"]);
    assert.match(result.stdout, /addressed, so it has no thread/);

    const sent = fake.posts.length;
    result = await cli(fake.url, ["reply", DIRECT, "answer", "--broadcast-to-channel"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--broadcast-to-channel sends a thread reply to its channel, and that message was addressed/);
    result = await cli(fake.url, ["reply", ROOT, "answer", "--private", "--thread"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--private replies privately to the author, so it can't be combined/);
    result = await cli(fake.url, ["reply", DIRECT, "answer", "--mention", "Wren"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /addressed, so the reply goes privately/);
    assert.equal(fake.posts.length, sent);

    // A message the caller can't read is refused the way it always was: a private reply and its 403 hint.
    result = await cli(fake.url, ["reply", HIDDEN, "answer"]);
    assert.notEqual(result.code, 0);
    assert.equal(fake.posts.at(-1)!.in_reply_to, HIDDEN);
    assert.match(result.stderr, /reply was refused \(403\)/);
  } finally { await fake.close(); }
});

test("a deployment that can't look a message up by id keeps the flags in charge", async () => {
  const fake = await cloud({ legacyRead: true });
  try {
    let result = await cli(fake.url, ["reply", ROOT, "answer", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.posts.at(-1)!.in_reply_to, ROOT);
    result = await cli(fake.url, ["reply", ROOT, "answer", "--thread", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.posts.at(-1)!.thread_root_id, ROOT);
  } finally { await fake.close(); }
});

test("a thread reply notifies its author, never itself, and still lands when that mention is refused", async () => {
  const fake = await cloud();
  try {
    let result = await cli(fake.url, ["reply", ROOT, "noted @Dana", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.posts.at(-1)!.mentions, [{ kind: "user", id: DANA }], "the author named explicitly is mentioned once");

    result = await cli(fake.url, ["reply", OWN, "following up on my own post", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.posts.at(-1)!.thread_root_id, OWN);
    assert.equal(Object.hasOwn(fake.posts.at(-1)!, "mentions"), false, "no self-mention");

    // The author is no longer live: the edge answers a bare 403, and the reply is sent without the mention.
    const before = fake.posts.length;
    result = await cli(fake.url, ["reply", BY_GONE, "done", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.posts.slice(before).map((post) => post.mentions ?? null), [[{ kind: "agent", id: GONE }], null]);
    assert.match(JSON.parse(result.stdout).author_not_notified, /could not be mentioned/);

    // The thread's agent hop limit: the same, keeping a person who was named explicitly.
    const hop = fake.posts.length;
    result = await cli(fake.url, ["reply", BY_WREN, "done @Dana"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.posts.slice(hop).map((post) => post.mentions),
      [[{ kind: "agent", id: WREN }, { kind: "user", id: DANA }], [{ kind: "user", id: DANA }]]);
    assert.match(result.stdout, /without notifying its author/);

    // Named explicitly, the agent's refusal is the reply's refusal: nothing is dropped.
    const explicit = fake.posts.length;
    result = await cli(fake.url, ["reply", BY_WREN, "done @Wren"]);
    assert.notEqual(result.code, 0);
    assert.equal(fake.posts.length, explicit + 1);
  } finally { await fake.close(); }
});

test("--channel general posts unfiled and reads only unfiled messages, in any case", async () => {
  const fake = await cloud();
  try {
    for (const [verb, value] of [["note", "general"], ["ask", "General"], ["working-on", "GENERAL"]] as const) {
      const result = await cli(fake.url, [verb, `to general ${verb}`, "--channel", value, "--json"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(Object.hasOwn(fake.posts.at(-1)!, "channel"), false, `${verb} --channel ${value} is unfiled`);
    }
    const named = await cli(fake.url, ["note", "to ops", "--channel", "ops", "--json"]);
    assert.equal(named.code, 0, named.stderr);
    assert.equal(fake.posts.at(-1)!.channel, "ops");
    for (const verb of ["feed", "inbox"]) {
      const result = await cli(fake.url, [verb, "--channel", "General", "--json"]);
      assert.equal(result.code, 0, result.stderr);
      const read = fake.reads.filter((body) => body.resource === "signals").at(-1)!;
      assert.equal(read.channel, "general", `${verb} asks the read edge for unfiled messages`);
      assert.equal(read.inbox, verb === "inbox");
    }
    const reserved = await cli(fake.url, ["note", "x", "--channel", "all-signals"]);
    assert.notEqual(reserved.code, 0);
    assert.match(reserved.stderr, /all-signals is reserved/);
  } finally { await fake.close(); }
});
