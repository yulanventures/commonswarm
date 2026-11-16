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

  // Each change tells the workspace's tabs which message moved, and nothing private.
  const sent = (await frames(workspaceTopic(), since)).filter((p) => p.signal_id === message);
  assert.ok(sent.length >= 5, `a frame per change on the workspace topic: ${JSON.stringify(sent)}`);
  for (const payload of sent) assert.deepEqual(Object.keys(payload).sort(), ["created_at", "signal_id", "v"]);
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
});

test("a reactor holds at most 64 emojis on one message", async () => {
  const message = await posted(owner.jwt);
  await sql`INSERT INTO swarm.signal_reactions (workspace_id, signal_id, actor_user_id, emoji)
    SELECT ${workspace}::uuid, ${message}::uuid, ${other.id}::uuid, 'held-' || n FROM generate_series(1, 64) AS n`;
  const refused = await react(other.jwt, message, "\u{1F44D}");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "reaction_limit_reached");
  assert.equal((await react(owner.jwt, message, "\u{1F44D}")).status, 200, "another reactor is unaffected");
});

test("a private channel: only its members react or see reactions, and leaving it ends both", { timeout: 60_000 }, async () => {
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
  assert.equal((await frames(memberTopic(other.id), since)).length, 0, "an outsider's topic hears nothing");

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

test("a private message: only its parties react, and only their topics hear it", { timeout: 60_000 }, async () => {
  const since = new Date(Date.now() - 1000);
  const direct = await posted(owner.jwt, { to_user_id: other.id });
  assert.equal((await react(other.jwt, direct, "✅")).status, 200, "the recipient reacts");
  assert.equal((await react(owner.jwt, direct, "\u{1F44D}")).status, 200, "the author reacts");
  const sibling = await react(agentB.token, direct, "\u{1F44D}");
  assert.equal(sibling.status, 404, "an agent of the author's is not a party");
  assert.equal((await frames(workspaceTopic(), since)).some((p) => p.signal_id === direct), false);
  assert.ok((await frames(memberTopic(other.id), since)).length >= 2);
  assert.ok((await frames(memberTopic(owner.id), since)).length >= 2);
  for (const payload of await frames(memberTopic(other.id), since)) assert.deepEqual(payload, { v: 1 });

  // A message addressed to an agent: that agent reacts; its sibling does not.
  const toAgent = await posted(other.jwt, { to_agent_principal_id: agentA.principal });
  assert.equal((await react(agentA.token, toAgent, "\u{1F440}", { source: "ack" })).status, 200);
  assert.equal((await react(agentB.token, toAgent, "\u{1F440}")).status, 404);
});
