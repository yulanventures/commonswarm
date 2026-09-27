-- RESERVE ONLY. Roll back edge and site code before removing HM transport state.
-- This is the complete inverse of 20260928000001_hm_agent_transport.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT release_proof_outer_transaction_guard;
\else
BEGIN;
\endif
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Exact pre-HM roster definition and ACLs from 20260916000001 plus the live
-- owner/grants/revoke state restored explicitly below.
-- DROP is required because CREATE OR REPLACE cannot remove projected columns.
DROP VIEW swarm_read.agent_principals;
CREATE VIEW swarm_read.agent_principals
WITH (security_barrier = true)
AS
  SELECT
    p.principal_id,
    p.workspace_id,
    p.owner_user_id,
    p.name,
    p.created_at,
    p.revoked_at,
    p.model,
    p.managed_at
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid())
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS c
      WHERE c.registrar_principal_id = p.principal_id
    );

ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_principals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.agent_principals FROM anon;

-- Exact pre-HM private wake source from 20260925000001, including every
-- predicate, projection column, barrier, owner, and revoke.
CREATE OR REPLACE VIEW swarm.wake_path_eligible_deliveries
WITH (security_barrier = true)
AS
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
  -- Check pages signals by (created_at cut to milliseconds, id), the read
  -- edge's cursor order, not by delivery enqueue time. A recipient added after
  -- signal creation can invert signal and enqueue order.
  AND NOT EXISTS (SELECT 1 FROM swarm.signal_deliveries AS later
    JOIN swarm.signals AS later_signal
      ON later_signal.workspace_id = later.workspace_id AND later_signal.id = later.signal_id
    WHERE later.workspace_id = d.workspace_id
      AND later.recipient_agent_principal_id = d.recipient_agent_principal_id
      AND (date_trunc('milliseconds', later_signal.created_at), later_signal.id)
        > (date_trunc('milliseconds', s.created_at), s.id)
      AND later_signal.kind IN ('ask', 'note')
      AND (later_signal.to_agent_principal_id = d.recipient_agent_principal_id
        OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS later_recipient
          WHERE later_recipient.workspace_id = later_signal.workspace_id
            AND later_recipient.signal_id = later_signal.id
            AND later_recipient.recipient_agent_principal_id = d.recipient_agent_principal_id))
      AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL
      AND later.last_leased_by IS NULL);

ALTER VIEW swarm.wake_path_eligible_deliveries OWNER TO swarm_admin;
REVOKE ALL ON swarm.wake_path_eligible_deliveries
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

DROP FUNCTION swarm.agent_principal_transport(uuid);

ALTER TABLE swarm.agent_principals
  DROP CONSTRAINT agent_principals_hosted_turn_only,
  DROP CONSTRAINT agent_principals_transport_valid,
  DROP COLUMN turn_only,
  DROP COLUMN transport;

DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20260928000001';

\ir 20260928000001-rollback-catalog.sql
\if :rollback_ok
  \if :{?release_proof_outer_transaction}
    RELEASE SAVEPOINT release_proof_outer_transaction_guard;
  \else
    COMMIT;
  \endif
\else
  ROLLBACK;
  DO $fail$ BEGIN RAISE EXCEPTION 'HM transport rollback catalog proof FAILED; transaction rolled back'; END $fail$;
\endif
