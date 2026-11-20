-- C2 Live Seat Status:
-- 1. Expose unseen_count alongside oldest_unobserved_at on swarm_read.agent_wake_path.
-- 2. Expose messages_waiting ({count, since}), wake ({watcher_at, channel_at, listener_at, turn_at}),
--    and open-channel working-on text (keeping private-channel and addressed titles null) on
--    swarm_read.workspace_roster(uuid).
-- 3. Expose messages_waiting_count and wake inside status.facts on swarm_read.home_overview().
-- All new fields preserve private-channel isolation and caller-scoped access gates.

CREATE OR REPLACE VIEW swarm_read.agent_wake_path
WITH (security_barrier = true)
AS
SELECT
  workspace_id,
  principal_id,
  min(enqueued_at) AS oldest_unobserved_at,
  count(*)::integer AS unseen_count
FROM swarm_read.agent_wake_path_deliveries
GROUP BY workspace_id, principal_id;

ALTER VIEW swarm_read.agent_wake_path OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.agent_wake_path TO authenticated;

CREATE OR REPLACE FUNCTION swarm_read.workspace_roster(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 caller uuid;
 caller_agent uuid;
 v_actor_kind text;
 v_actor_id uuid;
 read_at timestamptz := statement_timestamp();
 result jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 caller := (claims->>'sub')::uuid;
 IF NOT swarm.is_member(p_workspace_id, caller) THEN RETURN NULL; END IF;
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
 v_actor_kind := CASE WHEN caller_agent IS NOT NULL THEN 'agent' ELSE 'user' END;
 v_actor_id := coalesce(caller_agent, caller);

 WITH agents AS MATERIALIZED (
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
   presence.watcher_at, presence.channel_at, presence.listener_at, presence.turn_at,
   greatest(presence.last_command_at,
    (SELECT max(s.created_at) FROM swarm.signals s
     JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
     WHERE s.workspace_id = a.workspace_id AND s.from_kind = 'agent' AND s.from_principal = a.principal_id
       AND EXISTS (
         SELECT 1 FROM swarm.conversation_target(s.workspace_id, v_actor_kind, v_actor_id, cs.conversation_id) AS ct
         WHERE ct.visible
       )
       AND swarm.conversation_signal_visible_to(
         cs.workspace_id, cs.signal_id, cs.audience,
         s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
         v_actor_kind, v_actor_id
       )),
    (SELECT max(greatest(b.created_at, b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b
     WHERE b.workspace_id = a.workspace_id AND b.principal_id = a.principal_id
       AND (cardinality(b.signal_ids) = 0 OR EXISTS (
        SELECT 1 FROM unnest(b.signal_ids) AS sid
        JOIN swarm.signals bs ON bs.workspace_id = b.workspace_id AND bs.id = sid
        JOIN swarm.conversation_signals bcs ON bcs.workspace_id = bs.workspace_id AND bcs.signal_id = bs.id
        WHERE EXISTS (
          SELECT 1 FROM swarm.conversation_target(b.workspace_id, v_actor_kind, v_actor_id, bcs.conversation_id) AS ct
          WHERE ct.visible
        )
        AND swarm.conversation_signal_visible_to(
          bcs.workspace_id, bcs.signal_id, bcs.audience,
          bs.from_kind, bs.from_principal, bs.to_user_id, bs.to_agent_principal_id,
          v_actor_kind, v_actor_id
        )))),
    (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = a.workspace_id AND e.event->>'actor_agent_principal' = a.principal_id::text),
    (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
     WHERE e.workspace_id = a.workspace_id AND e.event->>'actor_agent_principal' = a.principal_id::text)) AS last_activity_at,
   waiting_mail.since AS messages_waiting_since,
   coalesce(waiting_mail.unseen_count, 0) AS messages_waiting_count,
   working.created_at AS working_since, working.body AS working_body, working.public_work,
   waiting.open_count, waiting.oldest_at
  FROM page a
  LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = a.workspace_id AND presence.principal_id = a.principal_id
  LEFT JOIN LATERAL (
   SELECT min(d.enqueued_at) AS since, count(*)::integer AS unseen_count
   FROM swarm.signal_deliveries d
   JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
   JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
   WHERE d.workspace_id = a.workspace_id
     AND d.recipient_agent_principal_id = a.principal_id
     AND (d.acked_at IS NULL OR d.ack_outcome = 'queued')
     AND s.until > read_at
     AND EXISTS (
       SELECT 1 FROM swarm.conversation_target(s.workspace_id, v_actor_kind, v_actor_id, cs.conversation_id) AS ct
       WHERE ct.visible
     )
     AND swarm.conversation_signal_visible_to(
       cs.workspace_id, cs.signal_id, cs.audience,
       s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
       v_actor_kind, v_actor_id
     )
  ) waiting_mail ON true
  LEFT JOIN LATERAL (
   SELECT s.created_at, s.body,
    (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL
     AND (
      s.channel_id IS NULL
      OR EXISTS (
       SELECT 1 FROM swarm.channels ch
       WHERE ch.workspace_id = s.workspace_id
         AND ch.channel_id = s.channel_id
         AND ch.visibility = 'open'
      )
     )
     AND NOT EXISTS (
      SELECT 1 FROM swarm.conversation_signals cs
      JOIN swarm.conversations conv
        ON conv.conversation_id = cs.conversation_id AND conv.workspace_id = cs.workspace_id
      WHERE cs.workspace_id = s.workspace_id
        AND cs.signal_id = s.id
        AND conv.kind NOT IN ('general', 'public_channel')
     )
     AND s.in_reply_to IS NULL AND s.thread_root_id IS NULL AND s.chain_root_id IS NULL
     AND s.parent_signal_id IS NULL AND s.chain_participants IS NULL
     AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients r WHERE r.signal_id = s.id)) AS public_work
   FROM swarm.signals s
   JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
   WHERE s.workspace_id = a.workspace_id AND s.from_kind = 'agent' AND s.from_principal = a.principal_id
     AND s.kind = 'working-on' AND s.until > read_at
     AND EXISTS (
       SELECT 1 FROM swarm.conversation_target(s.workspace_id, v_actor_kind, v_actor_id, cs.conversation_id) AS ct
       WHERE ct.visible
     )
     AND swarm.conversation_signal_visible_to(
       cs.workspace_id, cs.signal_id, cs.audience,
       s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
       v_actor_kind, v_actor_id
     )
   ORDER BY s.created_at DESC, s.id DESC LIMIT 1
  ) working ON true
  LEFT JOIN LATERAL (
   SELECT count(*)::integer AS open_count, min(s.created_at) AS oldest_at
   FROM swarm.signals s
   JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
   WHERE s.workspace_id = a.workspace_id AND s.from_kind = 'agent' AND s.from_principal = a.principal_id
     AND s.kind = 'ask' AND s.until > read_at
     AND EXISTS (
       SELECT 1 FROM swarm.conversation_target(s.workspace_id, v_actor_kind, v_actor_id, cs.conversation_id) AS ct
       WHERE ct.visible
     )
     AND swarm.conversation_signal_visible_to(
       cs.workspace_id, cs.signal_id, cs.audience,
       s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
       v_actor_kind, v_actor_id
     )
     AND EXISTS (
      SELECT 1 FROM (
       SELECT s.to_user_id AS user_id WHERE s.to_user_id IS NOT NULL
       UNION SELECT r.recipient_user_id FROM swarm.signal_recipients r
        WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id IS NOT NULL
      ) addressed)
     AND NOT swarm.ask_answered(s.workspace_id, s.id)
  ) waiting ON true
 )
 SELECT jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'lead_agent_principal_id', (SELECT w.lead_agent_principal_id FROM swarm.workspaces w WHERE w.workspace_id = p_workspace_id),
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
     'text', CASE WHEN f.public_work THEN left(f.working_body, 200) ELSE NULL END) END,
   'messages_waiting', jsonb_build_object(
     'count', f.messages_waiting_count,
     'since', CASE WHEN f.messages_waiting_count > 0 THEN f.messages_waiting_since ELSE NULL END),
   'wake', jsonb_build_object(
     'watcher_at', f.watcher_at,
     'channel_at', f.channel_at,
     'listener_at', f.listener_at,
     'turn_at', f.turn_at),
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
GRANT EXECUTE ON FUNCTION swarm_read.workspace_roster(uuid) TO swarm_read;

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
        SELECT 1 FROM swarm.agent_principals p WHERE (p.workspace_id = reply.workspace_id
          OR EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships seat WHERE seat.principal_id = p.principal_id
           AND seat.owner_user_id = p.owner_user_id AND seat.workspace_id = reply.workspace_id))
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
    LEFT JOIN LATERAL (
     SELECT ap.owner_user_id, coalesce(ap.revoked_at, seat.revoked_at) AS revoked_at
     FROM swarm.agent_principals ap
     LEFT JOIN swarm.agent_workspace_memberships seat ON seat.principal_id = ap.principal_id
      AND seat.owner_user_id = ap.owner_user_id AND seat.workspace_id = t.workspace_id
     WHERE ap.principal_id = t.assignee_principal
      AND (ap.workspace_id = t.workspace_id OR seat.principal_id IS NOT NULL)
    ) p ON true
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
    presence.watcher_at, presence.channel_at, presence.listener_at, presence.turn_at,
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
    greatest(presence.last_command_at,
     (SELECT max(s.created_at) FROM swarm.signals s
      JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
      WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id
        AND EXISTS (
          SELECT 1 FROM swarm.conversation_target(s.workspace_id, 'user', viewer, cs.conversation_id) AS ct
          WHERE ct.visible
        )
        AND swarm.conversation_signal_visible_to(
          cs.workspace_id, cs.signal_id, cs.audience,
          s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
          'user', viewer
        )),
     (SELECT max(greatest(b.created_at,b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b
      WHERE b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id
        AND (cardinality(b.signal_ids) = 0 OR EXISTS (
         SELECT 1 FROM unnest(b.signal_ids) AS sid
         JOIN swarm.signals bs ON bs.workspace_id = b.workspace_id AND bs.id = sid
         JOIN swarm.conversation_signals bcs ON bcs.workspace_id = bs.workspace_id AND bcs.signal_id = bs.id
         WHERE EXISTS (
           SELECT 1 FROM swarm.conversation_target(b.workspace_id, 'user', viewer, bcs.conversation_id) AS ct
           WHERE ct.visible
         )
         AND swarm.conversation_signal_visible_to(
           bcs.workspace_id, bcs.signal_id, bcs.audience,
           bs.from_kind, bs.from_principal, bs.to_user_id, bs.to_agent_principal_id,
           'user', viewer
         )))),
     (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text),
     (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
      WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text)) AS last_activity_at,
    waiting_mail.since AS messages_waiting_since,
    coalesce(waiting_mail.unseen_count, 0) AS messages_waiting_count,
    doing.value AS doing, working.value AS working_on,
    CASE WHEN can_read THEN jsonb_build_object(
     'working',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'),
     'up_next',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND t.gate_clear),
     'not_yet',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND NOT t.gate_clear),
     'requests',(SELECT count(*) FROM todo_facts t WHERE t.offer_principal = p.principal_id AND t.offer_id IS NOT NULL AND t.state IN ('open','doing'))) ELSE NULL END AS queue
   FROM agents p
   LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = p.workspace_id AND presence.principal_id = p.principal_id
   LEFT JOIN LATERAL (
    SELECT min(d.enqueued_at) AS since, count(*)::integer AS unseen_count
    FROM swarm.signal_deliveries d
    JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
    JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
    WHERE d.workspace_id = p.workspace_id
      AND d.recipient_agent_principal_id = p.principal_id
      AND (d.acked_at IS NULL OR d.ack_outcome = 'queued')
      AND s.until > read_at
      AND EXISTS (
        SELECT 1 FROM swarm.conversation_target(s.workspace_id, 'user', viewer, cs.conversation_id) AS ct
        WHERE ct.visible
      )
      AND swarm.conversation_signal_visible_to(
        cs.workspace_id, cs.signal_id, cs.audience,
        s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
        'user', viewer
      )
   ) waiting_mail ON true
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('todo_id',t.todo_id,'title',CASE WHEN can_read THEN t.title ELSE NULL END,'since',t.state_at) value
    FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'
    ORDER BY t.state_at DESC, t.todo_id LIMIT 1
   ) doing ON true
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('signal_id',s.id,'at',s.created_at,'until',s.until) value
    FROM swarm.signals s
    JOIN swarm.conversation_signals cs ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
    WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id
      AND s.kind = 'working-on' AND s.until > read_at
      AND EXISTS (
        SELECT 1 FROM swarm.conversation_target(s.workspace_id, 'user', viewer, cs.conversation_id) AS ct
        WHERE ct.visible
      )
      AND swarm.conversation_signal_visible_to(
        cs.workspace_id, cs.signal_id, cs.audience,
        s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
        'user', viewer
      )
    ORDER BY s.created_at DESC, s.id LIMIT 1
   ) working ON true
   LEFT JOIN LATERAL swarm_read.local_connection_selection(p.workspace_id,p.principal_id,p.owner_user_id)
    selected ON p.transport='local'
   LEFT JOIN swarm.renewal_grants local_policy
    ON local_policy.renewal_grant_id=selected.selected_renewal_grant_id
   LEFT JOIN LATERAL swarm.hosted_connection_policy(p.workspace_id,p.principal_id,p.owner_user_id)
    hosted_policy ON p.transport='hosted_mcp'
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
     WHEN local_policy.revoked_at IS NULL AND local_policy.suspension_active
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
      'last_activity_at',a.last_activity_at,'messages_waiting_since',a.messages_waiting_since,
      'messages_waiting_count',a.messages_waiting_count,
      'wake',jsonb_build_object('watcher_at',a.watcher_at,'channel_at',a.channel_at,'listener_at',a.listener_at,'turn_at',a.turn_at),
      'doing',a.doing,'working_on',a.working_on) || a.connection_policy),
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
REVOKE ALL ON FUNCTION swarm_read.home_overview()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.home_overview() TO authenticated;
