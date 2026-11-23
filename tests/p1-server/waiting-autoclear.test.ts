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
const postNotice: HouseholdTodoNoticePort = async (tx, workspace, identity, intent) => {
  const signal = randomUUID();
  const first = intent.to[0]!;
  await tx`
    INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,to_user_id,to_agent_principal_id,about,kind,body,until)
    VALUES (
      ${signal}::uuid,${workspace}::uuid,${identity.principal_id ?? identity.user_id}::uuid,
      ${identity.principal_id ? "agent" : "user"},
      ${first.kind === "user" ? first.id : null}::uuid,${first.kind === "agent" ? first.id : null}::uuid,
      ${intent.about},${intent.kind},${intent.body},statement_timestamp()+interval '1 day'
    )
  `;
  for (const [position, to] of intent.to.entries()) {
    await tx`
      INSERT INTO swarm.signal_recipients(signal_id,workspace_id,recipient_user_id,recipient_agent_principal_id,position)
      VALUES (
        ${signal}::uuid,${workspace}::uuid,
        ${to.kind === "user" ? to.id : null}::uuid,${to.kind === "agent" ? to.id : null}::uuid,${position}
      )
    `;
  }
  return { to: intent.to, status: "sent", signal_id: signal };
};

function makeTodoStore() {
  const access = createHouseholdObjectStore({
    core: { ...objects, ...objectPolicy },
    transfers,
    storage: noStorage,
    fileContentAllowed: () => false,
    recheckCredential: async () => true,
  }).access;
  return createHouseholdTodoStore({ core: todoCore, access, notice: postNotice });
}

