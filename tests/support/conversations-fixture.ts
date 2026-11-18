/** Conversations (20261118000004) against real Postgres: a workspace of people and agents, and messages
 * written the way today's edge writes them (swarm_command, one transaction: the signal, then its
 * recipient rows, then its mentions). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export function localSql(): Sql {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as { DB_URL?: string };
  assert.ok(status.DB_URL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.DB_URL).hostname));
  return postgres(status.DB_URL, { prepare: false, max: 3, onnotice: () => {} });
}

export type Space = { id: string; people: Record<string, string>; agents: Record<string, string> };

/** A workspace whose first person owns it; each agent is [name, owner's name]. */
export async function space(sql: Sql, people: string[], agents: Array<[string, string]> = []): Promise<Space> {
  const id = randomUUID();
  const ids: Record<string, string> = Object.fromEntries(people.map((p) => [p, randomUUID()]));
  const agentIds: Record<string, string> = Object.fromEntries(agents.map(([a]) => [a, randomUUID()]));
  await sql.begin(async (tx) => {
    for (const [name, user] of Object.entries(ids)) {
      await tx`INSERT INTO auth.users (id, aud, role, email)
        VALUES (${user}::uuid, 'authenticated', 'authenticated', ${`conv-${user}@example.test`})`;
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${user}::uuid, ${name})`;
    }
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${id}::uuid, 'Conversations', ${ids[people[0]!]!}::uuid)`;
    for (const [index, name] of people.entries()) {
      await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${id}::uuid, ${ids[name]!}::uuid, ${index === 0 ? "owner" : "member"})`;
    }
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${id}::uuid, 'workspace')`;
    for (const [name, owner] of agents) {
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${agentIds[name]!}::uuid, ${id}::uuid, ${ids[owner]!}::uuid, ${`${name}-${agentIds[name]!.slice(0, 8)}`})`;
    }
  });
  return { id, people: ids, agents: agentIds };
}

export async function channel(sql: Sql, s: Space, by: string, visibility: "open" | "private" = "open"): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, visibility)
    VALUES (${id}::uuid, ${s.id}::uuid, ${`c-${id.slice(0, 8)}`}, ${by}::uuid, 'user', ${visibility})`;
  return id;
}

export type Who = { user: string } | { agent: string };
export type Message = {
  from: string; fromKind?: "user" | "agent"; to?: Who[]; channel?: string; root?: string; inReplyTo?: string;
  mention?: Who; body?: string;
  /** The message's id, when a witness must look for it after a refusal. */
  id?: string;
  /** Runs in the message's transaction after its rows (a later edge's prefiled mapping, say). */
  then?: (tx: Tx, id: string) => Promise<unknown>;
  /** Runs first in the transaction (SET CONSTRAINTS, say). */
  first?: (tx: Tx) => Promise<unknown>;
};

/** A message as the edge writes it: entry 0 of `to` is also the scalar recipient. */
export async function post(sql: Sql, s: Space, m: Message): Promise<string> {
  const id = m.id ?? randomUUID();
  const first = m.to?.[0];
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await m.first?.(tx);
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id,
        kind, body, until, channel_id, thread_root_id, in_reply_to)
      VALUES (${id}::uuid, ${s.id}::uuid, ${m.from}::uuid, ${m.fromKind ?? "user"},
        ${first && "user" in first ? first.user : null}::uuid, ${first && "agent" in first ? first.agent : null}::uuid,
        'note', ${m.body ?? "conversations"}, clock_timestamp() + interval '1 day',
        ${m.channel ?? null}::uuid, ${m.root ?? null}::uuid, ${m.inReplyTo ?? null}::uuid)`;
    for (const [position, r] of (m.to && m.to.length > 1 ? m.to : []).entries()) {
      await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, recipient_agent_principal_id, position)
        VALUES (${id}::uuid, ${s.id}::uuid, ${"user" in r ? r.user : null}::uuid, ${"agent" in r ? r.agent : null}::uuid, ${position})`;
    }
    if (m.mention) {
      await tx`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_user_id, mentioned_agent_principal_id, position)
        VALUES (${id}::uuid, ${s.id}::uuid, ${"user" in m.mention ? m.mention.user : null}::uuid,
          ${"agent" in m.mention ? m.mention.agent : null}::uuid, 0)`;
    }
    await m.then?.(tx, id);
  });
  return id;
}

export type Filed = { conversation: string; kind: string; audience: string };

export async function filed(sql: Sql, signal: string): Promise<Filed | null> {
  const [row] = await sql<Filed[]>`
    SELECT cs.conversation_id::text AS conversation, c.kind, cs.audience
    FROM swarm.conversation_signals AS cs JOIN swarm.conversations AS c ON c.conversation_id = cs.conversation_id
    WHERE cs.signal_id = ${signal}::uuid`;
  return row ? { ...row } : null;
}

export async function members(sql: Sql, conversation: string): Promise<{ users: string[]; agents: string[] }> {
  const rows = await sql<{ u: string | null; a: string | null }[]>`
    SELECT member_user_id::text AS u, member_agent_principal_id::text AS a
    FROM swarm.conversation_members WHERE conversation_id = ${conversation}::uuid AND left_at IS NULL`;
  return {
    users: rows.flatMap((r) => r.u ? [r.u] : []).sort(),
    agents: rows.flatMap((r) => r.a ? [r.a] : []).sort(),
  };
}

export async function general(sql: Sql, s: Space): Promise<string> {
  const [row] = await sql<{ c: string }[]>`
    SELECT conversation_id::text AS c FROM swarm.conversations WHERE workspace_id = ${s.id}::uuid AND kind = 'general'`;
  assert.ok(row, "the workspace has its #general");
  return row.c;
}

/** postgres.js surfaces the server's SQLSTATE and constraint name; witnesses check both. */
export function refusedBy(code: string, constraint?: string) {
  return (error: unknown) => {
    const e = error as { code?: string; constraint_name?: string };
    assert.equal(e.code, code, String(error));
    if (constraint !== undefined) assert.equal(e.constraint_name, constraint, String(error));
    return true;
  };
}
