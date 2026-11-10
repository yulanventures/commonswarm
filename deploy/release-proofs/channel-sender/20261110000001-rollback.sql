-- RESERVE ONLY. Rolls back migration 20261110000001_delivery_sender_not_live in one transaction, on HezLead's decision.
-- Rolling back the edge alone is safe with this migration in place: the widened checks only admit one more shape and
-- every older writer still passes them.
--
-- After release, the edge writes failed_terminal / sender_not_live rows with no delivery time or no lease, which the
-- previous checks forbid. This restores the previous checks only when no such row exists; otherwise it keeps the
-- widened checks and says so in a NOTICE. It never rewrites delivery rows: clearing them would let a removed sender's
-- message be claimed again.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE swarm.signal_deliveries IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_delivered text;
  v_lease text;
  v_blocking bigint;
BEGIN
  SELECT count(*) INTO v_blocking FROM swarm.signal_deliveries
  WHERE ack_outcome = 'failed_terminal' AND last_error_code = 'sender_not_live';
  IF v_blocking > 0 THEN
    RAISE NOTICE 'kept the widened checks: % sender_not_live delivery row(s) exist and are never rewritten', v_blocking;
    RETURN;
  END IF;

  SELECT conname INTO v_delivered FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%delivered_at IS NOT NULL%'
    AND pg_get_constraintdef(oid) NOT LIKE '%last_lease_id%';
  SELECT conname INTO v_lease FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%last_lease_id IS NOT NULL%';
  IF v_delivered IS NULL OR v_lease IS NULL THEN
    RAISE EXCEPTION 'signal_deliveries checks not found (delivered: %, lease: %)', v_delivered, v_lease;
  END IF;

  EXECUTE format('ALTER TABLE swarm.signal_deliveries DROP CONSTRAINT %I', v_delivered);
  EXECUTE format($sql$ALTER TABLE swarm.signal_deliveries ADD CONSTRAINT %I CHECK (
    acked_at IS NULL
    OR ack_outcome = 'expired'
    OR delivered_at IS NOT NULL
  )$sql$, v_delivered);
  EXECUTE format('ALTER TABLE swarm.signal_deliveries DROP CONSTRAINT %I', v_lease);
  EXECUTE format($sql$ALTER TABLE swarm.signal_deliveries ADD CONSTRAINT %I CHECK (
    acked_at IS NULL
    OR (last_lease_id IS NOT NULL AND last_leased_by IS NOT NULL)
    OR ack_outcome = 'expired'
    OR (ack_outcome = 'observed' AND last_error_code IS NULL)
    OR (ack_outcome = 'failed_terminal' AND last_error_code = 'delivery_attempts_exhausted')
  )$sql$, v_lease);
END $$;

COMMIT;
