-- RESERVE ONLY. Roll back the old edge first; it does not name these columns.
-- Run only on HezLead's decision with the write helper.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  true
);
DO $$
DECLARE
  live_def text := current_setting('swarm.signals_view_before');
  body text;
BEGIN
  IF position('chain_hop' IN live_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals does not carry chain_hop';
  END IF;
  body := regexp_replace(
    live_def,
    ',\s*s\.chain_hop(\s+FROM\s+(?:swarm\.)?signals\s)',
    '\1'
  );
  IF body = live_def THEN
    RAISE EXCEPTION 'could not remove chain_hop from swarm_read.signals';
  END IF;
  body := rtrim(body, E' ;\n\t');
  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;
ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;

DROP INDEX swarm.signals_chain_parent_children;
ALTER TABLE swarm.signals
  DROP CONSTRAINT signals_chain_parent_workspace,
  DROP CONSTRAINT signals_chain_columns_together,
  DROP CONSTRAINT signals_chain_parent_ask,
  DROP COLUMN chain_participants,
  DROP COLUMN chain_hop,
  DROP COLUMN chain_root_id,
  DROP COLUMN parent_signal_id;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260927000003';

\i /proof/20260927000003-rollback-catalog.sql
\if :rollback_ok
  COMMIT;
\else
  ROLLBACK;
  DO $fail$ BEGIN RAISE EXCEPTION 'ask-chain rollback catalog proof FAILED; transaction rolled back'; END $fail$;
\endif
