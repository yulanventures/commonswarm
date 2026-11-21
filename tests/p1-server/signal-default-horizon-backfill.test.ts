/**
 * Real-Postgres proof for 20261120000007_signal_default_horizon_backfill.sql (to-do fcf69f45):
 *   - Test 1 (Same-release W1 pre-edge path + sub-ms clamped replies + explicit/expired controls +
 *     fail-closed rerun with zero permanent rows and no checksum):
 *       * Promotes pre-C6 sub-ms default 7d ask (.123456Z) + ms-truncated clamped reply (.123000Z),
 *         pre-C6 sub-ms default 30d note (.789987Z) + ms-truncated clamped reply (.789000Z),
 *         pre-C6 default 7d ask reply on 30d note, non-threaded default 30d in_reply_to note.
 *       * Preserves explicit 3d ask + clamped reply, explicit 1d reply on 7d ask, already-expired
 *         rows, and working-on signals.
 *       * Keeps signals_append_only enabled (55000 on UPDATE).
 *       * Once 20261120000007 is recorded in schema_migrations, re-running fails closed (0 updates)
 *         even when ZERO permanent rows and NO checksum exist, leaving post-C6 explicit 7d/30d
 *         top-level rows untouched.
 *   - Test 2 (Condition 1 fail-closed without trusted checksum):
 *       * Missing checksum + permanent signal present -> fails closed (0 updates), leaving
 *         ambiguous rows AND explicit post-C6 7d/30d writes written BEFORE the first permanent row
 *         completely untouched, with signals_append_only restored.
 *       * Non-'release' ('backfill') checksum row -> fails closed (0 updates) even with zero
 *         permanent signals.
 *   - Test 3 (Condition 1 trusted 'release' checksum boundary + Condition 2 reply creation-time fence):
 *       * With trusted source='release' checksum for 20261120000003 at T_c6, promotes pre-C6 roots
 *         and pre-C6 clamped replies (both exact root.until and ms-truncated date_trunc), while
 *         leaving untouched:
 *           - post-C6 explicit top-level 7d ask and 30d note,
 *           - post-C6 explicit reply on a promoted pre-C6 root whose until equals exact root.until,
 *           - post-C6 explicit reply on a promoted pre-C6 root whose until equals
 *             date_trunc('milliseconds', root.until),
 *           - post-C6 explicit 7d ask reply on a promoted pre-C6 30d note root.
 *   - Test 4 (Condition 3 deterministic, isolated two-connection lock-wait race witness):
 *       * Connection 1 holds ROW EXCLUSIVE on swarm.signals; Connection 2 runs MIGRATION_SQL inside
 *         a transaction that rolls back after assertions.
 *       * Observer queries pg_locks + pg_catalog.clock_timestamp() to confirm Connection 2 IS
 *         BLOCKED waiting on swarm.signals while expiringDuringWaitId is STILL LIVE, waits until
 *         Postgres clock_timestamp() passes expiringDuringWaitId's expiry while STILL blocked, then
 *         releases Connection 1.
 *       * Asserts inside Connection 2 that expiringDuringWaitId stayed expired and liveControlId
 *         became permanent, then rolls back Connection 2 (proving post-rollback that zero DB-wide
 *         updates survive outside its own cleaned-up fixture workspace).
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

function localClusterAdminUrl(dbUrl: string): string {
  const target = new URL(dbUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "local stack required");
  target.username = "supabase_admin";
  return target.toString();
}

const sql = postgres(localClusterAdminUrl(DATABASE_URL), { max: 5, onnotice: () => {} });
test.after(() => sql.end({ timeout: 5 }));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const isoMicro = (ms: number, micro: string) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${micro}Z`);

async function seedWorkspace(
  tx: postgres.TransactionSql,
  label: string,
): Promise<{ wsId: string; ownerId: string; agentId: string; chId: string }> {
  const wsId = randomUUID();
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const chId = randomUUID();

  await tx`
    INSERT INTO auth.users (id, email, aud, role, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES (${ownerId}::uuid, ${`owner-${ownerId}@example.test`}, 'authenticated', 'authenticated', '', now(), now(), now())
  `;
  await tx`
    INSERT INTO swarm.users (user_id, display_name)
    VALUES (${ownerId}::uuid, 'Backfill witness owner')
    ON CONFLICT (user_id) DO NOTHING
  `;
  await tx`
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES (${wsId}::uuid, ${label}, ${ownerId}::uuid)
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

  return { wsId, ownerId, agentId, chId };
}

async function clearPreExistingPostC6EvidenceInTx(tx: postgres.TransactionSql): Promise<void> {
  // Simulate pre-000007 W1 state inside this rolled-back transaction only (never committed).
  await tx`DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261120000007'`;
  await tx`SET LOCAL session_replication_role = replica`;
  await tx`UPDATE swarm.signals SET until = created_at + interval '1 hour' WHERE until = ${PERMANENT_UNTIL_ISO}::timestamptz`;
  await tx`DELETE FROM commonswarm_ops.migration_checksums WHERE version = '20261120000003'`;
  await tx`SET LOCAL session_replication_role = origin`;
}

async function fetchUntilMap(tx: postgres.TransactionSql, wsId: string): Promise<Map<string, number>> {
  const rows = await tx<{ id: string; until_iso: string }[]>`
    SELECT id::text AS id, until::text AS until_iso
    FROM swarm.signals
    WHERE workspace_id = ${wsId}::uuid
  `;
  return new Map(rows.map((r) => [r.id, Date.parse(r.until_iso)]));
}

async function assertAppendOnlyEnabled(tx: postgres.TransactionSql, signalId: string, savepoint: string): Promise<void> {
  await tx.unsafe(`SAVEPOINT ${savepoint}`);
  await assert.rejects(
    () => tx`UPDATE swarm.signals SET body = 'tamper' WHERE id = ${signalId}::uuid`,
    (err: { code?: string; message?: string }) =>
      err?.code === "55000" && String(err?.message ?? "").includes("SWARM_APPEND_ONLY"),
    `${savepoint}: signals_append_only must be enabled and reject UPDATE`,
  );
  await tx.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}

test("20261120000007 W1 pre-edge path: sub-ms clamped replies, explicit/expired controls, and fail-closed rerun with zero permanent rows", async () => {
  const ROLLBACK_WITNESS = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await clearPreExistingPostC6EvidenceInTx(tx);
      const { wsId, ownerId, agentId, chId } = await seedWorkspace(tx, "Backfill W1 witness workspace");

      const [clockRow] = await tx<{ now_iso: string }[]>`
        SELECT pg_catalog.clock_timestamp()::text AS now_iso
      `;
      const nowMs = Math.floor(Date.parse(clockRow!.now_iso) / 1000) * 1000;

      const explicit3dAskId = randomUUID();
      const clampedReplyOnExplicit3dAskId = randomUUID();
      const default30dInReplyToNoteId = randomUUID();

      const subMsDefault7dAskId = randomUUID();
      const msTruncClampedReplyOn7dAskId = randomUUID();
      const explicit1dReplyOn7dAskId = randomUUID();

      const default7dSoonAskId = randomUUID();
      const workingOnClampedReplyId = randomUUID();

      const default30dNoteId = randomUUID();
      const msTruncClampedReplyOn30dNoteId = randomUUID();
      const preC6Default7dAskReplyOn30dNoteId = randomUUID();

      const expiredDefault7dAskId = randomUUID();
      const expiredDefault30dNoteId = randomUUID();
      const expiredClampedReplyId = randomUUID();
      const workingOnStandaloneId = randomUUID();

      const explicit3dAskCreated = nowMs - 1 * DAY;
      const explicit3dAskUntil = explicit3dAskCreated + 3 * DAY;
      const clampedOn3dCreated = nowMs - 2 * HOUR;

      const subMsRootCreatedMs = nowMs - 2 * DAY;
      const subMsRootUntilMs = subMsRootCreatedMs + 7 * DAY;
      const subMsRootCreatedIso = isoMicro(subMsRootCreatedMs, "123456");
      const subMsRootUntilIso = isoMicro(subMsRootUntilMs, "123456");
      const msTruncOn7dUntilIso = isoMicro(subMsRootUntilMs, "123000");
      const msTruncOn7dCreatedIso = iso(nowMs - 1 * DAY);
      const explicit1dOn7dCreated = nowMs - 2 * HOUR;
      const explicit1dOn7dUntil = explicit1dOn7dCreated + 1 * DAY;

      const default7dSoonCreated = nowMs - (6 * DAY + 20 * HOUR);
      const default7dSoonUntil = default7dSoonCreated + 7 * DAY;
      const workingOnClampedCreated = nowMs - 2 * HOUR;

      const note30dCreatedMs = nowMs - 5 * DAY;
      const note30dUntilMs = note30dCreatedMs + 30 * DAY;
      const note30dCreatedIso = isoMicro(note30dCreatedMs, "789987");
      const note30dUntilIso = isoMicro(note30dUntilMs, "789987");
      const msTruncOn30dUntilIso = isoMicro(note30dUntilMs, "789000");
      const msTruncOn30dCreatedIso = iso(nowMs - 1 * DAY);
      const preC6AskReplyOn30dCreated = nowMs - 1 * DAY;
      const preC6AskReplyOn30dUntil = preC6AskReplyOn30dCreated + 7 * DAY;

      const inReplyToNoteCreated = nowMs - 2 * HOUR;
      const inReplyToNoteUntil = inReplyToNoteCreated + 30 * DAY;

      const expiredAskCreated = nowMs - 10 * DAY;
      const expiredAskUntil = expiredAskCreated + 7 * DAY;
      const expiredNoteCreated = nowMs - 40 * DAY;
      const expiredNoteUntil = expiredNoteCreated + 30 * DAY;
      const expiredReplyCreated = nowMs - 35 * DAY;

      const workingOnStandaloneCreated = nowMs - 2 * HOUR;
      const workingOnStandaloneUntil = workingOnStandaloneCreated + 1 * DAY;

      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;

      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${explicit3dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Explicit 3d ask?', ${chId}::uuid, ${iso(explicit3dAskUntil)}::timestamptz, ${iso(explicit3dAskCreated)}::timestamptz),
          (${subMsDefault7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Pre-C6 sub-ms default 7d open ask?', ${chId}::uuid, ${subMsRootUntilIso}::timestamptz, ${subMsRootCreatedIso}::timestamptz),
          (${default7dSoonAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Default 7d ask expiring soon?', ${chId}::uuid, ${iso(default7dSoonUntil)}::timestamptz, ${iso(default7dSoonCreated)}::timestamptz),
          (${default30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Pre-C6 sub-ms default 30d open note', ${chId}::uuid, ${note30dUntilIso}::timestamptz, ${note30dCreatedIso}::timestamptz),
          (${expiredDefault7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Already expired default 7d ask?', ${chId}::uuid, ${iso(expiredAskUntil)}::timestamptz, ${iso(expiredAskCreated)}::timestamptz),
          (${expiredDefault30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Already expired default 30d note', ${chId}::uuid, ${iso(expiredNoteUntil)}::timestamptz, ${iso(expiredNoteCreated)}::timestamptz),
          (${workingOnStandaloneId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', NULL, 'working-on', 'Active working-on status', ${chId}::uuid, ${iso(workingOnStandaloneUntil)}::timestamptz, ${iso(workingOnStandaloneCreated)}::timestamptz)
      `;

      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id, kind, body, channel_id, thread_root_id, in_reply_to, until, created_at)
        VALUES
          (${clampedReplyOnExplicit3dAskId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Clamped reply on explicit 3d ask', ${chId}::uuid, ${explicit3dAskId}::uuid, NULL, ${iso(explicit3dAskUntil)}::timestamptz, ${iso(clampedOn3dCreated)}::timestamptz),
          (${default30dInReplyToNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, ${agentId}::uuid, 'note', 'Pre-C6 non-threaded default 30d reply note', ${chId}::uuid, NULL, ${explicit3dAskId}::uuid, ${iso(inReplyToNoteUntil)}::timestamptz, ${iso(inReplyToNoteCreated)}::timestamptz),
          (${msTruncClampedReplyOn7dAskId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'MS-truncated default-clamped reply on sub-ms 7d ask', ${chId}::uuid, ${subMsDefault7dAskId}::uuid, NULL, ${msTruncOn7dUntilIso}::timestamptz, ${msTruncOn7dCreatedIso}::timestamptz),
          (${explicit1dReplyOn7dAskId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Explicit 1d reply on 7d ask', ${chId}::uuid, ${subMsDefault7dAskId}::uuid, NULL, ${iso(explicit1dOn7dUntil)}::timestamptz, ${iso(explicit1dOn7dCreated)}::timestamptz),
          (${workingOnClampedReplyId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', NULL, NULL, 'working-on', 'Working-on reply clamped to 7d ask', ${chId}::uuid, ${default7dSoonAskId}::uuid, NULL, ${iso(default7dSoonUntil)}::timestamptz, ${iso(workingOnClampedCreated)}::timestamptz),
          (${msTruncClampedReplyOn30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'MS-truncated default-clamped reply on sub-ms 30d note', ${chId}::uuid, ${default30dNoteId}::uuid, NULL, ${msTruncOn30dUntilIso}::timestamptz, ${msTruncOn30dCreatedIso}::timestamptz),
          (${preC6Default7dAskReplyOn30dNoteId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, NULL, 'ask', 'Pre-C6 default 7d ask reply on 30d note?', ${chId}::uuid, ${default30dNoteId}::uuid, NULL, ${iso(preC6AskReplyOn30dUntil)}::timestamptz, ${iso(preC6AskReplyOn30dCreated)}::timestamptz),
          (${expiredClampedReplyId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, NULL, 'note', 'Expired clamped reply on expired 30d note', ${chId}::uuid, ${expiredDefault30dNoteId}::uuid, NULL, ${iso(expiredNoteUntil)}::timestamptz, ${iso(expiredReplyCreated)}::timestamptz)
      `;

      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      await tx.unsafe(MIGRATION_SQL);

      const firstRun = await fetchUntilMap(tx, wsId);
      assert.equal(firstRun.get(subMsDefault7dAskId), PERMANENT_UNTIL_MS, "pre-C6 sub-ms default 7d open ask becomes permanent");
      assert.equal(firstRun.get(msTruncClampedReplyOn7dAskId), PERMANENT_UNTIL_MS, "ms-truncated default-clamped reply on sub-ms 7d ask becomes permanent");
      assert.equal(firstRun.get(default7dSoonAskId), PERMANENT_UNTIL_MS, "default 7d open ask expiring soon becomes permanent");
      assert.equal(firstRun.get(default30dNoteId), PERMANENT_UNTIL_MS, "pre-C6 sub-ms default 30d open note becomes permanent");
      assert.equal(firstRun.get(msTruncClampedReplyOn30dNoteId), PERMANENT_UNTIL_MS, "ms-truncated default-clamped reply on sub-ms 30d note becomes permanent");
      assert.equal(firstRun.get(default30dInReplyToNoteId), PERMANENT_UNTIL_MS, "pre-C6 non-threaded default 30d in_reply_to note becomes permanent");
      assert.equal(firstRun.get(preC6Default7dAskReplyOn30dNoteId), PERMANENT_UNTIL_MS, "pre-C6 default 7d ask reply on 30d note becomes permanent");

      assert.equal(firstRun.get(explicit3dAskId), explicit3dAskUntil, "explicit 3d ask stays at 3d");
      assert.equal(firstRun.get(clampedReplyOnExplicit3dAskId), explicit3dAskUntil, "reply clamped to explicit 3d ask stays at 3d");
      assert.equal(firstRun.get(explicit1dReplyOn7dAskId), explicit1dOn7dUntil, "explicit 1d reply on 7d ask stays at 1d");
      assert.equal(firstRun.get(expiredDefault7dAskId), expiredAskUntil, "already-expired default 7d ask stays expired");
      assert.equal(firstRun.get(expiredDefault30dNoteId), expiredNoteUntil, "already-expired default 30d note stays expired");
      assert.equal(firstRun.get(expiredClampedReplyId), expiredNoteUntil, "expired clamped reply stays expired");
      assert.equal(firstRun.get(workingOnStandaloneId), workingOnStandaloneUntil, "standalone working-on stays untouched");
      assert.equal(firstRun.get(workingOnClampedReplyId), default7dSoonUntil, "working-on reply clamped to default 7d ask stays untouched");

      await assertAppendOnlyEnabled(tx, subMsDefault7dAskId, "sp_w1_append_only");

      // Record 20261120000007 in schema_migrations (matching RELEASE-TO-BOX.md:2159), remove all
      // permanent signals (zero permanent rows, zero checksums), then insert post-C6 explicit
      // 7d/30d rows and re-run MIGRATION_SQL -> MUST fail closed and leave both untouched.
      await tx`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261120000007') ON CONFLICT (version) DO NOTHING`;
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE swarm.signals SET until = created_at + interval '1 hour' WHERE until = ${PERMANENT_UNTIL_ISO}::timestamptz`;
      await tx`SET LOCAL session_replication_role = origin`;

      const postRerunExplicit7dAskId = randomUUID();
      const postRerunExplicit30dNoteId = randomUUID();
      const postRerunCreated = nowMs - 5 * MIN;
      const postRerun7dUntil = postRerunCreated + 7 * DAY;
      const postRerun30dUntil = postRerunCreated + 30 * DAY;

      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${postRerunExplicit7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Post-release explicit 7d ask with zero permanent rows?', ${chId}::uuid, ${iso(postRerun7dUntil)}::timestamptz, ${iso(postRerunCreated)}::timestamptz),
          (${postRerunExplicit30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-release explicit 30d note with zero permanent rows', ${chId}::uuid, ${iso(postRerun30dUntil)}::timestamptz, ${iso(postRerunCreated)}::timestamptz)
      `;
      await tx`RESET ROLE`;

      await tx.unsafe(MIGRATION_SQL);
      const afterRerun = await fetchUntilMap(tx, wsId);
      assert.equal(afterRerun.get(postRerunExplicit7dAskId), postRerun7dUntil, "rerun with recorded 000007 and zero permanent rows leaves post-C6 explicit 7d ask untouched");
      assert.equal(afterRerun.get(postRerunExplicit30dNoteId), postRerun30dUntil, "rerun with recorded 000007 and zero permanent rows leaves post-C6 explicit 30d note untouched");
      await assertAppendOnlyEnabled(tx, postRerunExplicit7dAskId, "sp_rerun_append_only");

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

test("20261120000007 Condition 1 fail-closed: missing checksum with post-C6 write before first permanent row, and non-release checksum", async () => {
  const ROLLBACK_WITNESS = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await clearPreExistingPostC6EvidenceInTx(tx);
      const { wsId, ownerId, agentId, chId } = await seedWorkspace(tx, "Backfill fail-closed witness workspace");

      const [clockRow] = await tx<{ now_iso: string }[]>`
        SELECT pg_catalog.clock_timestamp()::text AS now_iso
      `;
      const nowMs = Math.floor(Date.parse(clockRow!.now_iso) / 1000) * 1000;

      // Case A: No checksum row for 20261120000003, AND explicit post-C6 7d/30d writes occurred
      // BEFORE the first permanent signal. Migration MUST fail closed (0 rows touched) instead of
      // inferring v_c6_cutoff from min(permanent).
      const preC6Ambiguous7dAskId = randomUUID();
      const postC6BeforeFirstPerm7dAskId = randomUUID();
      const postC6BeforeFirstPerm30dNoteId = randomUUID();
      const firstPermanentSignalId = randomUUID();

      const preCreated = nowMs - 2 * DAY;
      const preUntil = preCreated + 7 * DAY;
      const postBeforePerm7dCreated = nowMs - 2 * HOUR;
      const postBeforePerm7dUntil = postBeforePerm7dCreated + 7 * DAY;
      const postBeforePerm30dCreated = nowMs - 1 * HOUR;
      const postBeforePerm30dUntil = postBeforePerm30dCreated + 30 * DAY;
      const firstPermCreated = nowMs - 10 * MIN;

      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${preC6Ambiguous7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Ambiguous 7d ask without trusted cutoff?', ${chId}::uuid, ${iso(preUntil)}::timestamptz, ${iso(preCreated)}::timestamptz),
          (${postC6BeforeFirstPerm7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Post-C6 explicit 7d ask written BEFORE first permanent signal?', ${chId}::uuid, ${iso(postBeforePerm7dUntil)}::timestamptz, ${iso(postBeforePerm7dCreated)}::timestamptz),
          (${postC6BeforeFirstPerm30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 explicit 30d note written BEFORE first permanent signal', ${chId}::uuid, ${iso(postBeforePerm30dUntil)}::timestamptz, ${iso(postBeforePerm30dCreated)}::timestamptz),
          (${firstPermanentSignalId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'First permanent signal written after explicit post-C6 writes', ${chId}::uuid, ${PERMANENT_UNTIL_ISO}::timestamptz, ${iso(firstPermCreated)}::timestamptz)
      `;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      await tx.unsafe(MIGRATION_SQL);

      const afterMissingChecksum = await fetchUntilMap(tx, wsId);
      assert.equal(afterMissingChecksum.get(preC6Ambiguous7dAskId), preUntil, "missing checksum + permanent row fails closed (leaves ambiguous row untouched)");
      assert.equal(afterMissingChecksum.get(postC6BeforeFirstPerm7dAskId), postBeforePerm7dUntil, "post-C6 explicit 7d ask BEFORE first permanent row stays untouched");
      assert.equal(afterMissingChecksum.get(postC6BeforeFirstPerm30dNoteId), postBeforePerm30dUntil, "post-C6 explicit 30d note BEFORE first permanent row stays untouched");
      assert.equal(afterMissingChecksum.get(firstPermanentSignalId), PERMANENT_UNTIL_MS, "first permanent row stays permanent");
      await assertAppendOnlyEnabled(tx, postC6BeforeFirstPerm7dAskId, "sp_fail_closed_perm");

      // Case B: Zero permanent rows, but commonswarm_ops.migration_checksums holds a source='backfill'
      // row for 20261120000003 (not a pre-edge release timestamp) -> MUST fail closed (0 updates).
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE swarm.signals SET until = created_at + interval '1 hour' WHERE until = ${PERMANENT_UNTIL_ISO}::timestamptz`;
      await tx`SET LOCAL session_replication_role = origin`;

      await tx`SET LOCAL ROLE commonswarm_admin_release`;
      await tx`
        INSERT INTO commonswarm_ops.migration_checksums (version, sha256, applied_at, source, released_sha)
        VALUES ('20261120000003', ${"c".repeat(64)}, ${iso(nowMs - 5 * MIN)}::timestamptz, 'backfill', ${"d".repeat(40)})
      `;
      await tx`RESET ROLE`;

      await tx.unsafe(MIGRATION_SQL);
      const afterBackfillChecksum = await fetchUntilMap(tx, wsId);
      assert.equal(afterBackfillChecksum.get(preC6Ambiguous7dAskId), preUntil, "source='backfill' checksum fails closed (0 updates)");
      assert.equal(afterBackfillChecksum.get(postC6BeforeFirstPerm7dAskId), postBeforePerm7dUntil, "source='backfill' checksum leaves post-C6 explicit 7d ask untouched");
      await assertAppendOnlyEnabled(tx, preC6Ambiguous7dAskId, "sp_fail_closed_backfill_src");

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

test("20261120000007 Condition 1 & 2: trusted release checksum boundary fences BOTH top-level rows AND post-C6 ceiling-equality replies", async () => {
  const ROLLBACK_WITNESS = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await clearPreExistingPostC6EvidenceInTx(tx);
      const { wsId, ownerId, agentId, chId } = await seedWorkspace(tx, "Backfill checksum+reply fence witness");

      const [clockRow] = await tx<{ now_iso: string }[]>`
        SELECT pg_catalog.clock_timestamp()::text AS now_iso
      `;
      const nowMs = Math.floor(Date.parse(clockRow!.now_iso) / 1000) * 1000;
      const checksumAtMs = nowMs - 45 * MIN;

      await tx`SET LOCAL ROLE commonswarm_admin_release`;
      await tx`
        INSERT INTO commonswarm_ops.migration_checksums (version, sha256, applied_at, source, released_sha)
        VALUES ('20261120000003', ${"a".repeat(64)}, ${iso(checksumAtMs)}::timestamptz, 'release', ${"b".repeat(40)})
      `;
      await tx`RESET ROLE`;

      // Pre-C6 roots (sub-ms 7d ask and exact-ms 30d note)
      const preRoot7dId = randomUUID();
      const preRoot30dId = randomUUID();
      // Pre-C6 clamped replies (must be promoted)
      const preReplyMsTruncOn7dId = randomUUID();
      const preReplyExactOn30dId = randomUUID();
      // Condition 2 controls: POST-C6 explicit replies on those SAME promoted pre-C6 roots whose
      // explicit --until equals date_trunc('milliseconds', root.until) or exact root.until!
      const postC6ReplyMsTruncCeilingOn7dId = randomUUID();
      const postC6ReplyExactCeilingOn7dId = randomUUID();
      const postC6ReplyExactCeilingOn30dId = randomUUID();
      const postC6Reply7dDurationOn30dId = randomUUID();
      // Post-C6 explicit top-level ask & note
      const postC6Top7dAskId = randomUUID();
      const postC6Top30dNoteId = randomUUID();

      const preRoot7dCreatedMs = nowMs - 2 * DAY;
      const preRoot7dUntilMs = preRoot7dCreatedMs + 7 * DAY;
      const preRoot7dCreatedIso = isoMicro(preRoot7dCreatedMs, "123456");
      const preRoot7dUntilIso = isoMicro(preRoot7dUntilMs, "123456");
      const preRoot7dMsTruncUntilIso = isoMicro(preRoot7dUntilMs, "123000");

      const preRoot30dCreatedMs = nowMs - 5 * DAY;
      const preRoot30dUntilMs = preRoot30dCreatedMs + 30 * DAY;

      const preReplyCreatedMs = nowMs - 1 * DAY;
      const postC6CreatedMs = checksumAtMs + 10 * MIN;
      const postC6Top7dUntil = postC6CreatedMs + 7 * DAY;
      const postC6Top30dUntil = postC6CreatedMs + 30 * DAY;
      const postC6Reply7dUntil = postC6CreatedMs + 7 * DAY;

      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${preRoot7dId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Pre-C6 sub-ms 7d root?', ${chId}::uuid, ${preRoot7dUntilIso}::timestamptz, ${preRoot7dCreatedIso}::timestamptz),
          (${preRoot30dId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Pre-C6 30d root', ${chId}::uuid, ${iso(preRoot30dUntilMs)}::timestamptz, ${iso(preRoot30dCreatedMs)}::timestamptz),
          (${postC6Top7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Post-C6 explicit 7d ask?', ${chId}::uuid, ${iso(postC6Top7dUntil)}::timestamptz, ${iso(postC6CreatedMs)}::timestamptz),
          (${postC6Top30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 explicit 30d note', ${chId}::uuid, ${iso(postC6Top30dUntil)}::timestamptz, ${iso(postC6CreatedMs)}::timestamptz)
      `;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, thread_root_id, until, created_at)
        VALUES
          (${preReplyMsTruncOn7dId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Pre-C6 ms-truncated clamped reply', ${chId}::uuid, ${preRoot7dId}::uuid, ${preRoot7dMsTruncUntilIso}::timestamptz, ${iso(preReplyCreatedMs)}::timestamptz),
          (${preReplyExactOn30dId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Pre-C6 exact-ceiling clamped reply', ${chId}::uuid, ${preRoot30dId}::uuid, ${iso(preRoot30dUntilMs)}::timestamptz, ${iso(preReplyCreatedMs)}::timestamptz),
          (${postC6ReplyMsTruncCeilingOn7dId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 explicit reply matching ms-truncated root ceiling', ${chId}::uuid, ${preRoot7dId}::uuid, ${preRoot7dMsTruncUntilIso}::timestamptz, ${iso(postC6CreatedMs)}::timestamptz),
          (${postC6ReplyExactCeilingOn7dId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 explicit reply matching exact root ceiling', ${chId}::uuid, ${preRoot7dId}::uuid, ${preRoot7dUntilIso}::timestamptz, ${iso(postC6CreatedMs)}::timestamptz),
          (${postC6ReplyExactCeilingOn30dId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 explicit reply matching exact 30d root ceiling', ${chId}::uuid, ${preRoot30dId}::uuid, ${iso(preRoot30dUntilMs)}::timestamptz, ${iso(postC6CreatedMs)}::timestamptz),
          (${postC6Reply7dDurationOn30dId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Post-C6 explicit 7d ask reply on pre-C6 30d root?', ${chId}::uuid, ${preRoot30dId}::uuid, ${iso(postC6Reply7dUntil)}::timestamptz, ${iso(postC6CreatedMs)}::timestamptz)
      `;
      await tx`RESET ROLE`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;

      await tx.unsafe(MIGRATION_SQL);
      const result = await fetchUntilMap(tx, wsId);

      // Promoted pre-C6 roots and pre-C6 replies:
      assert.equal(result.get(preRoot7dId), PERMANENT_UNTIL_MS, "pre-C6 7d root promoted");
      assert.equal(result.get(preRoot30dId), PERMANENT_UNTIL_MS, "pre-C6 30d root promoted");
      assert.equal(result.get(preReplyMsTruncOn7dId), PERMANENT_UNTIL_MS, "pre-C6 ms-truncated clamped reply promoted");
      assert.equal(result.get(preReplyExactOn30dId), PERMANENT_UNTIL_MS, "pre-C6 exact-ceiling clamped reply promoted");

      // Condition 2 controls — EVERY post-C6 reply (including ceiling-equality!) MUST stay untouched:
      assert.equal(
        result.get(postC6ReplyMsTruncCeilingOn7dId),
        Date.parse(preRoot7dMsTruncUntilIso),
        "Condition 2: post-C6 explicit reply matching date_trunc(ms, root.until) MUST stay untouched",
      );
      assert.equal(
        result.get(postC6ReplyExactCeilingOn7dId),
        Date.parse(preRoot7dUntilIso),
        "Condition 2: post-C6 explicit reply matching exact root.until MUST stay untouched",
      );
      assert.equal(
        result.get(postC6ReplyExactCeilingOn30dId),
        preRoot30dUntilMs,
        "Condition 2: post-C6 explicit reply matching exact 30d root.until MUST stay untouched",
      );
      assert.equal(
        result.get(postC6Reply7dDurationOn30dId),
        postC6Reply7dUntil,
        "Condition 2: post-C6 explicit 7d ask reply on pre-C6 30d root MUST stay untouched",
      );
      assert.equal(result.get(postC6Top7dAskId), postC6Top7dUntil, "post-C6 explicit 7d top-level ask stays untouched");
      assert.equal(result.get(postC6Top30dNoteId), postC6Top30dUntil, "post-C6 explicit 30d top-level note stays untouched");

      await assertAppendOnlyEnabled(tx, preRoot7dId, "sp_checksum_append_only");
      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

test("20261120000007 Condition 3: deterministic lock-wait expiry race observed via pg_locks and rolled back cleanly", async () => {
  const ROLLBACK_WITNESS = Symbol("rollback_lock_witness");
  let wsId = "";
  let ownerId = "";
  const expiringDuringWaitId = randomUUID();
  const liveControlId = randomUUID();

  let expiringUntilMs = 0;
  let expiringUntilIso = "";
  let liveUntilMs = 0;

  let releaseLock!: () => void;
  const lockRelease = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  try {
    // Seed committed rows in a temporary workspace so two independent connections can contend on swarm.signals.
    await sql.begin(async (tx) => {
      const seeded = await seedWorkspace(tx, "Lock-race witness workspace");
      wsId = seeded.wsId;
      ownerId = seeded.ownerId;

      const [clockRow] = await tx<{ now_iso: string }[]>`
        SELECT pg_catalog.clock_timestamp()::text AS now_iso
      `;
      const t0 = Date.parse(clockRow!.now_iso);
      // Generous 2500ms window so even a loaded CI runner observes Connection 2 blocked in pg_locks
      // while expiringDuringWaitId is demonstrably still live on Postgres's clock.
      expiringUntilMs = t0 + 2500;
      expiringUntilIso = iso(expiringUntilMs);
      const expiringCreatedMs = expiringUntilMs - 7 * DAY;
      const liveCreatedMs = t0 - 2 * DAY;
      liveUntilMs = liveCreatedMs + 7 * DAY;

      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${expiringDuringWaitId}::uuid, ${wsId}::uuid, ${seeded.agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Expires while waiting on lock?', ${seeded.chId}::uuid, ${expiringUntilIso}::timestamptz, ${iso(expiringCreatedMs)}::timestamptz),
          (${liveControlId}::uuid, ${wsId}::uuid, ${seeded.agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Still live after lock clears?', ${seeded.chId}::uuid, ${iso(liveUntilMs)}::timestamptz, ${iso(liveCreatedMs)}::timestamptz)
      `;
      await tx`RESET ROLE`;
    });

    // Connection 1 holds ROW EXCLUSIVE on swarm.signals (conflicting with ALTER TABLE ... DISABLE TRIGGER's SHARE ROW EXCLUSIVE).
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });

    const holder = sql.begin(async (txHold) => {
      await txHold`LOCK TABLE swarm.signals IN ROW EXCLUSIVE MODE`;
      signalLockHeld();
      await lockRelease;
    });

    await lockHeld;

    // Connection 2 prepares the pre-edge W1 state inside its own transaction (all rolled back at
    // the end), publishes its pg_backend_pid(), then runs MIGRATION_SQL and blocks on the lock.
    let resolveMigPid!: (pid: number) => void;
    const migPidPromise = new Promise<number>((resolve) => {
      resolveMigPid = resolve;
    });

    let migAssertionsRan = false;
    const migrationPromise = (async () => {
      try {
        await sql.begin(async (txMig) => {
          await clearPreExistingPostC6EvidenceInTx(txMig);
          const [pidRow] = await txMig<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
          resolveMigPid(pidRow!.pid);

          await txMig.unsafe(MIGRATION_SQL);

          // Assert outcomes INSIDE the migration transaction, then roll back so zero DB-wide
          // updates survive to any other workspace or server test!
          const byId = await fetchUntilMap(txMig, wsId);
          assert.equal(
            byId.get(expiringDuringWaitId),
            expiringUntilMs,
            "row that expired while migration waited on SHARE ROW EXCLUSIVE lock MUST stay expired (never revived)",
          );
          assert.equal(
            byId.get(liveControlId),
            PERMANENT_UNTIL_MS,
            "control row still unexpired after lock acquisition MUST become permanent",
          );
          const [trigRow] = await txMig<{ tgenabled: string }[]>`
            SELECT t.tgenabled::text AS tgenabled
            FROM pg_catalog.pg_trigger AS t
            WHERE t.tgrelid = 'swarm.signals'::regclass
              AND t.tgname = 'signals_append_only'
              AND NOT t.tgisinternal
          `;
          assert.equal(trigRow?.tgenabled, "O", "signals_append_only must be origin-enabled inside migration tx");
          migAssertionsRan = true;

          throw ROLLBACK_WITNESS;
        });
      } catch (err) {
        if (err !== ROLLBACK_WITNESS) throw err;
      }
    })();

    const migPid = await migPidPromise;

    // Step 1: Observe Connection 2 ACTUALLY BLOCKED in pg_locks on swarm.signals while Postgres
    // clock_timestamp() still sees expiringDuringWaitId as LIVE.
    let observedBlockedWhileLive = false;
    const blockDeadline = Date.now() + 5000;
    while (Date.now() < blockDeadline) {
      const [obs] = await sql<{ is_blocked: boolean; still_live: boolean }[]>`
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_locks AS l
            WHERE l.pid = ${migPid}::int
              AND l.relation = 'swarm.signals'::regclass
              AND NOT l.granted
          ) AS is_blocked,
          (pg_catalog.clock_timestamp() < ${expiringUntilIso}::timestamptz) AS still_live
      `;
      if (obs?.is_blocked) {
        assert.equal(
          obs.still_live,
          true,
          "migration backend must be observed blocked on swarm.signals WHILE expiringDuringWaitId is still live",
        );
        observedBlockedWhileLive = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      observedBlockedWhileLive,
      true,
      "timed out waiting to observe migration backend blocked on swarm.signals while candidate was live",
    );

    // Step 2: Keep holding the lock until Postgres clock_timestamp() is strictly past expiringUntilIso,
    // verifying the migration backend is STILL blocked right before releasing Connection 1.
    let observedExpiredWhileBlocked = false;
    const expiryDeadline = Date.now() + 6000;
    while (Date.now() < expiryDeadline) {
      const [obs] = await sql<{ is_blocked: boolean; expired_now: boolean }[]>`
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_locks AS l
            WHERE l.pid = ${migPid}::int
              AND l.relation = 'swarm.signals'::regclass
              AND NOT l.granted
          ) AS is_blocked,
          (pg_catalog.clock_timestamp() > ${expiringUntilIso}::timestamptz + interval '50 milliseconds') AS expired_now
      `;
      if (obs?.expired_now) {
        assert.equal(obs.is_blocked, true, "migration backend must still be blocked when row expires");
        observedExpiredWhileBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      observedExpiredWhileBlocked,
      true,
      "timed out waiting for candidate row to expire while migration backend remained blocked",
    );

    releaseLock();
    await Promise.all([holder, migrationPromise]);
    assert.equal(migAssertionsRan, true, "migration transaction assertions must have executed");

    // Verify rollback isolation: liveControlId outside the rolled-back migration tx is still at its
    // original finite horizon, proving zero DB-wide writes escaped into the shared database.
    const postRollback = await sql<{ id: string; until_iso: string }[]>`
      SELECT id::text AS id, until::text AS until_iso
      FROM swarm.signals
      WHERE workspace_id = ${wsId}::uuid
    `;
    const postById = new Map(postRollback.map((r) => [r.id, Date.parse(r.until_iso)]));
    assert.equal(
      postById.get(liveControlId),
      liveUntilMs,
      "migration transaction rollback must leave zero committed DB-wide updates behind",
    );
  } finally {
    releaseLock();
    if (wsId && ownerId) {
      await sql.begin(async (txClean) => {
        await txClean`SET LOCAL session_replication_role = replica`;
        await txClean`DELETE FROM swarm.signal_deliveries WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.conversation_signals WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.conversation_reads WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.conversation_members WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.signals WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.conversations WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.channels WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.agent_workspace_memberships WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.agent_principals WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.memberships WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.workspaces WHERE workspace_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.org_memberships WHERE org_id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.organizations WHERE id = ${wsId}::uuid`;
        await txClean`DELETE FROM swarm.users WHERE user_id = ${ownerId}::uuid`;
        await txClean`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;
        await txClean`SET LOCAL session_replication_role = origin`;
      });
    }
  }
});
