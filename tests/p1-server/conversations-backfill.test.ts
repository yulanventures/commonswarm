/** Conversations, step 1 (20261118000004): the backfill, against real Postgres. The fixture is written
 * the way the database looked before the migration: inside its transaction the filing, #general and
 * channel triggers are off, and so are step 2a's membership and read-mark triggers (20261118000005), so
 * nothing is filed and no conversation exists until the backfill runs. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { filed, general, localSql, members, space, type Space, type Sql, type Tx } from "../support/conversations-fixture.js";

let sql: Sql;
const ws = randomUUID();
const id = (): string => randomUUID();
const people = { alice: id(), bob: id(), carol: id(), dave: id() };
const agents = { lead: id(), poster: id(), reader: id(), wsLead: id(), revoked: id(), idle: id() };
const rooms = { led: id(), posted: id(), read: id(), archived: id(), secret: id() };
const m: Record<string, string> = {};
let other: Space;
let firstRun: { general: number; filed: number; members: number; reads: number; unplaced: Record<string, number> };

const triggers = [
  ["swarm.signals", "signals_settle_conversation"], ["swarm.signal_recipients", "signal_recipients_settle_conversation"],
  ["swarm.workspaces", "workspaces_create_general"], ["swarm.channels", "channels_sync_conversation"],
  ["swarm.channels", "channels_sync_creator_member"], ["swarm.memberships", "memberships_conversation_upkeep"],
  ["swarm.agent_workspace_memberships", "agent_workspace_memberships_conversation_upkeep"],
  ["swarm.agent_principals", "agent_principals_conversation_upkeep"],
  ["swarm.human_channel_reads", "human_channel_reads_follow_conversation"],
  ["swarm.agent_channel_reads", "agent_channel_reads_follow_conversation"],
  ["swarm.channel_preferences", "channel_preferences_follow_conversation"],
] as const;

async function legacy(tx: Tx, key: string, row: {
  from: string; fromKind?: "user" | "agent"; toUser?: string; toAgent?: string; recipients?: Array<{ u?: string; a?: string }>;
  channel?: string; root?: string; mention?: string;
}): Promise<void> {
  m[key] = id();
  await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, kind,
      body, until, channel_id, thread_root_id, created_at)
    VALUES (${m[key]!}::uuid, ${ws}::uuid, ${row.from}::uuid, ${row.fromKind ?? "user"}, ${row.toUser ?? null}::uuid,
      ${row.toAgent ?? null}::uuid, 'note', ${key}, clock_timestamp() + interval '1 day', ${row.channel ?? null}::uuid,
      ${row.root ? m[row.root]! : null}::uuid, clock_timestamp())`;
  for (const [position, r] of (row.recipients ?? []).entries()) {
    await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, recipient_agent_principal_id, position)
      VALUES (${m[key]!}::uuid, ${ws}::uuid, ${r.u ?? null}::uuid, ${r.a ?? null}::uuid, ${position})`;
  }
  if (row.mention) {
    await tx`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_agent_principal_id, position)
      VALUES (${m[key]!}::uuid, ${ws}::uuid, ${row.mention}::uuid, 0)`;
  }
}

before(async () => {
  sql = localSql();
  other = await space(sql, ["olga"], [["outsider", "olga"]]);
  await sql.begin(async (tx) => {
    for (const [table, trigger] of triggers) await tx.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    for (const [name, user] of Object.entries(people)) {
      await tx`INSERT INTO auth.users (id, aud, role, email) VALUES (${user}::uuid, 'authenticated', 'authenticated', ${`bf-${user}@example.test`})`;
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${user}::uuid, ${name})`;
    }
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${ws}::uuid, 'Backfill', ${people.alice}::uuid)`;
    for (const [name, user] of Object.entries(people)) {
      await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${ws}::uuid, ${user}::uuid, ${name === "alice" ? "owner" : "member"})`;
    }
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${id()}::uuid, ${ws}::uuid, 'workspace')`;
    const owners: Record<keyof typeof agents, string> = {
      lead: people.alice, poster: people.bob, reader: people.carol, wsLead: people.alice, revoked: people.bob, idle: people.carol,
    };
    for (const [name, agent] of Object.entries(agents)) {
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${agent}::uuid, ${ws}::uuid, ${owners[name as keyof typeof agents]}::uuid, ${`bf-${name}-${agent.slice(0, 8)}`})`;
    }
    await tx`UPDATE swarm.workspaces SET lead_agent_principal_id = ${agents.wsLead}::uuid WHERE workspace_id = ${ws}::uuid`;
    for (const [name, room] of Object.entries(rooms)) {
      await tx`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, visibility,
          lead_mode, lead_agent_principal_id, archived_at)
        VALUES (${room}::uuid, ${ws}::uuid, ${`bf-${name}-${room.slice(0, 6)}`}, ${people.alice}::uuid, 'user',
          ${name === "secret" ? "private" : "open"}, ${name === "led" ? "agent" : "workspace"},
          ${name === "led" ? agents.lead : null}::uuid, ${name === "archived" ? new Date() : null})`;
    }
    await tx`INSERT INTO swarm.channel_members (workspace_id, channel_id, member_kind, user_id, is_manager, added_by_kind, added_by_principal)
      VALUES (${ws}::uuid, ${rooms.secret}::uuid, 'user', ${people.alice}::uuid, true, 'user', ${people.alice}::uuid)`;

    await legacy(tx, "general", { from: people.alice });
    await legacy(tx, "mention", { from: people.alice, mention: agents.poster });
    await legacy(tx, "posted", { from: agents.poster, fromKind: "agent", channel: rooms.posted });
    await legacy(tx, "addressedInChannel", { from: people.bob, toUser: people.alice, channel: rooms.led });
    await legacy(tx, "secret", { from: people.alice, channel: rooms.secret });
    await legacy(tx, "dm", { from: people.alice, toUser: people.bob });
    await legacy(tx, "dmBack", { from: people.bob, toUser: people.alice });
    await legacy(tx, "fromDave", { from: people.dave, toUser: people.alice });
    await legacy(tx, "group", { from: people.alice, toUser: people.bob,
      recipients: [{ u: people.bob }, { u: people.carol }, { a: agents.poster }] });
    await legacy(tx, "agentDm", { from: people.alice, toAgent: agents.poster });
    await legacy(tx, "dmReply", { from: people.bob, root: "dm" });
    await legacy(tx, "addressedGeneralReply", { from: people.bob, toUser: people.alice, root: "general" });
    await legacy(tx, "ghost", { from: id(), toUser: people.alice });
    await legacy(tx, "ghostReply", { from: people.alice, root: "ghost" });
    await legacy(tx, "outsider", { from: other.agents.outsider!, fromKind: "agent", toUser: people.alice });

    await tx`INSERT INTO swarm.human_channel_reads (workspace_id, user_id, channel_id, read_through_at, read_through_id)
      VALUES (${ws}::uuid, ${people.alice}::uuid, NULL, clock_timestamp(), ${m.general!}::uuid),
        (${ws}::uuid, ${people.bob}::uuid, ${rooms.led}::uuid, clock_timestamp(), NULL)`;
    await tx`INSERT INTO swarm.agent_channel_reads (workspace_id, principal_id, channel_id)
      VALUES (${ws}::uuid, ${agents.reader}::uuid, ${rooms.read}::uuid)`;
    await tx`INSERT INTO swarm.agent_channel_reads (workspace_id, principal_id, channel_id, read_through_at, read_through_id)
      VALUES (${ws}::uuid, ${agents.poster}::uuid, NULL, clock_timestamp(), ${m.general!}::uuid)`;
    await tx`INSERT INTO swarm.channel_preferences (workspace_id, user_id, channel_id, starred, star_rank, involvement)
      VALUES (${ws}::uuid, ${people.alice}::uuid, ${rooms.led}::uuid, true, 0, 'everything'),
        (${ws}::uuid, ${people.bob}::uuid, NULL, false, NULL, 'muted')`;

    await tx`UPDATE swarm.memberships SET revoked_at = statement_timestamp() WHERE workspace_id = ${ws}::uuid AND user_id = ${people.dave}::uuid`;
    await tx`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${agents.revoked}::uuid`;
    // The existing deferred recipient checks run now, so the tables can be altered back.
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table, trigger] of triggers) await tx.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  });
  const [nothing] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.conversations WHERE workspace_id = ${ws}::uuid`;
  assert.equal(nothing!.n, 0, "the fixture starts as the database did before the migration");
  firstRun = (await sql<{ r: typeof firstRun }[]>`SELECT swarm.conversations_backfill() AS r`)[0]!.r;
});

after(async () => { await sql?.end({ timeout: 5 }); });

const fixtureSpace = (): Space => ({ id: ws, people, agents });
const sorted = (...ids: string[]) => [...ids].sort();

test("every message is filed by the rule; ambiguous history fails closed, stays unmapped and is counted", async () => {
  const g = await general(sql, fixtureSpace());
  assert.deepEqual(await filed(sql, m.general!), { conversation: g, kind: "general", audience: "conversation" });
  assert.deepEqual(await filed(sql, m.mention!), { conversation: g, kind: "general", audience: "conversation" },
    "mention-only goes to #general");
  assert.deepEqual(await filed(sql, m.posted!), { conversation: rooms.posted, kind: "public_channel", audience: "conversation" });
  assert.deepEqual(await filed(sql, m.addressedInChannel!), { conversation: rooms.led, kind: "public_channel", audience: "addressed" });
  assert.deepEqual(await filed(sql, m.secret!), { conversation: rooms.secret, kind: "private_channel", audience: "conversation" });
  assert.deepEqual(await filed(sql, m.addressedGeneralReply!), { conversation: g, kind: "general", audience: "addressed" },
    "a reply takes its root's conversation with its own audience");

  const dm = await filed(sql, m.dm!);
  assert.deepEqual({ kind: dm?.kind, audience: dm?.audience }, { kind: "dm", audience: "addressed" });
  assert.equal((await filed(sql, m.dmBack!))?.conversation, dm!.conversation);
  assert.deepEqual(await filed(sql, m.dmReply!), { conversation: dm!.conversation, kind: "dm", audience: "conversation" });
  assert.deepEqual(await members(sql, dm!.conversation), { users: sorted(people.alice, people.bob), agents: [] });
  const fromDave = await filed(sql, m.fromDave!);
  assert.equal(fromDave?.kind, "dm", "a person removed since keeps their history filed");
  assert.deepEqual(await members(sql, fromDave!.conversation), { users: sorted(people.alice, people.dave), agents: [] });
  const group = await filed(sql, m.group!);
  assert.equal(group?.kind, "group_dm");
  assert.deepEqual(await members(sql, group!.conversation),
    { users: sorted(people.alice, people.bob, people.carol), agents: [agents.poster] });
  assert.deepEqual(await members(sql, (await filed(sql, m.agentDm!))!.conversation), { users: [people.alice], agents: [agents.poster] });

  for (const key of ["ghost", "ghostReply", "outsider"]) {
    assert.equal(await filed(sql, m[key]!), null, `${key} stays unmapped, never in #general`);
  }
  assert.ok((firstRun.unplaced.member_unresolved ?? 0) >= 2 && (firstRun.unplaced.root_unfiled ?? 0) >= 1,
    JSON.stringify(firstRun));
  const [counted] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.signals s
    WHERE s.workspace_id = ${ws}::uuid AND NOT EXISTS (SELECT 1 FROM swarm.conversation_signals cs WHERE cs.signal_id = s.id)`;
  assert.equal(counted!.n, 3);
});

test("membership follows the owner's Slack rules", async () => {
  const g = await general(sql, fixtureSpace());
  const live = sorted(people.alice, people.bob, people.carol);
  assert.deepEqual(await members(sql, g), {
    users: live, agents: sorted(agents.lead, agents.poster, agents.reader, agents.wsLead, agents.idle),
  }, "#general: every live person, and every agent with a live seat");
  assert.deepEqual(await members(sql, rooms.led), { users: live, agents: [agents.lead] },
    "a public channel: every live person, and the agent named as its explicit lead");
  assert.deepEqual(await members(sql, rooms.posted), { users: live, agents: [agents.poster] }, "an agent that posted there");
  assert.deepEqual(await members(sql, rooms.read), { users: live, agents: [agents.reader] }, "an agent with a read mark there");
  assert.deepEqual(await members(sql, rooms.archived), { users: live, agents: [] }, "archived public channels too");
  // The workspace lead routes for every channel in workspace-lead mode, but like a Slack admin it is not joined
  // to them: with no post and no read mark it is in #general only.
  const [wsLeadRooms] = await sql<{ kinds: string[] }[]>`
    SELECT array_agg(c.kind ORDER BY c.kind) AS kinds FROM swarm.conversation_members m
    JOIN swarm.conversations c ON c.conversation_id = m.conversation_id
    WHERE c.workspace_id = ${ws}::uuid AND m.member_agent_principal_id = ${agents.wsLead}::uuid`;
  assert.deepEqual(wsLeadRooms!.kinds, ["general"]);
  assert.deepEqual(await members(sql, rooms.secret), { users: [], agents: [] }, "private channels stay in channel_members");

  const [prefs] = await sql<{ starred: boolean; rank: number | null; bob: string }[]>`
    SELECT (SELECT starred FROM swarm.conversation_members WHERE conversation_id = ${rooms.led}::uuid AND member_user_id = ${people.alice}::uuid) AS starred,
      (SELECT star_rank FROM swarm.conversation_members WHERE conversation_id = ${rooms.led}::uuid AND member_user_id = ${people.alice}::uuid) AS rank,
      (SELECT notify_level FROM swarm.conversation_members WHERE conversation_id = ${g}::uuid AND member_user_id = ${people.bob}::uuid) AS bob`;
  assert.deepEqual({ ...prefs! }, { starred: true, rank: 0, bob: "muted" }, "stars and notification levels carry over");

  const reads = await sql<{ c: string; who: string; through: string | null }[]>`
    SELECT conversation_id::text AS c, coalesce(member_user_id, member_agent_principal_id)::text AS who, read_through_id::text AS through
    FROM swarm.conversation_reads WHERE workspace_id = ${ws}::uuid ORDER BY 1, 2`;
  assert.deepEqual(reads.map((r) => ({ ...r })).sort((x, y) => (x.c + x.who).localeCompare(y.c + y.who)), [
    { c: g, who: people.alice, through: m.general! }, { c: g, who: agents.poster, through: m.general! },
    { c: rooms.led, who: people.bob, through: null }, { c: rooms.read, who: agents.reader, through: null },
  ].sort((x, y) => (x.c + x.who).localeCompare(y.c + y.who)), "a NULL channel is #general");
});

test("the backfill is idempotent, moves read marks only forward, and catches up when run again", async () => {
  const again = (await sql<{ r: typeof firstRun }[]>`SELECT swarm.conversations_backfill() AS r`)[0]!.r;
  assert.deepEqual([again.general, again.filed, again.members, again.reads], [0, 0, 0, 0], JSON.stringify(again));

  const g = await general(sql, fixtureSpace());
  const mark = async () => (await sql<{ at: Date }[]>`SELECT read_through_at AS at FROM swarm.conversation_reads
    WHERE conversation_id = ${g}::uuid AND member_user_id = ${people.alice}::uuid`)[0]!.at.getTime();
  const was = await mark();
  await sql`UPDATE swarm.human_channel_reads SET read_through_at = read_through_at + interval '1 minute'
    WHERE workspace_id = ${ws}::uuid AND user_id = ${people.alice}::uuid AND channel_id IS NULL`;
  await sql`SELECT swarm.conversations_backfill()`;
  assert.equal(await mark(), was + 60_000, "a later mark moves forward");
  await sql`UPDATE swarm.human_channel_reads SET read_through_at = read_through_at - interval '1 hour'
    WHERE workspace_id = ${ws}::uuid AND user_id = ${people.alice}::uuid AND channel_id IS NULL`;
  await sql`SELECT swarm.conversations_backfill()`;
  assert.equal(await mark(), was + 60_000, "an earlier one never moves it back");

  // Someone who joins later is in #general at once (step 2a's trigger); a member who has left keeps their row
  // and the backfill does not add them back.
  const erin = randomUUID();
  await sql`INSERT INTO auth.users (id, aud, role, email) VALUES (${erin}::uuid, 'authenticated', 'authenticated', ${`bf-${erin}@example.test`})`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${erin}::uuid, 'erin')`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${erin}::uuid, 'member')`;
  assert.equal((await members(sql, g)).users.includes(erin), true);
  await sql`UPDATE swarm.conversation_members SET left_at = statement_timestamp()
    WHERE conversation_id = ${rooms.read}::uuid AND member_user_id = ${people.carol}::uuid`;
  await sql`SELECT swarm.conversations_backfill()`;
  assert.equal((await members(sql, g)).users.includes(erin), true);
  assert.equal((await members(sql, rooms.read)).users.includes(people.carol), false, "leaving is kept");
});
