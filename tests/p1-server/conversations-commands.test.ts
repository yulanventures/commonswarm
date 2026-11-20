/**
 * Conversations, step 2a (20261118000005) through the SERVED command function: the conversation commands with
 * their refusals, replay and audit rows; post_signal with conversation_id and its route rule; and per-person
 * Realtime frames on real sockets (@supabase/supabase-js), including a held socket after leaving a group and
 * after leaving the workspace, and non-member owners and admins.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { id: string; token: string; name: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let ann: Person; // the workspace owner
let ben: Person;
let cat: Person;
let dee: Person; // a workspace admin
let annBot: Agent; // owned by ann
let deeBot: Agent; // owned by dee
const realtimeClients: SupabaseClient[] = [];

type Listener = { name: string; frames: unknown[]; client: SupabaseClient; channel: RealtimeChannel };

async function listen(name: string, bearer: string, topic: string): Promise<Listener> {
  const client = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  realtimeClients.push(client);
  await client.realtime.setAuth(bearer);
  const frames: unknown[] = [];
  const channel = client.channel(topic, { config: { private: true, broadcast: { ack: false, self: false } } });
  channel.on("broadcast", { event: "signal" }, (message) => { frames.push(message.payload); });
  const status = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: Realtime subscribe timed out`)), 15_000);
    channel.subscribe((next) => {
      if (next !== "SUBSCRIBED" && next !== "CHANNEL_ERROR" && next !== "TIMED_OUT") return;
      clearTimeout(timer);
      resolve(next);
    });
  });
  assert.equal(status, "SUBSCRIBED", `${name} joins ${topic}`);
  return { name, frames, client, channel };
}

async function framesArrive(listeners: Listener[], before: number[], label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (listeners.some((l, i) => l.frames.length <= before[i]!)) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: no frame on ${listeners.filter((l, i) => l.frames.length <= before[i]!).map((l) => l.name).join(", ")}`);
    }
    await delay(100);
  }
}

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  assert.equal(new URL(parsed.DB_URL).hostname, "127.0.0.1");
  return parsed as Local;
}

/** A signed-in person. Their name comes from the sign-in identity, as in production: every command of theirs
 * sets swarm.users.display_name from it. */
async function createUser(label: string, name: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true,
    user_metadata: { full_name: name } });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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

const ok = (result: { status: number; body: Row }, label = ""): Row => {
  assert.equal(result.status, 200, `${label} ${JSON.stringify(result.body)} ${functionLogs.slice(-2000)}`);
  return result.body;
};
const note = (extra: Row = {}): Row => ({ kind: "post_signal", signal_kind: "note", body: `conv2a ${randomUUID()}`,
  to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra });
const posted = async (bearer: string, extra: Row = {}): Promise<string> =>
  String((ok(await send(bearer, note(extra)), "post").signal as Row).id);
const user = (p: Person) => ({ kind: "user", id: p.id });
const agent = (a: Agent) => ({ kind: "agent", id: a.id });
const opened = async (bearer: string, members: Row[], extra: Row = {}): Promise<Row> =>
  ok(await send(bearer, { kind: "conversation_open", members, ...extra }), "open").conversation as Row;
const deliveredTo = async (signal: string) => (await sql<{ a: string }[]>`
  SELECT recipient_agent_principal_id::text AS a FROM swarm.signal_deliveries WHERE signal_id = ${signal}::uuid ORDER BY 1`)
  .map((r) => r.a);
/** A plain object: postgres.js rows are not plain for a strict deepEqual. */
const filed = async (signal: string) => {
  const [row] = await sql<{ conversation: string; audience: string }[]>`
    SELECT conversation_id::text AS conversation, audience FROM swarm.conversation_signals WHERE signal_id = ${signal}::uuid`;
  return row ? { ...row } : undefined;
};

