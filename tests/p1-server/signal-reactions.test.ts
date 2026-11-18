/**
 * Reactions against the served command and read functions and real Postgres: who may react (who may
 * read), idempotent add and remove, the per-reactor bound, the agent read's grouped reactions, and
 * which Realtime topics hear about a change.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { parseSignalRecord, signalAddressesAgent } from "../../src/cloud/signals.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { principal: string; token: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let owner: Person;
let other: Person;
let device: string;
let agentA: Agent;
let agentB: Agent;

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  assert.equal(new URL(parsed.DB_URL).hostname, "127.0.0.1");
  return parsed as Local;
}

async function createUser(label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  assert.ok(signed.data.session?.access_token);
  return { id: created.data.user.id, jwt: signed.data.session.access_token };
}

async function createAgent(name: string): Promise<Agent> {
  const principal = randomUUID();
  const run = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${`${name}-${principal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token };
}

async function send(bearer: string, command: Row, commandId: string = randomUUID()): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: commandId, client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" }, command }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function posted(bearer: string, extra: Row = {}): Promise<string> {
  const result = await send(bearer, { kind: "post_signal", signal_kind: "note", body: `reactions ${randomUUID()}`,
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra });
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  return String((result.body.signal as Row).id);
}

const react = (bearer: string, signalId: string, emoji: string, extra: Row = {}) =>
  send(bearer, { kind: "add_reaction", signal_id: signalId, emoji, ...extra });
const unreact = (bearer: string, signalId: string, emoji: string) =>
  send(bearer, { kind: "remove_reaction", signal_id: signalId, emoji });

async function agentInbox(agent: Agent, extra: Row = {}): Promise<Row[]> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${agent.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ resource: "signals", workspace_id: workspace, inbox: true, about: null, kind: null,
      since: null, in_reply_to: null, after_created_at: null, after_id: null, limit: 100, include_stale: false, ...extra }),
  });
  const body = await response.json() as Row;
  assert.equal(response.status, 200, JSON.stringify(body) + functionLogs.slice(-3000));
  return body.signals as Row[];
}

async function wakeFrames(agent: Agent, since: Date): Promise<Row[]> {
  const [row] = await sql<{ wake_id: string }[]>`SELECT wake_id FROM swarm.agent_principals WHERE principal_id = ${agent.principal}::uuid`;
  assert.ok(row?.wake_id, "the agent has a wake topic");
  return await frames(`cswarm-wake:${row.wake_id}`, since);
}

async function agentRead(agent: Agent, includeReactions: boolean): Promise<Row[]> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${agent.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ resource: "signals", workspace_id: workspace, inbox: false, about: null, kind: null,
      since: null, in_reply_to: null, limit: 100, include_stale: true, include_reactions: includeReactions }),
  });
  const body = await response.json() as Row;
  assert.equal(response.status, 200, JSON.stringify(body) + functionLogs.slice(-3000));
  return body.signals as Row[];
}

/** swarm_read.signal_reactions as a signed-in person: the view is gated on their claims. */
async function reactionsSeenBy(userId: string, signalId: string): Promise<Array<{ kind: string; id: string; emoji: string }>> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const rows = await tx<{ kind: string; id: string; emoji: string }[]>`
      SELECT kind, id::text AS id, emoji FROM swarm_read.signal_reactions
      WHERE signal_id = ${signalId}::uuid ORDER BY created_at, reaction_id`;
    return rows.map((row) => ({ ...row }));
  });
}

/** Audit rows a person reads through the client audit view, which hides rows tagged with a private channel. */
async function auditSeenBy(userId: string): Promise<Array<{ command_kind: string; actor_agent_principal: string | null; outcome: string }>> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const rows = await tx<{ command_kind: string; actor_agent_principal: string | null; outcome: string }[]>`
      SELECT command_kind, actor_agent_principal::text AS actor_agent_principal, outcome
      FROM swarm_read.audit_log WHERE workspace_id = ${workspace}::uuid`;
    return rows.map((row) => ({ ...row }));
  });
}

async function frames(topic: string, since: Date): Promise<Row[]> {
  const rows = await sql<{ payload: Row }[]>`
    SELECT payload FROM realtime.messages WHERE topic = ${topic} AND inserted_at >= ${since} ORDER BY inserted_at`;
  // Some Realtime versions store the sent object under payload.payload, and Realtime adds its own `id`.
  return rows.map((row) => {
    const { id: _realtimeId, ...sent } = (row.payload?.payload as Row | undefined) ?? row.payload;
    return sent;
  });
}

