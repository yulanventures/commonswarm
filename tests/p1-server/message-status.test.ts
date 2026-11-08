/** Message status, slice 1: swarm_read.message_status returns Delivered, Seen, Replied and an
 * unexpired Working snapshot for messages the signed-in person sent to a specific agent. Called
 * the way the web app calls it: role authenticated with the person's claims. */
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

interface Status {
  signal_id: string;
  agent_principal_id: string;
  delivered: boolean;
  seen: boolean;
  replied: boolean;
  working: { label: string; until: string } | null;
}
type Result = { workspace_id: string; statuses: Status[] } | null;

async function person(name: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO auth.users (id, aud, role, email) VALUES (${id}::uuid, 'authenticated', 'authenticated', ${`status-${id}@example.test`})`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${name})`;
  return id;
}

async function workspace(owner: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${id}::uuid, 'Status test', ${owner}::uuid)`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${id}::uuid, ${owner}::uuid, 'owner')`;
  await sql`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${id}::uuid, 'workspace')`;
  return id;
}

async function member(ws: string, user: string): Promise<void> {
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${user}::uuid, 'member')`;
}

async function agent(ws: string, owner: string, name: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
    VALUES (${id}::uuid, ${ws}::uuid, ${owner}::uuid, ${name}, 'local', false)`;
  return id;
}

/** A message from a person to one agent; the insert trigger creates its delivery row. */
async function dm(ws: string, from: string, to: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until, created_at)
    VALUES (${id}::uuid, ${ws}::uuid, ${from}::uuid, 'user', ${to}::uuid, 'ask', 'are you on it',
      statement_timestamp() + interval '1 day', statement_timestamp() - interval '1 minute')`;
  return id;
}

/** delivered: the client received it (no ack yet); observed: an unleased self-observed ack, the
 * pairing signal_deliveries_check9 allows without a lease. */
async function ack(signal: string, to: string, outcome: "observed" | null): Promise<void> {
  await sql`UPDATE swarm.signal_deliveries SET
      delivered_at = statement_timestamp(),
      acked_at = ${outcome === null ? null : sql`statement_timestamp()`},
      ack_outcome = ${outcome}
    WHERE signal_id = ${signal}::uuid AND recipient_agent_principal_id = ${to}::uuid`;
}

async function working(ws: string, principal: string, signal: string | null, label: string | null, until = "2 minutes"): Promise<void> {
  await sql`INSERT INTO swarm.agent_message_working (workspace_id, principal_id, signal_id, label, working_until, stream_id, sequence)
    VALUES (${ws}::uuid, ${principal}::uuid, ${signal}, ${label},
      ${signal === null ? null : sql`statement_timestamp() + ${until}::interval`}, ${randomUUID()}::uuid, 1)
    ON CONFLICT (workspace_id, principal_id) DO UPDATE SET signal_id = EXCLUDED.signal_id, label = EXCLUDED.label,
      working_until = EXCLUDED.working_until, stream_id = EXCLUDED.stream_id, sequence = EXCLUDED.sequence`;
}

async function status(ws: string, viewer: string, ids: string[], extraClaims: Record<string, unknown> = {}, role = "authenticated"): Promise<Result> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewer, role: "authenticated", ...extraClaims })}, true)`;
    const [row] = await tx<{ status: Result }[]>`SELECT swarm_read.message_status(${ws}::uuid, ${ids}::uuid[]) AS status`;
    return row!.status;
  });
}

async function one(ws: string, viewer: string, id: string): Promise<Status | undefined> {
  return (await status(ws, viewer, [id]))?.statuses.find((row) => row.signal_id === id);
}

