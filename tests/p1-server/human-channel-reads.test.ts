/**
 * A person's channel read position against the served command function and real Postgres:
 * mark_channel_read moves it forward (never back), swarm_read.channel_unread counts only what is
 * after it, and a channel or message the person cannot see answers as an unknown one.
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
type UnreadRow = {
  channel_id: string | null; slug: string; involvement: string; unread: boolean | null;
  unread_count: number; first_unread_id: string | null; first_unread_at: string | null;
};

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let owner: Person;
let reader: Person;
let third: Person;
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
  const result = await send(bearer, { kind: "post_signal", signal_kind: "note", body: `reads ${randomUUID()}`,
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra });
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  return String((result.body.signal as Row).id);
}

/** A new channel's id and name; posts name the channel, mark_channel_read takes its id. */
async function channel(prefix: string, extra: Row = {}): Promise<{ id: string; slug: string }> {
  const slug = `${prefix}-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, { kind: "channel_create", slug, ...extra });
  assert.equal(created.status, 200, JSON.stringify(created.body) + functionLogs.slice(-3000));
  return { id: String((created.body.channel as Row).channel_id), slug };
}

const markRead = (bearer: string, target: Row, commandId?: string) =>
  send(bearer, { kind: "mark_channel_read", ...target }, commandId);

async function accepted(bearer: string, target: Row, commandId?: string): Promise<Row> {
  const result = await markRead(bearer, target, commandId);
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  assert.equal(result.body.status, "accepted");
  return result.body;
}

/** swarm_read.channel_unread the way the web app reads it, keyed by channel id ("general" for null). */
async function unreadOf(userId: string): Promise<Map<string, UnreadRow>> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const [row] = await tx<{ u: { channels: UnreadRow[] } }[]>`SELECT swarm_read.channel_unread(${workspace}::uuid) AS u`;
    return new Map(row!.u.channels.map((c) => [c.channel_id ?? "general", c]));
  });
}

/** A message's created_at as channel_unread renders it, from the same kind of session. */
async function createdAt(signalId: string): Promise<string> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner.id, role: "authenticated" })}, true)`;
    const [row] = await tx<{ at: string }[]>`
      SELECT jsonb_build_object('at', created_at) ->> 'at' AS at FROM swarm.signals WHERE id = ${signalId}::uuid`;
    return row!.at;
  });
}

