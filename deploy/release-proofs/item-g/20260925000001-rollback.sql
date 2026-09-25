-- RESERVE ONLY. Rolls back migration 20260925000001_unclaimed_observed_ack in one transaction.
-- Runs only on HezLead's decision. Rolling back the edge alone is safe with this migration in place (see
-- docs/evidence/2026-09-25-item-g-lane1/BOX-SECTION6.md); this file is for the case where the schema itself must go.
--
-- check9: after release, `cswarm check` writes unclaimed `observed` ACKs, which the pre-G check9 forbids. This
-- transaction restores the pre-G check9 only when no such row exists. Otherwise it keeps the widened check9 (it only
-- admits one more shape; every pre-G writer still passes it) and says so in a NOTICE. It never rewrites ACK rows:
-- clearing them would make old mail claimable again.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The receipts wrapper first, so nothing depends on the views when they are dropped.
DROP FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea);
ALTER FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(uuid, uuid, bytea)
  RENAME TO signal_delivery_receipts;
-- Pre-G ACL (pg_dump of the pre-G catalog): owner swarm_admin; PUBLIC revoked; EXECUTE to authenticated and swarm_read.
ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) TO authenticated, swarm_read;

DROP VIEW swarm_read.agent_wake_path;
DROP VIEW swarm_read.agent_wake_path_deliveries;
DROP VIEW swarm.wake_path_eligible_deliveries;
DROP TABLE swarm.wake_path_release;
DROP INDEX swarm.signal_deliveries_unclaimed_observed;

DO $rollback_check9$
DECLARE
  v_unclaimed bigint;
BEGIN
  SELECT count(*) INTO v_unclaimed FROM swarm.signal_deliveries
  WHERE acked_at IS NOT NULL AND ack_outcome = 'observed'
    AND (last_lease_id IS NULL OR last_leased_by IS NULL);
  IF v_unclaimed = 0 THEN
    ALTER TABLE swarm.signal_deliveries DROP CONSTRAINT signal_deliveries_check9;
    ALTER TABLE swarm.signal_deliveries ADD CONSTRAINT signal_deliveries_check9 CHECK (
      acked_at IS NULL
      OR (last_lease_id IS NOT NULL AND last_leased_by IS NOT NULL)
      OR ack_outcome = 'expired'
      OR (ack_outcome = 'failed_terminal' AND last_error_code = 'delivery_attempts_exhausted')
    );
    RAISE NOTICE 'check9 restored to the pre-G definition';
  ELSE
    RAISE NOTICE 'check9 KEPT widened: % unclaimed observed ACK rows exist', v_unclaimed;
  END IF;
END
$rollback_check9$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260925000001';

\i /proof/20260925000001-rollback-catalog.sql
\if :rollback_ok
  COMMIT;
\else
  ROLLBACK;
  -- psql's \quit takes no exit code; an error under ON_ERROR_STOP exits 3.
  DO $fail$ BEGIN RAISE EXCEPTION 'rollback catalog proof FAILED; the transaction was rolled back and nothing changed'; END $fail$;
\endif
