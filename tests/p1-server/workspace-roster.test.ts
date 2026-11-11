/** Roster R1a: swarm_read.workspace_roster derives each agent's row from recorded activity,
 * counts others' open asks without exposing them, and admits only a live member or agent of
 * that workspace. Calls the definer the way the read function does: role swarm_read with the
 * owner's claims. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

let sql: postgres.Sql;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as { DB_URL?: string };
  assert.ok(status.DB_URL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.DB_URL).hostname));
  sql = postgres(status.DB_URL, { prepare: false, max: 2 });
});

after(async () => { await sql.end(); });

interface Roster {
  workspace_id: string;
  truncated: boolean;
  agents: Array<Record<string, unknown> & {
    principal_id: string; name: string; status: string;
    open_work: { since: string; text: string | null } | null;
    waiting_on_people: { count: number; since: string | null };
  }>;
}

async function person(name: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO auth.users (id, aud, role, email) VALUES (${id}::uuid, 'authenticated', 'authenticated', ${`roster-${id}@example.test`})`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${name})`;
  return id;
}

async function workspace(owner: string, name: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${id}::uuid, ${name}, ${owner}::uuid)`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${id}::uuid, ${owner}::uuid, 'owner')`;
  await sql`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${id}::uuid, 'workspace')`;
  return id;
}

async function agent(ws: string, owner: string, name: string, hosted = false): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
    VALUES (${id}::uuid, ${ws}::uuid, ${owner}::uuid, ${name}, ${hosted ? "hosted_mcp" : "local"}, ${hosted})`;
  return id;
}

async function signal(ws: string, from: { kind: "user" | "agent"; id: string }, kind: "ask" | "note" | "working-on", body: string,
  opts: { toUser?: string; toAgent?: string; recipients?: string[]; replyTo?: string; ago?: string; expired?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const ago = opts.ago ?? "1 minute";
  // The recipient guard requires recipient 0 to be the row's own scalar addressee.
  const toUser = opts.toUser ?? opts.recipients?.[0] ?? null;
  // Recipients can be added only in the transaction that creates the signal.
  await sql.begin(async (tx) => {
  await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to, kind, body, until, created_at)
    VALUES (${id}::uuid, ${ws}::uuid, ${from.id}::uuid, ${from.kind}, ${toUser}, ${opts.toAgent ?? null}, ${opts.replyTo ?? null},
      ${kind}, ${body},
      ${opts.expired ? tx`statement_timestamp() - ${ago}::interval + interval '1 second'` : tx`statement_timestamp() + interval '1 day'`},
      statement_timestamp() - ${ago}::interval)`;
  for (const [position, user] of (opts.recipients ?? []).entries()) {
    await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
      VALUES (${id}::uuid, ${ws}::uuid, ${user}::uuid, ${position})`;
  }
  });
  return id;
}

/** As the read function does: swarm_read, the owner's claims, and the calling agent if any. */
async function roster(ws: string, owner: string, callingAgent?: string): Promise<Roster | null> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_read`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({
      sub: owner, role: "authenticated", ...(callingAgent ? { agent_principal_id: callingAgent } : {}),
    })}, true)`;
    const [row] = await tx<{ roster: Roster | null }[]>`SELECT swarm_read.workspace_roster(${ws}::uuid) AS roster`;
    return row!.roster;
  });
}

