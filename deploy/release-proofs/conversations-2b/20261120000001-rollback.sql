-- Rollback for 20261120000001_conversations_reads.sql.
-- Roll back the read and command edge functions first, then run this script to drop the Step 2b
-- read functions and restore Step 2a's exact conversation_check_route, file_conversation_signal,
-- and conversation_mark_read bodies.
SET search_path = swarm, pg_catalog, public;

DROP FUNCTION IF EXISTS swarm_read.conversation_oversight_history(uuid, uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean);
DROP FUNCTION IF EXISTS swarm_read.conversation_oversight(uuid, uuid);
DROP FUNCTION IF EXISTS swarm_read.conversation_history(uuid, uuid, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean);
DROP FUNCTION IF EXISTS swarm_read.conversations(uuid, boolean);

DROP FUNCTION IF EXISTS swarm.conversation_thread_root(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_history_page(uuid, uuid, text, uuid, boolean, timestamptz, uuid, timestamptz, uuid, integer, boolean, boolean);
DROP FUNCTION IF EXISTS swarm.conversation_summary_json(uuid, uuid, text, uuid, boolean);
DROP FUNCTION IF EXISTS swarm.conversation_members_json(uuid, uuid, text);
DROP FUNCTION IF EXISTS swarm.conversation_signal_visible_to(uuid, uuid, text, text, uuid, uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_oversight_actor(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_read_actor(uuid);

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
  SELECT s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id, s.channel_id, s.thread_root_id,
    s.in_reply_to
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
  ELSIF v_signal.from_kind IS NULL OR v_signal.channel_id IS NOT NULL OR v_signal.thread_root_id IS NOT NULL
    OR v_signal.in_reply_to IS NOT NULL THEN
    v_problem := 'not a top-level message outside any channel';
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
  -- The server stamp the recipient and mention guards read (20261022000992): new in this transaction.
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
    AND s.channel_id IS NULL AND s.thread_root_id IS NULL;
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
    -- Every new message belongs to exactly one conversation: one that cannot be placed aborts its
    -- transaction. (Only new messages reach here; history is filed by the backfill, which counts it.)
    RAISE EXCEPTION 'message % cannot be filed in a conversation', p_signal
      USING ERRCODE = 'CV001', CONSTRAINT = 'conversation_unfilable',
        DETAIL = 'conversation_unfilable: ' || coalesce(v_expected.unplaced, 'unknown');
  END IF;
  INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
  VALUES (p_signal, p_workspace, v_expected.conversation_id, '-infinity', v_expected.audience);
END;
$$;

CREATE OR REPLACE FUNCTION swarm.conversation_mark_read(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
  p_through uuid) RETURNS jsonb
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
      -- The read rule 2a serves (swarm_read.signals): a message for everyone, or one the caller sent or is
      -- addressed by. A group post's all-member audience is read by step 2b, not yet.
      AND ((s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL AND s.in_reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients AS any_r
            WHERE any_r.signal_id = s.id AND any_r.workspace_id = s.workspace_id))
        OR (s.from_kind = p_actor_kind AND s.from_principal = p_actor)
        OR (p_actor_kind = 'user' AND s.to_user_id = p_actor)
        OR (p_actor_kind = 'agent' AND s.to_agent_principal_id = p_actor)
        OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS sr
          WHERE sr.signal_id = s.id AND sr.workspace_id = s.workspace_id
            AND ((p_actor_kind = 'user' AND sr.recipient_user_id = p_actor)
              OR (p_actor_kind = 'agent' AND sr.recipient_agent_principal_id = p_actor))));
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

RESET search_path;
