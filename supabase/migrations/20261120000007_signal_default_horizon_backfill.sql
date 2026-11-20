-- C6 narrowed default-horizon backfill (to-do fcf69f45, follow-up to 20261120000003 / PR #706).
--
-- Product rationale (for security review):
--   The owner's product rule is "nothing a person sets up ever lapses" (C6 permanence). PR #706
--   made newly posted asks and notes permanent by default ('9999-12-31T23:59:59Z'::timestamptz)
--   while leaving pre-existing rows untouched so historical backfill could be reviewed on its own.
--   This migration applies the narrowed backfill ruling:
--     1. Promote ONLY still-unexpired (until > statement_timestamp(), not already permanent)
--        top-level asks whose horizon exactly equals the pre-C6 default (created_at + interval '7 days')
--        and top-level notes whose horizon exactly equals the pre-C6 default (created_at + interval '30 days').
--        (Before C6, postSignal computed both created_at and until from statement_timestamp() in the
--        same INSERT statement, so pre-C6 default rows match created_at + 7d / 30d exactly. An
--        explicit --until equal to the old default cannot be distinguished from the old default
--        because swarm.signals stores no default-vs-explicit flag, and extending it does no harm
--        under the owner's retention policy.)
--     2. Promote ONLY unexpired ask/note threaded replies (thread_root_id IS NOT NULL) whose thread
--        root is in that eligible pre-C6 default set AND whose horizon was either default-clamped to
--        the root (reply.until = root.until, from pre-C6 and post-C6 LEAST(..., root.until)) or equal
--        to the reply kind's own pre-C6 default (ask +7d / note +30d, e.g. a default-7d ask reply on
--        a default-30d note root). Restricting replies to roots promoted by this migration preserves
--        the thread-horizon invariant (no reply ever outlives its thread root) and leaves explicit
--        7d/30d replies on post-C6 permanent roots untouched.
--     3. Leave untouched:
--        - every row with an explicit non-default horizon (e.g. a 3d ask, a 1d reply on a 7d ask,
--          or any reply clamped to an explicit-horizon root),
--        - every row that has already lapsed (until <= statement_timestamp()),
--        - every working-on signal (ephemeral by design; signals_until_bound forbids permanent working-on).
--
-- Append-only trigger safety:
--   swarm.signals is guarded by signals_append_only (BEFORE UPDATE OR DELETE). Disabling and
--   re-enabling it inside one transactional DO block holds an ACCESS EXCLUSIVE lock on swarm.signals
--   until commit, so no concurrent session can mutate swarm.signals while the trigger is disabled.
--   Any error aborts and rolls back the DISABLE TRIGGER automatically, and this block asserts
--   tgenabled = 'O' after re-enabling. Re-running is a no-op (idempotent).

DO $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_permanent timestamptz := '9999-12-31T23:59:59Z'::timestamptz;
  v_trigger_state "char";
BEGIN
  ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only;

  WITH eligible_roots AS (
    SELECT s.id, s.workspace_id, s.until
    FROM swarm.signals AS s
    WHERE s.thread_root_id IS NULL
      AND s.until > v_now
      AND s.until <> v_permanent
      AND (
        (s.kind = 'ask' AND s.until = s.created_at + interval '7 days')
        OR (s.kind = 'note' AND s.until = s.created_at + interval '30 days')
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
        OR (r.kind = 'ask' AND r.until = r.created_at + interval '7 days')
        OR (r.kind = 'note' AND r.until = r.created_at + interval '30 days')
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
