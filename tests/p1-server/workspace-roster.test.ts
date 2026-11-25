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
  await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, in_reply_to, kind, body, until, created_at, sender_lifecycle_epoch)
    VALUES (${id}::uuid, ${ws}::uuid, ${from.id}::uuid, ${from.kind}, ${toUser}, ${opts.toAgent ?? null}, ${opts.replyTo ?? null},
      ${kind}, ${body},
      ${opts.expired ? tx`statement_timestamp() - ${ago}::interval + interval '1 second'` : tx`statement_timestamp() + interval '1 day'`},
      statement_timestamp() - ${ago}::interval,
      ${from.kind === "agent" && kind === "ask" ? 1 : null}::bigint)`;
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

  // Participants (addressed person `owner` and asking agent `asker`) see both open asks; an unrelated agent (`other`) sees 0.
  for (const result of [await roster(ws, owner), await roster(ws, owner, asker)]) {
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
    assert.deepEqual(Object.keys(row).sort(), ["connection", "job", "last_activity_at", "messages_waiting", "name", "open_work", "owner", "parent",
      "platform", "principal_id", "reports_to", "source", "status", "transport", "turn_only", "waiting_on_people", "wake"]);
  }
  const unrelatedResult = await roster(ws, owner, other);
  assert.ok(unrelatedResult);
  assert.deepEqual(unrelatedResult.agents.find((entry) => entry.principal_id === asker)!.waiting_on_people, { count: 0, since: null },
    "unrelated agent must not count private DM/group-DM asks it is not a participant in");
});

test("working-on text appears only for a workspace-wide broadcast; addressed or channel-scoped work shows its time only to participants", async () => {
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

  const ownerResult = (await roster(ws, owner))!;
  const helperResult = (await roster(ws, helper))!;
  const by = (res: Roster, id: string) => res.agents.find((entry) => entry.principal_id === id)!;
  assert.equal(by(ownerResult, broadcaster).open_work!.text, "shipping the roster");
  assert.equal(by(helperResult, broadcaster).open_work!.text, "shipping the roster");
  // Helper (DM participant for toPerson & toRecipients) sees open_work.since with null text; unrelated owner sees null.
  for (const id of [toPerson, toRecipients]) {
    assert.equal(by(helperResult, id).open_work!.text, null);
    assert.ok(Date.parse(by(helperResult, id).open_work!.since) > 0, "participant sees addressed working-on time with null text");
    assert.equal(by(ownerResult, id).open_work, null, "unrelated member must not see private DM working-on timestamp");
  }
  // Owner (DM participant for replying) sees open_work.since with null text; unrelated helper sees null.
  assert.equal(by(ownerResult, replying).open_work!.text, null);
  assert.ok(Date.parse(by(ownerResult, replying).open_work!.since) > 0, "participant sees DM reply working-on time with null text");
  assert.equal(by(helperResult, replying).open_work, null, "unrelated member must not see DM reply working-on timestamp");
  assert.equal(by(ownerResult, quiet).open_work, null);
  assert.equal(/SECRET-/.test(JSON.stringify(ownerResult)), false);
  assert.equal(/SECRET-/.test(JSON.stringify(helperResult)), false);
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

/* -------------------------------------------------------------------------
 * Goal 3 follow-up: a hosted agent a person added to another workspace reads as live there
 * before its first claim_seat turn, by the same eligibility claim_seat uses.
 * ------------------------------------------------------------------------- */

test("a hosted agent added to another workspace is live there before its first claim_seat, and off once removed", async () => {
  const owner = await person("Owner");
  const home = await workspace(owner, "Hosted home");
  const other = await workspace(owner, "Added workspace");
  const hosted = await agent(home, owner, "Hosted", true);
  const grant = randomUUID();
  const digest = Buffer.alloc(32, 7);
  await sql`INSERT INTO swarm.hosted_mcp_grants (grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
      selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at)
    VALUES (${grant}::uuid, ${`provider-${grant}`}, ${owner}::uuid, ${home}::uuid, 'pre-claim-client', 'https://mcp.commonswarm.com/mcp',
      ${[home]}::uuid[], ${digest}, 'pre-claim', 'active', statement_timestamp(), statement_timestamp())`;
  await sql`INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
    VALUES (${grant}::uuid, ${home}::uuid, ${owner}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
  await sql`INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id) VALUES (${grant}::uuid, ${hosted}::uuid, ${owner}::uuid)`;
  await sql`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
    VALUES (${randomUUID()}::uuid, ${grant}::uuid, ${home}::uuid, ${owner}::uuid, ${hosted}::uuid, 'Hosted', statement_timestamp())`;
  // add_agent_to_workspace: a membership in the other workspace and a human add receipt, and no seat there yet.
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${hosted}::uuid, ${other}::uuid, ${owner}::uuid, ${owner}::uuid)`;
  const added = randomUUID();
  await sql`INSERT INTO swarm.hosted_mcp_agent_workspace_adds (receipt_id, grant_id, principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${added}::uuid, ${grant}::uuid, ${hosted}::uuid, ${other}::uuid, ${owner}::uuid, ${owner}::uuid)`;

  const kind = async (ws: string) =>
    (await sql<{ kind: string | null }[]>`SELECT swarm_read.agent_connection_kind(${ws}::uuid, ${hosted}::uuid) AS kind`)[0]!.kind;
  const homeConnection = async (ws: string) => await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated" })}, true)`;
    const [row] = await tx<{ overview: { workspaces: Array<{ workspace_id: string; people: Array<{ agents: Array<{ principal_id: string; status: { facts: { connection: string } } }> }> }> } }[]>`
      SELECT swarm_read.home_overview() AS overview`;
    return row!.overview.workspaces.find((entry) => entry.workspace_id === ws)?.people.flatMap((person) => person.agents)
      .find((entry) => entry.principal_id === hosted)?.status.facts.connection;
  });
  const both = async (ws: string) => {
    const roster = await kind(ws);
    assert.equal(await homeConnection(ws), roster, "home_overview and the roster agree");
    return roster;
  };

  assert.equal(await both(home), "live");
  assert.equal(await both(other), "live", "added and not yet claimed: live, not connection off");

  // The agent claims its seat there: still live.
  const claimed = randomUUID();
  await sql`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
    VALUES (${claimed}::uuid, ${grant}::uuid, ${other}::uuid, ${owner}::uuid, ${hosted}::uuid, 'Hosted', statement_timestamp())`;
  assert.equal(await both(other), "live");

  // Removed from the workspace (as change_hosted_agent_membership does): the add receipt and the seat end and the
  // seat is tombstoned; it reads off.
  await sql`UPDATE swarm.hosted_mcp_agent_workspace_adds SET revoked_at = statement_timestamp() WHERE receipt_id = ${added}::uuid`;
  await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at = statement_timestamp() WHERE seat_id = ${claimed}::uuid`;
  await sql`INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by) VALUES ('hosted_seat', ${claimed}::uuid, ${owner}::uuid)`;
  assert.equal(await kind(other), "connection_off");

  // Added again: live before the next claim, although the old seat stays revoked.
  await sql`INSERT INTO swarm.hosted_mcp_agent_workspace_adds (grant_id, principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${grant}::uuid, ${hosted}::uuid, ${other}::uuid, ${owner}::uuid, ${owner}::uuid)`;
  assert.equal(await both(other), "live");

  // seat_release in the home workspace (consented, no add receipt): the seat ends and is tombstoned, and the agent
  // reads off there until a person adds it again; consent alone does not bring it back before a claim.
  const [homeSeat] = await sql<{ seat_id: string }[]>`SELECT seat_id FROM swarm.hosted_mcp_seats
    WHERE workspace_id = ${home}::uuid AND principal_id = ${hosted}::uuid AND revoked_at IS NULL`;
  await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at = statement_timestamp() WHERE seat_id = ${homeSeat!.seat_id}::uuid`;
  await sql`INSERT INTO swarm.revocation_tombstones (kind, target_id, created_by) VALUES ('hosted_seat', ${homeSeat!.seat_id}::uuid, ${owner}::uuid)`;
  assert.equal(await both(home), "connection_off", "a released seat stays off");
  assert.equal(await both(other), "live", "a release elsewhere does not end this workspace");

  // Reconnect onto a new grant, then the old refresh family is retired while its grant row stays active: off before
  // any claim. The new grant has no binding here, so nothing else reads live.
  // Family tombstones are append-only, so this runs in a transaction that rolls back.
  const [{ provider }] = await sql<{ provider: string }[]>`SELECT provider_grant_id AS provider FROM swarm.hosted_mcp_grants WHERE grant_id = ${grant}::uuid`;
  const rolledBack = new Error("roll back the family tombstone");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO commonswarm_oauth.refresh_family_tombstones (grant_id, revoked_at) VALUES (${provider}, statement_timestamp())`;
    const [retired] = await tx<{ kind: string }[]>`SELECT swarm_read.agent_connection_kind(${other}::uuid, ${hosted}::uuid) AS kind`;
    assert.equal(retired?.kind, "connection_off", "a retired refresh family is off before a claim");
    throw rolledBack;
  }).catch((error) => { if (error !== rolledBack) throw error; });
  assert.equal(await both(other), "live");

  // The grant ends: off everywhere, seat or no seat.
  await sql`UPDATE swarm.hosted_mcp_grants SET state = 'revoked', revoked_at = statement_timestamp() WHERE grant_id = ${grant}::uuid`;
  assert.equal(await both(home), "connection_off");
  assert.equal(await both(other), "connection_off");

  // Membership without consent or a live add receipt is never live.
  const third = await workspace(owner, "Never added");
  const otherAgent = await agent(home, owner, "Other hosted", true);
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${otherAgent}::uuid, ${third}::uuid, ${owner}::uuid, ${owner}::uuid)`;
  const [never] = await sql<{ kind: string }[]>`SELECT swarm_read.agent_connection_kind(${third}::uuid, ${otherAgent}::uuid) AS kind`;
  assert.equal(never?.kind, "connection_off");
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

