-- Waiting on you Step 2b DM & group DM convergence:
-- 1. Exposes authoritative conversation_id and conversation_kind from swarm.conversation_signals /
--    swarm.conversations on swarm_read.decision_queue and swarm_read.decision_queue_page so asks
--    outside loaded history (including restarted group DM generations) resolve to their exact
--    conversation without guessing by member set.
-- 2. Extends immutable to-do creation provenance on swarm.household_todos with origin_conversation_id
--    for 'dm' and 'group_dm' origins, gated by active conversation membership on create and redacted
--    to ('workspace', NULL, NULL) in swarm_read.waiting_todos_page when the viewer is not an active
--    member of the originating direct conversation.

ALTER TABLE swarm.household_todos
 ADD COLUMN IF NOT EXISTS origin_conversation_id uuid;

DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'household_todos_origin_placement_check'
    AND conrelid = 'swarm.household_todos'::regclass
 ) THEN
  ALTER TABLE swarm.household_todos
   DROP CONSTRAINT household_todos_origin_placement_check;
 END IF;
 ALTER TABLE swarm.household_todos
  ADD CONSTRAINT household_todos_origin_placement_check
  CHECK (origin_placement IN ('workspace', 'general', 'channel', 'dm', 'group_dm'));

 IF EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'household_todos_origin_shape_check'
    AND conrelid = 'swarm.household_todos'::regclass
 ) THEN
  ALTER TABLE swarm.household_todos
   DROP CONSTRAINT household_todos_origin_shape_check;
 END IF;
 ALTER TABLE swarm.household_todos
  ADD CONSTRAINT household_todos_origin_shape_check
  CHECK (
   ((origin_placement = 'channel') = (origin_channel_id IS NOT NULL))
   AND ((origin_placement IN ('dm', 'group_dm')) = (origin_conversation_id IS NOT NULL))
  );

 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'household_todos_origin_conversation_fk'
    AND conrelid = 'swarm.household_todos'::regclass
 ) THEN
  ALTER TABLE swarm.household_todos
   ADD CONSTRAINT household_todos_origin_conversation_fk
   FOREIGN KEY (origin_conversation_id, workspace_id)
   REFERENCES swarm.conversations(conversation_id, workspace_id);
 END IF;
END;
$$;

CREATE OR REPLACE FUNCTION swarm.actor_can_access_direct_conversation(
 p_workspace_id uuid,
 p_conversation_id uuid,
 p_expected_kind text,
 p_actor_kind text,
 p_actor_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
 IF p_workspace_id IS NULL
  OR p_conversation_id IS NULL
  OR p_expected_kind IS NULL
  OR p_expected_kind NOT IN ('dm', 'group_dm')
  OR p_actor_kind IS NULL
  OR p_actor_kind NOT IN ('user', 'agent')
  OR p_actor_id IS NULL THEN
  RETURN false;
 END IF;

 IF p_actor_kind = 'user' THEN
  IF NOT swarm.is_member(p_workspace_id, p_actor_id) THEN
   RETURN false;
  END IF;
 ELSE
  IF to_regclass('swarm.agent_workspace_memberships') IS NOT NULL THEN
   IF NOT EXISTS (
    SELECT 1
    FROM swarm.agent_principals p
    JOIN swarm.memberships owner_m
     ON owner_m.workspace_id = p_workspace_id
     AND owner_m.user_id = p.owner_user_id
     AND owner_m.revoked_at IS NULL
    WHERE p.principal_id = p_actor_id
     AND p.revoked_at IS NULL
     AND (
      EXISTS (
       SELECT 1 FROM swarm.agent_workspace_memberships am
       WHERE am.principal_id = p.principal_id
        AND am.workspace_id = p_workspace_id
        AND am.owner_user_id = p.owner_user_id
        AND am.revoked_at IS NULL
      )
      OR (
       p.workspace_id = p_workspace_id
       AND NOT EXISTS (
        SELECT 1 FROM swarm.agent_workspace_memberships any_am
        WHERE any_am.principal_id = p.principal_id
         AND any_am.workspace_id = p_workspace_id
       )
      )
     )
   ) THEN
    RETURN false;
   END IF;
  ELSE
   IF NOT EXISTS (
    SELECT 1
    FROM swarm.agent_principals p
    JOIN swarm.memberships owner_m
     ON owner_m.workspace_id = p_workspace_id
     AND owner_m.user_id = p.owner_user_id
     AND owner_m.revoked_at IS NULL
    WHERE p.principal_id = p_actor_id
     AND p.workspace_id = p_workspace_id
     AND p.revoked_at IS NULL
   ) THEN
    RETURN false;
   END IF;
  END IF;
 END IF;

 RETURN EXISTS (
  SELECT 1
  FROM swarm.conversations c
  JOIN swarm.conversation_members cm
   ON cm.conversation_id = c.conversation_id
   AND cm.workspace_id = c.workspace_id
  WHERE c.workspace_id = p_workspace_id
   AND c.conversation_id = p_conversation_id
   AND c.kind = p_expected_kind
   AND cm.left_at IS NULL
   AND (
    (p_actor_kind = 'user' AND cm.member_user_id = p_actor_id)
    OR (p_actor_kind = 'agent' AND cm.member_agent_principal_id = p_actor_id)
   )
 );
END;
$$;

ALTER FUNCTION swarm.actor_can_access_direct_conversation(uuid, uuid, text, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.actor_can_access_direct_conversation(uuid, uuid, text, text, uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.actor_can_access_direct_conversation(uuid, uuid, text, text, uuid) TO swarm_command;

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
  -- swarm_read.signals applies the viewer's normal visibility gate.
  SELECT s.id, s."from", s.from_kind, s.body, s.created_at, s.until
  FROM swarm_read.signals s
  WHERE s.workspace_id = p_workspace_id AND s.kind = 'ask' AND s.until > read_at
   AND (s."to" = viewer OR EXISTS (
    SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer))
   AND NOT swarm.ask_answered(s.workspace_id, s.id)
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
   'conversation_id', c.conversation_id,
   'conversation_kind', c.kind,
   'reraised', CASE WHEN x.signal_id IS NULL THEN NULL
     ELSE jsonb_build_object('count', x.raise_count, 'last_at', x.last_raised_at) END
  ) ORDER BY p.created_at, p.id), '[]'::jsonb)
 INTO total, rows
 FROM page p
 LEFT JOIN swarm.conversation_signals cs ON cs.workspace_id = p_workspace_id AND cs.signal_id = p.id
 LEFT JOIN swarm.conversations c ON c.workspace_id = p_workspace_id AND c.conversation_id = cs.conversation_id
  AND (
   c.kind IN ('general', 'public_channel')
   OR (c.kind = 'private_channel' AND swarm.claims_can_access_channel(p_workspace_id, c.channel_id))
   OR (c.kind IN ('dm', 'group_dm') AND EXISTS (
    SELECT 1 FROM swarm.conversation_members cm
    WHERE cm.workspace_id = c.workspace_id
     AND cm.conversation_id = c.conversation_id
     AND cm.member_user_id = viewer
     AND cm.left_at IS NULL
   ))
  )
 LEFT JOIN swarm.ask_reraises x ON x.workspace_id = p_workspace_id AND x.signal_id = p.id;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'total', total, 'truncated', total > 100, 'asks', rows);
