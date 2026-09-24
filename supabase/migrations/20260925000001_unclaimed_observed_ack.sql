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
  OR ack_outcome = 'observed'
  OR (ack_outcome = 'failed_terminal' AND last_error_code = 'delivery_attempts_exhausted')
);

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
  IF v_def NOT LIKE '%observed%' THEN
    RAISE EXCEPTION 'signal_deliveries_check9 does not admit an unclaimed observed ack: %', v_def;
  END IF;
  -- The narrowing half: a replied ack must still carry its lease pair.
  IF v_def LIKE '%replied%' THEN
    RAISE EXCEPTION 'signal_deliveries_check9 now admits a lease-free replied ack: %', v_def;
  END IF;
END $$;

-- A member-readable aggregate for the app roster. The browser never reads the
-- authority table directly, and an ACK makes the principal disappear from this view.
CREATE VIEW swarm_read.agent_wake_path WITH (security_barrier = true) AS
SELECT d.workspace_id, d.recipient_agent_principal_id AS principal_id,
       min(d.enqueued_at) AS oldest_unobserved_at
FROM swarm.signal_deliveries AS d
JOIN swarm.signals AS s
  ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
JOIN swarm.agent_principals AS p
  ON p.workspace_id = d.workspace_id AND p.principal_id = d.recipient_agent_principal_id
WHERE d.acked_at IS NULL AND d.lease_id IS NULL AND d.leased_by IS NULL
  AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
  AND s.kind IN ('ask', 'note')
  AND (s.to_agent_principal_id = d.recipient_agent_principal_id
    OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS r
      WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
        AND r.recipient_agent_principal_id = d.recipient_agent_principal_id))
  AND p.revoked_at IS NULL
  AND swarm.is_member(d.workspace_id, auth.uid())
GROUP BY d.workspace_id, d.recipient_agent_principal_id;
ALTER VIEW swarm_read.agent_wake_path OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_wake_path TO authenticated;