async function makeAgent(owner: Person, label: string, exactName?: string): Promise<Agent> {
  const id = randomUUID();
  const name = exactName ?? `${label}-${id.slice(0, 6)}`;
  const device = randomUUID();
  const run = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, ${label})`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${id}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${name})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${id}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { id, token, name };
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cswarm-conversations-2a-env-"));
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
  [ann, ben, cat, dee] = [await createUser("c2a-ann", "Ann"), await createUser("c2a-ben", "Ben"),
    await createUser("c2a-cat", "Cat"), await createUser("c2a-dee", "Dee")];
  workspace = randomUUID();
  await sql.begin(async (tx) => {
    // The rows the workspace and memberships reference, before anyone's first command; the same names as the
    // sign-in identity, which each command writes again.
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${ann.id}::uuid, 'Ann'), (${ben.id}::uuid, 'Ben'), (${cat.id}::uuid, 'Cat'), (${dee.id}::uuid, 'Dee')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'Conv2a', ${ann.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${ann.id}::uuid, 'owner'), (${workspace}::uuid, ${ben.id}::uuid, 'member'),
        (${workspace}::uuid, ${cat.id}::uuid, 'member'), (${workspace}::uuid, ${dee.id}::uuid, 'admin')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
  annBot = await makeAgent(ann, "c2a-annbot");
  deeBot = await makeAgent(dee, "c2a-deebot");
}, { timeout: 120_000 });

after(async () => {
  for (const client of realtimeClients) client.realtime.disconnect();
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

test("conversation_open finds or makes a 1:1 or group; replays; refuses strangers, oversize and groups someone left", { timeout: 90_000 }, async () => {
  const commandId = randomUUID();
  const first = ok(await send(ann.jwt, { kind: "conversation_open", members: [user(ben)] }, commandId));
  const dm = first.conversation as Row;
  assert.deepEqual([dm.kind, first.created, dm.generation], ["dm", true, 0]);
  assert.deepEqual((dm.members as Row[]).map((m) => m.id).sort(), [ann.id, ben.id].sort());
  assert.deepEqual(ok(await send(ann.jwt, { kind: "conversation_open", members: [user(ben)] }, commandId)), first,
    "a replay answers what the first call did");
  assert.equal((await send(ann.jwt, { kind: "conversation_open", members: [user(cat)] }, commandId)).status, 409,
    "the same command id with another body conflicts");
  const again = ok(await send(ben.jwt, { kind: "conversation_open", members: [user(ann)] }));
  assert.deepEqual([(again.conversation as Row).conversation_id, again.created], [dm.conversation_id, false], "either founder reuses it");
  assert.equal((await opened(ann.jwt, [user(ann)])).kind, "dm", "a note to oneself is a 1:1 of one");
  assert.equal((await opened(annBot.token, [user(ann)])).kind, "dm", "an agent opens one too");

  const [audit] = await sql<{ accepted: number; replayed: number; conflict: number }[]>`
    SELECT count(*) FILTER (WHERE outcome = 'accepted')::int AS accepted, count(*) FILTER (WHERE outcome = 'replayed')::int AS replayed,
      count(*) FILTER (WHERE outcome = 'conflict')::int AS conflict
    FROM swarm.audit_log WHERE workspace_id = ${workspace}::uuid AND command_kind = 'conversation_open' AND actor_user = ${ann.id}::uuid`;
  assert.ok(audit!.accepted >= 2 && audit!.replayed === 1 && audit!.conflict === 1, JSON.stringify(audit));

  const stranger = await send(ann.jwt, { kind: "conversation_open", members: [{ kind: "user", id: randomUUID() }] });
  assert.deepEqual([stranger.status, stranger.body.error], [403, "conversation_member_not_in_workspace"]);
  const ten = await send(ann.jwt, { kind: "conversation_open",
    members: Array.from({ length: 10 }, () => ({ kind: "user", id: randomUUID() })) });
  assert.equal(ten.status, 400, "more than nine is refused at the wire");
  const nine = await send(ann.jwt, { kind: "conversation_open",
    members: Array.from({ length: 9 }, () => ({ kind: "user", id: randomUUID() })) });
  assert.deepEqual([nine.status, nine.body.error], [400, "conversation_too_large"], "nine others plus the caller is ten");
  for (const bad of [{ kind: "conversation_open" }, { kind: "conversation_open", members: [] },
    { kind: "conversation_open", members: [user(ben), user(ben)] }, { kind: "conversation_open", members: [user(ben)], new_group: "yes" },
    { kind: "conversation_open", members: [user(ben)], extra: 1 }]) {
    assert.equal((await send(ann.jwt, bad)).status, 400, JSON.stringify(bad));
  }

  const group = await opened(ann.jwt, [user(ben), user(cat), agent(annBot)]);
  assert.equal(group.kind, "group_dm");
  const left = ok(await send(cat.jwt, { kind: "conversation_leave", conversation_id: group.conversation_id }));
  assert.equal(left.changed, true);
  const refused = await send(ann.jwt, { kind: "conversation_open", members: [user(ben), user(cat), agent(annBot)] });
  assert.deepEqual({ status: refused.status, ...refused.body }, { status: 409, error: "conversation_member_left",
    message: "Cat left this group. To include everyone again, start a new group." });
  const oldPath = await send(ann.jwt, note({ to: [user(ben), user(cat), agent(annBot)] }));
  assert.deepEqual([oldPath.status, oldPath.body.error], [409, "conversation_member_left"], "today's path says why too");
  assert.equal((await send(cat.jwt, { kind: "conversation_open", members: [user(ann), user(ben), agent(annBot)], new_group: true }))
    .body.error, "conversation_left", "the one who left cannot start it again");
  const fresh = ok(await send(ben.jwt, { kind: "conversation_open", members: [user(ann), user(cat), agent(annBot)], new_group: true }));
  assert.deepEqual([fresh.created, (fresh.conversation as Row).generation], [true, 1]);
  assert.notEqual((fresh.conversation as Row).conversation_id, group.conversation_id,
    "a new group: a new conversation, so the old one's history is not opened to anyone who left it");
});

test("join, leave, invite and remove follow the Slack rules; mark read and notify write the caller's own row", { timeout: 90_000 }, async () => {
  const slug = `c2a-${randomBytes(4).toString("hex")}`;
  const room = String(((ok(await send(ann.jwt, { kind: "channel_create", slug })).channel as Row).channel_id));
  const [{ g }] = await sql<{ g: string }[]>`SELECT conversation_id::text AS g FROM swarm.conversations
    WHERE workspace_id = ${workspace}::uuid AND kind = 'general'`;
  const join = (bearer: string, id: string) => send(bearer, { kind: "conversation_join", conversation_id: id });
  const leave = (bearer: string, id: string) => send(bearer, { kind: "conversation_leave", conversation_id: id });

  assert.equal(ok(await join(ben.jwt, room)).changed, true);
  assert.equal(ok(await join(ben.jwt, room)).changed, false, "joining twice changes nothing");
  assert.equal(ok(await join(annBot.token, room)).changed, true, "an agent joins too");
  assert.equal(ok(await leave(ben.jwt, room)).changed, true);
  assert.equal(ok(await join(ben.jwt, room)).changed, true, "and rejoins");
  assert.deepEqual([(await leave(ben.jwt, g)).status, (await leave(ben.jwt, g)).body.error], [409, "conversation_cannot_leave"]);
  const dm = await opened(ann.jwt, [user(ben)]);
  assert.deepEqual([(await leave(ann.jwt, String(dm.conversation_id))).body.error], ["conversation_cannot_leave"], "mute instead");
  const outside = await leave(cat.jwt, String(dm.conversation_id));
  const unknown = await leave(cat.jwt, randomUUID());
  assert.deepEqual([outside.status, outside.body], [404, unknown.body], "a 1:1 one is not in answers as an unknown id");
  assert.equal((await join(cat.jwt, String(dm.conversation_id))).status, 404);

  const invite = (bearer: string, id: string, members: Row[]) => send(bearer, { kind: "conversation_invite", conversation_id: id, members });
  assert.equal((await invite(cat.jwt, room, [user(dee)])).body.error, "conversation_not_member", "members invite");
  assert.deepEqual((ok(await invite(ben.jwt, room, [user(cat), agent(deeBot)])).members_added as Row[]).length, 2);
  const group = await opened(ann.jwt, [user(ben), user(dee)]);
  assert.equal((await invite(ann.jwt, String(group.conversation_id), [user(cat)])).body.error, "conversation_members_fixed");
  assert.equal((await invite(ann.jwt, g, [user(cat)])).body.error, "conversation_members_fixed");

  const remove = (bearer: string, member: Row) => send(bearer, { kind: "conversation_remove", conversation_id: room, member });
  assert.deepEqual([(await remove(ben.jwt, user(cat))).status], [403], "a plain member does not remove");
  assert.equal(ok(await remove(ann.jwt, user(cat))).changed, true, "the channel's creator does");
  assert.equal(ok(await remove(dee.jwt, agent(deeBot))).changed, true, "and so does a workspace admin");
  assert.equal((await remove(dee.jwt, agent(deeBot))).body.error, "conversation_not_member");

  const lock = `c2a-lock-${randomBytes(4).toString("hex")}`;
  const priv = String(((ok(await send(ann.jwt, { kind: "channel_create", slug: lock, visibility: "private",
    members: [user(ben)] })).channel as Row).channel_id));
  assert.equal((await join(ben.jwt, priv)).body.error, "conversation_private_channel", "private channels keep their own commands");
  assert.equal((await join(cat.jwt, priv)).status, 404, "and stay invisible to others");

  // Read marks: #general goes to both tables, and they agree.
  const message = await posted(ben.jwt);
  const marked = ok(await send(ann.jwt, { kind: "conversation_mark_read", conversation_id: g, through_signal_id: message }));
  const [{ same }] = await sql<{ same: boolean }[]>`SELECT
    (SELECT (read_through_at, read_through_id) FROM swarm.human_channel_reads WHERE workspace_id = ${workspace}::uuid
       AND user_id = ${ann.id}::uuid AND channel_id IS NULL)
    IS NOT DISTINCT FROM
    (SELECT (read_through_at, read_through_id) FROM swarm.conversation_reads WHERE conversation_id = ${g}::uuid
       AND member_user_id = ${ann.id}::uuid) AS same`;
  assert.equal(same, true);
  assert.equal(typeof marked.read_through_at, "string");
  ok(await send(ben.jwt, { kind: "mark_channel_read", channel_id: null }));
  const [{ followed }] = await sql<{ followed: boolean }[]>`SELECT EXISTS (SELECT 1 FROM swarm.conversation_reads
    WHERE conversation_id = ${g}::uuid AND member_user_id = ${ben.id}::uuid AND read_through_at IS NOT NULL) AS followed`;
  assert.equal(followed, true, "today's mark_channel_read is followed into conversation_reads");
  assert.equal((await send(cat.jwt, { kind: "conversation_mark_read", conversation_id: String(dm.conversation_id) })).status, 404);

  const muted = ok(await send(ann.jwt, { kind: "conversation_set_notify", conversation_id: String(dm.conversation_id), notify_level: "muted" }));
  assert.equal(muted.notify_level, "muted", "muting a 1:1 changes its notifications");
  assert.equal(ok(await send(ann.jwt, { kind: "conversation_set_notify", conversation_id: g, starred: true })).starred, true);
  assert.equal((await send(ann.jwt, { kind: "conversation_set_notify", conversation_id: g })).status, 400);
  assert.equal((await send(ann.jwt, { kind: "conversation_set_notify", conversation_id: g, notify_level: "loud" })).status, 400);
});

test("post_signal with conversation_id: the route rule, and every other address refused beside it", { timeout: 90_000 }, async () => {
  const group = await opened(ann.jwt, [user(ben), agent(annBot), agent(deeBot)]);
  const id = String(group.conversation_id);
  const fromPerson = await posted(ann.jwt, { conversation_id: id });
  assert.deepEqual(await filed(fromPerson), { conversation: id, audience: "conversation" });
  assert.deepEqual(await deliveredTo(fromPerson), [annBot.id, deeBot.id].sort(), "a person's post wakes every agent in it");
  const named = await posted(annBot.token, { conversation_id: id, to: [agent(deeBot)] });
  assert.deepEqual(await deliveredTo(named), [deeBot.id], "an agent's post wakes only the agents it names");
  const unnamed = await posted(annBot.token, { conversation_id: id });
  assert.deepEqual(await deliveredTo(unnamed), []);
  const [{ people }] = await sql<{ people: string[] }[]>`SELECT array_agg(recipient_user_id::text ORDER BY recipient_user_id)
    FILTER (WHERE recipient_user_id IS NOT NULL) AS people FROM swarm.signal_recipients WHERE signal_id = ${unnamed}::uuid`;
  assert.deepEqual(people ?? [], [ann.id, ben.id].sort(), "and still goes to every person in it");

  const outsider = await send(annBot.token, note({ conversation_id: id, to: [user(cat)] }));
  assert.equal(outsider.body.error, "conversation_not_member");
  assert.equal((await send(ann.jwt, note({ conversation_id: id, mentions: [agent(annBot)] }))).body.error, "conversation_mentions");
  assert.equal((await send(ann.jwt, note({ conversation_id: id, signal_kind: "working-on" }))).status, 400);
  for (const extra of [{ channel: "general" }, { to_user_id: ben.id }, { in_reply_to: fromPerson }, { thread_root_id: fromPerson, broadcast_to_channel: true }, { conversation_id: "nope" }]) {
    assert.equal((await send(ann.jwt, note({ conversation_id: id, ...extra }))).status, 400, JSON.stringify(extra));
  }
  const unknown = await send(ann.jwt, note({ conversation_id: randomUUID() }));
  const stranger = await send(cat.jwt, note({ conversation_id: id }));
  assert.deepEqual([stranger.status, stranger.body], [404, unknown.body], "a group one is not in answers as an unknown id");

  const [{ g }] = await sql<{ g: string }[]>`SELECT conversation_id::text AS g FROM swarm.conversations
    WHERE workspace_id = ${workspace}::uuid AND kind = 'general'`;
  const inGeneral = await posted(ben.jwt, { conversation_id: g });
  assert.deepEqual(await filed(inGeneral), { conversation: g, audience: "conversation" });
  const slug = `c2a-post-${randomBytes(4).toString("hex")}`;
  const room = String(((ok(await send(ann.jwt, { kind: "channel_create", slug })).channel as Row).channel_id));
  const inRoom = await posted(ben.jwt, { conversation_id: room });
  assert.deepEqual(await filed(inRoom), { conversation: room, audience: "conversation" });
  const dm = await opened(ben.jwt, [user(cat)]);
  const direct = await posted(cat.jwt, { conversation_id: String(dm.conversation_id) });
  assert.deepEqual(await filed(direct), { conversation: dm.conversation_id, audience: "conversation" });
  const [{ to }] = await sql<{ to: string }[]>`SELECT to_user_id::text AS to FROM swarm.signals WHERE id = ${direct}::uuid`;
  assert.equal(to, ben.id, "an old client reads it as addressed to the other person");
});

test("frames reach each member's own topic only: not the workspace topic, a member who left, an owner or admin outside, or anyone for a refused post", { timeout: 120_000 }, async () => {
  const onWorkspace = await listen("workspace topic", ben.jwt, `cswarm-signals:${workspace}`);
  const people: Array<[string, Person]> = [["ann", ann], ["ben", ben], ["cat", cat], ["dee", dee]];
  const sockets: Record<string, Listener> = {};
  for (const [name, p] of people) sockets[name] = await listen(name, p.jwt, `cswarm-member:${workspace}:${p.id}`);
  const counts = () => Object.fromEntries(Object.entries(sockets).map(([n, l]) => [n, l.frames.length]));
  const quiet = async (label: string, at: Record<string, number>, heard: string[]) => {
    await delay(3_000);
    const now = counts();
    for (const name of Object.keys(sockets)) {
      if (!heard.includes(name)) assert.equal(now[name], at[name], `${label}: ${name} hears nothing`);
    }
    assert.equal(onWorkspace.frames.length, 0, `${label}: the workspace topic hears nothing`);
  };

  // A 1:1 between ann and ben: both hear, nobody else does.
  const dm = String((await opened(ann.jwt, [user(ben)])).conversation_id);
  let at = counts();
  await posted(ann.jwt, { conversation_id: dm });
  await framesArrive([sockets.ann!, sockets.ben!], [at.ann!, at.ben!], "a 1:1 post");
  await quiet("a 1:1 post", at, ["ann", "ben"]);
  for (const frame of sockets.ben!.frames) assert.deepEqual(Object.keys(frame as Row).filter((k) => k !== "id"), ["v"]);

  // dee is an admin and owns deeBot; neither makes her a reader of ann's 1:1 with deeBot.
  const withBot = String((await opened(ann.jwt, [agent(deeBot)])).conversation_id);
  at = counts();
  await posted(ann.jwt, { conversation_id: withBot });
  await posted(deeBot.token, { conversation_id: withBot });
  await framesArrive([sockets.ann!], [at.ann! + 1], "ann hears both");
  await quiet("an agent's 1:1", at, ["ann"]);

  // A group: cat leaves, and from the next message on her socket, still open, hears nothing.
  const group = String((await opened(ann.jwt, [user(ben), user(cat)])).conversation_id);
  at = counts();
  await posted(ben.jwt, { conversation_id: group });
  await framesArrive([sockets.ann!, sockets.ben!, sockets.cat!], [at.ann!, at.ben!, at.cat!], "a group post");
  ok(await send(cat.jwt, { kind: "conversation_leave", conversation_id: group }));
  at = counts();
  await posted(ben.jwt, { conversation_id: group });
  await framesArrive([sockets.ann!, sockets.ben!], [at.ann!, at.ben!], "after cat left");
  await quiet("after cat left", at, ["ann", "ben"]);

  // A refused post: nothing anywhere.
  at = counts();
  assert.equal((await send(cat.jwt, note({ conversation_id: group }))).status, 404);
  assert.equal((await send(annBot.token, note({ conversation_id: group, to: [agent(deeBot)] }))).status, 404);
  await quiet("refused posts", at, []);

  // #general reaches everyone live; after cat leaves the workspace, her held socket hears nothing more.
  const [{ g }] = await sql<{ g: string }[]>`SELECT conversation_id::text AS g FROM swarm.conversations
    WHERE workspace_id = ${workspace}::uuid AND kind = 'general'`;
  at = counts();
  await posted(ann.jwt, { conversation_id: g });
  await framesArrive(Object.values(sockets), Object.keys(sockets).map((n) => at[n]!), "a #general post");
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp()
    WHERE workspace_id = ${workspace}::uuid AND user_id = ${cat.id}::uuid`;
  try {
    const [{ live }] = await sql<{ live: number }[]>`SELECT count(*)::int AS live FROM swarm.conversation_members
      WHERE workspace_id = ${workspace}::uuid AND member_user_id = ${cat.id}::uuid AND left_at IS NULL`;
    assert.equal(live, 0, "leaving the workspace leaves every conversation in it");
    at = counts();
    await posted(ann.jwt);
    await posted(ben.jwt);
    await framesArrive([sockets.ann!, sockets.ben!, sockets.dee!], [at.ann!, at.ben!, at.dee!], "after cat left the workspace");
    await quiet("after cat left the workspace", at, ["ann", "ben", "dee"]);
  } finally {
    await sql`UPDATE swarm.memberships SET revoked_at = NULL WHERE workspace_id = ${workspace}::uuid AND user_id = ${cat.id}::uuid`;
  }
  for (const l of [onWorkspace, ...Object.values(sockets)]) await l.client.removeChannel(l.channel);
});

