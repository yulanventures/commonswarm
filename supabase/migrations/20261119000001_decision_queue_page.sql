-- Keyset-paginated decision queue read so clients (Waiting on you channel panel and Catch up)
-- can reach and answer asks beyond the 100-row first page of swarm_read.decision_queue without
-- changing the existing single-argument RPC signature.

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
 total integer;
 has_more boolean;
 rows jsonb;
BEGIN
 -- A person's own session only. Agent paths install claims with agent_principal_id (and run
 -- as swarm_read or swarm_command, which cannot execute this); an owner-derived agent claim
 -- is never a person.
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
  -- swarm_read.signals applies the viewer's normal visibility gate.
  SELECT s.id, s."from", s.from_kind, s.body, s.created_at, s.until
  FROM swarm_read.signals s
  WHERE s.workspace_id = p_workspace_id AND s.kind = 'ask' AND s.until > read_at
   AND (s."to" = viewer OR EXISTS (
    SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer))
   AND NOT swarm.ask_answered(s.workspace_id, s.id)
 ), page_probe AS MATERIALIZED (
  SELECT * FROM open_asks
  WHERE p_after_created_at IS NULL
   OR (created_at, id) > (p_after_created_at, p_after_id)
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