test("asks to people are counted once, with no ids, text or recipients; answered, expired and agent-only asks are not", async () => {
  const owner = await person("Owner");
  const helper = await person("Helper");
  const ws = await workspace(owner, "Roster test");
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${helper}::uuid, 'member')`;
  const asker = await agent(ws, owner, "Asker");
  const other = await agent(ws, owner, "Other");
  const helperAgent = await agent(ws, helper, "Helper's agent");
  const from = { kind: "agent" as const, id: asker };

  // Open: addressed to two people at once, counted once; the oldest sets since.
  await signal(ws, from, "ask", "PRIVATE-ASK-TWO-PEOPLE", { recipients: [owner, helper], ago: "40 minutes" });
  await signal(ws, from, "ask", "PRIVATE-ASK-DIRECT", { toUser: owner, ago: "5 minutes" });
  // Not open: answered by the person, answered by the person's own agent, expired, to an agent only.
  const answered = await signal(ws, from, "ask", "PRIVATE-ANSWERED", { toUser: owner, ago: "2 hours" });
  await signal(ws, { kind: "user", id: owner }, "note", "done", { toAgent: asker, replyTo: answered });
  const answeredByAgent = await signal(ws, from, "ask", "PRIVATE-ANSWERED-BY-AGENT", { toUser: helper, ago: "3 hours" });
  await signal(ws, { kind: "agent", id: helperAgent }, "note", "handled", { toAgent: asker, replyTo: answeredByAgent });
  await signal(ws, from, "ask", "PRIVATE-EXPIRED", { toUser: owner, ago: "4 hours", expired: true });
  await signal(ws, from, "ask", "PRIVATE-AGENT-ONLY", { toAgent: other, ago: "6 hours" });

  const result = await roster(ws, owner, other);
  assert.ok(result);
  const row = result.agents.find((entry) => entry.principal_id === asker)!;
  assert.equal(row.waiting_on_people.count, 2);
  const oldest = Date.parse(row.waiting_on_people.since!);
  assert.ok(Math.abs(Date.now() - 40 * 60_000 - oldest) < 60_000, "since is the oldest open ask");
  const otherRow = result.agents.find((entry) => entry.principal_id === other)!;
  assert.deepEqual(otherRow.waiting_on_people, { count: 0, since: null });
  const text = JSON.stringify(result);
  assert.equal(/PRIVATE-/.test(text), false, "no ask text");
  // The exact key set: no ask ids, recipients or per-person breakdown on any row.
  assert.deepEqual(Object.keys(row).sort(), ["connection", "job", "last_activity_at", "name", "open_work", "owner", "parent",
    "platform", "principal_id", "reports_to", "source", "status", "transport", "turn_only", "waiting_on_people"]);
});

test("working-on text appears only for a workspace-wide broadcast; addressed or channel-scoped work shows its time only", async () => {
  const owner = await person("Owner");
  const helper = await person("Helper");
  const ws = await workspace(owner, "Work test");
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${helper}::uuid, 'member')`;
  const broadcaster = await agent(ws, owner, "Broadcaster");
  const toPerson = await agent(ws, owner, "To a person");
  const toRecipients = await agent(ws, owner, "To recipients");
  const replying = await agent(ws, owner, "Replying");
  const quiet = await agent(ws, owner, "No work");

  await signal(ws, { kind: "agent", id: broadcaster }, "working-on", "older broadcast", { ago: "10 minutes" });
  await signal(ws, { kind: "agent", id: broadcaster }, "working-on", "shipping the roster");
  await signal(ws, { kind: "agent", id: toPerson }, "working-on", "SECRET-ADDRESSED", { toUser: helper });
  await signal(ws, { kind: "agent", id: toRecipients }, "working-on", "SECRET-RECIPIENTS", { recipients: [helper] });
  const root = await signal(ws, { kind: "user", id: owner }, "note", "thread root", { toAgent: replying, ago: "5 minutes" });
  await signal(ws, { kind: "agent", id: replying }, "working-on", "SECRET-REPLY", { replyTo: root, toUser: owner });

  const result = (await roster(ws, owner))!;
  const by = (id: string) => result.agents.find((entry) => entry.principal_id === id)!;
  assert.equal(by(broadcaster).open_work!.text, "shipping the roster");
  for (const id of [toPerson, toRecipients, replying]) {
    assert.equal(by(id).open_work!.text, null);
    assert.ok(Date.parse(by(id).open_work!.since) > 0, "an addressed working-on still supplies its time");
  }
  assert.equal(by(quiet).open_work, null);
  assert.equal(/SECRET-/.test(JSON.stringify(result)), false);
});

