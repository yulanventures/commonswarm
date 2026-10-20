-- Pure read selection shared by the two human projections. No auth/use calls.
-- Only the existing SECURITY DEFINER readers (owned by swarm_admin) call it.
CREATE OR REPLACE FUNCTION swarm_read.local_connection_selection(
 p_workspace_id uuid,p_principal_id uuid,p_owner_user_id uuid)
RETURNS TABLE(selected_renewal_grant_id uuid,selected_token_id uuid,is_live boolean)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 WITH eligible_tokens AS MATERIALIZED (
       SELECT t.token_id,t.renewal_grant_id,t.issued_at FROM swarm.agent_tokens t
        JOIN swarm.agent_principals p ON p.principal_id=t.principal_id
        JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
        JOIN swarm.devices d ON d.device_id=r.device_id
        LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
        JOIN swarm.memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
        JOIN swarm.workspaces w ON w.workspace_id=p.workspace_id
        WHERE p.workspace_id=p_workspace_id AND p.principal_id=p_principal_id
          AND p.owner_user_id=p_owner_user_id AND p.transport='local' AND p.revoked_at IS NULL AND NOT p.turn_only
          AND t.revoked_at IS NULL AND NOT t.surrender_only AND r.ended_at IS NULL AND d.revoked_at IS NULL
          AND d.user_id=p.owner_user_id AND m.revoked_at IS NULL AND w.archived_at IS NULL
          AND (t.renewal_grant_id IS NULL OR g.renewal_grant_id IS NOT NULL AND g.revoked_at IS NULL
            AND NOT (g.suspension_active AND g.kind<>'standing')
            AND g.connection_expired_at IS NULL AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
            AND ROW(g.principal_id,g.run_id,g.workspace_id,g.created_by)=ROW(t.principal_id,t.run_id,p.workspace_id,p.owner_user_id)
            AND (g.bound_device_id IS NULL OR g.bound_device_id=d.device_id))
          AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[t.parent_admin_grant_id,p.parent_admin_grant_id]) parent(id)
          WHERE parent.id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM swarm.admin_grants a
            JOIN swarm.memberships am ON am.workspace_id=p.workspace_id AND am.user_id=a.owner_user_id
            JOIN swarm.workspaces aw ON aw.workspace_id=am.workspace_id
            LEFT JOIN swarm.admin_created_workspaces ac ON ac.workspace_id=p.workspace_id
            WHERE a.grant_id=parent.id AND a.state='active' AND a.revoked_at IS NULL
              AND a.expires_at>clock_timestamp() AND a.refresh_deadline>clock_timestamp()
              AND am.revoked_at IS NULL AND am.role IN ('owner','admin') AND aw.archived_at IS NULL
              AND NOT p.workspace_id=ANY(a.withdrawn_workspace_ids)
              AND (p.workspace_id=ANY(a.workspace_ids) OR ac.grant_id=a.grant_id
                OR a.workspace_selector='owned_and_selected' AND am.role='owner')
              AND (ac.grant_id IS DISTINCT FROM a.grant_id OR
                'seats:create'=ANY(ac.scope_names) AND a.created_workspace_policy->'scope_names' ? 'seats:create')
              AND jsonb_typeof(t.scopes)='array' AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(t.scopes) s(scope) WHERE NOT s.scope=ANY(a.worker_scope_ceiling))))
          AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
            (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
             ('membership',p.owner_user_id),('lineage',t.lineage_id),('family',t.lineage_id),('renewal_grant',t.renewal_grant_id)))
          AND (t.expires_at>clock_timestamp() OR (g.kind='standing' AND (t.first_used_at IS NOT NULL
          OR (t.first_used_at IS NULL AND t.predecessor_token_id IS NULL
            AND g.horizon_expires_at IS NULL AND g.max_successors IS NULL)
          OR EXISTS (
          SELECT 1 FROM swarm.agent_tokens predecessor WHERE predecessor.token_id=t.predecessor_token_id
            AND predecessor.first_used_at IS NOT NULL AND predecessor.revoked_at IS NULL AND NOT predecessor.surrender_only
            AND ROW(predecessor.principal_id,predecessor.run_id,predecessor.renewal_grant_id,predecessor.lineage_id,predecessor.parent_admin_grant_id)
              IS NOT DISTINCT FROM ROW(t.principal_id,t.run_id,t.renewal_grant_id,t.lineage_id,t.parent_admin_grant_id)
            AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='token' AND z.target_id=predecessor.token_id)))
          AND NOT EXISTS (SELECT 1 FROM swarm.agent_tokens child WHERE child.predecessor_token_id=t.token_id
            AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)))
 ), choices AS (
  SELECT g.renewal_grant_id,t.token_id,(e.token_id IS NOT NULL) AS eligible,
    (g.revoked_at IS NULL) AS unrevoked,g.created_at
  FROM swarm.renewal_grants g
  LEFT JOIN LATERAL (
   SELECT candidate.token_id FROM swarm.agent_tokens candidate
   LEFT JOIN eligible_tokens usable ON usable.token_id=candidate.token_id
   WHERE candidate.renewal_grant_id=g.renewal_grant_id
   ORDER BY (usable.token_id IS NOT NULL) DESC,candidate.issued_at DESC,candidate.token_id DESC LIMIT 1
  ) t ON true
  LEFT JOIN eligible_tokens e ON e.token_id=t.token_id
  WHERE g.workspace_id=p_workspace_id AND g.principal_id=p_principal_id AND g.created_by=p_owner_user_id
  UNION ALL
  SELECT NULL,e.token_id,true,true,e.issued_at FROM eligible_tokens e WHERE e.renewal_grant_id IS NULL
 )
 SELECT c.renewal_grant_id,c.token_id,c.eligible FROM choices c
 ORDER BY c.eligible DESC,(c.renewal_grant_id IS NOT NULL) DESC,c.unrevoked DESC,
   c.created_at DESC,c.renewal_grant_id DESC,c.token_id DESC LIMIT 1