test("a replay answers again only while its conversation is still open to the caller; a completed leave stays acknowledged", { timeout: 90_000 }, async () => {
  const hidden = await send(cat.jwt, { kind: "conversation_join", conversation_id: randomUUID() });
  assert.equal(hidden.status, 404);

  // A group: cat opens it, then leaves; dee stays.
  const catOpen = randomUUID();
  const opened = ok(await send(cat.jwt, { kind: "conversation_open", members: [user(dee), agent(deeBot)] }, catOpen));
  const group = String((opened.conversation as Row).conversation_id);
  const deeOpen = randomUUID();
  const deeFirst = ok(await send(dee.jwt, { kind: "conversation_open", members: [user(cat), agent(deeBot)] }, deeOpen));
  assert.deepEqual(ok(await send(cat.jwt, { kind: "conversation_open", members: [user(dee), agent(deeBot)] }, catOpen)), opened,
    "while she is in it, her replay answers what the first call did");
  // Posts to the group: a stored post names the members it went to.
  const catPost = randomUUID();
  const catNote = note({ conversation_id: group, body: "before leaving" });
  ok(await send(cat.jwt, catNote, catPost));
  const deePost = randomUUID();
  const deeNote = note({ conversation_id: group, body: "staying" });
  const deePosted = ok(await send(dee.jwt, deeNote, deePost));
  const catLeave = randomUUID();
  ok(await send(cat.jwt, { kind: "conversation_leave", conversation_id: group }, catLeave));
  const postReplay = await send(cat.jwt, catNote, catPost);
  assert.deepEqual([postReplay.status, postReplay.body], [404, hidden.body], "nor does her earlier post replay its recipients");
  const deeReplay = ok(await send(dee.jwt, deeNote, deePost));
  assert.deepEqual([(deeReplay.signal as Row).id, (deeReplay.signal as Row).recipients],
    [(deePosted.signal as Row).id, (deePosted.signal as Row).recipients], "dee's post replays, recipients and all");
  const replayed = await send(cat.jwt, { kind: "conversation_open", members: [user(dee), agent(deeBot)] }, catOpen);
  assert.deepEqual([replayed.status, replayed.body], [404, hidden.body],
    "after she left, the replay is the hidden-id refusal: no roster");
  assert.deepEqual(ok(await send(cat.jwt, { kind: "conversation_leave", conversation_id: group }, catLeave)),
    { status: "accepted", ok: true, event_ids: [], conversation_id: group }, "her own leave stays acknowledged, with nothing else");
  assert.deepEqual(ok(await send(dee.jwt, { kind: "conversation_open", members: [user(cat), agent(deeBot)] }, deeOpen)), deeFirst,
    "dee, still in it, replays in full");

  // A private channel: ben marks it read, then is removed from it; ann stays.
  const lock = `c2a-replay-${randomBytes(4).toString("hex")}`;
  const priv = String(((ok(await send(ann.jwt, { kind: "channel_create", slug: lock, visibility: "private",
    members: [user(ben)] })).channel as Row).channel_id));
  const benMark = randomUUID();
  const marked = ok(await send(ben.jwt, { kind: "conversation_mark_read", conversation_id: priv }, benMark));
  assert.equal(marked.kind, "private_channel");
  const annMark = randomUUID();
  const annFirst = ok(await send(ann.jwt, { kind: "conversation_mark_read", conversation_id: priv }, annMark));
  ok(await send(ann.jwt, { kind: "channel_member_remove", channel_id: priv, member: user(ben) }));
  const benReplay = await send(ben.jwt, { kind: "conversation_mark_read", conversation_id: priv }, benMark);
  assert.deepEqual([benReplay.status, benReplay.body], [404, hidden.body],
    "after his removal, no channel kind and no read time");
  assert.deepEqual(ok(await send(ann.jwt, { kind: "conversation_mark_read", conversation_id: priv }, annMark)), annFirst,
    "ann, still in it, replays in full");
});

