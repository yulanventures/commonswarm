-- Conversations, step 2b of 6: read model (conversations, conversation_history, human-only
-- agent oversight list/history) and DM/group-DM thread reply support.
--
-- Security invariants (Conversations V4 C1-C4):
--   1. Member reads (`swarm_read.conversations`, `swarm_read.conversation_history`) serve ONLY the
--      calling live human or local agent seat (`swarm.conversation_read_actor`). They NEVER include
--      agent oversight, left private channels, or left group DMs.
--   2. Placement and audience stay independent: a reader must satisfy BOTH conversation visibility
--      (`swarm.conversation_target`) AND per-message audience (`swarm.conversation_signal_visible_to`).
--      Unknown, left, and inaccessible conversation IDs all return NULL so the read edge returns
--      one uniform 404 conversation_not_found (no existence oracle).
--   3. Dedicated human-only oversight (`swarm_read.conversation_oversight`,
--      `swarm_read.conversation_oversight_history`) binds BOTH gates (live agent membership AND
--      per-message audience) to ONE currently owned live agent with a live seat in the workspace.
--      Scoped to dm / group_dm only (preserving #433 private-channel privacy). Denied if the human
--      has `left_at IS NOT NULL` on that conversation. Never leaks into member reads, unread,
--      receipts, delivery, wake, or Realtime.
--   4. DM/group-DM thread replies: `swarm.conversation_check_route` and
--      `swarm.file_conversation_signal` permit `thread_root_id` on prefiled dm/group_dm posts ONLY
--      when `broadcast_to_channel` is false and `thread_root_id` references a top-level message
--      filed in the exact same conversation (preserving 1-level-deep threads and live-member routing).
--
-- Rollback: deploy/release-proofs/conversations-2b/20261120000001-rollback.sql (backup first).
SET search_path = swarm, pg_catalog, public;

-- ---------------------------------------------------------------------------------------------------
-- 1. Actor claim verification & per-message audience gate (internal, swarm_admin only).

CREATE FUNCTION swarm.conversation_read_actor(
  p_workspace_id uuid,
  OUT actor_kind text,
  OUT actor_id uuid,
  OUT owner_user_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user uuid;
  v_agent uuid;
BEGIN
  IF p_workspace_id IS NULL OR v_claims IS NULL
    OR v_claims->>'role' IS DISTINCT FROM 'authenticated'
    OR coalesce(v_claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  v_user := (v_claims->>'sub')::uuid;
  IF v_claims ? 'agent_principal_id' THEN
    IF coalesce(v_claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN;
    END IF;
    v_agent := (v_claims->>'agent_principal_id')::uuid;
    IF NOT EXISTS (
      SELECT 1
      FROM swarm.agent_principals AS p
      JOIN swarm.agent_workspace_memberships AS am
        ON am.principal_id = p.principal_id
       AND am.workspace_id = p_workspace_id
       AND am.owner_user_id = p.owner_user_id
       AND am.revoked_at IS NULL
      WHERE p.principal_id = v_agent
        AND p.owner_user_id = v_user
        AND p.revoked_at IS NULL
    ) THEN
      RETURN;
    END IF;
    IF NOT swarm.actor_can_access_channel(p_workspace_id, NULL, 'user', v_user)
      OR NOT swarm.actor_can_access_channel(p_workspace_id, NULL, 'agent', v_agent) THEN
      RETURN;
    END IF;
    actor_kind := 'agent';
    actor_id := v_agent;
    owner_user_id := v_user;
    RETURN;
  END IF;
  IF NOT swarm.actor_can_access_channel(p_workspace_id, NULL, 'user', v_user) THEN
    RETURN;
  END IF;
  actor_kind := 'user';
  actor_id := v_user;
  owner_user_id := v_user;
END;
$$;

-- Verified human-only oversight actor check (V4 C2): caller must be a live human member of the
-- workspace (no agent_principal_id claim), and p_agent_principal_id must be owned by that human,
-- unrevoked, with a live seat in p_workspace_id.
CREATE FUNCTION swarm.conversation_oversight_actor(
  p_workspace_id uuid,
  p_agent_principal_id uuid,
  OUT human_user_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_agent_principal_id IS NULL OR v_claims IS NULL
    OR v_claims->>'role' IS DISTINCT FROM 'authenticated'
    OR v_claims ? 'agent_principal_id'
    OR coalesce(v_claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  v_user := (v_claims->>'sub')::uuid;
  IF NOT swarm.actor_can_access_channel(p_workspace_id, NULL, 'user', v_user) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.agent_principals AS p
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id
     AND am.workspace_id = p_workspace_id
     AND am.owner_user_id = p.owner_user_id
     AND am.revoked_at IS NULL
    WHERE p.principal_id = p_agent_principal_id
      AND p.owner_user_id = v_user
      AND p.revoked_at IS NULL
  ) THEN
    RETURN;
  END IF;
  IF NOT swarm.actor_can_access_channel(p_workspace_id, NULL, 'agent', p_agent_principal_id) THEN
    RETURN;
  END IF;
  human_user_id := v_user;
END;
$$;

-- Per-message audience predicate for ONE exact actor (never falls back to agent owner; total boolean, never NULL).
CREATE FUNCTION swarm.conversation_signal_visible_to(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_audience text,
  p_from_kind text,
  p_from_principal uuid,
  p_to_user_id uuid,
  p_to_agent_principal_id uuid,
  p_actor_kind text,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    CASE
      WHEN p_audience = 'conversation' THEN true
      WHEN p_audience = 'addressed' AND p_actor_kind IS NOT NULL AND p_actor_id IS NOT NULL THEN
        COALESCE(p_from_kind = p_actor_kind AND p_from_principal = p_actor_id, false)
        OR (
          p_actor_kind = 'user' AND (
            COALESCE(p_to_user_id = p_actor_id, false)
            OR EXISTS (
              SELECT 1 FROM swarm.signal_recipients AS sr
              WHERE sr.workspace_id = p_workspace_id
                AND sr.signal_id = p_signal_id
                AND sr.recipient_user_id = p_actor_id
            )
          )
        )
        OR (
          p_actor_kind = 'agent' AND (
            COALESCE(p_to_agent_principal_id = p_actor_id, false)
            OR EXISTS (
              SELECT 1 FROM swarm.signal_recipients AS sr
              WHERE sr.workspace_id = p_workspace_id
                AND sr.signal_id = p_signal_id
                AND sr.recipient_agent_principal_id = p_actor_id
            )
          )
        )
      ELSE false
    END,
    false
  )
$$;

-- ---------------------------------------------------------------------------------------------------
-- 2. Summary & message JSON builders (internal, swarm_admin only).

CREATE FUNCTION swarm.conversation_members_json(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_kind text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_kind = 'private_channel' THEN
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'kind', cm.member_kind,
            'id', COALESCE(cm.user_id, cm.agent_principal_id),
            'name', CASE WHEN cm.member_kind = 'user' THEN u.display_name ELSE ap.name END,
            'left_at', NULL
          ) ORDER BY cm.created_at, cm.member_kind DESC, COALESCE(cm.user_id, cm.agent_principal_id)
        )
        FROM swarm.channel_members AS cm
        LEFT JOIN swarm.users AS u ON u.user_id = cm.user_id
        LEFT JOIN swarm.agent_principals AS ap ON ap.principal_id = cm.agent_principal_id
        WHERE cm.workspace_id = p_workspace_id
          AND cm.channel_id = p_conversation_id
      ), '[]'::jsonb)
    WHEN p_kind IN ('dm', 'group_dm') THEN
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'kind', CASE WHEN m.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
            'id', COALESCE(m.member_user_id, m.member_agent_principal_id),
            'name', CASE WHEN m.member_user_id IS NOT NULL THEN u.display_name ELSE ap.name END,
            'left_at', m.left_at
          ) ORDER BY m.joined_at, (m.member_user_id IS NOT NULL) DESC, COALESCE(m.member_user_id, m.member_agent_principal_id)
        )
        FROM swarm.conversation_members AS m
        LEFT JOIN swarm.users AS u ON u.user_id = m.member_user_id
        LEFT JOIN swarm.agent_principals AS ap ON ap.principal_id = m.member_agent_principal_id
        WHERE m.conversation_id = p_conversation_id
          AND m.workspace_id = p_workspace_id
      ), '[]'::jsonb)
    ELSE
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'kind', CASE WHEN m.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
            'id', COALESCE(m.member_user_id, m.member_agent_principal_id),
            'name', CASE WHEN m.member_user_id IS NOT NULL THEN u.display_name ELSE ap.name END,
            'left_at', NULL
          ) ORDER BY m.joined_at, (m.member_user_id IS NOT NULL) DESC, COALESCE(m.member_user_id, m.member_agent_principal_id)
        )
        FROM swarm.conversation_members AS m
        LEFT JOIN swarm.users AS u ON u.user_id = m.member_user_id
        LEFT JOIN swarm.agent_principals AS ap ON ap.principal_id = m.member_agent_principal_id
        WHERE m.conversation_id = p_conversation_id
          AND m.workspace_id = p_workspace_id
          AND m.left_at IS NULL
      ), '[]'::jsonb)
  END
