-- RESERVE ONLY. Rolls back 20260926000001_agent_wake_leases in one transaction.
-- Roll back the EDGE first: the new command and read edges use these objects.
-- Run only on HezLead's decision with the write helper:
--   release_psql --file /proof/20260926000001-rollback.sql
-- Stage this file and 20260926000001-rollback-catalog.sql in /proof first.
-- This migration REPLACED no prior object, so there is nothing to restore.
-- Its primary-key index, foreign-key triggers, and policy dependency disappear
-- with the table; the policy is also dropped explicitly below.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP VIEW swarm_read.agent_wake_leases;
DROP FUNCTION swarm.agent_wake_lease_for_token(bytea, uuid);
DROP FUNCTION swarm.release_agent_wake_lease(uuid, uuid, uuid, bigint);
DROP FUNCTION swarm.renew_agent_wake_lease(uuid, uuid, uuid, bigint);
DROP FUNCTION swarm.claim_agent_wake_lease(uuid, uuid, uuid, text, uuid, text, boolean, integer);
DROP FUNCTION swarm.wake_seat_lock(uuid, uuid);
DROP POLICY wake_lease_server_read ON swarm.agent_wake_leases;
DROP TABLE swarm.agent_wake_leases;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260926000001';

\i /proof/20260926000001-rollback-catalog.sql
\if :rollback_ok
  COMMIT;
\else
  ROLLBACK;
  -- psql's \quit takes no exit code; ON_ERROR_STOP makes this exit nonzero.
  DO $fail$ BEGIN RAISE EXCEPTION 'wake-lease rollback catalog proof FAILED; transaction rolled back'; END $fail$;
\endif