test("only a live member or an admitted agent of that workspace gets rows", async () => {
  const owner = await person("Owner");
  const stranger = await person("Stranger");
  const ws = await workspace(owner, "Gate test");
  const elsewhere = await workspace(stranger, "Elsewhere");
  const own = await agent(ws, owner, "Own agent");
  const foreign = await agent(elsewhere, stranger, "Foreign agent");
  const removed = await agent(ws, owner, "Removed agent");
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${removed}::uuid`;

  assert.ok((await roster(ws, owner, own))?.agents.some((entry) => entry.principal_id === own), "control: own agent reads");
  assert.equal(await roster(ws, stranger), null, "a non-member gets nothing");
  assert.equal(await roster(ws, stranger, foreign), null, "an agent of another workspace gets nothing");
  assert.equal(await roster(ws, owner, foreign), null, "claims cannot pair this owner with another workspace's agent");
  assert.equal(await roster(ws, owner, removed), null, "a removed agent gets nothing");
  assert.equal((await roster(ws, owner))!.agents.some((entry) => entry.principal_id === removed), false, "removed agents are not listed");
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${ws}::uuid AND user_id = ${owner}::uuid`;
  assert.equal(await roster(ws, owner, own), null, "a removed member's agent gets nothing");
});

test("the roster stops at 200 agents and says so", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Big test");
  for (let n = 0; n < 201; n += 1) await agent(ws, owner, `Agent ${n}`);
  const result = (await roster(ws, owner))!;
  assert.equal(result.agents.length, 200);
  assert.equal(result.truncated, true);
});

test("status follows the app's order and thresholds", async () => {
  const cases: Array<[string, string, boolean, string | null, string | null, string]> = [
    ["key_off", "local", true, "20 minutes", "1 minute", "off"],
    ["connection_off", "hosted_mcp", false, null, "1 minute", "off"],
    ["live", "local", true, "4 minutes", "1 minute", "not_picking_up"],
    ["live", "local", true, "2 minutes", "1 minute", "active"],
    ["live", "local", false, "20 minutes", "1 minute", "active"],
    ["live", "hosted_mcp", true, "20 minutes", "1 minute", "active"],
    ["live", "local", false, null, "11 minutes", "idle"],
    ["live", "local", false, null, "2 days", "idle"],
    ["live", "local", false, null, "4 days", "inactive"],
    ["live", "local", false, null, null, "inactive"],
  ];
  for (const [connection, transport, wake, waitingAgo, activityAgo, expected] of cases) {
    const [row] = await sql<{ status: string }[]>`SELECT swarm_read.roster_status(${connection}, ${transport}, ${wake},
      ${waitingAgo === null ? null : sql`statement_timestamp() - ${waitingAgo}::interval`},
      ${activityAgo === null ? null : sql`statement_timestamp() - ${activityAgo}::interval`}, statement_timestamp()) AS status`;
    assert.equal(row!.status, expected, JSON.stringify({ connection, transport, wake, waitingAgo, activityAgo }));
  }
});

test("connection state matches home_overview's for the same agents", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Connection test");
  const local = await agent(ws, owner, "Local");
  const hosted = await agent(ws, owner, "Hosted", true);
  const rows = (await roster(ws, owner))!.agents;
  const overview = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated" })}, true)`;
    const [row] = await tx<{ overview: { workspaces: Array<{ workspace_id: string; people: Array<{ agents: Array<{ principal_id: string; status: { facts: { connection: string } } }> }> }> } }[]>`
      SELECT swarm_read.home_overview() AS overview`;
    return row!.overview;
  });
  const home = overview.workspaces.find((entry) => entry.workspace_id === ws)!;
  const homeConnection = new Map(home.people.flatMap((p) => p.agents).map((a) => [a.principal_id, a.status.facts.connection]));
  for (const id of [local, hosted]) {
    assert.equal(rows.find((entry) => entry.principal_id === id)!.connection, homeConnection.get(id), id);
  }
});

/** Roster R1b: the person's own queue, read the way the web app reads it (PostgREST role
 * authenticated with that person's claims). */
