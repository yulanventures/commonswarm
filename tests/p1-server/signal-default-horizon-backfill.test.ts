/**
 * Real-Postgres proof for 20261120000007_signal_default_horizon_backfill.sql (to-do fcf69f45):
 *   - Unexpired default-7d asks, default-30d notes (including non-threaded in_reply_to notes),
 *     and default-clamped / default-horizon ask & note replies on those roots become permanent
 *     (9999-12-31T23:59:59Z).
 *   - Explicit custom horizons (3d ask, 1d reply on a 7d ask, reply clamped to an explicit 3d ask,
 *     explicit 7d reply on an already-permanent post-C6 root) stay untouched.
 *   - Already-lapsed rows (expired default-7d ask, expired default-30d note + its clamped reply)
 *     stay expired.
 *   - working-on signals (both standalone 24h and clamped inside a default-7d thread) stay untouched.
 *   - signals_append_only remains enabled after the migration and refuses ordinary UPDATEs (55000).
 *   - Re-running the migration SQL is idempotent (0 further changes).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54322/postgres";
const PERMANENT_UNTIL_ISO = "9999-12-31T23:59:59.000Z";
const PERMANENT_UNTIL_MS = Date.parse(PERMANENT_UNTIL_ISO);
const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL("../../supabase/migrations/20261120000007_signal_default_horizon_backfill.sql", import.meta.url),
  ),
  "utf8",
);

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
test.after(() => sql.end({ timeout: 5 }));

test("20261120000007 narrowed default-horizon backfill promotes only unexpired default asks, notes, and their clamped replies", async () => {
  const ROLLBACK_WITNESS = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      const wsId = randomUUID();
      const ownerId = randomUUID();
      const agentId = randomUUID();
      const chId = randomUUID();

      await tx`
        INSERT INTO auth.users (id, email, aud, role, encrypted_password, email_confirmed_at, created_at, updated_at)
        VALUES (${ownerId}::uuid, ${`owner-${ownerId}@example.test`}, 'authenticated', 'authenticated', '', now(), now(), now())
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES (${wsId}::uuid, 'Backfill witness workspace', ${ownerId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${wsId}::uuid, ${ownerId}::uuid, 'owner')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${agentId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'Scout')
      `;
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES (${chId}::uuid, ${wsId}::uuid, 'ops', 'open', ${ownerId}::uuid, 'user')
      `;

      const [clockRow] = await tx<{ now_iso: string }[]>`
        SELECT pg_catalog.statement_timestamp()::text AS now_iso
      `;
      const nowMs = Date.parse(clockRow!.now_iso);
      const HOUR = 60 * 60 * 1000;
      const DAY = 24 * HOUR;
      const iso = (ms: number) => new Date(ms).toISOString();

      // Witness IDs
      const explicit3dAskId = randomUUID();
      const clampedReplyOnExplicit3dAskId = randomUUID();
      const default30dInReplyToNoteId = randomUUID();

      const default7dAskId = randomUUID();
      const clampedReplyOn7dAskId = randomUUID();
      const explicit1dReplyOn7dAskId = randomUUID();

      const default7dSoonAskId = randomUUID();
      const workingOnClampedReplyId = randomUUID();

      const default30dNoteId = randomUUID();
      const clampedReplyOn30dNoteId = randomUUID();
      const default7dAskReplyOn30dNoteId = randomUUID();

      const expiredDefault7dAskId = randomUUID();
      const expiredDefault30dNoteId = randomUUID();
      const expiredClampedReplyId = randomUUID();

      const workingOnStandaloneId = randomUUID();

      const postC6PermRootId = randomUUID();
      const explicit7dReplyOnPermRootId = randomUUID();

      // Exact timestamps so expected unchanged horizons are verified to the millisecond.
      const explicit3dAskCreated = nowMs - 1 * DAY;
      const explicit3dAskUntil = explicit3dAskCreated + 3 * DAY;
      const clampedOn3dCreated = nowMs - 2 * HOUR;

      const default7dAskCreated = nowMs - 2 * DAY;
      const default7dAskUntil = default7dAskCreated + 7 * DAY;
      const clampedOn7dCreated = nowMs - 1 * DAY;
      const explicit1dOn7dCreated = nowMs - 1 * HOUR;
      const explicit1dOn7dUntil = explicit1dOn7dCreated + 1 * DAY;

      const default7dSoonCreated = nowMs - (6 * DAY + 20 * HOUR);
      const default7dSoonUntil = default7dSoonCreated + 7 * DAY; // 4h remaining
      const workingOnClampedCreated = nowMs - 1 * HOUR;

      const default30dNoteCreated = nowMs - 5 * DAY;
      const default30dNoteUntil = default30dNoteCreated + 30 * DAY;
      const clampedOn30dCreated = nowMs - 1 * DAY;
      const askReplyOn30dCreated = nowMs - 1 * DAY;
      const askReplyOn30dUntil = askReplyOn30dCreated + 7 * DAY;

      const inReplyToNoteCreated = nowMs - 1 * HOUR;
      const inReplyToNoteUntil = inReplyToNoteCreated + 30 * DAY;

      const expiredAskCreated = nowMs - 10 * DAY;
      const expiredAskUntil = expiredAskCreated + 7 * DAY; // expired 3d ago

      const expiredNoteCreated = nowMs - 40 * DAY;
      const expiredNoteUntil = expiredNoteCreated + 30 * DAY; // expired 10d ago
      const expiredReplyCreated = nowMs - 35 * DAY;

      const workingOnStandaloneCreated = nowMs - 1 * HOUR;
      const workingOnStandaloneUntil = workingOnStandaloneCreated + 1 * DAY;

      const postC6PermCreated = nowMs - 1 * HOUR;
      const explicit7dOnPermCreated = nowMs - 30 * 60 * 1000;
      const explicit7dOnPermUntil = explicit7dOnPermCreated + 7 * DAY;

      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;

      // Top-level roots first (so thread_root_id FK and conversation filing resolve cleanly).
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${explicit3dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Explicit 3d ask?', ${chId}::uuid, ${iso(explicit3dAskUntil)}::timestamptz, ${iso(explicit3dAskCreated)}::timestamptz),
          (${default7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Default 7d open ask?', ${chId}::uuid, ${iso(default7dAskUntil)}::timestamptz, ${iso(default7dAskCreated)}::timestamptz),
          (${default7dSoonAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Default 7d ask expiring soon?', ${chId}::uuid, ${iso(default7dSoonUntil)}::timestamptz, ${iso(default7dSoonCreated)}::timestamptz),
          (${default30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Default 30d open note', ${chId}::uuid, ${iso(default30dNoteUntil)}::timestamptz, ${iso(default30dNoteCreated)}::timestamptz),
          (${expiredDefault7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Already expired default 7d ask?', ${chId}::uuid, ${iso(expiredAskUntil)}::timestamptz, ${iso(expiredAskCreated)}::timestamptz),
          (${expiredDefault30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Already expired default 30d note', ${chId}::uuid, ${iso(expiredNoteUntil)}::timestamptz, ${iso(expiredNoteCreated)}::timestamptz),
          (${workingOnStandaloneId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', NULL, 'working-on', 'Active working-on status', ${chId}::uuid, ${iso(workingOnStandaloneUntil)}::timestamptz, ${iso(workingOnStandaloneCreated)}::timestamptz),
          (${postC6PermRootId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 permanent root', ${chId}::uuid, ${PERMANENT_UNTIL_ISO}::timestamptz, ${iso(postC6PermCreated)}::timestamptz)
      `;

      // Replies (threaded + one non-threaded in_reply_to default-30d note).
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, kind, body, channel_id, thread_root_id, in_reply_to, until, created_at)
        VALUES
          (${clampedReplyOnExplicit3dAskId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Clamped reply on explicit 3d ask', ${chId}::uuid, ${explicit3dAskId}::uuid, NULL, ${iso(explicit3dAskUntil)}::timestamptz, ${iso(clampedOn3dCreated)}::timestamptz),
          (${default30dInReplyToNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, ${agentId}::uuid, 'note', 'Non-threaded default 30d reply note', ${chId}::uuid, NULL, ${explicit3dAskId}::uuid, ${iso(inReplyToNoteUntil)}::timestamptz, ${iso(inReplyToNoteCreated)}::timestamptz),
          (${clampedReplyOn7dAskId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Default-clamped reply on 7d ask', ${chId}::uuid, ${default7dAskId}::uuid, NULL, ${iso(default7dAskUntil)}::timestamptz, ${iso(clampedOn7dCreated)}::timestamptz),
          (${explicit1dReplyOn7dAskId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Explicit 1d reply on 7d ask', ${chId}::uuid, ${default7dAskId}::uuid, NULL, ${iso(explicit1dOn7dUntil)}::timestamptz, ${iso(explicit1dOn7dCreated)}::timestamptz),
          (${workingOnClampedReplyId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', NULL, NULL, 'working-on', 'Working-on reply clamped to 7d ask', ${chId}::uuid, ${default7dSoonAskId}::uuid, NULL, ${iso(default7dSoonUntil)}::timestamptz, ${iso(workingOnClampedCreated)}::timestamptz),
          (${clampedReplyOn30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Default-clamped reply on 30d note', ${chId}::uuid, ${default30dNoteId}::uuid, NULL, ${iso(default30dNoteUntil)}::timestamptz, ${iso(clampedOn30dCreated)}::timestamptz),
          (${default7dAskReplyOn30dNoteId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, NULL, 'ask', 'Default 7d ask reply on 30d note?', ${chId}::uuid, ${default30dNoteId}::uuid, NULL, ${iso(askReplyOn30dUntil)}::timestamptz, ${iso(askReplyOn30dCreated)}::timestamptz),
          (${expiredClampedReplyId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Expired clamped reply on expired 30d note', ${chId}::uuid, ${expiredDefault30dNoteId}::uuid, NULL, ${iso(expiredNoteUntil)}::timestamptz, ${iso(expiredReplyCreated)}::timestamptz),
          (${explicit7dReplyOnPermRootId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, NULL, 'ask', 'Explicit 7d ask on post-C6 permanent root?', ${chId}::uuid, ${postC6PermRootId}::uuid, NULL, ${iso(explicit7dOnPermUntil)}::timestamptz, ${iso(explicit7dOnPermCreated)}::timestamptz)
      `;

      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      const fetchUntilMap = async (): Promise<Map<string, number>> => {
        const rows = await tx<{ id: string; until_iso: string }[]>`
          SELECT id::text AS id, until::text AS until_iso
          FROM swarm.signals
          WHERE workspace_id = ${wsId}::uuid
        `;
        return new Map(rows.map((r) => [r.id, Date.parse(r.until_iso)]));
      };

      // Run the exact migration SQL.
      await tx.unsafe(MIGRATION_SQL);

      const assertExpectedState = (untilById: Map<string, number>, phase: string) => {
        // Promoted to permanent:
        assert.equal(untilById.get(default7dAskId), PERMANENT_UNTIL_MS, `${phase}: default 7d open ask becomes permanent`);
        assert.equal(untilById.get(default7dSoonAskId), PERMANENT_UNTIL_MS, `${phase}: default 7d open ask expiring soon becomes permanent`);
        assert.equal(untilById.get(default30dNoteId), PERMANENT_UNTIL_MS, `${phase}: default 30d open note becomes permanent`);
        assert.equal(untilById.get(default30dInReplyToNoteId), PERMANENT_UNTIL_MS, `${phase}: non-threaded default 30d in_reply_to note becomes permanent`);
        assert.equal(untilById.get(clampedReplyOn7dAskId), PERMANENT_UNTIL_MS, `${phase}: default-clamped reply on 7d ask becomes permanent`);
        assert.equal(untilById.get(clampedReplyOn30dNoteId), PERMANENT_UNTIL_MS, `${phase}: default-clamped reply on 30d note becomes permanent`);
        assert.equal(untilById.get(default7dAskReplyOn30dNoteId), PERMANENT_UNTIL_MS, `${phase}: default 7d ask reply on 30d note becomes permanent`);
        assert.equal(untilById.get(postC6PermRootId), PERMANENT_UNTIL_MS, `${phase}: post-C6 permanent root stays permanent`);

        // Left untouched:
        assert.equal(untilById.get(explicit3dAskId), explicit3dAskUntil, `${phase}: explicit 3d ask stays at 3d`);
        assert.equal(untilById.get(clampedReplyOnExplicit3dAskId), explicit3dAskUntil, `${phase}: reply clamped to explicit 3d ask stays at 3d`);
        assert.equal(untilById.get(explicit1dReplyOn7dAskId), explicit1dOn7dUntil, `${phase}: explicit 1d reply on 7d ask stays at 1d`);
        assert.equal(untilById.get(expiredDefault7dAskId), expiredAskUntil, `${phase}: already-expired default 7d ask stays expired`);
        assert.equal(untilById.get(expiredDefault30dNoteId), expiredNoteUntil, `${phase}: already-expired default 30d note stays expired`);
        assert.equal(untilById.get(expiredClampedReplyId), expiredNoteUntil, `${phase}: expired clamped reply stays expired`);
        assert.equal(untilById.get(workingOnStandaloneId), workingOnStandaloneUntil, `${phase}: standalone working-on stays untouched`);
        assert.equal(untilById.get(workingOnClampedReplyId), default7dSoonUntil, `${phase}: working-on reply clamped to default 7d ask stays untouched`);
        assert.equal(untilById.get(explicit7dReplyOnPermRootId), explicit7dOnPermUntil, `${phase}: explicit 7d reply on post-C6 permanent root stays untouched`);
      };

      assertExpectedState(await fetchUntilMap(), "first run");

      // signals_append_only MUST be enabled and refuse ordinary UPDATEs immediately after the migration.
      await tx`SAVEPOINT sp_append_only`;
      await assert.rejects(
        () => tx`UPDATE swarm.signals SET body = 'tamper' WHERE id = ${default7dAskId}::uuid`,
        (err: { code?: string; message?: string }) =>
          err?.code === "55000" && String(err?.message ?? "").includes("SWARM_APPEND_ONLY"),
        "signals_append_only must be re-enabled immediately after migration",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_append_only`;

      // Idempotency: re-running the migration SQL leaves every row unchanged and keeps signals_append_only enabled.
      await tx.unsafe(MIGRATION_SQL);
      assertExpectedState(await fetchUntilMap(), "second run (idempotent)");

      await tx`SAVEPOINT sp_append_only_2`;
      await assert.rejects(
        () => tx`UPDATE swarm.signals SET body = 'tamper' WHERE id = ${default30dNoteId}::uuid`,
        (err: { code?: string; message?: string }) =>
          err?.code === "55000" && String(err?.message ?? "").includes("SWARM_APPEND_ONLY"),
        "signals_append_only must stay enabled after idempotent re-run",
      );
      await tx`ROLLBACK TO SAVEPOINT sp_append_only_2`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});
