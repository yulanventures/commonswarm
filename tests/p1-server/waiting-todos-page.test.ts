/**
 * Server witness for swarm_read.waiting_todos_page (20261119000005_waiting_todos_page.sql).
 *
 * Runs inside a single rolled-back transaction so the shared local database stays clean.
 * Verifies:
 *   1. Keyset pagination past home_overview's 20-row cap (25 waiting/assigned to-dos including
 *      microsecond state_at ties and millisecond-truncated client cursors).
 *   2. Authoritative channel/conversation placement across two named channels, #general, and
 *      workspace-only to-dos, ensuring automatic addressed householdNotice signals never clobber
 *      a channel association or misclassify workspace-only to-dos.
 *   3. Private-channel visibility isolation via swarm_read.signals.
 *   4. Authz boundaries: household_human_can_read gate, non-member, agent claims, invalid cursor.
 *   5. Query plan pushes workspace_id + about into signals_about_newest on bounded page rows.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

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

test("waiting_todos_page paginates past 20, resolves channel placement, and enforces household read gates", async () => {
  const viewerId = randomUUID();
  const memberNoConsentId = randomUUID();
  const memberOutsidePrivId = randomUUID();
  const nonMemberId = randomUUID();
  const wsId = randomUUID();
  const chBoiler = randomUUID();
  const chReno = randomUUID();
  const chPriv = randomUUID();

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
        VALUES (${wsId}::uuid, 'WaitingTodosWS', ${viewerId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'owner'),
          (${wsId}::uuid, ${memberNoConsentId}::uuid, 'member'),
          (${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'member')
      `;
      // Grant household content read access to viewerId and memberOutsidePrivId, NOT memberNoConsentId.
      const consentViewer = randomUUID();
      const consentOutside = randomUUID();
      await tx`
        INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
        VALUES (${wsId}::uuid, 'shared')
      `;
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${viewerId}::uuid, 'editor', ${consentViewer}::uuid, now()),
          (${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'editor', ${consentOutside}::uuid, now())
      `;

      // Channels: two open channels + one private channel (viewerId only).
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES
          (${chBoiler}::uuid, ${wsId}::uuid, 'boiler-quotes', 'open', ${viewerId}::uuid, 'user'),
          (${chReno}::uuid, ${wsId}::uuid, 'renovation', 'open', ${viewerId}::uuid, 'user'),
          (${chPriv}::uuid, ${wsId}::uuid, 'private-vault', 'private', ${viewerId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES (${chPriv}::uuid, ${wsId}::uuid, 'user', ${viewerId}::uuid, ${viewerId}::uuid, 'user')
      `;

      // Seed 25 open to-dos assigned to viewerId (plus 1 done to-do that must be excluded).
      // Include microsecond timestamps and ties so cursor precision and tie-breaking are tested.
      const todoIds = Array.from({ length: 25 }, () => randomUUID());
      const doneTodoId = randomUUID();
      const tiedStamp = "2026-11-19T12:00:00.123456Z";
      for (let i = 0; i < todoIds.length; i++) {
        const id = todoIds[i]!;
        const stateAt = i >= 18 && i <= 21
          ? tiedStamp
          : new Date(Date.parse("2026-11-19T12:00:00.000Z") + (25 - i) * 1000).toISOString().replace(".000Z", `.${String(100000 + i).padStart(6, "0")}Z`);
        await tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state, due_on,
            created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
            gate_kind, state_by_user, state_at, comment_count, last_seq
          ) VALUES (
            ${wsId}::uuid, ${id}::uuid, 1, ${`Waiting todo #${i + 1}`}, '', 'open',
            ${i === 0 ? "2026-11-22" : null},
            ${viewerId}::uuid, now(), ${viewerId}::uuid, ${viewerId}::uuid, now(),
            'none', ${viewerId}::uuid, ${stateAt}::timestamptz, 0, ${i + 1}
          )
        `;
      }
      // Also seed an open to-do assigned to memberOutsidePrivId linked to chPriv so we can test
      // private-channel isolation for a member outside chPriv.
      const privOutsiderTodoId = randomUUID();
      await tx`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, title, notes, state,
          created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
          gate_kind, state_by_user, state_at, comment_count, last_seq
        ) VALUES
          (${wsId}::uuid, ${doneTodoId}::uuid, 1, 'Already completed', '', 'done',
           ${viewerId}::uuid, now(), ${viewerId}::uuid, ${viewerId}::uuid, now(),
           'none', ${viewerId}::uuid, now(), 0, 26),
          (${wsId}::uuid, ${privOutsiderTodoId}::uuid, 1, 'Outsider private-channel task', '', 'open',
           ${viewerId}::uuid, now(), ${memberOutsidePrivId}::uuid, ${viewerId}::uuid, now(),
           'none', ${viewerId}::uuid, now(), 0, 27)
      `;

      // Seed signals associating specific to-dos with conversations:
      // - todoIds[0]: #boiler-quotes signal PLUS a newer automatic addressed householdNotice (channel_id=NULL, to_user_id=viewerId)
      //               -> MUST stay placement='channel', channel_id=chBoiler (notice must NOT clobber it!)
      // - todoIds[1]: #renovation signal -> placement='channel', channel_id=chReno
      // - todoIds[2]: #general broadcast signal (channel_id=NULL, unaddressed) -> placement='general', channel_id=NULL
      // - todoIds[3]: ONLY an automatic addressed householdNotice (channel_id=NULL, to_user_id=viewerId)
      //               -> MUST stay placement='workspace', channel_id=NULL (must NOT become #general!)
      // - todoIds[4]: private channel signal (chPriv) -> viewerId sees placement='channel', channel_id=chPriv
      // - privOutsiderTodoId: private channel signal (chPriv) -> memberOutsidePrivId MUST NOT see chPriv!
      // - todoIds[5..24]: no signals -> placement='workspace', channel_id=NULL
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, about, channel_id, until, created_at)
        VALUES
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Boiler task created here', ${`todo:${todoIds[0]}`}, ${chBoiler}::uuid, now() + interval '7 days', now() - interval '10 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'user', ${viewerId}::uuid, 'ask', 'Asks you to take a to-do.', ${`todo:${todoIds[0]}`}, NULL, now() + interval '7 days', now() - interval '1 minute'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Renovation task created here', ${`todo:${todoIds[1]}`}, ${chReno}::uuid, now() + interval '7 days', now() - interval '9 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'General broadcast task', ${`todo:${todoIds[2]}`}, NULL, now() + interval '7 days', now() - interval '8 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${memberOutsidePrivId}::uuid, 'user', ${viewerId}::uuid, 'ask', 'Asks you to take a to-do.', ${`todo:${todoIds[3]}`}, NULL, now() + interval '7 days', now() - interval '7 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Private vault task', ${`todo:${todoIds[4]}`}, ${chPriv}::uuid, now() + interval '7 days', now() - interval '6 minutes'),
          (${randomUUID()}::uuid, ${wsId}::uuid, ${viewerId}::uuid, 'user', NULL, 'note', 'Private vault ref for outsider todo', ${`todo:${privOutsiderTodoId}`}, ${chPriv}::uuid, now() + interval '7 days', now() - interval '5 minutes')
      `;

      // Add extra noise signals in the workspace so EXPLAIN prefers signals_about_newest.
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, channel_id, until, created_at)
        SELECT gen_random_uuid(), ${wsId}::uuid, ${viewerId}::uuid, 'user', 'note', 'Noise ' || g, ${chBoiler}::uuid, now() + interval '7 days', now() - (g || ' seconds')::interval
        FROM generate_series(1, 2000) AS g
      `;
      await tx`ANALYZE swarm.household_todos, swarm.signals`;

      // 1. Keyset paginate all 25 to-dos using page size 10 (proving item 21-25 reachable even with
      //    millisecond-truncated JS timestamps and tied state_at rows!).
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
        const [row] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
          SELECT swarm_read.waiting_todos_page(
            ${wsId}::uuid,
            10,
            ${afterStateAt}::timestamptz,
            ${afterTodoId}::uuid
          ) AS r
        `;
        assert.ok(row?.r, "authenticated member with read access gets payload");
        assert.equal(row.r.total, 25, "exact total must reflect all 25 open waiting to-dos");
        collected.push(...row.r.todos);
        if (!row.r.truncated) break;
        const last = row.r.todos[row.r.todos.length - 1]!;
        // Truncate cursor timestamp to millisecond precision (exact JS Date.toISOString behavior).
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
        { placement: byId.get(todoIds[0]!)!.placement, channel_id: byId.get(todoIds[0]!)!.channel_id },
        { placement: "channel", channel_id: chBoiler },
        "newer addressed householdNotice must not clobber #boiler-quotes placement",
      );
      assert.deepEqual(
        { placement: byId.get(todoIds[1]!)!.placement, channel_id: byId.get(todoIds[1]!)!.channel_id },
        { placement: "channel", channel_id: chReno },
        "second channel to-do must resolve to #renovation",
      );
      assert.deepEqual(
        { placement: byId.get(todoIds[2]!)!.placement, channel_id: byId.get(todoIds[2]!)!.channel_id },
        { placement: "general", channel_id: null },
        "unaddressed #general broadcast signal must resolve to general",
      );
      assert.deepEqual(
        { placement: byId.get(todoIds[3]!)!.placement, channel_id: byId.get(todoIds[3]!)!.channel_id },
        { placement: "workspace", channel_id: null },
        "addressed channel_id=NULL householdNotice alone must remain workspace-only",
      );
      assert.deepEqual(
        { placement: byId.get(todoIds[4]!)!.placement, channel_id: byId.get(todoIds[4]!)!.channel_id },
        { placement: "channel", channel_id: chPriv },
        "private-channel member sees private channel placement",
      );
      assert.deepEqual(
        { placement: byId.get(todoIds[24]!)!.placement, channel_id: byId.get(todoIds[24]!)!.channel_id },
        { placement: "workspace", channel_id: null },
        "item 25 with no signal stays workspace-only",
      );

      // Half-cursor must raise SQLSTATE 22023.
      await tx`SAVEPOINT sp_bad_cursor`;
      await assert.rejects(
        () => tx`SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 10, now(), NULL)`,
        (err: { code?: string }) => err?.code === "22023",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_bad_cursor`;
      await tx`ROLLBACK TO SAVEPOINT sp_viewer`;

      // 2. Member outside private channel sees their assigned to-do, NOT the private channel_id!
      await tx`SAVEPOINT sp_outside_priv`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: memberOutsidePrivId })}, true)`;
      await tx`SET LOCAL ROLE authenticated`;
      const [outsideRow] = await tx<{ r: WaitingTodosPagePayload | null }[]>`
        SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r
      `;
      assert.equal(outsideRow!.r!.total, 1);
      assert.equal(outsideRow!.r!.todos[0]!.todo_id, privOutsiderTodoId);
      assert.equal(outsideRow!.r!.todos[0]!.placement, "workspace", "private channel must not leak to non-member");
      assert.equal(outsideRow!.r!.todos[0]!.channel_id, null, "private channel_id must stay null for non-member");
      await tx`ROLLBACK TO SAVEPOINT sp_outside_priv`;

      // 3. Authz gates: member without household_human_can_read gets empty list; non-member & agent get NULL.
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

      // 4. Verify LATERAL signals lookup uses signals_about_newest before security_barrier.
      await tx`SAVEPOINT sp_plan`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE swarm_admin`;
      const planRows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT loc.channel_id
        FROM (SELECT todo_id FROM swarm.household_todos WHERE workspace_id = '${wsId}'::uuid LIMIT 10) p
        LEFT JOIN LATERAL (
          SELECT s.channel_id
          FROM swarm_read.signals s
          WHERE s.workspace_id = '${wsId}'::uuid
            AND s.about = 'todo:' || p.todo_id::text
            AND s.channel_id IS NOT NULL
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT 1
        ) loc ON true
      `);
      const planText = planRows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.ok(
        planText.includes("signals_about_newest"),
        `expected LATERAL lookup to use signals_about_newest, got:\n${planText}`,
      );
      await tx`ROLLBACK TO SAVEPOINT sp_plan`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