test("decision_queue_page: keyset-pages past 100 asks oldest first and enforces person/member/cursor guards", async () => {
  const owner = await person("Owner");
  const outsider = await person("Outsider");
  const ws = await workspace(owner, "Paged queue test");
  const asker = await agent(ws, owner, "BulkAsker");

  // Seed 101 open asks with strictly increasing timestamps so ask #101 lands on page 2.
  const ids: string[] = [];
  await sql.begin(async (tx) => {
    for (let i = 1; i <= 101; i++) {
      const id = randomUUID();
      ids.push(id);
      await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, created_at, sender_lifecycle_epoch)
        VALUES (${id}::uuid, ${ws}::uuid, ${asker}::uuid, 'agent', ${owner}::uuid, 'ask', ${"ASK-" + i},
          statement_timestamp() + interval '1 day', statement_timestamp() - interval '2 hours' + (${i} * interval '1 second'), 1)`;
    }
  });

  const queuePage = async (viewer: string, after: { created_at: string; signal_id: string } | null, extraClaims: Record<string, unknown> = {}, role = "authenticated") =>
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewer, role: "authenticated", ...extraClaims })}, true)`;
      const [row] = await tx<{ page: { total: number; truncated: boolean; asks: Array<{ signal_id: string; body: string; created_at: string }> } | null }[]>`
        SELECT swarm_read.decision_queue_page(${ws}::uuid, ${after?.created_at ?? null}::timestamptz, ${after?.signal_id ?? null}::uuid) AS page`;
      return row!.page;
    });

  const page1 = await queuePage(owner, null);
  assert.ok(page1);
  assert.equal(page1.total, 101);
  assert.equal(page1.truncated, true);
  assert.equal(page1.asks.length, 100);
  assert.equal(page1.asks[0]!.signal_id, ids[0]);
  assert.equal(page1.asks[99]!.signal_id, ids[99]);

  const last1 = page1.asks[99]!;
  const page2 = await queuePage(owner, { created_at: last1.created_at, signal_id: last1.signal_id });
  assert.ok(page2);
  assert.equal(page2.total, 101);
  assert.equal(page2.truncated, false);
  assert.deepEqual(page2.asks.map((a) => a.signal_id), [ids[100]]);
  assert.equal(page2.asks[0]!.body, "ASK-101");

  // Agent claims and outsiders get null; half-cursor is rejected; non-authenticated roles cannot execute.
  assert.equal(await queuePage(owner, null, { agent_principal_id: asker }), null);
  assert.equal(await queuePage(outsider, null), null);
  await assert.rejects(() => sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated" })}, true)`;
    await tx`SELECT swarm_read.decision_queue_page(${ws}::uuid, ${last1.created_at}::timestamptz, NULL::uuid)`;
  }), /decision_queue_cursor_invalid/);
  for (const role of ["swarm_read", "swarm_command"]) {
    await assert.rejects(() => queuePage(owner, null, {}, role), /permission denied/);
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
  const own = await filed(ws, reader, "OWN", { channel: channelId });
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: false, design: false });

  // A thread reply channel_read returns does; so does an unfiled message, for general.
  const reply = await filed(ws, writer, "REPLY", { channel: channelId, thread: newest, ago: "0 seconds" });
  const unfiled = await filed(ws, writer, "UNFILED", { ago: "0 seconds" });
  assert.deepEqual(await agentUnread(ws, owner, reader), { general: true, design: true });
  // channel_read returns the agent's own message too; unread skips it, as the person's unread does.
  assert.deepEqual((await channelPage(ws, owner, reader, "design", { after_id: newest }))?.messages.map((m) => m.signal_id), [own, reply],
    "unread counts exactly what channel_read returns next, less the agent's own message");
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
  // Signals are append-only, so the expired one is written already expired.
  const expired = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id)
    VALUES (${expired}::uuid, ${ws}::uuid, ${reader}::uuid, 'agent', 'note', 'EXPIRED',
      statement_timestamp() - interval '1 minute', statement_timestamp() - interval '2 minutes', ${channelId}::uuid)`;

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

test("C2 live seat status: open-channel working-on exposes text while private-channel stays null, and unseen_count is isolated across roster, home_overview, and agent_wake_path", async () => {
  const owner = await person("Owner");
  const outsider = await person("Outsider");
  const ws = await workspace(owner, "C2 Seat Status");
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${outsider}::uuid, 'member')`;
  const worker = await agent(ws, owner, "Worker");
  const secretWorker = await agent(ws, owner, "SecretWorker");

  // Create an open channel (#ops) and a private channel (#vault).
  const openCh = randomUUID();
  const privCh = randomUUID();
  await sql`INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_kind, created_by_principal)
    VALUES (${openCh}::uuid, ${ws}::uuid, 'ops', 'open', 'user', ${owner}::uuid),
           (${privCh}::uuid, ${ws}::uuid, 'vault', 'private', 'user', ${owner}::uuid)`;
  await sql`INSERT INTO swarm.channel_members (workspace_id, channel_id, member_kind, user_id, added_by_kind, added_by_principal)
    VALUES (${ws}::uuid, ${privCh}::uuid, 'user', ${owner}::uuid, 'user', ${owner}::uuid)`;
  await sql`INSERT INTO swarm.channel_members (workspace_id, channel_id, member_kind, agent_principal_id, added_by_kind, added_by_principal)
    VALUES (${ws}::uuid, ${privCh}::uuid, 'agent', ${secretWorker}::uuid, 'user', ${owner}::uuid)`;

  // Open-channel unaddressed working-on exposes its text; private-channel working-on keeps text null for members and hides open_work from outsiders.
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id)
    VALUES (${randomUUID()}::uuid, ${ws}::uuid, ${worker}::uuid, 'agent', 'working-on', 'deploying C2',
            statement_timestamp() + interval '1 hour', statement_timestamp() - interval '2 minutes', ${openCh}::uuid),
           (${randomUUID()}::uuid, ${ws}::uuid, ${secretWorker}::uuid, 'agent', 'working-on', 'SECRET-VAULT-TASK',
            statement_timestamp() + interval '1 hour', statement_timestamp() - interval '2 minutes', ${privCh}::uuid)`;

  // Plus one DM working-on signal and one group_dm working-on signal (neither may expose open_work.text).
  const dmWorker = await agent(ws, owner, "DmWorker");
  const dmWorkingSignal = await signal(ws, { kind: "agent", id: dmWorker }, "working-on", "SECRET-DM-WORKING", { toUser: owner, ago: "2 minutes" });
  assert.ok(dmWorkingSignal);
  const groupDmWorker = await agent(ws, owner, "GroupDmWorker");
  const groupDmSignal = await signal(ws, { kind: "agent", id: groupDmWorker }, "working-on", "SECRET-GROUP-DM-WORKING", { recipients: [owner, outsider], ago: "2 minutes" });
  assert.ok(groupDmSignal);
  // 1. Channel-less DM deliveries (unacked + queued + observed): visible to DM participant (owner/worker), NEVER to outsider.
  const dmAsk1 = await signal(ws, { kind: "user", id: owner }, "ask", "first dm ask", { toAgent: worker, ago: "6 seconds" });
  const dmAsk2 = await signal(ws, { kind: "user", id: owner }, "ask", "second dm ask", { toAgent: worker, ago: "4 seconds" });
  const queuedDmAsk = await signal(ws, { kind: "user", id: owner }, "ask", "queued-only dm ask", { toAgent: worker, ago: "5 seconds" });
  const observedDmAsk = await signal(ws, { kind: "user", id: owner }, "ask", "already observed dm ask", { toAgent: worker, ago: "7 seconds" });
  // 2. Addressed ask in an OPEN channel (#ops): visible to sender/addressee, NEVER to non-addressee outsider.
  const openAddressedAsk = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at, channel_id)
    VALUES (${openAddressedAsk}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', ${worker}::uuid, 'ask', 'ADDRESSED-IN-OPEN-CHANNEL',
            statement_timestamp() + interval '1 hour', statement_timestamp() - interval '3 seconds', ${openCh}::uuid)`;
  // 3. Unaddressed open-channel mention (public control: conversation audience in #ops): visible to BOTH owner and outsider.
  const publicMention = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id)
      VALUES (${publicMention}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', 'note', 'public mention in #ops',
              statement_timestamp() + interval '1 hour', statement_timestamp() - interval '2 seconds', ${openCh}::uuid)`;
    await tx`INSERT INTO swarm.signal_mentions (workspace_id, signal_id, position, mentioned_agent_principal_id, source)
      VALUES (${ws}::uuid, ${publicMention}::uuid, 0, ${worker}::uuid, 'author')`;
  });
  // 4. Private channel (#vault) ask to secretWorker: visible to #vault member/sender, NEVER to outsider.
  const privAsk = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at, channel_id)
    VALUES (${privAsk}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', ${secretWorker}::uuid, 'ask', 'SECRET-VAULT-ASK',
            statement_timestamp() + interval '1 hour', statement_timestamp() - interval '5 seconds', ${privCh}::uuid)`;
  const queuedLeaseId = randomUUID();
  const queuedListenerId = randomUUID();
  await sql`INSERT INTO swarm.signal_deliveries (workspace_id, signal_id, recipient_agent_principal_id, enqueued_at, delivered_at, surfaced_at, acked_at, ack_outcome, ack_via, last_lease_id, last_leased_by)
    VALUES (${ws}::uuid, ${dmAsk1}::uuid, ${worker}::uuid, statement_timestamp() - interval '6 seconds', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
           (${ws}::uuid, ${dmAsk2}::uuid, ${worker}::uuid, statement_timestamp() - interval '4 seconds', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
           (${ws}::uuid, ${queuedDmAsk}::uuid, ${worker}::uuid, statement_timestamp() - interval '5 seconds', statement_timestamp() - interval '4 seconds', NULL, statement_timestamp() - interval '4 seconds', 'queued', 'leased', ${queuedLeaseId}::uuid, ${queuedListenerId}::uuid),
           (${ws}::uuid, ${observedDmAsk}::uuid, ${worker}::uuid, statement_timestamp() - interval '7 seconds', statement_timestamp() - interval '6 seconds', statement_timestamp() - interval '6 seconds', statement_timestamp() - interval '6 seconds', 'observed', 'unclaimed', NULL, NULL),
           (${ws}::uuid, ${openAddressedAsk}::uuid, ${worker}::uuid, statement_timestamp() - interval '3 seconds', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
           (${ws}::uuid, ${publicMention}::uuid, ${worker}::uuid, statement_timestamp() - interval '2 seconds', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
           (${ws}::uuid, ${privAsk}::uuid, ${secretWorker}::uuid, statement_timestamp() - interval '5 seconds', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET
      enqueued_at = EXCLUDED.enqueued_at, delivered_at = EXCLUDED.delivered_at,
      surfaced_at = EXCLUDED.surfaced_at, acked_at = EXCLUDED.acked_at,
      ack_outcome = EXCLUDED.ack_outcome, ack_via = EXCLUDED.ack_via,
      last_lease_id = EXCLUDED.last_lease_id, last_leased_by = EXCLUDED.last_leased_by`;
  await sql`INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at, watcher_at)
    VALUES (${ws}::uuid, ${worker}::uuid, statement_timestamp() - interval '1 minute', statement_timestamp() - interval '10 seconds')`;

  const ownerRoster = (await roster(ws, owner))!;
  const outsiderRoster = (await roster(ws, outsider))!;
  const find = (r: Roster, id: string) => r.agents.find((e) => e.principal_id === id) as Record<string, unknown>;

  assert.equal((find(ownerRoster, worker).open_work as { text: string | null }).text, "deploying C2", "open channel working-on exposes text");
  assert.equal((find(outsiderRoster, worker).open_work as { text: string | null }).text, "deploying C2");
  assert.equal((find(ownerRoster, secretWorker).open_work as { text: string | null }).text, null, "private channel working-on keeps text null even for member");
  assert.equal(find(outsiderRoster, secretWorker).open_work, null, "outsider cannot see private channel open_work");
  assert.equal((find(ownerRoster, dmWorker).open_work as { text: string | null }).text, null, "DM working-on keeps text null for participant");
  assert.equal(find(outsiderRoster, dmWorker).open_work, null, "outsider cannot see private DM open_work.since");
  assert.equal(find(outsiderRoster, dmWorker).last_activity_at, null, "outsider cannot see private DM last_activity_at");
  assert.ok(find(ownerRoster, dmWorker).last_activity_at !== null, "DM participant sees dmWorker last_activity_at");
  assert.equal((find(ownerRoster, groupDmWorker).open_work as { text: string | null }).text, null, "group_dm working-on keeps text null");
  assert.equal(/SECRET-VAULT|SECRET-DM|SECRET-GROUP-DM/.test(JSON.stringify(ownerRoster)), false);
  assert.equal(/SECRET-VAULT|SECRET-DM|SECRET-GROUP-DM/.test(JSON.stringify(outsiderRoster)), false);

  // Outgoing private DM ask from dmWorker to owner: participant (owner) sees waiting_on_people count=1 + since,
  // while unrelated outsider sees waiting_on_people count=0 + since=null and last_activity_at=null.
  const privateOutgoingAsk = await signal(ws, { kind: "agent", id: dmWorker }, "ask", "SECRET-OUTGOING-DM-ASK", { toUser: owner, ago: "1 minute" });
  assert.ok(privateOutgoingAsk);
  const ownerAfterPrivateAsk = (await roster(ws, owner))!;
  const outsiderAfterPrivateAsk = (await roster(ws, outsider))!;
  assert.equal((find(ownerAfterPrivateAsk, dmWorker).waiting_on_people as { count: number; since: string | null }).count, 1, "DM participant sees private outgoing ask count");
  assert.ok((find(ownerAfterPrivateAsk, dmWorker).waiting_on_people as { count: number; since: string | null }).since !== null);
  assert.deepEqual(find(outsiderAfterPrivateAsk, dmWorker).waiting_on_people, { count: 0, since: null }, "outsider must not see private outgoing ask count or timestamp");
  assert.equal(find(outsiderAfterPrivateAsk, dmWorker).last_activity_at, null, "outsider last_activity_at must stay null after private outgoing ask");
  assert.equal(find(outsiderAfterPrivateAsk, dmWorker).open_work, null, "outsider open_work must stay null for private DM work");

  // Owner (sender of DMs + open addressed ask + public mention) sees all 5 unseen deliveries (excludes observed).
  const ownerWorkerWaiting = find(ownerRoster, worker).messages_waiting as { count: number; since: string | null };
  assert.equal(ownerWorkerWaiting.count, 5, "owner sees 3 DM (incl. queued) + 1 open addressed + 1 public mention");
  assert.ok(ownerWorkerWaiting.since !== null);
  // Outsider sees ONLY the 1 public open-channel mention (NOT the 3 channel-less DMs and NOT the addressed open-channel ask!),
  // and outsider's `since` must be strictly newer than owner's oldest DM (`dmAsk1` at -6s vs `publicMention` at -2s)!
  const outsiderWorkerWaiting = find(outsiderRoster, worker).messages_waiting as { count: number; since: string | null };
  assert.equal(outsiderWorkerWaiting.count, 1, "outsider sees ONLY the public open-channel mention, never channel-less DMs or addressed open-channel asks");
  assert.ok(outsiderWorkerWaiting.since !== null);
  assert.ok(Date.parse(outsiderWorkerWaiting.since) > Date.parse(ownerWorkerWaiting.since), "outsider waiting age must not leak older DM enqueued_at");
  // Addressed DM/open-channel only agent (no public mention): outsider must see count=0, since=null.
  const dmOnlyAsk = await signal(ws, { kind: "user", id: owner }, "ask", "dm-only for dmWorker", { toAgent: dmWorker, ago: "5 seconds" });
  const openAddressedForDmWorker = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at, channel_id)
    VALUES (${openAddressedForDmWorker}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', ${dmWorker}::uuid, 'ask', 'open-addressed for dmWorker',
            statement_timestamp() + interval '1 hour', statement_timestamp() - interval '4 seconds', ${openCh}::uuid)`;
  await sql`INSERT INTO swarm.signal_deliveries (workspace_id, signal_id, recipient_agent_principal_id, enqueued_at)
    VALUES (${ws}::uuid, ${dmOnlyAsk}::uuid, ${dmWorker}::uuid, statement_timestamp() - interval '5 seconds'),
           (${ws}::uuid, ${openAddressedForDmWorker}::uuid, ${dmWorker}::uuid, statement_timestamp() - interval '4 seconds')
    ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET enqueued_at = EXCLUDED.enqueued_at`;
  const ownerRosterAfterDm = (await roster(ws, owner))!;
  const outsiderRosterAfterDm = (await roster(ws, outsider))!;
  assert.equal((find(ownerRosterAfterDm, dmWorker).messages_waiting as { count: number; since: string | null }).count, 2);
  assert.equal((find(outsiderRosterAfterDm, dmWorker).messages_waiting as { count: number; since: string | null }).count, 0, "outsider sees 0 for DM + addressed open-channel asks");
  assert.equal((find(outsiderRosterAfterDm, dmWorker).messages_waiting as { count: number; since: string | null }).since, null, "outsider sees null since for DM + addressed open-channel asks");

  assert.equal((find(ownerRoster, secretWorker).messages_waiting as { count: number }).count, 1, "private member sees secretWorker unseen count");
  assert.equal((find(outsiderRoster, secretWorker).messages_waiting as { count: number; since: string | null }).count, 0, "outsider must not see private unseen count");
  assert.equal((find(outsiderRoster, secretWorker).messages_waiting as { count: number; since: string | null }).since, null);
  assert.ok((find(ownerRoster, worker).wake as { watcher_at: string | null }).watcher_at !== null);

  // home_overview exposes messages_waiting_count (including queued-only) & wake, with identical canonical conversation & audience isolation.
  const homeAs = async (userId: string) => await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    const [row] = await tx<{ overview: { workspaces: Array<{ workspace_id: string; people: Array<{ agents: Array<{ principal_id: string; status: { facts: { messages_waiting_count: number; messages_waiting_since: string | null; wake: { watcher_at: string | null } } } }> }> }> } }[]>`
      SELECT swarm_read.home_overview() AS overview`;
    return row!.overview.workspaces.find((entry) => entry.workspace_id === ws)!.people.flatMap((p) => p.agents);
  });
  const ownerHome = await homeAs(owner);
  const outsiderHome = await homeAs(outsider);
  assert.equal(ownerHome.find((a) => a.principal_id === worker)!.status.facts.messages_waiting_count, 5);
  assert.equal(outsiderHome.find((a) => a.principal_id === worker)!.status.facts.messages_waiting_count, 1, "home_overview outsider sees only public open-channel mention");
  assert.ok(Date.parse(outsiderHome.find((a) => a.principal_id === worker)!.status.facts.messages_waiting_since!) > Date.parse(ownerHome.find((a) => a.principal_id === worker)!.status.facts.messages_waiting_since!));
  assert.equal(ownerHome.find((a) => a.principal_id === dmWorker)!.status.facts.messages_waiting_count, 2);
  assert.equal(outsiderHome.find((a) => a.principal_id === dmWorker)!.status.facts.messages_waiting_count, 0, "home_overview outsider sees 0 for DM + addressed open-channel asks");
  assert.equal(outsiderHome.find((a) => a.principal_id === dmWorker)!.status.facts.messages_waiting_since, null);
  assert.ok(ownerHome.find((a) => a.principal_id === worker)!.status.facts.wake.watcher_at !== null);
  assert.equal(ownerHome.find((a) => a.principal_id === secretWorker)!.status.facts.messages_waiting_count, 1);
  assert.equal(outsiderHome.find((a) => a.principal_id === secretWorker)!.status.facts.messages_waiting_count, 0);

  // agent_wake_path enforces canonical conversation & per-message audience visibility on candidate,
  // observed baseline, and newer-observed supersession rows before aggregating, under real ROLE authenticated:
  const wakeRowsAs = async (viewerId: string) => await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewerId, role: "authenticated" })}, true)`;
    return await tx<{ principal_id: string; oldest_unobserved_at: Date; unseen_count: number }[]>`
      SELECT principal_id::text, oldest_unobserved_at, unseen_count
      FROM swarm_read.agent_wake_path
      WHERE workspace_id = ${ws}::uuid`;
  });
  // Privilege check: only authenticated holds EXECUTE on the internal wake helper (no anon, swarm_read, swarm_command, or PUBLIC).
  const [wakeHelperPrivs] = await sql<{ auth_exec: boolean; anon_exec: boolean; read_exec: boolean; cmd_exec: boolean; public_exec: boolean }[]>`
    SELECT
      has_function_privilege('authenticated', 'swarm.claims_visible_wake_path_deliveries()', 'EXECUTE') AS auth_exec,
      has_function_privilege('anon', 'swarm.claims_visible_wake_path_deliveries()', 'EXECUTE') AS anon_exec,
      has_function_privilege('swarm_read', 'swarm.claims_visible_wake_path_deliveries()', 'EXECUTE') AS read_exec,
      has_function_privilege('swarm_command', 'swarm.claims_visible_wake_path_deliveries()', 'EXECUTE') AS cmd_exec,
      EXISTS (
        SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS acl
        WHERE p.oid = 'swarm.claims_visible_wake_path_deliveries()'::regprocedure
          AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      ) AS public_exec`;
  assert.deepEqual(wakeHelperPrivs, {
    auth_exec: true,
    anon_exec: false,
    read_exec: false,
    cmd_exec: false,
    public_exec: false,
  });

  // Step 1 (Hidden DM baselines only): owner sees 4 on worker, 2 on dmWorker, 1 on secretWorker;
  // unrelated outsider must NOT have worker's public mention enabled by owner's hidden DM baseline!
  const baseline = await signal(ws, { kind: "user", id: owner }, "note", "baseline", { toAgent: worker, ago: "10 seconds" });
  const dmBaseline = await signal(ws, { kind: "user", id: owner }, "note", "dm-baseline", { toAgent: dmWorker, ago: "10 seconds" });
  const secretBaseline = await signal(ws, { kind: "user", id: owner }, "note", "secret-baseline", { toAgent: secretWorker, ago: "10 seconds" });
  await sql`INSERT INTO swarm.signal_deliveries (workspace_id, signal_id, recipient_agent_principal_id, enqueued_at, delivered_at, surfaced_at, acked_at, ack_outcome)
    VALUES (${ws}::uuid, ${baseline}::uuid, ${worker}::uuid, statement_timestamp() - interval '10 seconds', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', 'observed'),
           (${ws}::uuid, ${dmBaseline}::uuid, ${dmWorker}::uuid, statement_timestamp() - interval '10 seconds', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', 'observed'),
           (${ws}::uuid, ${secretBaseline}::uuid, ${secretWorker}::uuid, statement_timestamp() - interval '10 seconds', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', 'observed')
    ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET
      enqueued_at = EXCLUDED.enqueued_at, delivered_at = EXCLUDED.delivered_at,
      surfaced_at = EXCLUDED.surfaced_at, acked_at = EXCLUDED.acked_at, ack_outcome = EXCLUDED.ack_outcome`;
  const ownerWakeHiddenBase = await wakeRowsAs(owner);
  const outsiderWakeHiddenBase = await wakeRowsAs(outsider);
  assert.equal(ownerWakeHiddenBase.find((r) => r.principal_id === worker)?.unseen_count, 4, "owner sees 2 DM asks + 1 addressed open-channel ask + 1 public mention");
  assert.equal(ownerWakeHiddenBase.find((r) => r.principal_id === dmWorker)?.unseen_count, 2, "owner sees dmWorker private-only deliveries");
  assert.equal(ownerWakeHiddenBase.find((r) => r.principal_id === secretWorker)?.unseen_count, 1, "owner sees secretWorker #vault delivery");
  assert.equal(outsiderWakeHiddenBase.find((r) => r.principal_id === worker), undefined, "hidden DM baseline must NOT enable worker's public wake row for outsider");
  assert.equal(outsiderWakeHiddenBase.find((r) => r.principal_id === dmWorker), undefined, "outsider gets NO agent_wake_path row for private-only dmWorker");
  assert.equal(outsiderWakeHiddenBase.find((r) => r.principal_id === secretWorker), undefined, "outsider gets NO agent_wake_path row for private-channel secretWorker");

  // Step 2 (Visible public open-channel baseline control): now outsider sees ONLY the 1 public mention on worker
  // (with strictly newer oldest_unobserved_at than owner's DM), while dmWorker and secretWorker stay hidden.
  const publicBaseline = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id)
      VALUES (${publicBaseline}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', 'note', 'public observed baseline in #ops',
              statement_timestamp() + interval '1 hour', statement_timestamp() - interval '10 seconds', ${openCh}::uuid)`;
    await tx`INSERT INTO swarm.signal_mentions (workspace_id, signal_id, position, mentioned_agent_principal_id, source)
      VALUES (${ws}::uuid, ${publicBaseline}::uuid, 0, ${worker}::uuid, 'author')`;
    await tx`INSERT INTO swarm.signal_deliveries (workspace_id, signal_id, recipient_agent_principal_id, enqueued_at, delivered_at, surfaced_at, acked_at, ack_outcome)
      VALUES (${ws}::uuid, ${publicBaseline}::uuid, ${worker}::uuid, statement_timestamp() - interval '10 seconds', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', statement_timestamp() - interval '1 second', 'observed')
      ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET
        enqueued_at = EXCLUDED.enqueued_at, delivered_at = EXCLUDED.delivered_at,
        surfaced_at = EXCLUDED.surfaced_at, acked_at = EXCLUDED.acked_at, ack_outcome = EXCLUDED.ack_outcome`;
  });
  const ownerWake = await wakeRowsAs(owner);
  const outsiderWake = await wakeRowsAs(outsider);
  const ownerWorkerWake = ownerWake.find((r) => r.principal_id === worker);
  const outsiderWorkerWake = outsiderWake.find((r) => r.principal_id === worker);
  assert.equal(ownerWorkerWake?.unseen_count, 4, "owner still sees all 4 unclaimed deliveries on worker");
  assert.equal(outsiderWorkerWake?.unseen_count, 1, "with visible baseline, outsider sees ONLY the 1 public mention");
  assert.ok(
    outsiderWorkerWake!.oldest_unobserved_at.getTime() > ownerWorkerWake!.oldest_unobserved_at.getTime(),
    "outsider agent_wake_path oldest_unobserved_at must not leak older DM timestamp",
  );
  assert.equal(outsiderWake.find((r) => r.principal_id === dmWorker), undefined);
  assert.equal(outsiderWake.find((r) => r.principal_id === secretWorker), undefined);

  // Step 3 (Newer hidden DM observation): supersedes owner's worker row, while outsider's public count and timestamp stay IDENTICAL.
  const hiddenLaterObserved = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at)
      VALUES (${hiddenLaterObserved}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', ${worker}::uuid, 'note', 'newer hidden dm observed',
              statement_timestamp() + interval '1 hour', statement_timestamp() - interval '500 milliseconds')`;
    await tx`INSERT INTO swarm.signal_deliveries (workspace_id, signal_id, recipient_agent_principal_id, enqueued_at, delivered_at, surfaced_at, acked_at, ack_outcome)
      VALUES (${ws}::uuid, ${hiddenLaterObserved}::uuid, ${worker}::uuid, statement_timestamp() - interval '500 milliseconds', statement_timestamp(), statement_timestamp(), statement_timestamp(), 'observed')
      ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET
        enqueued_at = EXCLUDED.enqueued_at, delivered_at = EXCLUDED.delivered_at,
        surfaced_at = EXCLUDED.surfaced_at, acked_at = EXCLUDED.acked_at, ack_outcome = EXCLUDED.ack_outcome`;
  });
  const ownerAfterHiddenLater = await wakeRowsAs(owner);
  const outsiderAfterHiddenLater = await wakeRowsAs(outsider);
  assert.equal(ownerAfterHiddenLater.find((r) => r.principal_id === worker), undefined, "owner sees worker superseded by newer observed DM");
  const outsiderWorkerAfterHiddenLater = outsiderAfterHiddenLater.find((r) => r.principal_id === worker);
  assert.equal(outsiderWorkerAfterHiddenLater?.unseen_count, 1, "newer hidden DM observation must NOT suppress outsider's public wake count");
  assert.equal(
    outsiderWorkerAfterHiddenLater!.oldest_unobserved_at.getTime(),
    outsiderWorkerWake!.oldest_unobserved_at.getTime(),
    "newer hidden DM observation must NOT change outsider's public oldest_unobserved_at",
  );

  // Step 4 (Newer visible open-channel observation control): supersedes outsider's public wake row.
  const publicLaterObserved = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, channel_id)
      VALUES (${publicLaterObserved}::uuid, ${ws}::uuid, ${owner}::uuid, 'user', 'note', 'newer public observed in #ops',
              statement_timestamp() + interval '1 hour', statement_timestamp(), ${openCh}::uuid)`;
    await tx`INSERT INTO swarm.signal_mentions (workspace_id, signal_id, position, mentioned_agent_principal_id, source)
      VALUES (${ws}::uuid, ${publicLaterObserved}::uuid, 0, ${worker}::uuid, 'author')`;
    await tx`INSERT INTO swarm.signal_deliveries (workspace_id, signal_id, recipient_agent_principal_id, enqueued_at, delivered_at, surfaced_at, acked_at, ack_outcome)
      VALUES (${ws}::uuid, ${publicLaterObserved}::uuid, ${worker}::uuid, statement_timestamp(), statement_timestamp(), statement_timestamp(), statement_timestamp(), 'observed')
      ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET
        enqueued_at = EXCLUDED.enqueued_at, delivered_at = EXCLUDED.delivered_at,
        surfaced_at = EXCLUDED.surfaced_at, acked_at = EXCLUDED.acked_at, ack_outcome = EXCLUDED.ack_outcome`;
  });
  const outsiderAfterPublicLater = await wakeRowsAs(outsider);
  assert.equal(outsiderAfterPublicLater.find((r) => r.principal_id === worker), undefined, "newer visible public observation supersedes outsider's public wake row");
});
