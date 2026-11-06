-- Message status for agents, slice 1: Delivered, Seen, Working (with a coarse label) and Replied
-- for messages a person sent to a specific agent.
--
-- Working is a short-lived snapshot on the agent's presence row, written only by the activity
-- edge from a status frame. The edge binds the frame to a delivery addressed to the calling agent,
-- sets working_until from server time (two minutes) and orders frames by stream and sequence.
-- swarm_read.agent_presence lists its columns explicitly and is not changed, so the message id and
-- label never reach a workspace-wide read. They are returned only by message_status below, to a
-- person who can already read that message.

ALTER TABLE swarm.agent_presence
  ADD COLUMN working_signal_id uuid,
  ADD COLUMN working_label text,
  ADD COLUMN working_until timestamptz,
  ADD COLUMN working_stream_id uuid,
  ADD COLUMN working_sequence bigint,
  ADD CONSTRAINT agent_presence_working_label_valid CHECK (
    working_label IS NULL OR working_label IN (
      'thinking', 'reading', 'editing', 'searching', 'running_command', 'searching_web', 'using_tool'
    )
  ),
  ADD CONSTRAINT agent_presence_working_complete CHECK (
    num_nonnulls(working_signal_id, working_label, working_until) IN (0, 3)
  ),
  ADD CONSTRAINT agent_presence_working_order_complete CHECK (
    num_nonnulls(working_stream_id, working_sequence) IN (0, 2)
    AND (working_sequence IS NULL OR working_sequence >= 1)
    AND (working_signal_id IS NULL OR working_stream_id IS NOT NULL)
  );

-- Per message and addressed agent, for up to 50 messages the signed-in person can read:
--   delivered - the agent's client received it (leased, routed to a session, or acknowledged);
--   seen      - the agent saw it (acknowledged observed or replied);
--   replied   - acknowledged replied, or the agent has posted a reply to it;
--   working   - {label, until} while the agent's current Working snapshot names this message and
--               has not expired by server time; otherwise null.
-- People only: EXECUTE is granted to authenticated, and claims that name an agent are refused.
-- Messages come from swarm_read.signals under the caller's claims, so unreadable and unknown ids
-- both return nothing.
CREATE OR REPLACE FUNCTION swarm_read.message_status(p_workspace_id uuid, p_signal_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN RETURN NULL; END IF;
 IF p_signal_ids IS NULL OR cardinality(p_signal_ids) > 50 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'statuses', (
   SELECT coalesce(jsonb_agg(jsonb_build_object(
     'signal_id', s.id,
     'agent_principal_id', d.recipient_agent_principal_id,
     'delivered', d.delivered_at IS NOT NULL OR d.ack_outcome IN ('queued', 'observed', 'replied'),
     'seen', d.ack_outcome IN ('observed', 'replied'),
     'replied', d.ack_outcome = 'replied' OR EXISTS (
       SELECT 1 FROM swarm_read.signals r
       WHERE r.workspace_id = p_workspace_id AND r.in_reply_to = s.id
         AND r.from_kind = 'agent' AND r."from" = d.recipient_agent_principal_id),
     'working', (
       SELECT jsonb_build_object('label', p.working_label, 'until', p.working_until)
       FROM swarm.agent_presence p
       WHERE p.workspace_id = p_workspace_id
         AND p.principal_id = d.recipient_agent_principal_id
         AND p.working_signal_id = s.id
         AND p.working_until > read_at))
    ORDER BY s.id, d.recipient_agent_principal_id), '[]'::jsonb)
   FROM swarm_read.signals s
   JOIN swarm.signal_deliveries d
     ON d.signal_id = s.id AND d.workspace_id = s.workspace_id
   WHERE s.workspace_id = p_workspace_id
     AND s.id = ANY (p_signal_ids)
     AND s.from_kind = 'user' AND s."from" = viewer));
END;
$$;
ALTER FUNCTION swarm_read.message_status(uuid, uuid[]) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.message_status(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.message_status(uuid, uuid[]) TO authenticated;
