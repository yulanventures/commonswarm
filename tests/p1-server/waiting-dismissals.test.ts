/**
 * Server witness for 20261124000001_waiting_dismissals.sql (CI / local Postgres only):
 *   1. Catalog check, rollback, rollback-catalog check, re-apply, and functional proof.
 *   2. Per-person dismissal of an ask, a to-do, and a work-request review:
 *      - Leaves the dismissing person's decision_queue, decision_queue_page, waiting_todos_page,
 *        and home_overview (both lists and counts).
 *      - Stays untouched in another person's lists and counts.
 *      - Appears in waiting_archived_page with outcome_kind='dismissed' and outcome_text='Dismissed'.
 *   3. Restore returns still-open items to Waiting on you and removes them from Archived.
 *   4. Idempotency: dismissing twice keeps original dismissed_at and produces one row; restoring
 *      twice succeeds cleanly.
 *   5. Authz:
 *      - Agents cannot call dismiss_waiting_item/restore_waiting_item (HUMAN_ONLY_COMMANDS + role gates).
 *      - A person who cannot read the item (unauthorized private channel ask, no household consent
 *        for to-do/review, non-member) is refused with not_found / forbidden.
 *      - Direct table access on swarm.waiting_dismissals is refused for authenticated/anon/swarm_read/swarm_command.
 *   6. Real resolution supersedes dismissal: a dismissed-then-answered ask appears in Archived
 *      only under its real outcome ('answered'), never as 'dismissed'.
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

const proofRoot = "deploy/release-proofs/waiting-dismissals/20261124000001";
const catalogAssert = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}-${rollback ? "rollback-catalog" : "catalog"}.sql`),
      rollback ? "rollback_ok" : "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    rollback ? "waiting dismissals rollback catalog" : "waiting dismissals catalog",
  );

test("20261124000001 waiting_dismissals rolls back cleanly and re-applies with functional proof", () => {
  runSql(
    catalogAssert(false) +
      repoSql(`${proofRoot}-functional.sql`) +
      repoSql(`${proofRoot}-rollback.sql`) +
      catalogAssert(true) +
      repoSql("supabase/migrations/20261124000001_waiting_dismissals.sql") +
      catalogAssert(false) +
      repoSql(`${proofRoot}-functional.sql`),
  );
});

let sql: postgres.Sql;

function resolveDbUrl(): string {
  const fromEnv = process.env.WAITING_DISMISSALS_TEST_DB_URL ?? process.env.WAITING_TODOS_TEST_DB_URL;
  const dbUrl = fromEnv ?? (JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as { DB_URL?: string }).DB_URL;
  assert.ok(
    dbUrl && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(dbUrl).hostname),
    "expected local Supabase DB_URL",
  );
  return dbUrl;
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

before(() => {
  sql = postgres(resolveDbUrl(), { prepare: false, max: 2 });
});

after(async () => {
  await sql.end();
});

const ROLLBACK_WITNESS = Symbol("rollback-waiting-dismissals-witness");

test("dismiss and restore work per person for ask, todo, and review with isolation, authz, idempotency, and real-outcome precedence", async () => {
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const noConsentId = randomUUID();
  const outsiderId = randomUUID();
  const wsId = randomUUID();
  const scoutId = randomUUID();
  const privChannelId = randomUUID();
  const sharedAskId = randomUUID();
  const privAskId = randomUUID();
  const store = makeTodoStore();
  const aliceIdentity: HouseholdIdentity = { user_id: aliceId, principal_id: null, run_id: null, connection: null };
  const bobIdentity: HouseholdIdentity = { user_id: bobId, principal_id: null, run_id: null, connection: null };

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${aliceId}::uuid, ${`wd-a-${aliceId}@example.test`}),
          (${bobId}::uuid, ${`wd-b-${bobId}@example.test`}),
          (${noConsentId}::uuid, ${`wd-nc-${noConsentId}@example.test`}),
          (${outsiderId}::uuid, ${`wd-out-${outsiderId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${aliceId}::uuid, 'Alice'),
          (${bobId}::uuid, 'Bob'),
          (${noConsentId}::uuid, 'NoConsent'),
          (${outsiderId}::uuid, 'Outsider')
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES (${wsId}::uuid, 'DismissWS', ${aliceId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${aliceId}::uuid, 'owner'),
          (${wsId}::uuid, ${bobId}::uuid, 'member'),
          (${wsId}::uuid, ${noConsentId}::uuid, 'member')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${scoutId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 'Scout')
      `;
      await tx`
        INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id)
        VALUES (${wsId}::uuid, ${scoutId}::uuid, ${aliceId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
        VALUES (${wsId}::uuid, 'shared')
      `;
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${aliceId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${bobId}::uuid, 'editor', ${randomUUID()}::uuid, now())
      `;
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES (${privChannelId}::uuid, ${wsId}::uuid, 'secret-room', 'private', ${aliceId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES (${privChannelId}::uuid, ${wsId}::uuid, 'user', ${aliceId}::uuid, ${aliceId}::uuid, 'user')
      `;

      // Shared ask addressed to BOTH Alice and Bob in #general
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
        VALUES (${sharedAskId}::uuid, ${wsId}::uuid, ${scoutId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Should we ship Slice 1?', '9999-12-31T23:59:59Z')
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${sharedAskId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 0),
          (${sharedAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 1)
      `;
      // Private-channel ask addressed to Alice (Bob is NOT in #secret-room)
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until)
        VALUES (${privAskId}::uuid, ${wsId}::uuid, ${scoutId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Private question', ${privChannelId}::uuid, '9999-12-31T23:59:59Z')
      `;

      // Create an assigned to-do for Alice and a work-request review for Alice (Bob offers to Scout, owned by Alice)
      await tx`SAVEPOINT sp_setup_todos`;
      await tx`SET LOCAL ROLE swarm_command`;
      const aliceTodo = committedTodo(await store.write(tx, wsId, aliceIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Book plumber",
        assign: { to: { kind: "user", id: aliceId } },
      }));
      const reviewTodo = committedTodo(await store.write(tx, wsId, bobIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Scout roof inspection",
        assign: { to: { kind: "agent", id: scoutId } },
      }));
      assert.ok(reviewTodo.offer?.offer_id, "review todo should carry an offer_id");
      const reviewOfferId = reviewTodo.offer.offer_id;
      await tx`RESET ROLE`;

      const readAs = async (userId: string) => {
        await tx`SAVEPOINT sp_read`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
        await tx`SET LOCAL ROLE authenticated`;
        const [dq] = await tx<{ r: { total: number; asks: Array<{ signal_id: string }> } }[]>`
          SELECT swarm_read.decision_queue(${wsId}::uuid) AS r
        `;
        const [dqp] = await tx<{ r: { total: number; asks: Array<{ signal_id: string }> } }[]>`
          SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r
        `;
        const [wt] = await tx<{ r: { total: number; todos: Array<{ todo_id: string; reason: string }> } }[]>`
          SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
        `;
        const [wa] = await tx<{ r: { total: number; items: Array<{ item_key: string; outcome_kind: string; outcome_text: string }> } }[]>`
          SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r
        `;
        const [ho] = await tx<{ r: { workspaces: Array<{ workspace_id: string; needs_you: { asks: Array<{ signal_id: string }>; assigned: Array<{ todo_id: string }>; waiting: Array<{ todo_id: string; reason: string }> } }> } }[]>`
          SELECT swarm_read.home_overview() AS r
        `;
        await tx`ROLLBACK TO SAVEPOINT sp_read`;
        const wsOverview = ho!.r.workspaces.find((w) => w.workspace_id === wsId)!;
        return { dq: dq!.r, dqp: dqp!.r, wt: wt!.r, wa: wa!.r, wsOverview };
      };

      // Baseline: Alice sees 2 asks, 2 todos (1 assigned + 1 request); Bob sees 1 ask (sharedAskId)
      const aliceBefore = await readAs(aliceId);
      assert.equal(aliceBefore.dq.total, 2);
      assert.equal(aliceBefore.dqp.total, 2);
      assert.equal(aliceBefore.wt.total, 2);
      assert.equal(aliceBefore.wsOverview.needs_you.asks.length, 2);
      assert.equal(aliceBefore.wsOverview.needs_you.assigned.length, 1);
      assert.equal(aliceBefore.wsOverview.needs_you.waiting.length, 1);

      const bobBefore = await readAs(bobId);
      assert.equal(bobBefore.dq.total, 1);
      assert.equal(bobBefore.dq.asks[0]!.signal_id, sharedAskId);

      // Direct table reads/writes refused for client roles
      for (const role of ["anon", "authenticated", "swarm_read", "swarm_command"]) {
        await tx`SAVEPOINT sp_table_deny`;
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await assert.rejects(() => tx`SELECT * FROM swarm.waiting_dismissals`, /permission denied/);
        await tx`ROLLBACK TO SAVEPOINT sp_table_deny`;
      }

      // Write calls as swarm_command
      await tx`SAVEPOINT sp_cmd`;
      await tx`SET LOCAL ROLE swarm_command`;

      // Unauthorized reads are refused:
      // 1. Bob cannot dismiss Alice's private-channel ask -> not_found
      const [bobPriv] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${bobId}::uuid, 'ask', ${privAskId}::uuid) AS r
      `;
      assert.equal(bobPriv!.r.status, "not_found");

      // 2. NoConsent member cannot dismiss a to-do or review -> not_found
      const [ncTodo] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${noConsentId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(ncTodo!.r.status, "not_found");
      const [ncReview] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${noConsentId}::uuid, 'review', ${reviewOfferId}::uuid) AS r
      `;
      assert.equal(ncReview!.r.status, "not_found");

      // 3. Outsider (non-member) -> forbidden
      const [outRes] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${outsiderId}::uuid, 'ask', ${sharedAskId}::uuid) AS r
      `;
      assert.equal(outRes!.r.status, "forbidden");

      // Alice dismisses sharedAskId, aliceTodo, and reviewOfferId
      const [dAsk1] = await tx<{ r: { status: string; dismissed: boolean; dismissed_at: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${sharedAskId}::uuid) AS r
      `;
      assert.equal(dAsk1!.r.status, "ok");
      assert.equal(dAsk1!.r.dismissed, true);

      // Idempotency: dismissing the same ask twice keeps original dismissed_at
      const [dAsk2] = await tx<{ r: { status: string; dismissed: boolean; dismissed_at: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${sharedAskId}::uuid) AS r
      `;
      assert.equal(dAsk2!.r.status, "ok");
      assert.equal(dAsk2!.r.dismissed_at, dAsk1!.r.dismissed_at);

      const [dTodo] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(dTodo!.r.status, "ok");

      const [dReview] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'review', ${reviewOfferId}::uuid) AS r
      `;
      assert.equal(dReview!.r.status, "ok");
      await tx`RESET ROLE`;

      // Verify Alice's queues & home_overview drop all 3 dismissed items, while Bob STILL sees sharedAskId
      const aliceAfterDismiss = await readAs(aliceId);
      assert.equal(aliceAfterDismiss.dq.total, 1);
      assert.equal(aliceAfterDismiss.dq.asks[0]!.signal_id, privAskId);
      assert.equal(aliceAfterDismiss.dqp.total, 1);
      assert.equal(aliceAfterDismiss.wt.total, 0);
      assert.equal(aliceAfterDismiss.wsOverview.needs_you.asks.length, 1);
      assert.equal(aliceAfterDismiss.wsOverview.needs_you.assigned.length, 0);
      assert.equal(aliceAfterDismiss.wsOverview.needs_you.waiting.length, 0);

      // Verify all 3 dismissed items appear in Alice's Archived tab with outcome_kind='dismissed'
      assert.equal(aliceAfterDismiss.wa.total, 3);
      const archByKey = new Map(aliceAfterDismiss.wa.items.map((item) => [item.item_key, item]));
      for (const expectedKey of [`ask:${sharedAskId}`, `todo:${aliceTodo.todo_id}`, `review:${reviewOfferId}`]) {
        const entry = archByKey.get(expectedKey);
        assert.ok(entry, `expected ${expectedKey} in Archived`);
        assert.equal(entry.outcome_kind, "dismissed");
        assert.equal(entry.outcome_text, "Dismissed");
      }

      // Bob is unaffected by Alice's dismissals!
      const bobAfterAliceDismiss = await readAs(bobId);
      assert.equal(bobAfterAliceDismiss.dq.total, 1);
      assert.equal(bobAfterAliceDismiss.dq.asks[0]!.signal_id, sharedAskId);
      assert.equal(bobAfterAliceDismiss.wa.total, 0);

      // Restore aliceTodo and reviewOfferId -> both return to Waiting on you and leave Archived
      await tx`SET LOCAL ROLE swarm_command`;
      const [rTodo1] = await tx<{ r: { status: string; restored: boolean } }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(rTodo1!.r.status, "ok");
      assert.equal(rTodo1!.r.restored, true);

      // Restoring twice is idempotent
      const [rTodo2] = await tx<{ r: { status: string; restored: boolean } }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(rTodo2!.r.status, "ok");
      assert.equal(rTodo2!.r.restored, false);

      const [rReview] = await tx<{ r: { status: string; restored: boolean } }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'review', ${reviewOfferId}::uuid) AS r
      `;
      assert.equal(rReview!.r.status, "ok");
      assert.equal(rReview!.r.restored, true);
      await tx`RESET ROLE`;

      const aliceAfterRestore = await readAs(aliceId);
      assert.equal(aliceAfterRestore.wt.total, 2);
      assert.equal(aliceAfterRestore.wsOverview.needs_you.assigned.length, 1);
      assert.equal(aliceAfterRestore.wsOverview.needs_you.waiting.length, 1);
      assert.equal(aliceAfterRestore.wa.total, 1);
      assert.equal(aliceAfterRestore.wa.items[0]!.item_key, `ask:${sharedAskId}`);

      // Dismissed-then-answered ask shows ONLY its real outcome in Archived (not 'dismissed')
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until)
        VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${sharedAskId}::uuid, 'note', 'Yes, ship it!', '9999-12-31T23:59:59Z')
      `;
      const aliceAfterRealAnswer = await readAs(aliceId);
      const sharedMatches = aliceAfterRealAnswer.wa.items.filter((i) => i.item_key === `ask:${sharedAskId}`);
      assert.equal(sharedMatches.length, 1, "dismissed-then-answered ask must appear exactly once");
      assert.equal(sharedMatches[0]!.outcome_kind, "answered");
      assert.equal(sharedMatches[0]!.outcome_text, "Yes, ship it!");

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
