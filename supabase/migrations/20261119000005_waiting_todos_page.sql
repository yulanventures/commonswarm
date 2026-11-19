-- Keyset-paginated waiting/assigned to-dos read for the Waiting on you panel and top-bar count.
--
-- swarm_read.home_overview caps needs_you.assigned and needs_you.waiting at 20 rows per workspace
-- with no pagination cursor or truncation flag, so item 21 is unreachable and exact totals cannot
-- be established. This RPC returns a unified, deduplicated, keyset-paginated list of every open or
-- doing to-do that needs the signed-in person (same reason precedence as home-map.ts pushNeed and
-- the same household_human_can_read gate and multi-workspace agent seat check as home_overview),
-- together with exact total and truncated flags.
--
-- For each row on the bounded page, a LATERAL lookup against swarm_read.signals resolves an
-- authoritative channel or #general conversation placement from the latest viewer-visible signal
-- carrying about = 'todo:' || todo_id. Addressed channel_id IS NULL notices (such as automatic
-- householdNotice notifications) are excluded so they never clobber a channel placement or turn a
-- workspace-only to-do into a channel/DM item. Explicit s.workspace_id and s.about predicates let
-- PostgreSQL push the lookup into signals_about_newest before the security_barrier filter.
--
-- Rollback: DROP FUNCTION IF EXISTS swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid);

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
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN RETURN NULL; END IF;
 IF (p_after_state_at IS NULL) <> (p_after_todo_id IS NULL) THEN
  RAISE EXCEPTION 'waiting_todos_cursor_invalid' USING ERRCODE = '22023';
 END IF;
 page_limit := greatest(1, least(coalesce(p_limit, 50), 100));
 -- Match home_overview: members without household content read access see no to-dos.
 IF NOT swarm.household_human_can_read(p_workspace_id, viewer) THEN
  RETURN jsonb_build_object(
   'workspace_id', p_workspace_id,
   'generated_at', read_at,
   'total', 0,
   'truncated', false,
   'todos', '[]'::jsonb
  );
 END IF;

 WITH candidate_todos AS MATERIALIZED (
  SELECT
   t.todo_id,
   t.title,
   t.state,
   t.due_on,
   t.state_at,
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
   'placement', coalesce(loc.placement_kind, 'workspace'),
   'channel_id', loc.channel_id
  ) ORDER BY p.state_at DESC, p.todo_id ASC), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p
 LEFT JOIN LATERAL (
  -- Authoritative conversation placement from viewer-visible signals referencing this to-do.
  -- Explicit workspace_id + about push into signals_about_newest before security_barrier.
  SELECT
   s.channel_id,
   CASE WHEN s.channel_id IS NOT NULL THEN 'channel' ELSE 'general' END AS placement_kind
  FROM swarm_read.signals s
  WHERE s.workspace_id = p_workspace_id
   AND s.about = 'todo:' || p.todo_id::text
   AND (
    s.channel_id IS NOT NULL
    OR (
     s.thread_root_id IS NULL
     AND s."to" IS NULL
     AND s.to_agent IS NULL
     AND NOT EXISTS (
      SELECT 1 FROM swarm.signal_recipients r
      WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
     )
    )
   )
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1
 ) loc ON true;

 RETURN jsonb_build_object(
  'workspace_id', p_workspace_id,
  'generated_at', read_at,
  'total', total,
  'truncated', has_more,
  'todos', rows
 );
END;
$$;

ALTER FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) TO authenticated;
