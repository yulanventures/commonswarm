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
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to, kind, body, until, created_at)
    VALUES (${id}::uuid, ${ws}::uuid, ${from.id}::uuid, ${from.kind}, ${opts.toUser ?? null}, ${opts.toAgent ?? null}, ${opts.replyTo ?? null},
      ${kind}, ${body},
      ${opts.expired ? sql`statement_timestamp() - ${ago}::interval + interval '1 second'` : sql`statement_timestamp() + interval '1 day'`},
      statement_timestamp() - ${ago}::interval)`;
  for (const [position, user] of (opts.recipients ?? []).entries()) {
    await sql`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
      VALUES (${id}::uuid, ${ws}::uuid, ${user}::uuid, ${position})`;
  }
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
