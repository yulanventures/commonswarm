-- Channel Management CM-2a: per-person channel stars & notification involvement,
-- workspace channel order, and workspace channel-creation policy.
--
-- Additive and backward-compatible:
-- 1. swarm.channels gains sort_rank (default 0: alphabetical until reordered).
-- 2. swarm.workspaces gains channel_creation_policy ('members' | 'admins', default 'members').
-- 3. swarm.channel_preferences stores a person's starred status, star_rank and involvement
--    ('everything' | 'mentions' | 'muted') per channel or for general (channel_id IS NULL).
-- 4. swarm_read.channels and swarm_read.workspaces append sort_rank and channel_creation_policy
--    without changing existing column positions or types.
-- 5. swarm_read.channel_unread returns starred, star_rank and involvement beside unread,
--    orders live channels by (general DESC, sort_rank, slug, channel_id), suppresses unread
--    when muted, and narrows unread under 'mentions' to messages that address or mention the viewer.

ALTER TABLE swarm.channels
  ADD COLUMN sort_rank integer NOT NULL DEFAULT 0 CHECK (sort_rank >= 0);

ALTER TABLE swarm.workspaces
  ADD COLUMN channel_creation_policy text NOT NULL DEFAULT 'members'
    CHECK (channel_creation_policy IN ('members', 'admins'));

CREATE TABLE swarm.channel_preferences (
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES swarm.users (user_id) ON DELETE CASCADE,
  -- NULL targets general (unfiled workspace messages).
  channel_id uuid,
  target_key text GENERATED ALWAYS AS (COALESCE(channel_id::text, 'general')) STORED,
  starred boolean NOT NULL DEFAULT false,
  star_rank integer CHECK (star_rank IS NULL OR star_rank >= 0),
  involvement text NOT NULL DEFAULT 'everything'
    CHECK (involvement IN ('everything', 'mentions', 'muted')),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, user_id, target_key),
  CHECK ((starred = false AND star_rank IS NULL) OR (starred = true AND star_rank IS NOT NULL)),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES swarm.channels (channel_id, workspace_id) ON DELETE CASCADE
);

ALTER TABLE swarm.channel_preferences OWNER TO swarm_admin;
ALTER TABLE swarm.channel_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.channel_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.channel_preferences
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.channel_preferences FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, UPDATE ON TABLE swarm.channel_preferences TO swarm_command;

-- Paired with signal_mentions_agent (20261113000001) so per-person 'mentions' involvement
-- checks in swarm_read.channel_unread use an index lookup.
CREATE INDEX signal_mentions_user
  ON swarm.signal_mentions (workspace_id, mentioned_user_id, signal_id)
  WHERE mentioned_user_id IS NOT NULL;

-- A person reads only their own preferences in workspaces where they are a live member.
CREATE VIEW swarm_read.channel_preferences
WITH (security_barrier = true)
AS
  SELECT
    p.workspace_id,
    p.channel_id,
    p.target_key,
    p.starred,
    p.star_rank,
    p.involvement,
    p.updated_at
  FROM swarm.channel_preferences AS p
  WHERE p.user_id = auth.uid()
    AND swarm.is_member(p.workspace_id, auth.uid());

ALTER VIEW swarm_read.channel_preferences OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.channel_preferences FROM PUBLIC, anon, swarm_read, swarm_command;
GRANT SELECT ON swarm_read.channel_preferences TO authenticated;

-- Append sort_rank at the end so explicit 8-column selects stay unchanged.
CREATE OR REPLACE VIEW swarm_read.channels
WITH (security_barrier = true)
AS
  SELECT
    c.channel_id,
    c.workspace_id,
    c.slug,
    c.purpose,
    c.created_by_principal,
    c.created_by_kind,
    c.created_at,
    c.archived_at,
    c.sort_rank
  FROM swarm.channels AS c
  WHERE swarm.is_member(c.workspace_id, auth.uid());

ALTER VIEW swarm_read.channels OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.channels TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.channels FROM PUBLIC, anon;

-- Append channel_creation_policy after lead_agent_principal_id (20261103000001).
CREATE OR REPLACE VIEW swarm_read.workspaces
WITH (security_barrier = true)
AS
  SELECT
    w.workspace_id,
    w.name,
    w.archived_at,
    w.org_id,
    o.display_name AS org_display_name,
    w.lead_agent_principal_id,
    w.channel_creation_policy
  FROM swarm.workspaces w
  JOIN swarm.organizations o ON o.id = w.org_id
  WHERE swarm.is_member(w.workspace_id, auth.uid())
    AND w.archived_at IS NULL;

ALTER VIEW swarm_read.workspaces OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.workspaces TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.workspaces FROM PUBLIC, anon;

-- Per-channel unread + personal star/involvement projection for the signed-in person.
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
   SELECT coalesce(jsonb_agg(jsonb_build_object(
     'channel_id', c.channel_id,
     'slug', c.slug,
     'starred', coalesce(p.starred, false),
     'star_rank', p.star_rank,
     'involvement', coalesce(p.involvement, 'everything'),
     'unread', CASE
      WHEN coalesce(p.involvement, 'everything') = 'muted' THEN false
      WHEN baseline IS NULL THEN NULL
      ELSE EXISTS (
       SELECT 1 FROM swarm_read.signals s
       WHERE s.workspace_id = p_workspace_id
        AND s.channel_id IS NOT DISTINCT FROM c.channel_id
        AND (s.thread_root_id IS NULL OR s.broadcast_to_channel)
        AND s.created_at > since AND s.until > read_at
        AND NOT (s.from_kind = 'user' AND s."from" = viewer)
        AND NOT EXISTS (SELECT 1 FROM swarm.signal_human_receipts r
         WHERE r.workspace_id = p_workspace_id AND r.signal_id = s.id AND r.user_id = viewer)
        AND (
         coalesce(p.involvement, 'everything') = 'everything'
         OR s."to" = viewer
         OR EXISTS (SELECT 1 FROM swarm.signal_recipients sr
          WHERE sr.workspace_id = p_workspace_id AND sr.signal_id = s.id AND sr.recipient_user_id = viewer)
         OR EXISTS (SELECT 1 FROM swarm.signal_mentions sm
          WHERE sm.workspace_id = p_workspace_id AND sm.signal_id = s.id AND sm.mentioned_user_id = viewer)
        )
      ) END)
    ORDER BY c.general DESC, c.sort_rank, c.slug, c.channel_id), '[]'::jsonb)
   FROM (
    SELECT NULL::uuid AS channel_id, 'general'::text AS slug, 0::integer AS sort_rank, true AS general
    UNION ALL
    SELECT ch.channel_id, ch.slug, ch.sort_rank, false FROM swarm.channels ch
    WHERE ch.workspace_id = p_workspace_id AND ch.archived_at IS NULL
   ) c
   LEFT JOIN swarm.channel_preferences p
    ON p.workspace_id = p_workspace_id
   AND p.user_id = viewer
   AND p.target_key = coalesce(c.channel_id::text, 'general')));
END;
$$;
ALTER FUNCTION swarm_read.channel_unread(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.channel_unread(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.channel_unread(uuid) TO authenticated;