test("a group someone left: the one who left is told so first; a member still in it, and today's picker, are told what to do", { timeout: 60_000 }, async () => {
  const set = [user(ben), user(dee), agent(deeBot)];
  const without = (p: Person) => set.filter((m) => m.id !== p.id);
  const group = await opened(ben.jwt, without(ben));
  ok(await send(dee.jwt, { kind: "conversation_leave", conversation_id: group.conversation_id }));

  const youLeft = { status: 409, error: "conversation_left",
    message: "You left this group. Ask a current member to start a new group with you." };
  const reopen = await send(dee.jwt, { kind: "conversation_open", members: without(dee) });
  assert.deepEqual({ status: reopen.status, ...reopen.body }, youLeft, "on the first open, without new_group");
  const restart = await send(dee.jwt, { kind: "conversation_open", members: without(dee), new_group: true });
  assert.deepEqual({ status: restart.status, ...restart.body }, youLeft, "and on the explicit restart");

  const stayed = await send(ben.jwt, { kind: "conversation_open", members: without(ben) });
  assert.deepEqual({ status: stayed.status, ...stayed.body }, { status: 409, error: "conversation_member_left",
    message: "Dee left this group. To include everyone again, start a new group." }, "a member still in it");

  const picker = await send(ben.jwt, note({ to: without(ben) }));
  assert.deepEqual({ status: picker.status, ...picker.body }, { status: 409, error: "conversation_member_left",
    message: "Someone left this group. Choose different recipients to send this message." }, "today's picker, with no name");
});

