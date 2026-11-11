-- Channels C1b for agents: per-channel unread on channel_ls, from a read position that channel_read
-- advances.
--
-- An agent's read position in a channel (and in general, the unfiled messages) is the newest message
-- channel_read has returned to it there, by (created_at, id), or none when every read there came back
-- empty. Only channel_read moves it, only forward, only to a message that read could return, and only
-- for a read whose caller delivers the page whole (the read function decides that; see
-- supabase/functions/read/index.ts). The agent's first read in a workspace, empty or not, starts its
-- unread there. Per channel, unread is:
--   null  - the agent has no read position anywhere in this workspace yet;
--   true  - a message channel_read would return there (whole-workspace, unexpired), not from this
--           agent, newer than the read position in that channel, the agent's first read in the
--           workspace and 14 days ago;
--   false - otherwise.
-- The person's own unread (swarm_read.channel_unread, 20261105000003) is unchanged.
--
-- The read function stays read-only: it runs as swarm_read, which has no grant on the table. The
-- only write is swarm.agent_channel_read_advance, a definer that admits the caller from the
-- installed claims exactly as swarm_read.channel_messages does.

CREATE TABLE swarm.agent_channel_reads (
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES swarm.agent_principals (principal_id) ON DELETE CASCADE,
  -- NULL is general.
  channel_id uuid,
  -- Both NULL until a read there returns a message.
  read_through_at timestamptz,
  read_through_id uuid,
  first_read_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (channel_id, workspace_id) REFERENCES swarm.channels (channel_id, workspace_id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (principal_id, workspace_id, channel_id),
  CHECK ((read_through_at IS NULL) = (read_through_id IS NULL))
);
ALTER TABLE swarm.agent_channel_reads OWNER TO swarm_admin;
ALTER TABLE swarm.agent_channel_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.agent_channel_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_channel_reads_admin_all ON swarm.agent_channel_reads
  FOR ALL TO swarm_admin USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.agent_channel_reads FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- The whole-workspace rule swarm_read.channel_messages applies to a message and to its thread root:
-- no scalar addressee, no recipient rows, not a reply, not part of an ask chain. Callable only by
-- its owner, so only from the definers below.
CREATE FUNCTION swarm.channel_feed_message(s swarm.signals) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
 SELECT s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL
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
     WHERE rr.workspace_id = root.workspace_id AND rr.signal_id = root.id)))
