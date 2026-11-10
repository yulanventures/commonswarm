-- Channel delivery sender condition (security review, 2026-11-10): a queued delivery whose sender is no longer
-- admitted to the signal's workspace is terminalized as failed_terminal / sender_not_live instead of being pushed
-- into an agent's context. The signal itself stays as history under its read ACL.
--
-- Two checks on swarm.signal_deliveries would refuse that terminal row when the delivery was never claimed:
--   * acked rows must be 'expired' or delivered (delivered_at set): a never-claimed row has no delivered_at, and
--     setting one would make message status report it as delivered;
--   * acked rows must carry the last lease pair, except 'expired', an unclaimed 'observed', or the server's own
--     'delivery_attempts_exhausted' poison.
-- Widen both for exactly 'failed_terminal' with 'sender_not_live' and nothing else. Client-reported terminal
-- codes still need a lease. The first check is unnamed in its CREATE TABLE, so both are found by definition.
-- One transaction: DROP/ADD hold ACCESS EXCLUSIVE through VALIDATE and commit.

LOCK TABLE swarm.signal_deliveries IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_delivered text;
  v_lease text;
BEGIN
  SELECT conname INTO v_delivered FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%delivered_at IS NOT NULL%'
    AND pg_get_constraintdef(oid) LIKE '%expired%'
    AND pg_get_constraintdef(oid) NOT LIKE '%last_lease_id%';
  SELECT conname INTO v_lease FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%last_lease_id IS NOT NULL%'
    AND pg_get_constraintdef(oid) LIKE '%delivery_attempts_exhausted%';
  IF v_delivered IS NULL OR v_lease IS NULL THEN
    RAISE EXCEPTION 'signal_deliveries checks not found (delivered: %, lease: %)', v_delivered, v_lease;
  END IF;

  EXECUTE format('ALTER TABLE swarm.signal_deliveries DROP CONSTRAINT %I', v_delivered);
  EXECUTE format($sql$ALTER TABLE swarm.signal_deliveries ADD CONSTRAINT %I CHECK (
    acked_at IS NULL
    OR ack_outcome = 'expired'
    OR delivered_at IS NOT NULL
    -- The sender was removed before the delivery was ever claimed.
    OR (ack_outcome = 'failed_terminal' AND last_error_code = 'sender_not_live')
  ) NOT VALID$sql$, v_delivered);
  EXECUTE format('ALTER TABLE swarm.signal_deliveries VALIDATE CONSTRAINT %I', v_delivered);

  EXECUTE format('ALTER TABLE swarm.signal_deliveries DROP CONSTRAINT %I', v_lease);
  EXECUTE format($sql$ALTER TABLE swarm.signal_deliveries ADD CONSTRAINT %I CHECK (
    acked_at IS NULL
    OR (last_lease_id IS NOT NULL AND last_leased_by IS NOT NULL)
    OR ack_outcome = 'expired'
    OR (ack_outcome = 'observed' AND last_error_code IS NULL)
    OR (ack_outcome = 'failed_terminal' AND last_error_code IN ('delivery_attempts_exhausted', 'sender_not_live'))
  ) NOT VALID$sql$, v_lease);
  EXECUTE format('ALTER TABLE swarm.signal_deliveries VALIDATE CONSTRAINT %I', v_lease);
END $$;

DO $$
DECLARE
  v_delivered text;
  v_lease text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_delivered FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%delivered_at IS NOT NULL%' AND pg_get_constraintdef(oid) NOT LIKE '%last_lease_id%';
  SELECT pg_get_constraintdef(oid) INTO v_lease FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%last_lease_id IS NOT NULL%';
  IF v_delivered IS NULL OR v_delivered NOT LIKE '%sender_not_live%' THEN
    RAISE EXCEPTION 'delivered check does not admit sender_not_live: %', v_delivered;
  END IF;
  IF v_lease IS NULL OR v_lease NOT LIKE '%sender_not_live%' OR v_lease NOT LIKE '%delivery_attempts_exhausted%' THEN
    RAISE EXCEPTION 'lease check does not admit sender_not_live beside attempts exhausted: %', v_lease;
  END IF;
  -- The narrowing half: client-reported work still needs its lease pair.
  IF v_lease LIKE '%replied%' OR v_lease LIKE '%provider_refused%' THEN
    RAISE EXCEPTION 'lease check now admits a lease-free client outcome: %', v_lease;
  END IF;
END $$;
