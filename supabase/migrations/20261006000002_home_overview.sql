-- Human catch-up read. No locks, writes, scheduler, or model start.
-- Requires 20261006000001_household_todos.sql. AM6: only messages are new.
CREATE FUNCTION swarm.household_human_can_read(p_workspace uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
 SELECT EXISTS (
  SELECT 1 FROM swarm.memberships m
  JOIN swarm.workspaces w USING (workspace_id)
  JOIN swarm.household_workspace_boundaries b USING (workspace_id)
  JOIN swarm.household_member_content_roles r USING (workspace_id, user_id)
  WHERE m.workspace_id = p_workspace AND m.user_id = p_user
   AND m.revoked_at IS NULL AND w.archived_at IS NULL
   AND (b.purpose = 'shared' OR b.owner_user_id = p_user)
   AND r.revoked_at IS NULL AND r.content_consent_id IS NOT NULL
   AND r.content_role IN ('reader', 'editor')
 );
$$;
ALTER FUNCTION swarm.household_human_can_read(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.household_human_can_read(uuid, uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

CREATE FUNCTION swarm_read.home_overview() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 workspace record;
 can_read boolean;
 last_seen timestamptz;
 new_messages integer;
 content jsonb;
 people jsonb;
 asks jsonb;
 assigned jsonb;
 waiting jsonb;
 result jsonb := '[]'::jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR claims ? 'agent_principal_id' OR nullif(claims->>'sub', '') IS NULL THEN
  RETURN NULL;
 END IF;
 -- Malformed identity is refused rather than cast into a different identity.
 IF claims->>'sub' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 viewer := (claims->>'sub')::uuid;
 FOR workspace IN
  SELECT w.workspace_id, w.name, m.role
  FROM swarm.workspaces w JOIN swarm.memberships m USING (workspace_id)
  WHERE m.user_id = viewer AND m.revoked_at IS NULL AND w.archived_at IS NULL
  ORDER BY w.created_at, w.workspace_id LIMIT 50
 LOOP
  can_read := swarm.household_human_can_read(workspace.workspace_id, viewer);
  SELECT max(r.first_seen_at) INTO last_seen FROM swarm.signal_human_receipts r
   WHERE r.workspace_id = workspace.workspace_id AND r.user_id = viewer;
  SELECT count(*) INTO new_messages FROM (
   SELECT s.id FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id
    AND NOT (s.from_kind = 'user' AND s."from" = viewer)
    AND NOT (s.from_kind = 'agent' AND EXISTS (
     SELECT 1 FROM swarm.agent_principals p WHERE p.workspace_id = s.workspace_id
      AND p.principal_id = s."from" AND p.owner_user_id = viewer))
    AND s.created_at > coalesce(last_seen, read_at - interval '7 days')
   LIMIT 99
  ) messages;
  SELECT coalesce(jsonb_agg(a.value ORDER BY a.created_at DESC, a.id), '[]'::jsonb) INTO asks FROM (
   SELECT s.id, s.created_at, jsonb_build_object('signal_id', s.id,
    'from', jsonb_build_object('kind', s.from_kind, 'id', s."from"),
    'created_at', s.created_at, 'until', s.until) AS value
   FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id AND s.kind = 'ask' AND s.until > read_at
    AND (s."to" = viewer OR EXISTS (
     SELECT 1 FROM swarm.signal_recipients r WHERE r.workspace_id = s.workspace_id
      AND r.signal_id = s.id AND r.recipient_user_id = viewer))
    AND NOT EXISTS (
     SELECT 1 FROM swarm.signals reply WHERE reply.workspace_id = s.workspace_id AND reply.in_reply_to = s.id
      AND ((reply.from_kind = 'user' AND reply.from_principal = viewer)
       OR (reply.from_kind = 'agent' AND EXISTS (
        SELECT 1 FROM swarm.agent_principals p WHERE p.workspace_id = reply.workspace_id
         AND p.principal_id = reply.from_principal AND p.owner_user_id = viewer))))
   ORDER BY s.created_at DESC, s.id LIMIT 10
  ) a;
  content := NULL;
  assigned := '[]'::jsonb;
  waiting := '[]'::jsonb;
  IF can_read THEN
   SELECT jsonb_build_object('open_todos', (
    SELECT count(*) FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing')),
    'lists', count(*) FILTER (WHERE o.value->>'kind' = 'list'),
    'docs', count(*) FILTER (WHERE o.value->>'kind' = 'doc'),
    'files', count(*) FILTER (WHERE o.value->>'kind' = 'file')) INTO content
   FROM swarm.household_object_streams os
   CROSS JOIN LATERAL jsonb_each(coalesce(os.projection->'objects', '{}'::jsonb)) o
   WHERE os.workspace_id = workspace.workspace_id;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id), '[]'::jsonb) INTO assigned FROM (
    SELECT t.todo_id, t.state_at, jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on) value
    FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
     AND t.assignee_user = viewer AND t.state IN ('open','doing')
    ORDER BY t.state_at DESC, t.todo_id LIMIT 20
   ) a;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id, a.reason), '[]'::jsonb) INTO waiting FROM (
    SELECT t.todo_id, t.state_at, reason.kind AS reason,
     jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on,
      'reason',reason.kind,'agent_id', CASE WHEN reason.kind = 'request' THEN t.offer_principal ELSE t.assignee_principal END) value
    FROM swarm.household_todos t
    LEFT JOIN swarm.agent_principals p ON p.workspace_id = t.workspace_id AND p.principal_id = t.assignee_principal
    CROSS JOIN LATERAL (
     SELECT 'request' AS kind WHERE t.offer_id IS NOT NULL AND t.offer_decider = viewer
     UNION ALL SELECT 'after' WHERE t.gate_kind = 'after' AND EXISTS (
      SELECT 1 FROM swarm.household_todos prerequisite WHERE prerequisite.workspace_id = t.workspace_id
       AND prerequisite.todo_id = t.gate_todo_id AND prerequisite.assignee_user = viewer AND prerequisite.state IN ('open','doing'))
     UNION ALL SELECT 'hold' WHERE t.gate_kind = 'hold' AND p.owner_user_id = viewer AND p.revoked_at IS NULL
     UNION ALL SELECT 'agent_removed' WHERE p.owner_user_id = viewer AND p.revoked_at IS NOT NULL
    ) reason
    WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing')
    ORDER BY t.state_at DESC, t.todo_id, reason.kind LIMIT 20
   ) a;
  END IF;
  WITH members AS MATERIALIZED (
   SELECT m.user_id, m.role, u.display_name FROM swarm.memberships m JOIN swarm.users u USING (user_id)
   WHERE m.workspace_id = workspace.workspace_id AND m.revoked_at IS NULL
   ORDER BY (m.user_id = viewer) DESC, m.user_id LIMIT 25
  ), agents AS MATERIALIZED (
   -- Use the existing roster view: registration-only principals stay hidden.
   SELECT p.* FROM swarm_read.agent_principals p JOIN members m ON m.user_id = p.owner_user_id
   WHERE p.workspace_id = workspace.workspace_id
   ORDER BY (p.owner_user_id = viewer) DESC, p.owner_user_id, p.principal_id LIMIT 50
  ), todo_facts AS MATERIALIZED (
   SELECT t.*, CASE t.gate_kind
    WHEN 'none' THEN true WHEN 'hold' THEN false WHEN 'at' THEN t.gate_at <= read_at
    WHEN 'after' THEN EXISTS (SELECT 1 FROM swarm.household_todos predecessor
     WHERE predecessor.workspace_id = t.workspace_id AND predecessor.todo_id = t.gate_todo_id AND predecessor.state IN ('done','dropped'))
    ELSE false END AS gate_clear
   FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
  ), agent_facts AS (
   SELECT p.*, connection.kind AS connection,
    greatest(presence.last_command_at,
     (SELECT max(s.created_at) FROM swarm.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id),
     (SELECT max(greatest(b.created_at,b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b WHERE b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id),
     (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text),
     (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
      WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text)) AS last_activity_at,
    (SELECT min(d.enqueued_at) FROM swarm.signal_deliveries d JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
     WHERE d.workspace_id = p.workspace_id AND d.recipient_agent_principal_id = p.principal_id AND d.acked_at IS NULL AND s.until > read_at) AS messages_waiting_since,
    doing.value AS doing, working.value AS working_on,
    CASE WHEN can_read THEN jsonb_build_object(
     'working',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'),
     'up_next',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND t.gate_clear),
     'not_yet',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND NOT t.gate_clear),
     'requests',(SELECT count(*) FROM todo_facts t WHERE t.offer_principal = p.principal_id AND t.offer_id IS NOT NULL AND t.state IN ('open','doing'))) ELSE NULL END AS queue
   FROM agents p
   LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = p.workspace_id AND presence.principal_id = p.principal_id
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('todo_id',t.todo_id,'title',CASE WHEN can_read THEN t.title ELSE NULL END,'since',t.state_at) value
    FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'
    ORDER BY t.state_at DESC, t.todo_id LIMIT 1
   ) doing ON true
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('signal_id',s.id,'at',s.created_at,'until',s.until) value
    FROM swarm.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id
     AND s.kind = 'working-on' AND s.until > read_at ORDER BY s.created_at DESC, s.id LIMIT 1
   ) working ON true
   CROSS JOIN LATERAL (
    SELECT CASE
     WHEN p.revoked_at IS NOT NULL THEN 'removed'
     WHEN p.transport = 'hosted_mcp' THEN CASE WHEN EXISTS (
      SELECT 1 FROM swarm.hosted_mcp_seats seat
      JOIN swarm.hosted_mcp_grant_workspaces binding ON binding.grant_id = seat.grant_id AND binding.workspace_id = seat.workspace_id AND binding.owner_user_id = seat.owner_user_id
      JOIN swarm.hosted_mcp_grants g ON g.grant_id = binding.grant_id AND g.owner_user_id = binding.owner_user_id
      WHERE seat.workspace_id = p.workspace_id AND seat.principal_id = p.principal_id AND seat.owner_user_id = p.owner_user_id
       AND seat.revoked_at IS NULL AND binding.revoked_at IS NULL AND g.revoked_at IS NULL AND g.state = 'active') THEN 'live' ELSE 'key_off' END
     WHEN EXISTS (
      SELECT 1 FROM swarm.agent_tokens token JOIN swarm.agent_runs run ON run.run_id = token.run_id AND run.principal_id = token.principal_id
      JOIN swarm.devices device ON device.device_id = run.device_id
      WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL AND token.expires_at > read_at AND NOT token.surrender_only
       AND run.ended_at IS NULL AND device.revoked_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM swarm.revocation_tombstones tomb WHERE (tomb.kind,tomb.target_id) IN (
         ('token',token.token_id),('principal',p.principal_id),('run',run.run_id),('device',device.device_id),
         ('membership',p.owner_user_id),('lineage',token.lineage_id),('family',token.lineage_id)))) THEN 'live'
     WHEN EXISTS (
      SELECT 1 FROM swarm.renewal_grants g JOIN swarm.agent_runs run ON run.run_id = g.run_id AND run.principal_id = g.principal_id
      JOIN swarm.devices device ON device.device_id = run.device_id
      WHERE g.workspace_id = p.workspace_id AND g.principal_id = p.principal_id AND g.revoked_at IS NULL AND NOT g.suspension_active
       AND run.ended_at IS NULL AND device.revoked_at IS NULL
       AND ((g.kind = 'standing' AND g.bound_device_id = run.device_id)
        OR (g.kind = 'timeboxed' AND g.horizon_expires_at > read_at AND g.successors_used - g.successors_stranded < g.max_successors))
       AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones tomb WHERE (tomb.kind,tomb.target_id) IN (
        ('renewal_grant',g.renewal_grant_id),('principal',p.principal_id),('run',run.run_id),('device',device.device_id),('membership',p.owner_user_id)))) THEN 'live'
     WHEN EXISTS (SELECT 1 FROM swarm.renewal_grants g WHERE g.workspace_id = p.workspace_id AND g.principal_id = p.principal_id AND g.revoked_at IS NULL AND g.suspension_active) THEN 'paused'
     WHEN EXISTS (SELECT 1 FROM swarm.agent_tokens token WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL)
      THEN 'key_ended' ELSE 'key_off' END AS kind
   ) connection
  ), rows AS (
   SELECT m.*, coalesce((SELECT jsonb_agg(jsonb_build_object('principal_id',a.principal_id,'name',a.name,
    'status',jsonb_build_object('work',CASE WHEN a.connection <> 'live' THEN 'disconnected'
     WHEN (a.doing IS NOT NULL OR a.working_on IS NOT NULL) AND a.last_activity_at >= read_at - interval '30 minutes' THEN 'working' ELSE 'idle' END,
     'facts',jsonb_build_object('transport',a.transport,'turn_only',a.turn_only,'connection',a.connection,
      'last_activity_at',a.last_activity_at,'messages_waiting_since',a.messages_waiting_since,'doing',a.doing,'working_on',a.working_on)),
    'queue',a.queue) ORDER BY a.principal_id) FROM agent_facts a WHERE a.owner_user_id = m.user_id),'[]'::jsonb) AS agents
   FROM members m
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',r.user_id,'display_name',r.display_name,'role',r.role,
   'is_viewer',r.user_id = viewer,'agents',r.agents) ORDER BY (r.user_id = viewer) DESC,r.user_id),'[]'::jsonb) INTO people FROM rows r;
  result := result || jsonb_build_array(jsonb_build_object('workspace_id',workspace.workspace_id,'name',workspace.name,'role',workspace.role,
   'last_seen_at',last_seen,'new_messages',new_messages,'content',content,'people',people,
   'needs_you',jsonb_build_object('asks',asks,'assigned',assigned,'waiting',waiting)));
 END LOOP;
 RETURN jsonb_build_object('viewer_user_id',viewer,'generated_at',read_at,'workspaces',result);
END;
$$;
ALTER FUNCTION swarm_read.home_overview() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.home_overview() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.home_overview() TO authenticated;