async function queue(ws: string, viewer: string, extraClaims: Record<string, unknown> = {}, role = "authenticated"): Promise<{
  total: number; truncated: boolean;
  asks: Array<{ signal_id: string; body: string; from: { kind: string; id: string; name: string | null }; reraised: unknown }>;
} | null> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewer, role: "authenticated", ...extraClaims })}, true)`;
    const [row] = await tx<{ queue: never }[]>`SELECT swarm_read.decision_queue(${ws}::uuid) AS queue`;
    return row!.queue;
  });
}

test("the asking agent's own follow-up never answers its ask, on the roster and the queue", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Self-reply test");
  const asker = await agent(ws, owner, "Asker");
  const ask = await signal(ws, { kind: "agent", id: asker }, "ask", "PICK-A-DATE", { toUser: owner, ago: "10 minutes" });
  await signal(ws, { kind: "agent", id: asker }, "note", "more context", { toUser: owner, replyTo: ask });

  const row = (await roster(ws, owner, asker))?.agents.find((entry) => entry.principal_id === asker);
  assert.equal(row?.waiting_on_people.count, 1, "the roster still counts the ask");
  const listed = await queue(ws, owner);
  assert.deepEqual(listed?.asks.map((entry) => entry.signal_id), [ask], "the queue still lists it");

  // The person's own answer closes it everywhere.
  await signal(ws, { kind: "user", id: owner }, "note", "Tuesday", { toAgent: asker, replyTo: ask });
  assert.equal((await roster(ws, owner, asker))?.agents.find((entry) => entry.principal_id === asker)?.waiting_on_people.count, 0);
  assert.deepEqual((await queue(ws, owner))?.asks, []);
});

test("decision_queue: the person's own open asks, oldest first; never for an agent's claims or a non-member", async () => {
  const owner = await person("Owner");
  const helper = await person("Helper");
  const outsider = await person("Outsider");
  const ws = await workspace(owner, "Queue test");
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${helper}::uuid, 'member')`;
  const asker = await agent(ws, helper, "Helper's agent");
  const from = { kind: "agent" as const, id: asker };
  const newer = await signal(ws, from, "ask", "NEWER", { toUser: owner, ago: "5 minutes" });
  const older = await signal(ws, from, "ask", "OLDER", { recipients: [owner, helper], ago: "2 hours" });
  await signal(ws, from, "ask", "FOR-HELPER-ONLY", { toUser: helper, ago: "1 hour" });
  await signal(ws, from, "ask", "EXPIRED", { toUser: owner, ago: "3 hours", expired: true });
  const answered = await signal(ws, from, "ask", "ANSWERED", { toUser: owner, ago: "4 hours" });
  await signal(ws, { kind: "user", id: owner }, "note", "done", { toAgent: asker, replyTo: answered });

  const listed = await queue(ws, owner);
  assert.ok(listed);
  assert.deepEqual(listed.asks.map((entry) => entry.signal_id), [older, newer], "oldest first; only this person's open asks");
  assert.equal(listed.total, 2);
  assert.equal(listed.truncated, false);
  assert.equal(listed.asks[0]!.body, "OLDER");
  assert.deepEqual(listed.asks[0]!.from, { kind: "agent", id: asker, name: "Helper's agent" });
  assert.equal(listed.asks[0]!.reraised, null);

  // An agent's claims (sub is its owner) are never a person; neither is an outsider.
  assert.equal(await queue(ws, owner, { agent_principal_id: asker }), null);
  assert.equal(await queue(ws, outsider), null);
  // The read and command roles can't execute it at all.
  for (const role of ["swarm_read", "swarm_command"]) {
    await assert.rejects(() => queue(ws, owner, {}, role), /permission denied/);
  }
});

/* -------------------------------------------------------------------------
 * Channels C3: swarm_read.channel_messages returns only messages every member
 * can already read: whole-workspace, unexpired, filed in that channel, and for
 * a thread reply a root that is whole-workspace too. Called the way the read
 * function calls it (swarm_read, the owner's claims plus the agent).
 * ------------------------------------------------------------------------- */

type ChannelPage = { channel: string; archived: boolean; next: { after_id: string } | null;
  messages: Array<{ signal_id: string; body: string; thread_root_id: string | null }>; error?: string } | null;

async function channelPage(ws: string, owner: string, agentId: string, channel: string,
  after: { after_id: string } | null = null, limit = 50): Promise<ChannelPage> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_read`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated", agent_principal_id: agentId })}, true)`;
    const [row] = await tx<{ page: ChannelPage }[]>`SELECT swarm_read.channel_messages(${ws}::uuid, ${channel},
      ${after?.after_id ?? null}::uuid, ${limit}) AS page`;
    return row!.page;
  });
}

