/** Conversations, step 1 (20261118000004): every new message is filed at commit, by the database, for
 * a writer that posts exactly as today's edge does (swarm_command). Real Postgres. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  channel, filed, general, localSql, members, post, refusedBy, space, type Space, type Sql,
} from "../support/conversations-fixture.js";

let sql: Sql;
let w: Space;
let other: Space;

before(async () => {
  sql = localSql();
  w = await space(sql, ["alice", "bob", "carol"], [["agentA", "alice"], ["agentB", "bob"]]);
  other = await space(sql, ["olga"]);
});
after(async () => { await sql?.end({ timeout: 5 }); });

const u = (name: string) => ({ user: w.people[name]! });
const a = (name: string) => ({ agent: w.agents[name]! });

test("a new workspace has its #general, and a channel has its conversation under the channel's own id", async () => {
  const fresh = await space(sql, ["solo"]);
  const [g] = await sql<{ n: number; by: string }[]>`
    SELECT count(*)::int AS n, min(created_by_principal::text) AS by FROM swarm.conversations
    WHERE workspace_id = ${fresh.id}::uuid AND kind = 'general'`;
  assert.deepEqual([g!.n, g!.by], [1, fresh.people.solo]);

  const open = await channel(sql, w, w.people.alice!);
  const kindOf = async () => (await sql<{ kind: string; archived: boolean }[]>`
    SELECT kind, archived_at IS NOT NULL AS archived FROM swarm.conversations
    WHERE conversation_id = ${open}::uuid AND workspace_id = ${w.id}::uuid AND channel_id = ${open}::uuid`)[0];
  assert.deepEqual({ ...(await kindOf())! }, { kind: "public_channel", archived: false });
  await sql`UPDATE swarm.channels SET archived_at = statement_timestamp() WHERE channel_id = ${open}::uuid`;
  assert.deepEqual({ ...(await kindOf())! }, { kind: "public_channel", archived: true }, "archive follows the channel");
  await sql`UPDATE swarm.channels SET archived_at = NULL WHERE channel_id = ${open}::uuid`;

  // A public channel's members live here; when it turns private they stay in channel_members only.
  await sql`INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id)
    VALUES (${open}::uuid, ${w.id}::uuid, ${w.people.bob!}::uuid)`;
  await sql`UPDATE swarm.channels SET visibility = 'private' WHERE channel_id = ${open}::uuid`;
  assert.deepEqual({ ...(await kindOf())! }, { kind: "private_channel", archived: false }, "kind follows visibility");
  assert.deepEqual(await members(sql, open), { users: [], agents: [] });
  await assert.rejects(sql`INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id)
    VALUES (${open}::uuid, ${w.id}::uuid, ${w.people.bob!}::uuid)`, refusedBy("23514"));
  // Private never reopens (the channel's own trigger), and the conversation cannot be turned back either.
  await assert.rejects(sql`UPDATE swarm.channels SET visibility = 'open' WHERE channel_id = ${open}::uuid`);
  await assert.rejects(sql`UPDATE swarm.conversations SET kind = 'public_channel' WHERE conversation_id = ${open}::uuid`,
    refusedBy("55000"));
  const g2 = await general(sql, w);
  await assert.rejects(sql`UPDATE swarm.conversations SET kind = 'dm' WHERE conversation_id = ${g2}::uuid`, refusedBy("55000"));
  await assert.rejects(sql`INSERT INTO swarm.conversations (workspace_id, kind, created_by_kind, created_by_principal)
    VALUES (${w.id}::uuid, 'general', 'user', ${w.people.alice!}::uuid)`, refusedBy("23505"), "one #general per workspace");
});

test("every kind files at commit by the rule, with its audience; mentions do not address", async () => {
  const g = await general(sql, w);
  const room = await channel(sql, w, w.people.alice!);
  const plain = await post(sql, w, { from: w.people.alice! });
  const mention = await post(sql, w, { from: w.people.alice!, mention: a("agentB") });
  const inRoom = await post(sql, w, { from: w.people.alice!, channel: room });
  const reply = await post(sql, w, { from: w.people.bob!, channel: room, root: inRoom });
  const addressedReply = await post(sql, w, { from: w.people.bob!, channel: room, root: inRoom, to: [u("alice")] });
  const addressedInRoom = await post(sql, w, { from: w.people.bob!, channel: room, to: [u("alice")], inReplyTo: inRoom });
  const generalReply = await post(sql, w, { from: w.people.bob!, root: plain });
  const addressedGeneralReply = await post(sql, w, { from: w.people.bob!, root: plain, to: [u("alice")] });

  assert.deepEqual(await filed(sql, plain), { conversation: g, kind: "general", audience: "conversation" });
  assert.deepEqual(await filed(sql, mention), { conversation: g, kind: "general", audience: "conversation" },
    "mention-only goes to #general");
  assert.deepEqual(await filed(sql, inRoom), { conversation: room, kind: "public_channel", audience: "conversation" });
  assert.deepEqual(await filed(sql, reply), { conversation: room, kind: "public_channel", audience: "conversation" });
  assert.deepEqual(await filed(sql, addressedReply), { conversation: room, kind: "public_channel", audience: "addressed" },
    "an addressed channel reply stays in its channel, with its own audience");
  assert.deepEqual(await filed(sql, addressedInRoom), { conversation: room, kind: "public_channel", audience: "addressed" });
  assert.deepEqual(await filed(sql, generalReply), { conversation: g, kind: "general", audience: "conversation" });
  assert.deepEqual(await filed(sql, addressedGeneralReply), { conversation: g, kind: "general", audience: "addressed" },
    "a reply takes its root's conversation and keeps its own audience");

  const toBob = await post(sql, w, { from: w.people.alice!, to: [u("bob")] });
  const back = await post(sql, w, { from: w.people.bob!, to: [u("alice")] });
  const pair = await filed(sql, toBob);
  assert.deepEqual({ kind: pair?.kind, audience: pair?.audience }, { kind: "dm", audience: "addressed" });
  assert.equal((await filed(sql, back))?.conversation, pair!.conversation, "both directions share the 1:1");
  assert.deepEqual(await members(sql, pair!.conversation), { users: [w.people.alice!, w.people.bob!].sort(), agents: [] });

  // Entry 0 repeats the scalar column; the sender named again collapses.
  const group = await post(sql, w, { from: w.people.alice!, to: [u("bob"), u("carol"), a("agentB"), u("alice")] });
  const grouped = await filed(sql, group);
  assert.equal(grouped?.kind, "group_dm");
  assert.deepEqual(await members(sql, grouped!.conversation),
    { users: [w.people.alice!, w.people.bob!, w.people.carol!].sort(), agents: [w.agents.agentB!] });

  const toAgent = await post(sql, w, { from: w.people.alice!, to: [a("agentB")] });
  const agentAnswer = await post(sql, w, { from: w.agents.agentB!, fromKind: "agent", to: [u("alice")] });
  assert.equal((await filed(sql, agentAnswer))?.conversation, (await filed(sql, toAgent))?.conversation);
  const note = await post(sql, w, { from: w.agents.agentA!, fromKind: "agent", to: [a("agentA")] });
  assert.deepEqual(await members(sql, (await filed(sql, note))!.conversation), { users: [], agents: [w.agents.agentA!] });

  const [copied] = await sql<{ same: boolean }[]>`SELECT cs.created_at = s.created_at AS same
    FROM swarm.conversation_signals cs JOIN swarm.signals s ON s.id = cs.signal_id WHERE cs.signal_id = ${group}::uuid`;
  assert.equal(copied!.same, true, "the row carries the message's own time");
});

test("final recipients written after the signal still file correctly; filing early then changing the set is refused", async () => {
  // As the edge writes: the signal, then each recipient row in its own statement.
  const late = await post(sql, w, { from: w.people.carol!, to: [u("alice"), u("bob"), a("agentA")] });
  const lateGroup = await filed(sql, late);
  assert.equal(lateGroup?.kind, "group_dm");
  assert.deepEqual(await members(sql, lateGroup!.conversation),
    { users: [w.people.alice!, w.people.bob!, w.people.carol!].sort(), agents: [w.agents.agentA!] });

  // Forcing the filing to run at the signal's INSERT, before its recipients: the later rows re-check it.
  const body = `early ${randomUUID()}`;
  await assert.rejects(post(sql, w, {
    from: w.people.carol!, to: [u("alice"), u("bob")], body,
    first: (tx) => tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE"),
  }), refusedBy("23514", "conversation_signals_placement"));
  assert.equal((await sql`SELECT 1 FROM swarm.signals WHERE body = ${body}`).length, 0);
  // Positive control: the same early filing with no later rows commits.
  const early = await post(sql, w, { from: w.people.carol!, to: [u("alice")], first: (tx) => tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE") });
  assert.equal((await filed(sql, early))?.kind, "dm");
});

test("a mapping row is recomputed, never trusted: a wrong one aborts at commit, a right one commits", async () => {
  const g = await general(sql, w);
  const pair = (await filed(sql, await post(sql, w, { from: w.people.alice!, to: [u("carol")] })))!.conversation;
  const prefile = (conversation: string, audience: string) => async (tx: import("../support/conversations-fixture.js").Tx, id: string) => {
    await tx.unsafe("RESET ROLE");
    await tx`INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
      VALUES (${id}::uuid, ${w.id}::uuid, ${conversation}::uuid, statement_timestamp(), ${audience})`;
  };
  // The INSERT itself succeeds; the refusal comes at commit.
  for (const [label, conversation, audience] of [
    ["another conversation", g, "addressed"], ["the right conversation, the wrong audience", pair, "conversation"],
  ] as const) {
    const body = `prefiled ${randomUUID()}`;
    await assert.rejects(post(sql, w, { from: w.people.alice!, to: [u("carol")], body, then: prefile(conversation, audience) }),
      refusedBy("23514", "conversation_signals_placement"), label);
    assert.equal((await sql`SELECT 1 FROM swarm.signals WHERE body = ${body}`).length, 0, label);
  }
  const right = await post(sql, w, { from: w.people.alice!, to: [u("carol")], then: prefile(pair, "addressed") });
  assert.deepEqual(await filed(sql, right), { conversation: pair, kind: "dm", audience: "addressed" });

  // A row for an older message is recomputed as well: a message that cannot be placed takes none.
  const ghost = randomUUID();
  const unplaceable = await post(sql, w, { from: ghost, to: [u("alice")] });
  assert.equal(await filed(sql, unplaceable), null, "a sender that does not resolve leaves the message unmapped");
  await assert.rejects(sql`INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
    VALUES (${unplaceable}::uuid, ${w.id}::uuid, ${g}::uuid, statement_timestamp(), 'addressed')`,
  refusedBy("23514", "conversation_signals_placement"));
});

test("a cross-tenant root or conversation is refused by the composite keys", async () => {
  const theirs = await post(sql, other, { from: other.people.olga! });
  await assert.rejects(post(sql, w, { from: w.people.alice!, root: theirs }),
    refusedBy("23503", "signals_thread_root_workspace"), "another workspace's root never reaches the filer");
  const theirGeneral = await general(sql, other);
  await assert.rejects(post(sql, w, {
    from: w.people.alice!,
    then: async (tx, id) => {
      await tx.unsafe("RESET ROLE");
      await tx`INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
        VALUES (${id}::uuid, ${w.id}::uuid, ${theirGeneral}::uuid, statement_timestamp(), 'conversation')`;
    },
  }), refusedBy("23503"), "another workspace's conversation");
  await assert.rejects(post(sql, w, {
    from: w.people.alice!,
    then: async (tx, id) => {
      await tx.unsafe("RESET ROLE");
      await tx`INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
        VALUES (${id}::uuid, ${other.id}::uuid, ${theirGeneral}::uuid, statement_timestamp(), 'conversation')`;
    },
  }), refusedBy("23503"), "a row claiming another workspace for this message");
});

test("the group-leave fence: an old-edge post to a group someone left is refused with no delivery and no realtime frame", async () => {
  const founding = [u("bob"), u("carol"), a("agentB")];
  // Every topic: the workspace topic, people's own topics and the agent's wake topic. Some Realtime versions
  // store the sent object under payload.payload.
  const traces = async (id: string) => (await sql<{ deliveries: number; frames: number; signals: number }[]>`
    SELECT (SELECT count(*)::int FROM swarm.signal_deliveries WHERE signal_id = ${id}::uuid) AS deliveries,
      (SELECT count(*)::int FROM realtime.messages
        WHERE coalesce(payload -> 'payload' ->> 'signal_id', payload ->> 'signal_id') = ${id}) AS frames,
      (SELECT count(*)::int FROM swarm.signals WHERE id = ${id}::uuid) AS signals`)[0]!;
  const allFrames = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM realtime.messages`)[0]!.n;

  // Positive control: before anyone leaves, the post delivers to the agent and sends its frames.
  const before = await post(sql, w, { from: w.people.alice!, to: founding });
  const group = (await filed(sql, before))!.conversation;
  const sent = await traces(before);
  assert.ok(sent.deliveries === 1 && sent.signals === 1 && sent.frames > 0, JSON.stringify(sent));

  // Nobody can leave in this step, so carol leaves in SQL.
  await sql`UPDATE swarm.conversation_members SET left_at = statement_timestamp()
    WHERE conversation_id = ${group}::uuid AND member_user_id = ${w.people.carol!}::uuid`;
  const refused = randomUUID();
  const framesBefore = await allFrames();
  await assert.rejects(post(sql, w, { id: refused, from: w.people.alice!, to: founding }),
    refusedBy("23514", "conversation_group_member_left"));
  assert.deepEqual({ ...(await traces(refused)) }, { deliveries: 0, frames: 0, signals: 0 },
    "no message, no delivery, and no frame on any topic");
  assert.equal(await allFrames(), framesBefore, "nothing at all reached realtime.messages");
  // Any sender of the founding set is refused, including someone who stayed.
  await assert.rejects(post(sql, w, { from: w.people.bob!, to: [u("alice"), u("carol"), a("agentB")] }),
    refusedBy("23514", "conversation_group_member_left"));

  // The remaining set is a different set and files normally, into a different conversation.
  const remaining = await post(sql, w, { from: w.people.alice!, to: [u("bob"), a("agentB")] });
  const rest = await filed(sql, remaining);
  assert.equal(rest?.kind, "group_dm");
  assert.notEqual(rest!.conversation, group);
  const restSent = await traces(remaining);
  assert.ok(restSent.deliveries === 1 && restSent.signals === 1 && restSent.frames > 0, JSON.stringify(restSent));
  // An addressed channel post to the same set keeps its channel rule.
  const room = await channel(sql, w, w.people.alice!);
  const inRoom = await post(sql, w, { from: w.people.alice!, channel: room, to: founding });
  assert.deepEqual(await filed(sql, inRoom), { conversation: room, kind: "public_channel", audience: "addressed" });

  // A later step's explicit new group (generation 1, made here in SQL) takes the founding set's posts;
  // the old group's history stays where it was.
  const [{ key }] = await sql<{ key: string }[]>`SELECT member_key AS key FROM swarm.conversations WHERE conversation_id = ${group}::uuid`;
  const [{ id: fresh }] = await sql<{ id: string }[]>`
    INSERT INTO swarm.conversations (workspace_id, kind, member_key, generation, created_by_kind, created_by_principal)
    VALUES (${w.id}::uuid, 'group_dm', ${key}, 1, 'user', ${w.people.alice!}::uuid) RETURNING conversation_id::text AS id`;
  await sql`INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id)
    SELECT ${fresh}::uuid, ${w.id}::uuid, x FROM unnest(${[w.people.alice!, w.people.bob!, w.people.carol!]}::uuid[]) AS x`;
  await sql`INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_agent_principal_id)
    VALUES (${fresh}::uuid, ${w.id}::uuid, ${w.agents.agentB!}::uuid)`;
  const again = await post(sql, w, { from: w.people.alice!, to: founding });
  assert.equal((await filed(sql, again))?.conversation, fresh);
  assert.equal((await filed(sql, before))?.conversation, group, "history stays in the old group");
});

test("filed messages are append-only, the cap is nine, and the founding set is the key", async () => {
  const id = await post(sql, w, { from: w.people.bob!, to: [u("carol")] });
  await assert.rejects(sql`UPDATE swarm.conversation_signals SET audience = 'conversation' WHERE signal_id = ${id}::uuid`,
    /SWARM_APPEND_ONLY/);
  await assert.rejects(sql`DELETE FROM swarm.conversation_signals WHERE signal_id = ${id}::uuid`, /SWARM_APPEND_ONLY/);

  const forMembers = async (users: string[], agents: string[] = [], creator = w.people.alice!) => (await sql<{ c: string | null }[]>`
    SELECT swarm.conversation_for_members(${w.id}::uuid, 'user', ${creator}::uuid, ${users}::uuid[], ${agents}::uuid[],
      true, NULL)::text AS c`)[0]!.c;
  const trio = await forMembers([w.people.bob!, w.people.carol!], [w.agents.agentA!]);
  assert.equal(await forMembers([w.people.carol!, w.people.bob!, w.people.bob!, w.people.alice!], [w.agents.agentA!]), trio,
    "order, repeats and the creator named again do not matter");
  assert.equal(await forMembers([w.people.alice!, w.people.carol!], [w.agents.agentA!], w.people.bob!), trio,
    "any founder of the same set");
  // The cap is checked before any row is written, so made-up ids are enough to reach it.
  const nine = Array.from({ length: 8 }, () => randomUUID());
  assert.equal(await forMembers(nine.concat(randomUUID())), null, "ten members is over the cap");
});

test("step 1 exposes nothing: no client role reads, writes or calls any of it, while their posts still file", async () => {
  const tables = ["conversations", "conversation_members", "conversation_signals", "conversation_reads"];
  const calls = [
    "swarm.conversations_backfill()",
    `swarm.conversation_general('${w.id}'::uuid)`,
    `swarm.conversation_for_channel('${w.id}'::uuid, gen_random_uuid())`,
    `swarm.conversation_for_members('${w.id}'::uuid, 'user', gen_random_uuid(), '{}'::uuid[], '{}'::uuid[], true, NULL)`,
    `swarm.conversation_placement('${w.id}'::uuid, gen_random_uuid(), true)`,
    `swarm.file_conversation_signal('${w.id}'::uuid, gen_random_uuid())`,
  ];
  for (const role of ["anon", "authenticated", "swarm_read", "swarm_command"]) {
    for (const table of tables) {
      for (const statement of [`SELECT 1 FROM swarm.${table} LIMIT 1`, `DELETE FROM swarm.${table}`]) {
        await assert.rejects(sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx.unsafe(statement);
        }), refusedBy("42501"), `${role}: ${statement}`);
      }
    }
    for (const call of calls) {
      await assert.rejects(sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe(`SELECT ${call}`);
      }), refusedBy("42501"), `${role}: ${call}`);
    }
  }
  assert.equal((await filed(sql, await post(sql, w, { from: w.people.alice! })))?.kind, "general",
    "swarm_command's own post is filed through the triggers");
});
