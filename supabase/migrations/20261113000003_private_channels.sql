-- Channel Management CM-3a: private (#lock) channels for people and AI agents.
--
-- Additive and fail-closed:
-- 1. swarm.channels gains visibility ('open' | 'private', default 'open').
-- 2. swarm.channel_members stores explicit human and agent principals admitted to a private
--    channel, with FORCE ROW LEVEL SECURITY and policies for both swarm_command and swarm_admin.
-- 3. swarm.actor_can_access_channel and swarm.claims_can_access_channel enforce both live
--    workspace admission AND private-channel membership, checking agent_principal_id BEFORE sub
--    so an agent never inherits its human owner's private-channel access.
-- 4. swarm_read.channels, swarm_read.channel_members, swarm_read.channel_preferences,
--    swarm_read.signals (dynamic pg_get_viewdef splice + assert_view_clauses_preserved),
--    swarm_read.signal_mentions, swarm_read.channel_unread, swarm_read.channel_messages,
--    swarm.agent_channel_read_advance, swarm_read.agent_channel_unread,
--    swarm.agent_delivery_is_wakeable, and swarm_read.signal_delivery_receipts enforce
--    private-channel membership with zero cross-channel metadata or slug disclosure.

ALTER TABLE swarm.channels
  ADD COLUMN visibility text NOT NULL DEFAULT 'open'
    CHECK (visibility IN ('open', 'private'));

CREATE TABLE swarm.channel_members (
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  member_kind text NOT NULL CHECK (member_kind IN ('user', 'agent')),
  user_id uuid REFERENCES swarm.users (user_id) ON DELETE CASCADE,
  agent_principal_id uuid REFERENCES swarm.agent_principals (principal_id) ON DELETE CASCADE,
  member_key text GENERATED ALWAYS AS (
    CASE
      WHEN member_kind = 'user' THEN 'user:' || user_id::text
      ELSE 'agent:' || agent_principal_id::text
    END
  ) STORED,
  added_by_kind text NOT NULL CHECK (added_by_kind IN ('user', 'agent')),
  added_by_principal uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, channel_id, member_key),
  CHECK (
    (member_kind = 'user' AND user_id IS NOT NULL AND agent_principal_id IS NULL)
    OR (member_kind = 'agent' AND agent_principal_id IS NOT NULL AND user_id IS NULL)
  ),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES swarm.channels (channel_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX channel_members_user_idx
  ON swarm.channel_members (workspace_id, user_id, channel_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX channel_members_agent_idx
  ON swarm.channel_members (workspace_id, agent_principal_id, channel_id)
  WHERE agent_principal_id IS NOT NULL;

ALTER TABLE swarm.channel_members OWNER TO swarm_admin;
ALTER TABLE swarm.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.channel_members FORCE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.channel_members
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

CREATE POLICY swarm_admin_all ON swarm.channel_members
  AS PERMISSIVE FOR ALL TO swarm_admin
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.channel_members FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, DELETE ON TABLE swarm.channel_members TO swarm_command;

-- Single source of truth for whether a person or agent can see or participate in a channel.
-- Always verifies live workspace admission first (soft-revocation sets revoked_at without
-- deleting FK rows), then requires an explicit swarm.channel_members row when private.
CREATE OR REPLACE FUNCTION swarm.actor_can_access_channel(
  p_workspace_id uuid,
  p_channel_id uuid,
  p_actor_kind text,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_visibility text;
BEGIN
  IF p_workspace_id IS NULL OR p_actor_id IS NULL OR p_actor_kind NOT IN ('user', 'agent') THEN
    RETURN false;
  END IF;

  IF p_actor_kind = 'user' THEN
    IF NOT swarm.is_member(p_workspace_id, p_actor_id) THEN
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
  END IF;

  IF p_channel_id IS NULL THEN
    RETURN true;
  END IF;

  SELECT c.visibility INTO v_visibility
  FROM swarm.channels c
  WHERE c.workspace_id = p_workspace_id AND c.channel_id = p_channel_id;

  IF v_visibility IS NULL THEN
    RETURN false;
  END IF;
  IF v_visibility = 'open' THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM swarm.channel_members m
    WHERE m.workspace_id = p_workspace_id
      AND m.channel_id = p_channel_id
      AND (
        (p_actor_kind = 'user' AND m.member_kind = 'user' AND m.user_id = p_actor_id)
        OR (p_actor_kind = 'agent' AND m.member_kind = 'agent' AND m.agent_principal_id = p_actor_id)
      )
  );
END;
$$;

ALTER FUNCTION swarm.actor_can_access_channel(uuid, uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.actor_can_access_channel(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.actor_can_access_channel(uuid, uuid, text, uuid) TO swarm_command;

-- Evaluates channel access from PostgREST / read-edge request.jwt.claims.
-- CRITICAL: agent paths install both sub (owner_user_id) and agent_principal_id, so
-- agent_principal_id MUST be checked first (never falling back to sub).
CREATE OR REPLACE FUNCTION swarm.claims_can_access_channel(
  p_workspace_id uuid,
  p_channel_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user uuid;
  v_agent uuid;
BEGIN
  IF p_workspace_id IS NULL OR claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
    OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_user := (claims->>'sub')::uuid;
  IF NOT swarm.is_member(p_workspace_id, v_user) THEN
    RETURN false;
  END IF;
  IF claims ? 'agent_principal_id' THEN
    IF coalesce(claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    v_agent := (claims->>'agent_principal_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM swarm.agent_principals p
      WHERE p.principal_id = v_agent AND p.owner_user_id = v_user AND p.revoked_at IS NULL
    ) THEN
      RETURN false;
    END IF;
    RETURN swarm.actor_can_access_channel(p_workspace_id, p_channel_id, 'agent', v_agent);
  END IF;
  RETURN swarm.actor_can_access_channel(p_workspace_id, p_channel_id, 'user', v_user);
END;
$$;

ALTER FUNCTION swarm.claims_can_access_channel(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.claims_can_access_channel(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.claims_can_access_channel(uuid, uuid)
  TO authenticated, swarm_read;

-- Append visibility at the end of swarm_read.channels and gate private channels.
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
    c.sort_rank,
    c.visibility
  FROM swarm.channels AS c
  WHERE swarm.is_member(c.workspace_id, auth.uid())
    AND swarm.claims_can_access_channel(c.workspace_id, c.channel_id);

ALTER VIEW swarm_read.channels OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.channels TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.channels FROM PUBLIC, anon;

-- Members of a private channel can read its live membership list; non-members see zero rows.
-- Inline live-member verification on the owner-backed tables so swarm.actor_can_access_channel
-- remains strictly swarm_command-only.
CREATE VIEW swarm_read.channel_members
WITH (security_barrier = true)
AS
  SELECT
    m.channel_id,
    m.workspace_id,
    m.member_kind AS kind,
    COALESCE(m.user_id, m.agent_principal_id) AS id,
    m.added_by_principal,
    m.added_by_kind,
    m.created_at
  FROM swarm.channel_members AS m
  WHERE swarm.is_member(m.workspace_id, auth.uid())
    AND swarm.claims_can_access_channel(m.workspace_id, m.channel_id)
    AND (
      (
        m.member_kind = 'user'
        AND EXISTS (
          SELECT 1 FROM swarm.memberships AS mem
          WHERE mem.workspace_id = m.workspace_id
            AND mem.user_id = m.user_id
            AND mem.revoked_at IS NULL
        )
      )
      OR (
        m.member_kind = 'agent'
        AND EXISTS (
          SELECT 1
          FROM swarm.agent_principals AS p
          JOIN swarm.memberships AS owner_m
            ON owner_m.workspace_id = m.workspace_id
           AND owner_m.user_id = p.owner_user_id
           AND owner_m.revoked_at IS NULL
          WHERE p.principal_id = m.agent_principal_id
            AND p.revoked_at IS NULL
            AND (
              EXISTS (
                SELECT 1 FROM swarm.agent_workspace_memberships AS am
                WHERE am.principal_id = p.principal_id
                  AND am.workspace_id = m.workspace_id
                  AND am.owner_user_id = p.owner_user_id
                  AND am.revoked_at IS NULL
              )
              OR (
                p.workspace_id = m.workspace_id
                AND NOT EXISTS (
                  SELECT 1 FROM swarm.agent_workspace_memberships AS any_am
                  WHERE any_am.principal_id = p.principal_id
                    AND any_am.workspace_id = m.workspace_id
                )
              )
            )
        )
      )
    );

ALTER VIEW swarm_read.channel_members OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.channel_members FROM PUBLIC, anon, swarm_command;
GRANT SELECT ON swarm_read.channel_members TO authenticated, swarm_read;

-- Personal preferences hide rows for private channels the viewer can no longer access.
CREATE OR REPLACE VIEW swarm_read.channel_preferences
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
    AND swarm.is_member(p.workspace_id, auth.uid())
    AND swarm.claims_can_access_channel(p.workspace_id, p.channel_id);

ALTER VIEW swarm_read.channel_preferences OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.channel_preferences FROM PUBLIC, anon, swarm_read, swarm_command;
GRANT SELECT ON swarm_read.channel_preferences TO authenticated;

-- Register the private-channel gate marker in assert_view_clauses_preserved before recreating
-- swarm_read.signals, matching 20260905000010.
CREATE OR REPLACE FUNCTION swarm.assert_view_clauses_preserved(
  p_view text,
  p_before text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  after_def text;
  marker text;
  markers text[] := ARRAY[
    'is_member',
    'to_user_id = auth.uid()',
    'to_agent_principal_id IS NULL',
    'owner_user_id = auth.uid()',
    'recipient_user_id = auth.uid()',
    'from_principal = auth.uid()',
    'claims_can_access_channel'
  ];
BEGIN
  after_def := pg_get_viewdef(p_view::regclass, true);
  FOREACH marker IN ARRAY markers LOOP
    IF position(marker IN p_before) > 0 AND position(marker IN after_def) = 0 THEN
      RAISE EXCEPTION
        'view % lost the authorization fragment "%" during recreation; resolve the starting body with pg_get_viewdef against this database, not from a migration file',
        p_view, marker;
    END IF;
  END LOOP;
END;
$$;
ALTER FUNCTION swarm.assert_view_clauses_preserved(text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.assert_view_clauses_preserved(text, text) FROM PUBLIC;

-- Dynamically narrow swarm_read.signals so any signal filed in a private channel is readable
-- ONLY when swarm.claims_can_access_channel(s.workspace_id, s.channel_id) holds.
SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text := current_setting('swarm.signals_view_before');
  tagged text;
  head text;
  tail text;
  tagged_where text;
  alias_and_where text;
  predicate text;
  body text;
BEGIN
  IF position('claims_can_access_channel' IN live_def) > 0 THEN
    RAISE EXCEPTION 'swarm_read.signals already carries claims_can_access_channel';
  END IF;

  tagged := regexp_replace(
    live_def,
    '(\sFROM\s+(?:swarm\.)?signals\s)',
    '\1@@SWARM_SPLIT@@'
  );
  IF split_part(tagged, '@@SWARM_SPLIT@@', 2) = ''
     OR split_part(tagged, '@@SWARM_SPLIT@@', 3) <> '' THEN
    RAISE EXCEPTION
      'expected exactly one top-level FROM swarm.signals in the live body; recreate swarm_read.signals by hand';
  END IF;
  head := split_part(tagged, '@@SWARM_SPLIT@@', 1);
  tail := split_part(tagged, '@@SWARM_SPLIT@@', 2);

  tagged_where := regexp_replace(tail, '\sWHERE\s', ' WHERE @@SWARM_WHERE@@ ');
  IF tagged_where = tail THEN
    RAISE EXCEPTION
      'the live swarm_read.signals body has no top-level WHERE';
  END IF;
  alias_and_where := split_part(tagged_where, '@@SWARM_WHERE@@', 1);
  predicate := rtrim(split_part(tagged_where, '@@SWARM_WHERE@@', 2), E' ;\n\t');

  body := head || alias_and_where || '(' || predicate
    || ') AND (s.channel_id IS NULL OR swarm.claims_can_access_channel(s.workspace_id, s.channel_id))';

  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM PUBLIC, anon;

SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals',
  current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);

DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF position('claims_can_access_channel' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals recreation did not add claims_can_access_channel';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(after_def, '\sFROM\s+(swarm\.)?signals\s', 'g')) <> 1 THEN
    RAISE EXCEPTION
      'swarm_read.signals now has more than one FROM swarm.signals boundary; the next migration cannot splice it';
  END IF;
END;
$$;

-- Mention metadata on private-channel signals is readable only to members of that channel.
CREATE OR REPLACE VIEW swarm_read.signal_mentions
WITH (security_barrier = true)
AS
  SELECT
    m.signal_id,
    m.workspace_id,
    m.position,
    CASE WHEN m.mentioned_user_id IS NOT NULL THEN 'user' ELSE 'agent' END AS kind,
    COALESCE(m.mentioned_user_id, m.mentioned_agent_principal_id) AS id,
    m.source
  FROM swarm.signal_mentions AS m
  JOIN swarm.signals AS s
    ON s.id = m.signal_id
   AND s.workspace_id = m.workspace_id
  WHERE swarm.claims_can_access_channel(s.workspace_id, s.channel_id);

ALTER VIEW swarm_read.signal_mentions OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signal_mentions TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signal_mentions FROM PUBLIC, anon;

-- Per-channel unread + personal preferences for the signed-in person, omitting private channels
-- where the viewer is not a member.
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
     'visibility', c.visibility,
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
   AND p.target_key = coalesce(c.channel_id::text, 'general')));
END;
$$;
ALTER FUNCTION swarm_read.channel_unread(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.channel_unread(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.channel_unread(uuid) TO authenticated;

-- Agent channel_messages: refuses inaccessible private channels with channel_not_found
-- (indistinguishable from an unknown slug, disclosing neither existence nor archived state).
CREATE OR REPLACE FUNCTION swarm_read.channel_messages(
  p_workspace_id uuid, p_channel text, p_after_id uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 caller uuid;
 caller_agent uuid;
 actor_kind text := 'user';
 actor_id uuid;
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
 actor_id := caller;
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
  actor_kind := 'agent';
  actor_id := caller_agent;
 END IF;

 IF p_channel IS NULL THEN RETURN NULL; END IF;
 IF NOT is_general THEN
  SELECT c.channel_id, c.archived_at INTO target_channel, target_archived
  FROM swarm.channels c
  WHERE c.workspace_id = p_workspace_id AND lower(c.slug) = lower(p_channel);
  IF target_channel IS NULL
    OR NOT swarm.actor_can_access_channel(p_workspace_id, target_channel, actor_kind, actor_id) THEN
   RETURN jsonb_build_object('error', 'channel_not_found');
  END IF;
 END IF;
 IF p_after_id IS NOT NULL THEN
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
   'body', m.body,
   'created_at', m.created_at,
   'until', m.until,
   'thread_root_id', m.thread_root_id,
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
GRANT EXECUTE ON FUNCTION swarm_read.channel_messages(uuid, text, uuid, integer) TO swarm_read;

-- Agent read-position advance and per-channel unread respect private-channel membership.
CREATE OR REPLACE FUNCTION swarm.agent_channel_read_advance(p_workspace_id uuid, p_channel text, p_through_id uuid)
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
  IF target_channel IS NULL
    OR NOT swarm.actor_can_access_channel(p_workspace_id, target_channel, 'agent', reader) THEN
   RETURN;
  END IF;
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

CREATE OR REPLACE FUNCTION swarm_read.agent_channel_unread(p_workspace_id uuid) RETURNS jsonb
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
   SELECT ch.channel_id, ch.slug, false FROM swarm.channels ch
   WHERE ch.workspace_id = p_workspace_id
     AND swarm.actor_can_access_channel(p_workspace_id, ch.channel_id, 'agent', reader)
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

-- Database-level wake defense-in-depth: neither scalar recipients, recipient rows, nor mentions
-- wake an agent for a signal in a private channel where that agent is not a member.
CREATE OR REPLACE FUNCTION swarm.agent_delivery_is_wakeable(
  p_signal_id uuid,
  p_workspace_id uuid,
  p_agent_principal_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM swarm.signals AS s
    JOIN swarm.agent_principals AS recipient
      ON recipient.principal_id = p_agent_principal_id
    JOIN swarm.agent_workspace_memberships AS seat
      ON seat.principal_id = recipient.principal_id
     AND seat.workspace_id = s.workspace_id
    WHERE s.id = p_signal_id
      AND s.workspace_id = p_workspace_id
      AND s.kind IN ('ask', 'note')
      AND s.until > statement_timestamp()
      AND recipient.revoked_at IS NULL
      AND seat.revoked_at IS NULL
      AND (
        s.channel_id IS NULL
        OR swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'agent', p_agent_principal_id)
      )
  );
$$;

ALTER FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_is_wakeable(uuid, uuid, uuid) TO swarm_command;

-- Delivery receipts & broadcast rosters: refuse private-channel signals to non-members, and
-- narrow broadcast_roster.members + broadcast_roster.agents to channel members when private.
CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts_without_main_queue_count(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_claims jsonb := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_human_user_id uuid := NULLIF(v_claims ->> 'sub', '')::uuid;
  v_author_kind text;
  v_author_id uuid;
  v_agent_principal_id uuid;
  v_agent_workspace_id uuid;
  v_agent_revoked boolean;
  v_to_user_id uuid;
  v_to_agent_principal_id uuid;
  v_channel_id uuid;
  v_addressed boolean;
  v_receipts jsonb;
  v_agent_principals jsonb;
  v_member_total bigint;
  v_member_seen_total bigint;
  v_member_returned bigint;
  v_agent_total bigint;
  v_agent_returned bigint;
  v_roster_limit constant integer := 50;
BEGIN
  IF v_human_user_id IS NOT NULL THEN
    IF p_agent_token_hash IS NOT NULL
       OR (v_claims ? 'agent_principal_id')
       OR NOT swarm.is_member(p_workspace_id, v_human_user_id)
    THEN
      RETURN NULL;
    END IF;
  ELSE
    IF p_agent_token_hash IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT
      context.principal_id,
      context.principal_workspace_id,
      context.is_revoked
    INTO
      v_agent_principal_id,
      v_agent_workspace_id,
      v_agent_revoked
    FROM swarm.agent_delivery_read_context(
      p_agent_token_hash,
      p_workspace_id
    ) AS context
    LIMIT 1;

    IF v_agent_principal_id IS NULL
       OR v_agent_revoked
       OR v_agent_workspace_id <> p_workspace_id
    THEN
      RETURN NULL;
    END IF;
    v_author_kind := 'agent';
    v_author_id := v_agent_principal_id;
  END IF;

  SELECT signal.to_user_id, signal.to_agent_principal_id, signal.channel_id
  INTO v_to_user_id, v_to_agent_principal_id, v_channel_id
  FROM swarm.signals AS signal
  WHERE signal.id = p_signal_id
    AND signal.workspace_id = p_workspace_id
    AND (
      (
        v_human_user_id IS NOT NULL
        AND swarm.actor_can_access_channel(p_workspace_id, signal.channel_id, 'user', v_human_user_id)
      )
      OR (
        v_human_user_id IS NULL
        AND signal.from_kind = v_author_kind
        AND signal.from_principal = v_author_id
        AND swarm.actor_can_access_channel(p_workspace_id, signal.channel_id, 'agent', v_author_id)
      )
    );

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_addressed := v_to_user_id IS NOT NULL OR v_to_agent_principal_id IS NOT NULL;

  IF NOT v_addressed THEN
    SELECT
      count(*),
      count(human.first_seen_at)
    INTO v_member_total, v_member_seen_total
    FROM swarm.memberships AS membership
    JOIN swarm.users AS member_user
      ON member_user.user_id = membership.user_id
    LEFT JOIN swarm.signal_human_receipts AS human
      ON human.workspace_id = membership.workspace_id
     AND human.signal_id = p_signal_id
     AND human.user_id = membership.user_id
    WHERE membership.workspace_id = p_workspace_id
      AND membership.revoked_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'user', membership.user_id);

    SELECT count(*)
    INTO v_agent_total
    FROM swarm.agent_principals AS principal
    JOIN swarm.memberships AS owner_membership
      ON owner_membership.workspace_id = principal.workspace_id
     AND owner_membership.user_id = principal.owner_user_id
     AND owner_membership.revoked_at IS NULL
    WHERE principal.workspace_id = p_workspace_id
      AND principal.revoked_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id);

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'recipient_user_id', member.user_id,
            'display_name', member.display_name,
            'seen_at', member.first_seen_at
          )
          ORDER BY
            member.first_seen_at IS NULL,
            lower(member.display_name),
            member.user_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_receipts, v_member_returned
    FROM (
      SELECT
        membership.user_id,
        member_user.display_name,
        human.first_seen_at
      FROM swarm.memberships AS membership
      JOIN swarm.users AS member_user
        ON member_user.user_id = membership.user_id
      LEFT JOIN swarm.signal_human_receipts AS human
        ON human.workspace_id = membership.workspace_id
       AND human.signal_id = p_signal_id
       AND human.user_id = membership.user_id
      WHERE membership.workspace_id = p_workspace_id
        AND membership.revoked_at IS NULL
        AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'user', membership.user_id)
      ORDER BY
        human.first_seen_at IS NULL,
        lower(member_user.display_name),
        membership.user_id
      LIMIT v_roster_limit
    ) AS member;

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'recipient_agent_principal_id', agent.principal_id,
            'display_name', agent.name,
            'tracking_state', 'not_tracked',
            'observed_at', NULL
          )
          ORDER BY lower(agent.name), agent.principal_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_agent_principals, v_agent_returned
    FROM (
      SELECT principal.principal_id, principal.name
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = principal.workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      WHERE principal.workspace_id = p_workspace_id
        AND principal.revoked_at IS NULL
        AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id)
      ORDER BY lower(principal.name), principal.principal_id
      LIMIT v_roster_limit
    ) AS agent;

    RETURN jsonb_build_object(
      'addressed', false,
      'receipts', v_receipts,
      'broadcast_roster', jsonb_build_object(
        'members', jsonb_build_object(
          'total', v_member_total,
          'seen', v_member_seen_total,
          'returned', v_member_returned,
          'limit', v_roster_limit,
          'truncated', v_member_total > v_member_returned
        ),
        'agents', jsonb_build_object(
          'total', v_agent_total,
          'returned', v_agent_returned,
          'limit', v_roster_limit,
          'truncated', v_agent_total > v_agent_returned,
          'tracking_state', 'not_tracked',
          'principals', v_agent_principals
        )
      )
    );
  END IF;

  SELECT COALESCE(jsonb_agg(row.receipt ORDER BY row.sort_key), '[]'::jsonb)
  INTO v_receipts
  FROM (
    SELECT
      'agent:' || delivery.recipient_agent_principal_id::text AS sort_key,
      jsonb_build_object(
        'recipient_agent_principal_id', delivery.recipient_agent_principal_id,
        'enqueued_at', delivery.enqueued_at,
        'delivered_at', delivery.delivered_at,
        'leased_until', delivery.leased_until,
        'acked_at', delivery.acked_at,
        'ack_outcome', delivery.ack_outcome,
        'attempt_count', delivery.attempt_count,
        'lease_expiry_count', delivery.lease_expiry_count,
        'last_error_code', delivery.last_error_code
      ) AS receipt
    FROM swarm.signal_deliveries AS delivery
    WHERE delivery.signal_id = p_signal_id
      AND delivery.workspace_id = p_workspace_id

    UNION ALL

    SELECT
      'human:' || target.user_id::text AS sort_key,
      jsonb_build_object(
        'recipient_user_id', target.user_id,
        'seen_at', human.first_seen_at
      ) AS receipt
    FROM (SELECT v_to_user_id AS user_id) AS target
    LEFT JOIN swarm.signal_human_receipts AS human
      ON human.workspace_id = p_workspace_id
     AND human.signal_id = p_signal_id
     AND human.user_id = target.user_id
    WHERE target.user_id IS NOT NULL
  ) AS row;

  RETURN jsonb_build_object(
    'addressed', true,
    'receipts', v_receipts
  );
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts_without_main_queue_count(uuid, uuid, bytea)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts_without_main_queue_count(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_result jsonb;
  v_receipts jsonb;
  v_channel_id uuid;
  v_agent_principals jsonb;
  v_agent_total bigint;
  v_agent_seen_total bigint;
  v_agent_returned bigint;
  v_roster_limit constant integer := 50;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_main_queue_count(
    p_workspace_id,
    p_signal_id,
    p_agent_token_hash
  );
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.channel_id INTO v_channel_id
  FROM swarm.signals AS s
  WHERE s.workspace_id = p_workspace_id AND s.id = p_signal_id;

  IF v_result ->> 'addressed' = 'false' THEN
    SELECT count(*), count(agent_receipt.first_seen_at)
    INTO v_agent_total, v_agent_seen_total
    FROM swarm.agent_principals AS principal
    JOIN swarm.memberships AS owner_membership
      ON owner_membership.workspace_id = principal.workspace_id
     AND owner_membership.user_id = principal.owner_user_id
     AND owner_membership.revoked_at IS NULL
    LEFT JOIN swarm.signal_agent_receipts AS agent_receipt
      ON agent_receipt.workspace_id = principal.workspace_id
     AND agent_receipt.signal_id = p_signal_id
     AND agent_receipt.principal_id = principal.principal_id
    WHERE principal.workspace_id = p_workspace_id
      AND principal.revoked_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id);

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'principal_id', agent.principal_id,
            'recipient_agent_principal_id', agent.principal_id,
            'display_name', agent.name,
            'seen_at', agent.first_seen_at,
            'tracking_state', 'not_tracked',
            'observed_at', NULL
          )
          ORDER BY
            agent.first_seen_at IS NULL,
            lower(agent.name),
            agent.principal_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_agent_principals, v_agent_returned
    FROM (
      SELECT principal.principal_id, principal.name, agent_receipt.first_seen_at
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = principal.workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      LEFT JOIN swarm.signal_agent_receipts AS agent_receipt
        ON agent_receipt.workspace_id = principal.workspace_id
       AND agent_receipt.signal_id = p_signal_id
       AND agent_receipt.principal_id = principal.principal_id
      WHERE principal.workspace_id = p_workspace_id
        AND principal.revoked_at IS NULL
        AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id)
      ORDER BY
        agent_receipt.first_seen_at IS NULL,
        lower(principal.name),
        principal.principal_id
      LIMIT v_roster_limit
    ) AS agent;

    v_result := jsonb_set(
      v_result,
      '{broadcast_roster,agents}',
      jsonb_build_object(
        'total', v_agent_total,
        'seen', v_agent_seen_total,
        'returned', v_agent_returned,
        'limit', v_roster_limit,
        'truncated', v_agent_total > v_agent_returned,
        'tracking_state', 'not_tracked',
        'principals', v_agent_principals
      ),
      false
    );
    RETURN v_result;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN receipt.value ? 'recipient_agent_principal_id'
             AND receipt.value ->> 'ack_outcome' = 'queued'
        THEN receipt.value || jsonb_build_object(
          'pending_for_main_count',
          (
            SELECT count(*)
            FROM swarm.signal_deliveries AS pending
            WHERE pending.workspace_id = p_workspace_id
              AND pending.recipient_agent_principal_id =
                (receipt.value ->> 'recipient_agent_principal_id')::uuid
              AND pending.ack_outcome = 'queued'
          )
        )
        ELSE receipt.value
      END
      ORDER BY receipt.ordinality
    ),
    '[]'::jsonb
  )
  INTO v_receipts
  FROM jsonb_array_elements(v_result -> 'receipts')
    WITH ORDINALITY AS receipt(value, ordinality);

  RETURN jsonb_set(v_result, '{receipts}', v_receipts, false);
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(uuid, uuid, bytea)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 14. Hosted MCP check batch guard: enforce private-channel membership on recorded batch ids.
CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_batches_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_ordered_ids uuid[];
  v_terminal_created_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(s.id ORDER BY date_trunc('milliseconds', s.created_at), s.id),
           max(date_trunc('milliseconds', s.created_at)) FILTER (
             WHERE s.id = NEW.terminal_signal_id
           )
    INTO v_ordered_ids, v_terminal_created_at
    FROM unnest(NEW.signal_ids) AS requested(signal_id)
    JOIN swarm.signals AS s ON s.id = requested.signal_id
    WHERE s.workspace_id = NEW.workspace_id
      AND (
        s.channel_id IS NULL
        OR swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'agent', NEW.principal_id)
      )
      AND (
        s.to_agent_principal_id = NEW.principal_id
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_recipients AS recipient
          WHERE recipient.workspace_id = s.workspace_id
            AND recipient.signal_id = s.id
            AND recipient.recipient_agent_principal_id = NEW.principal_id
        )
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_mentions AS mention
          WHERE mention.workspace_id = s.workspace_id
            AND mention.signal_id = s.id
            AND mention.mentioned_agent_principal_id = NEW.principal_id
        )
      );
    IF v_ordered_ids IS DISTINCT FROM NEW.signal_ids
       OR cardinality(v_ordered_ids) <> cardinality(NEW.signal_ids)
       OR (SELECT count(DISTINCT signal_id)
           FROM unnest(NEW.signal_ids) AS distinct_ids(signal_id)) <>
          cardinality(NEW.signal_ids)
       OR v_terminal_created_at IS DISTINCT FROM NEW.terminal_created_at
    THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.signal_ids IS DISTINCT FROM OLD.signal_ids
     OR NEW.terminal_created_at IS DISTINCT FROM OLD.terminal_created_at
     OR NEW.terminal_signal_id IS DISTINCT FROM OLD.terminal_signal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.acknowledged_at IS NOT NULL
     OR NEW.acknowledged_at IS NULL
  THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