async function filed(ws: string, from: string, body: string, opts: { channel?: string | null; thread?: string; toUser?: string; recipients?: string[]; ago?: string } = {}): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, created_at, channel_id, thread_root_id)
      VALUES (${id}::uuid, ${ws}::uuid, ${from}::uuid, 'agent', ${opts.toUser ?? opts.recipients?.[0] ?? null}, 'note', ${body},
        statement_timestamp() + interval '1 day', statement_timestamp() - ${opts.ago ?? "1 minute"}::interval,
        ${opts.channel ?? null}, ${opts.thread ?? null})`;
    for (const [position, user] of (opts.recipients ?? []).entries()) {
      await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES (${id}::uuid, ${ws}::uuid, ${user}::uuid, ${position})`;
    }
  });
  return id;
}

test("channel_messages: whole-workspace messages in that channel only, never addressed ones or their threads", async () => {
  const owner = await person("Owner");
  const helper = await person("Helper");
  const ws = await workspace(owner, "Channel read test");
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${helper}::uuid, 'member')`;
  const reader = await agent(ws, owner, "Reader");
  const writer = await agent(ws, helper, "Writer");
  const [design] = await sql<{ channel_id: string }[]>`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at)
    VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'design', ${owner}::uuid, 'user', statement_timestamp()) RETURNING channel_id`;
  const channelId = design!.channel_id;

  const open = await filed(ws, writer, "OPEN-IN-DESIGN", { channel: channelId, ago: "3 minutes" });
  const threadOk = await filed(ws, writer, "THREAD-OK", { channel: channelId, thread: open, ago: "2 minutes" });
  await filed(ws, writer, "DIRECT-TO-HELPER", { channel: channelId, toUser: helper });
  await filed(ws, writer, "TO-RECIPIENTS", { channel: channelId, recipients: [helper] });
  const privateRoot = await filed(ws, writer, "PRIVATE-ROOT", { channel: channelId, toUser: owner });
  await filed(ws, writer, "REPLY-UNDER-PRIVATE-ROOT", { channel: channelId, thread: privateRoot });
  const unfiled = await filed(ws, writer, "UNFILED", {});

  const page = await channelPage(ws, owner, reader, "design");
  assert.deepEqual(page?.messages.map((m) => m.signal_id), [open, threadOk]);
  assert.equal(JSON.stringify(page).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(page).includes("DIRECT"), false);
  assert.equal(JSON.stringify(page).includes("RECIPIENTS"), false);
  assert.deepEqual((await channelPage(ws, owner, reader, "general"))?.messages.map((m) => m.signal_id), [unfiled],
    "general alone is the unfiled channel");
  assert.equal((await channelPage(ws, owner, reader, "missing"))?.error, "channel_not_found");

  // Paging: one row at a time, oldest first, with a cursor.
  const first = await channelPage(ws, owner, reader, "design", null, 1);
  assert.deepEqual(first?.messages.map((m) => m.signal_id), [open]);
  assert.ok(first?.next);
  const second = await channelPage(ws, owner, reader, "design", first!.next, 1);
  assert.deepEqual(second?.messages.map((m) => m.signal_id), [threadOk]);
  assert.equal(second?.next, null);

  // The cursor must be a message this read returns: a private id, another channel's message and an
  // unknown id all get the same refusal, with no ordering metadata.
  for (const cursor of [privateRoot, unfiled, randomUUID()]) {
    const refused = await channelPage(ws, owner, reader, "design", { after_id: cursor });
    assert.deepEqual(refused, { error: "cursor_not_found" });
  }

  // An agent of another workspace, or a removed one, reads nothing.
  const elsewhere = await workspace(owner, "Other workspace");
  const outsider = await agent(elsewhere, owner, "Outsider");
  assert.equal(await channelPage(ws, owner, outsider, "design"), null);
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${reader}::uuid`;
  assert.equal(await channelPage(ws, owner, reader, "design"), null);
});