test("message_status moves from sent to delivered, seen, working and replied", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner);
  const helper = await agent(ws, owner, "Helper");
  const id = await dm(ws, owner, helper);

  assert.deepEqual(await one(ws, owner, id), {
    signal_id: id, agent_principal_id: helper, delivered: false, seen: false, replied: false, working: null,
  }, "a queued message is only sent");

  await ack(id, helper, null);
  assert.equal((await one(ws, owner, id))?.delivered, true, "the agent's client received it");
  assert.equal((await one(ws, owner, id))?.seen, false);

  await ack(id, helper, "observed");
  await working(ws, helper, id, "editing");
  const busy = await one(ws, owner, id);
  assert.equal(busy?.seen, true);
  assert.equal(busy?.working?.label, "editing");

  const reply = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, in_reply_to, kind, body, until, created_at)
    VALUES (${reply}::uuid, ${ws}::uuid, ${helper}::uuid, 'agent', ${owner}::uuid, ${id}::uuid, 'note', 'done',
      statement_timestamp() + interval '1 day', statement_timestamp())`;
  assert.equal((await one(ws, owner, id))?.replied, true, "a reply from the agent counts as replied");
});

test("an agent working in a workspace other than its home one shows Working there too", async () => {
  const owner = await person("Owner");
  const home = await workspace(owner);
  const other = await workspace(owner);
  const helper = await agent(home, owner, "Helper");
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${helper}::uuid, ${other}::uuid, ${owner}::uuid, ${owner}::uuid)`;
  for (const ws of [home, other]) {
    const id = await dm(ws, owner, helper);
    await ack(id, helper, "observed");
    await working(ws, helper, id, "editing");
    assert.equal((await one(ws, owner, id))?.working?.label, "editing", ws === home ? "home workspace" : "second workspace");
  }
});

test("message_status shows Working only for that message and only before it expires", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner);
  const helper = await agent(ws, owner, "Helper");
  const first = await dm(ws, owner, helper);
  const second = await dm(ws, owner, helper);
  await ack(first, helper, "observed");
  await ack(second, helper, "observed");

  await working(ws, helper, first, "reading");
  assert.equal((await one(ws, owner, first))?.working?.label, "reading");
  assert.equal((await one(ws, owner, second))?.working, null, "another message never borrows the snapshot");

  await working(ws, helper, first, "reading", "-1 second");
  assert.equal((await one(ws, owner, first))?.working, null, "an expired snapshot is suppressed by server time");
});

test("message_status is the sender's own: other members, outsiders, agents and read roles get nothing", async () => {
  const owner = await person("Owner");
  const other = await person("Other");
  const outsider = await person("Outsider");
  const ws = await workspace(owner);
  await member(ws, other);
  const helper = await agent(ws, owner, "Helper");
  const id = await dm(ws, owner, helper);
  await ack(id, helper, "observed");
  await working(ws, helper, id, "thinking");

  assert.deepEqual((await status(ws, other, [id]))?.statuses, [], "another member sees nothing for a message they did not send");
  assert.equal(await status(ws, outsider, [id]), null);
  assert.equal(await status(ws, owner, [id], { agent_principal_id: helper }), null);
  for (const role of ["swarm_read", "swarm_command", "anon"]) {
    await assert.rejects(() => status(ws, owner, [id], {}, role), /permission denied/);
  }

  // Unknown, unreadable and other-workspace ids are indistinguishable: no row.
  const elsewhere = await workspace(owner);
  const elsewhereAgent = await agent(elsewhere, owner, "Elsewhere");
  const foreign = await dm(elsewhere, owner, elsewhereAgent);
  assert.deepEqual((await status(ws, owner, [randomUUID(), foreign]))?.statuses, []);

  const tooMany = Array.from({ length: 51 }, () => randomUUID());
  assert.equal(await status(ws, owner, tooMany), null, "the batch is bounded");
});

test("the Working snapshot has no direct read: only message_status returns it", async () => {
  for (const role of ["authenticated", "anon", "swarm_read"]) {
    await assert.rejects(() => sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT * FROM swarm.agent_message_working LIMIT 1`;
    }), /permission denied/, role);
  }
  const [view] = await sql<{ definition: string }[]>`SELECT pg_get_viewdef('swarm_read.agent_presence'::regclass, true) AS definition`;
  assert.doesNotMatch(view!.definition, /agent_message_working/);
});