END;
$$;
ALTER FUNCTION swarm_read.decision_queue(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.decision_queue(uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.decision_queue(uuid) TO authenticated;

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
 IF p_after_id IS NOT NULL THEN
  SELECT s.created_at INTO anchor_created_at
  FROM swarm_read.signals s
  WHERE s.workspace_id = p_workspace_id AND s.id = p_after_id;
  anchor_created_at := coalesce(anchor_created_at, p_after_created_at);
 END IF;
 WITH open_asks AS MATERIALIZED (
  SELECT s.id, s."from", s.from_kind, s.body, s.created_at, s.until
  FROM swarm_read.signals s
  WHERE s.workspace_id = p_workspace_id AND s.kind = 'ask' AND s.until > read_at
   AND (s."to" = viewer OR EXISTS (
    SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer))
   AND NOT swarm.ask_answered(s.workspace_id, s.id)
 ), page_probe AS MATERIALIZED (
  SELECT * FROM open_asks
  WHERE anchor_created_at IS NULL
   OR (created_at, id) > (anchor_created_at, p_after_id)
  ORDER BY created_at, id
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
   'conversation_id', c.conversation_id,
   'conversation_kind', c.kind,
   'reraised', CASE WHEN x.signal_id IS NULL THEN NULL
     ELSE jsonb_build_object('count', x.raise_count, 'last_at', x.last_raised_at) END
  ) ORDER BY p.created_at, p.id), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p
 LEFT JOIN swarm.conversation_signals cs ON cs.workspace_id = p_workspace_id AND cs.signal_id = p.id
 LEFT JOIN swarm.conversations c ON c.workspace_id = p_workspace_id AND c.conversation_id = cs.conversation_id
  AND (
   c.kind IN ('general', 'public_channel')
   OR (c.kind = 'private_channel' AND swarm.claims_can_access_channel(p_workspace_id, c.channel_id))
   OR (c.kind IN ('dm', 'group_dm') AND EXISTS (
    SELECT 1 FROM swarm.conversation_members cm
    WHERE cm.workspace_id = c.workspace_id
     AND cm.conversation_id = c.conversation_id
     AND cm.member_user_id = viewer
     AND cm.left_at IS NULL
   ))
  )
 LEFT JOIN swarm.ask_reraises x ON x.workspace_id = p_workspace_id AND x.signal_id = p.id;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'total', total, 'truncated', has_more, 'asks', rows);
END;
$$;

ALTER FUNCTION swarm_read.decision_queue_page(uuid, timestamptz, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.decision_queue_page(uuid, timestamptz, uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.decision_queue_page(uuid, timestamptz, uuid) TO authenticated;
