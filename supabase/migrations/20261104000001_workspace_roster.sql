-- Agent roster R1a: one read of every agent in a workspace, for every member and agent.
--
-- Everything on a row is derived from activity the service already records; nothing is
-- self-reported yet (R2 adds platform, job and reports_to). Others' asks contribute a
-- count and the oldest time only: never an id, a body or a recipient.

-- The connection rule from home_overview (20261028000003), as one function so the roster
-- and later readers share it. home_overview keeps its inline copy for now; the server
-- test asserts both agree on the same fixtures.
CREATE OR REPLACE FUNCTION swarm_read.agent_connection_kind(
  p_workspace_id uuid, p_principal_id uuid
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT CASE
   WHEN coalesce(p.revoked_at, am.revoked_at) IS NOT NULL THEN 'removed'
   WHEN p.transport = 'hosted_mcp' THEN CASE
    WHEN hosted_policy.seat_revoked_at IS NULL AND hosted_policy.binding_revoked_at IS NULL
     AND hosted_policy.revoked_at IS NULL AND hosted_policy.state = 'active'
     AND hosted_policy.connection_expired_at IS NULL
     AND (hosted_policy.connection_expires_at IS NULL OR hosted_policy.connection_expires_at > clock_timestamp())
    THEN 'live' ELSE 'connection_off' END
   WHEN selected.is_live THEN 'live'
   WHEN local_policy.connection_expired_at IS NOT NULL OR local_policy.connection_expires_at <= clock_timestamp() THEN 'key_ended'
   WHEN local_policy.revoked_at IS NULL AND local_policy.suspension_active
    AND local_policy.connection_expired_at IS NULL
    AND (local_policy.connection_expires_at IS NULL OR local_policy.connection_expires_at > clock_timestamp()) THEN 'paused'
   WHEN local_policy.revoked_at IS NOT NULL THEN 'key_off'
   WHEN EXISTS (SELECT 1 FROM swarm.agent_tokens token WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL)
    THEN 'key_ended' ELSE 'key_off' END
  -- Agents belong to workspaces through agent_workspace_memberships, as in the
  -- swarm_read.agent_principals view; the base row's own workspace is only its first.
  FROM swarm.agent_principals p
  JOIN swarm.agent_workspace_memberships am USING (principal_id, owner_user_id)
  LEFT JOIN LATERAL swarm_read.local_connection_selection(am.workspace_id, p.principal_id, p.owner_user_id)
   selected ON p.transport = 'local'
  LEFT JOIN swarm.renewal_grants local_policy
   ON local_policy.renewal_grant_id = selected.selected_renewal_grant_id
  -- Select the newest target seat; old handles remain revoked after explicit re-add.
  LEFT JOIN LATERAL (
   SELECT g.*, seat.revoked_at AS seat_revoked_at,
    CASE WHEN swarm.hosted_binding_eligible(g.grant_id, seat.workspace_id, seat.principal_id)
     THEN NULL::timestamptz ELSE clock_timestamp() END AS binding_revoked_at
   FROM swarm.hosted_mcp_seats seat
   JOIN swarm.hosted_mcp_grants g ON g.grant_id = seat.grant_id AND g.owner_user_id = seat.owner_user_id
   WHERE p.transport = 'hosted_mcp' AND seat.workspace_id = am.workspace_id
     AND seat.principal_id = p.principal_id AND seat.owner_user_id = p.owner_user_id
   ORDER BY (seat.revoked_at IS NULL) DESC, seat.created_at DESC, seat.seat_id LIMIT 1
  ) hosted_policy ON true
  WHERE am.workspace_id = p_workspace_id AND p.principal_id = p_principal_id
$$;
ALTER FUNCTION swarm_read.agent_connection_kind(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.agent_connection_kind(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- The app's order and thresholds (site/src/lib/agent-status.ts): connection first, then a
-- stale wake path (WAKE_STALE_MS, 3 minutes, local agents with a watcher, channel or
-- listener), then activity age (10 minutes, 3 days).
CREATE OR REPLACE FUNCTION swarm_read.roster_status(
  p_connection text, p_transport text, p_has_wake_path boolean,
  p_messages_waiting_since timestamptz, p_last_activity_at timestamptz, p_read_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
   WHEN p_connection IS DISTINCT FROM 'live' THEN 'off'
   WHEN p_transport = 'local' AND p_has_wake_path
    AND p_messages_waiting_since <= p_read_at - interval '3 minutes' THEN 'not_picking_up'
   WHEN p_last_activity_at >= p_read_at - interval '10 minutes' THEN 'active'
   WHEN p_last_activity_at >= p_read_at - interval '3 days' THEN 'idle'
   ELSE 'inactive' END
$$;
ALTER FUNCTION swarm_read.roster_status(text, text, boolean, timestamptz, timestamptz, timestamptz) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.roster_status(text, text, boolean, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

CREATE OR REPLACE FUNCTION swarm_read.workspace_roster(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 caller uuid;
 caller_agent uuid;
 read_at timestamptz := statement_timestamp();
 result jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 caller := (claims->>'sub')::uuid;
 IF NOT swarm.is_member(p_workspace_id, caller) THEN RETURN NULL; END IF;
 -- An agent reads only the workspace it is bound to, and only while it is not revoked.
 IF claims ? 'agent_principal_id' THEN
  IF coalesce(claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   RETURN NULL;
  END IF;
  caller_agent := (claims->>'agent_principal_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM swarm.agent_principals p
   JOIN swarm.agent_workspace_memberships am USING (principal_id, owner_user_id)
   WHERE am.workspace_id = p_workspace_id AND p.principal_id = caller_agent
     AND p.owner_user_id = caller AND p.revoked_at IS NULL AND am.revoked_at IS NULL) THEN
   RETURN NULL;
  END IF;
 END IF;

 WITH agents AS MATERIALIZED (
  -- The roster view hides registration-only principals, as in home_overview.
  SELECT p.principal_id, p.workspace_id, p.name, p.transport, p.turn_only, p.owner_user_id
  FROM swarm_read.agent_principals p
  JOIN swarm.memberships owner_membership ON owner_membership.workspace_id = p.workspace_id
   AND owner_membership.user_id = p.owner_user_id AND owner_membership.revoked_at IS NULL
  WHERE p.workspace_id = p_workspace_id AND p.revoked_at IS NULL
  ORDER BY p.principal_id LIMIT 201
 ), page AS (
  SELECT * FROM agents ORDER BY principal_id LIMIT 200
 ), facts AS (
  SELECT a.*,
   swarm_read.agent_connection_kind(a.workspace_id, a.principal_id) AS connection,
   presence.watcher_at, presence.channel_at, presence.listener_at,
   -- Times only, as home_overview's last_activity_at.
   greatest(presence.last_command_at,
    (SELECT max(s.created_at) FROM swarm.signals s WHERE s.workspace_id = a.workspace_id AND s.from_kind = 'agent' AND s.from_principal = a.principal_id),
    (SELECT max(greatest(b.created_at, b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b WHERE b.workspace_id = a.workspace_id AND b.principal_id = a.principal_id),
    (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = a.workspace_id AND e.event->>'actor_agent_principal' = a.principal_id::text),
    (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
     WHERE e.workspace_id = a.workspace_id AND e.event->>'actor_agent_principal' = a.principal_id::text)) AS last_activity_at,
   (SELECT min(d.enqueued_at) FROM swarm.signal_deliveries d JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
    WHERE d.workspace_id = a.workspace_id AND d.recipient_agent_principal_id = a.principal_id AND d.acked_at IS NULL AND s.until > read_at) AS messages_waiting_since,
   working.created_at AS working_since, working.body AS working_body, working.whole_workspace,
   waiting.open_count, waiting.oldest_at
  FROM page a
  LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = a.workspace_id AND presence.principal_id = a.principal_id
  LEFT JOIN LATERAL (
   SELECT s.created_at, s.body,
    -- A true workspace-wide broadcast: no scalar addressee, no recipient rows, no channel,
    -- thread, reply or ask-chain scope. Anything narrower supplies only its time.
    (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL AND s.channel_id IS NULL
     AND s.in_reply_to IS NULL AND s.thread_root_id IS NULL AND s.chain_root_id IS NULL
     AND s.parent_signal_id IS NULL AND s.chain_participants IS NULL
     AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients r WHERE r.signal_id = s.id)) AS whole_workspace
   FROM swarm.signals s
   WHERE s.workspace_id = a.workspace_id AND s.from_kind = 'agent' AND s.from_principal = a.principal_id
     AND s.kind = 'working-on' AND s.until > read_at
   ORDER BY s.created_at DESC, s.id DESC LIMIT 1
  ) working ON true
  LEFT JOIN LATERAL (
   -- Open asks to people: unexpired, addressed to at least one person, and no addressed
   -- person has replied, either themselves or through one of their own agents.
   SELECT count(*)::integer AS open_count, min(s.created_at) AS oldest_at
   FROM swarm.signals s
   WHERE s.workspace_id = a.workspace_id AND s.from_kind = 'agent' AND s.from_principal = a.principal_id
     AND s.kind = 'ask' AND s.until > read_at
     AND EXISTS (
      SELECT 1 FROM (
       SELECT s.to_user_id AS user_id WHERE s.to_user_id IS NOT NULL
       UNION SELECT r.recipient_user_id FROM swarm.signal_recipients r
        WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id IS NOT NULL
      ) addressed)
     AND NOT EXISTS (
      SELECT 1 FROM (
       SELECT s.to_user_id AS user_id WHERE s.to_user_id IS NOT NULL
       UNION SELECT r.recipient_user_id FROM swarm.signal_recipients r
        WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id IS NOT NULL
      ) addressed
      JOIN swarm.signals reply ON reply.workspace_id = s.workspace_id AND reply.in_reply_to = s.id
      WHERE (reply.from_kind = 'user' AND reply.from_principal = addressed.user_id)
         OR (reply.from_kind = 'agent' AND EXISTS (
          -- The answering agent must be the addressed person's own agent, admitted to this
          -- same workspace.
          SELECT 1 FROM swarm.agent_principals rp
           JOIN swarm.agent_workspace_memberships ram USING (principal_id, owner_user_id)
           WHERE rp.principal_id = reply.from_principal AND rp.owner_user_id = addressed.user_id
             AND ram.workspace_id = s.workspace_id)))
  ) waiting ON true
 )
 SELECT jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'lead_agent_principal_id', (SELECT w.lead_agent_principal_id FROM swarm.workspaces w WHERE w.workspace_id = p_workspace_id),
  -- At most 200 agents, in principal_id order; truncated says the list is incomplete.
  'truncated', (SELECT count(*) FROM agents) > 200,
  'agents', coalesce(jsonb_agg(jsonb_build_object(
   'principal_id', f.principal_id,
   'name', f.name,
   'transport', f.transport,
   'turn_only', f.turn_only,
   'owner', jsonb_build_object('user_id', f.owner_user_id,
     'display_name', (SELECT u.display_name FROM swarm.users u WHERE u.user_id = f.owner_user_id)),
   'status', swarm_read.roster_status(f.connection, f.transport,
     coalesce(f.watcher_at, f.channel_at, f.listener_at) IS NOT NULL,
     f.messages_waiting_since, f.last_activity_at, read_at),
   'connection', f.connection,
   'last_activity_at', f.last_activity_at,
   'open_work', CASE WHEN f.working_since IS NULL THEN NULL ELSE jsonb_build_object(
     'since', f.working_since,
     'text', CASE WHEN f.whole_workspace THEN left(f.working_body, 200) ELSE NULL END) END,
   'waiting_on_people', jsonb_build_object('count', coalesce(f.open_count, 0),
     'since', CASE WHEN coalesce(f.open_count, 0) > 0 THEN f.oldest_at ELSE NULL END),
   'platform', NULL, 'job', NULL, 'reports_to', NULL, 'parent', NULL,
   'source', 'commonswarm'
  ) ORDER BY f.name, f.principal_id), '[]'::jsonb))
 INTO result FROM facts f;
 RETURN result;
END;
$$;
ALTER FUNCTION swarm_read.workspace_roster(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.workspace_roster(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
-- swarm_read only: the read function's agent and hosted paths, after their own live
-- authorization. The web page (R2) adds its role when it ships.
GRANT EXECUTE ON FUNCTION swarm_read.workspace_roster(uuid) TO swarm_read;
