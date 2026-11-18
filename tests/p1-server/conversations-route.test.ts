/** Conversations, step 2a (20261118000005) against real Postgres: the route rule for a message posted to a 1:1
 * or group, new generations, membership upkeep, dual-written read marks and per-person frames. Messages are
 * written as the step 2a edge writes them (swarm_command, one transaction: the signal, its recipient rows,
 * then swarm.conversation_prefile), and the commands are the definers the edge calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  channel, filed, general, localSql, members, post, refusedBy, space, type Message, type Space, type Sql, type Tx,
} from "../support/conversations-fixture.js";

let sql: Sql;
let w: Space;

before(async () => {
  sql = localSql();
  w = await space(sql, ["alice", "bob", "carol", "dave"], [["agentA", "alice"], ["agentB", "bob"]]);
});
after(async () => { await sql?.end({ timeout: 5 }); });

const u = (name: string, s: Space = w) => ({ user: s.people[name]! });
const a = (name: string, s: Space = w) => ({ agent: s.agents[name]! });
type Result = Record<string, unknown>;

/** Run a statement as the edge does: SET LOCAL ROLE swarm_command. */
async function asEdge<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    return await run(tx);
  }) as T;
}

async function open(by: string, kind: "user" | "agent", users: string[], agents: string[] = [], newGroup = false,
  s: Space = w): Promise<Result> {
  return await asEdge(async (tx) => (await tx<{ r: Result }[]>`
    SELECT swarm.conversation_open(${s.id}::uuid, ${kind}, ${by}::uuid, ${users}::uuid[], ${agents}::uuid[], ${newGroup}) AS r`)[0]!.r);
}
const idOf = (r: Result) => String((r.conversation as Result).conversation_id);

async function command(fn: "conversation_join" | "conversation_leave", by: string, kind: "user" | "agent",
  conversation: string, s: Space = w): Promise<Result> {
  return await asEdge(async (tx) => (await tx.unsafe(
    `SELECT swarm.${fn}($1::uuid, $2, $3::uuid, $4::uuid) AS r`, [s.id, kind, by, conversation]) as unknown as { r: Result }[])[0]!.r);
}

/** A post to a 1:1 or group, filed by its poster after its recipient rows. */
const explicit = (conversation: string, m: Message, s: Space = w): Promise<string> =>
  post(sql, s, { ...m, then: async (tx, id) => {
    await tx`SELECT swarm.conversation_prefile(${s.id}::uuid, ${id}::uuid, ${conversation}::uuid)`;
    await m.then?.(tx, id);
  } });

const deliveredTo = async (signal: string) => (await sql<{ a: string }[]>`
  SELECT recipient_agent_principal_id::text AS a FROM swarm.signal_deliveries WHERE signal_id = ${signal}::uuid ORDER BY 1`).map((r) => r.a);

/** Frames this workspace has queued, by topic. */
async function frames(s: Space = w): Promise<Record<string, number>> {
  const rows = await sql<{ topic: string; n: number }[]>`
    SELECT topic, count(*)::int AS n FROM realtime.messages
    WHERE topic = ${`cswarm-signals:${s.id}`} OR topic LIKE ${`cswarm-member:${s.id}:%`} GROUP BY topic`;
  return Object.fromEntries(rows.map((r) => [r.topic, r.n]));
}
function delta(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(after).filter(([t, n]) => n !== (before[t] ?? 0)).map(([t, n]) => [t, n - (before[t] ?? 0)]));
}
const topic = (name: string, s: Space = w) => `cswarm-member:${s.id}:${s.people[name]!}`;

