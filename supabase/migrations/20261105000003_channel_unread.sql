-- Channels C1b: per-channel unread for the signed-in person, from the seen receipts the app
-- already writes (signals_seen, for messages shown in a focused viewport).
--
-- People only, like decision_queue: EXECUTE is granted to authenticated (PostgREST sessions) and
-- nothing else, and claims that name an agent are refused. Messages come from swarm_read.signals,
-- so the person's normal visibility applies.
--
-- Per channel (and general, the unfiled messages), unread is:
--   null  - the person has no receipt in this workspace yet, so there is no read position;
--   true  - a message they can see, in the channel feed (top level, or a thread reply also sent
--           to the channel), not from them, unexpired, newer than both their first receipt in the
--           workspace and 14 days ago, has no receipt from them;
--   false - otherwise.

CREATE OR REPLACE FUNCTION swarm_read.channel_unread(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 baseline timestamptz;
 since timestamptz;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN RETURN NULL; END IF;
 SELECT min(r.first_seen_at) INTO baseline FROM swarm.signal_human_receipts r
  WHERE r.workspace_id = p_workspace_id AND r.user_id = viewer;
 since := greatest(baseline, read_at - interval '14 days');
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'channels', (
   SELECT coalesce(jsonb_agg(jsonb_build_object('channel_id', c.channel_id, 'slug', c.slug,
     'unread', CASE WHEN baseline IS NULL THEN NULL ELSE EXISTS (
      SELECT 1 FROM swarm_read.signals s
      WHERE s.workspace_id = p_workspace_id
       AND s.channel_id IS NOT DISTINCT FROM c.channel_id
       AND (s.thread_root_id IS NULL OR s.broadcast_to_channel)
       AND s.created_at > since AND s.until > read_at
       AND NOT (s.from_kind = 'user' AND s."from" = viewer)
       AND NOT EXISTS (SELECT 1 FROM swarm.signal_human_receipts r
        WHERE r.workspace_id = p_workspace_id AND r.signal_id = s.id AND r.user_id = viewer)) END)
    ORDER BY c.general DESC, c.slug, c.channel_id), '[]'::jsonb)
   FROM (
    SELECT NULL::uuid AS channel_id, 'general'::text AS slug, true AS general
    UNION ALL
    SELECT ch.channel_id, ch.slug, false FROM swarm.channels ch
    WHERE ch.workspace_id = p_workspace_id AND ch.archived_at IS NULL
   ) c));
END;
$$;
ALTER FUNCTION swarm_read.channel_unread(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.channel_unread(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.channel_unread(uuid) TO authenticated;
