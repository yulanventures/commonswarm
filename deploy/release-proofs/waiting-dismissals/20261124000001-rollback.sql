-- Rollback for 20261124000001 (waiting_dismissals):
-- Restores each of the five replaced read functions to its exact previous body
-- (20261120000002, 20261120000003, 20261120000006) and drops only what 20261124000001 added.
SET search_path = swarm, pg_catalog, public;

-- Restore swarm_read.waiting_todos_page from 20261120000002_waiting_dm_convergence.sql
CREATE OR REPLACE FUNCTION swarm_read.waiting_todos_page(
 p_workspace_id uuid,
 p_limit integer DEFAULT 50,
 p_after_state_at timestamptz DEFAULT NULL,
 p_after_todo_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 page_limit integer;
 total integer;
 has_more boolean;
 rows jsonb;
BEGIN
 -- A person's own session only. Reject agent claims and invalid sub UUIDs.
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;

 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN
  RETURN NULL;
 END IF;
 IF (p_after_state_at IS NULL) <> (p_after_todo_id IS NULL) THEN
  RAISE EXCEPTION 'waiting_todos_page cursor requires both p_after_state_at and p_after_todo_id' USING ERRCODE = '22023';
 END IF;

 -- Match home_overview's exact household read gate (live member, shared boundary, confirmed role).
 IF NOT swarm.household_human_can_read(p_workspace_id, viewer) THEN
  RETURN jsonb_build_object(
   'workspace_id', p_workspace_id,
   'generated_at', read_at,
   'total', 0,
   'truncated', false,
   'todos', '[]'::jsonb
  );
 END IF;

 page_limit := greatest(1, least(coalesce(p_limit, 50), 100));

 WITH candidate_todos AS MATERIALIZED (
  SELECT
   t.todo_id,
   t.title,
   t.state,
   t.due_on,
   t.state_at,
   t.origin_placement,
   t.origin_channel_id,
   t.origin_conversation_id,
   reason.kind AS reason,
   CASE
    WHEN reason.kind = 'request' THEN t.offer_principal
    WHEN reason.kind IN ('hold', 'agent_removed') THEN t.assignee_principal
    ELSE NULL
   END AS agent_id
  FROM swarm.household_todos t
  LEFT JOIN LATERAL (
   SELECT ap.owner_user_id, coalesce(ap.revoked_at, seat.revoked_at) AS revoked_at
   FROM swarm.agent_principals ap
   LEFT JOIN swarm.agent_workspace_memberships seat
    ON seat.principal_id = ap.principal_id
    AND seat.owner_user_id = ap.owner_user_id
    AND seat.workspace_id = t.workspace_id
   WHERE ap.principal_id = t.assignee_principal
    AND (ap.workspace_id = t.workspace_id OR seat.principal_id IS NOT NULL)
  ) p ON true
  CROSS JOIN LATERAL (
   SELECT CASE
    WHEN t.offer_id IS NOT NULL AND t.offer_decider = viewer THEN 'request'
    WHEN t.assignee_user = viewer THEN 'assigned'
    WHEN t.gate_kind = 'after' AND EXISTS (
     SELECT 1 FROM swarm.household_todos prerequisite
     WHERE prerequisite.workspace_id = t.workspace_id
      AND prerequisite.todo_id = t.gate_todo_id
      AND prerequisite.assignee_user = viewer
      AND prerequisite.state IN ('open', 'doing')
    ) THEN 'after'
    WHEN t.gate_kind = 'hold' AND p.owner_user_id = viewer AND p.revoked_at IS NULL THEN 'hold'
    WHEN p.owner_user_id = viewer AND p.revoked_at IS NOT NULL THEN 'agent_removed'
   END AS kind
  ) reason
  WHERE t.workspace_id = p_workspace_id
   AND t.state IN ('open', 'doing')
   AND reason.kind IS NOT NULL
 ), anchor AS (
  SELECT coalesce(
   (SELECT c.state_at FROM candidate_todos c WHERE c.todo_id = p_after_todo_id),
   p_after_state_at
  ) AS state_at
 ), page_probe AS MATERIALIZED (
  SELECT c.*
  FROM candidate_todos c, anchor a
  WHERE p_after_todo_id IS NULL
   OR c.state_at < a.state_at
   OR (c.state_at = a.state_at AND c.todo_id > p_after_todo_id)
  ORDER BY c.state_at DESC, c.todo_id ASC
  LIMIT page_limit + 1
 ), page AS (
  SELECT * FROM page_probe
  ORDER BY state_at DESC, todo_id ASC
  LIMIT page_limit
 )
 SELECT
  (SELECT count(*) FROM candidate_todos)::integer,
  (SELECT count(*) > page_limit FROM page_probe),
  coalesce(jsonb_agg(jsonb_build_object(
   'todo_id', p.todo_id,
   'title', p.title,
   'state', p.state,
   'due_on', p.due_on,
   'reason', p.reason,
   'agent_id', p.agent_id,
   'state_at', p.state_at,
   'placement', vis.placement,
   'channel_id', vis.channel_id,
   'conversation_id', vis.conversation_id
  ) ORDER BY p.state_at DESC, p.todo_id ASC), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p
 CROSS JOIN LATERAL (
  SELECT
   (p.origin_placement = 'channel'
    AND p.origin_channel_id IS NOT NULL
    AND swarm.claims_can_access_channel(p_workspace_id, p.origin_channel_id)) AS can_channel,
   (p.origin_placement IN ('dm', 'group_dm')
    AND p.origin_conversation_id IS NOT NULL
    AND swarm.actor_can_access_direct_conversation(p_workspace_id, p.origin_conversation_id, p.origin_placement, 'user', viewer)) AS can_direct
 ) access
 CROSS JOIN LATERAL (
  SELECT
   CASE
    WHEN access.can_channel THEN 'channel'
    WHEN access.can_direct THEN p.origin_placement
    WHEN p.origin_placement = 'general' THEN 'general'
    ELSE 'workspace'
   END AS placement,
   CASE WHEN access.can_channel THEN p.origin_channel_id ELSE NULL END AS channel_id,
   CASE WHEN access.can_direct THEN p.origin_conversation_id ELSE NULL END AS conversation_id
 ) vis;

 RETURN jsonb_build_object(
  'workspace_id', p_workspace_id,
  'generated_at', read_at,
  'total', coalesce(total, 0),
  'truncated', coalesce(has_more, false),
  'todos', coalesce(rows, '[]'::jsonb)
 );
END;
$$;

ALTER FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) TO authenticated;

-- Restore swarm_read.decision_queue from 20261120000002_waiting_dm_convergence.sql
CREATE OR REPLACE FUNCTION swarm_read.decision_queue(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 total integer;
 rows jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN RETURN NULL; END IF;
 WITH open_asks AS MATERIALIZED (
  -- swarm_read.signals applies the viewer's legacy visibility gate; mapped direct conversations
  -- additionally require live canonical membership and audience visibility before counting or paging.
  SELECT s.id, s."from", s.from_kind, s.body, s.created_at, s.until,
   c.conversation_id, c.kind AS conversation_kind
  FROM swarm_read.signals s
  LEFT JOIN swarm.conversation_signals cs
   ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations c
   ON c.workspace_id = s.workspace_id AND c.conversation_id = cs.conversation_id
  WHERE s.workspace_id = p_workspace_id AND s.kind = 'ask' AND s.until > read_at
   AND (s."to" = viewer OR EXISTS (
    SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer))
   AND NOT swarm.ask_answered(s.workspace_id, s.id)
   AND (
    c.conversation_id IS NULL
    OR c.kind IN ('general', 'public_channel')
    OR (c.kind = 'private_channel' AND swarm.claims_can_access_channel(p_workspace_id, c.channel_id))
    OR (
     c.kind IN ('dm', 'group_dm')
     AND EXISTS (
      SELECT 1 FROM swarm.conversation_members cm
      WHERE cm.workspace_id = c.workspace_id
       AND cm.conversation_id = c.conversation_id
       AND cm.member_user_id = viewer
       AND cm.left_at IS NULL
     )
     AND swarm.conversation_signal_visible_to(
      cs.workspace_id, cs.signal_id, cs.audience,
      s.from_kind, s."from", s."to", s.to_agent,
      'user', viewer
     )
    )
   )
 ), page AS (
  SELECT * FROM open_asks ORDER BY created_at, id LIMIT 100
 )
 SELECT (SELECT count(*) FROM open_asks)::integer,
  coalesce(jsonb_agg(jsonb_build_object(
   'signal_id', p.id,
   'from', jsonb_build_object('kind', p.from_kind, 'id', p."from",
     'name', CASE p.from_kind
      WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = p."from")
      ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = p."from") END),
   -- Untrusted text; clients render it as text, never HTML.
   'body', left(p.body, 4000),
   'created_at', p.created_at,
   'until', p.until,
   'conversation_id', p.conversation_id,
   'conversation_kind', p.conversation_kind,
   'reraised', CASE WHEN x.signal_id IS NULL THEN NULL
     ELSE jsonb_build_object('count', x.raise_count, 'last_at', x.last_raised_at) END
  ) ORDER BY p.created_at, p.id), '[]'::jsonb)
 INTO total, rows
 FROM page p
 LEFT JOIN swarm.ask_reraises x ON x.workspace_id = p_workspace_id AND x.signal_id = p.id;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'total', total, 'truncated', total > 100, 'asks', rows);
