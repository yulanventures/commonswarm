-- A person's read position per channel, so reading a channel clears its unread for good.
--
-- Until now a person's channel unread (swarm_read.channel_unread) was the set of messages with no
-- seen receipt (swarm.signal_human_receipts). The web app writes a receipt only for a row it shows in
-- the focused viewport, so a message scrolled past, or older than the first loaded page, kept its
-- channel unread for 14 days. Agents already keep a high-water position (swarm.agent_channel_reads).
--
-- swarm.human_channel_reads is that position for a person: the newest message they have read in a
-- channel (or in general, the unfiled messages), by (created_at, id). Only the command edge writes it
-- (mark_channel_read), only forward. A NULL read_through_id means "through read_through_at
-- inclusive": marking a channel read without naming a message reads everything up to that moment.
--
-- swarm_read.channel_unread is recreated from 20261113000003 with every predicate, key, owner and
-- grant it had. A message is unread only if it is also strictly after the person's position in its
-- channel, and the person's first position counts toward the unread baseline as a first receipt
-- does. Each channel gains unread_count, first_unread_id and first_unread_at, computed by the same
-- scan as unread so they never disagree. Readers that do not know the new keys ignore them.
--
-- Rollback: recreate swarm_read.channel_unread from 20261113000003_private_channels.sql (540-607),
-- then drop swarm.human_channel_reads. Nothing else reads the table.

CREATE TABLE swarm.human_channel_reads (
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- NULL is general (unfiled channel messages).
  channel_id uuid,
  read_through_at timestamptz NOT NULL,
  -- NULL: read through read_through_at inclusive (marked read without naming a message).
  read_through_id uuid,
  first_read_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (channel_id, workspace_id) REFERENCES swarm.channels (channel_id, workspace_id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (user_id, workspace_id, channel_id)
);

ALTER TABLE swarm.human_channel_reads OWNER TO swarm_admin;
ALTER TABLE swarm.human_channel_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.human_channel_reads
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.human_channel_reads FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.human_channel_reads TO swarm_command;

COMMENT ON TABLE swarm.human_channel_reads IS
  'A person''s read position per channel (NULL channel_id: general), by (created_at, id). Written only '
  'by mark_channel_read, only forward. A NULL read_through_id reads through read_through_at inclusive.';

-- Per-channel unread + personal preferences for the signed-in person, omitting private channels
-- where the viewer is not a member. From 20261113000003, plus the read position and the counts.
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
 -- The earlier of the first receipt and the first read position; least() skips a NULL.
 baseline := least(
  (SELECT min(r.first_seen_at) FROM swarm.signal_human_receipts r
   WHERE r.workspace_id = p_workspace_id AND r.user_id = viewer),
  (SELECT min(h.first_read_at) FROM swarm.human_channel_reads h
   WHERE h.workspace_id = p_workspace_id AND h.user_id = viewer));
 since := greatest(baseline, read_at - interval '14 days');
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'generated_at', read_at,
  'channels', (
   SELECT coalesce(jsonb_agg(jsonb_build_object(
     'channel_id', c.channel_id,
     'slug', c.slug,
     'visibility', c.visibility,
     'starred', coalesce(p.starred, false),
     'star_rank', p.star_rank,
     'involvement', coalesce(p.involvement, 'everything'),
     'unread', CASE
      WHEN coalesce(p.involvement, 'everything') = 'muted' THEN false
      WHEN baseline IS NULL THEN NULL
      ELSE u.unread_count > 0 END,
     'unread_count', u.unread_count,
     'first_unread_id', u.first_unread_id,
     'first_unread_at', u.first_unread_at)
    ORDER BY c.general DESC, c.sort_rank, c.slug, c.channel_id), '[]'::jsonb)
   FROM (
    SELECT NULL::uuid AS channel_id, 'general'::text AS slug, 'open'::text AS visibility, 0::integer AS sort_rank, true AS general
    UNION ALL
    SELECT ch.channel_id, ch.slug, ch.visibility, ch.sort_rank, false FROM swarm.channels ch
    WHERE ch.workspace_id = p_workspace_id
      AND ch.archived_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, ch.channel_id, 'user', viewer)
   ) c
   LEFT JOIN swarm.channel_preferences p
    ON p.workspace_id = p_workspace_id
   AND p.user_id = viewer
   AND p.target_key = coalesce(c.channel_id::text, 'general')
   LEFT JOIN swarm.human_channel_reads pos
    ON pos.workspace_id = p_workspace_id
   AND pos.user_id = viewer
   AND pos.channel_id IS NOT DISTINCT FROM c.channel_id
   -- One scan per channel gives unread, the count and the first unread message, so they agree.
   -- Muted, or no baseline yet: no rows, so 0 and nulls.
   CROSS JOIN LATERAL (
    SELECT count(*)::integer AS unread_count,
     (array_agg(s.id ORDER BY s.created_at, s.id))[1] AS first_unread_id,
     min(s.created_at) AS first_unread_at
    FROM swarm_read.signals s
    WHERE coalesce(p.involvement, 'everything') <> 'muted'
     AND baseline IS NOT NULL
     AND s.workspace_id = p_workspace_id
     AND s.channel_id IS NOT DISTINCT FROM c.channel_id
     AND (s.thread_root_id IS NULL OR s.broadcast_to_channel)
     AND s.created_at > since AND s.until > read_at
     AND NOT (s.from_kind = 'user' AND s."from" = viewer)
     AND NOT EXISTS (SELECT 1 FROM swarm.signal_human_receipts r
      WHERE r.workspace_id = p_workspace_id AND r.signal_id = s.id AND r.user_id = viewer)
     -- Strictly after the read position. A NULL read_through_id reads through read_through_at.
     AND (pos.read_through_at IS NULL
      OR (s.created_at, s.id) > (pos.read_through_at,
       coalesce(pos.read_through_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     AND (
      coalesce(p.involvement, 'everything') = 'everything'
      OR s."to" = viewer
      OR EXISTS (SELECT 1 FROM swarm.signal_recipients sr
       WHERE sr.workspace_id = p_workspace_id AND sr.signal_id = s.id AND sr.recipient_user_id = viewer)
      OR EXISTS (SELECT 1 FROM swarm.signal_mentions sm
       WHERE sm.workspace_id = p_workspace_id AND sm.signal_id = s.id AND sm.mentioned_user_id = viewer)
     )
   ) u));
END;
$$;
ALTER FUNCTION swarm_read.channel_unread(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.channel_unread(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.channel_unread(uuid) TO authenticated;