$$;
ALTER FUNCTION swarm.channel_feed_message(swarm.signals) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.channel_feed_message(swarm.signals)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- The calling agent, admitted as swarm_read.channel_messages admits it: valid claims naming an
-- agent, a live member owner, and the agent live in this workspace. NULL otherwise.
CREATE FUNCTION swarm.channel_reading_agent(p_workspace_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 caller uuid;
 caller_agent uuid;
BEGIN
 IF p_workspace_id IS NULL OR claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR coalesce(claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 caller := (claims->>'sub')::uuid;
 caller_agent := (claims->>'agent_principal_id')::uuid;
 IF NOT swarm.is_member(p_workspace_id, caller) THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM swarm.agent_principals p
  JOIN swarm.agent_workspace_memberships am USING (principal_id, owner_user_id)
  WHERE am.workspace_id = p_workspace_id AND p.principal_id = caller_agent
    AND p.owner_user_id = caller AND p.revoked_at IS NULL AND am.revoked_at IS NULL) THEN
  RETURN NULL;
 END IF;
 RETURN caller_agent;
END;
$$;
ALTER FUNCTION swarm.channel_reading_agent(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.channel_reading_agent(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Moves the calling agent's read position in one channel forward to p_through_id, the last message of
-- a delivered channel_read page. NULL records a read that returned nothing. Anything channel_read could
-- not have returned there leaves the position unchanged.
CREATE FUNCTION swarm.agent_channel_read_advance(p_workspace_id uuid, p_channel text, p_through_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 reader uuid := swarm.channel_reading_agent(p_workspace_id);
 is_general boolean := lower(coalesce(p_channel, '')) = 'general';
 target_channel uuid;
 through_at timestamptz;
BEGIN
 IF reader IS NULL OR p_channel IS NULL THEN RETURN; END IF;
 IF NOT is_general THEN
  SELECT c.channel_id INTO target_channel FROM swarm.channels c
  WHERE c.workspace_id = p_workspace_id AND lower(c.slug) = lower(p_channel);
  IF target_channel IS NULL THEN RETURN; END IF;
 END IF;
 IF p_through_id IS NULL THEN
  INSERT INTO swarm.agent_channel_reads (workspace_id, principal_id, channel_id)
  VALUES (p_workspace_id, reader, target_channel)
  ON CONFLICT (principal_id, workspace_id, channel_id) DO NOTHING;
  RETURN;
 END IF;
 SELECT s.created_at INTO through_at FROM swarm.signals s
 WHERE s.workspace_id = p_workspace_id AND s.id = p_through_id
  AND s.channel_id IS NOT DISTINCT FROM target_channel
  AND s.until > statement_timestamp()
  AND swarm.channel_feed_message(s);
 IF through_at IS NULL THEN RETURN; END IF;
 INSERT INTO swarm.agent_channel_reads AS r (workspace_id, principal_id, channel_id, read_through_at, read_through_id)
 VALUES (p_workspace_id, reader, target_channel, through_at, p_through_id)
 ON CONFLICT (principal_id, workspace_id, channel_id) DO UPDATE
  SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
   updated_at = statement_timestamp()
  WHERE r.read_through_at IS NULL
   OR (excluded.read_through_at, excluded.read_through_id) > (r.read_through_at, r.read_through_id);
END;
$$;
ALTER FUNCTION swarm.agent_channel_read_advance(uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_channel_read_advance(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.agent_channel_read_advance(uuid, text, uuid) TO swarm_read;

-- The calling agent's unread per channel: general first, then every channel (archived included),
-- by slug. NULL when the caller is not an admitted agent of this workspace.
CREATE FUNCTION swarm_read.agent_channel_unread(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 reader uuid := swarm.channel_reading_agent(p_workspace_id);
 read_at timestamptz := statement_timestamp();
 baseline timestamptz;
 since timestamptz;
BEGIN
 IF reader IS NULL THEN RETURN NULL; END IF;
 SELECT min(r.first_read_at) INTO baseline FROM swarm.agent_channel_reads r
  WHERE r.workspace_id = p_workspace_id AND r.principal_id = reader;
 since := greatest(baseline, read_at - interval '14 days');
 RETURN coalesce((
  SELECT jsonb_agg(jsonb_build_object('channel_id', c.channel_id, 'slug', c.slug,
    'unread', CASE WHEN baseline IS NULL THEN NULL ELSE EXISTS (
     SELECT 1 FROM swarm.signals s
     WHERE s.workspace_id = p_workspace_id
      AND s.channel_id IS NOT DISTINCT FROM c.channel_id
      AND s.created_at > since AND s.until > read_at
      AND NOT (s.from_kind = 'agent' AND s.from_principal = reader)
      AND (pos.read_through_at IS NULL
       OR (s.created_at, s.id) > (pos.read_through_at, pos.read_through_id))
      AND swarm.channel_feed_message(s)) END)
   ORDER BY c.general DESC, c.slug, c.channel_id)
  FROM (
   SELECT NULL::uuid AS channel_id, 'general'::text AS slug, true AS general
   UNION ALL
   SELECT ch.channel_id, ch.slug, false FROM swarm.channels ch WHERE ch.workspace_id = p_workspace_id
  ) c
  LEFT JOIN swarm.agent_channel_reads pos
   ON pos.workspace_id = p_workspace_id AND pos.principal_id = reader
   AND pos.channel_id IS NOT DISTINCT FROM c.channel_id), '[]'::jsonb);
END;
$$;
ALTER FUNCTION swarm_read.agent_channel_unread(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.agent_channel_unread(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.agent_channel_unread(uuid) TO swarm_read;
