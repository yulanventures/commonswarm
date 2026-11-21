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
-- Narrowed backfill rules:
--   1. Lock first, then sample liveness: ALTER TABLE swarm.signals DISABLE TRIGGER acquires a
--      SHARE ROW EXCLUSIVE lock on swarm.signals (blocking all concurrent INSERT/UPDATE/DELETE
--      writers until commit). Only AFTER that lock is held do we sample v_now via
--      pg_catalog.clock_timestamp() (not statement_timestamp() or now(), which freeze before the
--      lock wait), so any row that expires while waiting for the lock stays expired.
--   2. Pre-C6 creation fence (v_c6_cutoff): compute the earliest evidence of C6 rollout from
--      commonswarm_ops.migration_checksums (version = '20261120000003') and the earliest permanent
--      row in swarm.signals (until = '9999-12-31T23:59:59Z'), bounded above by v_now. Only rows
--      with created_at < v_c6_cutoff match the pre-C6 old-default durations (interval '168 hours'
--      for ask, interval '720 hours' for note — DST-immune exact match to pre-C6 postSignal's
--      7d/30d millisecond arithmetic), so post-C6 explicit 7d asks and explicit 30d notes are
--      never promoted.
--   3. Default-clamped replies on promoted roots: promote unexpired ask/note threaded replies
--      (thread_root_id IS NOT NULL) whose root is in eligible_roots when the reply's expiry was
--      clamped to the root — matching BOTH exact root.until AND millisecond-truncated
--      date_trunc('milliseconds', root.until) (because edge postSignal serialized rootUntil via
--      Date.prototype.toISOString(), truncating sub-millisecond Postgres microseconds) — or when a
--      pre-C6 reply (created_at < v_c6_cutoff) carried its own kind's pre-C6 default (e.g. a
--      pre-C6 default 7d ask reply on a pre-C6 default 30d note root). Restricting replies to
--      eligible_roots preserves the thread-horizon invariant (no reply ever outlives its root).
--   4. Leave untouched:
--      - every explicit non-default horizon (e.g. a 3d ask, a 1d reply on a 7d ask, or any reply
--        clamped to an explicit-horizon root),
--      - every post-C6 explicit 7d ask or 30d note (created_at >= v_c6_cutoff),
--      - every row already lapsed at post-lock clock_timestamp() (until <= v_now),
--      - every working-on signal (ephemeral by design; signals_until_bound forbids permanent working-on).
--
-- Append-only trigger safety:
--   Disabling and re-enabling signals_append_only inside one transactional DO block holds
--   SHARE ROW EXCLUSIVE on swarm.signals until commit, blocking concurrent writers while disabled.
--   Any error aborts and rolls back the DISABLE TRIGGER automatically, and this block asserts
--   tgenabled = 'O' after re-enabling. Re-running is a no-op (idempotent).

DO $$
DECLARE
  v_now timestamptz;
  v_permanent timestamptz := '9999-12-31T23:59:59Z'::timestamptz;
  v_c6_checksum_at timestamptz;
  v_first_permanent_at timestamptz;
  v_c6_cutoff timestamptz;
  v_trigger_state "char";
BEGIN
  ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only;

  -- Sample post-lock wall-clock time so a row expiring while waiting on SHARE ROW EXCLUSIVE stays expired.
  v_now := pg_catalog.clock_timestamp();

  IF pg_catalog.to_regclass('commonswarm_ops.migration_checksums') IS NOT NULL THEN
    SELECT mc.applied_at INTO v_c6_checksum_at
    FROM commonswarm_ops.migration_checksums AS mc
    WHERE mc.version = '20261120000003';
  END IF;

  SELECT min(s.created_at) INTO v_first_permanent_at
  FROM swarm.signals AS s
  WHERE s.until = v_permanent;

  v_c6_cutoff := least(
    v_now,
    coalesce(v_c6_checksum_at, v_now),
    coalesce(v_first_permanent_at, v_now)
  );

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
      AND r.until > v_now
      AND r.until <> v_permanent
      AND (
        r.until = root.until
        OR r.until = pg_catalog.date_trunc('milliseconds', root.until)
        OR (
          r.created_at < v_c6_cutoff
          AND (
            (r.kind = 'ask' AND r.until = r.created_at + interval '168 hours')
            OR (r.kind = 'note' AND r.until = r.created_at + interval '720 hours')
          )
        )
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