const workspaceTopic = () => `cswarm-signals:${workspace}`;
const memberTopic = (userId: string) => `cswarm-member:${workspace}:${userId}`;

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cswarm-reactions-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(functionProcess);
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
    startupSeen ||= functionLogs.includes("Serving functions on");
  };
  functionProcess.stdout?.on("data", observe);
  functionProcess.stderr?.on("data", observe);
  const bootDeadline = Date.now() + 60_000;
  while (!startupSeen) {
    if (Date.now() >= bootDeadline || functionProcess.exitCode !== null) throw new Error("local functions serve did not start");
    await delay(250);
  }
  await awaitFunctionRunning({ url: `${local.API_URL}/functions/v1/command`, fetcher: fetch,
    timeoutMs: 30_000, sleep: (ms) => delay(ms), now: () => Date.now(),
    diagnostics: () => "local command function was not ready", cliState });
  owner = await createUser("reactions-owner");
  other = await createUser("reactions-other");
  workspace = randomUUID();
  device = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'ReactOwner'), (${other.id}::uuid, 'ReactOther')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'reactions')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'ReactWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner'), (${workspace}::uuid, ${other.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
  agentA = await createAgent("react-a");
  agentB = await createAgent("react-b");
}, { timeout: 120_000 });

after(async () => {
  if (functionProcess?.pid && functionProcess.exitCode === null) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* already stopped */ }
    await Promise.race([new Promise((resolve) => functionProcess!.once("close", resolve)), delay(2_000)]);
    if (functionProcess.exitCode === null) {
      try { process.kill(-functionProcess.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
}, { timeout: 10_000 });

test("people and agents add and remove emojis on a public message, each once, and the agent read groups them", { timeout: 60_000 }, async () => {
  const since = new Date(Date.now() - 1000);
  const message = await posted(owner.jwt);
  const added = await react(other.jwt, message, "\u{1F440}");
  assert.equal(added.status, 200, JSON.stringify(added.body) + functionLogs.slice(-3000));
  assert.deepEqual({ ...added.body }, { status: "accepted", ok: true, event_ids: [], signal_id: message, emoji: "\u{1F440}", added: true });
  assert.equal((await react(other.jwt, message, ":eyes:")).body.added, false, "the same emoji, as a shortcode, is already there");
  assert.equal((await react(agentA.token, message, "\u{1F440}")).body.added, true);
  assert.equal((await react(agentA.token, message, ":rocket:")).body.emoji, "\u{1F680}");
  assert.equal((await react(agentA.token, message, "\u{1F6E0}️", { source: "ack" })).status, 200, "an agent may mark a message seen");

  const row = (await agentRead(agentB, true)).find((r) => r.id === message)!;
  assert.deepEqual(row.reactions, [
    { emoji: "\u{1F440}", count: 2, actors: [{ kind: "user", id: other.id }, { kind: "agent", id: agentA.principal }] },
    { emoji: "\u{1F680}", count: 1, actors: [{ kind: "agent", id: agentA.principal }] },
    { emoji: "\u{1F6E0}️", count: 1, actors: [{ kind: "agent", id: agentA.principal }] },
  ]);
  assert.equal("reactions" in (await agentRead(agentB, false)).find((r) => r.id === message)!, false, "absent unless asked");

  assert.deepEqual({ ...(await unreact(agentA.token, message, ":rocket:")).body }, {
    status: "accepted", ok: true, event_ids: [], signal_id: message, emoji: "\u{1F680}", removed: true });
  assert.equal((await unreact(agentA.token, message, ":rocket:")).body.removed, false);
  assert.deepEqual((await reactionsSeenBy(owner.id, message)).map((r) => r.emoji),
    ["\u{1F440}", "\u{1F440}", "\u{1F6E0}️"]);

  // Each change tells every reader's own topic that something moved, with no id (20261118000005), and the
  // workspace topic hears nothing.
  for (const person of [owner, other]) {
    const sent = await frames(memberTopic(person.id), since);
    assert.ok(sent.length >= 6, `the post and a frame per change on each reader's topic: ${JSON.stringify(sent)}`);
    for (const payload of sent) assert.deepEqual(payload, { v: 1 });
  }
  assert.deepEqual(await frames(workspaceTopic(), since), []);
});

test("what a reaction may carry: one emoji, an agent's ack, a known shortcode", async () => {
  const message = await posted(owner.jwt);
  for (const emoji of ["a", "\u{1F440}\u{1F440}", " \u{1F440}", ":nope:", ""]) {
    const refused = await react(other.jwt, message, emoji);
    assert.equal(refused.status, 400, JSON.stringify([emoji, refused.body]));
  }
  const personAck = await react(other.jwt, message, "\u{1F440}", { source: "ack" });
  assert.equal(personAck.status, 400, "a person's reaction is never an automatic ack");
  assert.equal((await send(other.jwt, { kind: "add_reaction", signal_id: message, emoji: "\u{1F44D}", extra: 1 })).status, 400);
  assert.equal((await react(other.jwt, "not-a-uuid", "\u{1F44D}")).status, 400);
  assert.equal((await react(other.jwt, message, "\u{1F44D}", { source: null })).status, 400, "source, when sent, is a string");
});

test("a reactor holds at most 64 emojis on one message, and re-adding one it holds is still accepted", async () => {
  const message = await posted(owner.jwt);
  // 63 stored directly, plus one real emoji through the edge: 64 held.
  await sql`INSERT INTO swarm.signal_reactions (workspace_id, signal_id, actor_user_id, emoji)
    SELECT ${workspace}::uuid, ${message}::uuid, ${other.id}::uuid, 'held-' || n FROM generate_series(1, 63) AS n`;
  assert.equal((await react(other.jwt, message, "\u{1F440}")).body.added, true);
  const refused = await react(other.jwt, message, "\u{1F44D}");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "reaction_limit_reached");
  const again = await react(other.jwt, message, ":eyes:");
  assert.equal(again.status, 200, `an emoji already held is not a 65th: ${JSON.stringify(again.body)}`);
  assert.equal(again.body.added, false);
  assert.equal((await react(owner.jwt, message, "\u{1F44D}")).status, 200, "another reactor is unaffected");
});

test("a private channel: only its members react or see reactions, and leaving it ends both", { timeout: 60_000 }, async () => {
  // Every frame the outsider's own topic has ever had, counted before the channel exists: since 20261118000005
  // a public message's frames reach that topic too, so a look-back window would catch the last test's.
  const outsiderAt = (await frames(memberTopic(other.id), new Date(0))).length;
  const slug = `lock-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, { kind: "channel_create", slug, visibility: "private",
    members: [{ kind: "agent", id: agentA.principal }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const lockId = String((created.body.channel as Row).channel_id);
  const message = await posted(owner.jwt, { channel: slug });
  const since = new Date(Date.now() - 1000);
  const reactionCommand = randomUUID();
  const reacted = await send(agentA.token, { kind: "add_reaction", signal_id: message, emoji: "\u{1F440}" }, reactionCommand);
  assert.equal(reacted.status, 200, "a member agent reacts");
  assert.equal((await react(owner.jwt, message, "\u{1F44D}")).status, 200);

  // Outside the channel, the message does not exist: the same answer as an unknown id.
  const unknown = await react(other.jwt, randomUUID(), "\u{1F44D}");
  assert.equal(unknown.status, 404);
  for (const [who, bearer] of [["a member outside it", other.jwt], ["a sibling agent outside it", agentB.token]] as const) {
    for (const attempt of [await react(bearer, message, "\u{1F44D}"), await unreact(bearer, message, "\u{1F440}")]) {
      assert.equal(attempt.status, 404, who);
      assert.deepEqual(attempt.body, unknown.body, `${who}: no different from an unknown id`);
    }
  }
  assert.deepEqual(await reactionsSeenBy(other.id, message), [], "an outsider reads no reactions");
  assert.equal((await agentRead(agentB, true)).some((r) => r.id === message), false);

  // Pushes go to the channel's people, never to the workspace topic.
  assert.equal((await frames(workspaceTopic(), since)).some((p) => p.signal_id === message), false);
  assert.ok((await frames(memberTopic(owner.id), since)).length >= 2, "the member's own topic hears it");
  assert.equal((await frames(memberTopic(other.id), new Date(0))).length, outsiderAt,
    "an outsider's topic hears nothing: not the post, not a reaction");

  const removed = await send(owner.jwt, { kind: "channel_member_remove", channel_id: lockId,
    member: { kind: "agent", id: agentA.principal } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const late = await react(agentA.token, message, "\u{1F680}");
  assert.equal(late.status, 404, "removed: the message is gone for it, though its owner stays");
  assert.deepEqual(late.body, unknown.body);
  assert.equal((await unreact(agentA.token, message, "\u{1F440}")).status, 404);

  // Its earlier command id, replayed after removal and again with another payload: the audit rows keep
  // the channel's tag from the stored success, so an admin outside the channel reads neither.
  await sql`UPDATE swarm.memberships SET role = 'admin' WHERE workspace_id = ${workspace}::uuid AND user_id = ${other.id}::uuid`;
  try {
    const replayed = await send(agentA.token, { kind: "add_reaction", signal_id: message, emoji: "\u{1F440}" }, reactionCommand);
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.deepEqual(replayed.body, reacted.body, "a replay answers what the first call did");
    const conflicting = await send(agentA.token, { kind: "add_reaction", signal_id: message, emoji: "\u{1F680}" }, reactionCommand);
    assert.equal(conflicting.status, 409);
    const changedKind = await send(agentA.token, { kind: "remove_reaction", signal_id: message, emoji: "\u{1F440}" }, reactionCommand);
    assert.equal(changedKind.status, 409);
    const outsideAudit = await auditSeenBy(other.id);
    assert.deepEqual(outsideAudit.filter((row) => row.actor_agent_principal === agentA.principal &&
      ["replayed", "conflict"].includes(row.outcome)), [], "no replay or conflict row reaches an admin outside the channel");
    // Control: the same replay on a public message is an ordinary row the admin reads.
    const publicMessage = await posted(owner.jwt);
    const publicCommand = randomUUID();
    assert.equal((await send(agentA.token, { kind: "add_reaction", signal_id: publicMessage, emoji: "\u{1F440}" }, publicCommand)).status, 200);
    assert.equal((await send(agentA.token, { kind: "add_reaction", signal_id: publicMessage, emoji: "\u{1F440}" }, publicCommand)).status, 200);
    assert.ok((await auditSeenBy(other.id)).some((row) => row.actor_agent_principal === agentA.principal && row.outcome === "replayed"),
      "the public replay is visible, so the empty result above is the tag, not the view");
  } finally {
    await sql`UPDATE swarm.memberships SET role = 'member' WHERE workspace_id = ${workspace}::uuid AND user_id = ${other.id}::uuid`;
  }
});

test("a private message: only those it is addressed to react, and only their topics hear it", { timeout: 60_000 }, async () => {
  const direct = await posted(owner.jwt, { to_user_id: other.id });
  // After the post: the post's own frame is the message trigger's business, not a reaction's.
  await delay(1100);
  const since = new Date();
  const unknown = await react(other.jwt, randomUUID(), "\u{1F44D}");
  assert.equal((await react(other.jwt, direct, "\u2705")).status, 200, "the recipient reacts");
  // ~~"the author's reaction answers as an unknown id does, like their read"~~ Since 20261117000004
  // swarm_read.signals admits a message to its author, so the author reacts as its recipient does.
  assert.equal((await react(owner.jwt, direct, "\u{1F44D}")).status, 200, "the author reacts");
  const sibling = await react(agentB.token, direct, "\u{1F44D}");
  assert.equal(sibling.status, 404, "an agent of the author's is neither addressed nor its author");
  assert.deepEqual(sibling.body, unknown.body);
  assert.equal((await frames(workspaceTopic(), since)).some((p) => p.signal_id === direct), false);
  const toRecipient = await frames(memberTopic(other.id), since);
  assert.ok(toRecipient.length >= 1);
  for (const payload of toRecipient) assert.deepEqual(payload, { v: 1 });
  assert.deepEqual((await reactionsSeenBy(other.id, direct)).map((r) => r.emoji), ["\u2705", "\u{1F44D}"]);
  assert.deepEqual((await reactionsSeenBy(owner.id, direct)).map((r) => r.emoji), ["\u2705", "\u{1F44D}"],
    "the author sees the reactions on their own message");

  // A message addressed to an agent: that agent reacts, and its owner's topic hears it; its sibling does not react,
  // and reading the view directly under the sibling's claims shows nothing.
  const toAgent = await posted(other.jwt, { to_agent_principal_id: agentA.principal });
  await delay(1100);
  const since2 = new Date();
  assert.equal((await react(agentA.token, toAgent, "\u{1F440}", { source: "ack" })).status, 200);
  assert.equal((await react(agentB.token, toAgent, "\u{1F440}")).status, 404);
  // The owner reads it (today's read rule admits an agent's owner), but hears nothing: since 20261118000005 a
  // 1:1's frames go to its people only, and ownership is never membership. The sender hears it.
  assert.equal((await frames(memberTopic(owner.id), since2)).length, 0, "the addressed agent's owner hears nothing");
  assert.ok((await frames(memberTopic(other.id), since2)).length >= 1, "its sender, a member, hears it");
  const seenBySibling = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner.id, role: "authenticated", agent_principal_id: agentB.principal })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    return await tx`SELECT 1 FROM swarm_read.signal_reactions WHERE signal_id = ${toAgent}::uuid`;
  });
  assert.equal(seenBySibling.length, 0, "a sibling agent's claims read no reactions on a message addressed to another agent");
  assert.equal((await reactionsSeenBy(owner.id, toAgent)).length, 1, "while the owner, who reads it, sees the reaction");
});

test("a person's reaction on an agent's public message wakes it and reaches its inbox; agents' reactions wake nobody", { timeout: 60_000 }, async () => {
  const message = await posted(agentA.token);
  await delay(1100);
  const since = new Date();
  const liked = await react(other.jwt, message, "\u{1F44D}");
  assert.equal(liked.status, 200, JSON.stringify(liked.body));
  const woke = await wakeFrames(agentA, since);
  assert.equal(woke.length, 1, `one wake for the agent: ${JSON.stringify(woke)}`);
  assert.deepEqual(Object.keys(woke[0]!).sort(), ["enqueued_at", "signal_id", "v"], "content-free");

  // Neither another agent's reaction, nor the agent's own, nor an automatic ack wakes it.
  assert.equal((await react(agentB.token, message, "\u{1F680}")).status, 200);
  assert.equal((await react(agentA.token, message, "\u{1F440}", { source: "ack" })).status, 200);
  assert.equal((await react(agentA.token, message, "\u{1F389}")).status, 200);
  assert.equal((await wakeFrames(agentA, since)).length, 1, "agents reacting never wake an agent");
  assert.equal((await wakeFrames(agentB, since)).length, 0);
  // A person's reaction on a person's message wakes no agent.
  const personal = await posted(owner.jwt);
  assert.equal((await react(other.jwt, personal, "\u{1F44D}")).status, 200);
  assert.equal((await wakeFrames(agentA, since)).length, 1);

  // The inbox as an installed client reads it: a note addressed to the agent, replying to its message.
  const inbox = await agentInbox(agentA);
  const reactionRows = inbox.filter((row) => row.in_reply_to === message && row.from === other.id);
  assert.equal(reactionRows.length, 1, `only the person's reaction: ${JSON.stringify(inbox)}`);
  const row = reactionRows[0]!;
  assert.equal(row.kind, "note");
  assert.equal(row.to_agent, agentA.principal);
  assert.deepEqual(row.recipients, [{ kind: "agent", id: agentA.principal, position: 0 }]);
  assert.match(String(row.body), new RegExp(`^Reacted \u{1F44D} to your message ${message}: `, "u"));
  assert.equal("reaction" in row, false, "no new key unless asked");
  const parsed = parseSignalRecord(row);
  assert.equal(signalAddressesAgent(parsed, agentA.principal), true, "0.1.82 to 0.1.98 admit it");
  const asked = (await agentInbox(agentA, { include_reactions: true })).find((r) => r.id === row.id)!;
  assert.deepEqual(asked.reaction, { emoji: "\u{1F44D}", signal_id: message });
  assert.equal((await agentInbox(agentB)).some((r) => r.in_reply_to === message && r.from === other.id), false,
    "another agent's inbox does not hold it");
  // Paging past it: the reaction row carries a cursor like any row.
  const page = await agentInbox(agentA, { after_created_at: String(row.created_at), after_id: String(row.id) });
  assert.equal(page.some((r) => r.id === row.id), false);

  // Removed, it is gone from the inbox.
  assert.equal((await unreact(other.jwt, message, "\u{1F44D}")).body.removed, true);
  assert.equal((await agentInbox(agentA)).some((r) => r.id === row.id), false);
});

test("a reaction in a private channel reaches the agent only while it is in the channel", { timeout: 60_000 }, async () => {
  const slug = `wake-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, { kind: "channel_create", slug, visibility: "private",
    members: [{ kind: "agent", id: agentA.principal }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const lockId = String((created.body.channel as Row).channel_id);
  const message = await posted(agentA.token, { channel: slug });
  assert.equal((await react(owner.jwt, message, "\u{1F44D}")).status, 200);
  assert.ok((await agentInbox(agentA)).some((r) => r.in_reply_to === message), "a member agent reads it");
  const removed = await send(owner.jwt, { kind: "channel_member_remove", channel_id: lockId,
    member: { kind: "agent", id: agentA.principal } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await agentInbox(agentA)).some((r) => r.in_reply_to === message), false, "gone once it leaves");
  const since = new Date();
  assert.equal((await react(owner.jwt, message, "\u{1F389}")).status, 200);
  assert.equal((await wakeFrames(agentA, since)).length, 0, "and a new reaction there wakes it no more");
});
