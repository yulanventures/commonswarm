-- Rollback for 20261117000003: restore swarm.wake_path_eligible_deliveries and
-- swarm.actor_wake_path_eligible_deliveries exactly as 20261113000003_private_channels.sql defines them
-- (1728-1793 and 1322-1424), then drop swarm.agent_has_live_workspace_seat, which only the view used.
-- The view goes back first: it depends on the function until it is replaced.
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
  AND (
    s.channel_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM swarm.channels AS ch
      WHERE ch.workspace_id = s.workspace_id
        AND ch.channel_id = s.channel_id
        AND (
          ch.visibility = 'open'
          OR EXISTS (
            SELECT 1
            FROM swarm.channel_members AS cm
            WHERE cm.workspace_id = s.workspace_id
              AND cm.channel_id = s.channel_id
              AND cm.member_kind = 'agent'
              AND cm.agent_principal_id = d.recipient_agent_principal_id
          )
        )
    )
  )
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

CREATE OR REPLACE FUNCTION swarm.actor_wake_path_eligible_deliveries(
  p_actor_kind text,
  p_actor_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  signal_id uuid,
  principal_id uuid,
  enqueued_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF p_actor_id IS NULL OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT d.workspace_id, d.signal_id, d.recipient_agent_principal_id AS principal_id,
         d.enqueued_at
  FROM swarm.signal_deliveries AS d
  JOIN swarm.signals AS s
    ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
  JOIN swarm.agent_principals AS p
    ON p.workspace_id = d.workspace_id AND p.principal_id = d.recipient_agent_principal_id
  WHERE d.acked_at IS NULL AND d.lease_id IS NULL AND d.leased_by IS NULL
    AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
    AND d.enqueued_at >= (SELECT wpr.applied_at FROM swarm.wake_path_release AS wpr WHERE wpr.singleton)
    AND s.until > statement_timestamp()
    AND s.kind IN ('ask', 'note')
    AND swarm.actor_can_access_channel(d.workspace_id, s.channel_id, p_actor_kind, p_actor_id)
    AND (
      s.channel_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM swarm.channels AS ch
        WHERE ch.workspace_id = s.workspace_id
          AND ch.channel_id = s.channel_id
          AND (
            ch.visibility = 'open'
            OR EXISTS (
              SELECT 1
              FROM swarm.channel_members AS cm
              WHERE cm.workspace_id = s.workspace_id
                AND cm.channel_id = s.channel_id
                AND cm.member_kind = 'agent'
                AND cm.agent_principal_id = d.recipient_agent_principal_id
            )
          )
      )
    )
    AND (s.to_agent_principal_id = d.recipient_agent_principal_id
      OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS r
        WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
          AND r.recipient_agent_principal_id = d.recipient_agent_principal_id))
    AND p.revoked_at IS NULL
    AND p.turn_only = false
    AND EXISTS (SELECT 1 FROM swarm.signal_deliveries AS observed
      JOIN swarm.signals AS observed_signal
        ON observed_signal.workspace_id = observed.workspace_id
       AND observed_signal.id = observed.signal_id
      WHERE observed.workspace_id = d.workspace_id
        AND observed.recipient_agent_principal_id = d.recipient_agent_principal_id
        AND observed.ack_outcome = 'observed' AND observed.last_lease_id IS NULL
        AND observed.last_leased_by IS NULL
        AND observed.acked_at >= (SELECT wpr2.applied_at FROM swarm.wake_path_release AS wpr2 WHERE wpr2.singleton)
        AND swarm.actor_can_access_channel(
          observed_signal.workspace_id,
          observed_signal.channel_id,
          p_actor_kind,
          p_actor_id
        ))
    AND NOT EXISTS (SELECT 1 FROM swarm.signal_deliveries AS later
      JOIN swarm.signals AS later_signal
        ON later_signal.workspace_id = later.workspace_id AND later_signal.id = later.signal_id
      WHERE later.workspace_id = d.workspace_id
        AND later.recipient_agent_principal_id = d.recipient_agent_principal_id
        AND (date_trunc('milliseconds', later_signal.created_at), later_signal.id)
          > (date_trunc('milliseconds', s.created_at), s.id)
        AND later_signal.kind IN ('ask', 'note')
        AND swarm.actor_can_access_channel(
          later_signal.workspace_id,
          later_signal.channel_id,
          p_actor_kind,
          p_actor_id
        )
        AND (later_signal.to_agent_principal_id = d.recipient_agent_principal_id
          OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS later_recipient
            WHERE later_recipient.workspace_id = later_signal.workspace_id
              AND later_recipient.signal_id = later_signal.id
              AND later_recipient.recipient_agent_principal_id = d.recipient_agent_principal_id))
        AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL
        AND later.last_leased_by IS NULL);
END;
$$;

ALTER FUNCTION swarm.actor_wake_path_eligible_deliveries(text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.actor_wake_path_eligible_deliveries(text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

DROP FUNCTION swarm.agent_has_live_workspace_seat(uuid, uuid);