$$;

CREATE FUNCTION swarm.conversation_summary_json(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_oversight boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_conv record;
  v_mem record;
  v_pref record;
  v_read record;
  v_last record;
  v_joined boolean := false;
  v_notify text := 'everything';
  v_starred boolean := false;
  v_star_rank integer := NULL;
  v_unread integer := 0;
  v_mentions integer := 0;
  v_members jsonb;
BEGIN
  SELECT
    c.conversation_id,
    c.kind,
    c.channel_id,
    c.generation,
    COALESCE(ch.archived_at, c.archived_at) AS archived_at,
    CASE WHEN c.kind = 'general' THEN 'general' ELSE ch.slug END AS slug,
    ch.purpose AS description,
    ch.lead_mode,
    ch.lead_agent_principal_id
  INTO v_conv
  FROM swarm.conversations AS c
  LEFT JOIN swarm.channels AS ch
    ON ch.channel_id = c.channel_id
   AND ch.workspace_id = c.workspace_id
  WHERE c.conversation_id = p_conversation_id
    AND c.workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_members := swarm.conversation_members_json(p_workspace_id, p_conversation_id, v_conv.kind);

  SELECT cs.created_at, cs.signal_id
  INTO v_last
  FROM swarm.conversation_signals AS cs
  JOIN swarm.signals AS s
    ON s.id = cs.signal_id
   AND s.workspace_id = cs.workspace_id
  WHERE cs.conversation_id = p_conversation_id
    AND cs.workspace_id = p_workspace_id
    AND swarm.conversation_signal_visible_to(
      cs.workspace_id, cs.signal_id, cs.audience,
      s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
      p_actor_kind, p_actor_id
    )
  ORDER BY cs.created_at DESC, cs.signal_id DESC
  LIMIT 1;

  IF p_oversight THEN
    RETURN jsonb_build_object(
      'conversation_id', v_conv.conversation_id,
      'kind', v_conv.kind,
      'channel_id', v_conv.channel_id,
      'slug', v_conv.slug,
      'description', v_conv.description,
      'archived_at', v_conv.archived_at,
      'generation', v_conv.generation,
      'members', v_members,
      'last_message_at', v_last.created_at,
      'last_message_id', v_last.signal_id,
      'read_only', true
    );
  END IF;

  IF v_conv.kind = 'private_channel' THEN
    v_joined := true;
    IF p_actor_kind = 'user' THEN
      SELECT cp.involvement, cp.starred, cp.star_rank
      INTO v_pref
      FROM swarm.channel_preferences AS cp
      WHERE cp.workspace_id = p_workspace_id
        AND cp.user_id = p_actor_id
        AND cp.target_key = v_conv.channel_id::text;
      IF FOUND THEN
        v_notify := COALESCE(v_pref.involvement, 'everything');
        v_starred := COALESCE(v_pref.starred, false);
        v_star_rank := v_pref.star_rank;
      END IF;
    END IF;
  ELSE
    SELECT m.left_at IS NULL AS is_live, m.notify_level, m.starred, m.star_rank
    INTO v_mem
    FROM swarm.conversation_members AS m
    WHERE m.conversation_id = p_conversation_id
      AND m.workspace_id = p_workspace_id
      AND (
        (p_actor_kind = 'user' AND m.member_user_id = p_actor_id)
        OR (p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor_id)
      );
    IF FOUND AND v_mem.is_live THEN
      v_joined := true;
      v_notify := v_mem.notify_level;
      v_starred := v_mem.starred;
      v_star_rank := v_mem.star_rank;
    ELSIF v_conv.kind = 'general' THEN
      v_joined := true;
    ELSE
      v_joined := false;
    END IF;
  END IF;

  SELECT cr.read_through_at, cr.read_through_id
  INTO v_read
  FROM swarm.conversation_reads AS cr
  WHERE cr.conversation_id = p_conversation_id
    AND cr.workspace_id = p_workspace_id
    AND (
      (p_actor_kind = 'user' AND cr.member_user_id = p_actor_id)
      OR (p_actor_kind = 'agent' AND cr.member_agent_principal_id = p_actor_id)
    );

  IF v_joined THEN
    SELECT
      count(*) FILTER (
        WHERE s.thread_root_id IS NULL OR s.broadcast_to_channel = true
      )::integer,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM swarm.signal_mentions AS sm
          WHERE sm.workspace_id = cs.workspace_id
            AND sm.signal_id = cs.signal_id
            AND (
              (p_actor_kind = 'user' AND sm.mentioned_user_id = p_actor_id)
              OR (p_actor_kind = 'agent' AND sm.mentioned_agent_principal_id = p_actor_id)
            )
        )
      )::integer
    INTO v_unread, v_mentions
    FROM swarm.conversation_signals AS cs
    JOIN swarm.signals AS s
      ON s.id = cs.signal_id
     AND s.workspace_id = cs.workspace_id
    WHERE cs.conversation_id = p_conversation_id
      AND cs.workspace_id = p_workspace_id
      AND NOT (s.from_kind = p_actor_kind AND s.from_principal = p_actor_id)
      AND swarm.conversation_signal_visible_to(
        cs.workspace_id, cs.signal_id, cs.audience,
        s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
        p_actor_kind, p_actor_id
      )
      AND (
        v_read.read_through_at IS NULL
        OR cs.created_at > v_read.read_through_at
        OR (
          cs.created_at = v_read.read_through_at
          AND v_read.read_through_id IS NOT NULL
          AND cs.signal_id > v_read.read_through_id
        )
      );
  END IF;

  RETURN jsonb_build_object(
    'conversation_id', v_conv.conversation_id,
    'kind', v_conv.kind,
    'channel_id', v_conv.channel_id,
    'slug', v_conv.slug,
    'description', v_conv.description,
    'archived_at', v_conv.archived_at,
    'joined', v_joined,
    'generation', v_conv.generation,
    'lead_mode', v_conv.lead_mode,
    'lead_agent_principal_id', v_conv.lead_agent_principal_id,
    'members', v_members,
    'notify_level', v_notify,
    'starred', v_starred,
    'star_rank', v_star_rank,
    'read_through_at', v_read.read_through_at,
    'read_through_id', v_read.read_through_id,
    'unread_count', COALESCE(v_unread, 0),
    'mention_count', COALESCE(v_mentions, 0),
    'last_message_at', v_last.created_at,
    'last_message_id', v_last.signal_id
  );
