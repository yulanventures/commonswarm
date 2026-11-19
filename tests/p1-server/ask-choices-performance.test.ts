/**
 * Production-volume witness for swarm_read.ask_choices (SQLSTATE 57014 timeout fix).
 *
 * Seeds 25,000 signals, 1,000 choice asks, 200 completed answers, 5,000 signal recipients,
 * 20 agent principals, and public/private channels inside a single rolled-back transaction so
 * the shared local database stays clean. Proves that:
 *   1. Both custom plans (calls 1-5) and cached generic plans (calls 6-10) stay well under
 *      500 ms (PostgreSQL statement_timeout enforced) for 50-signal batches.
 *   2. Visibility (public, private channel, cross-workspace, agent/non-member) and output
 *      shape (multi, options, completed answer fields, empty array) remain exact.
 *   3. EXPLAIN (ANALYZE, BUFFERS) stays O(|p_signal_ids|) with indexed lookups on
 *      signals_id_workspace / signals_pkey and bounded shared buffers (no full-workspace scan).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import postgres from "postgres";

let sql: postgres.Sql;

function resolveDbUrl(): string {
  const fromEnv = process.env.ASK_CHOICES_TEST_DB_URL;
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

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

function collectNodes(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [root];
  for (const child of root.Plans ?? []) out.push(...collectNodes(child));
  return out;
}

interface AskChoicesPayload {
  workspace_id: string;
  untrusted_content: boolean;
  asks: Array<{
    signal_id: string;
    options: Array<{ id: string; label: string }>;
    multi: boolean;
    answer: {
      option_id: string;
      option_ids: string[];
      other_text: string | null;
      actor_user_id: string;
      by_viewer: boolean;
      reply_signal_id: string;
      at: string;
    } | null;
  }>;
}

const ROLLBACK_WITNESS = Symbol("rollback-witness");

test("ask_choices stays indexed and fast at 25k signals across custom and generic plans", async () => {
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const nonMemberId = randomUUID();
  const wsMain = randomUUID();
  const wsOther = randomUUID();
  const chPub = randomUUID();
  const chPriv = randomUUID();

  try {
    await sql.begin(async (tx) => {
      // Seed users, workspaces, channels, 20 agents, 25,000 signals, 1,000 choice asks,
      // 200 completed answers, and 5,000 signal recipients inside this rolled-back transaction.
      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${viewerId}::uuid, ${`ask-perf-v-${viewerId}@example.test`}),
          (${outsiderId}::uuid, ${`ask-perf-o-${outsiderId}@example.test`}),
          (${nonMemberId}::uuid, ${`ask-perf-n-${nonMemberId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${viewerId}::uuid, 'PerfViewer'),
          (${outsiderId}::uuid, 'PerfOutsider'),
          (${nonMemberId}::uuid, 'PerfNonMember')
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES
          (${wsMain}::uuid, 'AskPerfMain', ${viewerId}::uuid),
          (${wsOther}::uuid, 'AskPerfOther', ${outsiderId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsMain}::uuid, ${viewerId}::uuid, 'owner'),
          (${wsMain}::uuid, ${outsiderId}::uuid, 'member'),
          (${wsOther}::uuid, ${outsiderId}::uuid, 'owner')
      `;
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES
          (${chPub}::uuid, ${wsMain}::uuid, 'perf-general', 'open', ${viewerId}::uuid, 'user'),
          (${chPriv}::uuid, ${wsMain}::uuid, 'perf-private', 'private', ${viewerId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES (${chPriv}::uuid, ${wsMain}::uuid, 'user', ${viewerId}::uuid, ${viewerId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        SELECT gen_random_uuid(), ${wsMain}::uuid,
          CASE WHEN g <= 10 THEN ${viewerId}::uuid ELSE ${outsiderId}::uuid END,
          'PerfAgent-' || g
        FROM generate_series(1, 20) AS g
      `;

      // 25,000 signals in wsMain:
      //   1..250:   public-channel broadcast choice asks (visible to both viewer and outsider)
      //   251..500: public-channel choice asks addressed to viewer
      //   501..1000: private-channel broadcast choice asks (visible to viewer only)
      //   1001..25000: normal channel/DM notes
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        SELECT
          gen_random_uuid(),
          ${wsMain}::uuid,
          CASE WHEN g % 2 = 0 THEN ${outsiderId}::uuid ELSE ${viewerId}::uuid END,
          'user',
          CASE
            WHEN g <= 250 THEN NULL
            WHEN g <= 500 THEN ${viewerId}::uuid
            WHEN g <= 1000 THEN NULL
            WHEN g % 3 = 0 THEN ${outsiderId}::uuid
            ELSE NULL
          END,
          CASE WHEN g <= 1000 THEN 'ask' ELSE 'note' END,
          'Perf signal #' || g,
          CASE
            WHEN g <= 500 THEN ${chPub}::uuid
            WHEN g <= 1000 THEN ${chPriv}::uuid
            WHEN g % 4 = 0 THEN ${chPriv}::uuid
            WHEN g % 5 = 0 THEN NULL
            ELSE ${chPub}::uuid
          END,
          now() + interval '7 days',
          now() - ((25000 - g) || ' seconds')::interval
        FROM generate_series(1, 25000) AS g
      `;

      // One choice ask in wsOther to verify cross-workspace isolation.
      const otherAskId = randomUUID();
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
        VALUES (${otherAskId}::uuid, ${wsOther}::uuid, ${outsiderId}::uuid, 'user', ${outsiderId}::uuid, 'ask', 'Other ws ask', now() + interval '7 days')
      `;
      await tx`
        INSERT INTO swarm.ask_choices (signal_id, workspace_id, options, multi)
        VALUES (${otherAskId}::uuid, ${wsOther}::uuid, '[{"id":"x","label":"X"},{"id":"y","label":"Y"}]'::jsonb, false)
      `;

      // Populate ask_choices for all 1,000 asks in wsMain.
      await tx`
        INSERT INTO swarm.ask_choices (signal_id, workspace_id, options, multi)
        SELECT s.id, s.workspace_id,
          '[{"id":"ship","label":"Ship now"},{"id":"wait","label":"Wait"}]'::jsonb,
          (s.channel_id = ${chPriv}::uuid)
        FROM swarm.signals s
        WHERE s.workspace_id = ${wsMain}::uuid AND s.kind = 'ask'
      `;

      // Complete 200 answers in wsMain (with v2 option_ids + other_text on half).
      await tx`
        INSERT INTO swarm.ui_actions (
          action_id, workspace_id, signal_id, actor_user_id, option_id, option_ids, other_text,
          state, reply_signal_id, completed_at
        )
        SELECT
          gen_random_uuid(), c.workspace_id, c.signal_id, ${viewerId}::uuid,
          'ship', ARRAY['ship']::text[],
          CASE WHEN row_number() OVER () % 2 = 0 THEN 'Go ahead' ELSE NULL END,
          'completed', gen_random_uuid(), now()
        FROM (
          SELECT workspace_id, signal_id
          FROM swarm.ask_choices
          WHERE workspace_id = ${wsMain}::uuid
          ORDER BY signal_id
          LIMIT 200
        ) c
      `;

      // Seed 5,000 signal_recipients in the same transaction to exercise the addressee branch.
      await tx`
        INSERT INTO swarm.signal_recipients (workspace_id, signal_id, recipient_user_id, position)
        SELECT s.workspace_id, s.id, ${outsiderId}::uuid, 0
        FROM (
          SELECT workspace_id, id
          FROM swarm.signals
          WHERE workspace_id = ${wsMain}::uuid AND to_user_id = ${outsiderId}::uuid
          LIMIT 5000
        ) s
      `;

      await tx`ANALYZE swarm.signals, swarm.ask_choices, swarm.ui_actions, swarm.signal_recipients, swarm.channels, swarm.channel_members, swarm.agent_principals, swarm.memberships`;

      // Pick representative 50-id batches (25 public broadcasts + 25 private-channel asks).
      const pubIds = (await tx<{ id: string }[]>`
        SELECT s.id FROM swarm.signals s
        WHERE s.workspace_id = ${wsMain}::uuid AND s.kind = 'ask' AND s.channel_id = ${chPub}::uuid AND s.to_user_id IS NULL
        ORDER BY s.id LIMIT 25
      `).map((r) => r.id);
      const privIds = (await tx<{ id: string }[]>`
        SELECT s.id FROM swarm.signals s
        WHERE s.workspace_id = ${wsMain}::uuid AND s.kind = 'ask' AND s.channel_id = ${chPriv}::uuid
        ORDER BY s.id LIMIT 25
      `).map((r) => r.id);
      const mixedBatch50 = [...pubIds, ...privIds];
      assert.equal(mixedBatch50.length, 50);

      const privBatch50 = (await tx<{ id: string }[]>`
        SELECT s.id FROM swarm.signals s
        WHERE s.workspace_id = ${wsMain}::uuid AND s.kind = 'ask' AND s.channel_id = ${chPriv}::uuid
        ORDER BY s.id LIMIT 50
      `).map((r) => r.id);
      assert.equal(privBatch50.length, 50);

      const noteBatch50 = (await tx<{ id: string }[]>`
        SELECT s.id FROM swarm.signals s
        WHERE s.workspace_id = ${wsMain}::uuid AND s.kind = 'note'
        ORDER BY s.id LIMIT 50
      `).map((r) => r.id);
      assert.equal(noteBatch50.length, 50);

      // 1. Run 10 consecutive authenticated calls (crossing Postgres's 5-call generic-plan switch)
      //    with a strict 500 ms statement_timeout (16x tighter than production's 8 s timeout).
      await tx`SAVEPOINT sp_rpc`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL statement_timeout = '500ms'`;
      await tx`SET LOCAL ROLE authenticated`;

      const timingsMs: number[] = [];
      let lastPayload: AskChoicesPayload | null = null;
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        const [row] = await tx<{ r: AskChoicesPayload | null }[]>`
          SELECT swarm_read.ask_choices(${wsMain}::uuid, ${mixedBatch50}::uuid[]) AS r
        `;
        timingsMs.push(performance.now() - t0);
        lastPayload = row!.r;
        assert.ok(lastPayload, `call ${i + 1} must return payload`);
        assert.equal(lastPayload.workspace_id, wsMain);
        assert.equal(lastPayload.untrusted_content, true);
        assert.equal(lastPayload.asks.length, 50, `call ${i + 1} must return all 50 visible asks`);
      }
      // Every call after warmup (especially calls 6-10 using the cached generic plan) must be fast.
      const steadyMaxMs = Math.max(...timingsMs.slice(1));
      assert.ok(
        steadyMaxMs < 250,
        `expected steady-state ask_choices < 250 ms at 25k signals, saw ${timingsMs.map((n) => n.toFixed(1)).join(", ")} ms`,
      );
      // Verify answer shape on answered rows and multi flag on private asks.
      const answered = lastPayload!.asks.filter((a) => a.answer !== null);
      assert.ok(answered.length > 0, "batch should include completed answers");
      assert.equal(answered[0]!.answer!.option_id, "ship");
      assert.deepEqual(answered[0]!.answer!.option_ids, ["ship"]);
      assert.equal(answered[0]!.answer!.by_viewer, true);
      assert.equal(answered[0]!.answer!.actor_user_id, viewerId);
      assert.ok(lastPayload!.asks.some((a) => a.multi === true) && lastPayload!.asks.some((a) => a.multi === false));

      // Empty array short-circuit returns empty asks array, not NULL.
      const [emptyRow] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ARRAY[]::uuid[]) AS r
      `;
      assert.deepEqual(emptyRow!.r, { workspace_id: wsMain, untrusted_content: true, asks: [] });

      // Non-choice notes return empty asks quickly; cross-workspace ask is excluded.
      const [notesRow] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${noteBatch50}::uuid[]) AS r
      `;
      assert.equal(notesRow!.r!.asks.length, 0);
      const [crossWsRow] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${[otherAskId]}::uuid[]) AS r
      `;
      assert.equal(crossWsRow!.r!.asks.length, 0);

      // > 50 signal ids returns NULL.
      const [over50Row] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${[...mixedBatch50, otherAskId]}::uuid[]) AS r
      `;
      assert.equal(over50Row!.r, null);

      // Outsider (workspace member NOT in chPriv) sees 0 private asks and only the 25 public asks.
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: outsiderId })}, true)`;
      const [outsiderPriv] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${privBatch50}::uuid[]) AS r
      `;
      assert.equal(outsiderPriv!.r!.asks.length, 0, "outsider must not see private-channel choice asks");
      const [outsiderMixed] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${mixedBatch50}::uuid[]) AS r
      `;
      assert.equal(outsiderMixed!.r!.asks.length, 25, "outsider must see only the 25 public asks");

      // Non-member and agent claims return NULL.
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: nonMemberId })}, true)`;
      const [nonMemberRow] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${pubIds}::uuid[]) AS r
      `;
      assert.equal(nonMemberRow!.r, null);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId, agent_principal_id: randomUUID() })}, true)`;
      const [agentRow] = await tx<{ r: AskChoicesPayload | null }[]>`
        SELECT swarm_read.ask_choices(${wsMain}::uuid, ${pubIds}::uuid[]) AS r
      `;
      assert.equal(agentRow!.r, null);
      await tx`ROLLBACK TO SAVEPOINT sp_rpc`;

      // 2. Deterministic query-plan & buffer witness (both custom and forced generic plan).
      //    Verifies Postgres pushes (workspace_id, id = ANY(...)) into swarm_read.signals instead
      //    of scanning all 25,000 workspace signals or materializing the view.
      await tx`SAVEPOINT sp_plan`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: viewerId })}, true)`;
      await tx`SET LOCAL ROLE swarm_admin`;

      for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
        await tx`SELECT set_config('plan_cache_mode', ${mode}, true)`;
        const planName = `ask_choices_witness_${mode}`;
        await tx.unsafe(`
          PREPARE ${planName} (uuid, uuid[], uuid) AS
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'signal_id', c.signal_id,
            'options', c.options,
            'multi', c.multi,
            'answer', CASE WHEN a.action_id IS NOT NULL THEN jsonb_build_object(
                'option_id', a.option_id,
                'option_ids', to_jsonb(coalesce(a.option_ids, ARRAY[a.option_id])),
                'other_text', a.other_text, 'actor_user_id', a.actor_user_id,
                'by_viewer', a.actor_user_id = $3,
                'reply_signal_id', a.reply_signal_id, 'at', a.completed_at)
              ELSE NULL END)
            ORDER BY c.signal_id), '[]'::jsonb)
          FROM swarm_read.signals s
          JOIN swarm.ask_choices c ON c.signal_id = s.id AND c.workspace_id = s.workspace_id
          LEFT JOIN swarm.ui_actions a ON a.signal_id = c.signal_id AND a.state = 'completed'
          WHERE s.workspace_id = $1 AND s.id = ANY ($2)
        `);
        const idsLiteral = `ARRAY[${mixedBatch50.map((id) => `'${id}'::uuid`).join(",")}]`;
        const [explainRow] = await tx.unsafe<{ "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number }> }[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE ${planName}('${wsMain}'::uuid, ${idsLiteral}, '${viewerId}'::uuid)`,
        );
        await tx.unsafe(`DEALLOCATE ${planName}`);

        const top = explainRow!["QUERY PLAN"][0]!;
        const root = top.Plan;
        const nodes = collectNodes(root);
        const totalBuffers = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);

        assert.ok(
          totalBuffers < 3000,
          `${mode}: expected < 3000 shared buffers (was >170k before fix), got ${totalBuffers}`,
        );
        assert.equal(
          nodes.some((n) => n["Node Type"] === "Materialize"),
          false,
          `${mode}: must not materialize swarm_read.signals across the join`,
        );
        assert.equal(
          nodes.some((n) => n["Node Type"] === "Seq Scan" && (n["Relation Name"] === "signals" || n["Relation Name"] === "signal_recipients")),
          false,
          `${mode}: must not Seq Scan signals or signal_recipients`,
        );
        const signalScans = nodes.filter((n) => n["Relation Name"] === "signals");
        assert.ok(signalScans.length >= 1, `${mode}: expected scan node on signals`);
        for (const scan of signalScans) {
          const touched = (scan["Actual Rows"] ?? 0) + (scan["Rows Removed by Filter"] ?? 0);
          assert.ok(
            touched <= 50,
            `${mode}: signals scan must touch <= 50 rows, touched ${touched} (${scan["Node Type"]} / ${scan["Index Name"] ?? "none"})`,
          );
          if (scan["Index Name"]) {
            assert.notEqual(
              scan["Index Name"],
              "signals_workspace_newest",
              `${mode}: must not scan full workspace via signals_workspace_newest`,
            );
          }
        }
      }
      await tx`ROLLBACK TO SAVEPOINT sp_plan`;

      // Roll back the seeded 25,000 rows so the shared test database stays untouched.
      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
