-- C6 narrowed default-horizon backfill (to-do fcf69f45, follow-up to 20261120000003 / PR #706).
--
-- Product rationale & retention ruling (for security review):
--   The owner's product rule is "nothing a person sets up ever lapses" (C6 permanence). PR #706
--   made newly posted asks and notes permanent by default ('9999-12-31T23:59:59Z'::timestamptz)
--   while leaving pre-existing rows untouched so historical backfill could be reviewed on its own.
--   HezLead retention ruling for ambiguous pre-C6 rows: swarm.signals stores no separate
--   default-vs-explicit bit, so a pre-C6 row whose explicit --until exactly equals the old default
--   (168h for ask, 720h for note) or its default-horizon root's ceiling cannot be distinguished
--   from a default or default-clamped write. Under the owner's "nothing lapses" rule, those
--   pre-C6 rows are treated as defaults and promoted to permanent; extending them does no harm.
--
-- Release-order invariant & fail-closed pre-C6 boundary:
--   Live production verification (HezOps, 2026-11-21T00:15:53Z): production edge is pre-C6
--   (b3d9c68b), DB ledger count is 149 (latest 20261120000001), and neither 20261120000003 (#706)
--   nor 20261120000007 (#714) has been applied. In the CommonSwarm release sequence
--   (deploy/RELEASE-TO-BOX.md), W1 applies migrations 20261120000003 through 20261120000007 BEFORE
--   W2 deploys the C6 edge. Therefore no post-C6 row can exist when 20261120000007 first runs in W1.
--   This migration enforces that boundary fail-closed rather than inferring a cutoff from
--   min(permanent) (which could admit explicit finite post-C6 writes preceding the first permanent
--   write):
--     1. If '20261120000007' is already in supabase_migrations.schema_migrations (post-apply rerun),
--        skip all updates (0 rows touched) — even if zero permanent signals or checksum rows exist.
--     2. If commonswarm_ops.migration_checksums holds a trusted source='release' row for
--        '20261120000003' (written in the same transaction as 000003 before edge rollout), fence
--        BOTH roots AND replies strictly to created_at < least(v_now, applied_at).
--     3. If commonswarm_ops.migration_checksums holds a non-'release' row (e.g. 'backfill') for
--        '20261120000003', fail closed (0 rows touched) because applied_at is not a pre-edge bound.
--     4. If NO checksum row exists and ANY permanent signal ('9999-12-31T23:59:59Z') already exists
--        in swarm.signals, fail closed (0 rows touched) — direct post-C6 writer evidence without a
--        trusted pre-edge cutoff.
--     5. Only when 000007 is not yet recorded, no checksum row exists, and zero permanent signals
--        exist (the same-release W1 pre-edge path) does the migration treat all rows created before
--        post-lock v_now as pre-C6 (v_c6_cutoff := v_now).
--
-- Narrowed backfill rules:
--   1. Lock first, then sample liveness: ALTER TABLE swarm.signals DISABLE TRIGGER acquires a
--      SHARE ROW EXCLUSIVE lock on swarm.signals (blocking all concurrent INSERT/UPDATE/DELETE
--      writers until commit). Only AFTER that lock is held do we sample v_now via
--      pg_catalog.clock_timestamp() (not statement_timestamp() or now(), which freeze before the
--      lock wait), so any row that expires while waiting for the lock stays expired.
--   2. Pre-C6 roots: promote unexpired ask/note roots (thread_root_id IS NULL, created_at < v_c6_cutoff,
--      until > v_now) matching pre-C6 fixed-hour defaults (interval '168 hours' for ask, interval
--      '720 hours' for note — DST-immune exact match to pre-C6 postSignal's 7d/30d ms arithmetic).
--   3. Pre-C6 default-clamped replies on promoted roots: promote unexpired ask/note threaded replies
--      (thread_root_id IS NOT NULL) whose root is in eligible_roots AND whose OWN creation time is
--      pre-C6 (r.created_at < v_c6_cutoff), when the reply's expiry matches exact root.until,
--      millisecond-truncated date_trunc('milliseconds', root.until) (matching edge postSignal's
--      Date.prototype.toISOString() serialization), or the reply's own pre-C6 default (168h/720h).
--      Fencing r.created_at < v_c6_cutoff on EVERY reply branch ensures a post-C6 explicit reply
--      whose --until happens to equal an old root's ceiling is never extended.
--   4. Leave untouched:
--      - every explicit non-default horizon (e.g. a 3d ask, a 1d reply on a 7d ask, or any reply
--        clamped to an explicit-horizon root),
--      - every post-C6 explicit top-level ask/note or post-C6 reply (created_at >= v_c6_cutoff),
--      - every row already lapsed at post-lock clock_timestamp() (until <= v_now),
--      - every working-on signal (ephemeral by design; signals_until_bound forbids permanent working-on).
--
-- Append-only trigger safety:
--   Disabling and re-enabling signals_append_only inside one transactional DO block holds
--   SHARE ROW EXCLUSIVE on swarm.signals until commit, blocking concurrent writers while disabled.
--   The conditional backfill sits strictly between DISABLE and ENABLE so signals_append_only is
--   always restored and asserted tgenabled = 'O' on every path (including fail-closed skips).

DO $$
DECLARE
  v_now timestamptz;
  v_permanent timestamptz := '9999-12-31T23:59:59Z'::timestamptz;
  v_backfill_recorded boolean := false;
  v_has_permanent boolean := false;
  v_c6_checksum_at timestamptz;
  v_c6_checksum_source text;
  v_c6_cutoff timestamptz;
  v_should_backfill boolean := false;
  v_trigger_state "char";
BEGIN
  ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only;

  -- Sample post-lock wall-clock time so a row expiring while waiting on SHARE ROW EXCLUSIVE stays expired.
  v_now := pg_catalog.clock_timestamp();

  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM supabase_migrations.schema_migrations AS sm
      WHERE sm.version = '20261120000007'
    ) INTO v_backfill_recorded;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM swarm.signals AS s
    WHERE s.until = v_permanent
  ) INTO v_has_permanent;

  IF pg_catalog.to_regclass('commonswarm_ops.migration_checksums') IS NOT NULL THEN
    SELECT mc.applied_at, mc.source
      INTO v_c6_checksum_at, v_c6_checksum_source
    FROM commonswarm_ops.migration_checksums AS mc
    WHERE mc.version = '20261120000003';
  END IF;

  -- Fail closed if already applied, if a non-'release' checksum row exists, or if any permanent
  -- signal exists without a trusted 'release' checksum for 20261120000003.
  IF NOT v_backfill_recorded THEN
    IF v_c6_checksum_source = 'release' AND v_c6_checksum_at IS NOT NULL THEN
      v_c6_cutoff := least(v_now, v_c6_checksum_at);
      v_should_backfill := true;
    ELSIF v_c6_checksum_source IS NULL AND NOT v_has_permanent THEN
      v_c6_cutoff := v_now;
      v_should_backfill := true;
    END IF;
  END IF;

  IF v_should_backfill THEN
    WITH eligible_roots AS (
      SELECT s.id, s.workspace_id, s.until
      FROM swarm.signals AS s
      WHERE s.thread_root_id IS NULL
        AND s.created_at < v_c6_cutoff
        AND s.until > v_now
        AND s.until <> v_permanent
        AND (
          (s.kind = 'ask' AND s.until = s.created_at + interval '168 hours')
          OR (s.kind = 'note' AND s.until = s.created_at + interval '720 hours')
        )
    ),
    eligible_replies AS (
      SELECT r.id
      FROM swarm.signals AS r
      JOIN eligible_roots AS root
        ON root.id = r.thread_root_id
       AND root.workspace_id = r.workspace_id
      WHERE r.kind IN ('ask', 'note')
        AND r.created_at < v_c6_cutoff
        AND r.until > v_now
        AND r.until <> v_permanent
        AND (
          r.until = root.until
          OR r.until = pg_catalog.date_trunc('milliseconds', root.until)
          OR (r.kind = 'ask' AND r.until = r.created_at + interval '168 hours')
          OR (r.kind = 'note' AND r.until = r.created_at + interval '720 hours')
        )
    ),
    targets AS (
      SELECT id FROM eligible_roots
      UNION
      SELECT id FROM eligible_replies
    )
    UPDATE swarm.signals AS s
    SET until = v_permanent
    FROM targets AS t
    WHERE s.id = t.id;
  END IF;

  ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only;

  SELECT t.tgenabled INTO v_trigger_state
  FROM pg_catalog.pg_trigger AS t
  WHERE t.tgrelid = 'swarm.signals'::regclass
    AND t.tgname = 'signals_append_only'
    AND NOT t.tgisinternal;

  IF v_trigger_state IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'signals_append_only trigger was not restored to origin-enabled state (got %)',
      coalesce(v_trigger_state::text, 'NULL')
      USING ERRCODE = '55000';
  END IF;
END
$$;