function committedTodo(result: { outcome: todos.TodoOutcome }): todos.Todo {
  assert.equal(result.outcome.status, "committed");
  if (result.outcome.status !== "committed" || !("todo_id" in result.outcome.value)) {
    throw new Error("Expected committed todo outcome");
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
    SELECT set_config('request.jwt.claims', '${JSON.stringify({ role: "authenticated", sub: userId })}', true);
    SET LOCAL ROLE authenticated;
    INSERT INTO pg_temp.read_snapshots(label, dq, dqp, wt, wa, ho)
    SELECT
      '${label}',
      swarm_read.decision_queue('${wsId}'::uuid) - 'generated_at',
      swarm_read.decision_queue_page('${wsId}'::uuid, NULL, NULL) - 'generated_at',
      swarm_read.waiting_todos_page('${wsId}'::uuid, 50, NULL, NULL) - 'generated_at',
      swarm_read.waiting_archived_page('${wsId}'::uuid, 50, NULL, NULL) - 'generated_at',
      (
        SELECT elem
        FROM jsonb_array_elements((swarm_read.home_overview())->'workspaces') AS elem
        WHERE elem->>'workspace_id' = '${wsId}'
      );
    RESET ROLE;
  `;

  runSql(`
    ${catalogAssert(false)}
    ${repoSql(`${proofRoot}-functional.sql`)}

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
    INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
    VALUES ('${wsId}'::uuid, 'shared');
    INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
    VALUES
      ('${wsId}'::uuid, '${aliceId}'::uuid, 'editor', '${randomUUID()}'::uuid, statement_timestamp()),
      ('${wsId}'::uuid, '${bobId}'::uuid, 'editor', '${randomUUID()}'::uuid, statement_timestamp());
    INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
    VALUES ('${privChId}'::uuid, '${wsId}'::uuid, 'parity-secret', 'private', '${aliceId}'::uuid, 'user');
    INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
    VALUES ('${privChId}'::uuid, '${wsId}'::uuid, 'user', '${aliceId}'::uuid, '${aliceId}'::uuid, 'user');
    SELECT swarm.conversation_for_channel('${wsId}'::uuid, '${privChId}'::uuid);
    SELECT swarm.conversation_open('${wsId}'::uuid, 'user', '${bobId}'::uuid, ARRAY['${aliceId}']::uuid[], ARRAY[]::uuid[], false);
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until)
    VALUES
      ('${generalAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity general ask?', NULL, '9999-12-31T23:59:59Z'),
      ('${dismissedAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity dismissed ask?', NULL, '9999-12-31T23:59:59Z'),
      ('${privAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity private ask?', '${privChId}'::uuid, '9999-12-31T23:59:59Z'),
      ('${dmAskId}'::uuid, '${wsId}'::uuid, '${bobId}'::uuid, 'user', '${aliceId}'::uuid, 'ask', 'Parity DM ask?', NULL, '9999-12-31T23:59:59Z'),
      ('${answeredAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity answered ask?', NULL, '9999-12-31T23:59:59Z');
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until)
    VALUES ('${randomUUID()}'::uuid, '${wsId}'::uuid, '${aliceId}'::uuid, 'user', '${answeredAskId}'::uuid, 'note', 'Answered!', '9999-12-31T23:59:59Z');
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO swarm.waiting_dismissals (workspace_id, user_id, item_kind, item_id, dismissed_at)
    VALUES ('${wsId}'::uuid, '${aliceId}'::uuid, 'ask', '${dismissedAskId}'::uuid, statement_timestamp());
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq
    ) VALUES
      ('${wsId}'::uuid, '${assignedTodoId}'::uuid, 1, 'Parity assigned', '', 'open',
       '${aliceId}'::uuid, statement_timestamp(), '${aliceId}'::uuid, '${aliceId}'::uuid, statement_timestamp(),
       'none', '${aliceId}'::uuid, statement_timestamp(), 0, 1),
      ('${wsId}'::uuid, '${doneTodoId}'::uuid, 1, 'Parity done', '', 'done',
       '${aliceId}'::uuid, statement_timestamp(), '${aliceId}'::uuid, '${aliceId}'::uuid, statement_timestamp(),
       'none', '${aliceId}'::uuid, statement_timestamp(), 0, 2);
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, offer_id, offer_principal, offer_decider,
      offer_start, offer_gate, offer_by_user, offered_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq
    ) VALUES (
      '${wsId}'::uuid, '${reviewTodoId}'::uuid, 1, 'Parity review', '', 'open',
      '${bobId}'::uuid, statement_timestamp(), '${reviewOfferId}'::uuid, '${scoutId}'::uuid, '${aliceId}'::uuid,
      'queue', '{"kind":"none"}'::jsonb, '${bobId}'::uuid, statement_timestamp(),
      'none', '${bobId}'::uuid, statement_timestamp(), 0, 3
    );

    CREATE TEMP TABLE pg_temp.read_snapshots (
      label text PRIMARY KEY,
      dq jsonb,
      dqp jsonb,
      wt jsonb,
      wa jsonb,
      ho jsonb
    );

    ${snapshotFive("after_alice", aliceId)}
    ${snapshotFive("after_bob", bobId)}

    -- Roll back to 20261124000001 bodies and verify rollback catalog + exact parity.
    ${repoSql(`${proofRoot}-rollback.sql`)}
    ${catalogAssert(true)}

    ${snapshotFive("before_alice", aliceId)}
    ${snapshotFive("before_bob", bobId)}

    ${dbAssert(`
      SELECT
        a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
      FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
      WHERE a.label = 'after_alice' AND b.label = 'before_alice'
    `, "all 5 read functions must match 20261124000001 verbatim for Alice when no new rules apply")}
    ${dbAssert(`
      SELECT
        a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
      FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
      WHERE a.label = 'after_bob' AND b.label = 'before_bob'
    `, "all 5 read functions must match 20261124000001 verbatim for Bob when no new rules apply")}

    -- Re-apply 20261124000002 and re-verify proofs + parity.
    ${repoSql("supabase/migrations/20261124000002_waiting_autoclear.sql")}
    ${catalogAssert(false)}
    ${repoSql(`${proofRoot}-functional.sql`)}

    ${snapshotFive("reapplied_alice", aliceId)}
    ${dbAssert(`
      SELECT
        a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
      FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
      WHERE a.label = 'reapplied_alice' AND b.label = 'before_alice'
    `, "re-applied 20261124000002 matches 20261124000001 verbatim for Alice when no new rules apply")}
  `);
});

const ROLLBACK_WITNESS = Symbol("rollback-waiting-autoclear-witness");

test("every Slice 2 rule clears Waiting and counts, agrees across decision_queue/home_overview, populates Archived with exact outcomes, and enforces visibility + uniform 404", async () => {
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const carolId = randomUUID();
  const wsId = randomUUID();
  const liveAgentId = randomUUID();
  const revokedAgentId = randomUUID();
  const seatRemovedAgentId = randomUUID();
  const ownerLeftAgentId = randomUUID();
  const bobAgentId = randomUUID();
  const openChId = randomUUID();
  const privChReadableId = randomUUID();
  const privChUnreadableId = randomUUID();
  const privChLostId = randomUUID();
  const dmConvId = randomUUID();

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
      // DM conversations: Alice<->Bob (live sender) and Alice<->RevokedBot (agent later revoked after Alice leaves)
      const [dmOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(${wsId}::uuid, 'user', ${bobId}::uuid, ARRAY[${aliceId}]::uuid[], ARRAY[]::uuid[], false) AS r
      `;
      const actualDmConvId = dmOpen!.r.conversation.conversation_id;
      const [dmRevokedOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(${wsId}::uuid, 'user', ${aliceId}::uuid, ARRAY[]::uuid[], ARRAY[${revokedAgentId}]::uuid[], false) AS r
      `;
      const actualDmRevokedConvId = dmRevokedOpen!.r.conversation.conversation_id;
      void dmConvId;

      // Seed asks — initially ALL live (except expiredAskId which has explicit past until, and privChUnreadableAskId where Alice isn't in channel).
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, created_at, until)
        VALUES
          (${liveAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Live agent still here?', NULL, ${ts(-600)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${selfFollowupAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Self follow-up ask?', NULL, ${ts(-590)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${answeredByBobAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Answered by Bob?', NULL, ${ts(-580)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${answeredByBobAgentAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Answered by BobBot?', NULL, ${ts(-570)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${revokedAgentAskId}::uuid, ${wsId}::uuid, ${revokedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'From revoked agent?', NULL, ${ts(-560)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${dismissedThenRevokedAskId}::uuid, ${wsId}::uuid, ${revokedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Dismissed then revoked?', NULL, ${ts(-550)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${seatRemovedAskId}::uuid, ${wsId}::uuid, ${seatRemovedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'From seat-removed agent?', NULL, ${ts(-540)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${ownerLeftAskId}::uuid, ${wsId}::uuid, ${ownerLeftAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'From CarolBot whose owner leaves?', NULL, ${ts(-530)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${senderLeftAskId}::uuid, ${wsId}::uuid, ${carolId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'From Carol who leaves?', NULL, ${ts(-520)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${archivedOpenChAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'In archived open channel?', ${openChId}::uuid, ${ts(-510)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${archivedPrivReadableAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'In archived readable private channel?', ${privChReadableId}::uuid, ${ts(-500)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${archivedPrivUnreadableAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'SECRET archived private ask?', ${privChUnreadableId}::uuid, ${ts(-490)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${lostPrivChAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'SECRET lost private ask?', ${privChLostId}::uuid, ${ts(-480)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${leftDmAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${aliceId}::uuid, 'ask', 'SECRET left DM ask?', NULL, ${ts(-470)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${leftDmRevokedAskId}::uuid, ${wsId}::uuid, ${revokedAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'SECRET left DM revoked agent ask?', NULL, ${ts(-465)}::timestamptz, '9999-12-31T23:59:59Z'),
          (${expiredAskId}::uuid, ${wsId}::uuid, ${liveAgentId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Explicit short horizon ask?', NULL, ${ts(-460)}::timestamptz, ${ts(-400)}::timestamptz)
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
      assert.ok(reviewTodo.offer?.offer_id);
      const reviewOfferId = reviewTodo.offer.offer_id;

      // Alice dismisses dismissedThenRevokedAskId while it is still live!
      const [dismissBefore] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${dismissedThenRevokedAskId}::uuid) AS r
      `;
      assert.equal(dismissBefore!.r.status, "ok");
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
      assert.equal(beforeSnap.dq.total, expectedBeforeAskIds.length);
      assert.deepEqual(askIdsInOrder(beforeSnap.dq.asks), expectedBeforeAskIds);
      assert.deepEqual(askIdsInOrder(beforeSnap.dqp.asks), expectedBeforeAskIds);
      // home_overview caps at 10 newest asks, all of which must come from the exact same eligible set (including selfFollowupAskId, excluding dismissedThenRevokedAskId & expiredAskId & archivedPrivUnreadableAskId).
      assert.equal(beforeSnap.wsOverview!.needs_you.asks.length, 10);
      for (const a of beforeSnap.wsOverview!.needs_you.asks) {
        assert.ok(expectedBeforeAskIds.includes(a.signal_id), `home_overview ask ${a.signal_id} must be in eligible set`);
      }
      assert.equal(beforeSnap.wt.total, 1);
      assert.equal(beforeSnap.wt.todos[0]!.reason, "request");
      assert.equal(beforeSnap.wsOverview!.needs_you.waiting.length, 1);

      // Verify expiredAskId is ALREADY in Archived as 'expired' / 'Expired' with archived_at = until.
      const beforeExpired = beforeSnap.wa.items.find((i) => i.item_key === `ask:${expiredAskId}`);
      assert.ok(beforeExpired, "expired ask must appear in Archived");
      assert.equal(beforeExpired.outcome_kind, "expired");
      assert.equal(beforeExpired.outcome_text, "Expired");
      assert.equal(beforeExpired.answered_by, null);
      assert.equal(Date.parse(beforeExpired.archived_at), Date.parse(ts(-400)));

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

      // Rule 2: revoke revokedAgentId globally, revoke seatRemovedAgentId workspace seat, and revoke Carol (owner of ownerLeftAgentId & sender of senderLeftAskId -> also triggers Rule 3!).
      await tx`UPDATE swarm.agent_principals SET revoked_at = ${ts(-280)}::timestamptz WHERE principal_id = ${revokedAgentId}::uuid`;
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
      assert.equal(afterSnap.dq.total, 2, "only live ask and self-followup ask remain in decision_queue");
      assert.equal(afterSnap.dqp.total, 2, "decision_queue_page total matches decision_queue");
      assert.deepEqual(askIdsInOrder(afterSnap.dq.asks), expectedRemaining);
      assert.deepEqual(askIdsInOrder(afterSnap.dqp.asks), expectedRemaining);
      assert.deepEqual(askIdsInOrder(afterSnap.wsOverview!.needs_you.asks), expectedRemaining, "home_overview agrees exactly with decision_queue");

      // Withdrawn review left waiting_todos_page AND home_overview!
      assert.equal(afterSnap.wt.total, 0);
      assert.equal(afterSnap.wsOverview!.needs_you.waiting.length, 0);

      // Verify Archived outcomes!
      const archByKey = new Map(afterSnap.wa.items.map((i) => [i.item_key, i]));

      // Live asks stay OUT of Archived.
      assert.equal(archByKey.has(`ask:${liveAskId}`), false);
      assert.equal(archByKey.has(`ask:${selfFollowupAskId}`), false);

      // Rule 1: answered by another addressee / their agent.
      const bobAns = archByKey.get(`ask:${answeredByBobAskId}`);
      assert.ok(bobAns);
      assert.equal(bobAns.outcome_kind, "answered");
      assert.equal(bobAns.outcome_text, "Bob handled it");
      assert.equal(bobAns.answered_by?.by_viewer, false);

      const bobAgentAns = archByKey.get(`ask:${answeredByBobAgentAskId}`);
      assert.ok(bobAgentAns);
      assert.equal(bobAgentAns.outcome_kind, "answered");
      assert.equal(bobAgentAns.outcome_text, "BobBot handled it");

      // Rule 2: agent_removed (revoked principal, revoked workspace seat, owner left, and dismissed-then-revoked).
      for (const id of [revokedAgentAskId, seatRemovedAskId, ownerLeftAskId, dismissedThenRevokedAskId]) {
        const matches = afterSnap.wa.items.filter((i) => i.item_key === `ask:${id}`);
        assert.equal(matches.length, 1, `ask:${id} must appear exactly once in Archived`);
        assert.equal(matches[0]!.outcome_kind, "agent_removed");
        assert.equal(matches[0]!.outcome_text, "Agent removed");
        assert.equal(matches[0]!.answered_by, null);
      }

      // Rule 3: sender_left.
      const senderLeft = archByKey.get(`ask:${senderLeftAskId}`);
      assert.ok(senderLeft);
      assert.equal(senderLeft.outcome_kind, "sender_left");
      assert.equal(senderLeft.outcome_text, "Sender left");
      assert.equal(senderLeft.answered_by, null);

      // Rule 4: channel_archived (readable open + readable private appear; unreadable private MUST NOT appear).
      for (const id of [archivedOpenChAskId, archivedPrivReadableAskId]) {
        const row = archByKey.get(`ask:${id}`);
        assert.ok(row, `ask:${id} should appear as channel_archived`);
        assert.equal(row.outcome_kind, "channel_archived");
        assert.equal(row.outcome_text, "Channel archived");
        assert.equal(row.answered_by, null);
      }
      assert.equal(archByKey.has(`ask:${archivedPrivUnreadableAskId}`), false, "unreadable archived private ask must not be listed");

      // Rule 5: viewer lost access -> NOT listed in Archived (zero leakage, even when asking agent is also revoked).
      assert.equal(archByKey.has(`ask:${lostPrivChAskId}`), false, "removed private-channel ask must not appear in Archived");
      assert.equal(archByKey.has(`ask:${leftDmAskId}`), false, "left DM ask must not appear in Archived");
      assert.equal(archByKey.has(`ask:${leftDmRevokedAskId}`), false, "left DM ask from revoked agent must not appear in Archived");
      const afterJson = JSON.stringify(afterSnap.wa);
      assert.equal(afterJson.includes("SECRET archived private ask?"), false);
      assert.equal(afterJson.includes("SECRET lost private ask?"), false);
      assert.equal(afterJson.includes("SECRET left DM ask?"), false);
      assert.equal(afterJson.includes("SECRET left DM revoked agent ask?"), false);

      // Explicit expiry: expired.
      const expired = archByKey.get(`ask:${expiredAskId}`);
      assert.ok(expired);
      assert.equal(expired.outcome_kind, "expired");
      assert.equal(expired.outcome_text, "Expired");
      assert.equal(expired.answered_by, null);

      // Withdrawn review offer: withdrawn.
      const withdrawn = archByKey.get(`review:${reviewOfferId}`);
      assert.ok(withdrawn, "withdrawn review offer must appear in Archived");
      assert.equal(withdrawn.outcome_kind, "withdrawn");
      assert.equal(withdrawn.outcome_text, "Withdrawn");

      // Uniform 404 on dismiss/restore for auto-cleared asks (indistinguishable from unknown UUID).
      await tx`SET LOCAL ROLE swarm_command`;
      const [unknownDismiss] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${randomUUID()}::uuid) AS r
      `;
      assert.deepEqual(unknownDismiss!.r, { status: "not_found" });
      for (const clearedId of [revokedAgentAskId, senderLeftAskId, archivedOpenChAskId, expiredAskId, leftDmAskId]) {
        const [d] = await tx<{ r: Row }[]>`
          SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${clearedId}::uuid) AS r
        `;
        assert.deepEqual(d!.r, unknownDismiss!.r, `dismiss on cleared ask ${clearedId} must return uniform not_found`);
      }
      const [restoreCleared] = await tx<{ r: Row }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${dismissedThenRevokedAskId}::uuid) AS r
      `;
      assert.deepEqual(restoreCleared!.r, { status: "not_found" }, "restore on dismissed-then-revoked ask must return uniform not_found");
      await tx`RESET ROLE`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
