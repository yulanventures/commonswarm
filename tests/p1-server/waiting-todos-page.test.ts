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

interface WaitingTodoRow {
  todo_id: string;
  title: string;
  state: "open" | "doing";
  due_on: string | null;
  reason: "assigned" | "request" | "after" | "hold" | "agent_removed";
  agent_id: string | null;
  state_at: string;
  placement: "channel" | "general" | "workspace";
  channel_id: string | null;
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
      const privOutsiderTodo = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Outsider private-channel task",
        origin_placement: "channel",
        origin_channel_id: chPriv,
        assign: { to: { kind: "user", id: memberOutsidePrivId } },
      }));

      // Immutability across updates: update boilerTodo title and move to 'doing'.
      const updatedBoiler = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_update",
        todo_id: boilerTodo.todo_id,
        base_version: boilerTodo.version,
        title: "Boiler channel task (updated)",
      }));
      assert.equal(updatedBoiler.origin_placement, "channel");
      assert.equal(updatedBoiler.origin_channel_id, chBoiler);
      const doingBoiler = committedTodo(await store.write(tx, wsId, viewerIdentity, `req-${randomUUID()}`, {
        kind: "todo_set_state",
        todo_id: boilerTodo.todo_id,
        base_version: updatedBoiler.version,
        state: "doing",
      }));
      assert.equal(doingBoiler.origin_placement, "channel");
      assert.equal(doingBoiler.origin_channel_id, chBoiler);

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
      assert.equal(replayed.todos[workspaceTodo.todo_id]!.origin_placement, "workspace");
      assert.equal(replayed.todos[workspaceTodo.todo_id]!.origin_channel_id, null);

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