test("the route rule: a person's group post goes to every other member, an agent's to the people and the agents it names", async () => {
  const group = idOf(await open(w.people.alice!, "user", [w.people.bob!, w.people.carol!], [w.agents.agentA!, w.agents.agentB!]));
  const everyoneElse = [u("bob"), u("carol"), a("agentA"), a("agentB")];

  const fromPerson = await explicit(group, { from: w.people.alice!, to: everyoneElse });
  assert.deepEqual(await filed(sql, fromPerson), { conversation: group, kind: "group_dm", audience: "conversation" });
  assert.deepEqual(await deliveredTo(fromPerson), [w.agents.agentA!, w.agents.agentB!].sort(), "a person's post wakes every agent");

  const naming = await explicit(group, { from: w.agents.agentA!, fromKind: "agent",
    to: [u("alice"), u("bob"), u("carol"), a("agentB")] });
  assert.deepEqual(await deliveredTo(naming), [w.agents.agentB!], "an agent's post wakes only the agent it names");
  const quiet = await explicit(group, { from: w.agents.agentA!, fromKind: "agent", to: [u("alice"), u("bob"), u("carol")] });
  assert.deepEqual(await filed(sql, quiet), { conversation: group, kind: "group_dm", audience: "conversation" },
    "and is filed for everyone in the group, so the agent it left out can still read it (step 2b)");
  assert.deepEqual(await deliveredTo(quiet), [], "an agent it does not name is not woken");

  const cases: Array<[string, Message]> = [
    ["a person leaving someone out", { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA")] }],
    ["an agent leaving a person out", { from: w.agents.agentA!, fromKind: "agent", to: [u("alice"), u("bob")] }],
    ["an agent addressing itself", { from: w.agents.agentA!, fromKind: "agent",
      to: [u("alice"), u("bob"), u("carol"), a("agentA")] }],
    ["someone outside the group", { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA"), a("agentB"), u("dave")] }],
  ];
  for (const [label, m] of cases) {
    const body = `route ${randomUUID()}`;
    // An agent's own row among its recipients may be refused by an older check first; any 23514 is a refusal.
    await assert.rejects(explicit(group, { ...m, body }),
      label === "an agent addressing itself" ? refusedBy("23514") : refusedBy("23514", "conversation_signals_route"), label);
    assert.equal((await sql`SELECT 1 FROM swarm.signals WHERE body = ${body}`).length, 0, `${label}: nothing persists`);
  }
  // A sender outside the conversation, posting exactly what its members would.
  const pair = idOf(await open(w.people.alice!, "user", [w.people.bob!]));
  await assert.rejects(explicit(pair, { from: w.people.carol!, to: [u("bob")] }),
    refusedBy("23514", "conversation_signals_route"), "a non-member sender");
  // A forged audience: the same agent post filed as an addressed message is recomputed by step 1's rule, which
  // places it elsewhere.
  await assert.rejects(post(sql, w, { from: w.agents.agentA!, fromKind: "agent", to: [u("alice"), u("bob"), u("carol")],
    then: async (tx, id) => {
      await tx.unsafe("RESET ROLE");
      await tx`INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
        VALUES (${id}::uuid, ${w.id}::uuid, ${group}::uuid, statement_timestamp(), 'addressed')`;
    } }), refusedBy("23514", "conversation_signals_placement"), "a forged audience");
  // The poster may file only a message of its own transaction.
  await assert.rejects(asEdge((tx) => tx`SELECT swarm.conversation_prefile(${w.id}::uuid, ${fromPerson}::uuid, ${group}::uuid)`),
    refusedBy("42501"));
});

test("a post filed first and given its last recipients after is checked, and announced, with the final set", async () => {
  const group = idOf(await open(w.people.bob!, "user", [w.people.alice!, w.people.carol!]));
  const id = randomUUID();
  const at = await frames();
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
      VALUES (${id}::uuid, ${w.id}::uuid, ${w.people.bob!}::uuid, 'user', ${w.people.alice!}::uuid, 'note', 'late', clock_timestamp() + interval '1 day')`;
    await tx`SELECT swarm.conversation_prefile(${w.id}::uuid, ${id}::uuid, ${group}::uuid)`;
    await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
      VALUES (${id}::uuid, ${w.id}::uuid, ${w.people.alice!}::uuid, 0), (${id}::uuid, ${w.id}::uuid, ${w.people.carol!}::uuid, 1)`;
  });
  assert.equal((await filed(sql, id))?.audience, "conversation");
  assert.deepEqual(delta(await frames(), at), { [topic("alice")]: 1, [topic("bob")]: 1, [topic("carol")]: 1 },
    "one bare frame for each person in the group, sender included, and nothing on the workspace topic");
});

test("frames: a 1:1 tells its people only; never an agent's owner, an admin or the workspace topic; a refused post tells nobody", async () => {
  await sql`UPDATE swarm.memberships SET role = 'admin' WHERE workspace_id = ${w.id}::uuid AND user_id = ${w.people.dave!}::uuid`;
  const pair = idOf(await open(w.people.alice!, "user", [w.people.carol!]));
  let at = await frames();
  const id = await explicit(pair, { from: w.people.alice!, to: [u("carol")] });
  assert.deepEqual(delta(await frames(), at), { [topic("alice")]: 1, [topic("carol")]: 1 });
  const payload = (await sql<{ p: Result }[]>`SELECT payload AS p FROM realtime.messages WHERE topic = ${topic("carol")}
    ORDER BY inserted_at DESC LIMIT 1`)[0]!.p;
  assert.deepEqual(Object.keys((payload.payload as Result | undefined) ?? payload).filter((k) => k !== "id"), ["v"]);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${id}|${pair}`), "no id in the frame");

  // agentB's owner (bob) and the admin (dave) are not in alice's 1:1 with agentB.
  const withAgent = idOf(await open(w.people.alice!, "user", [], [w.agents.agentB!]));
  at = await frames();
  await explicit(withAgent, { from: w.people.alice!, to: [a("agentB")] });
  await explicit(withAgent, { from: w.agents.agentB!, fromKind: "agent", to: [u("alice")] });
  assert.deepEqual(delta(await frames(), at), { [topic("alice")]: 2 }, "only alice: not bob, who owns agentB, nor dave");

  // A public post reaches everyone live, on their own topics.
  at = await frames();
  await post(sql, w, { from: w.people.bob! });
  assert.deepEqual(delta(await frames(), at), Object.fromEntries(["alice", "bob", "carol", "dave"].map((n) => [topic(n), 1])));

  at = await frames();
  await assert.rejects(explicit(pair, { from: w.people.alice!, to: [u("bob")] }), refusedBy("23514"));
  assert.deepEqual(delta(await frames(), at), {}, "a refused post queues nothing");
});

test("leaving a group is final; only an explicit new group from someone still in it starts again, without the old history", async () => {
  const founders = [w.people.bob!, w.people.carol!];
  const g0 = idOf(await open(w.people.alice!, "user", founders, [w.agents.agentA!]));
  const history = await explicit(g0, { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA")] });
  assert.equal((await command("conversation_leave", w.people.carol!, "user", g0)).changed, true);
  assert.equal((await command("conversation_leave", w.people.carol!, "user", g0)).status, "not_found",
    "after leaving, the group answers as an unknown one");

  // The rest keep talking in the same group; carol gets nothing from the next message on.
  let at = await frames();
  await explicit(g0, { from: w.people.alice!, to: [u("bob"), a("agentA")] });
  assert.deepEqual(delta(await frames(), at), { [topic("alice")]: 1, [topic("bob")]: 1 });
  await assert.rejects(explicit(g0, { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA")] }),
    refusedBy("23514", "conversation_signals_route"), "carol is no longer routed to");
  await assert.rejects(explicit(g0, { from: w.people.carol!, to: [u("alice"), u("bob"), a("agentA")] }),
    refusedBy("23514", "conversation_signals_route"), "nor may she post there");
  await assert.rejects(post(sql, w, { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA")] }),
    refusedBy("23514", "conversation_group_member_left"), "today's path to the founding set stays fenced");

  assert.deepEqual(await open(w.people.alice!, "user", founders, [w.agents.agentA!]), { status: "member_left", name: "carol" });
  assert.deepEqual(await open(w.people.carol!, "user", [w.people.alice!, w.people.bob!], [w.agents.agentA!], true),
    { status: "caller_left" }, "the one who left cannot start it again");
  const fresh = await open(w.people.bob!, "user", [w.people.alice!, w.people.carol!], [w.agents.agentA!], true);
  assert.equal(fresh.created, true);
  const g1 = idOf(fresh);
  assert.notEqual(g1, g0);
  assert.equal((fresh.conversation as Result).generation, 1);
  assert.equal(((fresh.conversation as Result).members as unknown[]).length, 4, "everyone in the set, carol too");
  const [old] = await sql<{ left: boolean }[]>`SELECT left_at IS NOT NULL AS left FROM swarm.conversation_members
    WHERE conversation_id = ${g0}::uuid AND member_user_id = ${w.people.carol!}::uuid`;
  assert.equal(old!.left, true, "her membership of the old group stays ended: the old history is not hers again");
  assert.equal((await filed(sql, history))?.conversation, g0, "and the old messages stay in the old group");
  assert.equal(idOf(await open(w.people.alice!, "user", founders, [w.agents.agentA!], true)), g1, "asking again finds it");
  const after = await post(sql, w, { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA")] });
  assert.equal((await filed(sql, after))?.conversation, g1, "today's path to the set now files in the new group");
  at = await frames();
  await explicit(g1, { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentA")] });
  assert.equal(delta(await frames(), at)[topic("carol")], 1);
});

test("membership upkeep: a newcomer joins only #general; leaving the workspace leaves everything; a re-add starts with nothing", async () => {
  const s = await space(sql, ["olive", "pat"], [["agentP", "pat"]]);
  const g = await general(sql, s);
  assert.deepEqual(await members(sql, g), { users: [s.people.olive!, s.people.pat!].sort(), agents: [s.agents.agentP!] },
    "people and agents join #general on arrival");
  const room = await channel(sql, s, s.people.olive!);
  assert.deepEqual(await members(sql, room), { users: [s.people.olive!], agents: [] }, "a public channel starts with its creator");
  const pair = idOf(await open(s.people.olive!, "user", [s.people.pat!], [], false, s));
  const trio = idOf(await open(s.people.olive!, "user", [s.people.pat!], [s.agents.agentP!], false, s));
  assert.equal((await command("conversation_join", s.people.pat!, "user", room, s)).changed, true);

  const quinn = randomUUID();
  await sql`INSERT INTO auth.users (id, aud, role, email) VALUES (${quinn}::uuid, 'authenticated', 'authenticated', ${`conv-${quinn}@example.test`})`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${quinn}::uuid, 'quinn')`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${s.id}::uuid, ${quinn}::uuid, 'member')`;
  const live = async (c: string) => (await members(sql, c)).users.includes(quinn);
  assert.deepEqual([await live(g), await live(room)], [true, false], "a new member joins only #general");

  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${s.id}::uuid AND user_id = ${s.people.pat!}::uuid`;
  const rows = await sql<{ c: string; left: boolean }[]>`SELECT conversation_id::text AS c, left_at IS NOT NULL AS left
    FROM swarm.conversation_members WHERE workspace_id = ${s.id}::uuid
      AND (member_user_id = ${s.people.pat!}::uuid OR member_agent_principal_id = ${s.agents.agentP!}::uuid)`;
  assert.ok(rows.length >= 5 && rows.every((r) => r.left), `pat and pat's agent leave every conversation: ${JSON.stringify(rows)}`);

  await sql`UPDATE swarm.memberships SET revoked_at = NULL WHERE workspace_id = ${s.id}::uuid AND user_id = ${s.people.pat!}::uuid`;
  const back = async (c: string) => (await members(sql, c)).users.includes(s.people.pat!);
  assert.deepEqual([await back(g), await back(room), await back(pair), await back(trio)], [true, false, false, false],
    "a re-add starts with #general and nothing else");
  const [fresh] = await sql<{ fresh: boolean }[]>`SELECT joined_at > (SELECT min(joined_at) FROM swarm.conversation_members
      WHERE conversation_id = ${g}::uuid) AS fresh
    FROM swarm.conversation_members WHERE conversation_id = ${g}::uuid AND member_user_id = ${s.people.pat!}::uuid`;
  assert.equal(fresh!.fresh, true, "with a fresh membership");
  // The 1:1 opens fresh for both: a new generation, since its old one has a member who left.
  const reopened = await open(s.people.olive!, "user", [s.people.pat!], [], false, s);
  assert.deepEqual([reopened.created, (reopened.conversation as Result).generation], [true, 1]);
  assert.notEqual(idOf(reopened), pair);

  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${s.agents.agentP!}::uuid`;
  assert.equal((await members(sql, g)).agents.includes(s.agents.agentP!), false, "a revoked agent leaves too");
});

test("read marks are written to both tables and agree; today's writers are followed into conversation_reads", async () => {
  const g = await general(sql, w);
  const message = await post(sql, w, { from: w.people.bob! });
  const mark = async (by: string, kind: "user" | "agent", conversation: string, through: string | null) =>
    await asEdge(async (tx) => (await tx<{ r: Result }[]>`SELECT swarm.conversation_mark_read(${w.id}::uuid, ${kind},
      ${by}::uuid, ${conversation}::uuid, ${through}::uuid) AS r`)[0]!.r);
  assert.equal((await mark(w.people.alice!, "user", g, message)).status, "ok");
  const both = async (user: string) => (await sql<{ old: string; new: string }[]>`
    SELECT (SELECT to_jsonb(ARRAY[read_through_at::text, read_through_id::text])::text FROM swarm.human_channel_reads
        WHERE workspace_id = ${w.id}::uuid AND user_id = ${user}::uuid AND channel_id IS NULL) AS old,
      (SELECT to_jsonb(ARRAY[read_through_at::text, read_through_id::text])::text FROM swarm.conversation_reads
        WHERE conversation_id = ${g}::uuid AND member_user_id = ${user}::uuid) AS new`)[0]!;
  let pair = await both(w.people.alice!);
  assert.ok(pair.old !== null && pair.old.includes(message));
  assert.equal(pair.new, pair.old, "the command's mark is the same in both tables");

  // mark_channel_read writes only the old table; the new one follows, forward only.
  await sql`INSERT INTO swarm.human_channel_reads (workspace_id, user_id, channel_id, read_through_at, read_through_id)
    VALUES (${w.id}::uuid, ${w.people.carol!}::uuid, NULL, clock_timestamp(), NULL)`;
  pair = await both(w.people.carol!);
  assert.equal(pair.new, pair.old);
  await sql`UPDATE swarm.human_channel_reads SET read_through_at = read_through_at - interval '1 hour'
    WHERE workspace_id = ${w.id}::uuid AND user_id = ${w.people.carol!}::uuid AND channel_id IS NULL`;
  assert.notEqual((await both(w.people.carol!)).new, (await both(w.people.carol!)).old, "never backwards");

  // An agent's mark goes to agent_channel_reads, read by its unread today, and follows on.
  assert.equal((await mark(w.agents.agentA!, "agent", g, null)).status, "ok");
  const [agent] = await sql<{ old: Date; new: Date; id: string | null }[]>`
    SELECT (SELECT read_through_at FROM swarm.agent_channel_reads WHERE workspace_id = ${w.id}::uuid
        AND principal_id = ${w.agents.agentA!}::uuid AND channel_id IS NULL) AS old,
      (SELECT read_through_at FROM swarm.conversation_reads WHERE conversation_id = ${g}::uuid
        AND member_agent_principal_id = ${w.agents.agentA!}::uuid) AS new,
      (SELECT read_through_id::text FROM swarm.conversation_reads WHERE conversation_id = ${g}::uuid
        AND member_agent_principal_id = ${w.agents.agentA!}::uuid) AS id`;
  assert.equal(agent!.new.getTime(), agent!.old.getTime());
  assert.equal(agent!.id, null, "through now is a moment, with no message id");

  // A 1:1 has only the new table; a stranger and a message from elsewhere answer as unknown.
  const dm = idOf(await open(w.people.alice!, "user", [w.people.dave!]));
  const inDm = await explicit(dm, { from: w.people.dave!, to: [u("alice")] });
  assert.equal((await mark(w.people.alice!, "user", dm, inDm)).status, "ok");
  assert.equal((await sql`SELECT 1 FROM swarm.conversation_reads WHERE conversation_id = ${dm}::uuid
    AND member_user_id = ${w.people.alice!}::uuid AND read_through_id = ${inDm}::uuid`).length, 1);
  assert.equal((await mark(w.people.carol!, "user", dm, null)).status, "not_found");
  assert.equal((await mark(w.people.alice!, "user", dm, message)).status, "signal_not_found");

  // Today's channel_preference_set is followed onto the member row.
  await sql`INSERT INTO swarm.channel_preferences (workspace_id, user_id, channel_id, involvement)
    VALUES (${w.id}::uuid, ${w.people.bob!}::uuid, NULL, 'muted')
    ON CONFLICT (workspace_id, user_id, target_key) DO UPDATE SET involvement = 'muted'`;
  assert.equal((await sql<{ n: string }[]>`SELECT notify_level AS n FROM swarm.conversation_members
    WHERE conversation_id = ${g}::uuid AND member_user_id = ${w.people.bob!}::uuid`)[0]!.n, "muted");
});

test("step 2a grants the edge its ten commands and nothing else; no client role calls any of it", async () => {
  const edge = ["conversation_open(uuid,text,uuid,uuid[],uuid[],boolean)", "conversation_join(uuid,text,uuid,uuid)",
    "conversation_leave(uuid,text,uuid,uuid)", "conversation_invite(uuid,text,uuid,uuid,uuid[],uuid[])",
    "conversation_remove(uuid,text,uuid,uuid,text,uuid)", "conversation_mark_read(uuid,text,uuid,uuid,uuid)",
    "conversation_set_notify(uuid,text,uuid,uuid,text,boolean,integer)",
    "conversation_post_route(uuid,text,uuid,uuid,uuid[],uuid[])", "conversation_prefile(uuid,uuid,uuid)",
    "conversation_group_departed(uuid,text,uuid,uuid[],uuid[])"];
  const internal = ["conversation_check_route(uuid,uuid,uuid)", "send_signal_frames(uuid,uuid)",
    "signal_frame_readers(uuid,uuid)", "conversation_member_join(uuid,uuid,text,uuid)", "conversation_next_generation(uuid,text,uuid)",
    "conversation_target(uuid,text,uuid,uuid)", "conversation_lock_workspace(uuid)"];
  const can = async (role: string, fn: string) => (await sql<{ ok: boolean }[]>`
    SELECT has_function_privilege(${role}, ${`swarm.${fn}`}, 'EXECUTE') AS ok`)[0]!.ok;
  for (const fn of edge) assert.equal(await can("swarm_command", fn), true, fn);
  for (const fn of internal) assert.equal(await can("swarm_command", fn), false, fn);
  for (const role of ["anon", "authenticated", "swarm_read"]) {
    for (const fn of [...edge, ...internal]) assert.equal(await can(role, fn), false, `${role}: ${fn}`);
  }
  for (const table of ["conversations", "conversation_members", "conversation_signals", "conversation_reads"]) {
    await assert.rejects(asEdge((tx) => tx.unsafe(`SELECT 1 FROM swarm.${table} LIMIT 1`)), refusedBy("42501"), table);
  }
});