END;
$$;
ALTER FUNCTION swarm_read.decision_queue(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.decision_queue(uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.decision_queue(uuid) TO authenticated;

-- Restore swarm_read.decision_queue_page from 20261120000002_waiting_dm_convergence.sql
CREATE OR REPLACE FUNCTION swarm_read.decision_queue_page(
 p_workspace_id uuid,
 p_after_created_at timestamptz DEFAULT NULL,
 p_after_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 anchor_created_at timestamptz;
 total integer;
 has_more boolean;
 rows jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN RETURN NULL; END IF;
 IF (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
  RAISE EXCEPTION 'decision_queue_cursor_invalid' USING ERRCODE = '22023';
 END IF;
 WITH open_asks AS MATERIALIZED (
  SELECT s.id, s."from", s.from_kind, s.body, s.created_at, s.until,
   c.conversation_id, c.kind AS conversation_kind
  FROM swarm_read.signals s
  LEFT JOIN swarm.conversation_signals cs
   ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations c
   ON c.workspace_id = s.workspace_id AND c.conversation_id = cs.conversation_id
  WHERE s.workspace_id = p_workspace_id AND s.kind = 'ask' AND s.until > read_at
   AND (s."to" = viewer OR EXISTS (
    SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer))
   AND NOT swarm.ask_answered(s.workspace_id, s.id)
   AND (
    c.conversation_id IS NULL
    OR c.kind IN ('general', 'public_channel')
    OR (c.kind = 'private_channel' AND swarm.claims_can_access_channel(p_workspace_id, c.channel_id))
    OR (
     c.kind IN ('dm', 'group_dm')
     AND EXISTS (
      SELECT 1 FROM swarm.conversation_members cm
      WHERE cm.workspace_id = c.workspace_id
       AND cm.conversation_id = c.conversation_id
       AND cm.member_user_id = viewer
       AND cm.left_at IS NULL
     )
     AND swarm.conversation_signal_visible_to(
      cs.workspace_id, cs.signal_id, cs.audience,
      s.from_kind, s."from", s."to", s.to_agent,
      'user', viewer
     )
    )
   )
 ), anchor AS (
  SELECT coalesce(
   (SELECT oa.created_at FROM open_asks oa WHERE oa.id = p_after_id),
   p_after_created_at
  ) AS created_at
 ), page_probe AS MATERIALIZED (
  SELECT oa.*
  FROM open_asks oa, anchor a
  WHERE p_after_id IS NULL
   OR (oa.created_at, oa.id) > (a.created_at, p_after_id)
  ORDER BY oa.created_at, oa.id
  LIMIT 101
 ), page AS (
  SELECT * FROM page_probe ORDER BY created_at, id LIMIT 100
 )
 SELECT (SELECT count(*) FROM open_asks)::integer,
  (SELECT count(*) > 100 FROM page_probe),
  coalesce(jsonb_agg(jsonb_build_object(
   'signal_id', p.id,
   'from', jsonb_build_object('kind', p.from_kind, 'id', p."from",
     'name', CASE p.from_kind
      WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = p."from")
      ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = p."from") END),
   -- Untrusted text; clients render it as text, never HTML.
   'body', left(p.body, 4000),
   'created_at', p.created_at,
   'until', p.until,
   'conversation_id', p.conversation_id,
   'conversation_kind', p.conversation_kind,
   'reraised', CASE WHEN x.signal_id IS NULL THEN NULL
     ELSE jsonb_build_object('count', x.raise_count, 'last_at', x.last_raised_at) END
  ) ORDER BY p.created_at, p.id), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p
 LEFT JOIN swarm.ask_reraises x ON x.workspace_id = p_workspace_id AND x.signal_id = p.id;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'total', total, 'truncated', has_more, 'asks', rows);
END;
$$;

ALTER FUNCTION swarm_read.decision_queue_page(uuid, timestamptz, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.decision_queue_page(uuid, timestamptz, uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.decision_queue_page(uuid, timestamptz, uuid) TO authenticated;

-- Restore swarm_read.home_overview from 20261120000006_live_seat_status.sql
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

-- Restore swarm_read.waiting_archived_page from 20261120000003_waiting_archived_and_permanence.sql
CREATE OR REPLACE FUNCTION swarm_read.waiting_archived_page(
 p_workspace_id uuid,
 p_limit integer DEFAULT 30,
 p_after_archived_at timestamptz DEFAULT NULL,
 p_after_item_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
 claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := pg_catalog.statement_timestamp();
 can_read_todos boolean;
 page_limit integer;
 after_key text;
 total integer;
 has_more boolean;
 rows jsonb;
BEGIN
 -- A person's own session only. Reject agent claims and invalid sub UUIDs.
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;

 IF p_workspace_id IS NULL OR NOT swarm.actor_can_access_channel(p_workspace_id, NULL, 'user', viewer) THEN
  RETURN NULL;
 END IF;

 IF (p_after_archived_at IS NULL) <> (p_after_item_key IS NULL) THEN
  RAISE EXCEPTION 'waiting_archived_page cursor requires both p_after_archived_at and p_after_item_key'
   USING ERRCODE = '22023';
 END IF;
 IF p_after_item_key IS NOT NULL
  AND p_after_item_key !~* '^(ask|todo|review):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'waiting_archived_page cursor item_key invalid' USING ERRCODE = '22023';
 END IF;
 after_key := pg_catalog.lower(p_after_item_key);

 can_read_todos := swarm.household_human_can_read(p_workspace_id, viewer);
 page_limit := greatest(1, least(coalesce(p_limit, 30), 100));

 WITH archived_asks AS (
  SELECT
   'ask:' || s.id::text AS item_key,
   'ask'::text AS kind,
   s.id AS id,
   NULL::uuid AS todo_id,
   CASE WHEN ac.signal_id IS NOT NULL THEN 'choice' ELSE 'plain' END AS ask_kind,
   pg_catalog.left(s.body, 4000) AS title,
   s.from_kind AS from_kind,
   s.from_principal AS from_id,
   CASE
    WHEN act.action_id IS NOT NULL THEN 'answered'
    WHEN rep.body = 'Closed as stale. Re-ask with choices if still needed.' THEN 'cleared_stale'
    ELSE 'answered'
   END AS outcome_kind,
   CASE
    WHEN act.action_id IS NOT NULL THEN pg_catalog.left(coalesce(nullif(choice_fmt.label_text, ''), nullif(act.reply_body, ''), 'Answered'), 500)
    WHEN rep.body = 'Closed as stale. Re-ask with choices if still needed.' THEN 'Cleared as stale'
    ELSE pg_catalog.left(rep.body, 500)
   END AS outcome_text,
   coalesce(act.completed_at, rep.created_at) AS archived_at,
   CASE WHEN act.action_id IS NOT NULL THEN 'user' ELSE rep.from_kind END AS answered_by_kind,
   CASE WHEN act.action_id IS NOT NULL THEN act.actor_user_id ELSE rep.from_principal END AS answered_by_id,
   place.placement AS placement,
   place.channel_id AS channel_id,
   place.conversation_id AS conversation_id,
   place.conversation_kind AS conversation_kind
  FROM swarm.signals s
  LEFT JOIN swarm.ask_choices ac
   ON ac.workspace_id = p_workspace_id AND ac.signal_id = s.id
  LEFT JOIN swarm.conversation_signals cs
   ON cs.workspace_id = p_workspace_id AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations raw_c
   ON raw_c.workspace_id = p_workspace_id AND raw_c.conversation_id = cs.conversation_id
  LEFT JOIN swarm.conversation_members viewer_cm
   ON raw_c.kind IN ('dm', 'group_dm')
   AND viewer_cm.workspace_id = raw_c.workspace_id
   AND viewer_cm.conversation_id = raw_c.conversation_id
   AND viewer_cm.member_user_id = viewer
  LEFT JOIN LATERAL (
   SELECT
    a.action_id,
    a.actor_user_id,
    a.option_id,
    a.option_ids,
    a.other_text,
    a.reply_signal_id,
    a.completed_at,
    act_sig.body AS reply_body
   FROM swarm.ui_actions a
   LEFT JOIN swarm.signals act_sig
    ON act_sig.workspace_id = p_workspace_id AND act_sig.id = a.reply_signal_id
   LEFT JOIN swarm.conversation_signals act_cs
    ON act_cs.workspace_id = p_workspace_id AND act_cs.signal_id = act_sig.id
   LEFT JOIN swarm.conversations act_c
    ON act_c.workspace_id = p_workspace_id AND act_c.conversation_id = act_cs.conversation_id
   LEFT JOIN swarm.conversation_members act_cm
    ON act_c.kind IN ('dm', 'group_dm')
    AND act_cm.workspace_id = act_c.workspace_id
    AND act_cm.conversation_id = act_c.conversation_id
    AND act_cm.member_user_id = viewer
   WHERE a.workspace_id = p_workspace_id
    AND a.signal_id = s.id
    AND a.state = 'completed'
    AND (
     (a.reply_signal_id IS NULL AND a.actor_user_id = viewer)
     OR (
      a.reply_signal_id IS NOT NULL
      AND act_sig.id IS NOT NULL
      AND (
       (
        act_c.conversation_id IS NOT NULL
        AND (
         act_c.kind IN ('general', 'public_channel')
         OR (
          act_c.kind = 'private_channel'
          AND swarm.actor_can_access_channel(p_workspace_id, act_c.channel_id, 'user', viewer)
         )
         OR (
          act_c.kind IN ('dm', 'group_dm')
          AND act_cm.member_user_id IS NOT NULL
          AND act_cm.left_at IS NULL
         )
        )
        AND swarm.conversation_signal_visible_to(
         act_cs.workspace_id, act_cs.signal_id, act_cs.audience,
         act_sig.from_kind, act_sig.from_principal, act_sig.to_user_id, act_sig.to_agent_principal_id,
         'user', viewer
        )
       )
       OR (
        act_c.conversation_id IS NULL
        AND (
         act_sig.channel_id IS NULL
         OR swarm.actor_can_access_channel(p_workspace_id, act_sig.channel_id, 'user', viewer)
        )
        AND (
         (act_sig.from_kind = 'user' AND act_sig.from_principal = viewer)
         OR act_sig.to_user_id = viewer
         OR EXISTS (
          SELECT 1 FROM swarm.signal_recipients ar
          WHERE ar.workspace_id = act_sig.workspace_id
           AND ar.signal_id = act_sig.id
           AND ar.recipient_user_id = viewer
         )
         OR (
          act_sig.to_user_id IS NULL
          AND act_sig.to_agent_principal_id IS NULL
          AND NOT EXISTS (
           SELECT 1 FROM swarm.signal_recipients ar
           WHERE ar.workspace_id = act_sig.workspace_id
            AND ar.signal_id = act_sig.id
          )
         )
        )
       )
      )
     )
    )
   ORDER BY a.completed_at ASC, a.action_id ASC
   LIMIT 1
  ) act ON true
  LEFT JOIN LATERAL (
   SELECT reply.id, reply.from_kind, reply.from_principal, reply.body, reply.created_at
   FROM swarm.signals reply
   LEFT JOIN swarm.conversation_signals rep_cs
    ON rep_cs.workspace_id = p_workspace_id AND rep_cs.signal_id = reply.id
   LEFT JOIN swarm.conversations rep_c
    ON rep_c.workspace_id = p_workspace_id AND rep_c.conversation_id = rep_cs.conversation_id
   LEFT JOIN swarm.conversation_members rep_cm
    ON rep_c.kind IN ('dm', 'group_dm')
    AND rep_cm.workspace_id = rep_c.workspace_id
    AND rep_cm.conversation_id = rep_c.conversation_id
    AND rep_cm.member_user_id = viewer
   WHERE reply.workspace_id = s.workspace_id
    AND reply.in_reply_to = s.id
    AND NOT (reply.from_kind = s.from_kind AND reply.from_principal = s.from_principal)
    AND (
     (reply.from_kind = 'user' AND (
      reply.from_principal = s.to_user_id
      OR EXISTS (
       SELECT 1 FROM swarm.signal_recipients ar
       WHERE ar.workspace_id = s.workspace_id AND ar.signal_id = s.id AND ar.recipient_user_id = reply.from_principal
      )
     ))
     OR (reply.from_kind = 'agent' AND EXISTS (
      SELECT 1
      FROM swarm.agent_principals rp
      JOIN swarm.agent_workspace_memberships ram USING (principal_id, owner_user_id)
      WHERE rp.principal_id = reply.from_principal
       AND ram.workspace_id = s.workspace_id
       AND (
        rp.owner_user_id = s.to_user_id
        OR EXISTS (
         SELECT 1 FROM swarm.signal_recipients ar
         WHERE ar.workspace_id = s.workspace_id AND ar.signal_id = s.id AND ar.recipient_user_id = rp.owner_user_id
        )
       )
     ))
    )
    -- Independent canonical conversation and message access check on the answer itself
    -- (never falls back to legacy swarm_read.signals or ended agent oversight).
    AND (
     (
      rep_c.conversation_id IS NOT NULL
      AND (
       rep_c.kind IN ('general', 'public_channel')
       OR (
        rep_c.kind = 'private_channel'
        AND swarm.actor_can_access_channel(p_workspace_id, rep_c.channel_id, 'user', viewer)
       )
       OR (
        rep_c.kind IN ('dm', 'group_dm')
        AND rep_cm.member_user_id IS NOT NULL
        AND rep_cm.left_at IS NULL
       )
      )
      AND swarm.conversation_signal_visible_to(
       rep_cs.workspace_id, rep_cs.signal_id, rep_cs.audience,
       reply.from_kind, reply.from_principal, reply.to_user_id, reply.to_agent_principal_id,
       'user', viewer
      )
     )
     OR (
      rep_c.conversation_id IS NULL
      AND (
       reply.channel_id IS NULL
       OR swarm.actor_can_access_channel(p_workspace_id, reply.channel_id, 'user', viewer)
      )
      AND (
       (reply.from_kind = 'user' AND reply.from_principal = viewer)
       OR reply.to_user_id = viewer
       OR EXISTS (
        SELECT 1 FROM swarm.signal_recipients rr
        WHERE rr.workspace_id = reply.workspace_id
         AND rr.signal_id = reply.id
         AND rr.recipient_user_id = viewer
       )
       OR (
        reply.to_user_id IS NULL
        AND reply.to_agent_principal_id IS NULL
        AND NOT EXISTS (
         SELECT 1 FROM swarm.signal_recipients rr
         WHERE rr.workspace_id = reply.workspace_id
          AND rr.signal_id = reply.id
        )
       )
      )
     )
    )
   ORDER BY reply.created_at ASC, reply.id ASC
   LIMIT 1
  ) rep ON true
  LEFT JOIN LATERAL (
   SELECT
    CASE
     WHEN act.action_id IS NULL THEN NULL
     ELSE pg_catalog.concat_ws(
      ' · ',
      nullif((
       SELECT pg_catalog.string_agg(opt->>'label', ', ' ORDER BY sel.ord)
       FROM pg_catalog.unnest(coalesce(act.option_ids, ARRAY[act.option_id])) WITH ORDINALITY AS sel(oid, ord)
       JOIN LATERAL (
        SELECT elem
        FROM pg_catalog.jsonb_array_elements(coalesce(ac.options, '[]'::jsonb)) AS elem
        WHERE elem->>'id' = sel.oid
        LIMIT 1
       ) matched ON sel.oid <> 'other'
       CROSS JOIN LATERAL (SELECT matched.elem AS opt) o
      ), ''),
      nullif(act.other_text, '')
     )
    END AS label_text
  ) choice_fmt ON true
  CROSS JOIN LATERAL (
   SELECT
    CASE
     WHEN raw_c.conversation_id IS NOT NULL AND raw_c.kind IN ('public_channel', 'private_channel') THEN 'channel'
     WHEN raw_c.conversation_id IS NOT NULL THEN raw_c.kind
     WHEN s.channel_id IS NOT NULL AND swarm.actor_can_access_channel(p_workspace_id, s.channel_id, 'user', viewer) THEN 'channel'
     ELSE 'redacted'
    END AS placement,
    CASE
     WHEN raw_c.conversation_id IS NOT NULL AND raw_c.kind IN ('public_channel', 'private_channel') THEN raw_c.channel_id
     WHEN raw_c.conversation_id IS NULL AND s.channel_id IS NOT NULL AND swarm.actor_can_access_channel(p_workspace_id, s.channel_id, 'user', viewer) THEN s.channel_id
     ELSE NULL
    END AS channel_id,
    CASE WHEN raw_c.conversation_id IS NOT NULL THEN raw_c.conversation_id ELSE NULL END AS conversation_id,
    CASE WHEN raw_c.conversation_id IS NOT NULL THEN raw_c.kind ELSE NULL END AS conversation_kind
  ) place
  WHERE s.workspace_id = p_workspace_id
   AND s.kind = 'ask'
   AND (
    s.to_user_id = viewer
    OR EXISTS (
     SELECT 1 FROM swarm.signal_recipients r
     WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer
    )
   )
   -- Whole-row canonical membership and audience gate on the ask matching decision_queue_page:
   -- a departed DM/group_dm member or unauthorized private-channel reader gets nothing (zero body/count/cursor).
   AND (
    (
     raw_c.conversation_id IS NOT NULL
     AND (
      raw_c.kind IN ('general', 'public_channel')
      OR (
       raw_c.kind = 'private_channel'
       AND swarm.actor_can_access_channel(p_workspace_id, raw_c.channel_id, 'user', viewer)
      )
      OR (
       raw_c.kind IN ('dm', 'group_dm')
       AND viewer_cm.member_user_id IS NOT NULL
       AND viewer_cm.left_at IS NULL
      )
     )
     AND swarm.conversation_signal_visible_to(
      cs.workspace_id, cs.signal_id, cs.audience,
      s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
      'user', viewer
     )
    )
    OR (
     raw_c.conversation_id IS NULL
     AND (
      s.channel_id IS NULL
      OR swarm.actor_can_access_channel(p_workspace_id, s.channel_id, 'user', viewer)
     )
    )
   )
   AND (act.action_id IS NOT NULL OR rep.id IS NOT NULL)
 ),
 archived_todos AS (
  SELECT
   'todo:' || t.todo_id::text AS item_key,
   'todo'::text AS kind,
   t.todo_id AS id,
   t.todo_id AS todo_id,
   NULL::text AS ask_kind,
   t.title AS title,
   CASE WHEN t.created_by_principal IS NOT NULL THEN 'agent' ELSE 'user' END AS from_kind,
   coalesce(t.created_by_principal, t.created_by_user) AS from_id,
   t.state AS outcome_kind,
   CASE t.state WHEN 'done' THEN 'Done' ELSE 'Dropped' END AS outcome_text,
   t.state_at AS archived_at,
   CASE WHEN t.state_by_principal IS NOT NULL THEN 'agent' ELSE 'user' END AS answered_by_kind,
   coalesce(t.state_by_principal, t.state_by_user) AS answered_by_id,
   vis.placement AS placement,
   vis.channel_id AS channel_id,
   vis.conversation_id AS conversation_id,
   vis.conversation_kind AS conversation_kind
  FROM swarm.household_todos t
  LEFT JOIN swarm.agent_workspace_memberships seat
   ON seat.principal_id = t.assignee_principal
   AND seat.workspace_id = t.workspace_id
   AND seat.owner_user_id = viewer
  CROSS JOIN LATERAL (
   SELECT
    (t.origin_placement = 'channel'
     AND t.origin_channel_id IS NOT NULL
     AND swarm.claims_can_access_channel(p_workspace_id, t.origin_channel_id)) AS can_channel,
    (t.origin_placement IN ('dm', 'group_dm')
     AND t.origin_conversation_id IS NOT NULL
     AND swarm.actor_can_access_direct_conversation(p_workspace_id, t.origin_conversation_id, t.origin_placement, 'user', viewer)) AS can_direct
  ) access
  CROSS JOIN LATERAL (
   SELECT
    CASE
     WHEN access.can_channel THEN 'channel'
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE 'workspace'
    END AS placement,
    CASE WHEN access.can_channel THEN t.origin_channel_id ELSE NULL END AS channel_id,
    CASE WHEN access.can_direct THEN t.origin_conversation_id ELSE NULL END AS conversation_id,
    CASE
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE NULL
    END AS conversation_kind
  ) vis
  WHERE can_read_todos
   AND t.workspace_id = p_workspace_id
   AND t.state IN ('done', 'dropped')
   AND (
    t.assignee_user = viewer
    OR (seat.principal_id IS NOT NULL AND t.state_by_user = viewer)
   )
 ),
 archived_reviews AS (
  SELECT
   'review:' || (ans.event->'payload'->>'offer_id') AS item_key,
   'review'::text AS kind,
   (ans.event->'payload'->>'offer_id')::uuid AS id,
   t.todo_id AS todo_id,
   NULL::text AS ask_kind,
   coalesce(t.title, pg_catalog.left(coalesce(ans.event->'payload'->'todo'->>'title', 'To-do request'), 240)) AS title,
   CASE
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'principal_id', '') IS NOT NULL THEN 'agent'
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'user_id', '') IS NOT NULL THEN 'user'
    ELSE NULL
   END AS from_kind,
   CASE
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'principal_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (off.event->'payload'->'todo'->'offer'->'by'->>'principal_id')::uuid
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (off.event->'payload'->'todo'->'offer'->'by'->>'user_id')::uuid
    ELSE NULL
   END AS from_id,
   CASE ans.event->'payload'->>'answer' WHEN 'accept' THEN 'accepted' ELSE 'declined' END AS outcome_kind,
   CASE ans.event->'payload'->>'answer' WHEN 'accept' THEN 'Accepted' ELSE 'Declined' END AS outcome_text,
   ans.occurred_at AS archived_at,
   CASE WHEN nullif(ans.event->>'actor_agent_principal', '') IS NOT NULL THEN 'agent' ELSE 'user' END AS answered_by_kind,
   CASE
    WHEN nullif(ans.event->>'actor_agent_principal', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (ans.event->>'actor_agent_principal')::uuid
    WHEN nullif(ans.event->>'actor_user', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (ans.event->>'actor_user')::uuid
    ELSE viewer
   END AS answered_by_id,
   vis.placement AS placement,
   vis.channel_id AS channel_id,
   vis.conversation_id AS conversation_id,
   vis.conversation_kind AS conversation_kind
  FROM swarm.household_todo_events ans
  JOIN LATERAL (
   SELECT e.event
   FROM swarm.household_todo_events e
   WHERE e.workspace_id = ans.workspace_id
    AND e.event->>'type' = 'TodoOffered'
    AND e.event->'payload'->'todo'->'offer'->>'offer_id' = ans.event->'payload'->>'offer_id'
    AND e.event->'payload'->'todo'->'offer'->>'decider_user_id' = viewer::text
   ORDER BY e.seq DESC
   LIMIT 1
  ) off ON true
  LEFT JOIN swarm.household_todos t
   ON t.workspace_id = ans.workspace_id
   AND coalesce(ans.event->'payload'->'todo'->>'todo_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND t.todo_id = (ans.event->'payload'->'todo'->>'todo_id')::uuid
  CROSS JOIN LATERAL (
   SELECT
    (t.origin_placement = 'channel'
     AND t.origin_channel_id IS NOT NULL
     AND swarm.claims_can_access_channel(p_workspace_id, t.origin_channel_id)) AS can_channel,
    (t.origin_placement IN ('dm', 'group_dm')
     AND t.origin_conversation_id IS NOT NULL
     AND swarm.actor_can_access_direct_conversation(p_workspace_id, t.origin_conversation_id, t.origin_placement, 'user', viewer)) AS can_direct
  ) access
  CROSS JOIN LATERAL (
   SELECT
    CASE
     WHEN access.can_channel THEN 'channel'
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE 'workspace'
    END AS placement,
    CASE WHEN access.can_channel THEN t.origin_channel_id ELSE NULL END AS channel_id,
    CASE WHEN access.can_direct THEN t.origin_conversation_id ELSE NULL END AS conversation_id,
    CASE
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE NULL
    END AS conversation_kind
  ) vis
  WHERE can_read_todos
   AND ans.workspace_id = p_workspace_id
   AND ans.event->>'type' = 'TodoOfferAnswered'
   AND ans.event->'payload'->>'answer' IN ('accept', 'decline')
   AND coalesce(ans.event->'payload'->>'offer_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 ),
 candidate_items AS MATERIALIZED (
  SELECT * FROM archived_asks
  UNION ALL
  SELECT * FROM archived_todos
  UNION ALL
  SELECT * FROM archived_reviews
 ),
 anchor AS (
  SELECT coalesce(
   (SELECT c.archived_at FROM candidate_items c WHERE c.item_key = after_key),
   p_after_archived_at
  ) AS archived_at
 ),
 page_probe AS MATERIALIZED (
  SELECT c.*
  FROM candidate_items c, anchor a
  WHERE after_key IS NULL
   OR c.archived_at < a.archived_at
   OR (c.archived_at = a.archived_at AND c.item_key > after_key)
  ORDER BY c.archived_at DESC, c.item_key ASC
  LIMIT page_limit + 1
 ),
 page AS (
  SELECT * FROM page_probe
  ORDER BY archived_at DESC, item_key ASC
  LIMIT page_limit
 )
 SELECT
  (SELECT pg_catalog.count(*) FROM candidate_items)::integer,
  (SELECT pg_catalog.count(*) > page_limit FROM page_probe),
  coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'item_key', p.item_key,
   'kind', p.kind,
   'id', p.id,
   'todo_id', p.todo_id,
   'ask_kind', p.ask_kind,
   'title', p.title,
   'from', CASE WHEN p.from_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
    'kind', p.from_kind,
    'id', p.from_id,
    'name', CASE p.from_kind
     WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = p.from_id)
     ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = p.from_id)
    END
   ) END,
   'outcome_kind', p.outcome_kind,
   'outcome_text', p.outcome_text,
   'archived_at', p.archived_at,
   'answered_by', CASE WHEN p.answered_by_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
    'kind', p.answered_by_kind,
    'id', p.answered_by_id,
    'name', CASE p.answered_by_kind
     WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = p.answered_by_id)
     ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = p.answered_by_id)
    END,
    'by_viewer', (p.answered_by_kind = 'user' AND p.answered_by_id = viewer)
   ) END,
   'placement', p.placement,
   'channel_id', p.channel_id,
   'conversation_id', p.conversation_id,
   'conversation_kind', p.conversation_kind
  ) ORDER BY p.archived_at DESC, p.item_key ASC), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p;

 RETURN pg_catalog.jsonb_build_object(
  'workspace_id', p_workspace_id,
  'generated_at', read_at,
  'untrusted_content', true,
  'total', coalesce(total, 0),
  'truncated', coalesce(has_more, false),
  'items', coalesce(rows, '[]'::jsonb)
 );
