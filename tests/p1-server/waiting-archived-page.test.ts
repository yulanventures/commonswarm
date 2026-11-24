/**
 * Server witness for 20261120000003_waiting_archived_and_permanence.sql:
 *   - C6 permanence: signals_until_bound permits 9999-12-31T23:59:59Z for ask/note, refuses >30d
 *     for working-on and arbitrary >30d dates for ask/note.
 *   - swarm_read.waiting_archived_page:
 *   1. Answered choice asks (single-select + multi-select with Other text -> resolved labels),
 *      answered plain-text asks (inline reply + stale close -> Cleared as stale), completed/dropped
 *      to-dos, and answered work-request reviews (TodoOfferAnswered accept/decline) all return with
 *      their exact outcome_kind, outcome_text, and archived_at timestamp. Open asks/to-dos stay out.
 *   2. Keyset pagination across 35 archived items (including microsecond ties across ask/todo/review)
 *      using millisecond-truncated client cursors: zero duplicates, zero drops, exact total.
 *   3. Private channel & direct-conversation isolation + redaction matching #694:
 *      - Removed private-channel member never sees private-channel asks; outside member sees their
 *        completed private-channel to-do redacted to placement='workspace', channel_id=NULL.
 *      - Active Gen 1 group-DM member sees authoritative conversation_id=convGroupGen1 (not Gen 2).
 *      - Departed group-DM member gets NOTHING for mapped group-DM asks (whole-row exclusion matching
 *        decision_queue / decision_queue_page: zero body, outcome, count, or cursor anchor), while
 *        still seeing their completed group-DM to-do redacted to placement='workspace' (NULL IDs).
 *   4. Authz & cursor gates: member without household_human_can_read still sees answered asks with 0
 *      to-dos/reviews; non-member and agent JWT get NULL; swarm_read/swarm_command get permission
 *      denied; half-cursor and invalid item_key raise SQLSTATE 22023.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import * as todos from "../../src/protocol/household-todos.js";
import * as todoPolicy from "../../src/protocol/household-todo-policy.js";
import * as objectPolicy from "../../src/protocol/household-object-policy.js";
import * as objects from "../../src/protocol/household-objects.js";
import * as transfers from "../../supabase/functions/command/household-transfers.js";
import { createHouseholdObjectStore, type HouseholdIdentity } from "../../supabase/functions/command/household-objects.js";
import { createHouseholdTodoStore, type HouseholdTodoNoticePort } from "../../supabase/functions/command/household-todos.js";

let sql: postgres.Sql;

function resolveDbUrl(): string {
  const fromEnv = process.env.WAITING_ARCHIVED_TEST_DB_URL ?? process.env.WAITING_TODOS_TEST_DB_URL;
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

interface ArchivedItemRow {
  item_key: string;
  kind: "ask" | "todo" | "review";
  id: string;
  todo_id: string | null;
  ask_kind: "choice" | "plain" | null;
  title: string;
  from: { kind: "agent" | "user"; id: string; name: string | null } | null;
  outcome_kind: "answered" | "cleared_stale" | "done" | "dropped" | "accepted" | "declined" | "withdrawn" | "dismissed" | "agent_removed" | "sender_left" | "channel_archived" | "expired";
  outcome_text: string;
  archived_at: string;
  answered_by: { kind: "agent" | "user"; id: string; name: string | null; by_viewer: boolean } | null;
  placement: "channel" | "general" | "dm" | "group_dm" | "workspace" | "redacted";
  channel_id: string | null;
  conversation_id: string | null;
  conversation_kind: "general" | "public_channel" | "private_channel" | "dm" | "group_dm" | null;
}

interface WaitingArchivedPagePayload {
  workspace_id: string;
  generated_at: string;
  untrusted_content: boolean;
  total: number;
  truncated: boolean;
  items: ArchivedItemRow[];
}

before(() => {
  sql = postgres(resolveDbUrl(), { prepare: false, max: 2 });
});

after(async () => {
  await sql.end();
});

const ROLLBACK_WITNESS = Symbol("rollback-waiting-archived-witness");

test("waiting_archived_page returns answered asks, completed/dropped todos, and answered reviews with pagination, isolation, and redaction", async () => {
  const viewerId = randomUUID();
  const mayaId = randomUUID();
  const noConsentId = randomUUID();
  const nonMemberId = randomUUID();
  const wsId = randomUUID();
  const scoutAgentId = randomUUID();
  const chBoiler = randomUUID();
  const chPriv = randomUUID();
  const store = makeTodoStore();
  const viewerIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: null, run_id: null, connection: null };
  const mayaIdentity: HouseholdIdentity = { user_id: mayaId, principal_id: null, run_id: null, connection: null };

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${viewerId}::uuid, ${`wa-v-${viewerId}@example.test`}),
          (${mayaId}::uuid, ${`wa-m-${mayaId}@example.test`}),
          (${noConsentId}::uuid, ${`wa-nc-${noConsentId}@example.test`}),
          (${nonMemberId}::uuid, ${`wa-nm-${nonMemberId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${viewerId}::uuid, 'ArchiveViewer'),
          (${mayaId}::uuid, 'ArchiveMaya'),
          (${noConsentId}::uuid, 'ArchiveNoConsent'),
          (${nonMemberId}::uuid, 'ArchiveOutsider')
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES (${wsId}::uuid, 'ArchiveWS', ${viewerId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'owner'),
          (${wsId}::uuid, ${mayaId}::uuid, 'member'),
          (${wsId}::uuid, ${noConsentId}::uuid, 'member')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${scoutAgentId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'Scout')
      `;
      await tx`
        INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
        VALUES (${wsId}::uuid, 'shared')
      `;
      // Grant household consent to viewerId & mayaId, NOT noConsentId.
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${mayaId}::uuid, 'editor', ${randomUUID()}::uuid, now())
      `;
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES
          (${chBoiler}::uuid, ${wsId}::uuid, 'boiler-quotes', 'open', ${viewerId}::uuid, 'user'),
          (${chPriv}::uuid, ${wsId}::uuid, 'private-vault', 'private', ${viewerId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES (${chPriv}::uuid, ${wsId}::uuid, 'user', ${viewerId}::uuid, ${viewerId}::uuid, 'user')
      `;

      // Open Group DM Gen 1 (viewer + Maya + Scout) and restarted Gen 2 (same founding members).
      const [g1Open] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${wsId}::uuid, 'user', ${viewerId}::uuid, ARRAY[${mayaId}]::uuid[], ARRAY[${scoutAgentId}]::uuid[], false
        ) AS r
      `;
      const convGroupGen1 = g1Open!.r.conversation.conversation_id;
      const [g1Meta] = await tx<{ member_key: string }[]>`
        SELECT member_key FROM swarm.conversations WHERE conversation_id = ${convGroupGen1}::uuid
      `;
      const convGroupGen2 = randomUUID();
      await tx`
        INSERT INTO swarm.conversations (
          conversation_id, workspace_id, kind, member_key, generation, created_by_kind, created_by_principal
        ) VALUES (
          ${convGroupGen2}::uuid, ${wsId}::uuid, 'group_dm', ${g1Meta!.member_key}, 1, 'user', ${viewerId}::uuid
        )
      `;
      await tx`
        INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id, member_agent_principal_id)
        VALUES
          (${convGroupGen2}::uuid, ${wsId}::uuid, ${viewerId}::uuid, NULL),
          (${convGroupGen2}::uuid, ${wsId}::uuid, ${mayaId}::uuid, NULL),
          (${convGroupGen2}::uuid, ${wsId}::uuid, NULL, ${scoutAgentId}::uuid)
      `;

      // 1. Seed answered asks:
      // - choiceAskId: multi-select choice ask in #boiler-quotes answered by viewer with ['opt_a', 'opt_b'] + other_text.
      // - plainAskId: plain-text ask in #general answered inline by viewer.
      // - staleAskId: plain-text ask in #boiler-quotes cleared as stale by viewer.
      // - openAskId: unanswered ask (MUST NOT appear in Archived!).
      // - privAskId: answered ask in #private-vault (visible to viewer, hidden from mayaId).
      // - gen1MayaAskId: ask in convGroupGen1 answered by Maya BEFORE she leaves.
      // - gen1PostLeaveAskId: ask in convGroupGen1 answered by viewer AFTER Maya leaves (MUST NOT leak to Maya!).
      // - noConsentAskId: ask addressed to noConsentId answered by noConsentId (proves asks work without household consent).
      const choiceAskId = randomUUID();
      const choiceReplyId = randomUUID();
      const plainAskId = randomUUID();
      const plainReplyId = randomUUID();
      const staleAskId = randomUUID();
      const staleReplyId = randomUUID();
      const openAskId = randomUUID();
      const privAskId = randomUUID();
      const privReplyId = randomUUID();
      const gen1MayaAskId = randomUUID();
      const gen1MayaReplyId = randomUUID();
      const gen1PostLeaveAskId = randomUUID();
      const gen1PostLeaveReplyId = randomUUID();
      const noConsentAskId = randomUUID();
      const noConsentReplyId = randomUUID();

      const tBase = Date.parse("2026-11-20T12:00:00.000Z");
      const ts = (offsetSec: number, micro = "000000") =>
        new Date(tBase + offsetSec * 1000).toISOString().replace(".000Z", `.${micro}Z`);

      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;

      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${choiceAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Which boiler options?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-300)}::timestamptz),
          (${plainAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Should we schedule Tuesday?', NULL, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-290)}::timestamptz),
          (${staleAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Old quote question?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-280)}::timestamptz),
          (${openAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Still open question?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-270)}::timestamptz),
          (${privAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Private vault ask?', ${chPriv}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-260)}::timestamptz),
          (${gen1MayaAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Gen 1 ask answered before leave?', NULL, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-250)}::timestamptz),
          (${gen1PostLeaveAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Gen 1 ask answered after leave?', NULL, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-240)}::timestamptz),
          (${noConsentAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${noConsentId}::uuid, 'ask', 'No-consent ask?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-230)}::timestamptz)
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${gen1MayaAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${gen1MayaAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1),
          (${gen1PostLeaveAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${gen1PostLeaveAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1)
      `;
      await tx`SELECT swarm.conversation_prefile(${wsId}::uuid, ${gen1MayaAskId}::uuid, ${convGroupGen1}::uuid)`;
      await tx`SELECT swarm.conversation_prefile(${wsId}::uuid, ${gen1PostLeaveAskId}::uuid, ${convGroupGen1}::uuid)`;

      await tx`
        INSERT INTO swarm.ask_choices (signal_id, workspace_id, multi, options)
        VALUES (
          ${choiceAskId}::uuid,
          ${wsId}::uuid,
          true,
          ${tx.json([
            { id: "opt_a", label: "Approve quote" },
            { id: "opt_b", label: "Book install" },
          ])}::jsonb
        )
      `;

      // Replies (answers):
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, channel_id, thread_root_id, in_reply_to, until, created_at)
        VALUES
          (${choiceReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Approve quote, Book install', ${chBoiler}::uuid, NULL, ${choiceAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(100)}::timestamptz),
          (${plainReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Yes, Tuesday at 9am works.', NULL, NULL, ${plainAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(90)}::timestamptz),
          (${staleReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Closed as stale. Re-ask with choices if still needed.', ${chBoiler}::uuid, NULL, ${staleAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(80)}::timestamptz),
          (${privReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Vault secret confirmed', ${chPriv}::uuid, NULL, ${privAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(70)}::timestamptz),
          (${gen1MayaReplyId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Maya answered before leaving', NULL, ${gen1MayaAskId}::uuid, ${gen1MayaAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(60)}::timestamptz),
          (${gen1PostLeaveReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Viewer secret post-leave answer', NULL, ${gen1PostLeaveAskId}::uuid, ${gen1PostLeaveAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(120)}::timestamptz),
          (${noConsentReplyId}::uuid, ${wsId}::uuid, ${noConsentId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Got it', ${chBoiler}::uuid, NULL, ${noConsentAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(50)}::timestamptz)
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, recipient_agent_principal_id, position)
        VALUES
          (${gen1MayaReplyId}::uuid, ${wsId}::uuid, NULL, ${scoutAgentId}::uuid, 0),
          (${gen1MayaReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, NULL, 1),
          (${gen1PostLeaveReplyId}::uuid, ${wsId}::uuid, NULL, ${scoutAgentId}::uuid, 0),
          (${gen1PostLeaveReplyId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, NULL, 1)
      `;
      await tx`
        INSERT INTO swarm.ui_actions (
          action_id, workspace_id, signal_id, actor_user_id, option_id, option_ids, other_text,
          state, reply_signal_id, created_at, completed_at
        ) VALUES (
          ${randomUUID()}::uuid, ${wsId}::uuid, ${choiceAskId}::uuid, ${viewerId}::uuid,
          'opt_a', ARRAY['opt_a', 'opt_b']::text[], 'Check warranty',
          'completed', ${choiceReplyId}::uuid, ${ts(100)}::timestamptz, ${ts(100)}::timestamptz
        )
      `;

      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      // 2. Seed completed/dropped to-dos and an answered review (offer accept/decline) via real household-todos store!
      await tx`SAVEPOINT sp_todos`;
      await tx`SET LOCAL ROLE swarm_command`;

      const doneGroupTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Book plumber from Gen 1",
        origin_placement: "group_dm",
        origin_conversation_id: convGroupGen1,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_set_state",
        todo_id: doneGroupTodo.todo_id,
        base_version: doneGroupTodo.version,
        state: "done",
      });

      const droppedBoilerTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Old quote follow-up",
        origin_placement: "channel",
        origin_channel_id: chBoiler,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_set_state",
        todo_id: droppedBoilerTodo.todo_id,
        base_version: droppedBoilerTodo.version,
        state: "dropped",
      });

      // Open to-do (MUST NOT appear in Archived!).
      const openTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Still open task",
        origin_placement: "channel",
        origin_channel_id: chBoiler,
        assign: { to: { kind: "user", id: viewerId } },
      }));

      // Private-channel completed to-do assigned to Maya (who is NOT in #private-vault) -> MUST redact to workspace/null!
      const privMayaTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Completed vault task for Maya",
        origin_placement: "channel",
        origin_channel_id: chPriv,
        assign: { to: { kind: "user", id: mayaId } },
      }));
      // Wait: assigning to another person creates an offer unless accepted! Accept it as Maya, then mark done!
      assert.ok(privMayaTodo.offer, "assigning to Maya creates an offer");
      const acceptedPrivMaya = committedTodo(await store.write(tx, wsId, mayaIdentity, `req-${randomUUID()}`, {
        kind: "household_todo_answer",
        todo_id: privMayaTodo.todo_id,
        offer_id: privMayaTodo.offer!.offer_id,
        answer: "accept",
      }));
      await store.write(tx, wsId, mayaIdentity, `req-${randomUUID()}`, {
        kind: "todo_set_state",
        todo_id: acceptedPrivMaya.todo_id,
        base_version: acceptedPrivMaya.version,
        state: "done",
      });

      // Group DM Gen 1 completed to-do for Maya -> redacted to workspace/null after she leaves Gen 1!
      const gen1MayaTodo = committedTodo(await store.write(tx, wsId, mayaIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Maya Gen 1 completed task",
        origin_placement: "group_dm",
        origin_conversation_id: convGroupGen1,
        assign: { to: { kind: "user", id: mayaId } },
      }));
      await store.write(tx, wsId, mayaIdentity, `req-${randomUUID()}`, {
        kind: "todo_set_state",
        todo_id: gen1MayaTodo.todo_id,
        base_version: gen1MayaTodo.version,
        state: "done",
      });

      // Review offer: Maya offers a #boiler-quotes to-do to viewer -> viewer declines -> appears as Archived review!
      const reviewTodo = committedTodo(await store.write(tx, wsId, mayaIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Review Scout's draft proposal",
        origin_placement: "channel",
        origin_channel_id: chBoiler,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      assert.ok(reviewTodo.offer, "Maya offering a to-do to viewer creates an offer for viewer");
      const reviewOfferId = reviewTodo.offer!.offer_id;
      await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "household_todo_answer",
        todo_id: reviewTodo.todo_id,
        offer_id: reviewOfferId,
        answer: "decline",
      });

      await tx`RELEASE SAVEPOINT sp_todos`;
      await tx`RESET ROLE`;

      // Maya leaves Group DM Gen 1 at ts(95) — AFTER gen1MayaReplyId (ts(60)), BEFORE gen1PostLeaveReplyId (ts(120))!
      // Pin joined_at to ts(-600) so left_at >= joined_at (conversation_members_check1) holds regardless of wall-clock time.
      await tx`
        UPDATE swarm.conversation_members
        SET joined_at = ${ts(-600)}::timestamptz
        WHERE conversation_id = ${convGroupGen1}::uuid
      `;
      await tx`
        UPDATE swarm.conversation_members
        SET left_at = ${ts(95)}::timestamptz
        WHERE conversation_id = ${convGroupGen1}::uuid AND member_user_id = ${mayaId}::uuid
      `;

      // Seed 26 extra done to-dos (including microsecond ties!) for viewerId to prove keyset pagination past 30.
      const tiedStamp = ts(40, "654321");
      const extraDoneIds = Array.from({ length: 26 }, () => randomUUID());
      for (let i = 0; i < extraDoneIds.length; i++) {
        const stateAt = i >= 8 && i <= 11 ? tiedStamp : ts(30 - i, String(100000 + i).padStart(6, "0"));
        await tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
            gate_kind, state_by_user, state_at, comment_count, last_seq
          ) VALUES (
            ${wsId}::uuid, ${extraDoneIds[i]!}::uuid, 1, ${`Archived extra #${i + 1}`}, '', 'done',
            ${viewerId}::uuid, ${ts(-500)}::timestamptz, ${viewerId}::uuid, ${viewerId}::uuid, ${ts(-500)}::timestamptz,
            'none', ${viewerId}::uuid, ${stateAt}::timestamptz, 0, ${500 + i}
          )
        `;
      }

      // 3. Viewer reads & keyset-paginates ALL archived items (limit 10, millisecond-truncated cursors).
      await tx`SAVEPOINT sp_viewer`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;

      const collected: ArchivedItemRow[] = [];
      let afterAt: string | null = null;
      let afterKey: string | null = null;
      let pages = 0;
      let expectedTotal = -1;
      for (;;) {
        pages += 1;
        assert.ok(pages <= 8, "pagination should converge within 5 pages");
        const pageRows: { r: WaitingArchivedPagePayload | null }[] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
          SELECT swarm_read.waiting_archived_page(
            ${wsId}::uuid,
            10,
            ${afterAt}::timestamptz,
            ${afterKey}::text
          ) AS r
        `;
        const payload = pageRows[0]?.r;
        assert.ok(payload, "authenticated member gets archived payload");
        assert.equal(payload.untrusted_content, true);
        if (expectedTotal === -1) expectedTotal = payload.total;
        assert.equal(payload.total, expectedTotal, "total stays consistent across pages");
        collected.push(...payload.items);
        if (!payload.truncated) break;
        const last = payload.items[payload.items.length - 1]!;
        // Millisecond-truncated ISO cursor (simulating JS Date serialization) + uppercase item_key check!
        afterAt = new Date(last.archived_at).toISOString();
        afterKey = last.item_key.toUpperCase();
      }

      assert.equal(collected.length, expectedTotal, "all archived rows reached with zero drops");
      assert.equal(new Set(collected.map((i) => i.item_key)).size, expectedTotal, "zero duplicates across keyset pages");
      assert.ok(pages >= 4, "35+ items at limit 10 must span at least 4 pages");

      const byKey = new Map(collected.map((i) => [i.item_key, i]));

      // Open ask & open to-do must NEVER appear in Archived.
      assert.equal(byKey.has(`ask:${openAskId}`), false, "open ask must not appear in Archived");
      assert.equal(byKey.has(`todo:${openTodo.todo_id}`), false, "open to-do must not appear in Archived");

      // Multi-select choice ask with Other text resolves labels cleanly.
      const choiceRow = byKey.get(`ask:${choiceAskId}`);
      assert.ok(choiceRow);
      assert.equal(choiceRow.kind, "ask");
      assert.equal(choiceRow.ask_kind, "choice");
      assert.equal(choiceRow.outcome_kind, "answered");
      assert.equal(choiceRow.outcome_text, "Approve quote, Book install · Check warranty");
      assert.equal(choiceRow.placement, "channel");
      assert.equal(choiceRow.channel_id, chBoiler);
      assert.equal(choiceRow.answered_by?.by_viewer, true);

      // Plain-text ask answered inline.
      const plainRow = byKey.get(`ask:${plainAskId}`);
      assert.ok(plainRow);
      assert.equal(plainRow.ask_kind, "plain");
      assert.equal(plainRow.outcome_kind, "answered");
      assert.equal(plainRow.outcome_text, "Yes, Tuesday at 9am works.");

      // Stale-cleared plain-text ask.
      const staleRow = byKey.get(`ask:${staleAskId}`);
      assert.ok(staleRow);
      assert.equal(staleRow.outcome_kind, "cleared_stale");
      assert.equal(staleRow.outcome_text, "Cleared as stale");
      assert.equal(staleRow.placement, "channel");
      assert.equal(staleRow.channel_id, chBoiler);

      // Gen 1 ask resolves to convGroupGen1 (NOT Gen 2!).
      const gen1Row = byKey.get(`ask:${gen1MayaAskId}`);
      assert.ok(gen1Row);
      assert.equal(gen1Row.placement, "group_dm");
      assert.equal(gen1Row.conversation_id, convGroupGen1);
      assert.notEqual(gen1Row.conversation_id, convGroupGen2);
      assert.equal(gen1Row.conversation_kind, "group_dm");
      assert.equal(gen1Row.outcome_text, "Maya answered before leaving");
      assert.equal(gen1Row.answered_by?.by_viewer, false);

      // Completed Gen 1 group-DM to-do.
      const doneGroupRow = byKey.get(`todo:${doneGroupTodo.todo_id}`);
      assert.ok(doneGroupRow);
      assert.equal(doneGroupRow.outcome_kind, "done");
      assert.equal(doneGroupRow.outcome_text, "Done");
      assert.equal(doneGroupRow.placement, "group_dm");
      assert.equal(doneGroupRow.conversation_id, convGroupGen1);
      assert.equal(doneGroupRow.todo_id, doneGroupTodo.todo_id);

      // Dropped #boiler-quotes to-do.
      const droppedRow = byKey.get(`todo:${droppedBoilerTodo.todo_id}`);
      assert.ok(droppedRow);
      assert.equal(droppedRow.outcome_kind, "dropped");
      assert.equal(droppedRow.outcome_text, "Dropped");
      assert.equal(droppedRow.placement, "channel");
      assert.equal(droppedRow.channel_id, chBoiler);

      // Answered review (declined offer).
      const reviewRow = byKey.get(`review:${reviewOfferId}`);
      assert.ok(reviewRow);
      assert.equal(reviewRow.kind, "review");
      assert.equal(reviewRow.todo_id, reviewTodo.todo_id);
      assert.equal(reviewRow.outcome_kind, "declined");
      assert.equal(reviewRow.outcome_text, "Declined");
      assert.equal(reviewRow.placement, "channel");
      assert.equal(reviewRow.channel_id, chBoiler);

      // Cursor validation: half-cursor & invalid item_key raise SQLSTATE 22023.
      await tx`SAVEPOINT sp_bad_cursors`;
      await assert.rejects(
        () => tx`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 10, now(), NULL)`,
        (err: { code?: string }) => err?.code === "22023",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_bad_cursors`;
      await assert.rejects(
        () => tx`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 10, now(), 'bad-key')`,
        (err: { code?: string }) => err?.code === "22023",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_bad_cursors`;
      await tx`ROLLBACK TO SAVEPOINT sp_viewer`;

      // 4. Maya (NOT in #private-vault, LEFT convGroupGen1 at ts(95)):
      //    - Never sees privAskId
      //    - Never sees gen1MayaAskId OR gen1PostLeaveAskId (whole-row exclusion for departed group DM!)
      //    - Sees privMayaTodo & gen1MayaTodo redacted to placement='workspace', channel_id=NULL, conversation_id=NULL!
      //    - Sees her accepted review on privMayaTodo redacted to placement='workspace', channel_id=NULL!
      await tx`SAVEPOINT sp_maya`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: mayaId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [mayaPage] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.ok(mayaPage?.r);
      const mayaByKey = new Map(mayaPage.r.items.map((i) => [i.item_key, i]));

      assert.equal(mayaByKey.has(`ask:${privAskId}`), false, "non-member must never see private-channel ask");
      assert.equal(
        mayaByKey.has(`ask:${gen1PostLeaveAskId}`),
        false,
        "left group member must never see ask answered after their departure",
      );
      assert.equal(
        mayaByKey.has(`ask:${gen1MayaAskId}`),
        false,
        "departed group-DM member gets whole-row exclusion on mapped group-DM asks (matching decision_queue)",
      );
      assert.equal(mayaPage.r.total, 3, "departed group-DM asks must not be counted in Maya's total");

      const mayaPrivTodo = mayaByKey.get(`todo:${privMayaTodo.todo_id}`);
      assert.ok(mayaPrivTodo, "redaction must not hide Maya's completed private-channel to-do");
      assert.equal(mayaPrivTodo.placement, "workspace");
      assert.equal(mayaPrivTodo.channel_id, null);
      assert.equal(mayaPrivTodo.conversation_id, null);

      const mayaPrivReview = mayaByKey.get(`review:${privMayaTodo.offer!.offer_id}`);
      assert.ok(mayaPrivReview, "Maya sees her accepted review redacted to workspace");
      assert.equal(mayaPrivReview.outcome_kind, "accepted");
      assert.equal(mayaPrivReview.placement, "workspace");
      assert.equal(mayaPrivReview.channel_id, null);

      const mayaGen1Todo = mayaByKey.get(`todo:${gen1MayaTodo.todo_id}`);
      assert.ok(mayaGen1Todo, "redaction must not hide Maya's completed left-group to-do");
      assert.equal(mayaGen1Todo.placement, "workspace");
      assert.equal(mayaGen1Todo.conversation_id, null);
      await tx`ROLLBACK TO SAVEPOINT sp_maya`;

      // 4b. C6 signals_until_bound CHECK proof:
      //     - ask/note accept permanent sentinel 9999-12-31T23:59:59Z AND explicit short horizons (<=30d)
      //     - ask/note reject arbitrary > 30 days
      //     - working-on rejects 9999-12-31T23:59:59Z and > 30 days
      await tx`SAVEPOINT sp_c6_check`;
      const permNoteId = randomUUID();
      const shortExplicitAskId = randomUUID();
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at)
        VALUES
          (${permNoteId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', 'note', 'Permanent note', '9999-12-31T23:59:59Z'::timestamptz, ${ts(200)}::timestamptz),
          (${shortExplicitAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', 'ask', 'Short explicit 1h ask', ${ts(200)}::timestamptz + interval '1 hour', ${ts(200)}::timestamptz)
      `;
      const [shortCheck] = await tx<{ horizon_sec: number }[]>`
        SELECT EXTRACT(EPOCH FROM (until - created_at))::int AS horizon_sec
        FROM swarm.signals WHERE id = ${shortExplicitAskId}::uuid
      `;
      assert.equal(shortCheck!.horizon_sec, 3600, "explicit short horizon on ask is stored verbatim");
      await tx`SAVEPOINT sp_c6_bad_ask`;
      await assert.rejects(
        () => tx`
          INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at)
          VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', 'ask', 'Bad 45d ask', ${ts(200)}::timestamptz + interval '45 days', ${ts(200)}::timestamptz)
        `,
        (err: { code?: string }) => err?.code === "23514",
        "ask with arbitrary >30d until must fail signals_until_bound",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_c6_bad_ask`;
      await tx`SAVEPOINT sp_c6_bad_working`;
      await assert.rejects(
        () => tx`
          INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at)
          VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', 'working-on', 'Never expires', '9999-12-31T23:59:59Z'::timestamptz, ${ts(200)}::timestamptz)
        `,
        (err: { code?: string }) => err?.code === "23514",
        "working-on with permanent sentinel must fail signals_until_bound",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_c6_bad_working`;
      await tx`ROLLBACK TO SAVEPOINT sp_c6_check`;

      // 4c. HezSec Condition 2 witness: independent canonical access check on the answer signal!
      //     A public ask whose ONLY answer lives in a different private conversation (Maya <-> Scout 1:1 DM,
      //     where viewer owns Scout — tested both while Scout is live and after Scout is revoked — OR a
      //     private channel Maya is NOT in, OR a ui_action whose reply lives in an inaccessible DM, OR an
      //     unmapped legacy reply addressed only to viewer's revoked agent) MUST NOT appear in Archived
      //     (zero text, zero row, zero count, zero cursor anchor).
      await tx`SAVEPOINT sp_answer_canonical`;
      const [dmMayaScoutOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${wsId}::uuid, 'user', ${mayaId}::uuid, ARRAY[]::uuid[], ARRAY[${scoutAgentId}]::uuid[], false
        ) AS r
      `;
      const convMayaScoutDm = dmMayaScoutOpen!.r.conversation.conversation_id;

      const crossDmAskId = randomUUID();
      const crossDmReplyId = randomUUID();
      const crossPrivAskId = randomUUID();
      const crossPrivReplyId = randomUUID();
      const crossUiAskId = randomUUID();
      const crossUiReplyId = randomUUID();
      const legacyRevokedAgentAskId = randomUUID();
      const legacyRevokedAgentReplyId = randomUUID();

      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${crossDmAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Public ask answered in Maya-Scout DM?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-220)}::timestamptz),
          (${crossPrivAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${mayaId}::uuid, 'ask', 'Public ask answered in private vault?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-215)}::timestamptz),
          (${crossUiAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Choice ask with ui_action reply in Maya-Scout DM?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-210)}::timestamptz),
          (${legacyRevokedAgentAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid, 'ask', 'Unmapped ask with unmapped reply to revoked Scout?', ${chBoiler}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(-205)}::timestamptz)
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${crossDmAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${crossDmAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1),
          (${crossPrivAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 0),
          (${crossPrivAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 1),
          (${crossUiAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${crossUiAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1),
          (${legacyRevokedAgentAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${legacyRevokedAgentAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1)
      `;
      await tx`
        INSERT INTO swarm.ask_choices (signal_id, workspace_id, multi, options)
        VALUES (
          ${crossUiAskId}::uuid,
          ${wsId}::uuid,
          false,
          ${tx.json([
            { id: "secret_opt", label: "Secret Choice Label" },
            { id: "alt_opt", label: "Alternate Option" },
          ])}::jsonb
        )
      `;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, channel_id, in_reply_to, until, created_at)
        VALUES
          (${crossDmReplyId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'SECRET_MAYA_SCOUT_DM_ANSWER', NULL, ${crossDmAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(130)}::timestamptz),
          (${crossPrivReplyId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'SECRET_VAULT_ONLY_ANSWER', ${chPriv}::uuid, ${crossPrivAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(131)}::timestamptz),
          (${crossUiReplyId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'SECRET_UI_ACTION_DM_ANSWER', NULL, ${crossUiAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(132)}::timestamptz),
          (${legacyRevokedAgentReplyId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'SECRET_LEGACY_AGENT_ONLY_ANSWER', NULL, ${legacyRevokedAgentAskId}::uuid, '9999-12-31T23:59:59Z'::timestamptz, ${ts(133)}::timestamptz)
      `;
      await tx`
        INSERT INTO swarm.ui_actions (
          action_id, workspace_id, signal_id, actor_user_id, option_id, state, reply_signal_id, created_at, completed_at
        ) VALUES (
          ${randomUUID()}::uuid, ${wsId}::uuid, ${crossUiAskId}::uuid, ${mayaId}::uuid,
          'secret_opt', 'completed', ${crossUiReplyId}::uuid, ${ts(132)}::timestamptz, ${ts(132)}::timestamptz
        )
      `;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      // Simulate a pre-Step-2b unmapped legacy reply (no conversation_signals row) addressed only to Scout.
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        DELETE FROM swarm.conversation_signals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${legacyRevokedAgentReplyId}::uuid
      `;
      await tx`SET LOCAL session_replication_role = origin`;

      // Before revoking Scout's seat (asks are NOT auto-cleared), unauthorized answers stay absent from Archived.
      await tx`SAVEPOINT sp_live_canon_check`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [viewerLivePage] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 100, NULL, NULL) AS r
      `;
      assert.ok(viewerLivePage?.r);
      const viewerLiveKeys = new Set(viewerLivePage.r.items.map((i) => i.item_key));
      assert.equal(viewerLiveKeys.has(`ask:${crossDmAskId}`), false, "live ask answered in Maya-Scout DM stays absent for viewer");
      assert.equal(viewerLiveKeys.has(`ask:${crossUiAskId}`), false, "live choice ask with DM reply stays absent for viewer");
      assert.equal(viewerLiveKeys.has(`ask:${legacyRevokedAgentAskId}`), false, "live ask with unmapped agent-only reply stays absent for viewer");
      assert.equal(viewerLiveKeys.has(`ask:${openAskId}`), false, "live open ask stays absent");
      assert.equal(viewerLivePage.r.total, expectedTotal + 1, "live viewer total includes only crossPrivAskId");
      await tx`ROLLBACK TO SAVEPOINT sp_live_canon_check`;

      // Revoke Scout's workspace seat (simulating ended canonical oversight, where legacy swarm_read.signals still admitted owner reads!).
      await tx`
        UPDATE swarm.agent_workspace_memberships
        SET revoked_at = now()
        WHERE workspace_id = ${wsId}::uuid AND principal_id = ${scoutAgentId}::uuid
      `;

      // After revoking Scout's seat, every visible ask from Scout with NO viewer-visible answer falls through
      // to the generic 'agent_removed' cleared row (indistinguishable from an unanswered ask; zero answer data).
      await tx`SAVEPOINT sp_viewer_canon_check`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [viewerCanonPage] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 100, NULL, NULL) AS r
      `;
      assert.ok(viewerCanonPage?.r);
      const viewerCanon = viewerCanonPage.r;
      const viewerCanonByKey = new Map(viewerCanon.items.map((i) => [i.item_key, i]));
      for (const clearedAskId of [openAskId, crossDmAskId, crossUiAskId, legacyRevokedAgentAskId]) {
        const matches = viewerCanon.items.filter((i) => i.item_key === `ask:${clearedAskId}`);
        assert.equal(matches.length, 1, `ask:${clearedAskId} appears once as generic agent_removed`);
        assert.equal(matches[0]!.outcome_kind, "agent_removed");
        assert.equal(matches[0]!.outcome_text, "Agent removed");
        assert.equal(matches[0]!.answered_by, null);
      }
      assert.equal(viewerCanonByKey.get(`ask:${crossPrivAskId}`)?.outcome_kind, "answered");
      const viewerCanonJson = JSON.stringify(viewerCanon);
      assert.equal(viewerCanonJson.includes("SECRET_MAYA_SCOUT_DM_ANSWER"), false);
      assert.equal(viewerCanonJson.includes("SECRET_UI_ACTION_DM_ANSWER"), false);
      assert.equal(viewerCanonJson.includes("Secret Choice Label"), false);
      assert.equal(viewerCanonJson.includes("SECRET_LEGACY_AGENT_ONLY_ANSWER"), false);
      assert.equal(
        viewerCanon.total,
        expectedTotal + 5,
        "viewer total includes crossPrivAskId (answered) plus openAskId and the 3 hidden-answer asks as generic agent_removed rows",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_viewer_canon_check`;

      // Maya (NOT in #private-vault) sees crossPrivAskId only as a generic 'agent_removed' row with zero vault answer text,
      // while she sees crossDmAskId and crossUiAskId once each as 'answered' (she is in Maya-Scout DM!).
      await tx`SAVEPOINT sp_maya_canon_check`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: mayaId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [mayaCanonPage] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 100, NULL, NULL) AS r
      `;
      assert.ok(mayaCanonPage?.r);
      const mayaCrossPriv = mayaCanonPage.r.items.filter((i) => i.item_key === `ask:${crossPrivAskId}`);
      assert.equal(mayaCrossPriv.length, 1, "Maya sees crossPrivAskId once as generic agent_removed");
      assert.equal(mayaCrossPriv[0]!.outcome_kind, "agent_removed");
      assert.equal(mayaCrossPriv[0]!.outcome_text, "Agent removed");
      assert.equal(mayaCrossPriv[0]!.answered_by, null);
      assert.equal(JSON.stringify(mayaCanonPage.r).includes("SECRET_VAULT_ONLY_ANSWER"), false);
      assert.equal(mayaCanonPage.r.items.filter((i) => i.item_key === `ask:${crossDmAskId}`).length, 1);
      assert.equal(mayaCanonPage.r.items.find((i) => i.item_key === `ask:${crossDmAskId}`)?.outcome_kind, "answered");
      assert.equal(mayaCanonPage.r.items.filter((i) => i.item_key === `ask:${crossUiAskId}`).length, 1);
      assert.equal(mayaCanonPage.r.items.find((i) => i.item_key === `ask:${crossUiAskId}`)?.outcome_kind, "answered");
      await tx`ROLLBACK TO SAVEPOINT sp_maya_canon_check`;
      await tx`ROLLBACK TO SAVEPOINT sp_answer_canonical`;

      // 5. Authz gates: noConsentId sees answered asks (1) and zero to-dos/reviews; non-member & agent get NULL;
      //    swarm_read & swarm_command are denied EXECUTE.
      await tx`SAVEPOINT sp_authz`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: noConsentId })}, true)`;
      const [noConsentRow] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(noConsentRow!.r!.total, 1);
      assert.equal(noConsentRow!.r!.items[0]!.item_key, `ask:${noConsentAskId}`);

      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: nonMemberId })}, true)`;
      const [nonMemberRow] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(nonMemberRow!.r, null);

      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId, agent_principal_id: scoutAgentId })}, true)`;
      const [agentRow] = await tx<{ r: WaitingArchivedPagePayload | null }[]>`
        SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(agentRow!.r, null);
      await tx`ROLLBACK TO SAVEPOINT sp_authz`;

      for (const role of ["swarm_read", "swarm_command"]) {
        await tx`SAVEPOINT sp_role_deny`;
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await assert.rejects(
          () => tx`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 10, NULL, NULL)`,
          /permission denied/,
        );
        await tx`ROLLBACK TO SAVEPOINT sp_role_deny`;
      }

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