/* -------------------------------------------------------------------------
 * Channels C1b: swarm_read.channel_unread, the person's own per-channel unread
 * from the seen receipts the app writes. Read the way the web app reads it.
 * ------------------------------------------------------------------------- */

type Unread = { channels: Array<{ channel_id: string | null; slug: string; unread: boolean | null }> } | null;

async function unread(ws: string, viewer: string, extraClaims: Record<string, unknown> = {}, role = "authenticated"): Promise<Unread> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewer, role: "authenticated", ...extraClaims })}, true)`;
    const [row] = await tx<{ unread: Unread }[]>`SELECT swarm_read.channel_unread(${ws}::uuid) AS unread`;
    return row!.unread;
  });
}

async function post(ws: string, from: { kind: "user" | "agent"; id: string }, channelId: string | null, ago = "1 minute"): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id)
    VALUES (${id}::uuid, ${ws}::uuid, ${from.id}::uuid, ${from.kind}, 'note', 'channel message',
      statement_timestamp() + interval '1 day', statement_timestamp() - ${ago}::interval, ${channelId})`;
  return id;
}

async function seen(ws: string, viewer: string, signalId: string, ago = "0 seconds"): Promise<void> {
  await sql`INSERT INTO swarm.signal_human_receipts (workspace_id, signal_id, user_id, first_seen_at)
    VALUES (${ws}::uuid, ${signalId}::uuid, ${viewer}::uuid, statement_timestamp() - ${ago}::interval)`;
}

test("channel_unread: unknown without receipts, unread until seen, unread again for a newer message", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Unread test");
  const writer = { kind: "agent" as const, id: await agent(ws, owner, "Writer") };
  const [design] = await sql<{ channel_id: string }[]>`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at)
    VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'design', ${owner}::uuid, 'user', statement_timestamp()) RETURNING channel_id`;
  const channelId = design!.channel_id;
  const state = async () => Object.fromEntries((await unread(ws, owner))!.channels.map((c) => [c.slug, c.unread]));

  const first = await post(ws, writer, null, "30 minutes");
  assert.deepEqual(await state(), { general: null, design: null }, "no receipts yet: unknown, never read");

  // The first receipt sets the read position; later messages are newer than it.
  await seen(ws, owner, first, "20 minutes");
  assert.deepEqual(await state(), { general: false, design: false });

  const inDesign = await post(ws, writer, channelId, "5 minutes");
  await post(ws, { kind: "user", id: owner }, null, "4 minutes");
  assert.deepEqual(await state(), { general: false, design: true }, "the person's own post never counts");

  await seen(ws, owner, inDesign);
  assert.deepEqual(await state(), { general: false, design: false });
  await post(ws, writer, channelId, "1 minute");
  assert.deepEqual(await state(), { general: false, design: true }, "a newer message is unread again");
});

test("channel_unread is the person's own: never for an agent's claims, a non-member or the read roles", async () => {
  const owner = await person("Owner");
  const outsider = await person("Outsider");
  const ws = await workspace(owner, "Unread gate");
  const own = await agent(ws, owner, "Own");
  assert.equal(await unread(ws, owner, { agent_principal_id: own }), null);
  assert.equal(await unread(ws, outsider), null);
  for (const role of ["swarm_read", "swarm_command"]) {
    await assert.rejects(() => unread(ws, owner, {}, role), /permission denied/);
  }
});

/* -------------------------------------------------------------------------
 * Channels C1b for agents: swarm_read.agent_channel_unread, from the read
 * position swarm.agent_channel_read_advance keeps. Both called the way the read
 * function calls them: swarm_read, the owner's claims plus the agent.
 * ------------------------------------------------------------------------- */