END;
$$;

ALTER FUNCTION swarm_read.waiting_archived_page(uuid, integer, timestamptz, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.waiting_archived_page(uuid, integer, timestamptz, text)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.waiting_archived_page(uuid, integer, timestamptz, text) TO authenticated;

-- Restore swarm_read.audit_log to its exact 20261113000003_private_channels.sql definition.
CREATE OR REPLACE VIEW swarm_read.audit_log
WITH (security_barrier = true)
AS
  SELECT
    a.audit_id,
    a.occurred_at,
    a.actor_user,
    a.actor_agent_principal,
    a.actor_run,
    a.credential_kind,
    a.credential_id,
    a.device_id,
    a.command_kind,
    a.workspace_id,
    a.stream_id,
    a.outcome,
    a.reason,
    a.detail,
    a.request_hash,
    a.ip
  FROM swarm.audit_log AS a
  WHERE swarm.is_member(a.workspace_id, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM swarm.memberships AS m
      WHERE m.workspace_id = a.workspace_id
        AND m.user_id = auth.uid()
        AND m.revoked_at IS NULL
        AND m.role IN ('owner', 'admin')
    )
    AND (
      COALESCE(cardinality(a.channel_ids), 0) = 0
      OR NOT EXISTS (
        SELECT 1
        FROM unnest(a.channel_ids) AS cid
        WHERE cid IS NULL
           OR NOT swarm.claims_can_access_channel(a.workspace_id, cid)
      )
    )
    AND (
      a.command_kind NOT IN (
        'private_channel_manager_promoted',
        'private_channel_auto_archived'
      )
      OR (
        a.stream_id IS NOT NULL
        AND swarm.claims_can_access_channel(a.workspace_id, a.stream_id)
      )
    );

ALTER VIEW swarm_read.audit_log OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.audit_log TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.audit_log FROM PUBLIC, anon;

-- Drop only the objects added by 20261124000001
DROP FUNCTION IF EXISTS swarm.dismiss_waiting_item(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.restore_waiting_item(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.waiting_dismissal_replay_allowed(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.waiting_item_eligible(uuid, uuid, text, uuid, timestamptz);
DROP FUNCTION IF EXISTS swarm.waiting_review_eligible(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.waiting_todo_eligible(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.waiting_todo_reason(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.waiting_ask_eligible(uuid, uuid, uuid, timestamptz);
DROP TABLE IF EXISTS swarm.waiting_dismissals;
DROP FUNCTION IF EXISTS swarm.waiting_dismissal_validate_refs();

RESET search_path;