END;
$$;

-- Shared paged history builder (used by both member history and oversight history, bound to ONE
-- exact actor at both conversation visibility and per-message audience).
CREATE FUNCTION swarm.conversation_history_page(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_oversight boolean,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_after_created_at timestamptz,
  p_after_id uuid,
  p_limit integer,
  p_include_mentions boolean,
  p_include_reactions boolean
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_use_before boolean := (p_before_created_at IS NOT NULL AND p_before_id IS NOT NULL);
  v_use_after boolean := (p_after_created_at IS NOT NULL AND p_after_id IS NOT NULL);
  v_summary jsonb;
  v_messages jsonb;
  v_has_more boolean := false;
  v_next_before jsonb := NULL;
  v_next_after jsonb := NULL;
  v_raw_count integer := 0;
BEGIN
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL)
    OR (p_after_created_at IS NULL) <> (p_after_id IS NULL)
    OR (v_use_before AND v_use_after) THEN
    RETURN NULL;
  END IF;

  v_summary := swarm.conversation_summary_json(
    p_workspace_id, p_conversation_id, p_actor_kind, p_actor_id, p_oversight
  );
  IF v_summary IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_use_after THEN
    WITH raw_page AS (
      SELECT
        cs.signal_id,
        cs.workspace_id,
        cs.created_at,
        cs.audience
      FROM swarm.conversation_signals AS cs
      JOIN swarm.signals AS s
        ON s.id = cs.signal_id
       AND s.workspace_id = cs.workspace_id
      WHERE cs.conversation_id = p_conversation_id
        AND cs.workspace_id = p_workspace_id
        AND swarm.conversation_signal_visible_to(
          cs.workspace_id, cs.signal_id, cs.audience,
          s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
          p_actor_kind, p_actor_id
        )
        AND (
          date_trunc('milliseconds', cs.created_at) > date_trunc('milliseconds', p_after_created_at)
          OR (
            date_trunc('milliseconds', cs.created_at) = date_trunc('milliseconds', p_after_created_at)
            AND cs.signal_id > p_after_id
          )
        )
      ORDER BY date_trunc('milliseconds', cs.created_at) ASC, cs.signal_id ASC
      LIMIT v_limit + 1
    ), sliced AS (
      SELECT *
      FROM raw_page
      ORDER BY date_trunc('milliseconds', created_at) ASC, signal_id ASC
      LIMIT v_limit
    )
    SELECT
      (SELECT count(*)::integer FROM raw_page),
      COALESCE(jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'mentions', CASE WHEN p_include_mentions THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'position', sm.position,
                'kind', CASE WHEN sm.mentioned_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                'id', COALESCE(sm.mentioned_user_id, sm.mentioned_agent_principal_id),
                'source', sm.source
              ) ORDER BY sm.position)
              FROM swarm.signal_mentions AS sm
              WHERE sm.workspace_id = s.workspace_id AND sm.signal_id = s.id
            ), '[]'::jsonb) END,
            'reactions', CASE WHEN p_include_reactions THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'emoji', g.emoji, 'count', g.count, 'actors', g.actors
              ) ORDER BY g.first_at, g.emoji)
              FROM (
                SELECT sr.emoji, count(*)::int AS count, min(sr.created_at) AS first_at,
                  jsonb_agg(jsonb_build_object(
                    'kind', CASE WHEN sr.actor_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                    'id', COALESCE(sr.actor_user_id, sr.actor_agent_principal_id)
                  ) ORDER BY sr.created_at, sr.reaction_id) AS actors
                FROM swarm.signal_reactions AS sr
                WHERE sr.workspace_id = s.workspace_id AND sr.signal_id = s.id
                GROUP BY sr.emoji
              ) AS g
            ), '[]'::jsonb) END
          )
        ) || jsonb_build_object(
          'id', s.id,
          'workspace_id', s.workspace_id,
          'from', s.from_principal,
          'from_kind', s.from_kind,
          'to', s.to_user_id,
          'to_agent', s.to_agent_principal_id,
          'in_reply_to', s.in_reply_to,
          'reply_status', s.reply_status,
          'about', s.about,
          'kind', s.kind,
          'body', s.body,
          'until', s.until,
          'created_at', s.created_at,
          'chain_hop', s.chain_hop,
          'attachments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'file_id', att.file_id,
              'version_n', att.version_n,
              'name', f.name,
              'content_type', fv.content_type,
              'size_bytes', fv.size_bytes::double precision
            ) ORDER BY att.position)
            FROM swarm.signal_attachments AS att
            JOIN swarm.files AS f ON f.file_id = att.file_id AND f.workspace_id = att.workspace_id
            JOIN swarm.file_versions AS fv
              ON fv.file_id = att.file_id AND fv.workspace_id = att.workspace_id AND fv.version_n = att.version_n
            WHERE att.signal_id = s.id AND att.workspace_id = s.workspace_id
          ), '[]'::jsonb),
          'channel_id', s.channel_id,
          'thread_root_id', s.thread_root_id,
          'broadcast_to_channel', s.broadcast_to_channel,
          'recipients', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'kind', CASE WHEN rc.recipient_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
              'id', COALESCE(rc.recipient_user_id, rc.recipient_agent_principal_id),
              'position', rc.position
            ) ORDER BY rc.position)
            FROM swarm.signal_recipients AS rc
            WHERE rc.signal_id = s.id AND rc.workspace_id = s.workspace_id
          ), CASE
            WHEN s.to_user_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'user', 'id', s.to_user_id, 'position', 0))
            WHEN s.to_agent_principal_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', s.to_agent_principal_id, 'position', 0))
            ELSE '[]'::jsonb
          END),
          'audience', sl.audience
        )
        ORDER BY date_trunc('milliseconds', sl.created_at) ASC, sl.signal_id ASC
      ), '[]'::jsonb),
      (SELECT jsonb_build_object('created_at', b.created_at, 'id', b.signal_id)
       FROM sliced AS b ORDER BY date_trunc('milliseconds', b.created_at) ASC, b.signal_id ASC LIMIT 1),
      (SELECT jsonb_build_object('created_at', a.created_at, 'id', a.signal_id)
       FROM sliced AS a ORDER BY date_trunc('milliseconds', a.created_at) DESC, a.signal_id DESC LIMIT 1)
    INTO v_raw_count, v_messages, v_next_before, v_next_after
    FROM sliced AS sl
    JOIN swarm.signals AS s ON s.id = sl.signal_id AND s.workspace_id = sl.workspace_id;
  ELSE
    WITH raw_page AS (
      SELECT
        cs.signal_id,
        cs.workspace_id,
        cs.created_at,
        cs.audience
      FROM swarm.conversation_signals AS cs
      JOIN swarm.signals AS s
        ON s.id = cs.signal_id
       AND s.workspace_id = cs.workspace_id
      WHERE cs.conversation_id = p_conversation_id
        AND cs.workspace_id = p_workspace_id
        AND swarm.conversation_signal_visible_to(
          cs.workspace_id, cs.signal_id, cs.audience,
          s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
          p_actor_kind, p_actor_id
        )
        AND (
          NOT v_use_before
          OR date_trunc('milliseconds', cs.created_at) < date_trunc('milliseconds', p_before_created_at)
          OR (
            date_trunc('milliseconds', cs.created_at) = date_trunc('milliseconds', p_before_created_at)
            AND cs.signal_id < p_before_id
          )
        )
      ORDER BY date_trunc('milliseconds', cs.created_at) DESC, cs.signal_id DESC
      LIMIT v_limit + 1
    ), sliced AS (
      SELECT *
      FROM raw_page
      ORDER BY date_trunc('milliseconds', created_at) DESC, signal_id DESC
      LIMIT v_limit
    )
    SELECT
      (SELECT count(*)::integer FROM raw_page),
      COALESCE(jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'mentions', CASE WHEN p_include_mentions THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'position', sm.position,
                'kind', CASE WHEN sm.mentioned_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                'id', COALESCE(sm.mentioned_user_id, sm.mentioned_agent_principal_id),
                'source', sm.source
              ) ORDER BY sm.position)
              FROM swarm.signal_mentions AS sm
              WHERE sm.workspace_id = s.workspace_id AND sm.signal_id = s.id
            ), '[]'::jsonb) END,
            'reactions', CASE WHEN p_include_reactions THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'emoji', g.emoji, 'count', g.count, 'actors', g.actors
              ) ORDER BY g.first_at, g.emoji)
              FROM (
                SELECT sr.emoji, count(*)::int AS count, min(sr.created_at) AS first_at,
                  jsonb_agg(jsonb_build_object(
                    'kind', CASE WHEN sr.actor_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                    'id', COALESCE(sr.actor_user_id, sr.actor_agent_principal_id)
                  ) ORDER BY sr.created_at, sr.reaction_id) AS actors
                FROM swarm.signal_reactions AS sr
                WHERE sr.workspace_id = s.workspace_id AND sr.signal_id = s.id
                GROUP BY sr.emoji
              ) AS g
            ), '[]'::jsonb) END
          )
        ) || jsonb_build_object(
          'id', s.id,
          'workspace_id', s.workspace_id,
          'from', s.from_principal,
          'from_kind', s.from_kind,
          'to', s.to_user_id,
          'to_agent', s.to_agent_principal_id,
          'in_reply_to', s.in_reply_to,
          'reply_status', s.reply_status,
          'about', s.about,
          'kind', s.kind,
          'body', s.body,
          'until', s.until,
          'created_at', s.created_at,
          'chain_hop', s.chain_hop,
          'attachments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'file_id', att.file_id,
              'version_n', att.version_n,
              'name', f.name,
              'content_type', fv.content_type,
              'size_bytes', fv.size_bytes::double precision
            ) ORDER BY att.position)
            FROM swarm.signal_attachments AS att
            JOIN swarm.files AS f ON f.file_id = att.file_id AND f.workspace_id = att.workspace_id
            JOIN swarm.file_versions AS fv
              ON fv.file_id = att.file_id AND fv.workspace_id = att.workspace_id AND fv.version_n = att.version_n
            WHERE att.signal_id = s.id AND att.workspace_id = s.workspace_id
          ), '[]'::jsonb),
          'channel_id', s.channel_id,
          'thread_root_id', s.thread_root_id,
          'broadcast_to_channel', s.broadcast_to_channel,
          'recipients', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'kind', CASE WHEN rc.recipient_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
              'id', COALESCE(rc.recipient_user_id, rc.recipient_agent_principal_id),
              'position', rc.position
            ) ORDER BY rc.position)
            FROM swarm.signal_recipients AS rc
            WHERE rc.signal_id = s.id AND rc.workspace_id = s.workspace_id
          ), CASE
            WHEN s.to_user_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'user', 'id', s.to_user_id, 'position', 0))
            WHEN s.to_agent_principal_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', s.to_agent_principal_id, 'position', 0))
            ELSE '[]'::jsonb
          END),
          'audience', sl.audience
        )
        ORDER BY date_trunc('milliseconds', sl.created_at) ASC, sl.signal_id ASC
      ), '[]'::jsonb),
      (SELECT jsonb_build_object('created_at', b.created_at, 'id', b.signal_id)
       FROM sliced AS b ORDER BY date_trunc('milliseconds', b.created_at) ASC, b.signal_id ASC LIMIT 1),
      (SELECT jsonb_build_object('created_at', a.created_at, 'id', a.signal_id)
       FROM sliced AS a ORDER BY date_trunc('milliseconds', a.created_at) DESC, a.signal_id DESC LIMIT 1)
    INTO v_raw_count, v_messages, v_next_before, v_next_after
    FROM sliced AS sl
    JOIN swarm.signals AS s ON s.id = sl.signal_id AND s.workspace_id = sl.workspace_id;
  END IF;

  v_has_more := COALESCE(v_raw_count, 0) > v_limit;
  RETURN jsonb_build_object(
    'conversation', v_summary,
    'messages', COALESCE(v_messages, '[]'::jsonb),
    'has_more', v_has_more,
    'next_before', v_next_before,
    'next_after', v_next_after
  );
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Public swarm_read entry points (granted ONLY to swarm_read; all claims verified internally).

