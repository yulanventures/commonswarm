-- Per-seat command and wake-route presence. The command edge is the only
-- writer; clients read the member-scoped view instead of this base table.
CREATE TABLE swarm.agent_presence (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  last_command_at timestamptz NOT NULL,
  client_build text,
  watcher_at timestamptz,
  channel_at timestamptz,
  listener_at timestamptz,
  turn_at timestamptz,
  PRIMARY KEY (workspace_id, principal_id),
  FOREIGN KEY (principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id),
  CHECK (client_build IS NULL OR length(client_build) <= 64)
);
ALTER TABLE swarm.agent_presence OWNER TO swarm_admin;
ALTER TABLE swarm.agent_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_presence_command_all ON swarm.agent_presence
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.agent_presence FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, UPDATE ON swarm.agent_presence TO swarm_command;

ALTER TABLE swarm.signal_deliveries
  ADD COLUMN ack_via text
  CHECK (ack_via IN ('leased', 'unclaimed'));
CREATE INDEX signal_deliveries_presence_latest_ack
  ON swarm.signal_deliveries (
    workspace_id, recipient_agent_principal_id, acked_at DESC, signal_id DESC
  )
  WHERE acked_at IS NOT NULL;

INSERT INTO swarm.config (key, value)
VALUES ('current_client_build', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Raw member-visible facts. A pre-G3d or server-terminalized newest ACK keeps
-- its real time and reports a NULL route instead of inventing one.
CREATE VIEW swarm_read.agent_presence WITH (security_barrier = true) AS
SELECT
  presence.workspace_id,
  presence.principal_id,
  presence.last_command_at,
  presence.client_build,
  presence.watcher_at,
  presence.channel_at,
  presence.listener_at,
  presence.turn_at,
  latest_ack.ack_via AS last_ack_via,
  latest_ack.acked_at AS last_ack_at,
  (
    SELECT CASE WHEN jsonb_typeof(config.value) = 'string'
      THEN config.value #>> '{}'
      ELSE NULL
    END
    FROM swarm.config AS config
    WHERE config.key = 'current_client_build'
  ) AS current_client_build
FROM swarm.agent_presence AS presence
LEFT JOIN LATERAL (
  SELECT delivery.ack_via, delivery.acked_at
  FROM swarm.signal_deliveries AS delivery
  WHERE delivery.workspace_id = presence.workspace_id
    AND delivery.recipient_agent_principal_id = presence.principal_id
    AND delivery.acked_at IS NOT NULL
  ORDER BY delivery.acked_at DESC, delivery.signal_id DESC
  LIMIT 1
) AS latest_ack ON true
WHERE swarm.is_member(presence.workspace_id, auth.uid());
ALTER VIEW swarm_read.agent_presence OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.agent_presence FROM PUBLIC, anon;
GRANT SELECT ON swarm_read.agent_presence TO authenticated, swarm_read;
