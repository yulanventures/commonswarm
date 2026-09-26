-- RESERVE ONLY. Rolls back 20260927000002_agent_presence in one transaction.
-- Roll back the EDGE first: the command edge writes these objects.
-- Run only on HezLead's decision with the write helper:
--   release_psql --file /proof/20260927000002-rollback.sql
-- Stage this file and 20260927000002-rollback-catalog.sql in /proof first.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP VIEW swarm_read.agent_presence;
DROP INDEX swarm.signal_deliveries_presence_latest_ack;
ALTER TABLE swarm.signal_deliveries DROP COLUMN ack_via;
DROP POLICY agent_presence_command_all ON swarm.agent_presence;
DROP TABLE swarm.agent_presence;
DELETE FROM swarm.config WHERE key = 'current_client_build';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260927000002';

\i /proof/20260927000002-rollback-catalog.sql
\if :rollback_ok
  COMMIT;
\else
  ROLLBACK;
  DO $fail$ BEGIN RAISE EXCEPTION 'agent-presence rollback catalog proof FAILED; transaction rolled back'; END $fail$;
\endif