test("C1e: @Agent mentions typed in a group-DM body route into recipients without leaking or waking outsiders", { timeout: 90_000 }, async () => {
  const extraBot = await makeAgent(ben, "c1e-extra");
  const outsiderBot = await makeAgent(cat, "c1e-outsider");
  const sharedName = `SharedBot-${randomBytes(3).toString("hex")}`;
  const inGroupShared = await makeAgent(ann, "c1e-shared-in", sharedName);
  const outGroupShared = await makeAgent(cat, "c1e-shared-out", sharedName);

  // 1) Human + agents group DM: @deeBot in body wakes deeBot without explicit `to`, and keeps human recipients.
  const mixed = await opened(ann.jwt, [user(ben), agent(annBot), agent(deeBot), agent(extraBot), agent(inGroupShared)], { new_group: true });
  const mixedId = String(mixed.conversation_id);
  const bodyMention = await posted(annBot.token, { conversation_id: mixedId, body: `Hey @${deeBot.name}, please review this.` });
  assert.deepEqual(await filed(bodyMention), { conversation: mixedId, audience: "conversation" });
  assert.deepEqual(await deliveredTo(bodyMention), [deeBot.id], "body @Agent wakes only the mentioned peer agent");
  const [{ people }] = await sql<{ people: string[] }[]>`SELECT array_agg(recipient_user_id::text ORDER BY recipient_user_id)
    FILTER (WHERE recipient_user_id IS NOT NULL) AS people FROM swarm.signal_recipients WHERE signal_id = ${bodyMention}::uuid`;
  assert.deepEqual(people ?? [], [ann.id, ben.id].sort(), "and still delivers to every human in the group");

  // 2) Thread reply inside the group DM also resolves @Agent mentions in body.
  const threadMention = await posted(annBot.token, {
    conversation_id: mixedId,
    thread_root_id: bodyMention,
    body: `Looping in @${extraBot.name} on this thread.`,
  });
  assert.deepEqual(await deliveredTo(threadMention), [extraBot.id], "group DM thread reply resolves @Agent in body");

  // 3) Explicit `to` + body @Agent merge without duplicates.
  const merged = await posted(annBot.token, {
    conversation_id: mixedId,
    to: [agent(extraBot)],
    body: `Both @${extraBot.name} and @${deeBot.name} please check.`,
  });
  assert.deepEqual(await deliveredTo(merged), [deeBot.id, extraBot.id].sort(), "explicit to and body @Agent merge cleanly");

  // 4) Self mention and outsider mention never wake self or outsider.
  const selfAndOutsider = await posted(annBot.token, {
    conversation_id: mixedId,
    body: `Note mentioning @${annBot.name} and @${outsiderBot.name} only.`,
  });
  assert.deepEqual(await deliveredTo(selfAndOutsider), [], "self and non-member @Agent mentions wake zero agents");

  // 5) Same name in workspace (one inside group, one outside) resolves unambiguously to the in-group agent.
  const disambByMembership = await posted(annBot.token, {
    conversation_id: mixedId,
    body: `Checking with @${sharedName} here.`,
  });
  assert.deepEqual(await deliveredTo(disambByMembership), [inGroupShared.id],
    "outsider with colliding name never shadows or makes in-group @Agent ambiguous");
  assert.ok(!(await deliveredTo(disambByMembership)).includes(outGroupShared.id));

  // 6) Agent-only group DM: @deeBot in body succeeds without explicit `to`; no mention returns 409 conversation_no_recipients.
  const agentsOnly = await opened(annBot.token, [agent(deeBot), agent(extraBot)], { new_group: true });
  const agentsOnlyId = String(agentsOnly.conversation_id);
  const agentOnlyNoTarget = await send(annBot.token, note({ conversation_id: agentsOnlyId, body: "Status without mention" }));
  assert.equal(agentOnlyNoTarget.status, 409);
  assert.equal(agentOnlyNoTarget.body.error, "conversation_no_recipients");
  const agentOnlyMention = await posted(annBot.token, { conversation_id: agentsOnlyId, body: `@${deeBot.name} can you handle this?` });
  assert.deepEqual(await deliveredTo(agentOnlyMention), [deeBot.id], "agent-only group DM routes via body @Agent");

  // 7) Stranger agent posting with @Agent gets exact 404 matching unknown conversation (zero oracle).
  const unknown = await send(outsiderBot.token, note({ conversation_id: randomUUID(), body: `@${deeBot.name} hi` }));
  const stranger = await send(outsiderBot.token, note({ conversation_id: mixedId, body: `@${deeBot.name} hi` }));
  assert.deepEqual([stranger.status, stranger.body], [404, unknown.body], "non-member agent gets non-leaking 404");

  // 8) Two live agents sharing a name inside the SAME group DM refuse with 400 mention_ambiguous
  //    naming only those two in-group IDs; explicit `to` disambiguates cleanly.
  //    An outside workspace admin/owner reading swarm_read.audit_log sees only a general audit reason
  //    (never mention_ambiguous or any group-private name/ID).
  const dupGroup = await opened(annBot.token, [agent(inGroupShared), agent(outGroupShared)], { new_group: true });
  const dupGroupId = String(dupGroup.conversation_id);
  const [{ mark: auditBefore }] = await sql<{ mark: string }[]>`
    SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`;
  const ambiguous = await send(annBot.token, note({ conversation_id: dupGroupId, body: `Ping @${sharedName}` }));
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error, "mention_ambiguous");
  assert.ok(String(ambiguous.body.message).includes(inGroupShared.id));
  assert.ok(String(ambiguous.body.message).includes(outGroupShared.id));
  for (const outsideAuditor of [
    { label: "outside admin (dee)", id: dee.id },
    { label: "outside owner (ann)", id: ann.id },
  ]) {
    const auditRows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: outsideAuditor.id, role: "authenticated" })}, true)`;
      await tx.unsafe("SET LOCAL ROLE authenticated");
      return await tx<{ outcome: string; reason: string | null; detail: string | null }[]>`
        SELECT outcome, reason, detail FROM swarm_read.audit_log
        WHERE workspace_id = ${workspace}::uuid
          AND command_kind = 'post_signal'
          AND actor_agent_principal = ${annBot.id}::uuid
          AND audit_id > ${auditBefore}::bigint
        ORDER BY audit_id`;
    });
    assert.equal(auditRows.length, 1, `${outsideAuditor.label} sees one refusal audit row`);
    assert.deepEqual(
      { outcome: auditRows[0]!.outcome, reason: auditRows[0]!.reason, detail: auditRows[0]!.detail },
      { outcome: "domain", reason: "invalid_request", detail: null },
      `${outsideAuditor.label} sees only general audit reason without group-ambiguity disclosure`,
    );
    const serialized = JSON.stringify(auditRows);
    assert.ok(!serialized.includes("mention_ambiguous"));
    assert.ok(!serialized.includes(sharedName));
    assert.ok(!serialized.includes(dupGroupId));
    assert.ok(!serialized.includes(inGroupShared.id));
    assert.ok(!serialized.includes(outGroupShared.id));
  }
  const byExplicitTo = await posted(annBot.token, {
    conversation_id: dupGroupId,
    to: [agent(outGroupShared)],
    body: `Ping @${sharedName}`,
  });
  assert.deepEqual(await deliveredTo(byExplicitTo), [outGroupShared.id], "explicit to disambiguates colliding in-group name");
});
