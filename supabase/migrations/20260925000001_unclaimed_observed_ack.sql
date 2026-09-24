-- Item G lane 1 (brain topic wake-liveness-design): real mail is the wake probe.
--
-- `cswarm check` is the verb an attended seat runs every turn, and today it records NOTHING
-- server-side (src/cloud/agent-check.ts makes two reads and no write). So nobody can tell a
-- seat that is reading its mail from one whose wake path died: the operator noticed before the
-- seat did, on 2026-09-14.
--
-- For check to ACK `observed`, an UNCLAIMED delivery must be ackable. signal_deliveries_check9
-- requires last_lease_id/last_leased_by on any acked row, because until now every ack came from
-- a listener that had claimed a lease. An attended seat never claims one — that is the whole
-- point of the seat being attended — so the check refuses the only ack it can honestly send.
--
-- Widen check9 for exactly that case and no other. `observed` already passes the ack_outcome
-- enum; this is only about the lease columns.
-- This migration is one transaction. DROP/ADD holds ACCESS EXCLUSIVE through
-- VALIDATE and commit, so the validation scan is inside the exclusive window.
--
-- Deliberately NOT widened: 'replied' and 'failed_terminal' still require the lease pair, so a
-- worker cannot report work it never claimed. The pairing constraint below check9
-- (num_nonnulls(last_lease_id, last_leased_by) IN (0, 2)) is untouched, so a row can still never
-- carry one half of the pair.

ALTER TABLE swarm.signal_deliveries DROP CONSTRAINT IF EXISTS signal_deliveries_check9;

ALTER TABLE swarm.signal_deliveries ADD CONSTRAINT signal_deliveries_check9 CHECK (
  acked_at IS NULL
  OR (last_lease_id IS NOT NULL AND last_leased_by IS NOT NULL)
  OR ack_outcome = 'expired'
  -- An attended seat observing its own mail: no lease was ever taken.
  OR (ack_outcome = 'observed' AND last_error_code IS NULL)
  OR (ack_outcome = 'failed_terminal' AND last_error_code = 'delivery_attempts_exhausted')
) NOT VALID;
ALTER TABLE swarm.signal_deliveries VALIDATE CONSTRAINT signal_deliveries_check9;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'swarm.signal_deliveries'::regclass AND conname = 'signal_deliveries_check9';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'signal_deliveries_check9 is missing after the rewrite';
  END IF;
  IF v_def NOT LIKE '%observed%' OR v_def NOT LIKE '%last_error_code IS NULL%' THEN
    RAISE EXCEPTION 'signal_deliveries_check9 does not admit an unclaimed observed ack: %', v_def;
  END IF;
  -- The narrowing half: a replied ack must still carry its lease pair.
  IF v_def LIKE '%replied%' THEN
    RAISE EXCEPTION 'signal_deliveries_check9 now admits a lease-free replied ack: %', v_def;
  END IF;
END $$;