async function asAgent<T>(ws: string, owner: string, agentId: string | null, run: (tx: postgres.TransactionSql) => Promise<T>,
  role = "swarm_read"): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated",
      ...(agentId === null ? {} : { agent_principal_id: agentId }) })}, true)`;
    return await run(tx);
  }) as T;
}

async function agentUnread(ws: string, owner: string, agentId: string | null, role = "swarm_read"): Promise<Record<string, boolean | null> | null> {
  return await asAgent(ws, owner, agentId, async (tx) => {
    const [row] = await tx<{ unread: Array<{ slug: string; unread: boolean | null }> | null }[]>`
      SELECT swarm_read.agent_channel_unread(${ws}::uuid) AS unread`;
    return row!.unread === null ? null : Object.fromEntries(row!.unread.map((c) => [c.slug, c.unread]));
  }, role);
}

async function advance(ws: string, owner: string, agentId: string, channel: string, through: string, role = "swarm_read"): Promise<void> {
  await asAgent(ws, owner, agentId, async (tx) => {
    await tx`SELECT swarm.agent_channel_read_advance(${ws}::uuid, ${channel}, ${through}::uuid)`;
  }, role);
}

async function readPosition(ws: string, agentId: string, channelId: string | null): Promise<string | null> {
  const [row] = await sql<{ read_through_id: string }[]>`SELECT read_through_id FROM swarm.agent_channel_reads
    WHERE workspace_id = ${ws}::uuid AND principal_id = ${agentId}::uuid AND channel_id IS NOT DISTINCT FROM ${channelId}::uuid`;
  return row?.read_through_id ?? null;
}

test("agent_channel_unread: unknown before any read, then unread only for newer whole-workspace messages from others", async () => {
  const owner = await person("Owner");
  const helper = await person("Helper");
  const ws = await workspace(owner, "Agent unread");
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${helper}::uuid, 'member')`;
  const reader = await agent(ws, owner, "Reader");
  const writer = await agent(ws, helper, "Writer");
  const [design] = await sql<{ channel_id: string }[]>`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at)
    VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'design', ${owner}::uuid, 'user', statement_timestamp()) RETURNING channel_id`;
  const channelId = design!.channel_id;

  assert.deepEqual(await agentUnread(ws, owner, reader), { general: null, design: null }, "no read position yet");
  // An empty first read, recorded an hour ago, starts the agent's unread before the messages below.
  await asAgent(ws, owner, reader, (tx) => tx`SELECT swarm.agent_channel_read_advance(${ws}::uuid, 'general', NULL)`);
  await sql`UPDATE swarm.agent_channel_reads SET first_read_at = statement_timestamp() - interval '1 hour'
    WHERE principal_id = ${reader}::uuid`;
  const older = await filed(ws, writer, "OLDER", { channel: channelId, ago: "10 minutes" });
  const newest = await filed(ws, writer, "NEWEST", { channel: channelId, ago: "9 minutes" });
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false, design: true });

  // Reading the older message leaves the newer one unread; reading through the newest clears it.
  await advance(ws, owner, reader, "design", older);
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false, design: true });
  await advance(ws, owner, reader, "design", newest);
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false, design: false });
  // Only forward: an older message never moves the position back.
  await advance(ws, owner, reader, "design", older);
  assert.equal(await readPosition(ws, reader, channelId), newest);

  // Messages channel_read never returns, and the agent's own, never make a channel unread.
  await filed(ws, writer, "DIRECT", { channel: channelId, toUser: helper });
  await filed(ws, writer, "TO-RECIPIENTS", { channel: channelId, recipients: [helper] });
  const privateRoot = await filed(ws, writer, "PRIVATE-ROOT", { channel: channelId, toUser: owner });
  await filed(ws, writer, "UNDER-PRIVATE-ROOT", { channel: channelId, thread: privateRoot });
  await filed(ws, reader, "OWN", { channel: channelId });
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false, design: false });

  // A thread reply channel_read returns does; so does an unfiled message, for general.
  const reply = await filed(ws, writer, "REPLY", { channel: channelId, thread: newest, ago: "0 seconds" });
  const unfiled = await filed(ws, writer, "UNFILED", { ago: "0 seconds" });
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: true, design: true });
  assert.deepEqual((await channelPage(ws, owner, reader, "design", { after_id: newest }))?.messages.map((m) => m.signal_id), [reply],
    "unread names exactly what channel_read would return next");
  await advance(ws, owner, reader, "general", unfiled);
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false, design: true }, "positions are per channel");

  // Each agent has its own position.
  assert.deepEqual(await agentUnread(ws, helper, writer), { general: null, design: null });
});

