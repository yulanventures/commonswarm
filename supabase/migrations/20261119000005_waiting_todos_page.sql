-- Paginated waiting/assigned to-dos read for the Waiting on you panel.
-- 1. Stores an immutable originating channel link on swarm.household_todos so a to-do's
--    origin channel is stable across later discussions and workspace-only tasks are never
--    promoted into a channel just by being mentioned there.
-- 2. Reaches beyond home_overview's 20-item cap with deterministic keyset pagination
--    (state_at DESC, todo_id ASC), resolving exact microsecond state_at from the viewer's
--    own candidate rows so millisecond-precision client cursors never repeat a boundary.
-- 3. Mirrors home_overview's exact household_human_can_read gate, human-only JWT check,
--    and waiting-reason precedence (including multi-workspace agent seat checks), and
--    redacts private origin_channel_id to ('workspace', NULL) when the viewer lacks access.

ALTER TABLE swarm.household_todos
 ADD COLUMN IF NOT EXISTS origin_placement text NOT NULL DEFAULT 'workspace',
 ADD COLUMN IF NOT EXISTS origin_channel_id uuid;

DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'household_todos_origin_placement_check'
    AND conrelid = 'swarm.household_todos'::regclass
 ) THEN
  ALTER TABLE swarm.household_todos
   ADD CONSTRAINT household_todos_origin_placement_check
   CHECK (origin_placement IN ('workspace', 'general', 'channel'));
 END IF;

 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'household_todos_origin_shape_check'
    AND conrelid = 'swarm.household_todos'::regclass
 ) THEN
  ALTER TABLE swarm.household_todos
   ADD CONSTRAINT household_todos_origin_shape_check
   CHECK ((origin_placement = 'channel') = (origin_channel_id IS NOT NULL));
 END IF;

 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'household_todos_origin_channel_fk'
    AND conrelid = 'swarm.household_todos'::regclass
 ) THEN
  ALTER TABLE swarm.household_todos
   ADD CONSTRAINT household_todos_origin_channel_fk
   FOREIGN KEY (origin_channel_id, workspace_id)
   REFERENCES swarm.channels(channel_id, workspace_id);
 END IF;
END;
$$;

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
    -- Pending offer requests replace plain assignment so each to-do appears once with its
    -- primary viewer action (matching home-map.ts pushNeed).
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
  -- Resolve exact microsecond state_at only from the viewer's own candidate rows so
  -- millisecond-precision client timestamps never repeat a page boundary and unrelated to-dos
  -- never leak timestamps.
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
   'channel_id', vis.channel_id
  ) ORDER BY p.state_at DESC, p.todo_id ASC), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p
 CROSS JOIN LATERAL (
  SELECT
   CASE
    WHEN p.origin_placement = 'channel'
     AND p.origin_channel_id IS NOT NULL
     AND swarm.claims_can_access_channel(p_workspace_id, p.origin_channel_id)
    THEN 'channel'
    WHEN p.origin_placement = 'general' THEN 'general'
    ELSE 'workspace'
   END AS placement,
   CASE
    WHEN p.origin_placement = 'channel'
     AND p.origin_channel_id IS NOT NULL
     AND swarm.claims_can_access_channel(p_workspace_id, p.origin_channel_id)
    THEN p.origin_channel_id
    ELSE NULL
   END AS channel_id
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