$$;
ALTER FUNCTION swarm_read.local_connection_selection(uuid,uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.local_connection_selection(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;

-- v10 forward read truth. 00009 is reserved for hosted snapshot compatibility.
-- Keep this additive schema and a chosen-date-enforcing runtime on rollback.
-- e565 runtime alone is not a safe rollback floor.
CREATE OR REPLACE FUNCTION swarm_read.home_overview() RETURNS jsonb
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
    -- Pick one reason per to-do before the 20-to-do bound: request, after, hold, agent_removed.
    CROSS JOIN LATERAL (
     SELECT CASE
     WHEN t.offer_id IS NOT NULL AND t.offer_decider = viewer THEN 'request'
     WHEN t.gate_kind = 'after' AND EXISTS (
      SELECT 1 FROM swarm.household_todos prerequisite WHERE prerequisite.workspace_id = t.workspace_id
       AND prerequisite.todo_id = t.gate_todo_id AND prerequisite.assignee_user = viewer AND prerequisite.state IN ('open','doing')) THEN 'after'
     WHEN t.gate_kind = 'hold' AND p.owner_user_id = viewer AND p.revoked_at IS NULL THEN 'hold'
     WHEN p.owner_user_id = viewer AND p.revoked_at IS NOT NULL THEN 'agent_removed'
     END AS kind
    ) reason
    WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing') AND reason.kind IS NOT NULL
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
    CASE WHEN p.transport='hosted_mcp' AND hosted_policy.grant_id IS NOT NULL THEN
      jsonb_build_object('connection_expires_at',hosted_policy.connection_expires_at,
        'connection_expired_at',coalesce(hosted_policy.connection_expired_at,
          CASE WHEN hosted_policy.connection_expires_at<=clock_timestamp() THEN hosted_policy.connection_expires_at END))
    WHEN p.transport='local' AND local_policy.renewal_grant_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',local_policy.renewal_grant_id,
        'connection_expires_at',local_policy.connection_expires_at,
        'connection_expired_at',coalesce(local_policy.connection_expired_at,
          CASE WHEN local_policy.connection_expires_at<=clock_timestamp() THEN local_policy.connection_expires_at END))
        || CASE WHEN selected.selected_token_id IS NOT NULL THEN jsonb_build_object('token_id',selected.selected_token_id) ELSE '{}'::jsonb END
    WHEN p.transport='local' AND selected.selected_token_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',NULL,'token_id',selected.selected_token_id)
    ELSE '{}'::jsonb END AS connection_policy,
    -- Raw signals are safe here: last_activity_at exposes only a time, no content or signal id.
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
    FROM swarm_read.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s."from" = p.principal_id
     AND s.kind = 'working-on' AND s.until > read_at ORDER BY s.created_at DESC, s.id LIMIT 1
   ) working ON true
   LEFT JOIN LATERAL swarm_read.local_connection_selection(p.workspace_id,p.principal_id,p.owner_user_id)
    selected ON p.transport='local'
   LEFT JOIN swarm.renewal_grants local_policy
    ON local_policy.renewal_grant_id=selected.selected_renewal_grant_id
   -- principal_id is UNIQUE on seats: policy and status share this same grant.
   LEFT JOIN LATERAL (
    SELECT g.*,seat.revoked_at AS seat_revoked_at,binding.revoked_at AS binding_revoked_at
    FROM swarm.hosted_mcp_seats seat
    JOIN swarm.hosted_mcp_grant_workspaces binding ON binding.grant_id=seat.grant_id
      AND binding.workspace_id=seat.workspace_id AND binding.owner_user_id=seat.owner_user_id
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=binding.grant_id AND g.owner_user_id=binding.owner_user_id
    WHERE p.transport='hosted_mcp' AND seat.workspace_id=p.workspace_id
      AND seat.principal_id=p.principal_id AND seat.owner_user_id=p.owner_user_id
   ) hosted_policy ON true
   CROSS JOIN LATERAL (
    SELECT CASE
     WHEN p.revoked_at IS NOT NULL THEN 'removed'
     WHEN p.transport = 'hosted_mcp' THEN CASE
      WHEN hosted_policy.seat_revoked_at IS NULL AND hosted_policy.binding_revoked_at IS NULL
       AND hosted_policy.revoked_at IS NULL AND hosted_policy.state='active'
       AND hosted_policy.connection_expired_at IS NULL
       AND (hosted_policy.connection_expires_at IS NULL OR hosted_policy.connection_expires_at>clock_timestamp())
      THEN 'live' ELSE 'connection_off' END
     WHEN selected.is_live THEN 'live'
     WHEN local_policy.connection_expired_at IS NOT NULL OR local_policy.connection_expires_at<=clock_timestamp() THEN 'key_ended'
     WHEN local_policy.revoked_at IS NULL AND local_policy.suspension_active AND local_policy.kind<>'standing'
      AND local_policy.connection_expired_at IS NULL
      AND (local_policy.connection_expires_at IS NULL OR local_policy.connection_expires_at>clock_timestamp()) THEN 'paused'
     WHEN local_policy.revoked_at IS NOT NULL THEN 'key_off'
     WHEN EXISTS (SELECT 1 FROM swarm.agent_tokens token WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL)
      THEN 'key_ended' ELSE 'key_off' END AS kind
   ) connection
  ), rows AS (
   SELECT m.*, coalesce((SELECT jsonb_agg(jsonb_build_object('principal_id',a.principal_id,'name',a.name,
    'status',jsonb_build_object('work',CASE WHEN a.connection <> 'live' THEN 'disconnected'
     WHEN (a.doing IS NOT NULL OR a.working_on IS NOT NULL) AND a.last_activity_at >= read_at - interval '30 minutes' THEN 'working' ELSE 'idle' END,
     'facts',jsonb_build_object('transport',a.transport,'turn_only',a.turn_only,'connection',a.connection,
      'last_activity_at',a.last_activity_at,'messages_waiting_since',a.messages_waiting_since,'doing',a.doing,'working_on',a.working_on) || a.connection_policy),
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

-- Append fields only; CREATE OR REPLACE preserves existing SELECT ACLs.
CREATE OR REPLACE VIEW swarm_read.hosted_mcp_connections
WITH (security_barrier = true)
AS
  SELECT g.grant_id, g.client_id, g.resource, g.home_workspace_id,
         g.selected_workspace_ids, g.state, g.created_at, g.activated_at,
         g.revoked_at, g.connection_expires_at,
         COALESCE(g.connection_expired_at, CASE WHEN g.connection_expires_at<=clock_timestamp()
           THEN g.connection_expires_at END) AS connection_expired_at
  FROM swarm.hosted_mcp_grants AS g
  WHERE g.owner_user_id = auth.uid();
ALTER VIEW swarm_read.hosted_mcp_connections OWNER TO swarm_admin;

-- Replace the existing human roster only; the token-scoped reader is unchanged.
CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_roster(p_workspace_id uuid)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz,
  connection_expires_at timestamptz,
  connection_expired_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
BEGIN
  IF v_user_id IS NULL OR NOT swarm.is_member(p_workspace_id, v_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    CASE WHEN grant_row.suspension_active AND grant_row.kind<>'standing' THEN grant_row.suspended_at END,
    grant_row.revoked_at,
    token.token_id,
    token.issued_at,
    token.expires_at,
    token.first_used_at,
    token.revoked_at,
    grant_row.connection_expires_at,COALESCE(grant_row.connection_expired_at,
      CASE WHEN grant_row.connection_expires_at<=clock_timestamp() THEN grant_row.connection_expires_at END)
  FROM swarm.agent_principals AS principal
  JOIN LATERAL swarm_read.local_connection_selection(
    p_workspace_id,principal.principal_id,principal.owner_user_id) selected ON true
  JOIN swarm.renewal_grants grant_row ON grant_row.renewal_grant_id=selected.selected_renewal_grant_id
  LEFT JOIN swarm.agent_tokens token ON token.token_id=selected.selected_token_id
  WHERE principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL
  ORDER BY principal.principal_id;
END;
$$;

ALTER FUNCTION swarm_read.renewal_grant_roster(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_roster(uuid)
  TO authenticated, swarm_read;