CREATE FUNCTION swarm_read.conversations(
  p_workspace_id uuid,
  p_include_archived boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_actor record;
  v_rows jsonb;
BEGIN
  SELECT * INTO v_actor FROM swarm.conversation_read_actor(p_workspace_id);
  IF v_actor.actor_kind IS NULL THEN
    RETURN NULL;
  END IF;

  WITH visible AS MATERIALIZED (
    SELECT
      c.conversation_id,
      c.kind,
      COALESCE(ch.sort_rank, 0) AS sort_rank,
      CASE WHEN c.kind = 'general' THEN 'general' ELSE ch.slug END AS slug
    FROM swarm.conversations AS c
    LEFT JOIN swarm.channels AS ch
      ON ch.channel_id = c.channel_id
     AND ch.workspace_id = c.workspace_id
    WHERE c.workspace_id = p_workspace_id
      AND (COALESCE(p_include_archived, false) OR COALESCE(ch.archived_at, c.archived_at) IS NULL)
      AND (
        c.kind IN ('general', 'public_channel')
        OR (
          c.kind = 'private_channel'
          AND swarm.actor_can_access_channel(p_workspace_id, c.channel_id, v_actor.actor_kind, v_actor.actor_id)
        )
        OR (
          c.kind IN ('dm', 'group_dm')
          AND EXISTS (
            SELECT 1 FROM swarm.conversation_members AS m
            WHERE m.conversation_id = c.conversation_id
              AND m.workspace_id = p_workspace_id
              AND m.left_at IS NULL
              AND (
                (v_actor.actor_kind = 'user' AND m.member_user_id = v_actor.actor_id)
                OR (v_actor.actor_kind = 'agent' AND m.member_agent_principal_id = v_actor.actor_id)
              )
          )
        )
      )
  )
  SELECT COALESCE(jsonb_agg(item.summary ORDER BY
    CASE item.kind
      WHEN 'general' THEN 0
      WHEN 'public_channel' THEN 1
      WHEN 'private_channel' THEN 2
      ELSE 3
    END,
    item.sort_rank ASC,
    item.slug ASC NULLS LAST,
    item.last_at DESC NULLS LAST,
    item.conversation_id ASC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      v.conversation_id,
      v.kind,
      v.sort_rank,
      v.slug,
      (summary_row.s->>'last_message_at')::timestamptz AS last_at,
      summary_row.s AS summary
    FROM visible AS v
    CROSS JOIN LATERAL (
      SELECT swarm.conversation_summary_json(
        p_workspace_id, v.conversation_id, v_actor.actor_kind, v_actor.actor_id, false
      ) AS s
    ) AS summary_row
    WHERE summary_row.s IS NOT NULL
  ) AS item;

  RETURN jsonb_build_object('conversations', v_rows);
END;
$$;

CREATE FUNCTION swarm_read.conversation_history(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_include_mentions boolean DEFAULT false,
  p_include_reactions boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_actor record;
  v_target record;
BEGIN
  IF p_workspace_id IS NULL OR p_conversation_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_actor FROM swarm.conversation_read_actor(p_workspace_id);
  IF v_actor.actor_kind IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_target
  FROM swarm.conversation_target(p_workspace_id, v_actor.actor_kind, v_actor.actor_id, p_conversation_id);
  IF v_target.kind IS NULL OR NOT v_target.visible THEN
    RETURN NULL;
  END IF;
  RETURN swarm.conversation_history_page(
    p_workspace_id, p_conversation_id,
    v_actor.actor_kind, v_actor.actor_id, false,
    p_before_created_at, p_before_id,
    p_after_created_at, p_after_id,
    p_limit, COALESCE(p_include_mentions, false), COALESCE(p_include_reactions, false)
  );
END;
$$;

-- Dedicated human-only agent oversight list (V4 C2): dm / group_dm where the ONE owned live agent
-- is a live member AND the human owner does NOT have left_at set.
CREATE FUNCTION swarm_read.conversation_oversight(
  p_workspace_id uuid,
  p_agent_principal_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_human uuid;
  v_rows jsonb;
BEGIN
  SELECT human_user_id INTO v_human
  FROM swarm.conversation_oversight_actor(p_workspace_id, p_agent_principal_id);
  IF v_human IS NULL THEN
    RETURN NULL;
  END IF;

  WITH visible AS MATERIALIZED (
    SELECT c.conversation_id
    FROM swarm.conversations AS c
    JOIN swarm.conversation_members AS am
      ON am.conversation_id = c.conversation_id
     AND am.workspace_id = c.workspace_id
     AND am.member_agent_principal_id = p_agent_principal_id
     AND am.left_at IS NULL
    WHERE c.workspace_id = p_workspace_id
      AND c.kind IN ('dm', 'group_dm')
      AND NOT EXISTS (
        SELECT 1 FROM swarm.conversation_members AS hm
        WHERE hm.conversation_id = c.conversation_id
          AND hm.workspace_id = c.workspace_id
          AND hm.member_user_id = v_human
          AND hm.left_at IS NOT NULL
      )
  )
  SELECT COALESCE(jsonb_agg(item.summary ORDER BY item.last_at DESC NULLS LAST, item.conversation_id ASC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      v.conversation_id,
      (summary_row.s->>'last_message_at')::timestamptz AS last_at,
      summary_row.s AS summary
    FROM visible AS v
    CROSS JOIN LATERAL (
      SELECT swarm.conversation_summary_json(
        p_workspace_id, v.conversation_id, 'agent', p_agent_principal_id, true
      ) AS s
    ) AS summary_row
    WHERE summary_row.s IS NOT NULL
  ) AS item;

  RETURN jsonb_build_object('conversations', v_rows);
END;
$$;

-- Dedicated human-only agent oversight history (V4 C2): binds BOTH gates (conversation membership
-- AND per-message audience) to the exact same owned live agent p_agent_principal_id, and refuses
-- if the human has left_at set on that conversation.
CREATE FUNCTION swarm_read.conversation_oversight_history(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_agent_principal_id uuid,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_include_mentions boolean DEFAULT false,
  p_include_reactions boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  v_human uuid;
  v_target record;
BEGIN
  IF p_workspace_id IS NULL OR p_conversation_id IS NULL OR p_agent_principal_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT human_user_id INTO v_human
  FROM swarm.conversation_oversight_actor(p_workspace_id, p_agent_principal_id);
  IF v_human IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_target
  FROM swarm.conversation_target(p_workspace_id, 'agent', p_agent_principal_id, p_conversation_id);
  IF v_target.kind IS NULL OR v_target.kind NOT IN ('dm', 'group_dm')
    OR NOT v_target.visible OR v_target.member <> 'live' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm.conversation_members AS hm
    WHERE hm.conversation_id = p_conversation_id
      AND hm.workspace_id = p_workspace_id
      AND hm.member_user_id = v_human
      AND hm.left_at IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;
  RETURN swarm.conversation_history_page(
    p_workspace_id, p_conversation_id,
    'agent', p_agent_principal_id, true,
    p_before_created_at, p_before_id,
    p_after_created_at, p_after_id,
    p_limit, COALESCE(p_include_mentions, false), COALESCE(p_include_reactions, false)
  );
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 4. DM / group-DM thread reply support in route check and deferred filer.

CREATE OR REPLACE FUNCTION swarm.conversation_check_route(p_workspace uuid, p_signal uuid, p_conversation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_kind text;
  v_signal record;
  v_users uuid[];
  v_agents uuid[];
  v_live_users uuid[];
  v_live_agents uuid[];
  v_founders integer;
  v_want_users uuid[];
  v_want_agents uuid[];
  v_problem text;
BEGIN
  SELECT c.kind INTO v_kind
  FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace
  FOR SHARE;
  SELECT s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id, s.channel_id,
    s.thread_root_id, s.broadcast_to_channel, s.in_reply_to
  INTO v_signal
  FROM swarm.signals AS s
  WHERE s.id = p_signal AND s.workspace_id = p_workspace;
  SELECT coalesce(array_agg(DISTINCT r.u) FILTER (WHERE r.u IS NOT NULL), '{}'),
    coalesce(array_agg(DISTINCT r.a) FILTER (WHERE r.a IS NOT NULL), '{}')
  INTO v_users, v_agents
  FROM (
    SELECT v_signal.to_user_id AS u, v_signal.to_agent_principal_id AS a
    UNION ALL
    SELECT sr.recipient_user_id, sr.recipient_agent_principal_id
    FROM swarm.signal_recipients AS sr
    WHERE sr.signal_id = p_signal AND sr.workspace_id = p_workspace
  ) AS r;
  SELECT coalesce(array_agg(m.member_user_id) FILTER (WHERE m.member_user_id IS NOT NULL
        AND swarm.actor_can_access_channel(p_workspace, NULL, 'user', m.member_user_id)), '{}'),
    coalesce(array_agg(m.member_agent_principal_id) FILTER (WHERE m.member_agent_principal_id IS NOT NULL
        AND swarm.actor_can_access_channel(p_workspace, NULL, 'agent', m.member_agent_principal_id)), '{}')
  INTO v_live_users, v_live_agents
  FROM swarm.conversation_members AS m
  WHERE m.conversation_id = p_conversation AND m.left_at IS NULL;
  SELECT count(*) INTO v_founders FROM swarm.conversation_members AS m WHERE m.conversation_id = p_conversation;

  IF v_kind IS NULL OR v_kind NOT IN ('dm', 'group_dm') THEN
    v_problem := 'not a 1:1 or group';
  ELSIF v_signal.from_kind IS NULL OR v_signal.channel_id IS NOT NULL OR v_signal.in_reply_to IS NOT NULL THEN
    v_problem := 'not a conversation message outside any channel';
  ELSIF v_signal.thread_root_id IS NOT NULL AND v_signal.broadcast_to_channel IS TRUE THEN
    v_problem := 'broadcast_to_channel is not allowed in direct conversations';
  ELSIF v_signal.thread_root_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS root
    JOIN swarm.conversation_signals AS rcs
      ON rcs.signal_id = root.id
     AND rcs.workspace_id = root.workspace_id
    WHERE root.workspace_id = p_workspace
      AND root.id = v_signal.thread_root_id
      AND root.thread_root_id IS NULL
      AND rcs.conversation_id = p_conversation
      AND (
        rcs.audience = 'conversation'
        OR (
          rcs.audience = 'addressed'
          AND NOT EXISTS (
            SELECT 1 FROM swarm.conversation_members AS lm
            WHERE lm.conversation_id = p_conversation
              AND lm.workspace_id = p_workspace
              AND lm.left_at IS NULL
              AND swarm.conversation_signal_visible_to(
                rcs.workspace_id, rcs.signal_id, rcs.audience,
                root.from_kind, root.from_principal, root.to_user_id, root.to_agent_principal_id,
                CASE WHEN lm.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                COALESCE(lm.member_user_id, lm.member_agent_principal_id)
              ) IS NOT TRUE
          )
        )
      )
  ) THEN
    v_problem := 'thread root is not a visible top-level message in this conversation';
  ELSIF NOT ((v_signal.from_kind = 'user' AND v_signal.from_principal = ANY (v_live_users))
    OR (v_signal.from_kind = 'agent' AND v_signal.from_principal = ANY (v_live_agents))) THEN
    v_problem := 'the sender is not a live member';
  ELSE
    IF v_kind = 'dm' AND v_founders = 1 THEN
      -- A note to oneself.
      v_want_users := v_live_users;
      v_want_agents := v_live_agents;
    ELSIF v_kind = 'dm' OR v_signal.from_kind = 'user' THEN
      -- Everyone else: a person's post, and either member's post in a 1:1.
      v_want_users := CASE WHEN v_signal.from_kind = 'user' THEN array_remove(v_live_users, v_signal.from_principal) ELSE v_live_users END;
      v_want_agents := CASE WHEN v_signal.from_kind = 'agent' THEN array_remove(v_live_agents, v_signal.from_principal) ELSE v_live_agents END;
    ELSE
      -- An agent's group post: every live person, and only the live agents it named, never itself.
      v_want_users := v_live_users;
      v_want_agents := CASE WHEN v_agents <@ array_remove(v_live_agents, v_signal.from_principal) THEN v_agents
        ELSE array_remove(v_live_agents, v_signal.from_principal) END;
    END IF;
    IF cardinality(v_want_users) + cardinality(v_want_agents) = 0 THEN
      v_problem := 'nobody to send it to';
    ELSIF NOT (v_users @> v_want_users AND v_users <@ v_want_users
      AND v_agents @> v_want_agents AND v_agents <@ v_want_agents) THEN
      v_problem := 'its address set is not the route rule''s';
    END IF;
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'message % is filed in conversation % but breaks its route rule: %', p_signal, p_conversation, v_problem
      USING ERRCODE = '23514', CONSTRAINT = 'conversation_signals_route';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION swarm.file_conversation_signal(p_workspace uuid, p_signal uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_new boolean;
  v_expected record;
  v_row record;
  v_explicit record;
BEGIN
  v_new := EXISTS (
    SELECT 1 FROM swarm.signals AS s
    WHERE s.id = p_signal AND s.workspace_id = p_workspace
      AND s.creation_xact_id = pg_current_xact_id()
      AND s.creation_system_identifier = (SELECT system_identifier FROM pg_catalog.pg_control_system()));
  SELECT cs.conversation_id INTO v_explicit
  FROM swarm.conversation_signals AS cs
  JOIN swarm.conversations AS c ON c.conversation_id = cs.conversation_id AND c.workspace_id = cs.workspace_id
  JOIN swarm.signals AS s ON s.id = cs.signal_id AND s.workspace_id = cs.workspace_id
  WHERE cs.signal_id = p_signal AND cs.workspace_id = p_workspace AND v_new
    AND cs.audience = 'conversation' AND c.kind IN ('dm', 'group_dm')
    AND s.channel_id IS NULL;
  IF FOUND THEN
    PERFORM swarm.conversation_check_route(p_workspace, p_signal, v_explicit.conversation_id);
    RETURN;
  END IF;
  SELECT p.conversation_id, p.audience, p.unplaced INTO v_expected
  FROM swarm.conversation_placement(p_workspace, p_signal, v_new) AS p;
  SELECT cs.workspace_id, cs.conversation_id, cs.audience INTO v_row
  FROM swarm.conversation_signals AS cs
  WHERE cs.signal_id = p_signal;
  IF FOUND THEN
    IF v_expected.conversation_id IS NULL OR v_row.workspace_id <> p_workspace
      OR v_row.conversation_id <> v_expected.conversation_id OR v_row.audience <> v_expected.audience THEN
      RAISE EXCEPTION 'message % is filed in conversation % for audience %, but belongs in % for %',
        p_signal, v_row.conversation_id, v_row.audience,
        coalesce(v_expected.conversation_id::text, 'none (' || v_expected.unplaced || ')'),
        coalesce(v_expected.audience, 'none')
        USING ERRCODE = '23514', CONSTRAINT = 'conversation_signals_placement';
    END IF;
    RETURN;
  END IF;
  IF v_expected.conversation_id IS NULL THEN
    RAISE EXCEPTION 'message % cannot be filed in a conversation', p_signal
      USING ERRCODE = 'CV001', CONSTRAINT = 'conversation_unfilable',
        DETAIL = 'conversation_unfilable: ' || coalesce(v_expected.unplaced, 'unknown');
  END IF;
  INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
  VALUES (p_signal, p_workspace, v_expected.conversation_id, '-infinity', v_expected.audience);
END;
$$;

-- Narrow command-edge helper: validates a live thread root inside an explicit dm / group_dm
-- conversation (preserving swarm_command's zero direct SELECT on conversation tables and enforcing
-- the exact same non-leaking audience rule as swarm.conversation_check_route).
CREATE FUNCTION swarm.conversation_thread_root(
  p_workspace uuid,
  p_conversation uuid,
  p_root uuid
) RETURNS TABLE (
  id uuid,
  until timestamptz,
  remaining_ms double precision,
  channel_id uuid,
  thread_root_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT
    s.id,
    s.until,
    (EXTRACT(EPOCH FROM (s.until - statement_timestamp())) * 1000)::double precision AS remaining_ms,
    s.channel_id,
    s.thread_root_id
  FROM swarm.signals AS s
  JOIN swarm.conversation_signals AS cs
    ON cs.signal_id = s.id
   AND cs.workspace_id = s.workspace_id
  JOIN swarm.conversations AS c
    ON c.conversation_id = cs.conversation_id
   AND c.workspace_id = cs.workspace_id
  WHERE s.workspace_id = p_workspace
    AND s.id = p_root
    AND cs.conversation_id = p_conversation
    AND c.kind IN ('dm', 'group_dm')
    AND s.in_reply_to IS NULL
    AND s.until > statement_timestamp() + interval '1 second'
    AND (
      cs.audience = 'conversation'
      OR (
        cs.audience = 'addressed'
        AND NOT EXISTS (
          SELECT 1 FROM swarm.conversation_members AS lm
          WHERE lm.conversation_id = p_conversation
            AND lm.workspace_id = p_workspace
            AND lm.left_at IS NULL
            AND swarm.conversation_signal_visible_to(
              cs.workspace_id, cs.signal_id, cs.audience,
              s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
              CASE WHEN lm.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
              COALESCE(lm.member_user_id, lm.member_agent_principal_id)
            ) IS NOT TRUE
        )
      )
    )
  LIMIT 1
$$;

-- Step 2b upgrade of conversation_mark_read: replaces Step 2a's pre-read audience filter with
-- swarm.conversation_signal_visible_to so any live member can mark read through any message
-- visible in conversation_history (including unaddressed group-DM posts with audience='conversation').
CREATE OR REPLACE FUNCTION swarm.conversation_mark_read(
  p_workspace uuid,
  p_actor_kind text,
  p_actor uuid,
  p_conversation uuid,
  p_through uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
  v_at timestamptz;
  v_id uuid;
  v_last constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
BEGIN
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF p_through IS NULL THEN
    v_at := statement_timestamp();
  ELSE
    SELECT s.created_at, s.id INTO v_at, v_id
    FROM swarm.conversation_signals AS cs
    JOIN swarm.signals AS s ON s.id = cs.signal_id AND s.workspace_id = cs.workspace_id
    WHERE cs.signal_id = p_through AND cs.conversation_id = p_conversation AND cs.workspace_id = p_workspace
      AND swarm.conversation_signal_visible_to(
        cs.workspace_id, cs.signal_id, cs.audience,
        s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
        p_actor_kind, p_actor
      );
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'signal_not_found', 'channel_id', t.channel_id);
    END IF;
  END IF;
  IF t.kind IN ('general', 'public_channel', 'private_channel') AND p_actor_kind = 'user' THEN
    INSERT INTO swarm.human_channel_reads AS r (workspace_id, user_id, channel_id, read_through_at, read_through_id)
    VALUES (p_workspace, p_actor, t.channel_id, v_at, v_id)
    ON CONFLICT (user_id, workspace_id, channel_id) DO UPDATE
      SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
        updated_at = statement_timestamp()
      WHERE (excluded.read_through_at, coalesce(excluded.read_through_id, v_last))
        > (r.read_through_at, coalesce(r.read_through_id, v_last));
  ELSIF t.kind IN ('general', 'public_channel', 'private_channel') THEN
    INSERT INTO swarm.agent_channel_reads AS r (workspace_id, principal_id, channel_id, read_through_at, read_through_id)
    VALUES (p_workspace, p_actor, t.channel_id, v_at, coalesce(v_id, v_last))
    ON CONFLICT (principal_id, workspace_id, channel_id) DO UPDATE
      SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
        updated_at = statement_timestamp()
      WHERE r.read_through_at IS NULL
        OR (excluded.read_through_at, excluded.read_through_id) > (r.read_through_at, r.read_through_id);
  ELSIF p_actor_kind = 'user' THEN
    INSERT INTO swarm.conversation_reads AS r
      (conversation_id, workspace_id, member_user_id, read_through_at, read_through_id)
    VALUES (p_conversation, p_workspace, p_actor, v_at, v_id)
    ON CONFLICT (conversation_id, member_user_id) DO UPDATE
      SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
        updated_at = statement_timestamp()
      WHERE r.read_through_at IS NULL
        OR (excluded.read_through_at, coalesce(excluded.read_through_id, v_last))
          > (r.read_through_at, coalesce(r.read_through_id, v_last));
  ELSE
    INSERT INTO swarm.conversation_reads AS r
      (conversation_id, workspace_id, member_agent_principal_id, read_through_at, read_through_id)
    VALUES (p_conversation, p_workspace, p_actor, v_at, v_id)
    ON CONFLICT (conversation_id, member_agent_principal_id) DO UPDATE
      SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
        updated_at = statement_timestamp()
      WHERE r.read_through_at IS NULL
        OR (excluded.read_through_at, coalesce(excluded.read_through_id, v_last))
          > (r.read_through_at, coalesce(r.read_through_id, v_last));
  END IF;
  SELECT r.read_through_at INTO v_at
  FROM swarm.conversation_reads AS r
  WHERE r.conversation_id = p_conversation
    AND ((p_actor_kind = 'user' AND r.member_user_id = p_actor)
      OR (p_actor_kind = 'agent' AND r.member_agent_principal_id = p_actor));
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id,
    'read_through_at', to_jsonb(v_at) #>> '{}');
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 5. Ownership & least-privilege grants.

ALTER FUNCTION swarm.conversation_read_actor(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_oversight_actor(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_signal_visible_to(uuid, uuid, text, text, uuid, uuid, uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_members_json(uuid, uuid, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_summary_json(uuid, uuid, text, uuid, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_history_page(uuid, uuid, text, uuid, boolean, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_thread_root(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_check_route(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.file_conversation_signal(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_mark_read(uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;

ALTER FUNCTION swarm_read.conversations(uuid, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm_read.conversation_history(uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm_read.conversation_oversight(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm_read.conversation_oversight_history(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION
  swarm.conversation_read_actor(uuid),
  swarm.conversation_oversight_actor(uuid, uuid),
  swarm.conversation_signal_visible_to(uuid, uuid, text, text, uuid, uuid, uuid, text, uuid),
  swarm.conversation_members_json(uuid, uuid, text),
  swarm.conversation_summary_json(uuid, uuid, text, uuid, boolean),
  swarm.conversation_history_page(uuid, uuid, text, uuid, boolean, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean),
  swarm.conversation_thread_root(uuid, uuid, uuid),
  swarm_read.conversations(uuid, boolean),
  swarm_read.conversation_history(uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean),
  swarm_read.conversation_oversight(uuid, uuid),
  swarm_read.conversation_oversight_history(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean)
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT EXECUTE ON FUNCTION
  swarm.conversation_thread_root(uuid, uuid, uuid)
TO swarm_command;

GRANT EXECUTE ON FUNCTION
  swarm_read.conversations(uuid, boolean),
  swarm_read.conversation_history(uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean),
  swarm_read.conversation_oversight(uuid, uuid),
  swarm_read.conversation_oversight_history(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean)
TO swarm_read;

RESET search_path;
