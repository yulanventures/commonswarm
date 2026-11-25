/**
 * Server witness for 20261124000002_waiting_autoclear.sql (CI / local Postgres):
 *   1. Catalog check, functional proof, rollback, rollback-catalog check, re-apply, and exact
 *      5-read-function parity (decision_queue, decision_queue_page, waiting_todos_page,
 *      waiting_archived_page, home_overview) before vs after when none of the new auto-clear
 *      rules apply.
 *   2. Direct helper denial: swarm.waiting_ask_autoclear_status is denied to anon, authenticated,
 *      swarm_read, and swarm_command.
 *   3. Every Slice 2 automatic clearing rule across decision_queue, decision_queue_page,
 *      waiting_todos_page, home_overview (with exact agreement on every case), waiting_archived_page,
 *      and dismiss/restore uniform 404:
 *      - Live agent control: ask from a live agent stays listed & counted, absent from Archived.
 *      - Rule 1: another addressee (or their workspace-admitted agent) answers -> clears in
 *        decision_queue*, home_overview, appears in Archived as 'answered'; asking agent's own
 *        follow-up does NOT clear the ask in home_overview or decision_queue.
 *      - Rule 2 (agent_removed): asking agent revoked, workspace seat revoked, or owner left ->
 *        clears from Waiting/counts/home_overview, appears in Archived as 'agent_removed' /
 *        'Agent removed' (answered_by = null), and dismiss/restore return uniform not_found.
 *      - Rule 3 (sender_left): asking person leaves workspace -> clears from Waiting/counts/
 *        home_overview, appears in Archived as 'sender_left' / 'Sender left'.
 *      - Rule 4 (channel_archived): open or readable private channel archived -> clears from
 *        Waiting/counts/home_overview, appears in Archived as 'channel_archived' /
 *        'Channel archived'; unreadable archived private channel is omitted from Archived.
 *      - Rule 5 (viewer loses access): private-channel removal and DM/group-DM leave -> clears
 *        from decision_queue*, home_overview, and is NOT listed in Archived (even if agent is
 *        also removed).
 *      - Explicit expiry (expired): ask with until <= now is absent from Waiting/home_overview
 *        and appears in Archived as 'expired' / 'Expired' with archived_at = until.
 *      - Work-request review withdrawn (withdrawn): offer withdrawn leaves waiting_todos_page
 *        and home_overview and appears in Archived as 'withdrawn' / 'Withdrawn'.
 *      - Dismissed-then-autocleared precedence: dismissed ask whose agent is removed leaves
 *        dismissed_asks, appears ONCE in Archived as 'agent_removed', and restore returns not_found.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { dbAssert, repoSql, runSql } from "../support/admin-schema-db.js";
import { sqlPhase } from "../support/admin-schema-process.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";
import * as todos from "../../src/protocol/household-todos.js";
import * as todoPolicy from "../../src/protocol/household-todo-policy.js";
import * as objectPolicy from "../../src/protocol/household-object-policy.js";
import * as objects from "../../src/protocol/household-objects.js";
import * as transfers from "../../supabase/functions/command/household-transfers.js";
import { createHouseholdObjectStore, type HouseholdIdentity } from "../../supabase/functions/command/household-objects.js";
import { createHouseholdTodoStore, type HouseholdTodoNoticePort } from "../../supabase/functions/command/household-todos.js";

type Local = { DB_URL: string };
type Row = Record<string, unknown>;

const proofRoot = "deploy/release-proofs/waiting-autoclear/20261124000002";
const catalogAssert = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}-${rollback ? "rollback-catalog" : "catalog"}.sql`),
      rollback ? "rollback_ok" : "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    rollback ? "waiting autoclear rollback catalog" : "waiting autoclear catalog",
  );

let sql: postgres.Sql;

function localDbUrl(): string {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.DB_URL, "local Supabase DB_URL required");
  return parsed.DB_URL;
}

const todoCore = { ...todos, ...todoPolicy, ...objectPolicy };
const noStorage = {
  putImmutable: async () => { throw new Error("Unexpected Storage I/O"); },
  read: async () => { throw new Error("Unexpected Storage I/O"); },
};
// Do not inject unrelated ask signals into swarm.signals when seeding household to-do offers:
// tests explicitly seed the asks whose decision_queue / home_overview counts they assert.
const noNotice: HouseholdTodoNoticePort = async (_tx, _workspace, _identity, intent) => ({
  to: intent.to,
  status: "not_sent",
  reason: "signal_rate_limited",
});

function makeTodoStore() {
  const access = createHouseholdObjectStore({
    core: { ...objects, ...objectPolicy },
    transfers,
    storage: noStorage,
    fileContentAllowed: () => false,
    recheckCredential: async () => true,
  }).access;
  return createHouseholdTodoStore({ core: todoCore, access, notice: noNotice });
}

function committedTodo(result: { outcome: todos.TodoOutcome }): todos.Todo {
  assert.equal(
    result.outcome.status,
    "committed",
    `expected committed todo outcome, got ${JSON.stringify(result.outcome)}`,
  );
  if (result.outcome.status !== "committed" || !("todo_id" in result.outcome.value)) {
    throw new Error(`Expected committed todo outcome, got ${JSON.stringify(result.outcome)}`);
  }
  return result.outcome.value;
}

type WaitingSnapshot = {
  dq: { total: number; truncated: boolean; asks: Array<{ signal_id: string } & Row> };
  dqp: { total: number; truncated: boolean; asks: Array<{ signal_id: string } & Row> };
  wt: { total: number; truncated: boolean; todos: Array<{ todo_id: string; reason: string } & Row> };
  wa: { total: number; truncated: boolean; items: Array<{ item_key: string; outcome_kind: string; outcome_text: string; archived_at: string; answered_by: Row | null } & Row> };
  wsOverview: {
    workspace_id: string;
    needs_you: {
      asks: Array<{ signal_id: string } & Row>;
      assigned: Array<{ todo_id: string } & Row>;
      waiting: Array<{ todo_id: string; reason: string } & Row>;
    };
  } | null;
};

async function readAllFiveAs(tx: postgres.TransactionSql, wsId: string, userId: string): Promise<WaitingSnapshot> {
  await tx`SAVEPOINT sp_read_five`;
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
  await tx`SET LOCAL ROLE authenticated`;
  const [dq] = await tx<{ r: WaitingSnapshot["dq"] }[]>`SELECT swarm_read.decision_queue(${wsId}::uuid) AS r`;
  const [dqp] = await tx<{ r: WaitingSnapshot["dqp"] }[]>`SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r`;
  const [wt] = await tx<{ r: WaitingSnapshot["wt"] }[]>`SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
  const [wa] = await tx<{ r: WaitingSnapshot["wa"] }[]>`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 100, NULL, NULL) AS r`;
  const [ho] = await tx<{ r: { workspaces: Array<NonNullable<WaitingSnapshot["wsOverview"]>> } }[]>`SELECT swarm_read.home_overview() AS r`;
  await tx`ROLLBACK TO SAVEPOINT sp_read_five`;
  return {
    dq: dq!.r,
    dqp: dqp!.r,
    wt: wt!.r,
    wa: wa!.r,
    wsOverview: ho!.r.workspaces.find((w) => w.workspace_id === wsId) ?? null,
  };
}

function askIdsInOrder(ids: Array<{ signal_id: string }>): string[] {
  return ids.map((a) => a.signal_id).sort();
}

before(async () => {
  sql = postgres(localDbUrl(), { prepare: false, max: 4 });
});

after(async () => {
  if (sql) await sql.end();
});

test("20261124000002 rolls back cleanly, re-applies with proofs, and all 5 read functions match 20261124000001 verbatim when no new rules apply", () => {
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const wsId = randomUUID();
  const scoutId = randomUUID();
  const privChId = randomUUID();
  const generalAskId = randomUUID();
  const dismissedAskId = randomUUID();
  const privAskId = randomUUID();
  const dmAskId = randomUUID();
  const answeredAskId = randomUUID();
  const assignedTodoId = randomUUID();
  const doneTodoId = randomUUID();
  const reviewTodoId = randomUUID();
  const reviewOfferId = randomUUID();

  const snapshotFive = (label: string, userId: string) => `
    DO $snap$
    DECLARE
      v_dq jsonb;
      v_dqp jsonb;
      v_wt jsonb;
      v_wa jsonb;
      v_ho jsonb;
    BEGIN
      PERFORM pg_catalog.set_config('request.jwt.claims', '${JSON.stringify({ role: "authenticated", sub: userId })}', true);
      SET LOCAL ROLE authenticated;
      v_dq := swarm_read.decision_queue('${wsId}'::uuid) - 'generated_at';
      v_dqp := swarm_read.decision_queue_page('${wsId}'::uuid, NULL, NULL) - 'generated_at';
      v_wt := swarm_read.waiting_todos_page('${wsId}'::uuid, 50, NULL, NULL) - 'generated_at';
      v_wa := swarm_read.waiting_archived_page('${wsId}'::uuid, 50, NULL, NULL) - 'generated_at';
      SELECT elem INTO v_ho
      FROM pg_catalog.jsonb_array_elements((swarm_read.home_overview())->'workspaces') AS elem
      WHERE elem->>'workspace_id' = '${wsId}';
      RESET ROLE;
      PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
      INSERT INTO pg_temp.read_snapshots(label, dq, dqp, wt, wa, ho)
      VALUES ('${label}', v_dq, v_dqp, v_wt, v_wa, v_ho);
    END $snap$;
  `;

  const fixtureSql = `
    -- Seed a fixture where NONE of the new auto-clear rules apply (all senders live,
    -- all channels unarchived, viewer active in every channel/DM, no expired asks, no withdrawn offers).
    INSERT INTO auth.users (id, email)
    VALUES
      ('${aliceId}'::uuid, 'ac-par-a-${aliceId}@example.test'),
      ('${bobId}'::uuid, 'ac-par-b-${bobId}@example.test');
    INSERT INTO swarm.users (user_id, display_name)
    VALUES ('${aliceId}'::uuid, 'ParityAlice'), ('${bobId}'::uuid, 'ParityBob');
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES ('${wsId}'::uuid, 'ParityWS', '${aliceId}'::uuid);
    INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES ('${wsId}'::uuid, '${aliceId}'::uuid, 'owner'), ('${wsId}'::uuid, '${bobId}'::uuid, 'member');
    INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
    VALUES ('${scoutId}'::uuid, '${wsId}'::uuid, '${aliceId}'::uuid, 'ParityScout');
    INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
    VALUES ('${wsId}'::uuid, '${scoutId}'::uuid, '${aliceId}'::uuid, '${aliceId}'::uuid)
    ON CONFLICT (principal_id, workspace_id) DO NOTHING;
    INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
    VALUES ('${wsId}'::uuid, 'shared');
    INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
    VALUES
      ('${wsId}'::uuid, '${aliceId}'::uuid, 'editor', '${randomUUID()}'::uuid, pg_catalog.statement_timestamp()),
      ('${wsId}'::uuid, '${bobId}'::uuid, 'editor', '${randomUUID()}'::uuid, pg_catalog.statement_timestamp());
    INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
    VALUES ('${privChId}'::uuid, '${wsId}'::uuid, 'parity-secret', 'private', '${aliceId}'::uuid, 'user');
    INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
    VALUES ('${privChId}'::uuid, '${wsId}'::uuid, 'user', '${aliceId}'::uuid, '${aliceId}'::uuid, 'user');
    SELECT swarm.conversation_for_channel('${wsId}'::uuid, '${privChId}'::uuid);
    SELECT swarm.conversation_open('${wsId}'::uuid, 'user', '${bobId}'::uuid, ARRAY['${aliceId}']::uuid[], ARRAY[]::uuid[], false);
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, sender_lifecycle_epoch)
    VALUES
      ('${generalAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity general ask?', NULL, '9999-12-31T23:59:59Z', 1),
      ('${dismissedAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity dismissed ask?', NULL, '9999-12-31T23:59:59Z', 1),
      ('${privAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity private ask?', '${privChId}'::uuid, '9999-12-31T23:59:59Z', 1),
      ('${dmAskId}'::uuid, '${wsId}'::uuid, '${bobId}'::uuid, 'user', '${aliceId}'::uuid, 'ask', 'Parity DM ask?', NULL, '9999-12-31T23:59:59Z', NULL),
      ('${answeredAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity answered ask?', NULL, '9999-12-31T23:59:59Z', 1);
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until)
    VALUES ('${randomUUID()}'::uuid, '${wsId}'::uuid, '${aliceId}'::uuid, 'user', '${answeredAskId}'::uuid, 'note', 'Answered!', '9999-12-31T23:59:59Z');
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO swarm.waiting_dismissals (workspace_id, user_id, item_kind, item_id, dismissed_at)
    VALUES ('${wsId}'::uuid, '${aliceId}'::uuid, 'ask', '${dismissedAskId}'::uuid, pg_catalog.statement_timestamp());
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq
    ) VALUES
      ('${wsId}'::uuid, '${assignedTodoId}'::uuid, 1, 'Parity assigned', '', 'open',
       '${aliceId}'::uuid, pg_catalog.statement_timestamp(), '${aliceId}'::uuid, '${aliceId}'::uuid, pg_catalog.statement_timestamp(),
       'none', '${aliceId}'::uuid, pg_catalog.statement_timestamp(), 0, 1),
      ('${wsId}'::uuid, '${doneTodoId}'::uuid, 1, 'Parity done', '', 'done',
       '${aliceId}'::uuid, pg_catalog.statement_timestamp(), '${aliceId}'::uuid, '${aliceId}'::uuid, pg_catalog.statement_timestamp(),
       'none', '${aliceId}'::uuid, pg_catalog.statement_timestamp(), 0, 2);
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, offer_id, offer_principal, offer_decider,
      offer_start, offer_gate, offer_by_user, offered_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq
    ) VALUES (
      '${wsId}'::uuid, '${reviewTodoId}'::uuid, 1, 'Parity review', '', 'open',
      '${bobId}'::uuid, pg_catalog.statement_timestamp(), '${reviewOfferId}'::uuid, '${scoutId}'::uuid, '${aliceId}'::uuid,
      'queue', '{"kind":"none"}'::jsonb, '${bobId}'::uuid, pg_catalog.statement_timestamp(),
      'none', '${bobId}'::uuid, pg_catalog.statement_timestamp(), 0, 3
    );

    CREATE TEMP TABLE pg_temp.read_snapshots (
      label text PRIMARY KEY,
      dq jsonb NOT NULL,
      dqp jsonb NOT NULL,
      wt jsonb NOT NULL,
      wa jsonb NOT NULL,
      ho jsonb NOT NULL
    );
  `;

  // Run the entire rollback, rollback-catalog, re-apply, catalog/functional proof, and
  // 5-read-function parity check inside ONE runSql transaction so state carries across
  // rollback -> re-apply and the "before" snapshot runs against the 20261124000001 bodies.
  runSql(
    sqlPhase("autoclear-initial-proofs", catalogAssert(false) + "\n" + repoSql(`${proofRoot}-functional.sql`)) +
      sqlPhase("autoclear-parity-fixture", fixtureSql) +
      sqlPhase(
        "autoclear-snapshot-after",
        snapshotFive("after_alice", aliceId) +
          snapshotFive("after_bob", bobId) +
          dbAssert(
            `SELECT (dq->>'total')::int = 3 AND (dqp->>'total')::int = 3 AND (wt->>'total')::int = 2 AND (wa->>'total')::int = 3
             FROM pg_temp.read_snapshots WHERE label = 'after_alice'`,
            "parity fixture baseline counts for Alice",
          ) +
          dbAssert(
            `SELECT (dq->>'total')::int = 0 AND (dqp->>'total')::int = 0 AND (wt->>'total')::int = 0 AND (wa->>'total')::int = 0
             FROM pg_temp.read_snapshots WHERE label = 'after_bob'`,
            "parity fixture baseline counts for Bob",
          ),
      ) +
      sqlPhase("autoclear-rollback", repoSql(`${proofRoot}-rollback.sql`) + "\n" + catalogAssert(true)) +
      sqlPhase(
        "autoclear-snapshot-before-and-compare",
        snapshotFive("before_alice", aliceId) +
          snapshotFive("before_bob", bobId) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'after_alice' AND b.label = 'before_alice'`,
            "all 5 read functions must match 20261124000001 verbatim for Alice when no new rules apply",
          ) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'after_bob' AND b.label = 'before_bob'`,
            "all 5 read functions must match 20261124000001 verbatim for Bob when no new rules apply",
          ),
      ) +
      sqlPhase(
        "autoclear-reapply",
        repoSql("supabase/migrations/20261124000002_waiting_autoclear.sql") +
          "\n" +
          catalogAssert(false) +
          "\n" +
          repoSql(`${proofRoot}-functional.sql`),
      ) +
      sqlPhase(
        "autoclear-snapshot-reapplied-and-compare",
        snapshotFive("reapplied_alice", aliceId) +
          snapshotFive("reapplied_bob", bobId) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'reapplied_alice' AND b.label = 'before_alice'`,
            "re-applied 20261124000002 matches 20261124000001 verbatim for Alice when no new rules apply",
          ) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'reapplied_bob' AND b.label = 'before_bob'`,
            "re-applied 20261124000002 matches 20261124000001 verbatim for Bob when no new rules apply",
          ),
      ),
  );
});

const ROLLBACK_WITNESS = Symbol("rollback-waiting-autoclear-witness");

test("every Slice 2 rule clears Waiting and counts, agrees across decision_queue/home_overview, populates Archived with exact outcomes, and enforces visibility + uniform 404", async () => {
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const carolId = randomUUID();
  const wsId = randomUUID();
  const liveAgentId = randomUUID();
  const revokedAgentId = randomUUID();
  const leftDmRevokedAgentId = randomUUID();
  const seatRemovedAgentId = randomUUID();
  const ownerLeftAgentId = randomUUID();
  const bobAgentId = randomUUID();
  const openChId = randomUUID();
  const privChReadableId = randomUUID();
  const privChUnreadableId = randomUUID();
  const privChLostId = randomUUID();

  const liveAskId = randomUUID();
  const selfFollowupAskId = randomUUID();
  const answeredByBobAskId = randomUUID();
  const answeredByBobAgentAskId = randomUUID();
  const revokedAgentAskId = randomUUID();
  const dismissedThenRevokedAskId = randomUUID();
  const seatRemovedAskId = randomUUID();
  const ownerLeftAskId = randomUUID();
  const senderLeftAskId = randomUUID();
  const archivedOpenChAskId = randomUUID();
  const archivedPrivReadableAskId = randomUUID();
  const archivedPrivUnreadableAskId = randomUUID();
  const lostPrivChAskId = randomUUID();
  const leftDmAskId = randomUUID();
  const leftDmRevokedAskId = randomUUID();
  const expiredAskId = randomUUID();

  const store = makeTodoStore();
  const bobIdentity: HouseholdIdentity = { user_id: bobId, principal_id: null, run_id: null, connection: null };

  try {
    await sql.begin(async (tx) => {
      // Direct helper denial: client/command/read roles must NOT execute swarm.waiting_ask_autoclear_status.
      for (const role of ["anon", "authenticated", "swarm_read", "swarm_command"]) {
        await tx`SAVEPOINT sp_helper_deny`;
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await assert.rejects(
          () => tx`SELECT * FROM swarm.waiting_ask_autoclear_status(${wsId}::uuid, ${liveAskId}::uuid, statement_timestamp())`,
          /permission denied/,
          `${role} must not execute swarm.waiting_ask_autoclear_status`,
        );
        await tx`ROLLBACK TO SAVEPOINT sp_helper_deny`;
      }

      const tBase = Date.parse("2026-11-23T12:00:00.000Z");
      const ts = (offsetSec: number) => new Date(tBase + offsetSec * 1000).toISOString();

      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${aliceId}::uuid, ${`ac-a-${aliceId}@example.test`}),
          (${bobId}::uuid, ${`ac-b-${bobId}@example.test`}),
          (${carolId}::uuid, ${`ac-c-${carolId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${aliceId}::uuid, 'Alice'),
          (${bobId}::uuid, 'Bob'),
          (${carolId}::uuid, 'Carol')
      `;
      await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${wsId}::uuid, 'AutoClearWS', ${aliceId}::uuid)`;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${aliceId}::uuid, 'owner'),
          (${wsId}::uuid, ${bobId}::uuid, 'member'),
          (${wsId}::uuid, ${carolId}::uuid, 'member')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES
          (${liveAgentId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 'LiveScout'),
          (${revokedAgentId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 'RevokedBot'),
          (${leftDmRevokedAgentId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 'LeftDmRevokedBot'),
          (${seatRemovedAgentId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 'SeatRemovedBot'),
          (${ownerLeftAgentId}::uuid, ${wsId}::uuid, ${carolId}::uuid, 'CarolBot'),
          (${bobAgentId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'BobBot')
      `;
      await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose) VALUES (${wsId}::uuid, 'shared')`;
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${aliceId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${bobId}::uuid, 'editor', ${randomUUID()}::uuid, now())
      `;
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES
          (${openChId}::uuid, ${wsId}::uuid, 'open-room', 'open', ${aliceId}::uuid, 'user'),
          (${privChReadableId}::uuid, ${wsId}::uuid, 'priv-read', 'private', ${aliceId}::uuid, 'user'),
          (${privChUnreadableId}::uuid, ${wsId}::uuid, 'priv-hidden', 'private', ${bobId}::uuid, 'user'),
          (${privChLostId}::uuid, ${wsId}::uuid, 'priv-lost', 'private', ${bobId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES
          (${privChReadableId}::uuid, ${wsId}::uuid, 'user', ${aliceId}::uuid, ${aliceId}::uuid, 'user'),
          (${privChUnreadableId}::uuid, ${wsId}::uuid, 'user', ${bobId}::uuid, ${bobId}::uuid, 'user'),
          (${privChLostId}::uuid, ${wsId}::uuid, 'user', ${bobId}::uuid, ${bobId}::uuid, 'user'),
          (${privChLostId}::uuid, ${wsId}::uuid, 'user', ${aliceId}::uuid, ${bobId}::uuid, 'user')
      `;
      // DM conversations: Alice<->Bob (live sender) and Alice<->LeftDmRevokedBot (separate agent from RevokedBot so leaving this DM does not also leave the Alice<->RevokedBot DM holding revokedAgentAskId & dismissedThenRevokedAskId)
      const [dmOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(${wsId}::uuid, 'user', ${bobId}::uuid, ARRAY[${aliceId}]::uuid[], ARRAY[]::uuid[], false) AS r
      `;
      const actualDmConvId = dmOpen!.r.conversation.conversation_id;
      const [dmRevokedOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(${wsId}::uuid, 'user', ${aliceId}::uuid, ARRAY[]::uuid[], ARRAY[${leftDmRevokedAgentId}]::uuid[], false) AS r
      `;
      const actualDmRevokedConvId = dmRevokedOpen!.r.conversation.conversation_id;

      // Seed asks — initially ALL live (except expiredAskId which has explicit past until, and privChUnreadableAskId where Alice isn't in channel).
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, created_at, until, sender_lifecycle_epoch)
        VALUES
          (${liveAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Live agent still here?', NULL, ${ts(-600)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${selfFollowupAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Self follow-up ask?', NULL, ${ts(-590)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${answeredByBobAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Answered by Bob?', NULL, ${ts(-580)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${answeredByBobAgentAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Answered by BobBot?', NULL, ${ts(-570)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${revokedAgentAskId}::uuid, ${wsId}::uuid, ${revokedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'From revoked agent?', NULL, ${ts(-560)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${dismissedThenRevokedAskId}::uuid, ${wsId}::uuid, ${revokedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Dismissed then revoked?', NULL, ${ts(-550)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${seatRemovedAskId}::uuid, ${wsId}::uuid, ${seatRemovedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'From seat-removed agent?', NULL, ${ts(-540)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${ownerLeftAskId}::uuid, ${wsId}::uuid, ${ownerLeftAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'From CarolBot whose owner leaves?', NULL, ${ts(-530)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${senderLeftAskId}::uuid, ${wsId}::uuid, ${carolId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'From Carol who leaves?', NULL, ${ts(-520)}::timestamptz, '9999-12-31T23:59:59Z', NULL),
          (${archivedOpenChAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'In archived open channel?', ${openChId}::uuid, ${ts(-510)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${archivedPrivReadableAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'In archived readable private channel?', ${privChReadableId}::uuid, ${ts(-500)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${archivedPrivUnreadableAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'SECRET archived private ask?', ${privChUnreadableId}::uuid, ${ts(-490)}::timestamptz, '9999-12-31T23:59:59Z', NULL),
          (${lostPrivChAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'SECRET lost private ask?', ${privChLostId}::uuid, ${ts(-480)}::timestamptz, '9999-12-31T23:59:59Z', NULL),
          (${leftDmAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'SECRET left DM ask?', NULL, ${ts(-470)}::timestamptz, '9999-12-31T23:59:59Z', NULL),
          (${leftDmRevokedAskId}::uuid, ${wsId}::uuid, ${leftDmRevokedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'SECRET left DM revoked agent ask?', NULL, ${ts(-465)}::timestamptz, '9999-12-31T23:59:59Z', 1),
          (${expiredAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Explicit short horizon ask?', NULL, ${ts(-460)}::timestamptz, ${ts(-400)}::timestamptz, 1)
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${answeredByBobAskId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 0),
          (${answeredByBobAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 1),
          (${answeredByBobAgentAskId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 0),
          (${answeredByBobAgentAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 1)
      `;
      await tx`SELECT swarm.conversation_prefile(${wsId}::uuid, ${leftDmAskId}::uuid, ${actualDmConvId}::uuid)`;
      await tx`SELECT swarm.conversation_prefile(${wsId}::uuid, ${leftDmRevokedAskId}::uuid, ${actualDmRevokedConvId}::uuid)`;

      // LiveScout posts its own follow-up to selfFollowupAskId -> must NOT clear selfFollowupAskId!
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, in_reply_to, kind, body, created_at, until)
        VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, ${selfFollowupAskId}::uuid, 'note', 'Extra detail from asking agent', ${ts(-390)}::timestamptz, '9999-12-31T23:59:59Z')
      `;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      // Work-request review offered by Bob to Alice's LiveScout (decider = Alice)
      await tx`SET LOCAL ROLE swarm_command`;
      const reviewTodo = committedTodo(await store.write(tx, wsId, bobIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Withdrawable review task",
        assign: { to: { kind: "agent", id: liveAgentId } },
      }));
      assert.ok(
        reviewTodo.offer?.offer_id,
        `expected pending offer on reviewTodo, got ${JSON.stringify(reviewTodo)}`,
      );
      const reviewOfferId = reviewTodo.offer.offer_id;

      // Alice dismisses dismissedThenRevokedAskId while it is still live!
      const [dismissBefore] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${dismissedThenRevokedAskId}::uuid) AS r
      `;
      assert.equal(
        dismissBefore!.r.status,
        "ok",
        `dismiss_waiting_item before revocation failed: result=${JSON.stringify(dismissBefore!.r)}`,
      );
      await tx`RESET ROLE`;

      // Baseline BEFORE transitions: verify all live asks are listed and counted, and decision_queue == decision_queue_page == home_overview!
      const beforeSnap = await readAllFiveAs(tx, wsId, aliceId);
      const expectedBeforeAskIds: string[] = [
        liveAskId,
        selfFollowupAskId,
        answeredByBobAskId,
        answeredByBobAgentAskId,
        revokedAgentAskId,
        seatRemovedAskId,
        ownerLeftAskId,
        senderLeftAskId,
        archivedOpenChAskId,
        archivedPrivReadableAskId,
        lostPrivChAskId,
        leftDmAskId,
        leftDmRevokedAskId,
      ].sort();
      assert.equal(
        beforeSnap.dq.total,
        expectedBeforeAskIds.length,
        `beforeSnap.dq.total mismatch: dq=${JSON.stringify(beforeSnap.dq)}`,
      );
      assert.deepEqual(
        askIdsInOrder(beforeSnap.dq.asks),
        expectedBeforeAskIds,
        `beforeSnap.dq.asks mismatch: dq=${JSON.stringify(beforeSnap.dq)}`,
      );
      assert.deepEqual(
        askIdsInOrder(beforeSnap.dqp.asks),
        expectedBeforeAskIds,
        `beforeSnap.dqp.asks mismatch: dqp=${JSON.stringify(beforeSnap.dqp)}`,
      );
      // home_overview caps at 10 newest asks, all of which must come from the exact same eligible set (including selfFollowupAskId, excluding dismissedThenRevokedAskId & expiredAskId & archivedPrivUnreadableAskId).
      assert.equal(
        beforeSnap.wsOverview!.needs_you.asks.length,
        10,
        `beforeSnap.wsOverview.needs_you.asks cap mismatch: wsOverview=${JSON.stringify(beforeSnap.wsOverview)}`,
      );
      for (const a of beforeSnap.wsOverview!.needs_you.asks) {
        assert.ok(
          expectedBeforeAskIds.includes(a.signal_id),
          `home_overview ask ${a.signal_id} must be in eligible set; ask=${JSON.stringify(a)}`,
        );
      }
      assert.equal(
        beforeSnap.wt.total,
        1,
        `beforeSnap.wt.total mismatch: wt=${JSON.stringify(beforeSnap.wt)}`,
      );
      assert.equal(
        beforeSnap.wt.todos[0]!.reason,
        "request",
        `beforeSnap.wt.todos[0].reason mismatch: todo=${JSON.stringify(beforeSnap.wt.todos[0])}`,
      );
      assert.equal(
        beforeSnap.wsOverview!.needs_you.waiting.length,
        1,
        `beforeSnap.wsOverview.needs_you.waiting mismatch: wsOverview=${JSON.stringify(beforeSnap.wsOverview)}`,
      );

      // Verify expiredAskId is ALREADY in Archived as 'expired' / 'Expired' with archived_at = until.
      const beforeExpired = beforeSnap.wa.items.find((i) => i.item_key === `ask:${expiredAskId}`);
      assert.ok(
        beforeExpired,
        `expired ask ${expiredAskId} must appear in Archived; wa=${JSON.stringify(beforeSnap.wa)}`,
      );
      assert.equal(beforeExpired.outcome_kind, "expired", `beforeExpired=${JSON.stringify(beforeExpired)}`);
      assert.equal(beforeExpired.outcome_text, "Expired", `beforeExpired=${JSON.stringify(beforeExpired)}`);
      assert.equal(beforeExpired.answered_by, null, `beforeExpired=${JSON.stringify(beforeExpired)}`);
      assert.equal(
        Date.parse(beforeExpired.archived_at),
        Date.parse(ts(-400)),
        `beforeExpired=${JSON.stringify(beforeExpired)} expectedAt=${ts(-400)}`,
      );

      // NOW trigger every Slice 2 rule!
      // Rule 1: Bob and BobBot answer their respective multi-addressee asks.
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, created_at, until)
        VALUES
          (${randomUUID()}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${answeredByBobAskId}::uuid, 'note', 'Bob handled it', ${ts(-300)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${bobAgentId}::uuid, 'agent', ${answeredByBobAgentAskId}::uuid, 'note', 'BobBot handled it', ${ts(-290)}::timestamptz, '9999-12-31T23:59:59Z')
      `;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      // Rule 2: revoke revokedAgentId & leftDmRevokedAgentId globally, revoke seatRemovedAgentId workspace seat, and revoke Carol (owner of ownerLeftAgentId & sender of senderLeftAskId -> also triggers Rule 3!).
      await tx`UPDATE swarm.agent_principals SET revoked_at = ${ts(-280)}::timestamptz WHERE principal_id IN (${revokedAgentId}::uuid, ${leftDmRevokedAgentId}::uuid)`;
      await tx`UPDATE swarm.agent_workspace_memberships SET revoked_at = ${ts(-270)}::timestamptz WHERE workspace_id = ${wsId}::uuid AND principal_id = ${seatRemovedAgentId}::uuid`;
      await tx`UPDATE swarm.memberships SET revoked_at = ${ts(-260)}::timestamptz WHERE workspace_id = ${wsId}::uuid AND user_id = ${carolId}::uuid`;

      // Rule 4: archive openChId, privChReadableId, and privChUnreadableId (and sync conversations).
      await tx`
        UPDATE swarm.channels
        SET archived_at = ${ts(-250)}::timestamptz
        WHERE workspace_id = ${wsId}::uuid AND channel_id IN (${openChId}::uuid, ${privChReadableId}::uuid, ${privChUnreadableId}::uuid)
      `;
      await tx`SELECT swarm.conversation_for_channel(${wsId}::uuid, ${openChId}::uuid)`;
      await tx`SELECT swarm.conversation_for_channel(${wsId}::uuid, ${privChReadableId}::uuid)`;
      await tx`SELECT swarm.conversation_for_channel(${wsId}::uuid, ${privChUnreadableId}::uuid)`;

      // Rule 5: remove Alice from privChLostId and make Alice leave the DM conversation.
      await tx`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChLostId}::uuid AND member_kind = 'user' AND user_id = ${aliceId}::uuid
      `;
      await tx`
        UPDATE swarm.conversation_members
        SET joined_at = ${ts(-600)}::timestamptz, left_at = ${ts(-240)}::timestamptz
        WHERE workspace_id = ${wsId}::uuid
          AND conversation_id IN (${actualDmConvId}::uuid, ${actualDmRevokedConvId}::uuid)
          AND member_user_id = ${aliceId}::uuid
      `;

      // Review offer withdrawn by Bob!
      await tx`SET LOCAL ROLE swarm_command`;
      committedTodo(await store.write(tx, wsId, bobIdentity, `req-${randomUUID()}`, {
        kind: "household_todo_answer",
        todo_id: reviewTodo.todo_id,
        offer_id: reviewOfferId,
        answer: "withdraw",
      }));
      await tx`RESET ROLE`;

      // Read all 5 functions AFTER all transitions!
      const afterSnap = await readAllFiveAs(tx, wsId, aliceId);

      // ONLY liveAskId and selfFollowupAskId remain in Waiting on you, and ALL THREE ask reads agree 100%!
      const expectedRemaining: string[] = [liveAskId, selfFollowupAskId].sort();
      assert.equal(
        afterSnap.dq.total,
        2,
        `only live ask and self-followup ask remain in decision_queue; dq=${JSON.stringify(afterSnap.dq)}`,
      );
      assert.equal(
        afterSnap.dqp.total,
        2,
        `decision_queue_page total matches decision_queue; dqp=${JSON.stringify(afterSnap.dqp)}`,
      );
      assert.deepEqual(
        askIdsInOrder(afterSnap.dq.asks),
        expectedRemaining,
        `afterSnap.dq.asks mismatch; dq=${JSON.stringify(afterSnap.dq)}`,
      );
      assert.deepEqual(
        askIdsInOrder(afterSnap.dqp.asks),
        expectedRemaining,
        `afterSnap.dqp.asks mismatch; dqp=${JSON.stringify(afterSnap.dqp)}`,
      );
      assert.deepEqual(
        askIdsInOrder(afterSnap.wsOverview!.needs_you.asks),
        expectedRemaining,
        `home_overview agrees exactly with decision_queue; wsOverview=${JSON.stringify(afterSnap.wsOverview)}`,
      );

      // Withdrawn review left waiting_todos_page AND home_overview!
      assert.equal(
        afterSnap.wt.total,
        0,
        `withdrawn review must leave waiting_todos_page; wt=${JSON.stringify(afterSnap.wt)}`,
      );
      assert.equal(
        afterSnap.wsOverview!.needs_you.waiting.length,
        0,
        `withdrawn review must leave home_overview; wsOverview=${JSON.stringify(afterSnap.wsOverview)}`,
      );

      // Verify Archived outcomes!
      const archByKey = new Map(afterSnap.wa.items.map((i) => [i.item_key, i]));

      // Live asks stay OUT of Archived.
      assert.equal(
        archByKey.has(`ask:${liveAskId}`),
        false,
        `liveAskId must not appear in Archived; row=${JSON.stringify(archByKey.get(`ask:${liveAskId}`))}`,
      );
      assert.equal(
        archByKey.has(`ask:${selfFollowupAskId}`),
        false,
        `selfFollowupAskId must not appear in Archived; row=${JSON.stringify(archByKey.get(`ask:${selfFollowupAskId}`))}`,
      );

      // Rule 1: answered by another addressee / their agent.
      const bobAns = archByKey.get(`ask:${answeredByBobAskId}`);
      assert.ok(bobAns, `answeredByBobAskId missing from Archived; wa=${JSON.stringify(afterSnap.wa)}`);
      assert.equal(bobAns.outcome_kind, "answered", `bobAns=${JSON.stringify(bobAns)}`);
      assert.equal(bobAns.outcome_text, "Bob handled it", `bobAns=${JSON.stringify(bobAns)}`);
      assert.equal(bobAns.answered_by?.by_viewer, false, `bobAns=${JSON.stringify(bobAns)}`);

      const bobAgentAns = archByKey.get(`ask:${answeredByBobAgentAskId}`);
      assert.ok(bobAgentAns, `answeredByBobAgentAskId missing from Archived; wa=${JSON.stringify(afterSnap.wa)}`);
      assert.equal(bobAgentAns.outcome_kind, "answered", `bobAgentAns=${JSON.stringify(bobAgentAns)}`);
      assert.equal(bobAgentAns.outcome_text, "BobBot handled it", `bobAgentAns=${JSON.stringify(bobAgentAns)}`);

      // Rule 2: agent_removed (revoked principal, revoked workspace seat, owner left, and dismissed-then-revoked).
      for (const id of [revokedAgentAskId, seatRemovedAskId, ownerLeftAskId, dismissedThenRevokedAskId]) {
        const matches = afterSnap.wa.items.filter((i) => i.item_key === `ask:${id}`);
        assert.equal(
          matches.length,
          1,
          `ask:${id} must appear exactly once in Archived; matches=${JSON.stringify(matches)} wa=${JSON.stringify(afterSnap.wa)}`,
        );
        assert.equal(matches[0]!.outcome_kind, "agent_removed", `row=${JSON.stringify(matches[0])}`);
        assert.equal(matches[0]!.outcome_text, "Agent removed", `row=${JSON.stringify(matches[0])}`);
        assert.equal(matches[0]!.answered_by, null, `row=${JSON.stringify(matches[0])}`);
      }

      // Rule 3: sender_left.
      const senderLeft = archByKey.get(`ask:${senderLeftAskId}`);
      assert.ok(senderLeft, `senderLeftAskId missing from Archived; wa=${JSON.stringify(afterSnap.wa)}`);
      assert.equal(senderLeft.outcome_kind, "sender_left", `senderLeft=${JSON.stringify(senderLeft)}`);
      assert.equal(senderLeft.outcome_text, "Sender left", `senderLeft=${JSON.stringify(senderLeft)}`);
      assert.equal(senderLeft.answered_by, null, `senderLeft=${JSON.stringify(senderLeft)}`);

      // Rule 4: channel_archived (readable open + readable private appear; unreadable private MUST NOT appear).
      for (const id of [archivedOpenChAskId, archivedPrivReadableAskId]) {
        const row = archByKey.get(`ask:${id}`);
        assert.ok(row, `ask:${id} should appear as channel_archived; wa=${JSON.stringify(afterSnap.wa)}`);
        assert.equal(row.outcome_kind, "channel_archived", `row=${JSON.stringify(row)}`);
        assert.equal(row.outcome_text, "Channel archived", `row=${JSON.stringify(row)}`);
        assert.equal(row.answered_by, null, `row=${JSON.stringify(row)}`);
      }
      assert.equal(
        archByKey.has(`ask:${archivedPrivUnreadableAskId}`),
        false,
        `unreadable archived private ask must not be listed; row=${JSON.stringify(archByKey.get(`ask:${archivedPrivUnreadableAskId}`))}`,
      );

      // Rule 5: viewer lost access -> NOT listed in Archived (zero leakage, even when asking agent is also revoked).
      assert.equal(
        archByKey.has(`ask:${lostPrivChAskId}`),
        false,
        `removed private-channel ask must not appear in Archived; row=${JSON.stringify(archByKey.get(`ask:${lostPrivChAskId}`))}`,
      );
      assert.equal(
        archByKey.has(`ask:${leftDmAskId}`),
        false,
        `left DM ask must not appear in Archived; row=${JSON.stringify(archByKey.get(`ask:${leftDmAskId}`))}`,
      );
      assert.equal(
        archByKey.has(`ask:${leftDmRevokedAskId}`),
        false,
        `left DM ask from revoked agent must not appear in Archived; row=${JSON.stringify(archByKey.get(`ask:${leftDmRevokedAskId}`))}`,
      );
      const afterJson = JSON.stringify(afterSnap.wa);
      assert.equal(afterJson.includes("SECRET archived private ask?"), false, `leaked archived private ask in wa=${afterJson}`);
      assert.equal(afterJson.includes("SECRET lost private ask?"), false, `leaked lost private ask in wa=${afterJson}`);
      assert.equal(afterJson.includes("SECRET left DM ask?"), false, `leaked left DM ask in wa=${afterJson}`);
      assert.equal(afterJson.includes("SECRET left DM revoked agent ask?"), false, `leaked left DM revoked ask in wa=${afterJson}`);

      // Explicit expiry: expired.
      const expired = archByKey.get(`ask:${expiredAskId}`);
      assert.ok(expired, `expiredAskId missing from Archived; wa=${JSON.stringify(afterSnap.wa)}`);
      assert.equal(expired.outcome_kind, "expired", `expired=${JSON.stringify(expired)}`);
      assert.equal(expired.outcome_text, "Expired", `expired=${JSON.stringify(expired)}`);
      assert.equal(expired.answered_by, null, `expired=${JSON.stringify(expired)}`);

      // Withdrawn review offer: withdrawn.
      const withdrawn = archByKey.get(`review:${reviewOfferId}`);
      assert.ok(withdrawn, `withdrawn review offer ${reviewOfferId} must appear in Archived; wa=${JSON.stringify(afterSnap.wa)}`);
      assert.equal(withdrawn.outcome_kind, "withdrawn", `withdrawn=${JSON.stringify(withdrawn)}`);
      assert.equal(withdrawn.outcome_text, "Withdrawn", `withdrawn=${JSON.stringify(withdrawn)}`);

      // Uniform 404 on dismiss/restore for auto-cleared asks (indistinguishable from unknown UUID).
      await tx`SET LOCAL ROLE swarm_command`;
      const [unknownDismiss] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${randomUUID()}::uuid) AS r
      `;
      assert.deepEqual(
        unknownDismiss!.r,
        { status: "not_found" },
        `unknownDismiss=${JSON.stringify(unknownDismiss!.r)}`,
      );
      for (const clearedId of [revokedAgentAskId, senderLeftAskId, archivedOpenChAskId, expiredAskId, leftDmAskId]) {
        const [d] = await tx<{ r: Row }[]>`
          SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${clearedId}::uuid) AS r
        `;
        assert.deepEqual(
          d!.r,
          unknownDismiss!.r,
          `dismiss on cleared ask ${clearedId} must return uniform not_found; got=${JSON.stringify(d!.r)} expected=${JSON.stringify(unknownDismiss!.r)}`,
        );
      }
      const [restoreCleared] = await tx<{ r: Row }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${dismissedThenRevokedAskId}::uuid) AS r
      `;
      assert.deepEqual(
        restoreCleared!.r,
        { status: "not_found" },
        `restore on dismissed-then-revoked ask must return uniform not_found; got=${JSON.stringify(restoreCleared!.r)}`,
      );
      await tx`RESET ROLE`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

test("private directed reply or private completed choice never alters another addressee's Archived page, total, or cursor once auto-cleared", async () => {
  const tBase = Date.parse("2026-11-23T12:00:00.000Z");
  const ts = (offsetSec: number) => new Date(tBase + offsetSec * 1000).toISOString();

  type ArchivedPage = WaitingSnapshot["wa"];

  async function readArchivedPage(
    tx: postgres.TransactionSql,
    wsId: string,
    userId: string,
    limit: number,
    afterAt: string | null = null,
    afterKey: string | null = null,
  ): Promise<ArchivedPage> {
    await tx`SAVEPOINT sp_read_wa_c1`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    const [wa] = await tx<{ r: ArchivedPage }[]>`
      SELECT swarm_read.waiting_archived_page(
        ${wsId}::uuid,
        ${limit},
        ${afterAt}::timestamptz,
        ${afterKey}::text
      ) AS r
    `;
    await tx`ROLLBACK TO SAVEPOINT sp_read_wa_c1`;
    return wa!.r;
  }

  function normalizeRow(item: ArchivedPage["items"][number]) {
    const from = item.from as { kind: string; name: string | null } | null;
    const answeredBy = item.answered_by as { kind: string; name: string | null; by_viewer: boolean } | null;
    return {
      kind: item.kind,
      ask_kind: item.ask_kind,
      title: item.title,
      from: from ? { kind: from.kind, name: from.name } : null,
      outcome_kind: item.outcome_kind,
      outcome_text: item.outcome_text,
      archived_at: Date.parse(item.archived_at),
      answered_by: answeredBy ? { kind: answeredBy.kind, name: answeredBy.name, by_viewer: answeredBy.by_viewer } : null,
      placement: item.placement,
      conversation_kind: item.conversation_kind,
    };
  }

  async function seedMirrorWorkspace(tx: postgres.TransactionSql, includePrivateAnswers: boolean) {
    const wsId = randomUUID();
    const addresseeAId = randomUUID();
    const addresseeBId = randomUUID();
    const departingAskerId = randomUUID();
    const liveAgentId = randomUUID();
    const openChId = randomUUID();
    const archivedChId = randomUUID();

    const expDirectedAskId = randomUUID();
    const senderLeftDirectedAskId = randomUUID();
    const expHiddenChoiceAskId = randomUUID();
    const archivedChHiddenChoiceAskId = randomUUID();
    const visibleAnswerExpiredAskId = randomUUID();

    await tx`
      INSERT INTO auth.users (id, email)
      VALUES
        (${addresseeAId}::uuid, ${`c1-a-${addresseeAId}@example.test`}),
        (${addresseeBId}::uuid, ${`c1-b-${addresseeBId}@example.test`}),
        (${departingAskerId}::uuid, ${`c1-d-${departingAskerId}@example.test`})
    `;
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${addresseeAId}::uuid, 'AddresseeA'),
        (${addresseeBId}::uuid, 'AddresseeB'),
        (${departingAskerId}::uuid, 'DepartingAsker')
    `;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${wsId}::uuid, 'C1MirrorWS', ${addresseeAId}::uuid)`;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${wsId}::uuid, ${addresseeAId}::uuid, 'owner'),
        (${wsId}::uuid, ${addresseeBId}::uuid, 'member'),
        (${wsId}::uuid, ${departingAskerId}::uuid, 'member')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${liveAgentId}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 'C1Agent')
    `;
    await tx`
      INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
      VALUES
        (${openChId}::uuid, ${wsId}::uuid, 'c1-open', 'open', ${addresseeAId}::uuid, 'user'),
        (${archivedChId}::uuid, ${wsId}::uuid, 'c1-archived', 'open', ${addresseeAId}::uuid, 'user')
    `;

    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`SET LOCAL ROLE swarm_command`;
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, created_at, until, sender_lifecycle_epoch)
      VALUES
        (${expDirectedAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${addresseeAId}::uuid, 'ask', 'Expired ask with directed reply?', ${openChId}::uuid, ${ts(-600)}::timestamptz, ${ts(-300)}::timestamptz, 1),
        (${senderLeftDirectedAskId}::uuid, ${wsId}::uuid, ${departingAskerId}::uuid, 'user', ${addresseeAId}::uuid, 'ask', 'Sender-left ask with directed DM reply?', ${openChId}::uuid, ${ts(-600)}::timestamptz, '9999-12-31T23:59:59Z', NULL),
        (${expHiddenChoiceAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${addresseeAId}::uuid, 'ask', 'Expired choice ask with directed reply?', ${openChId}::uuid, ${ts(-600)}::timestamptz, ${ts(-250)}::timestamptz, 1),
        (${archivedChHiddenChoiceAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${addresseeAId}::uuid, 'ask', 'Archived-channel choice ask with DM reply?', ${archivedChId}::uuid, ${ts(-600)}::timestamptz, '9999-12-31T23:59:59Z', 1),
        (${visibleAnswerExpiredAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${addresseeAId}::uuid, 'ask', 'Expired ask with visible unaddressed reply?', ${openChId}::uuid, ${ts(-600)}::timestamptz, ${ts(-150)}::timestamptz, 1)
    `;
    for (const askId of [
      expDirectedAskId,
      senderLeftDirectedAskId,
      expHiddenChoiceAskId,
      archivedChHiddenChoiceAskId,
      visibleAnswerExpiredAskId,
    ]) {
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${askId}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 0),
          (${askId}::uuid, ${wsId}::uuid, ${addresseeBId}::uuid, 1)
      `;
    }
    for (const choiceAskId of [expHiddenChoiceAskId, archivedChHiddenChoiceAskId]) {
      await tx`
        INSERT INTO swarm.ask_choices (signal_id, workspace_id, multi, options)
        VALUES (
          ${choiceAskId}::uuid,
          ${wsId}::uuid,
          false,
          ${tx.json([
            { id: "opt_secret", label: "SECRET_CHOICE_LABEL" },
            { id: "opt_alt", label: "Alternate option" },
          ])}::jsonb
        )
      `;
    }

    // Visible-answer control: unaddressed reply in openChId (audience = 'conversation', readable by both A and B).
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, channel_id, created_at, until)
      VALUES (
        ${randomUUID()}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 'user', ${visibleAnswerExpiredAskId}::uuid,
        'note', 'Public answer both can read', ${openChId}::uuid, ${ts(-180)}::timestamptz, '9999-12-31T23:59:59Z'
      )
    `;

    if (includePrivateAnswers) {
      const expDirectedReplyId = randomUUID();
      const senderLeftDmReplyId = randomUUID();
      const expHiddenChoiceReplyId = randomUUID();
      const archivedChChoiceReplyId = randomUUID();

      // 1. Directed reply in openChId (to_agent_principal_id = liveAgentId -> audience = 'addressed', hidden from B).
      // 2. Directed DM reply to departingAskerId (channel_id = NULL -> 1:1 DM {A, departingAsker}, hidden from B).
      // 3. Completed choice with directed reply in openChId (audience = 'addressed', hidden from B).
      // 4. Completed choice with directed DM reply (channel_id = NULL -> 1:1 DM {A, liveAgent}, hidden from B).
      await tx`
        INSERT INTO swarm.signals (
          id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id,
          in_reply_to, kind, body, channel_id, created_at, until
        ) VALUES
          (${expDirectedReplyId}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 'user', NULL, ${liveAgentId}::uuid,
           ${expDirectedAskId}::uuid, 'note', 'SECRET_DIRECTED_EXPIRY_REPLY', ${openChId}::uuid, ${ts(-400)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${senderLeftDmReplyId}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 'user', ${departingAskerId}::uuid, NULL,
           ${senderLeftDirectedAskId}::uuid, 'note', 'SECRET_DIRECTED_DM_REPLY', NULL, ${ts(-390)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${expHiddenChoiceReplyId}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 'user', NULL, ${liveAgentId}::uuid,
           ${expHiddenChoiceAskId}::uuid, 'note', 'SECRET_CHOICE_REPLY_BODY', ${openChId}::uuid, ${ts(-380)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${archivedChChoiceReplyId}::uuid, ${wsId}::uuid, ${addresseeAId}::uuid, 'user', NULL, ${liveAgentId}::uuid,
           ${archivedChHiddenChoiceAskId}::uuid, 'note', 'SECRET_ARCHIVED_CH_CHOICE_BODY', NULL, ${ts(-370)}::timestamptz, '9999-12-31T23:59:59Z')
      `;
      await tx`
        INSERT INTO swarm.ui_actions (
          action_id, workspace_id, signal_id, actor_user_id, option_id, option_ids, other_text,
          state, reply_signal_id, created_at, completed_at
        ) VALUES
          (${randomUUID()}::uuid, ${wsId}::uuid, ${expHiddenChoiceAskId}::uuid, ${addresseeAId}::uuid,
           'opt_secret', ARRAY['opt_secret']::text[], 'SECRET_CHOICE_OTHER',
           'completed', ${expHiddenChoiceReplyId}::uuid, ${ts(-380)}::timestamptz, ${ts(-380)}::timestamptz),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${archivedChHiddenChoiceAskId}::uuid, ${addresseeAId}::uuid,
           'opt_secret', ARRAY['opt_secret']::text[], NULL,
           'completed', ${archivedChChoiceReplyId}::uuid, ${ts(-370)}::timestamptz, ${ts(-370)}::timestamptz)
      `;
    }

    await tx`RESET ROLE`;
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;

    // Trigger sender_left (ts(-200)) and channel_archived (ts(-220)) identically in both workspaces.
    await tx`
      UPDATE swarm.memberships
      SET revoked_at = ${ts(-200)}::timestamptz
      WHERE workspace_id = ${wsId}::uuid AND user_id = ${departingAskerId}::uuid
    `;
    await tx`
      UPDATE swarm.channels
      SET archived_at = ${ts(-220)}::timestamptz
      WHERE workspace_id = ${wsId}::uuid AND channel_id = ${archivedChId}::uuid
    `;
    await tx`SELECT swarm.conversation_for_channel(${wsId}::uuid, ${archivedChId}::uuid)`;

    return {
      wsId,
      addresseeAId,
      addresseeBId,
      liveAgentId,
      openChId,
      expDirectedAskId,
      senderLeftDirectedAskId,
      expHiddenChoiceAskId,
      archivedChHiddenChoiceAskId,
      visibleAnswerExpiredAskId,
    };
  }

  try {
    await sql.begin(async (tx) => {
      const priv = await seedMirrorWorkspace(tx, true);
      const ctrl = await seedMirrorWorkspace(tx, false);

      // 1. Compare B's full Archived page between the privately-answered workspace and the never-answered control.
      const bPrivFull = await readArchivedPage(tx, priv.wsId, priv.addresseeBId, 50);
      const bCtrlFull = await readArchivedPage(tx, ctrl.wsId, ctrl.addresseeBId, 50);

      assert.equal(bPrivFull.total, 5, `bPrivFull=${JSON.stringify(bPrivFull)}`);
      assert.equal(
        bPrivFull.total,
        bCtrlFull.total,
        `B's total must match the never-answered control; priv=${JSON.stringify(bPrivFull)} ctrl=${JSON.stringify(bCtrlFull)}`,
      );
      assert.equal(
        bPrivFull.truncated,
        bCtrlFull.truncated,
        `B's truncated flag mismatch; priv=${JSON.stringify(bPrivFull)} ctrl=${JSON.stringify(bCtrlFull)}`,
      );
      assert.deepEqual(
        bPrivFull.items.map(normalizeRow),
        bCtrlFull.items.map(normalizeRow),
        `B's Archived items must match the never-answered control field for field; priv=${JSON.stringify(bPrivFull.items)} ctrl=${JSON.stringify(bCtrlFull.items)}`,
      );

      // Verify each specific cleared outcome, timestamp, and absence of answer data for B.
      const bByKey = new Map(bPrivFull.items.map((i) => [i.item_key, i]));
      const bExpDir = bByKey.get(`ask:${priv.expDirectedAskId}`);
      assert.ok(bExpDir, `expDirectedAskId missing from B's Archived; bPrivFull=${JSON.stringify(bPrivFull)}`);
      assert.equal(bExpDir.outcome_kind, "expired", `bExpDir=${JSON.stringify(bExpDir)}`);
      assert.equal(bExpDir.outcome_text, "Expired", `bExpDir=${JSON.stringify(bExpDir)}`);
      assert.equal(Date.parse(bExpDir.archived_at), Date.parse(ts(-300)), `bExpDir=${JSON.stringify(bExpDir)}`);
      assert.equal(bExpDir.answered_by, null, `bExpDir=${JSON.stringify(bExpDir)}`);

      const bSenderLeft = bByKey.get(`ask:${priv.senderLeftDirectedAskId}`);
      assert.ok(bSenderLeft, `senderLeftDirectedAskId missing from B's Archived; bPrivFull=${JSON.stringify(bPrivFull)}`);
      assert.equal(bSenderLeft.outcome_kind, "sender_left", `bSenderLeft=${JSON.stringify(bSenderLeft)}`);
      assert.equal(bSenderLeft.outcome_text, "Sender left", `bSenderLeft=${JSON.stringify(bSenderLeft)}`);
      assert.equal(Date.parse(bSenderLeft.archived_at), Date.parse(ts(-200)), `bSenderLeft=${JSON.stringify(bSenderLeft)}`);
      assert.equal(bSenderLeft.answered_by, null, `bSenderLeft=${JSON.stringify(bSenderLeft)}`);

      const bExpChoice = bByKey.get(`ask:${priv.expHiddenChoiceAskId}`);
      assert.ok(bExpChoice, `expHiddenChoiceAskId missing from B's Archived; bPrivFull=${JSON.stringify(bPrivFull)}`);
      assert.equal(bExpChoice.outcome_kind, "expired", `bExpChoice=${JSON.stringify(bExpChoice)}`);
      assert.equal(bExpChoice.outcome_text, "Expired", `bExpChoice=${JSON.stringify(bExpChoice)}`);
      assert.equal(Date.parse(bExpChoice.archived_at), Date.parse(ts(-250)), `bExpChoice=${JSON.stringify(bExpChoice)}`);
      assert.equal(bExpChoice.answered_by, null, `bExpChoice=${JSON.stringify(bExpChoice)}`);

      const bArchivedChChoice = bByKey.get(`ask:${priv.archivedChHiddenChoiceAskId}`);
      assert.ok(bArchivedChChoice, `archivedChHiddenChoiceAskId missing from B's Archived; bPrivFull=${JSON.stringify(bPrivFull)}`);
      assert.equal(bArchivedChChoice.outcome_kind, "channel_archived", `bArchivedChChoice=${JSON.stringify(bArchivedChChoice)}`);
      assert.equal(bArchivedChChoice.outcome_text, "Channel archived", `bArchivedChChoice=${JSON.stringify(bArchivedChChoice)}`);
      assert.equal(Date.parse(bArchivedChChoice.archived_at), Date.parse(ts(-220)), `bArchivedChChoice=${JSON.stringify(bArchivedChChoice)}`);
      assert.equal(bArchivedChChoice.answered_by, null, `bArchivedChChoice=${JSON.stringify(bArchivedChChoice)}`);

      // Visible-answer control: unaddressed reply wins ONCE for B even though the ask also expired.
      const bVisibleMatches = bPrivFull.items.filter((i) => i.item_key === `ask:${priv.visibleAnswerExpiredAskId}`);
      assert.equal(
        bVisibleMatches.length,
        1,
        `visible answer must appear once for B, not also as expired; matches=${JSON.stringify(bVisibleMatches)}`,
      );
      assert.equal(bVisibleMatches[0]!.outcome_kind, "answered", `row=${JSON.stringify(bVisibleMatches[0])}`);
      assert.equal(bVisibleMatches[0]!.outcome_text, "Public answer both can read", `row=${JSON.stringify(bVisibleMatches[0])}`);
      assert.equal(Date.parse(bVisibleMatches[0]!.archived_at), Date.parse(ts(-180)), `row=${JSON.stringify(bVisibleMatches[0])}`);
      assert.equal(bVisibleMatches[0]!.answered_by?.by_viewer, false, `row=${JSON.stringify(bVisibleMatches[0])}`);

      // Zero secret answer content anywhere in B's response.
      const bJson = JSON.stringify(bPrivFull);
      for (const secret of [
        "SECRET_DIRECTED_EXPIRY_REPLY",
        "SECRET_DIRECTED_DM_REPLY",
        "SECRET_CHOICE_LABEL",
        "SECRET_CHOICE_OTHER",
        "SECRET_CHOICE_REPLY_BODY",
        "SECRET_ARCHIVED_CH_CHOICE_BODY",
      ]) {
        assert.equal(bJson.includes(secret), false, `B's Archived page must never leak ${secret}; bPrivFull=${bJson}`);
      }

      // 2. Compare B's keyset cursor pagination (limit = 2) page-for-page against the never-answered control.
      let pAfterAt: string | null = null;
      let pAfterKey: string | null = null;
      let cAfterAt: string | null = null;
      let cAfterKey: string | null = null;
      let pageCount = 0;
      for (;;) {
        pageCount += 1;
        assert.ok(pageCount <= 5, `pagination must terminate in 3 pages; pageCount=${pageCount}`);
        const pPage = await readArchivedPage(tx, priv.wsId, priv.addresseeBId, 2, pAfterAt, pAfterKey);
        const cPage = await readArchivedPage(tx, ctrl.wsId, ctrl.addresseeBId, 2, cAfterAt, cAfterKey);
        assert.equal(
          pPage.total,
          cPage.total,
          `page ${pageCount} total matches control; pPage=${JSON.stringify(pPage)} cPage=${JSON.stringify(cPage)}`,
        );
        assert.equal(
          pPage.truncated,
          cPage.truncated,
          `page ${pageCount} truncated matches control; pPage=${JSON.stringify(pPage)} cPage=${JSON.stringify(cPage)}`,
        );
        assert.deepEqual(
          pPage.items.map(normalizeRow),
          cPage.items.map(normalizeRow),
          `page ${pageCount} items match control; pPage=${JSON.stringify(pPage)} cPage=${JSON.stringify(cPage)}`,
        );
        if (!pPage.truncated) break;
        const pLast = pPage.items[pPage.items.length - 1]!;
        const cLast = cPage.items[cPage.items.length - 1]!;
        assert.equal(
          Date.parse(pLast.archived_at),
          Date.parse(cLast.archived_at),
          `page ${pageCount} cursor timestamp matches control; pLast=${JSON.stringify(pLast)} cLast=${JSON.stringify(cLast)}`,
        );
        pAfterAt = pLast.archived_at;
        pAfterKey = pLast.item_key;
        cAfterAt = cLast.archived_at;
        cAfterKey = cLast.item_key;
      }
      assert.equal(pageCount, 3, `5 rows at limit 2 span 3 cursor pages; got pageCount=${pageCount}`);

      // 3. Addressee A sees ALL 5 asks as 'answered', ONCE each (never duplicated as cleared).
      const aPrivFull = await readArchivedPage(tx, priv.wsId, priv.addresseeAId, 50);
      assert.equal(aPrivFull.total, 5, `aPrivFull=${JSON.stringify(aPrivFull)}`);
      const expectedForA: Array<[string, string, number]> = [
        [priv.expDirectedAskId, "SECRET_DIRECTED_EXPIRY_REPLY", Date.parse(ts(-400))],
        [priv.senderLeftDirectedAskId, "SECRET_DIRECTED_DM_REPLY", Date.parse(ts(-390))],
        [priv.expHiddenChoiceAskId, "SECRET_CHOICE_LABEL · SECRET_CHOICE_OTHER", Date.parse(ts(-380))],
        [priv.archivedChHiddenChoiceAskId, "SECRET_CHOICE_LABEL", Date.parse(ts(-370))],
        [priv.visibleAnswerExpiredAskId, "Public answer both can read", Date.parse(ts(-180))],
      ];
      for (const [askId, expectedText, expectedAt] of expectedForA) {
        const matches = aPrivFull.items.filter((i) => i.item_key === `ask:${askId}`);
        assert.equal(
          matches.length,
          1,
          `ask:${askId} must appear exactly once for A; matches=${JSON.stringify(matches)} aPrivFull=${JSON.stringify(aPrivFull)}`,
        );
        assert.equal(matches[0]!.outcome_kind, "answered", `row=${JSON.stringify(matches[0])}`);
        assert.equal(matches[0]!.outcome_text, expectedText, `row=${JSON.stringify(matches[0])}`);
        assert.equal(Date.parse(matches[0]!.archived_at), expectedAt, `row=${JSON.stringify(matches[0])}`);
        assert.equal(matches[0]!.answered_by?.by_viewer, true, `row=${JSON.stringify(matches[0])}`);
      }

      // 4. Live queue rule unchanged: an unexpired ask privately answered by A still leaves B's Waiting on you
      //    (via global swarm.ask_answered) without appearing in B's Archived until it auto-clears.
      const liveDirectedAskId = randomUUID();
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, created_at, until, sender_lifecycle_epoch)
        VALUES (
          ${liveDirectedAskId}::uuid, ${priv.wsId}::uuid, ${priv.liveAgentId}::uuid, 'agent',
          ${priv.addresseeAId}::uuid, 'ask', 'Unexpired ask with directed reply?', ${priv.openChId}::uuid,
          ${ts(-100)}::timestamptz, '9999-12-31T23:59:59Z', 1
        )
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${liveDirectedAskId}::uuid, ${priv.wsId}::uuid, ${priv.addresseeAId}::uuid, 0),
          (${liveDirectedAskId}::uuid, ${priv.wsId}::uuid, ${priv.addresseeBId}::uuid, 1)
      `;
      await tx`
        INSERT INTO swarm.signals (
          id, workspace_id, from_principal, from_kind, to_agent_principal_id,
          in_reply_to, kind, body, channel_id, created_at, until
        ) VALUES (
          ${randomUUID()}::uuid, ${priv.wsId}::uuid, ${priv.addresseeAId}::uuid, 'user', ${priv.liveAgentId}::uuid,
          ${liveDirectedAskId}::uuid, 'note', 'SECRET_LIVE_DIRECTED_REPLY', ${priv.openChId}::uuid,
          ${ts(-90)}::timestamptz, '9999-12-31T23:59:59Z'
        )
      `;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      const bLiveSnap = await readAllFiveAs(tx, priv.wsId, priv.addresseeBId);
      assert.equal(
        bLiveSnap.dq.total,
        0,
        `global ask_answered still clears live decision_queue for B; dq=${JSON.stringify(bLiveSnap.dq)}`,
      );
      assert.equal(
        bLiveSnap.dqp.total,
        0,
        `global ask_answered still clears live decision_queue_page for B; dqp=${JSON.stringify(bLiveSnap.dqp)}`,
      );
      assert.equal(
        bLiveSnap.wsOverview!.needs_you.asks.length,
        0,
        `global ask_answered still clears home_overview for B; wsOverview=${JSON.stringify(bLiveSnap.wsOverview)}`,
      );
      assert.equal(
        bLiveSnap.wa.items.some((i) => i.item_key === `ask:${liveDirectedAskId}`),
        false,
        `unexpired ask with private answer stays out of B's Archived until an auto-clear condition holds; wa=${JSON.stringify(bLiveSnap.wa)}`,
      );
      const aLiveSnap = await readAllFiveAs(tx, priv.wsId, priv.addresseeAId);
      assert.equal(
        aLiveSnap.wa.items.filter((i) => i.item_key === `ask:${liveDirectedAskId}`).length,
        1,
        `A sees the live privately-answered ask once in Archived; wa=${JSON.stringify(aLiveSnap.wa)}`,
      );

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
