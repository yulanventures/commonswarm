/** Real direct messages, step 1 (20261118000002): the conversation filer and the backfill against real
 * Postgres. Messages are written as the edge writes them; swarm.file_direct_messages() files them. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

let sql: postgres.Sql;
let workspace: string;
let alice: string;
let bob: string;
let carol: string;
let agentA: string;
let agentB: string;

before(async () => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as { DB_URL?: string };
  assert.ok(status.DB_URL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.DB_URL).hostname));
  sql = postgres(status.DB_URL, { prepare: false, max: 2 });
  workspace = randomUUID();
  [alice, bob, carol] = [randomUUID(), randomUUID(), randomUUID()];
  [agentA, agentB] = [randomUUID(), randomUUID()];
  await sql.begin(async (tx) => {
    for (const [id, name] of [[alice, "Alice"], [bob, "Bob"], [carol, "Carol"]] as const) {
      await tx`INSERT INTO auth.users (id, aud, role, email)
        VALUES (${id}::uuid, 'authenticated', 'authenticated', ${`dm-${id}@example.test`})`;
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${name})`;
    }
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'DM backfill', ${alice}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${alice}::uuid, 'owner'), (${workspace}::uuid, ${bob}::uuid, 'member'),
        (${workspace}::uuid, ${carol}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${agentA}::uuid, ${workspace}::uuid, ${alice}::uuid, ${`dm-a-${agentA.slice(0, 6)}`}),
        (${agentB}::uuid, ${workspace}::uuid, ${bob}::uuid, ${`dm-b-${agentB.slice(0, 6)}`})`;
  });
});

after(async () => { await sql?.end({ timeout: 5 }); });

type Message = {
  from: string; fromKind?: "user" | "agent"; toUser?: string; toAgent?: string;
  recipients?: Array<{ user?: string; agent?: string }>; channel?: string; root?: string; mentionAgent?: string;
};

/** A message as the edge writes it, in one transaction: the scalar recipient, one recipient row per `to`
 * entry, and its mention (swarm.signal_mentions accepts rows only from the transaction that created the signal). */
async function message(m: Message): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id,
        kind, body, until, channel_id, thread_root_id)
      VALUES (${id}::uuid, ${workspace}::uuid, ${m.from}::uuid, ${m.fromKind ?? "user"}, ${m.toUser ?? null}::uuid,
        ${m.toAgent ?? null}::uuid, 'note', 'dm backfill', clock_timestamp() + interval '1 day',
        ${m.channel ?? null}::uuid, ${m.root ?? null}::uuid)`;
    for (const [position, r] of (m.recipients ?? []).entries()) {
      await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, recipient_agent_principal_id, position)
        VALUES (${id}::uuid, ${workspace}::uuid, ${r.user ?? null}::uuid, ${r.agent ?? null}::uuid, ${position})`;
    }
    if (m.mentionAgent) {
      await tx`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_agent_principal_id, position)
        VALUES (${id}::uuid, ${workspace}::uuid, ${m.mentionAgent}::uuid, 0)`;
    }
  });
  return id;
}

const file = async () => Number((await sql<{ n: string }[]>`SELECT swarm.file_direct_messages()::text AS n`)[0]!.n);

async function filedIn(id: string): Promise<string | null> {
  const [row] = await sql<{ c: string }[]>`SELECT conversation_id::text AS c FROM swarm.conversation_signals WHERE signal_id = ${id}::uuid`;
  return row?.c ?? null;
}

async function conversation(id: string): Promise<{ kind: string; users: string[]; agents: string[] }> {
  const [c] = await sql<{ kind: string }[]>`SELECT kind FROM swarm.conversations WHERE conversation_id = ${id}::uuid`;
  const members = await sql<{ u: string | null; a: string | null }[]>`
    SELECT member_user_id::text AS u, member_agent_principal_id::text AS a FROM swarm.conversation_members
    WHERE conversation_id = ${id}::uuid`;
  return {
    kind: c!.kind,
    users: members.flatMap((m) => m.u ? [m.u] : []).sort(),
    agents: members.flatMap((m) => m.a ? [m.a] : []).sort(),
  };
}