test("an empty channel_read starts the agent's unread; a later message makes that channel unread", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Agent empty read");
  const reader = await agent(ws, owner, "Reader");
  const writer = await agent(ws, owner, "Writer");
  await filed(ws, writer, "BEFORE-FIRST-READ", { ago: "5 minutes" });
  await asAgent(ws, owner, reader, (tx) => tx`SELECT swarm.agent_channel_read_advance(${ws}::uuid, 'general', NULL)`);
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false }, "messages before the first read never count");
  assert.equal(await readPosition(ws, reader, null), null, "no message read yet");
  const later = await filed(ws, writer, "LATER", { ago: "0 seconds" });
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: true });
  await advance(ws, owner, reader, "general", later);
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false });
  // An empty read never clears a position already held.
  await asAgent(ws, owner, reader, (tx) => tx`SELECT swarm.agent_channel_read_advance(${ws}::uuid, 'general', NULL)`);
  assert.equal(await readPosition(ws, reader, null), later);
});

test("agent_channel_read_advance moves only to a message channel_read could return in that channel", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Agent advance");
  const reader = await agent(ws, owner, "Reader");
  const [design] = await sql<{ channel_id: string }[]>`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at)
    VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'design', ${owner}::uuid, 'user', statement_timestamp()) RETURNING channel_id`;
  const channelId = design!.channel_id;
  const elsewhere = await workspace(owner, "Other workspace");
  const foreign = await filed(elsewhere, await agent(elsewhere, owner, "Foreign"), "FOREIGN", {});
  const privateOne = await filed(ws, reader, "PRIVATE", { channel: channelId, toUser: owner });
  const unfiled = await filed(ws, reader, "UNFILED", {});
  const expired = await filed(ws, reader, "EXPIRED", { channel: channelId });
  await sql`UPDATE swarm.signals SET until = statement_timestamp() - interval '1 second' WHERE id = ${expired}::uuid`;

  for (const [channel, through] of [["design", privateOne], ["design", unfiled], ["design", foreign], ["design", expired],
    ["design", randomUUID()], ["general", privateOne], ["missing", unfiled]] as const) {
    await advance(ws, owner, reader, channel, through);
  }
  const [{ rows }] = await sql<{ rows: number }[]>`SELECT count(*)::int AS rows FROM swarm.agent_channel_reads WHERE principal_id = ${reader}::uuid`;
  assert.equal(rows, 0, "no refused id sets a read position");
  assert.equal(await agentUnread(ws, owner, reader).then((u) => u?.design), null);
});

test("agent read positions are the agent's own: no person, other agent, removed agent or read role reaches them", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner, "Agent unread gate");
  const reader = await agent(ws, owner, "Reader");
  const message = await filed(ws, reader, "GENERAL", {});
  const elsewhere = await workspace(owner, "Other workspace");
  const outsider = await agent(elsewhere, owner, "Outsider");

  assert.equal(await agentUnread(ws, owner, null), null, "a person's claims have no agent read position");
  assert.equal(await agentUnread(ws, owner, outsider), null, "an agent of another workspace");
  await advance(ws, owner, outsider, "general", message);
  await advance(ws, randomUUID(), reader, "general", message);
  const [{ rows }] = await sql<{ rows: number }[]>`SELECT count(*)::int AS rows FROM swarm.agent_channel_reads WHERE workspace_id = ${ws}::uuid`;
  assert.equal(rows, 0, "neither a foreign agent nor a non-member owner claim writes a position");

  // The read role reaches the table only through the two definers.
  for (const role of ["swarm_read", "swarm_command", "authenticated"]) {
    await assert.rejects(() => asAgent(ws, owner, reader, (tx) => tx`SELECT 1 FROM swarm.agent_channel_reads`, role), /permission denied/);
  }
  for (const role of ["swarm_command", "authenticated"]) {
    await assert.rejects(() => agentUnread(ws, owner, reader, role), /permission denied/);
    await assert.rejects(() => advance(ws, owner, reader, "general", message, role), /permission denied/);
  }

  await advance(ws, owner, reader, "general", message);
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false });
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${reader}::uuid`;
  assert.equal(await agentUnread(ws, owner, reader), null, "a removed agent reads nothing");
});
