/**
 * Conversations, step 1 (20261118000004) with today's SERVED command function: the migration is
 * schema-first and changes no edge, so this edge is both the one that runs beside it at rollout and the
 * one an edge rollback returns to. Each kind it posts is filed at commit, and an old-edge post to a
 * group someone has left is refused with nothing persisted and no frame on the wire.
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
type Row = Record<string, unknown>;
type Filed = { conversation: string; kind: string; audience: string };

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let owner: Person;
let other: Person;
let third: Person;
let principal: string;
let agentToken: string;

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

async function send(bearer: string, command: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: randomUUID(), client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" }, command }),
  });
  return { status: response.status, body: await response.json() as Row };
}

const note = (extra: Row = {}): Row => ({ kind: "post_signal", signal_kind: "note", body: `conv ${randomUUID()}`,
  to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra });

async function posted(bearer: string, extra: Row = {}): Promise<string> {
  const result = await send(bearer, note(extra));
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  return String((result.body.signal as Row).id);
}

async function channel(extra: Row = {}): Promise<{ id: string; slug: string }> {
  const slug = `conv-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, { kind: "channel_create", slug, ...extra });
  assert.equal(created.status, 200, JSON.stringify(created.body) + functionLogs.slice(-3000));
  return { id: String((created.body.channel as Row).channel_id), slug };
}

async function filed(signal: string): Promise<Filed | null> {
  const [row] = await sql<Filed[]>`
    SELECT cs.conversation_id::text AS conversation, c.kind, cs.audience
    FROM swarm.conversation_signals cs JOIN swarm.conversations c ON c.conversation_id = cs.conversation_id
    WHERE cs.signal_id = ${signal}::uuid`;
  return row ? { ...row } : null;
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cswarm-conversations-env-"));
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
  owner = await createUser("conv-owner");
  other = await createUser("conv-other");
  third = await createUser("conv-third");
  workspace = randomUUID();
  const device = randomUUID();
  principal = randomUUID();
  const run = randomUUID();
  agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'ConvOwner'), (${other.id}::uuid, 'ConvOther'), (${third.id}::uuid, 'ConvThird')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'conv')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'ConvWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner'), (${workspace}::uuid, ${other.id}::uuid, 'member'),
        (${workspace}::uuid, ${third.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${`conv-agent-${principal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
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

test("today's edge posts every kind and each is filed at commit with its audience", { timeout: 90_000 }, async () => {
  const [{ g }] = await sql<{ g: string }[]>`SELECT conversation_id::text AS g FROM swarm.conversations
    WHERE workspace_id = ${workspace}::uuid AND kind = 'general'`;
  const room = await channel();
  const lock = await channel({ visibility: "private", members: [{ kind: "user", id: third.id }] });

  const plain = await posted(owner.jwt);
  const mention = await posted(owner.jwt, { body: `hey @conv-agent-${principal.slice(0, 6)}`, mentions: [{ kind: "agent", id: principal }] });
  const inRoom = await posted(owner.jwt, { channel: room.slug });
  const reply = await posted(other.jwt, { thread_root_id: inRoom });
  const broadcast = await posted(other.jwt, { thread_root_id: inRoom, broadcast_to_channel: true });
  const inLock = await posted(owner.jwt, { channel: lock.slug });
  // in_reply_to answers only a message addressed to the replier; this ask is, inside the private channel.
  const lockAsk = await posted(owner.jwt, { channel: lock.slug, signal_kind: "ask", to_user_id: third.id });
  const privateReply = await posted(third.jwt, { in_reply_to: lockAsk });
  const dm = await posted(owner.jwt, { to_user_id: other.id });
  const dmBack = await posted(other.jwt, { in_reply_to: dm });
  const group = await posted(owner.jwt, { to: [{ kind: "user", id: other.id }, { kind: "user", id: third.id }, { kind: "agent", id: principal }] });
  const toAgent = await posted(owner.jwt, { to_agent_principal_id: principal });
  const fromAgent = await posted(agentToken, { to_user_id: owner.id });

  assert.deepEqual(await filed(plain), { conversation: g, kind: "general", audience: "conversation" });
  assert.deepEqual(await filed(mention), { conversation: g, kind: "general", audience: "conversation" });
  for (const id of [inRoom, reply, broadcast]) {
    assert.deepEqual(await filed(id), { conversation: room.id, kind: "public_channel", audience: "conversation" });
  }
  assert.deepEqual(await filed(inLock), { conversation: lock.id, kind: "private_channel", audience: "conversation" });
  assert.deepEqual(await filed(lockAsk), { conversation: lock.id, kind: "private_channel", audience: "addressed" },
    "an addressed post in a channel stays in it");
  assert.deepEqual(await filed(privateReply), { conversation: lock.id, kind: "private_channel", audience: "addressed" },
    "a private reply in a channel stays in it, addressed");
  const pair = await filed(dm);
  assert.deepEqual({ kind: pair?.kind, audience: pair?.audience }, { kind: "dm", audience: "addressed" });
  assert.equal((await filed(dmBack))?.conversation, pair!.conversation);
  assert.equal((await filed(group))?.kind, "group_dm");
  const agentPair = await filed(toAgent);
  assert.equal(agentPair?.kind, "dm");
  assert.equal((await filed(fromAgent))?.conversation, agentPair!.conversation);
});

test("an old-edge post to a group someone left is refused: no message, no delivery, no frame", { timeout: 90_000 }, async () => {
  const founding = [{ kind: "user", id: other.id }, { kind: "user", id: third.id }, { kind: "agent", id: principal }];
  // Every frame this workspace's people and agent can hear: the workspace topic, each person's own topic and the
  // agent's wake topic (keyed by its wake id, not the workspace).
  const [{ wake }] = await sql<{ wake: string }[]>`SELECT 'cswarm-wake:' || wake_id AS wake FROM swarm.agent_principals
    WHERE principal_id = ${principal}::uuid`;
  const frames = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM realtime.messages
    WHERE position(${workspace} in topic) > 0 OR topic = ${wake}`)[0]!.n;
  const orphanFrames = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM realtime.messages AS m
    WHERE (position(${workspace} in m.topic) > 0 OR m.topic = ${wake})
      AND coalesce(m.payload -> 'payload' ->> 'signal_id', m.payload ->> 'signal_id') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM swarm.signals s
        WHERE s.id::text = coalesce(m.payload -> 'payload' ->> 'signal_id', m.payload ->> 'signal_id'))`)[0]!.n;
  const deliveries = async () => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm.signal_deliveries WHERE workspace_id = ${workspace}::uuid`)[0]!.n;
  const traces = async (id: string) => (await sql<{ frames: number; deliveries: number }[]>`
    SELECT (SELECT count(*)::int FROM realtime.messages
      WHERE coalesce(payload -> 'payload' ->> 'signal_id', payload ->> 'signal_id') = ${id}) AS frames,
      (SELECT count(*)::int FROM swarm.signal_deliveries WHERE signal_id = ${id}::uuid) AS deliveries`)[0]!;

  // Positive control: the same post before anyone leaves delivers to the agent and sends its frames.
  const first = await posted(owner.jwt, { to: founding });
  const sent = await traces(first);
  assert.ok(sent.frames > 0 && sent.deliveries === 1, JSON.stringify(sent));
  const group = (await filed(first))!.conversation;

  await sql`UPDATE swarm.conversation_members SET left_at = statement_timestamp()
    WHERE conversation_id = ${group}::uuid AND member_user_id = ${third.id}::uuid`;
  const [framesAt, deliveriesAt] = [await frames(), await deliveries()];
  const body = `after leaving ${randomUUID()}`;
  const refused = await send(owner.jwt, note({ body, to: founding }));
  assert.ok(refused.status >= 400, JSON.stringify(refused.body));
  assert.equal((await sql`SELECT 1 FROM swarm.signals WHERE workspace_id = ${workspace}::uuid AND body = ${body}`).length, 0);
  assert.equal(await deliveries(), deliveriesAt, "no delivery to the agent");
  assert.equal(await frames(), framesAt, "no frame on the workspace, member or wake topics");
  assert.equal(await orphanFrames(), 0, "no frame names a message that does not exist");

  // The remaining set is another conversation and posts normally.
  const rest = await posted(owner.jwt, { to: [{ kind: "user", id: other.id }, { kind: "agent", id: principal }] });
  const restFiled = await filed(rest);
  assert.equal(restFiled?.kind, "group_dm");
  assert.notEqual(restFiled!.conversation, group);
  const restSent = await traces(rest);
  assert.ok(restSent.frames > 0 && restSent.deliveries === 1, JSON.stringify(restSent));
});
