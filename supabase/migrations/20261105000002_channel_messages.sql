-- Channels C3: one channel's whole-workspace messages, for an agent (hosted seats included).
--
-- Rows are only messages every member of the workspace can already read: no scalar addressee,
-- no recipient rows, not a reply, not part of an ask chain, unexpired, filed in this channel
-- (and, for a thread reply, a root that meets the same rule),
-- ("general" = unfiled). Addressed messages and DMs never appear, whatever the caller's owner can
-- see. Gate as workspace_roster: valid claims, a live member, and an agent admitted to this
-- workspace. Paged oldest first by (created_at, id), at most 50 rows.

CREATE OR REPLACE FUNCTION swarm_read.channel_messages(
  p_workspace_id uuid, p_channel text, p_after_id uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 caller uuid;
 caller_agent uuid;
 read_at timestamptz := statement_timestamp();
 is_general boolean := lower(coalesce(p_channel, '')) = 'general';
 target_channel uuid;
 target_archived timestamptz;
 after_at timestamptz;
 page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
 page_rows jsonb;
 more boolean;
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

 IF p_channel IS NULL THEN RETURN NULL; END IF;
 IF NOT is_general THEN
  SELECT c.channel_id, c.archived_at INTO target_channel, target_archived
  FROM swarm.channels c
  WHERE c.workspace_id = p_workspace_id AND lower(c.slug) = lower(p_channel);
  IF target_channel IS NULL THEN
   RETURN jsonb_build_object('error', 'channel_not_found');
  END IF;
 END IF;
 -- The cursor is the last message of the previous page, looked up here (workspace-pinned) so its
 -- time never round-trips through JSON.
 IF p_after_id IS NOT NULL THEN
  -- The anchor must itself be a message this read would return (same channel, same whole-workspace
  -- rules), so any other id, private or unknown, gets the same refusal and no ordering metadata.
  SELECT s.created_at INTO after_at FROM swarm.signals s
  WHERE s.workspace_id = p_workspace_id AND s.id = p_after_id
   AND CASE WHEN is_general THEN s.channel_id IS NULL ELSE s.channel_id = target_channel END
   AND s.until > read_at
   AND s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL
   AND s.in_reply_to IS NULL AND s.parent_signal_id IS NULL
   AND s.chain_root_id IS NULL AND s.chain_participants IS NULL
   AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id)
   AND (s.thread_root_id IS NULL OR EXISTS (
    SELECT 1 FROM swarm.signals root
    WHERE root.workspace_id = s.workspace_id AND root.id = s.thread_root_id
     AND root.to_user_id IS NULL AND root.to_agent_principal_id IS NULL
     AND root.in_reply_to IS NULL AND root.parent_signal_id IS NULL
     AND root.chain_root_id IS NULL AND root.chain_participants IS NULL
     AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients rr
      WHERE rr.workspace_id = root.workspace_id AND rr.signal_id = root.id)));
  IF after_at IS NULL THEN RETURN jsonb_build_object('error', 'cursor_not_found'); END IF;
 END IF;
 WITH page AS MATERIALIZED (
  SELECT s.id, s.from_kind, s.from_principal, s.kind, s.body, s.created_at, s.until, s.thread_root_id
  FROM swarm.signals s
  WHERE s.workspace_id = p_workspace_id
   AND CASE WHEN is_general THEN s.channel_id IS NULL ELSE s.channel_id = target_channel END
   AND s.until > read_at
   AND s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL
   AND s.in_reply_to IS NULL AND s.parent_signal_id IS NULL
   AND s.chain_root_id IS NULL AND s.chain_participants IS NULL
   AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients r
    WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id)
   -- A thread reply appears only when its root is itself whole-workspace in this workspace,
   -- so a returned thread_root_id never points at a message the reader couldn't read.
   AND (s.thread_root_id IS NULL OR EXISTS (
    SELECT 1 FROM swarm.signals root
    WHERE root.workspace_id = s.workspace_id AND root.id = s.thread_root_id
     AND root.to_user_id IS NULL AND root.to_agent_principal_id IS NULL
     AND root.in_reply_to IS NULL AND root.parent_signal_id IS NULL
     AND root.chain_root_id IS NULL AND root.chain_participants IS NULL
     AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients rr
      WHERE rr.workspace_id = root.workspace_id AND rr.signal_id = root.id)))
   AND (p_after_id IS NULL OR (s.created_at, s.id) > (after_at, p_after_id))
  ORDER BY s.created_at, s.id
  LIMIT page_limit + 1
 ), shown AS (
  SELECT * FROM page ORDER BY created_at, id LIMIT page_limit
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'signal_id', m.id,
   'from', jsonb_build_object('kind', m.from_kind, 'id', m.from_principal,
     'name', CASE m.from_kind
      WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = m.from_principal)
      ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = m.from_principal) END),
   'kind', m.kind,
   -- Untrusted text.
   'body', m.body,
   'created_at', m.created_at,
   'until', m.until,
   'thread_root_id', m.thread_root_id,
   -- Ids only; file_get applies its own checks.
   'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object('file_id', at.file_id, 'version_n', at.version_n)
      ORDER BY at.position) FROM swarm.signal_attachments at
      WHERE at.workspace_id = p_workspace_id AND at.signal_id = m.id), '[]'::jsonb)
  ) ORDER BY m.created_at, m.id), '[]'::jsonb),
  (SELECT count(*) FROM page) > page_limit
 INTO page_rows, more
 FROM shown m;
 RETURN jsonb_build_object(
  'workspace_id', p_workspace_id,
  'channel', CASE WHEN is_general THEN 'general' ELSE lower(p_channel) END,
  'archived', target_archived IS NOT NULL,
  'messages', page_rows,
  'next', CASE WHEN more THEN jsonb_build_object(
    'after_id', page_rows->(jsonb_array_length(page_rows) - 1)->'signal_id') ELSE NULL END);
END;
$$;
ALTER FUNCTION swarm_read.channel_messages(uuid, text, uuid, integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.channel_messages(uuid, text, uuid, integer)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
-- swarm_read only: the read function's agent and hosted paths, after their own live authorization.
GRANT EXECUTE ON FUNCTION swarm_read.channel_messages(uuid, text, uuid, integer) TO swarm_read;