-- The migration itself records the release boundary; old mail cannot become a
-- permanent false stale mark when a seat's existing cursor is already past it.
CREATE TABLE swarm.wake_path_release (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
INSERT INTO swarm.wake_path_release (singleton) VALUES (true);
ALTER TABLE swarm.wake_path_release OWNER TO swarm_admin;

-- One private eligible-row source feeds both the roster and receipts. The
-- release cutoff is load-bearing: a seat that is behind at release can ACK old
-- mail first, and only the cutoff then keeps its remaining old mail out.
CREATE VIEW swarm.wake_path_eligible_deliveries WITH (security_barrier = true) AS
SELECT d.workspace_id, d.signal_id, d.recipient_agent_principal_id AS principal_id,
       d.enqueued_at
FROM swarm.signal_deliveries AS d
JOIN swarm.signals AS s
  ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
JOIN swarm.agent_principals AS p
  ON p.workspace_id = d.workspace_id AND p.principal_id = d.recipient_agent_principal_id
WHERE d.acked_at IS NULL AND d.lease_id IS NULL AND d.leased_by IS NULL
  AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
  AND d.enqueued_at >= (SELECT applied_at FROM swarm.wake_path_release WHERE singleton)
  AND s.until > statement_timestamp()
  AND s.kind IN ('ask', 'note')
  AND (s.to_agent_principal_id = d.recipient_agent_principal_id
    OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS r
      WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
        AND r.recipient_agent_principal_id = d.recipient_agent_principal_id))
  AND p.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM swarm.signal_deliveries AS observed
    WHERE observed.workspace_id = d.workspace_id
      AND observed.recipient_agent_principal_id = d.recipient_agent_principal_id
      AND observed.ack_outcome = 'observed' AND observed.last_lease_id IS NULL
      AND observed.last_leased_by IS NULL
      AND observed.acked_at >= (SELECT applied_at FROM swarm.wake_path_release WHERE singleton))
  -- Check pages signals by (created_at, id), not by delivery enqueue time.
  -- A recipient added after signal creation can invert those two orders.
  AND NOT EXISTS (SELECT 1 FROM swarm.signal_deliveries AS later
    JOIN swarm.signals AS later_signal
      ON later_signal.workspace_id = later.workspace_id AND later_signal.id = later.signal_id
    WHERE later.workspace_id = d.workspace_id
      AND later.recipient_agent_principal_id = d.recipient_agent_principal_id
      AND (later_signal.created_at, later_signal.id) > (s.created_at, s.id)
      AND later_signal.kind IN ('ask', 'note')
      AND (later_signal.to_agent_principal_id = d.recipient_agent_principal_id
        OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS later_recipient
          WHERE later_recipient.workspace_id = later_signal.workspace_id
            AND later_recipient.signal_id = later_signal.id
            AND later_recipient.recipient_agent_principal_id = d.recipient_agent_principal_id))
      AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL
      AND later.last_leased_by IS NULL);
ALTER VIEW swarm.wake_path_eligible_deliveries OWNER TO swarm_admin;
REVOKE ALL ON swarm.wake_path_eligible_deliveries FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- The roster adds caller membership; agent-token receipts cannot use auth.uid().
CREATE VIEW swarm_read.agent_wake_path_deliveries WITH (security_barrier = true) AS
SELECT workspace_id, signal_id, principal_id, enqueued_at
FROM swarm.wake_path_eligible_deliveries AS d
WHERE swarm.is_member(d.workspace_id, auth.uid());
ALTER VIEW swarm_read.agent_wake_path_deliveries OWNER TO swarm_admin;

-- The browser only sees this member-readable aggregate. An ACK removes its row.
CREATE VIEW swarm_read.agent_wake_path WITH (security_barrier = true) AS
SELECT workspace_id, principal_id, min(enqueued_at) AS oldest_unobserved_at
FROM swarm_read.agent_wake_path_deliveries
GROUP BY workspace_id, principal_id;
ALTER VIEW swarm_read.agent_wake_path OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_wake_path TO authenticated;

-- Add one server-authoritative eligibility bit to directed receipts. Old
-- clients ignore it; new clients never infer observation from row age alone.
ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  RENAME TO signal_delivery_receipts_without_wake_path;
REVOKE ALL ON FUNCTION
  swarm_read.signal_delivery_receipts_without_wake_path(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read;
CREATE FUNCTION swarm_read.signal_delivery_receipts(
  p_workspace_id uuid, p_signal_id uuid, p_agent_token_hash bytea DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = swarm, pg_catalog AS $$
DECLARE
  v_result jsonb;
  v_receipts jsonb;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_wake_path(
    p_workspace_id, p_signal_id, p_agent_token_hash);
  IF v_result IS NULL OR v_result ->> 'addressed' <> 'true' THEN RETURN v_result; END IF;
  SELECT COALESCE(jsonb_agg(
    CASE WHEN receipt.value ? 'recipient_agent_principal_id' THEN
      receipt.value || jsonb_build_object('wake_path_observing', EXISTS (
        SELECT 1 FROM swarm.wake_path_eligible_deliveries AS d
        WHERE d.workspace_id = p_workspace_id AND d.signal_id = p_signal_id
          AND d.principal_id = (receipt.value ->> 'recipient_agent_principal_id')::uuid
      ))
    ELSE receipt.value END ORDER BY receipt.ordinality), '[]'::jsonb)
  INTO v_receipts FROM jsonb_array_elements(v_result -> 'receipts')
    WITH ORDINALITY AS receipt(value, ordinality);
  RETURN jsonb_set(v_result, '{receipts}', v_receipts, false);
END;
$$;
ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  TO authenticated, swarm_read;