test("direct messages are filed by their founding set, both directions in one conversation; nothing else is filed", async () => {
  const toBob = await message({ from: alice, toUser: bob });
  const fromBob = await message({ from: bob, toUser: alice });
  const group = await message({ from: alice, toUser: bob, recipients: [{ user: bob }, { user: carol }, { agent: agentB }] });
  const toAgent = await message({ from: alice, toAgent: agentB });
  const agentReply = await message({ from: agentB, fromKind: "agent", toUser: alice });
  const selfNote = await message({ from: agentA, fromKind: "agent", toAgent: agentA });
  const general = await message({ from: alice });
  const mention = await message({ from: alice, mentionAgent: agentB });
  const channelId = randomUUID();
  await sql`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at)
    VALUES (${channelId}::uuid, ${workspace}::uuid, ${`dm-${channelId.slice(0, 6)}`}, ${alice}::uuid, 'user', statement_timestamp())`;
  const inChannel = await message({ from: alice, toUser: bob, channel: channelId });
  // Thread replies follow their root: under a filed root they are filed, under a #general root they are not.
  const dmReply = await message({ from: bob, root: toBob });
  const generalReply = await message({ from: bob, toUser: alice, root: general });

  assert.ok(await file() >= 7, "the backfill files this test's messages");
  const pair = await filedIn(toBob);
  assert.ok(pair);
  assert.equal(await filedIn(fromBob), pair, "the reply direction reuses the conversation");
  assert.equal(await filedIn(dmReply), pair, "a thread reply joins its root's conversation");
  assert.deepEqual(await conversation(pair), { kind: "dm", users: [alice, bob].sort(), agents: [] });

  const grouped = await filedIn(group);
  assert.ok(grouped && grouped !== pair);
  assert.deepEqual(await conversation(grouped), { kind: "group", users: [alice, bob, carol].sort(), agents: [agentB] },
    "recipient 0 repeats the scalar column; it is counted once");

  const withAgent = await filedIn(toAgent);
  assert.equal(await filedIn(agentReply), withAgent, "an agent's answer to a person shares their conversation");
  assert.deepEqual(await conversation(withAgent!), { kind: "dm", users: [alice], agents: [agentB] });
  assert.deepEqual(await conversation((await filedIn(selfNote))!), { kind: "dm", users: [], agents: [agentA] });

  for (const [id, label] of [[general, "a #general post"], [mention, "a post that only mentions"],
    [inChannel, "an addressed channel post"], [generalReply, "an addressed reply under a #general root"]] as const) {
    assert.equal(await filedIn(id), null, `${label} is not a direct message`);
  }

  const before = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM swarm.conversation_signals WHERE workspace_id = ${workspace}::uuid`;
  await file();
  const again = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM swarm.conversation_signals WHERE workspace_id = ${workspace}::uuid`;
  assert.equal(again[0]!.n, before[0]!.n, "running it again files nothing twice");
  const created = await message({ from: carol, toUser: alice });
  await file();
  assert.ok(await filedIn(created), "a message posted later is filed by the next run");
});

test("the founding set is the key: a smaller set is another conversation, and the cap is nine", async () => {
  const filer = async (users: string[], agents: string[] = [], creator = alice) => (await sql<{ c: string | null }[]>`
    SELECT swarm.conversation_for_members(${workspace}::uuid, 'user', ${creator}::uuid, ${users}::uuid[], ${agents}::uuid[])::text AS c`)[0]!.c;
  const trio = await filer([bob, carol]);
  assert.equal(await filer([carol, bob, bob, alice]), trio, "order, repeats and the creator named again do not matter");
  assert.equal(await filer([alice, carol], [], bob), trio, "any founder of the same set");
  await sql`UPDATE swarm.conversation_members SET left_at = statement_timestamp()
    WHERE conversation_id = ${trio}::uuid AND member_user_id = ${carol}::uuid`;
  const pair = await filer([bob]);
  assert.notEqual(pair, trio, "a group someone left is not the 1:1 of the rest");
  assert.equal(await filer([bob, carol]), trio, "the founding set still names the group");

  assert.equal(await filer([], [], alice), await filer([alice]), "a note to oneself");
  const nine = Array.from({ length: 8 }, () => randomUUID());
  // The cap is checked before any row is written, so made-up ids are enough to reach it.
  assert.equal(await filer(nine.concat(randomUUID())), null, "ten members is over the cap");
});

test("filed messages are append-only, never in a channel, and no client role reads the new tables", async () => {
  const id = await message({ from: bob, toUser: carol });
  await file();
  await assert.rejects(sql`UPDATE swarm.conversation_signals SET created_at = statement_timestamp() WHERE signal_id = ${id}::uuid`,
    /SWARM_APPEND_ONLY/);
  await assert.rejects(sql`DELETE FROM swarm.conversation_signals WHERE signal_id = ${id}::uuid`, /SWARM_APPEND_ONLY/);
  const [row] = await sql<{ same: boolean }[]>`
    SELECT cs.created_at = s.created_at AS same FROM swarm.conversation_signals cs JOIN swarm.signals s ON s.id = cs.signal_id
    WHERE cs.signal_id = ${id}::uuid`;
  assert.equal(row!.same, true, "the row carries the message's own time");

  const channelId = randomUUID();
  await sql`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at)
    VALUES (${channelId}::uuid, ${workspace}::uuid, ${`dm-${channelId.slice(0, 6)}`}, ${alice}::uuid, 'user', statement_timestamp())`;
  const inChannel = await message({ from: alice, channel: channelId });
  const somewhere = await filedIn(id);
  await assert.rejects(sql`INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at)
    VALUES (${inChannel}::uuid, ${workspace}::uuid, ${somewhere}::uuid, statement_timestamp())`, /cannot join a conversation/);

  for (const role of ["authenticated", "swarm_read", "swarm_command"]) {
    for (const table of ["conversations", "conversation_members", "conversation_signals"]) {
      await assert.rejects(sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe(`SELECT 1 FROM swarm.${table} LIMIT 1`);
      }), /permission denied/, `${role} on ${table}`);
    }
    await assert.rejects(sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT swarm.file_direct_messages()`;
    }), /permission denied/, `${role} cannot run the backfill`);
  }
});
