/** Roster R1c: deploy/ops/quiet-agents.sql finds agents whose push route went quiet while
 * messages addressed to them wait, and nothing else. Runs the exact file read-only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import postgres from "postgres";

const query = readFileSync(new URL("../../deploy/ops/quiet-agents.sql", import.meta.url), "utf8");
let sql: postgres.Sql;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as { DB_URL?: string };
  assert.ok(status.DB_URL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.DB_URL).hostname));
  sql = postgres(status.DB_URL, { prepare: false, max: 2 });
});

after(async () => { await sql.end(); });

interface Agent { principal: string; name: string }

async function seed(): Promise<{ workspace: string; owner: string; agent: (name: string, opts?: { hosted?: boolean }) => Promise<Agent> }> {
  const owner = randomUUID();
  const workspace = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO auth.users (id, aud, role, email)
      VALUES (${owner}::uuid, 'authenticated', 'authenticated', ${`quiet-${owner}@example.test`})`;
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner}::uuid, 'Quiet owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'Quiet test', ${owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
  return {
    workspace, owner,
    agent: async (name, opts = {}) => {
      const principal = randomUUID();
      await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES (${principal}::uuid, ${workspace}::uuid, ${owner}::uuid, ${name}, ${opts.hosted ? "hosted_mcp" : "local"}, ${opts.hosted === true})`;
      return { principal, name };
    },
  };
}

async function presence(workspace: string, agent: Agent, watcherAgo: string | null) {
  await sql`INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at, watcher_at)
    VALUES (${workspace}::uuid, ${agent.principal}::uuid, statement_timestamp(),
      ${watcherAgo === null ? null : sql`statement_timestamp() - ${watcherAgo}::interval`})`;
}

/** The signal insert fans out its own delivery row; set its queue time and ack state.
 * An acknowledged control uses ack_outcome 'observed' with delivered_at and acked_at set and
 * no lease or error: the pairing signal_deliveries_check9 allows for an unleased ack
 * (20260925000001), within signal_deliveries_ack_outcome_check (20260828000003). */
async function waiting(workspace: string, owner: string, agent: Agent, ago: string, acked = false) {
  const signal = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, about, kind, body, until, created_at)
    VALUES (${signal}::uuid, ${workspace}::uuid, ${owner}::uuid, 'user', ${agent.principal}::uuid, NULL, 'ask', 'are you there',
      statement_timestamp() + interval '1 day', statement_timestamp() - ${ago}::interval)`;
  await sql`INSERT INTO swarm.signal_deliveries (signal_id, workspace_id, recipient_agent_principal_id, enqueued_at, delivered_at, acked_at, ack_outcome)
    VALUES (${signal}::uuid, ${workspace}::uuid, ${agent.principal}::uuid, statement_timestamp() - ${ago}::interval,
      ${acked ? sql`statement_timestamp()` : null}, ${acked ? sql`statement_timestamp()` : null}, ${acked ? "observed" : null})
    ON CONFLICT (signal_id, recipient_agent_principal_id) DO UPDATE SET
      enqueued_at = EXCLUDED.enqueued_at, delivered_at = EXCLUDED.delivered_at,
      acked_at = EXCLUDED.acked_at, ack_outcome = EXCLUDED.ack_outcome`;
}

async function quiet(workspace: string): Promise<Array<Record<string, unknown>>> {
  return await sql.begin("read only", async (tx) =>
    (await tx.unsafe(query)).filter((row: Record<string, unknown>) => row.workspace_id === workspace));
}

test("a dead watcher with a waiting message alerts; live, idle, hosted, revoked and long-retired agents do not", async () => {
  const { workspace, owner, agent } = await seed();
  const dead = await agent("Watcher died");
  await presence(workspace, dead, "10 minutes");
  await waiting(workspace, owner, dead, "8 minutes");
  await waiting(workspace, owner, dead, "5 minutes");

  const live = await agent("Watcher live");
  await presence(workspace, live, "30 seconds");
  await waiting(workspace, owner, live, "8 minutes");

  const nothingWaiting = await agent("Stopped cleanly");
  await presence(workspace, nothingWaiting, "10 minutes");
  await waiting(workspace, owner, nothingWaiting, "8 minutes", true);

  const justSent = await agent("Message just sent");
  await presence(workspace, justSent, "10 minutes");
  await waiting(workspace, owner, justSent, "1 minute");

  const retired = await agent("Gone for days");
  await presence(workspace, retired, "3 days");
  await waiting(workspace, owner, retired, "2 days");

  const turnOnly = await agent("Never had a route");
  await presence(workspace, turnOnly, null);
  await waiting(workspace, owner, turnOnly, "8 minutes");

  const hosted = await agent("Hosted seat", { hosted: true });
  await presence(workspace, hosted, "10 minutes");
  await waiting(workspace, owner, hosted, "8 minutes");

  const revoked = await agent("Revoked");
  await presence(workspace, revoked, "10 minutes");
  await waiting(workspace, owner, revoked, "8 minutes");
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${revoked.principal}::uuid`;

  const rows = await quiet(workspace);
  assert.deepEqual(rows.map((row) => row.agent), ["Watcher died"]);
  const [row] = rows;
  assert.equal(row!.waiting, 2);
  assert.equal(row!.principal_id, dead.principal);
  assert.equal(row!.owner_user_id, owner);
  assert.equal(row!.workspace, "Quiet test");
  assert.deepEqual(Object.keys(row!).sort(), ["agent", "last_route_at", "oldest_waiting_at", "owner_user_id",
    "principal_id", "waiting", "workspace", "workspace_id"], "names, refs, times and counts only; never message text");
});

test("the query is read-only and runs under BEGIN READ ONLY", async () => {
  assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|COPY)\b/iu);
  await sql.begin("read only", async (tx) => { await tx.unsafe(query); });
});
