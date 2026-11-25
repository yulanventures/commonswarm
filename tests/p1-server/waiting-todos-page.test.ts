/**
 * Server witness for swarm_read.waiting_todos_page and immutable household_todos channel origin
 * (20261119000005_waiting_todos_page.sql).
 *
 * Runs inside a single rolled-back transaction so the shared local database stays clean.
 * Verifies:
 *   1. Keyset pagination past home_overview's 20-row cap (25 waiting/assigned to-dos including
 *      microsecond state_at ties and millisecond-truncated client cursors).
 *   2. Designer Sequence 1: a to-do created with origin #boiler-quotes stays in #boiler-quotes even
 *      after a later ordinary note referencing about='todo:<id>' is posted in #renovation or an
 *      addressed householdNotice arrives.
 *   3. Designer Sequence 2: a workspace-only to-do stays placement='workspace' (channel_id=NULL)
 *      even after being mentioned later in #general or a named channel.
 *   4. Write-time authz on todo_create: unauthorized private channel, foreign-workspace channel,
 *      nonexistent channel, and mismatched placement/channel_id shapes all refuse uniformly with
 *      non-oracle 'target_not_found'; DB constraints enforce tenant-pinned composite FK and shape.
 *   5. Read-time private-channel redaction: private-channel member sees placement='channel' +
 *      channel_id; workspace member outside the private channel still sees their assigned to-do
 *      with placement='workspace' + channel_id=NULL (never hides the to-do, never leaks channel_id),
 *      and todo_read never leaks origin_channel_id either.
 *   6. Immutability across updates (todo_update / todo_set_state) and deterministic event replay.
 *   7. Authz gates: household_human_can_read, non-member, agent JWT, invalid half-cursor.
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
  const fromEnv = process.env.WAITING_TODOS_TEST_DB_URL;
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
    INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,to_user_id,to_agent_principal_id,about,kind,body,until,sender_lifecycle_epoch)
    VALUES (
      ${signal}::uuid,${workspace}::uuid,${identity.principal_id ?? identity.user_id}::uuid,
      ${identity.principal_id ? "agent" : "user"},
      ${first.kind === "user" ? first.id : null}::uuid,${first.kind === "agent" ? first.id : null}::uuid,
      ${intent.about},${intent.kind},${intent.body},statement_timestamp()+interval '1 day',
      ${identity.principal_id && intent.kind === "ask" ? 1 : null}::bigint
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

interface WaitingTodoRow {
  todo_id: string;
  title: string;
  state: "open" | "doing";
  due_on: string | null;
  reason: "assigned" | "request" | "after" | "hold" | "agent_removed";
  agent_id: string | null;
  state_at: string;
  placement: "channel" | "general" | "workspace" | "dm" | "group_dm";
  channel_id: string | null;
  conversation_id: string | null;
}

interface WaitingTodosPagePayload {
  workspace_id: string;
  generated_at: string;
  total: number;
  truncated: boolean;
  todos: WaitingTodoRow[];
}

const ROLLBACK_WITNESS = Symbol("rollback-waiting-todos-witness");

test("waiting_todos_page paginates past 20, preserves stable channel origin across later discussions/updates, and enforces write/read authz", async () => {
  const viewerId = randomUUID();
  const memberNoConsentId = randomUUID();
  const memberOutsidePrivId = randomUUID();
  const nonMemberId = randomUUID();
  const wsId = randomUUID();
  const foreignWsId = randomUUID();
  const chBoiler = randomUUID();
  const chReno = randomUUID();
  const chPriv = randomUUID();
  const chForeign = randomUUID();
  const store = makeTodoStore();
  const viewerIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: null, run_id: null, connection: null };
  const outsiderIdentity: HouseholdIdentity = { user_id: memberOutsidePrivId, principal_id: null, run_id: null, connection: null };

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${viewerId}::uuid, ${`wt-v-${viewerId}@example.test`}),
          (${memberNoConsentId}::uuid, ${`wt-nc-${memberNoConsentId}@example.test`}),
          (${memberOutsidePrivId}::uuid, ${`wt-op-${memberOutsidePrivId}@example.test`}),
          (${nonMemberId}::uuid, ${`wt-nm-${nonMemberId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${viewerId}::uuid, 'WTViewer'),
          (${memberNoConsentId}::uuid, 'WTNoConsent'),
          (${memberOutsidePrivId}::uuid, 'WTOutsidePriv'),
          (${nonMemberId}::uuid, 'WTNonMember')
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES
          (${wsId}::uuid, 'WaitingTodosWS', ${viewerId}::uuid),
          (${foreignWsId}::uuid, 'ForeignTodosWS', ${nonMemberId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'owner'),
          (${wsId}::uuid, ${memberNoConsentId}::uuid, 'member'),
          (${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'member'),
          (${foreignWsId}::uuid, ${nonMemberId}::uuid, 'owner')
      `;
      // Grant household content read/write access to viewerId and memberOutsidePrivId, NOT memberNoConsentId.
      await tx`
        INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
        VALUES (${wsId}::uuid, 'shared'), (${foreignWsId}::uuid, 'shared')
      `;
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${foreignWsId}::uuid, ${nonMemberId}::uuid, 'editor', ${randomUUID()}::uuid, now())
      `;

      // Channels: two open channels + one private channel (viewerId only) + one foreign-workspace channel.
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES
          (${chBoiler}::uuid, ${wsId}::uuid, 'boiler-quotes', 'open', ${viewerId}::uuid, 'user'),
          (${chReno}::uuid, ${wsId}::uuid, 'renovation', 'open', ${viewerId}::uuid, 'user'),
          (${chPriv}::uuid, ${wsId}::uuid, 'private-vault', 'private', ${viewerId}::uuid, 'user'),
          (${chForeign}::uuid, ${foreignWsId}::uuid, 'foreign-ch', 'open', ${nonMemberId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES (${chPriv}::uuid, ${wsId}::uuid, 'user', ${viewerId}::uuid, ${viewerId}::uuid, 'user')
      `;

      // 1. Write-time authz on todo_create via real household-todos store (running as swarm_command).
      await tx`SAVEPOINT sp_write_authz`;
      await tx`SET LOCAL ROLE swarm_command`;

      // Unauthorized private channel, foreign-workspace channel, nonexistent channel, and mismatched shapes all refuse uniformly.
      const refusedCreates: Array<{ label: string; who: HouseholdIdentity; cmd: todos.TodoCommand }> = [
        {
          label: "outsider private channel",
          who: outsiderIdentity,
          cmd: { kind: "todo_create", title: "Sneaky private", origin_placement: "channel", origin_channel_id: chPriv },
        },
        {
          label: "foreign workspace channel",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Cross-tenant channel", origin_placement: "channel", origin_channel_id: chForeign },
        },
        {
          label: "nonexistent channel",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Missing channel", origin_placement: "channel", origin_channel_id: randomUUID() },
        },
        {
          label: "mismatched general + channel_id",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Bad general shape", origin_placement: "general", origin_channel_id: chBoiler },
        },
        {
          label: "mismatched channel + null channel_id",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Bad channel shape", origin_placement: "channel", origin_channel_id: null },
        },
      ];
      for (const entry of refusedCreates) {
        const res = await store.write(tx, wsId, entry.who, `req-${randomUUID()}`, entry.cmd);
        assert.deepEqual(
          res.outcome,
          { status: "refused", reason: "target_not_found" },
          `expected uniform non-oracle refusal for ${entry.label}`,
        );
      }

      // Create authoritative to-dos via real todo_create:
      // - boilerTodo: origin #boiler-quotes, assigned to viewer
      // - renoTodo: origin #renovation, assigned to viewer
      // - generalTodo: origin #general, assigned to viewer
      // - workspaceTodo: default workspace-only, assigned to viewer
      // - privViewerTodo: origin #private-vault, assigned to viewer
      // - privOutsiderTodo: origin #private-vault, assigned to memberOutsidePrivId
      const boilerTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Boiler channel task",
        due_on: "2026-11-22",
        origin_placement: "channel",
        origin_channel_id: chBoiler,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      const renoTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Renovation channel task",
        origin_placement: "channel",
        origin_channel_id: chReno,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      const generalTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "General channel task",
        origin_placement: "general",
        assign: { to: { kind: "user", id: viewerId } },
      }));
      const workspaceTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Workspace-only task",
        assign: { to: { kind: "user", id: viewerId } },
      }));
      const privViewerTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Private vault viewer task",
        origin_placement: "channel",
        origin_channel_id: chPriv,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      const privOutsiderCreateReqId = `req-${randomUUID()}`;
      const privOutsiderCreateCmd: todos.TodoCommand = {
        kind: "todo_create",
        title: "Outsider private-channel task",
        origin_placement: "channel",
        origin_channel_id: chPriv,
        assign: { to: { kind: "user", id: memberOutsidePrivId } },
      };
      const privOutsiderTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, privOutsiderCreateReqId, privOutsiderCreateCmd));

      // C1: Every client-visible write outcome strips origin_placement and origin_channel_id (create, update, conflict, replay).
      for (const written of [boilerTodo, renoTodo, generalTodo, workspaceTodo, privViewerTodo, privOutsiderTodo]) {
        assert.equal("origin_channel_id" in written, false, "todo_create outcome must strip origin_channel_id");
        assert.equal("origin_placement" in written, false, "todo_create outcome must strip origin_placement");
      }

      // Immutability across updates: update boilerTodo title and move to 'doing'.
      const updatedBoiler = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: boilerTodo.todo_id,
        base_version: boilerTodo.version,
        title: "Boiler channel task (updated)",
      }));
      assert.equal("origin_channel_id" in updatedBoiler, false, "todo_update outcome must strip origin_channel_id");
      const doingBoiler = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_set_state",
        todo_id: boilerTodo.todo_id,
        base_version: updatedBoiler.version,
        state: "doing",
      }));
      assert.equal("origin_channel_id" in doingBoiler, false, "todo_set_state outcome must strip origin_channel_id");

      // C1 witness: authorized to-do editor outside #private-vault gets redacted conflict, pending-offer freeze (#742 C3),
      // and redacted committed write responses after accepting the offer.
      const outsiderConflict = await store.write(tx, wsId, outsiderIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: privOutsiderTodo.todo_id,
        base_version: 99,
        title: "Stale edit",
      });
      assert.equal(outsiderConflict.outcome.status, "conflict");
      if (outsiderConflict.outcome.status === "conflict") {
        assert.equal("origin_channel_id" in outsiderConflict.outcome.current, false, "conflict current must not leak private origin_channel_id");
        assert.equal("origin_placement" in outsiderConflict.outcome.current, false, "conflict current must not leak private origin_placement");
      }
      const outsiderFrozen = await store.write(tx, wsId, outsiderIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: privOutsiderTodo.todo_id,
        base_version: privOutsiderTodo.version,
        title: "Edit while offer pending",
      });
      assert.deepEqual(
        outsiderFrozen.outcome,
        { status: "refused", reason: "offer_pending_frozen" },
        "todo_update while a pending offer exists must refuse offer_pending_frozen (#742 Condition 3)",
      );
      await tx`SAVEPOINT sp_outsider_edit_after_accept`;
      assert.ok(privOutsiderTodo.offer, "assigning to another user creates a pending offer");
      const outsiderAccepted = committedTodo(await store.write(tx, wsId, outsiderIdentity, `req-${randomUUID()}`, {
        kind: "household_todo_answer",
        todo_id: privOutsiderTodo.todo_id,
        offer_id: privOutsiderTodo.offer.offer_id,
        base_version: privOutsiderTodo.version,
        answer: "accept",
      }));
      assert.equal("origin_channel_id" in outsiderAccepted, false, "outsider offer accept must not leak private origin_channel_id");
      assert.equal("origin_placement" in outsiderAccepted, false, "outsider offer accept must not leak private origin_placement");
      const outsiderCommit = committedTodo(await store.write(tx, wsId, outsiderIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: privOutsiderTodo.todo_id,
        base_version: outsiderAccepted.version,
        title: "Outsider private-channel task (edited)",
      }));
      assert.equal("origin_channel_id" in outsiderCommit, false, "outsider successful write must not leak private origin_channel_id");
      assert.equal("origin_placement" in outsiderCommit, false, "outsider successful write must not leak private origin_placement");
      await tx`ROLLBACK TO SAVEPOINT sp_outsider_edit_after_accept`;
      await tx`SET LOCAL ROLE swarm_command`;

      // C1 witness: replay after the original caller loses channel access never leaks private origin_channel_id.
      await tx`SAVEPOINT sp_replay_after_channel_removal`;
      await tx`RESET ROLE`;
      await tx`DELETE FROM swarm.channel_members WHERE channel_id = ${chPriv}::uuid AND user_id = ${viewerId}::uuid`;
      await tx`SET LOCAL ROLE swarm_command`;
      const replayedCreate = await store.write(tx, wsId, viewerIdentity, privOutsiderCreateReqId, privOutsiderCreateCmd);
      assert.equal(replayedCreate.replayed, true);
      const replayedVal = committedTodo(replayedCreate);
      assert.equal("origin_channel_id" in replayedVal, false, "replayed create after channel removal must not leak origin_channel_id");
      assert.equal("origin_placement" in replayedVal, false, "replayed create after channel removal must not leak origin_placement");
      await tx`ROLLBACK TO SAVEPOINT sp_replay_after_channel_removal`;
      await tx`SET LOCAL ROLE swarm_command`;

      // Verify todo_read for outsider does NOT leak origin_channel_id.
      const outsiderRead = await store.read(tx, wsId, outsiderIdentity, {
        kind: "todo_read",
        todo_id: privOutsiderTodo.todo_id,
      }) as { status?: string; todo?: Record<string, unknown> };
      assert.ok(outsiderRead.todo, "outsider can read their assigned to-do");
      assert.equal("origin_channel_id" in outsiderRead.todo, false, "todo_read must not expose private origin_channel_id");
      assert.equal("origin_placement" in outsiderRead.todo, false, "todo_read must not expose private origin_placement");

      // Deterministic event replay check on persisted household_todo_events.
      const eventRows = await tx<{ event: todos.TodoEvent }[]>`
        SELECT event FROM swarm.household_todo_events
        WHERE workspace_id = ${wsId}::uuid
        ORDER BY seq ASC
      `;
      const [streamRow] = await tx<{ stream_id: string }[]>`
        SELECT stream_id FROM swarm.household_todo_streams WHERE workspace_id = ${wsId}::uuid
      `;
      const replayed = todos.reduceTodoEvents(
        todos.emptyHouseholdTodoState(wsId, String(streamRow!.stream_id)),
        eventRows.map((r) => r.event),
      );
      assert.equal(replayed.todos[boilerTodo.todo_id]!.origin_placement, "channel");
      assert.equal(replayed.todos[boilerTodo.todo_id]!.origin_channel_id, chBoiler);
      assert.equal(replayed.todos[boilerTodo.todo_id]!.title, "Boiler channel task (updated)");
      assert.equal(replayed.todos[privOutsiderTodo.todo_id]!.origin_placement, "channel");
      assert.equal(replayed.todos[privOutsiderTodo.todo_id]!.origin_channel_id, chPriv);
      assert.equal(replayed.todos[workspaceTodo.todo_id]!.origin_placement, "workspace");
      assert.equal(replayed.todos[workspaceTodo.todo_id]!.origin_channel_id, null);

      // C2 witness: pre-migration TodoCreated event (no origin keys) + post-migration DB update replays cleanly from seq 0.
      await tx`SAVEPOINT sp_legacy_migration_replay`;
      const legacyWsId = randomUUID();
      const legacyStreamId = randomUUID();
      const legacyTodoId = randomUUID();
      const legacyCreatedAt = "2026-11-18T12:00:00.000Z";
      const legacyTodoPayload = {
        workspace_id: legacyWsId, todo_id: legacyTodoId, version: 1, title: "Pre-migration task", notes: "", due_on: null,
        state: "open", created_by: { user_id: viewerId, principal_id: null }, created_at: legacyCreatedAt,
        assignee: null, assigned_by: null, assigned_at: null, offer: null, gate: { kind: "none" }, gate_set_by: null,
        queue_rank: null, state_by: { user_id: viewerId, principal_id: null }, state_at: legacyCreatedAt, comment_count: 0,
      };
      const legacyCreatedEvent = {
        type: "TodoCreated", workspace_id: legacyWsId, stream_id: legacyStreamId, seq: 0,
        event_id: randomUUID(), command_id: "legacy-create-0", schema_version: 1,
        actor_user: viewerId, actor_agent_principal: null, actor_run: null,
        occurred_at_server: Date.parse(legacyCreatedAt),
        payload: { todo: legacyTodoPayload },
      };
      await tx`RESET ROLE`;
      await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${legacyWsId}::uuid, 'LegacyReplayWS', ${viewerId}::uuid)`;
      await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${legacyWsId}::uuid, ${viewerId}::uuid, 'owner')`;
      await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose) VALUES (${legacyWsId}::uuid, 'shared')`;
      await tx`INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at) VALUES (${legacyWsId}::uuid, ${viewerId}::uuid, 'editor', ${randomUUID()}::uuid, now())`;
      await tx`INSERT INTO swarm.household_todo_streams (workspace_id, stream_id, last_seq) VALUES (${legacyWsId}::uuid, ${legacyStreamId}::uuid, 0)`;
      await tx`INSERT INTO swarm.household_todo_events (workspace_id, seq, event_id, occurred_at, event) VALUES (${legacyWsId}::uuid, 0, ${legacyCreatedEvent.event_id}::uuid, ${legacyCreatedAt}::timestamptz, ${tx.json(legacyCreatedEvent)}::jsonb)`;
      // Projection row hydrated with migration DEFAULT 'workspace' / NULL.
      await tx`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, title, notes, state,
          created_by_user, created_at, gate_kind, state_by_user, state_at, comment_count, last_seq
        ) VALUES (
          ${legacyWsId}::uuid, ${legacyTodoId}::uuid, 1, 'Pre-migration task', '', 'open',
          ${viewerId}::uuid, ${legacyCreatedAt}::timestamptz, 'none', ${viewerId}::uuid, ${legacyCreatedAt}::timestamptz, 0, 0
        )
      `;
      await tx`SET LOCAL ROLE swarm_command`;
      const migratedEdit = committedTodo(await store.write(tx, legacyWsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: legacyTodoId,
        base_version: 1,
        title: "Post-migration edited task",
      }));
      assert.equal(migratedEdit.title, "Post-migration edited task");
      const legacyEvents = await tx<{ event: todos.TodoEvent }[]>`
        SELECT event FROM swarm.household_todo_events WHERE workspace_id = ${legacyWsId}::uuid ORDER BY seq ASC
      `;
      const legacyReplayed = todos.reduceTodoEvents(
        todos.emptyHouseholdTodoState(legacyWsId, legacyStreamId),
        legacyEvents.map((r) => r.event),
      );
      assert.equal(legacyReplayed.todos[legacyTodoId]!.title, "Post-migration edited task");
      assert.equal(legacyReplayed.todos[legacyTodoId]!.origin_placement, "workspace");
      assert.equal(legacyReplayed.todos[legacyTodoId]!.origin_channel_id, null);
      await tx`ROLLBACK TO SAVEPOINT sp_legacy_migration_replay`;
      await tx`SET LOCAL ROLE swarm_command`;

      await tx`RELEASE SAVEPOINT sp_write_authz`;
      await tx`RESET ROLE`;

      // Verify DB-level tenant-pinned FK (23503) and shape CHECK (23514).
      await tx`SAVEPOINT sp_db_constraints`;
      await assert.rejects(
        () => tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, gate_kind, state_by_user, state_at, comment_count, last_seq,
            origin_placement, origin_channel_id
          ) VALUES (
            ${wsId}::uuid, ${randomUUID()}::uuid, 1, 'Cross-tenant FK', '', 'open',
            ${viewerId}::uuid, now(), 'none', ${viewerId}::uuid, now(), 0, 999,
            'channel', ${chForeign}::uuid
          )
        `,
        (err: { code?: string }) => err?.code === "23503",
        "tenant-pinned composite FK must reject foreign workspace origin_channel_id",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_db_constraints`;
      await assert.rejects(
        () => tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, gate_kind, state_by_user, state_at, comment_count, last_seq,
            origin_placement, origin_channel_id
          ) VALUES (
            ${wsId}::uuid, ${randomUUID()}::uuid, 1, 'Bad shape', '', 'open',
            ${viewerId}::uuid, now(), 'none', ${viewerId}::uuid, now(), 0, 999,
            'workspace', ${chBoiler}::uuid
          )
        `,
        (err: { code?: string }) => err?.code === "23514",
        "CHECK constraint must reject workspace origin with non-null origin_channel_id",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_db_constraints`;

      // Seed 20 more open to-dos (total = 25 for viewerId, including microsecond ties) + 1 done to-do.
      const extraTodoIds = Array.from({ length: 20 }, () => randomUUID());
      const doneTodoId = randomUUID();
      const tiedStamp = "2026-11-19T12:00:00.123456Z";
      for (let i = 0; i < extraTodoIds.length; i++) {
        const id = extraTodoIds[i]!;
        const stateAt = i >= 13 && i <= 16
          ? tiedStamp
          : new Date(Date.parse("2026-11-19T12:00:00.000Z") + (20 - i) * 1000).toISOString().replace(".000Z", `.${String(100000 + i).padStart(6, "0")}Z`);
        await tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
            gate_kind, state_by_user, state_at, comment_count, last_seq
          ) VALUES (
            ${wsId}::uuid, ${id}::uuid, 1, ${`Extra waiting todo #${i + 1}`}, '', 'open',
            ${viewerId}::uuid, now(), ${viewerId}::uuid, ${viewerId}::uuid, now(),
            'none', ${viewerId}::uuid, ${stateAt}::timestamptz, 0, ${100 + i}
          )
        `;
      }
      await tx`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, title, notes, state,
          created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
          gate_kind, state_by_user, state_at, comment_count, last_seq
        ) VALUES (
          ${wsId}::uuid, ${doneTodoId}::uuid, 1, 'Already completed', '', 'done',
          ${viewerId}::uuid, now(), ${viewerId}::uuid, ${viewerId}::uuid, now(),
          'none', ${viewerId}::uuid, now(), 0, 200
        )
      `;

      // Post ordinary chat notes AFTER creation to test Designer's two exact sequences:
      // - Sequence 1: boilerTodo gets an ordinary note in #boiler-quotes, then a LATER ordinary note in #renovation,
      //               plus a later addressed householdNotice -> MUST stay #boiler-quotes!
      // - Sequence 2: workspaceTodo gets mentioned in an ordinary unaddressed note in #general AND in #boiler-quotes
      //               -> MUST stay placement='workspace', channel_id=NULL!
      // - generalTodo gets mentioned later in #renovation -> MUST stay placement='general', channel_id=NULL!
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, about, channel_id, until, created_at)
        VALUES
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Original boiler discussion', ${`todo:${boilerTodo.todo_id}`}, ${chBoiler}::uuid, now() + interval '7 days', now() - interval '10 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Later update posted in renovation', ${`todo:${boilerTodo.todo_id}`}, ${chReno}::uuid, now() + interval '7 days', now() - interval '2 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'user', ${viewerId}::uuid, 'ask', 'Asks you to take a to-do.', ${`todo:${boilerTodo.todo_id}`}, NULL, now() + interval '7 days', now() - interval '1 minute'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Mentioning workspace task in general', ${`todo:${workspaceTodo.todo_id}`}, NULL, now() + interval '7 days', now() - interval '5 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Mentioning workspace task in boiler', ${`todo:${workspaceTodo.todo_id}`}, ${chBoiler}::uuid, now() + interval '7 days', now() - interval '4 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Mentioning general task in renovation', ${`todo:${generalTodo.todo_id}`}, ${chReno}::uuid, now() + interval '7 days', now() - interval '3 minutes')
      `;

      // 2. Keyset paginate all 25 to-dos for viewerId (page size 10, millisecond-truncated cursors).
      await tx`SAVEPOINT sp_viewer`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;

      const collected: WaitingTodoRow[] = [];
      let afterStateAt: string | null = null;
      let afterTodoId: string | null = null;
      let pages = 0;
      for (;;) {
        pages += 1;
        assert.ok(pages <= 5, "pagination loop should finish in 3 pages for 25 rows at limit 10");
        const pageRows: { r: WaitingTodosPagePayload | null }[] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
          SELECT swarm_read.waiting_todos_page(
            ${wsId}::uuid,
            10,
            ${afterStateAt}::timestamptz,
            ${afterTodoId}::uuid
          ) AS r
        `;
        const row = pageRows[0];
        assert.ok(row?.r, "authenticated member with read access gets payload");
        assert.equal(row.r.total, 25, "exact total must reflect all 25 open/doing waiting to-dos");
        collected.push(...row.r.todos);
        if (!row.r.truncated) break;
        const last = row.r.todos[row.r.todos.length - 1]!;
        afterStateAt = new Date(last.state_at).toISOString();
        afterTodoId = last.todo_id;
      }

      assert.equal(pages, 3, "25 to-dos at limit 10 must paginate cleanly in 3 pages (10 + 10 + 5)");
      assert.equal(collected.length, 25, "all 25 to-dos including items 21-25 must be reached");
      const uniqueIds = new Set(collected.map((t) => t.todo_id));
      assert.equal(uniqueIds.size, 25, "no duplicate to-dos across keyset pages");
      assert.equal(uniqueIds.has(doneTodoId), false, "done to-do must not be returned");

      const byId = new Map(collected.map((t) => [t.todo_id, t]));
      assert.deepEqual(
        { placement: byId.get(boilerTodo.todo_id)!.placement, channel_id: byId.get(boilerTodo.todo_id)!.channel_id },
        { placement: "channel", channel_id: chBoiler },
        "Designer Sequence 1: later note in #renovation and updates must NOT move #boiler-quotes origin",
      );
      assert.equal(byId.get(boilerTodo.todo_id)!.title, "Boiler channel task (updated)");
      assert.equal(byId.get(boilerTodo.todo_id)!.state, "doing");

      assert.deepEqual(
        { placement: byId.get(renoTodo.todo_id)!.placement, channel_id: byId.get(renoTodo.todo_id)!.channel_id },
        { placement: "channel", channel_id: chReno },
      );
      assert.deepEqual(
        { placement: byId.get(generalTodo.todo_id)!.placement, channel_id: byId.get(generalTodo.todo_id)!.channel_id },
        { placement: "general", channel_id: null },
        "later note in #renovation must NOT move #general origin",
      );
      assert.deepEqual(
        { placement: byId.get(workspaceTodo.todo_id)!.placement, channel_id: byId.get(workspaceTodo.todo_id)!.channel_id },
        { placement: "workspace", channel_id: null },
        "Designer Sequence 2: later mention in #general or #boiler-quotes must NOT promote workspace-only task",
      );
      assert.deepEqual(
        { placement: byId.get(privViewerTodo.todo_id)!.placement, channel_id: byId.get(privViewerTodo.todo_id)!.channel_id },
        { placement: "channel", channel_id: chPriv },
        "private-channel member sees private channel origin",
      );

      // Half-cursor must raise SQLSTATE 22023.
      await tx`SAVEPOINT sp_bad_cursor`;
      await assert.rejects(
        () => tx`SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 10, now(), NULL)`,
        (err: { code?: string }) => err?.code === "22023",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_bad_cursor`;
      await tx`ROLLBACK TO SAVEPOINT sp_viewer`;

      // 3. Private-channel read redaction: member outside chPriv sees their assigned to-do, redacted to workspace/NULL!
      await tx`SAVEPOINT sp_outside_priv`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: memberOutsidePrivId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [outsideRow] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(outsideRow!.r!.total, 1, "redaction must never hide an assigned/waiting to-do");
      assert.equal(outsideRow!.r!.todos[0]!.todo_id, privOutsiderTodo.todo_id);
      assert.equal(outsideRow!.r!.todos[0]!.placement, "workspace", "private channel must redact to workspace for non-member");
      assert.equal(outsideRow!.r!.todos[0]!.channel_id, null, "private channel_id must stay null for non-member");
      await tx`ROLLBACK TO SAVEPOINT sp_outside_priv`;

      // 4. Authz gates: member without household_human_can_read gets empty list; non-member & agent get NULL.
      await tx`SAVEPOINT sp_authz`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: memberNoConsentId })}, true)`;
      const [noConsentRow] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(noConsentRow!.r!.total, 0);
      assert.deepEqual(noConsentRow!.r!.todos, []);

      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: nonMemberId })}, true)`;
      const [nonMemberRow] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(nonMemberRow!.r, null);

      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId, agent_principal_id: randomUUID() })}, true)`;
      const [agentRow] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(agentRow!.r, null);
      await tx`ROLLBACK TO SAVEPOINT sp_authz`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

interface DecisionQueueAskRow {
  signal_id: string;
  body: string;
  created_at: string;
  conversation_id: string | null;
  conversation_kind: "general" | "public_channel" | "private_channel" | "dm" | "group_dm" | null;
}

interface DecisionQueuePayload {
  workspace_id: string;
  total: number;
  truncated: boolean;
  asks: DecisionQueueAskRow[];
}

test("20261120000002: dm/group_dm to-do origin authz & redaction and authoritative decision_queue conversation_id across restarted groups", async () => {
  const viewerId = randomUUID();
  const mayaId = randomUUID();
  const outsiderId = randomUUID();
  const nonMemberId = randomUUID();
  const wsId = randomUUID();
  const foreignWsId = randomUUID();
  const scoutAgentId = randomUUID();
  const store = makeTodoStore();
  const viewerIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: null, run_id: null, connection: null };
  const mayaIdentity: HouseholdIdentity = { user_id: mayaId, principal_id: null, run_id: null, connection: null };
  const outsiderIdentity: HouseholdIdentity = { user_id: outsiderId, principal_id: null, run_id: null, connection: null };

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${viewerId}::uuid, ${`dm-v-${viewerId}@example.test`}),
          (${mayaId}::uuid, ${`dm-m-${mayaId}@example.test`}),
          (${outsiderId}::uuid, ${`dm-o-${outsiderId}@example.test`}),
          (${nonMemberId}::uuid, ${`dm-nm-${nonMemberId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${viewerId}::uuid, 'DMViewer'),
          (${mayaId}::uuid, 'DMMaya'),
          (${outsiderId}::uuid, 'DMOutsider'),
          (${nonMemberId}::uuid, 'DMNonMember')
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES
          (${wsId}::uuid, 'DMConvWS', ${viewerId}::uuid),
          (${foreignWsId}::uuid, 'DMForeignWS', ${nonMemberId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'owner'),
          (${wsId}::uuid, ${mayaId}::uuid, 'member'),
          (${wsId}::uuid, ${outsiderId}::uuid, 'member'),
          (${foreignWsId}::uuid, ${nonMemberId}::uuid, 'owner')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES (${scoutAgentId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'Scout', 'hosted_mcp', true)
      `;
      const unseatedAgentId = randomUUID();
      const revokedSeatAgentId = randomUUID();
      const seatedNonMemberAgentId = randomUUID();
      // agent_principals_sync_workspace_membership automatically creates live seats for all inserted
      // principals (scoutAgentId, seatedNonMemberAgentId, etc.); remove unseatedAgentId's seat row
      // (matching join-credential registrar state) and revoke revokedSeatAgentId's seat.
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES
          (${unseatedAgentId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'UnseatedAgent', 'hosted_mcp', true),
          (${revokedSeatAgentId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'RevokedSeatAgent', 'hosted_mcp', true),
          (${seatedNonMemberAgentId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'SeatedNonMember', 'hosted_mcp', true)
      `;
      await tx`
        DELETE FROM swarm.agent_workspace_memberships
        WHERE principal_id = ${unseatedAgentId}::uuid AND workspace_id = ${wsId}::uuid
      `;
      await tx`
        UPDATE swarm.agent_workspace_memberships
        SET revoked_at = now()
        WHERE principal_id = ${revokedSeatAgentId}::uuid AND workspace_id = ${wsId}::uuid
      `;
      await tx`
        INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
        VALUES (${wsId}::uuid, 'shared'), (${foreignWsId}::uuid, 'shared')
      `;
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${mayaId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${outsiderId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${foreignWsId}::uuid, ${nonMemberId}::uuid, 'editor', ${randomUUID()}::uuid, now())
      `;

      // Open 1:1 DM (viewer + Scout), Group DM Gen 1 (viewer + Maya + Scout), and restarted Gen 2 (same member set).
      const [dmOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${wsId}::uuid, 'user', ${viewerId}::uuid, '{}'::uuid[], ARRAY[${scoutAgentId}]::uuid[], false
        ) AS r
      `;
      const [g1Open] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${wsId}::uuid, 'user', ${viewerId}::uuid, ARRAY[${mayaId}]::uuid[], ARRAY[${scoutAgentId}]::uuid[], false
        ) AS r
      `;
      // Have Maya leave temporarily to allow starting a fresh generation (Gen 2) with the same founding members,
      // OR insert Gen 2 directly via conversation_open(..., new_group => true) after Maya leaves a dummy group —
      // even cleaner: use conversation_open(..., new_group => true) after a second group member set or direct generation=1 row.
      const convDmScout = dmOpen!.r.conversation.conversation_id;
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
      const [foreignDmOpen] = await tx<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${foreignWsId}::uuid, 'user', ${nonMemberId}::uuid, ARRAY[${nonMemberId}]::uuid[], '{}'::uuid[], false
        ) AS r
      `;
      const convForeignDm = foreignDmOpen!.r.conversation.conversation_id;

      // Post an open ask from Scout explicitly filed into Gen 1 (while Gen 2 also exists with identical members).
      const gen1AskId = randomUUID();
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (
          id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, created_at, sender_lifecycle_epoch
        ) VALUES (
          ${gen1AskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid,
          'ask', 'Gen 1 group ask: approve boiler?', statement_timestamp() + interval '1 day', statement_timestamp(), 1
        )
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${gen1AskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${gen1AskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1)
      `;
      await tx`SELECT swarm.conversation_prefile(${wsId}::uuid, ${gen1AskId}::uuid, ${convGroupGen1}::uuid)`;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      // Add unseatedAgentId and revokedSeatAgentId as conversation_members of convGroupGen1 to test
      // Condition 2: live, owner-matched workspace seat is strictly required (no registrar fallback!).
      await tx`
        INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id, member_agent_principal_id)
        VALUES
          (${convGroupGen1}::uuid, ${wsId}::uuid, NULL, ${unseatedAgentId}::uuid),
          (${convGroupGen1}::uuid, ${wsId}::uuid, NULL, ${revokedSeatAgentId}::uuid)
      `;
      await tx`SAVEPOINT sp_agent_seat_gate`;
      await tx`SET LOCAL ROLE swarm_command`;
      const [seatCheck] = await tx<{ seated: boolean; unseated: boolean; revoked: boolean; seated_outsider: boolean }[]>`
        SELECT
          swarm.actor_can_access_direct_conversation(${wsId}::uuid, ${convGroupGen1}::uuid, 'group_dm', 'agent', ${scoutAgentId}::uuid) AS seated,
          swarm.actor_can_access_direct_conversation(${wsId}::uuid, ${convGroupGen1}::uuid, 'group_dm', 'agent', ${unseatedAgentId}::uuid) AS unseated,
          swarm.actor_can_access_direct_conversation(${wsId}::uuid, ${convGroupGen1}::uuid, 'group_dm', 'agent', ${revokedSeatAgentId}::uuid) AS revoked,
          swarm.actor_can_access_direct_conversation(${wsId}::uuid, ${convGroupGen1}::uuid, 'group_dm', 'agent', ${seatedNonMemberAgentId}::uuid) AS seated_outsider
      `;
      assert.equal(seatCheck!.seated, true, "seated live agent member must be admitted");
      assert.equal(seatCheck!.unseated, false, "unseated agent (registrar workspace only, absent seat) must be refused");
      assert.equal(seatCheck!.revoked, false, "revoked-seat agent must be refused");
      assert.equal(seatCheck!.seated_outsider, false, "seated agent outside conversation must be refused");
      await tx`ROLLBACK TO SAVEPOINT sp_agent_seat_gate`;

      // Also verify todo_create end-to-end for seated member vs seated non-member vs revoked-seat vs absent-seat agents!
      const grantScout = randomUUID(), connScout = randomUUID();
      const grantRevoked = randomUUID(), connRevoked = randomUUID();
      const grantOutsider = randomUUID(), connOutsider = randomUUID();
      for (const [grantId, connId, agentId, label] of [
        [grantScout, connScout, scoutAgentId, "Scout"],
        [grantRevoked, connRevoked, revokedSeatAgentId, "Revoked"],
        [grantOutsider, connOutsider, seatedNonMemberAgentId, "SeatedOutsider"],
      ] as const) {
        await tx`
          INSERT INTO swarm.hosted_mcp_grants (
            grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
            selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
          ) VALUES (
            ${grantId}::uuid, ${`syn-${grantId}`}, ${viewerId}::uuid, ${wsId}::uuid, 'syn-client',
            'https://mcp.commonswarm.com/mcp', ARRAY[${wsId}]::uuid[], decode(repeat('a',64),'hex'),
            'syn-consent', 'active', clock_timestamp(), clock_timestamp()
          )
        `;
        await tx`
          INSERT INTO swarm.hosted_mcp_grant_workspaces (
            grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at
          ) VALUES (
            ${grantId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, decode(repeat('a',64),'hex'),
            ${randomUUID()}::uuid, clock_timestamp()
          )
        `;
        await tx`
          INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
          VALUES (${grantId}::uuid, ${agentId}::uuid, ${viewerId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
          VALUES (${connId}::uuid, ${grantId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, ${agentId}::uuid, ${label}, clock_timestamp())
        `;
        await tx`
          INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
          VALUES (${`seat_${connId.replace(/-/g, "")}`}, ${connId}::uuid, ${grantId}::uuid, ${wsId}::uuid, ${agentId}::uuid, clock_timestamp())
        `;
        await tx`
          INSERT INTO swarm.household_content_connections (
            connection_id, grant_id, workspace_id, principal_id, owner_user_id, purpose, operations,
            consent_receipt_id, expires_at, hosted_grant_id
          ) VALUES (
            ${connId}::uuid, ${grantId}::uuid, ${wsId}::uuid, ${agentId}::uuid, ${viewerId}::uuid,
            'shared', ARRAY['read','create','update'], ${randomUUID()}::uuid, NULL, ${grantId}::uuid
          )
        `;
      }
      const scoutIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: scoutAgentId, run_id: null, connection: { connection_id: connScout, grant_id: grantScout } };
      const unseatedIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: unseatedAgentId, run_id: null, connection: { connection_id: randomUUID(), grant_id: randomUUID() } };
      const revokedIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: revokedSeatAgentId, run_id: null, connection: { connection_id: connRevoked, grant_id: grantRevoked } };
      const seatedOutsiderIdentity: HouseholdIdentity = { user_id: viewerId, principal_id: seatedNonMemberAgentId, run_id: null, connection: { connection_id: connOutsider, grant_id: grantOutsider } };
      await tx`SAVEPOINT sp_agent_todo_creates`;
      await tx`SET LOCAL ROLE swarm_command`;
      const unseatedCreate = await store.write(tx, wsId, unseatedIdentity, `req-${randomUUID()}`, {
        kind: "todo_create", title: "Unseated agent group todo", origin_placement: "group_dm", origin_conversation_id: convGroupGen1,
      });
      assert.equal(unseatedCreate.outcome.status, "refused", "absent seat must refuse direct provenance");
      const revokedCreate = await store.write(tx, wsId, revokedIdentity, `req-${randomUUID()}`, {
        kind: "todo_create", title: "Revoked seat group todo", origin_placement: "group_dm", origin_conversation_id: convGroupGen1,
      });
      assert.equal(revokedCreate.outcome.status, "refused", "revoked seat must refuse direct provenance");
      const seatedOutsiderCreate = await store.write(tx, wsId, seatedOutsiderIdentity, `req-${randomUUID()}`, {
        kind: "todo_create", title: "Seated non-member group todo", origin_placement: "group_dm", origin_conversation_id: convGroupGen1,
      });
      assert.deepEqual(seatedOutsiderCreate.outcome, { status: "refused", reason: "target_not_found" }, "seated non-member must refuse target_not_found");
      const seatedCreate = await store.write(tx, wsId, scoutIdentity, `req-${randomUUID()}`, {
        kind: "todo_create", title: "Seated agent group todo", origin_placement: "group_dm", origin_conversation_id: convGroupGen1,
      });
      assert.equal(seatedCreate.outcome.status, "committed", "live seated conversation member must succeed");
      await tx`ROLLBACK TO SAVEPOINT sp_agent_todo_creates`;

      // Seed an eligible unmapped legacy ask (no conversation_signals row) addressed to viewer & Maya as a control!
      const legacyAskId = randomUUID();
      await tx`ALTER TABLE swarm.signals DISABLE TRIGGER signals_settle_conversation`;
      await tx`ALTER TABLE swarm.signal_recipients DISABLE TRIGGER signal_recipients_settle_conversation`;
      await tx`
        INSERT INTO swarm.signals (
          id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, created_at, sender_lifecycle_epoch
        ) VALUES (
          ${legacyAskId}::uuid, ${wsId}::uuid, ${scoutAgentId}::uuid, 'agent', ${viewerId}::uuid,
          'ask', 'Legacy unmapped ask control?', statement_timestamp() + interval '1 day', statement_timestamp() - interval '5 seconds', 1
        )
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${legacyAskId}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 0),
          (${legacyAskId}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 1)
      `;
      await tx`ALTER TABLE swarm.signal_recipients ENABLE TRIGGER signal_recipients_settle_conversation`;
      await tx`ALTER TABLE swarm.signals ENABLE TRIGGER signals_settle_conversation`;

      // 1. Write-time authz on todo_create for dm / group_dm origins.
      await tx`SAVEPOINT sp_dm_todo_writes`;
      await tx`SET LOCAL ROLE swarm_command`;

      const refusedDirectCreates: Array<{ label: string; who: HouseholdIdentity; cmd: todos.TodoCommand }> = [
        {
          label: "outsider group_dm origin",
          who: outsiderIdentity,
          cmd: { kind: "todo_create", title: "Outsider group todo", origin_placement: "group_dm", origin_conversation_id: convGroupGen1 },
        },
        {
          label: "foreign workspace dm origin",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Foreign dm todo", origin_placement: "dm", origin_conversation_id: convForeignDm },
        },
        {
          label: "wrong kind dm vs group_dm",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Wrong kind 1", origin_placement: "dm", origin_conversation_id: convGroupGen1 },
        },
        {
          label: "wrong kind group_dm vs dm",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Wrong kind 2", origin_placement: "group_dm", origin_conversation_id: convDmScout },
        },
        {
          label: "nonexistent conversation_id",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Missing conv", origin_placement: "group_dm", origin_conversation_id: randomUUID() },
        },
        {
          label: "group_dm with null conversation_id",
          who: viewerIdentity,
          cmd: { kind: "todo_create", title: "Missing id", origin_placement: "group_dm", origin_conversation_id: null },
        },
      ];
      for (const entry of refusedDirectCreates) {
        const res = await store.write(tx, wsId, entry.who, `req-${randomUUID()}`, entry.cmd);
        assert.deepEqual(
          res.outcome,
          { status: "refused", reason: "target_not_found" },
          `expected uniform non-oracle refusal for ${entry.label}`,
        );
      }

      const groupViewerTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Book plumber from Gen 1",
        origin_placement: "group_dm",
        origin_conversation_id: convGroupGen1,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      const groupOutsiderTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Outsider assigned group task",
        origin_placement: "group_dm",
        origin_conversation_id: convGroupGen1,
        assign: { to: { kind: "user", id: outsiderId } },
      }));
      const groupMayaWrite = await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Maya assigned group task",
        origin_placement: "group_dm",
        origin_conversation_id: convGroupGen1,
        assign: { to: { kind: "user", id: mayaId } },
      });
      const groupMayaTodo = committedTodo(groupMayaWrite);
      const mayaOfferNoticeId = groupMayaWrite.notices[0]?.signal_id ?? null;
      assert.ok(mayaOfferNoticeId, "assigning a to-do to Maya posts a direct offer notice ask to Maya");
      const dmViewerTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Follow up with Scout",
        origin_placement: "dm",
        origin_conversation_id: convDmScout,
        assign: { to: { kind: "user", id: viewerId } },
      }));
      for (const written of [groupViewerTodo, groupOutsiderTodo, groupMayaTodo, dmViewerTodo]) {
        assert.equal("origin_conversation_id" in written, false, "todo_create must strip origin_conversation_id");
        assert.equal("origin_placement" in written, false, "todo_create must strip origin_placement");
      }

      // Updating preserves immutable origin_conversation_id in event replay.
      await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: groupViewerTodo.todo_id,
        base_version: groupViewerTodo.version,
        title: "Book plumber from Gen 1 (updated)",
      });
      const eventRows = await tx<{ event: todos.TodoEvent }[]>`
        SELECT event FROM swarm.household_todo_events WHERE workspace_id = ${wsId}::uuid ORDER BY seq ASC
      `;
      const [streamRow] = await tx<{ stream_id: string }[]>`
        SELECT stream_id FROM swarm.household_todo_streams WHERE workspace_id = ${wsId}::uuid
      `;
      const replayed = todos.reduceTodoEvents(
        todos.emptyHouseholdTodoState(wsId, String(streamRow!.stream_id)),
        eventRows.map((r) => r.event),
      );
      assert.equal(replayed.todos[groupViewerTodo.todo_id]!.origin_placement, "group_dm");
      assert.equal(replayed.todos[groupViewerTodo.todo_id]!.origin_conversation_id, convGroupGen1);
      assert.equal(replayed.todos[dmViewerTodo.todo_id]!.origin_placement, "dm");
      assert.equal(replayed.todos[dmViewerTodo.todo_id]!.origin_conversation_id, convDmScout);
      await tx`RELEASE SAVEPOINT sp_dm_todo_writes`;
      await tx`RESET ROLE`;

      // DB constraints: cross-tenant FK (23503) and shape CHECK (23514).
      await tx`SAVEPOINT sp_dm_db_constraints`;
      await assert.rejects(
        () => tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, gate_kind, state_by_user, state_at, comment_count, last_seq,
            origin_placement, origin_conversation_id
          ) VALUES (
            ${wsId}::uuid, ${randomUUID()}::uuid, 1, 'Cross-tenant conv FK', '', 'open',
            ${viewerId}::uuid, now(), 'none', ${viewerId}::uuid, now(), 0, 999,
            'dm', ${convForeignDm}::uuid
          )
        `,
        (err: { code?: string }) => err?.code === "23503",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_dm_db_constraints`;
      await assert.rejects(
        () => tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, gate_kind, state_by_user, state_at, comment_count, last_seq,
            origin_placement, origin_conversation_id
          ) VALUES (
            ${wsId}::uuid, ${randomUUID()}::uuid, 1, 'Bad conv shape', '', 'open',
            ${viewerId}::uuid, now(), 'none', ${viewerId}::uuid, now(), 0, 999,
            'workspace', ${convGroupGen1}::uuid
          )
        `,
        (err: { code?: string }) => err?.code === "23514",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_dm_db_constraints`;

      // 2. Active member reads: waiting_todos_page returns dm/group_dm + conversation_id;
      //    decision_queue & decision_queue_page return authoritative conversation_id=convGroupGen1 (not Gen 2).
      await tx`SAVEPOINT sp_dm_viewer_reads`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [viewerTodos] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      const byTodoId = new Map(viewerTodos!.r!.todos.map((t) => [t.todo_id, t]));
      assert.deepEqual(
        {
          placement: byTodoId.get(groupViewerTodo.todo_id)!.placement,
          channel_id: byTodoId.get(groupViewerTodo.todo_id)!.channel_id,
          conversation_id: byTodoId.get(groupViewerTodo.todo_id)!.conversation_id,
        },
        { placement: "group_dm", channel_id: null, conversation_id: convGroupGen1 },
      );
      assert.deepEqual(
        {
          placement: byTodoId.get(dmViewerTodo.todo_id)!.placement,
          channel_id: byTodoId.get(dmViewerTodo.todo_id)!.channel_id,
          conversation_id: byTodoId.get(dmViewerTodo.todo_id)!.conversation_id,
        },
        { placement: "dm", channel_id: null, conversation_id: convDmScout },
      );

      const [dqRow] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue(${wsId}::uuid) AS r
      `;
      const [dqpRow] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r
      `;
      for (const [label, payload] of [["decision_queue", dqRow!.r], ["decision_queue_page", dqpRow!.r]] as const) {
        assert.ok(payload, `${label} should return payload for viewer`);
        const ask = payload.asks.find((a) => a.signal_id === gen1AskId);
        assert.ok(ask, `${label} must include Gen 1 ask`);
        assert.equal(ask.conversation_id, convGroupGen1, `${label} must return authoritative Gen 1 conversation_id`);
        assert.notEqual(ask.conversation_id, convGroupGen2, `${label} must not confuse Gen 1 with restarted Gen 2`);
        assert.equal(ask.conversation_kind, "group_dm", `${label} must return conversation_kind='group_dm'`);
      }
      await tx`ROLLBACK TO SAVEPOINT sp_dm_viewer_reads`;

      // 3. Outsider redaction: outsider assigned a group_dm to-do sees it redacted to workspace/null/null.
      await tx`SAVEPOINT sp_dm_outsider_read`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: outsiderId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [outsiderTodos] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(outsiderTodos!.r!.total, 1);
      assert.equal(outsiderTodos!.r!.todos[0]!.todo_id, groupOutsiderTodo.todo_id);
      assert.equal(outsiderTodos!.r!.todos[0]!.placement, "workspace");
      assert.equal(outsiderTodos!.r!.todos[0]!.channel_id, null);
      assert.equal(outsiderTodos!.r!.todos[0]!.conversation_id, null);
      await tx`ROLLBACK TO SAVEPOINT sp_dm_outsider_read`;

      // 4. Left-member gating & write refusal: Maya leaves convGroupGen1 ->
      //    todo_create refuses, waiting_todos_page redacts to workspace/null/null,
      //    and decision_queue/decision_queue_page EXCLUDE the entire mapped Gen 1 ask row
      //    (zero body, sender, timing, or count leaked) while preserving eligible legacy asks
      //    and keeping the joined recipient control (viewerId) intact!
      await tx`
        UPDATE swarm.conversation_members
        SET left_at = statement_timestamp()
        WHERE conversation_id = ${convGroupGen1}::uuid AND member_user_id = ${mayaId}::uuid
      `;

      await tx`SAVEPOINT sp_dm_left_write`;
      await tx`SET LOCAL ROLE swarm_command`;
      const leftWrite = await store.write(tx, wsId, mayaIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Left member create",
        origin_placement: "group_dm",
        origin_conversation_id: convGroupGen1,
      });
      assert.deepEqual(leftWrite.outcome, { status: "refused", reason: "target_not_found" });
      await tx`ROLLBACK TO SAVEPOINT sp_dm_left_write`;

      await tx`SAVEPOINT sp_dm_left_read`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: mayaId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [mayaTodos] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(mayaTodos!.r!.total, 1);
      assert.equal(mayaTodos!.r!.todos[0]!.todo_id, groupMayaTodo.todo_id);
      assert.equal(mayaTodos!.r!.todos[0]!.placement, "workspace");
      assert.equal(mayaTodos!.r!.todos[0]!.channel_id, null);
      assert.equal(mayaTodos!.r!.todos[0]!.conversation_id, null);

      const [mayaDq] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue(${wsId}::uuid) AS r
      `;
      const [mayaDqp] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r
      `;
      for (const [label, payload] of [["decision_queue", mayaDq!.r], ["decision_queue_page", mayaDqp!.r]] as const) {
        assert.ok(payload, `${label} should return payload for workspace member`);
        assert.equal(
          payload.asks.find((a) => a.signal_id === gen1AskId),
          undefined,
          `${label} must exclude mapped Gen 1 ask completely after member departure`,
        );
        // Maya retains only her unmapped legacy control ask + the live direct offer notice ask (2 total, never gen1AskId).
        assert.equal(payload.total, 2, `${label} total must exclude departed Gen 1 ask and count only legacy + offer notice`);
        assert.equal(payload.asks.length, 2);
        const leg = payload.asks.find((a) => a.signal_id === legacyAskId);
        const offerNotice = payload.asks.find((a) => a.signal_id === mayaOfferNoticeId);
        assert.ok(leg, `${label} must retain eligible unmapped legacy ask control`);
        assert.equal(leg.conversation_id, null);
        assert.equal(leg.conversation_kind, null);
        assert.ok(offerNotice, `${label} must retain live direct offer notice ask`);
      }

      // Joined recipient control: viewerId still sees BOTH Gen 1 ask (with convGroupGen1) AND legacy ask!
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      const [viewerDqAfter] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue(${wsId}::uuid) AS r
      `;
      const [viewerDqpAfter] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r
      `;
      for (const [label, payload] of [["decision_queue", viewerDqAfter!.r], ["decision_queue_page", viewerDqpAfter!.r]] as const) {
        assert.equal(payload!.total, 2, `${label} joined recipient control must still count both asks`);
        const g1 = payload!.asks.find((a) => a.signal_id === gen1AskId);
        const leg = payload!.asks.find((a) => a.signal_id === legacyAskId);
        assert.equal(g1?.conversation_id, convGroupGen1);
        assert.equal(g1?.conversation_kind, "group_dm");
        assert.ok(leg && leg.conversation_id === null && leg.conversation_kind === null);
      }
      await tx`ROLLBACK TO SAVEPOINT sp_dm_left_read`;

      // Pure departed-only control: answer legacyAskId and mayaOfferNoticeId so gen1AskId is Maya's ONLY open ask -> total=0, asks=[]!
      await tx`SAVEPOINT sp_dm_departed_zero`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, in_reply_to, until, created_at)
        VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', ${scoutAgentId}::uuid, 'note', 'Answered legacy', ${legacyAskId}::uuid, now() + interval '1 day', statement_timestamp())
      `;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, in_reply_to, until, created_at)
        VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${mayaId}::uuid, 'user', ${viewerId}::uuid, 'note', 'Answered offer notice', ${mayaOfferNoticeId}::uuid, now() + interval '1 day', statement_timestamp())
      `;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: mayaId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [mayaZeroDq] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue(${wsId}::uuid) AS r
      `;
      const [mayaZeroDqp] = await tx<{ r: DecisionQueuePayload | null }[]>`
        SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r
      `;
      assert.equal(mayaZeroDq!.r!.total, 0, "departed member with no other asks gets total=0 in decision_queue");
      assert.deepEqual(mayaZeroDq!.r!.asks, [], "departed member gets empty asks in decision_queue");
      assert.equal(mayaZeroDqp!.r!.total, 0, "departed member with no other asks gets total=0 in decision_queue_page");
      assert.deepEqual(mayaZeroDqp!.r!.asks, [], "departed member gets empty asks in decision_queue_page");
      await tx`ROLLBACK TO SAVEPOINT sp_dm_departed_zero`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
