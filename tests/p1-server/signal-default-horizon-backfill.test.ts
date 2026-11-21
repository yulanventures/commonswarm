/**
 * Real-Postgres proof for 20261120000007_signal_default_horizon_backfill.sql (to-do fcf69f45):
 *   - Condition 1: promotes a pre-C6 default-horizon root with sub-millisecond microsecond
 *     precision (.123456Z / .123987Z) AND its default-clamped reply stored with millisecond-
 *     truncated rootUntil (date_trunc('milliseconds', root.until) = .123000Z), matching edge
 *     postSignal's Date.prototype.toISOString() serialization.
 *   - Condition 2: fences old-default promotion strictly to pre-C6 writes (created_at < v_c6_cutoff)
 *     via BOTH earliest permanent signal AND commonswarm_ops.migration_checksums (20261120000003),
 *     leaving post-C6 top-level explicit 7d asks, post-C6 top-level explicit 30d notes, and
 *     post-C6 explicit 7d ask replies on pre-C6 30d note roots completely untouched.
 *   - Condition 3: real concurrent lock-wait race — a pre-C6 default-7d ask that is live when the
 *     migration starts waiting on SHARE ROW EXCLUSIVE, and expires while waiting for another
 *     transaction's ROW EXCLUSIVE lock, stays expired (never revived) once the lock clears.
 *   - Baseline witnesses: explicit 3d ask + its clamped reply stay at 3d; pre-C6 default 7d open
 *     ask, default 30d open note, non-threaded in_reply_to 30d note, and default-clamped replies
 *     become permanent; explicit 1d reply on 7d ask stays at 1d; already-expired rows stay expired;
 *     working-on signals stay untouched; signals_append_only stays enabled (55000 on UPDATE);
 *     re-running is idempotent.
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

const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
test.after(() => sql.end({ timeout: 5 }));

test("20261120000007 narrowed default-horizon backfill: sub-ms clamped replies, pre-C6 fence, explicit/expired controls, and idempotency", async () => {
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
        SELECT pg_catalog.clock_timestamp()::text AS now_iso
      `;
      const nowMs = Math.floor(Date.parse(clockRow!.now_iso) / 1000) * 1000;
      const MIN = 60 * 1000;
      const HOUR = 60 * MIN;
      const DAY = 24 * HOUR;
      const iso = (ms: number) => new Date(ms).toISOString();
      const isoMicro = (ms: number, micro: string) =>
        new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${micro}Z`);

      // Witness IDs
      const explicit3dAskId = randomUUID();
      const clampedReplyOnExplicit3dAskId = randomUUID();
      const default30dInReplyToNoteId = randomUUID();

      // Condition 1: sub-millisecond pre-C6 default-7d ask root + ms-truncated clamped reply
      const subMsDefault7dAskId = randomUUID();
      const msTruncClampedReplyOn7dAskId = randomUUID();
      const explicit1dReplyOn7dAskId = randomUUID();

      const default7dSoonAskId = randomUUID();
      const workingOnClampedReplyId = randomUUID();

      // Pre-C6 default-30d note root with sub-ms precision (.789987Z) + ms-truncated clamped reply (.789000Z)
      const default30dNoteId = randomUUID();
      const msTruncClampedReplyOn30dNoteId = randomUUID();
      const preC6Default7dAskReplyOn30dNoteId = randomUUID();
      const postC6Explicit7dAskReplyOn30dNoteId = randomUUID();

      const expiredDefault7dAskId = randomUUID();
      const expiredDefault30dNoteId = randomUUID();
      const expiredClampedReplyId = randomUUID();

      const workingOnStandaloneId = randomUUID();

      // Condition 2: post-C6 permanent root at T_c6 = now - 30m, plus post-C6 explicit 7d ask & 30d note at now - 20m
      const postC6PermRootId = randomUUID();
      const postC6Explicit7dTopAskId = randomUUID();
      const postC6Explicit30dTopNoteId = randomUUID();
      const explicit7dReplyOnPermRootId = randomUUID();

      // Timestamps (C6 boundary at now - 30m via postC6PermRootId)
      const explicit3dAskCreated = nowMs - 1 * DAY;
      const explicit3dAskUntil = explicit3dAskCreated + 3 * DAY;
      const clampedOn3dCreated = nowMs - 2 * HOUR;

      const subMsRootCreatedMs = nowMs - 2 * DAY;
      const subMsRootUntilMs = subMsRootCreatedMs + 7 * DAY;
      const subMsRootCreatedIso = isoMicro(subMsRootCreatedMs, "123456");
      const subMsRootUntilIso = isoMicro(subMsRootUntilMs, "123456");
      // Edge postSignal serializes rootUntil via Date.toISOString(), truncating .123456 -> .123000.
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
      const postC6AskReplyOn30dCreated = nowMs - 20 * MIN;
      const postC6AskReplyOn30dUntil = postC6AskReplyOn30dCreated + 7 * DAY;

      const inReplyToNoteCreated = nowMs - 2 * HOUR;
      const inReplyToNoteUntil = inReplyToNoteCreated + 30 * DAY;

      const expiredAskCreated = nowMs - 10 * DAY;
      const expiredAskUntil = expiredAskCreated + 7 * DAY;

      const expiredNoteCreated = nowMs - 40 * DAY;
      const expiredNoteUntil = expiredNoteCreated + 30 * DAY;
      const expiredReplyCreated = nowMs - 35 * DAY;

      const workingOnStandaloneCreated = nowMs - 2 * HOUR;
      const workingOnStandaloneUntil = workingOnStandaloneCreated + 1 * DAY;

      const postC6PermCreated = nowMs - 30 * MIN;
      const postC6Explicit7dCreated = nowMs - 20 * MIN;
      const postC6Explicit7dUntil = postC6Explicit7dCreated + 7 * DAY;
      const postC6Explicit30dCreated = nowMs - 20 * MIN;
      const postC6Explicit30dUntil = postC6Explicit30dCreated + 30 * DAY;
      const explicit7dOnPermCreated = nowMs - 15 * MIN;
      const explicit7dOnPermUntil = explicit7dOnPermCreated + 7 * DAY;

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
          (${workingOnStandaloneId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', NULL, 'working-on', 'Active working-on status', ${chId}::uuid, ${iso(workingOnStandaloneUntil)}::timestamptz, ${iso(workingOnStandaloneCreated)}::timestamptz),
          (${postC6PermRootId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 permanent root', ${chId}::uuid, ${PERMANENT_UNTIL_ISO}::timestamptz, ${iso(postC6PermCreated)}::timestamptz),
          (${postC6Explicit7dTopAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Post-C6 explicit 7d ask?', ${chId}::uuid, ${iso(postC6Explicit7dUntil)}::timestamptz, ${iso(postC6Explicit7dCreated)}::timestamptz),
          (${postC6Explicit30dTopNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-C6 explicit 30d note', ${chId}::uuid, ${iso(postC6Explicit30dUntil)}::timestamptz, ${iso(postC6Explicit30dCreated)}::timestamptz)
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
          (${postC6Explicit7dAskReplyOn30dNoteId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, NULL, 'ask', 'Post-C6 explicit 7d ask reply on 30d note?', ${chId}::uuid, ${default30dNoteId}::uuid, NULL, ${iso(postC6AskReplyOn30dUntil)}::timestamptz, ${iso(postC6AskReplyOn30dCreated)}::timestamptz),
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
        assert.equal(untilById.get(subMsDefault7dAskId), PERMANENT_UNTIL_MS, `${phase}: pre-C6 sub-ms default 7d open ask becomes permanent`);
        assert.equal(untilById.get(msTruncClampedReplyOn7dAskId), PERMANENT_UNTIL_MS, `${phase}: Condition 1 ms-truncated default-clamped reply on sub-ms 7d ask becomes permanent`);
        assert.equal(untilById.get(default7dSoonAskId), PERMANENT_UNTIL_MS, `${phase}: default 7d open ask expiring soon becomes permanent`);
        assert.equal(untilById.get(default30dNoteId), PERMANENT_UNTIL_MS, `${phase}: pre-C6 sub-ms default 30d open note becomes permanent`);
        assert.equal(untilById.get(msTruncClampedReplyOn30dNoteId), PERMANENT_UNTIL_MS, `${phase}: Condition 1 ms-truncated default-clamped reply on sub-ms 30d note becomes permanent`);
        assert.equal(untilById.get(default30dInReplyToNoteId), PERMANENT_UNTIL_MS, `${phase}: pre-C6 non-threaded default 30d in_reply_to note becomes permanent`);
        assert.equal(untilById.get(preC6Default7dAskReplyOn30dNoteId), PERMANENT_UNTIL_MS, `${phase}: pre-C6 default 7d ask reply on 30d note becomes permanent`);
        assert.equal(untilById.get(postC6PermRootId), PERMANENT_UNTIL_MS, `${phase}: post-C6 permanent root stays permanent`);

        // Left untouched (including Condition 2 post-C6 explicit 7d ask & 30d note controls!):
        assert.equal(untilById.get(postC6Explicit7dTopAskId), postC6Explicit7dUntil, `${phase}: Condition 2 post-C6 explicit 7d top-level ask stays untouched`);
        assert.equal(untilById.get(postC6Explicit30dTopNoteId), postC6Explicit30dUntil, `${phase}: Condition 2 post-C6 explicit 30d top-level note stays untouched`);
        assert.equal(untilById.get(postC6Explicit7dAskReplyOn30dNoteId), postC6AskReplyOn30dUntil, `${phase}: Condition 2 post-C6 explicit 7d ask reply on pre-C6 30d note stays untouched`);
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
        () => tx`UPDATE swarm.signals SET body = 'tamper' WHERE id = ${subMsDefault7dAskId}::uuid`,
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

      // Condition 2b: migration_checksums fence works even when ZERO permanent signals exist yet.
      await tx`SAVEPOINT sp_checksum_fence`;
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE swarm.signals SET until = created_at + interval '1 hour' WHERE until = ${PERMANENT_UNTIL_ISO}::timestamptz`;
      await tx`SET LOCAL session_replication_role = origin`;

      const checksumAtMs = nowMs - 45 * MIN;
      await tx`SET LOCAL ROLE commonswarm_admin_release`;
      await tx`
        INSERT INTO commonswarm_ops.migration_checksums (version, sha256, applied_at, source, released_sha)
        VALUES ('20261120000003', ${"a".repeat(64)}, ${iso(checksumAtMs)}::timestamptz, 'release', ${"b".repeat(40)})
        ON CONFLICT (version) DO NOTHING
      `;
      await tx`RESET ROLE`;

      const preChecksumAskId = randomUUID();
      const postChecksum7dAskId = randomUUID();
      const postChecksum30dNoteId = randomUUID();
      const preChecksumCreated = checksumAtMs - 10 * MIN;
      const preChecksumUntil = preChecksumCreated + 7 * DAY;
      const postChecksumCreated = checksumAtMs + 5 * MIN;
      const postChecksum7dUntil = postChecksumCreated + 7 * DAY;
      const postChecksum30dUntil = postChecksumCreated + 30 * DAY;

      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${preChecksumAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Pre-checksum 7d ask?', ${chId}::uuid, ${iso(preChecksumUntil)}::timestamptz, ${iso(preChecksumCreated)}::timestamptz),
          (${postChecksum7dAskId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Post-checksum explicit 7d ask?', ${chId}::uuid, ${iso(postChecksum7dUntil)}::timestamptz, ${iso(postChecksumCreated)}::timestamptz),
          (${postChecksum30dNoteId}::uuid, ${wsId}::uuid, ${ownerId}::uuid, 'user', NULL, 'note', 'Post-checksum explicit 30d note', ${chId}::uuid, ${iso(postChecksum30dUntil)}::timestamptz, ${iso(postChecksumCreated)}::timestamptz)
      `;
      await tx`RESET ROLE`;

      await tx.unsafe(MIGRATION_SQL);
      const afterChecksum = await fetchUntilMap();
      assert.equal(afterChecksum.get(preChecksumAskId), PERMANENT_UNTIL_MS, "pre-checksum 7d ask becomes permanent");
      assert.equal(afterChecksum.get(postChecksum7dAskId), postChecksum7dUntil, "post-checksum explicit 7d ask stays untouched with zero permanent rows");
      assert.equal(afterChecksum.get(postChecksum30dNoteId), postChecksum30dUntil, "post-checksum explicit 30d note stays untouched with zero permanent rows");
      await tx`ROLLBACK TO SAVEPOINT sp_checksum_fence`;

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

test("20261120000007 Condition 3: row expiring while migration waits on SHARE ROW EXCLUSIVE lock stays expired", async () => {
  const wsId = randomUUID();
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const chId = randomUUID();
  const expiringDuringWaitId = randomUUID();
  const liveControlId = randomUUID();
  const DAY = 24 * 60 * 60 * 1000;

  let expiringUntilMs = 0;

  try {
    // Seed committed rows in a temporary workspace so two independent connections can contend on swarm.signals.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO auth.users (id, email, aud, role, encrypted_password, email_confirmed_at, created_at, updated_at)
        VALUES (${ownerId}::uuid, ${`lock-owner-${ownerId}@example.test`}, 'authenticated', 'authenticated', '', now(), now(), now())
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES (${wsId}::uuid, 'Lock-race witness workspace', ${ownerId}::uuid)
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
        VALUES (${chId}::uuid, ${wsId}::uuid, 'lock-race', 'open', ${ownerId}::uuid, 'user')
      `;

      const [clockRow] = await tx<{ now_iso: string }[]>`
        SELECT pg_catalog.clock_timestamp()::text AS now_iso
      `;
      const t0 = Date.parse(clockRow!.now_iso);
      // Pre-C6 default-7d ask that is STILL LIVE at t0 (+350ms), and expires while migration waits on the lock (~750ms).
      expiringUntilMs = t0 + 350;
      const expiringCreatedMs = expiringUntilMs - 7 * DAY;
      const liveCreatedMs = t0 - 2 * DAY;
      const liveUntilMs = liveCreatedMs + 7 * DAY;

      await tx`SET LOCAL ROLE swarm_command`;
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until, created_at)
        VALUES
          (${expiringDuringWaitId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Expires while waiting on lock?', ${chId}::uuid, ${new Date(expiringUntilMs).toISOString()}::timestamptz, ${new Date(expiringCreatedMs).toISOString()}::timestamptz),
          (${liveControlId}::uuid, ${wsId}::uuid, ${agentId}::uuid, 'agent', ${ownerId}::uuid, 'ask', 'Still live after lock clears?', ${chId}::uuid, ${new Date(liveUntilMs).toISOString()}::timestamptz, ${new Date(liveCreatedMs).toISOString()}::timestamptz)
      `;
      await tx`RESET ROLE`;
    });

    // Connection 1 holds ROW EXCLUSIVE on swarm.signals (conflicting with ALTER TABLE ... DISABLE TRIGGER's SHARE ROW EXCLUSIVE).
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });
    let releaseLock!: () => void;
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const holder = sql.begin(async (txHold) => {
      await txHold`LOCK TABLE swarm.signals IN ROW EXCLUSIVE MODE`;
      signalLockHeld();
      await lockRelease;
    });

    await lockHeld;

    // Connection 2 starts running the migration while expiringDuringWaitId is STILL LIVE (+350ms),
    // and blocks waiting on SHARE ROW EXCLUSIVE.
    const migrationPromise = sql.begin(async (txMig) => {
      await txMig.unsafe(MIGRATION_SQL);
    });

    // Wait until well past expiringUntilMs (+750ms) so the row expires strictly DURING the lock wait,
    // then release the blocking lock so the migration proceeds.
    await new Promise((resolve) => setTimeout(resolve, 750));
    releaseLock();

    await Promise.all([holder, migrationPromise]);

    const rows = await sql<{ id: string; until_iso: string }[]>`
      SELECT id::text AS id, until::text AS until_iso
      FROM swarm.signals
      WHERE workspace_id = ${wsId}::uuid
    `;
    const byId = new Map(rows.map((r) => [r.id, Date.parse(r.until_iso)]));
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
  } finally {
    // Clean up committed test rows cleanly inside one transaction, leaving triggers intact.
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
      await txClean`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;
      await txClean`SET LOCAL session_replication_role = origin`;
    });
  }
});
