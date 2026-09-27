-- HM lane 4: distinguish local agent seats from hosted MCP turn-only seats.
-- Existing principals remain local. Hosted-seat creation lands in a later lane.

ALTER TABLE swarm.agent_principals
  ADD COLUMN transport text NOT NULL DEFAULT 'local',
  ADD COLUMN turn_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT agent_principals_transport_valid
    CHECK (transport IN ('local', 'hosted_mcp')),
  ADD CONSTRAINT agent_principals_hosted_turn_only
    CHECK (transport <> 'hosted_mcp' OR turn_only = true);

COMMENT ON COLUMN swarm.agent_principals.transport IS
  'Delivery transport for the principal. local uses the CLI path; hosted_mcp is served only by hosted MCP turns.';
COMMENT ON COLUMN swarm.agent_principals.turn_only IS
  'True when the principal may act only during an authenticated turn and must not enter listener or managed-session paths.';

-- The read edge authenticates through agent_delivery_read_context while no
-- human JWT claims exist. Keep the transport fence in that same narrow role
-- without granting swarm_read direct access to the authority table.
CREATE FUNCTION swarm.agent_principal_transport(p_principal_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT p.transport
  FROM swarm.agent_principals AS p
  WHERE p.principal_id = p_principal_id
$fn$;

ALTER FUNCTION swarm.agent_principal_transport(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_principal_transport(uuid)
  FROM PUBLIC, anon, authenticated, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.agent_principal_transport(uuid) TO swarm_read;

-- Start with the live registrar-filtered projection and append transport state.
CREATE OR REPLACE VIEW swarm_read.agent_principals
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
    p.managed_at,
    p.transport,
    p.turn_only
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

-- Preserve the full live private wake source. The only eligibility change is
-- that turn-only seats never advertise a listener wake path.
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
  AND p.turn_only = false
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