async function position(userId: string, channelId: string | null): Promise<{ through_id: string | null; exact: boolean } | null> {
  const [row] = await sql<{ through_id: string | null; exact: boolean }[]>`
    SELECT r.read_through_id::text AS through_id,
      coalesce(r.read_through_at = (SELECT s.created_at FROM swarm.signals s WHERE s.id = r.read_through_id), false) AS exact
    FROM swarm.human_channel_reads r
    WHERE r.workspace_id = ${workspace}::uuid AND r.user_id = ${userId}::uuid
      AND r.channel_id IS NOT DISTINCT FROM ${channelId}::uuid`;
  return row ? { ...row } : null;
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cswarm-channel-reads-env-"));
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
  owner = await createUser("reads-owner");
  reader = await createUser("reads-reader");
  third = await createUser("reads-third");
  workspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'ReadsOwner'), (${reader.id}::uuid, 'ReadsReader'), (${third.id}::uuid, 'ReadsThird')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'reads')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'ReadsWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner'), (${workspace}::uuid, ${reader.id}::uuid, 'member'),
        (${workspace}::uuid, ${third.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${`reads-agent-${principal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["post_signal", "mark_channel_read"])}::jsonb,
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

test("reading through the newest message clears a channel whose older unread was never seen, and only forward", { timeout: 90_000 }, async () => {
  const design = await channel("design");
  const designId = design.id;
  const before = await unreadOf(reader.id);
  assert.equal(before.get(designId)?.unread, null, "no receipt and no position yet: unknown");
  assert.equal(before.get(designId)?.unread_count, 0);
  assert.equal(before.get(designId)?.first_unread_id, null);

  // Marking general read starts the reader's unread, as a first receipt does.
  const general = await accepted(reader.jwt, { channel_id: null });
  assert.equal((general.channels as Row[]).length, 1);
  assert.equal((general.channels as Row[])[0]!.channel_id, null);
  assert.equal(typeof (general.channels as Row[])[0]!.read_through_at, "string");

  const first = await posted(owner.jwt, { channel: design.slug });
  const middle = await posted(owner.jwt, { channel: design.slug });
  const newest = await posted(owner.jwt, { channel: design.slug });
  // The web app saw only the newest row in its viewport; the two above it have no receipt.
  assert.equal((await send(reader.jwt, { kind: "signals_seen", signal_ids: [newest] })).status, 200);
  const stuck = (await unreadOf(reader.id)).get(designId)!;
  assert.equal(stuck.unread, true, "older unseen messages keep the channel unread without a position");
  assert.equal(stuck.unread_count, 2);
  assert.equal(stuck.first_unread_id, first);
  assert.equal(stuck.first_unread_at, await createdAt(first));
  assert.equal((await unreadOf(reader.id)).get("general")?.unread, false);

  const commandId = randomUUID();
  const read = await accepted(reader.jwt, { channel_id: designId, through_signal_id: newest }, commandId);
  assert.deepEqual(Object.keys(read).sort(), ["channels", "event_ids", "ok", "status"]);
  assert.deepEqual((read.channels as Row[]).map((c) => c.channel_id), [designId]);
  assert.deepEqual(await position(reader.id, designId), { through_id: newest, exact: true },
    "the position is the message's own (created_at, id), at the database's precision");
  const cleared = (await unreadOf(reader.id)).get(designId)!;
  assert.deepEqual([cleared.unread, cleared.unread_count, cleared.first_unread_id, cleared.first_unread_at], [false, 0, null, null]);

  // An older message is accepted and moves nothing.
  const older = await accepted(reader.jwt, { channel_id: designId, through_signal_id: middle });
  assert.deepEqual(older.channels, read.channels, "the answer is the position kept, not the older one");
  assert.deepEqual(await position(reader.id, designId), { through_id: newest, exact: true });
  assert.equal((await unreadOf(reader.id)).get(designId)?.unread, false);

  // The same command id replays its stored answer; another payload under it conflicts.
  const replayed = await markRead(reader.jwt, { channel_id: designId, through_signal_id: newest }, commandId);
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.body, read);
  assert.equal((await markRead(reader.jwt, { channel_id: designId, through_signal_id: middle }, commandId)).status, 409);

  // A newer message is unread again, and is the first unread.
  const later = await posted(owner.jwt, { channel: design.slug });
  const again = (await unreadOf(reader.id)).get(designId)!;
  assert.deepEqual([again.unread, again.unread_count, again.first_unread_id], [true, 1, later]);

  // Without a message, everything up to now is read.
  await accepted(reader.jwt, { channel_id: designId });
  assert.deepEqual(await position(reader.id, designId), { through_id: null, exact: false });
  assert.equal((await unreadOf(reader.id)).get(designId)?.unread, false);
  // A message named after that is older than the position: nothing moves back.
  await accepted(reader.jwt, { channel_id: designId, through_signal_id: later });
  assert.deepEqual(await position(reader.id, designId), { through_id: null, exact: false });

  // A thread reply that stays in its thread is not a channel message to read through; one also sent
  // to the channel is.
  const reply = await posted(owner.jwt, { thread_root_id: later });
  const refused = await markRead(reader.jwt, { channel_id: designId, through_signal_id: reply });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "signal_not_found");
  const broadcast = await posted(owner.jwt, { thread_root_id: later, broadcast_to_channel: true });
  assert.equal((await unreadOf(reader.id)).get(designId)?.first_unread_id, broadcast, "a reply sent to the channel counts");
  await accepted(reader.jwt, { channel_id: designId, through_signal_id: broadcast });
  assert.deepEqual(await position(reader.id, designId), { through_id: broadcast, exact: true });
});

test("unknown and inaccessible channels and messages answer alike, and all: true never reaches a private channel the person is not in", { timeout: 90_000 }, async () => {
  const open = await channel("open");
  const lock = await channel("lock", { visibility: "private", members: [{ kind: "user", id: third.id }] });
  const openId = open.id;
  const lockId = lock.id;
  // Baselines for both readers, so their unread is known.
  await accepted(reader.jwt, { channel_id: null });
  await accepted(third.jwt, { channel_id: null });

  const inOpen = await posted(owner.jwt, { channel: open.slug });
  const inGeneral = await posted(owner.jwt);
  const inLock = await posted(owner.jwt, { channel: lock.slug });
  const toThird = await posted(owner.jwt, { to_user_id: third.id });

  // A private channel the reader is not in answers exactly as an unknown id.
  const unknownChannel = await markRead(reader.jwt, { channel_id: randomUUID() });
  assert.equal(unknownChannel.status, 404);
  assert.equal(unknownChannel.body.error, "channel_not_found");
  const hiddenChannel = await markRead(reader.jwt, { channel_id: lockId });
  assert.equal(hiddenChannel.status, 404);
  assert.deepEqual(hiddenChannel.body, unknownChannel.body);
  assert.equal((await markRead(reader.jwt, { channel_id: lockId, through_signal_id: inLock })).status, 404);

  // Unknown, in another channel, and unreadable messages all answer alike.
  const unknownSignal = await markRead(reader.jwt, { channel_id: null, through_signal_id: randomUUID() });
  assert.equal(unknownSignal.status, 404);
  assert.equal(unknownSignal.body.error, "signal_not_found");
  for (const [why, target] of [
    ["another channel's message", { channel_id: null, through_signal_id: inOpen }],
    ["a private channel's message", { channel_id: null, through_signal_id: inLock }],
    ["a message addressed to someone else", { channel_id: null, through_signal_id: toThird }],
  ] as const) {
    const refused = await markRead(reader.jwt, target);
    assert.equal(refused.status, 404, why);
    assert.deepEqual(refused.body, unknownSignal.body, why);
  }
  // Control: the person it is addressed to may read through it.
  await accepted(third.jwt, { channel_id: null, through_signal_id: toThird });
  assert.deepEqual(await position(third.id, null), { through_id: toThird, exact: true });

  const readerBefore = await unreadOf(reader.id);
  assert.equal(readerBefore.has(lockId), false);
  assert.equal(readerBefore.get(openId)?.unread, true);
  assert.equal(readerBefore.get("general")?.first_unread_id, inGeneral);

  // all: true reads general and every channel the reader can open, and nothing else.
  const all = await accepted(reader.jwt, { all: true });
  const targets = (all.channels as Row[]).map((c) => c.channel_id);
  assert.equal(targets[0], null, "general first");
  assert.ok(targets.includes(openId));
  assert.equal(targets.includes(lockId), false, "a private channel the reader is not in is never touched");
  assert.equal(await position(reader.id, lockId), null);
  for (const row of (await unreadOf(reader.id)).values()) {
    assert.equal(row.unread, false, row.slug);
    assert.equal(row.unread_count, 0, row.slug);
  }

  // The member's own unread for the private channel is untouched by the reader.
  const thirdRows = await unreadOf(third.id);
  assert.equal(thirdRows.get(lockId)?.unread, true);
  assert.equal(thirdRows.get(lockId)?.first_unread_id, inLock);
});

test("muted and mentions-only channels keep their rules beside the position", { timeout: 90_000 }, async () => {
  const muted = await channel("muted");
  const quiet = await channel("quiet");
  const mutedId = muted.id;
  const quietId = quiet.id;
  for (const [channelId, involvement] of [[mutedId, "muted"], [quietId, "mentions"]] as const) {
    const set = await send(reader.jwt, { kind: "channel_preference_set", channel_id: channelId, involvement });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  await accepted(reader.jwt, { channel_id: null });
  await posted(owner.jwt, { channel: muted.slug });
  await posted(owner.jwt, { channel: quiet.slug });
  let rows = await unreadOf(reader.id);
  assert.deepEqual([rows.get(mutedId)?.unread, rows.get(mutedId)?.unread_count, rows.get(mutedId)?.first_unread_id],
    [false, 0, null], "muted is never unread");
  assert.deepEqual([rows.get(quietId)?.unread, rows.get(quietId)?.unread_count], [false, 0], "an unmentioned post stays quiet");

  const mention = await posted(owner.jwt, { channel: quiet.slug, body: "hey @ReadsReader", mentions: [{ kind: "user", id: reader.id }] });
  rows = await unreadOf(reader.id);
  assert.deepEqual([rows.get(quietId)?.unread, rows.get(quietId)?.unread_count, rows.get(quietId)?.first_unread_id],
    [true, 1, mention]);
  await accepted(reader.jwt, { channel_id: quietId, through_signal_id: mention });
  assert.equal((await unreadOf(reader.id)).get(quietId)?.unread, false);
});

test("an agent cannot mark a channel read, whatever its scopes", { timeout: 30_000 }, async () => {
  for (const target of [{ channel_id: null }, { all: true }]) {
    const refused = await markRead(agentToken, target);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  }
  assert.equal((await markRead(reader.jwt, { channel_id: null, extra: true })).status, 400);
});
