-- Conversations, step 2a of 6: the commands, posts to a conversation, membership upkeep and per-person
-- live updates. The read rule (step 2b) is not here: every read is still swarm_read.signals.
--
-- 1. Commands. The command edge (swarm_command) calls the definers below and nothing else; no client
--    role can read or write a conversation table.
--      conversation_open        find or make the 1:1 or group for a member list (nine at most, the
--                               caller included). A group someone has left is refused unless the
--                               caller, a live member of it, asks for a new group (new_group): that
--                               makes the next generation of the same set, a new conversation with
--                               none of the old one's history. A 1:1 whose other member was removed
--                               from the workspace and is back is made fresh the same way, without
--                               new_group, since a 1:1 cannot be left.
--      conversation_join/leave  #general and public channels; a group can be left, finally; a 1:1
--                               and #general cannot. Private channels keep channel_member_* (step 5).
--      conversation_invite      a member adds people and agents to a public channel.
--      conversation_remove      the channel's creator (or its creating agent's owner) or a workspace
--                               owner or admin takes someone out of a public channel.
--      conversation_mark_read   the caller's read position. In #general and channels it is written to
--                               human_channel_reads or agent_channel_reads, which today's unread reads;
--                               a trigger copies every write of those two tables, from any writer, into
--                               conversation_reads. A 1:1 or group has only conversation_reads.
--      conversation_set_notify  everything, mentions or muted, and the star with its order.
-- 2. Posts to a conversation. The edge turns post_signal's conversation_id into today's addresses by
--    the route rule (swarm.conversation_post_route) and files the message itself
--    (swarm.conversation_prefile) with audience 'conversation'. At commit the deferred filer checks
--    such a row by the route rule, separately from the audience (swarm.conversation_check_route): the
--    sender is a live member, and the address set is exactly every other live member for a person's
--    post (the other member of a 1:1 for anyone's; the sender alone in a note to self), or, for an
--    agent's group post, the live people plus only the live agents it named, never itself. Anything
--    else still goes through step 1's placement and must match it.
-- 3. Membership upkeep (triggers): a person or an agent seat that becomes live joins #general, and
--    only #general; one that stops being live (removed, seat or agent revoked, owner removed) leaves
--    every conversation in that workspace, so a re-add starts with nothing. A rejoin resets the one row
--    a member has (joined_at now, defaults). A public channel's creator joins it. channel_preferences
--    writes are copied onto the member's row.
-- 4. Realtime. Nothing is sent on the workspace topic (cswarm-signals:<workspace>) any more: its
--    emitter (swarm.wake_workspace_signal) is dropped and reactions move off it. Each reader of a new
--    message gets a bare {"v": 1} on their own topic (cswarm-member:<workspace>:<user>), sent by the
--    deferred filer when the message's mapping row is checked, at commit, after validation, under the
--    conversation's row lock (FOR SHARE here and for a reaction; FOR UPDATE on every membership change,
--    a person's removal from a private channel included, and on every conversation in the workspace
--    when someone leaves it). Readers: every live person in the workspace for #general and public
--    channels, the private channel's members, a 1:1's or group's live people; a message for a narrower
--    audience, and addressed history never filed, reaches only its sender and people recipients among
--    those. An agent's owner is never a reader by ownership. Agents keep their wake topic.
-- 5. Release: swarm.conversations_backfill() runs once more at the end (messages and read marks since
--    step 1, and step 1's membership rule for anyone added since). After this migration it is not run
--    again: its public-channel rule would enrol new members in every channel.
--
-- Rollback: deploy/release-proofs/conversations-2a/20261118000005-rollback.sql (backup first).
SET search_path = swarm, pg_catalog, public;

-- ---------------------------------------------------------------------------------------------------
-- Membership helpers.

-- Join, or rejoin with a fresh membership. True when something changed.
CREATE FUNCTION swarm.conversation_member_join(p_conversation uuid, p_workspace uuid, p_kind text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_n bigint;
BEGIN
  IF p_kind = 'user' THEN
    INSERT INTO swarm.conversation_members AS m (conversation_id, workspace_id, member_user_id)
    VALUES (p_conversation, p_workspace, p_id)
    ON CONFLICT (conversation_id, member_user_id) DO UPDATE
      SET joined_at = statement_timestamp(), left_at = NULL, notify_level = 'everything', starred = false,
        star_rank = NULL
      WHERE m.left_at IS NOT NULL;
  ELSE
    INSERT INTO swarm.conversation_members AS m (conversation_id, workspace_id, member_agent_principal_id)
    VALUES (p_conversation, p_workspace, p_id)
    ON CONFLICT (conversation_id, member_agent_principal_id) DO UPDATE
      SET joined_at = statement_timestamp(), left_at = NULL, notify_level = 'everything', starred = false,
        star_rank = NULL
      WHERE m.left_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- Leave. True when the member was live.
CREATE FUNCTION swarm.conversation_member_leave(p_conversation uuid, p_kind text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_n bigint;
BEGIN
  UPDATE swarm.conversation_members AS m
  SET left_at = greatest(m.joined_at, statement_timestamp())
  WHERE m.conversation_id = p_conversation AND m.left_at IS NULL
    AND ((p_kind = 'user' AND m.member_user_id = p_id) OR (p_kind = 'agent' AND m.member_agent_principal_id = p_id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- What the caller may do with one conversation of this workspace. visible: a live person or agent of
-- the workspace who may read it (#general and public channels: anyone live; a private channel: its
-- members; a 1:1 or group: its live members). member: their own row, 'live', 'left' or 'none'.
CREATE FUNCTION swarm.conversation_target(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
  OUT kind text, OUT channel_id uuid, OUT archived boolean, OUT member text, OUT visible boolean,
  OUT created_by_kind text, OUT created_by_principal uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_live boolean;
BEGIN
  visible := false;
  member := 'none';
  SELECT c.kind, c.channel_id, c.archived_at IS NOT NULL, c.created_by_kind, c.created_by_principal
  INTO kind, channel_id, archived, created_by_kind, created_by_principal
  FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace;
  IF NOT FOUND OR p_actor_kind NOT IN ('user', 'agent') THEN
    kind := NULL;
    RETURN;
  END IF;
  v_live := swarm.actor_can_access_channel(p_workspace, NULL, p_actor_kind, p_actor);
  SELECT CASE WHEN m.left_at IS NULL THEN 'live' ELSE 'left' END INTO member
  FROM swarm.conversation_members AS m
  WHERE m.conversation_id = p_conversation
    AND ((p_actor_kind = 'user' AND m.member_user_id = p_actor)
      OR (p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor));
  member := coalesce(member, 'none');
  visible := v_live AND CASE
    WHEN kind IN ('general', 'public_channel') THEN true
    WHEN kind = 'private_channel' THEN swarm.actor_can_access_channel(p_workspace, channel_id, p_actor_kind, p_actor)
    ELSE member = 'live' END;
END;
$$;

-- The display name of someone who left the newest generation of a founding set's group, or null.
CREATE FUNCTION swarm.conversation_departed_name(p_conversation uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce(u.display_name, p.name, 'Someone')
  FROM swarm.conversation_members AS m
  LEFT JOIN swarm.users AS u ON u.user_id = m.member_user_id
  LEFT JOIN swarm.agent_principals AS p ON p.principal_id = m.member_agent_principal_id
  WHERE m.conversation_id = p_conversation AND m.left_at IS NOT NULL
  ORDER BY m.left_at, m.member_user_id, m.member_agent_principal_id
  LIMIT 1
$$;

-- The founding key of a set, exactly as swarm.conversation_for_members computes it.
CREATE FUNCTION swarm.conversation_member_key(p_users uuid[], p_agents uuid[]) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(string_agg(tagged, ',' ORDER BY tagged), 'UTF8')), 'hex')
  FROM (
    SELECT DISTINCT 'u:' || u::text AS tagged FROM unnest(p_users) AS u WHERE u IS NOT NULL
    UNION
    SELECT DISTINCT 'a:' || a::text FROM unnest(p_agents) AS a WHERE a IS NOT NULL
  ) AS members
$$;

-- The next generation of a 1:1 or group: a new conversation with the same founding key and all its
-- founders as live members. Only conversation_open calls it. Takes the newest generation FOR UPDATE.
CREATE FUNCTION swarm.conversation_next_generation(p_conversation uuid, p_creator_kind text, p_creator uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_old record;
  v_newest record;
  v_id uuid;
BEGIN
  SELECT c.workspace_id, c.kind, c.member_key INTO v_old
  FROM swarm.conversations AS c WHERE c.conversation_id = p_conversation;
  SELECT c.conversation_id, c.generation INTO v_newest
  FROM swarm.conversations AS c
  WHERE c.workspace_id = v_old.workspace_id AND c.member_key = v_old.member_key
  ORDER BY c.generation DESC LIMIT 1
  FOR UPDATE;
  IF v_newest.conversation_id <> p_conversation THEN
    -- Another open made it first.
    RETURN v_newest.conversation_id;
  END IF;
  INSERT INTO swarm.conversations (workspace_id, kind, member_key, generation, created_by_kind, created_by_principal)
  VALUES (v_old.workspace_id, v_old.kind, v_old.member_key, v_newest.generation + 1, p_creator_kind, p_creator)
  RETURNING conversation_id INTO v_id;
  INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id, member_agent_principal_id)
  SELECT v_id, v_old.workspace_id, m.member_user_id, m.member_agent_principal_id
  FROM swarm.conversation_members AS m WHERE m.conversation_id = p_conversation;
  RETURN v_id;
END;
$$;

CREATE FUNCTION swarm.conversation_live_members(p_conversation uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'kind', CASE WHEN m.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
      'id', coalesce(m.member_user_id, m.member_agent_principal_id))
    ORDER BY m.joined_at, m.member_user_id, m.member_agent_principal_id), '[]'::jsonb)
  FROM swarm.conversation_members AS m
  WHERE m.conversation_id = p_conversation AND m.left_at IS NULL
$$;

-- ---------------------------------------------------------------------------------------------------
-- The commands. Each returns {"status": ...}; the edge turns a status into its answer. A 1:1, a
-- group and a private channel the caller cannot read answer 'not_found', as an unknown id does.

CREATE FUNCTION swarm.conversation_open(p_workspace uuid, p_actor_kind text, p_actor uuid,
  p_users uuid[], p_agents uuid[], p_new_group boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_users uuid[];
  v_agents uuid[];
  v_key text;
  v_id uuid;
  v_created boolean := false;
  v_conv record;
  v_self text;
BEGIN
  IF p_actor_kind NOT IN ('user', 'agent')
    OR NOT swarm.actor_can_access_channel(p_workspace, NULL, p_actor_kind, p_actor) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  SELECT coalesce(array_agg(DISTINCT u), '{}') INTO v_users
  FROM unnest(coalesce(p_users, '{}') || CASE WHEN p_actor_kind = 'user' THEN ARRAY[p_actor] ELSE '{}' END) AS u
  WHERE u IS NOT NULL;
  SELECT coalesce(array_agg(DISTINCT a), '{}') INTO v_agents
  FROM unnest(coalesce(p_agents, '{}') || CASE WHEN p_actor_kind = 'agent' THEN ARRAY[p_actor] ELSE '{}' END) AS a
  WHERE a IS NOT NULL;
  IF cardinality(v_users) + cardinality(v_agents) > 9 THEN
    RETURN jsonb_build_object('status', 'too_many');
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_users) AS u WHERE NOT swarm.actor_can_access_channel(p_workspace, NULL, 'user', u))
    OR EXISTS (SELECT 1 FROM unnest(v_agents) AS a WHERE NOT swarm.actor_can_access_channel(p_workspace, NULL, 'agent', a)) THEN
    RETURN jsonb_build_object('status', 'member_not_found');
  END IF;
  v_key := swarm.conversation_member_key(v_users, v_agents);
  SELECT c.conversation_id INTO v_id
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace AND c.member_key = v_key
  ORDER BY c.generation DESC LIMIT 1;
  IF v_id IS NULL THEN
    v_id := swarm.conversation_for_members(p_workspace, p_actor_kind, p_actor, v_users, v_agents, true, NULL);
    v_created := true;
  END IF;
  SELECT c.conversation_id, c.kind, c.generation INTO v_conv
  FROM swarm.conversations AS c WHERE c.conversation_id = v_id
  FOR UPDATE;
  IF EXISTS (SELECT 1 FROM swarm.conversation_members AS m WHERE m.conversation_id = v_id AND m.left_at IS NOT NULL) THEN
    SELECT CASE WHEN m.left_at IS NULL THEN 'live' ELSE 'left' END INTO v_self
    FROM swarm.conversation_members AS m
    WHERE m.conversation_id = v_id
      AND ((p_actor_kind = 'user' AND m.member_user_id = p_actor)
        OR (p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor));
    -- The caller's own departure comes first, on a plain open as on new_group: they are told that they
    -- left, never another leaver's name (or their own as someone else).
    IF v_conv.kind = 'group_dm' AND v_self IS DISTINCT FROM 'live' THEN
      RETURN jsonb_build_object('status', 'caller_left');
    END IF;
    IF v_conv.kind = 'group_dm' AND NOT coalesce(p_new_group, false) THEN
      RETURN jsonb_build_object('status', 'member_left', 'name', swarm.conversation_departed_name(v_id));
    END IF;
    -- Every member was checked live above, so a 1:1 here is one whose member came back after a
    -- workspace removal, and a group is one the caller (still in it) asked to start again.
    v_id := swarm.conversation_next_generation(v_id, p_actor_kind, p_actor);
    v_created := true;
    SELECT c.conversation_id, c.kind, c.generation INTO v_conv
    FROM swarm.conversations AS c WHERE c.conversation_id = v_id;
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'created', v_created,
    'conversation', jsonb_build_object('conversation_id', v_conv.conversation_id, 'kind', v_conv.kind,
      'generation', v_conv.generation, 'members', swarm.conversation_live_members(v_id)));
END;
$$;

CREATE FUNCTION swarm.conversation_join(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace FOR UPDATE;
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF t.kind = 'private_channel' THEN
    RETURN jsonb_build_object('status', 'private_channel', 'channel_id', t.channel_id);
  ELSIF t.kind IN ('dm', 'group_dm') THEN
    RETURN jsonb_build_object('status', 'fixed_members', 'kind', t.kind);
  ELSIF t.archived THEN
    RETURN jsonb_build_object('status', 'archived', 'channel_id', t.channel_id);
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id,
    'changed', swarm.conversation_member_join(p_conversation, p_workspace, p_actor_kind, p_actor));
END;
$$;

CREATE FUNCTION swarm.conversation_leave(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace FOR UPDATE;
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF t.kind = 'private_channel' THEN
    RETURN jsonb_build_object('status', 'private_channel', 'channel_id', t.channel_id);
  ELSIF t.kind = 'general' THEN
    RETURN jsonb_build_object('status', 'cannot_leave_general');
  ELSIF t.kind = 'dm' THEN
    RETURN jsonb_build_object('status', 'cannot_leave_dm');
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id,
    'changed', swarm.conversation_member_leave(p_conversation, p_actor_kind, p_actor));
END;
$$;

CREATE FUNCTION swarm.conversation_invite(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
  p_users uuid[], p_agents uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
  v_id uuid;
  v_added jsonb := '[]'::jsonb;
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace FOR UPDATE;
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF t.kind = 'private_channel' THEN
    RETURN jsonb_build_object('status', 'private_channel', 'channel_id', t.channel_id);
  ELSIF t.kind IN ('dm', 'group_dm') THEN
    RETURN jsonb_build_object('status', 'fixed_members', 'kind', t.kind);
  ELSIF t.kind = 'general' THEN
    RETURN jsonb_build_object('status', 'everyone_in_general');
  ELSIF t.archived THEN
    RETURN jsonb_build_object('status', 'archived', 'channel_id', t.channel_id);
  ELSIF t.member <> 'live' THEN
    RETURN jsonb_build_object('status', 'not_a_member', 'channel_id', t.channel_id);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_users, '{}')) AS u WHERE NOT swarm.actor_can_access_channel(p_workspace, NULL, 'user', u))
    OR EXISTS (SELECT 1 FROM unnest(coalesce(p_agents, '{}')) AS a WHERE NOT swarm.actor_can_access_channel(p_workspace, NULL, 'agent', a)) THEN
    RETURN jsonb_build_object('status', 'member_not_found', 'channel_id', t.channel_id);
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_users, '{}') LOOP
    IF swarm.conversation_member_join(p_conversation, p_workspace, 'user', v_id) THEN
      v_added := v_added || jsonb_build_array(jsonb_build_object('kind', 'user', 'id', v_id));
    END IF;
  END LOOP;
  FOREACH v_id IN ARRAY coalesce(p_agents, '{}') LOOP
    IF swarm.conversation_member_join(p_conversation, p_workspace, 'agent', v_id) THEN
      v_added := v_added || jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', v_id));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id, 'members_added', v_added);
END;
$$;

CREATE FUNCTION swarm.conversation_remove(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
  p_member_kind text, p_member uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
  v_manager boolean;
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace FOR UPDATE;
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF t.kind = 'private_channel' THEN
    RETURN jsonb_build_object('status', 'private_channel', 'channel_id', t.channel_id);
  ELSIF t.kind IN ('dm', 'group_dm') THEN
    RETURN jsonb_build_object('status', 'fixed_members', 'kind', t.kind);
  ELSIF t.kind = 'general' THEN
    RETURN jsonb_build_object('status', 'everyone_in_general');
  END IF;
  -- canManageChannel for a public channel: its creator, the owner of the agent that created it, or a
  -- workspace owner or admin.
  v_manager := (t.created_by_kind = p_actor_kind AND t.created_by_principal = p_actor)
    OR (p_actor_kind = 'user' AND t.created_by_kind = 'agent' AND EXISTS (
      SELECT 1 FROM swarm.agent_principals AS p
      WHERE p.principal_id = t.created_by_principal AND p.owner_user_id = p_actor))
    OR (p_actor_kind = 'user' AND EXISTS (
      SELECT 1 FROM swarm.memberships AS m
      WHERE m.workspace_id = p_workspace AND m.user_id = p_actor AND m.revoked_at IS NULL
        AND m.role IN ('owner', 'admin')));
  IF NOT v_manager THEN
    RETURN jsonb_build_object('status', 'forbidden', 'channel_id', t.channel_id);
  END IF;
  IF NOT swarm.conversation_member_leave(p_conversation, p_member_kind, p_member) THEN
    RETURN jsonb_build_object('status', 'not_a_member', 'channel_id', t.channel_id);
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id, 'changed', true);
END;
$$;

-- The caller's read position, forward only. Through a message filed in this conversation that the
-- caller is in the audience of, or through now. #general and channels go through the two tables
-- today's unread reads (and from there, by trigger, into conversation_reads); a 1:1 or group has only
-- conversation_reads.
CREATE FUNCTION swarm.conversation_mark_read(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
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

CREATE FUNCTION swarm.conversation_set_notify(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
  p_notify_level text, p_starred boolean, p_star_rank integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
  v_rank integer;
  v_row record;
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace FOR UPDATE;
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF t.kind = 'private_channel' THEN
    RETURN jsonb_build_object('status', 'private_channel', 'channel_id', t.channel_id);
  ELSIF t.member <> 'live' THEN
    RETURN jsonb_build_object('status', 'not_a_member', 'channel_id', t.channel_id);
  END IF;
  IF p_starred THEN
    v_rank := coalesce(p_star_rank, (
      SELECT max(m.star_rank) + 1 FROM swarm.conversation_members AS m
      WHERE m.workspace_id = p_workspace AND m.starred AND m.left_at IS NULL
        AND ((p_actor_kind = 'user' AND m.member_user_id = p_actor)
          OR (p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor))
        AND m.conversation_id <> p_conversation), 0);
  END IF;
  UPDATE swarm.conversation_members AS m
  SET notify_level = coalesce(p_notify_level, m.notify_level),
    starred = coalesce(p_starred, m.starred),
    star_rank = CASE WHEN p_starred IS NULL THEN m.star_rank WHEN p_starred THEN v_rank END
  WHERE m.conversation_id = p_conversation AND m.left_at IS NULL
    AND ((p_actor_kind = 'user' AND m.member_user_id = p_actor)
      OR (p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor))
  RETURNING m.notify_level, m.starred, m.star_rank INTO v_row;
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id,
    'notify_level', v_row.notify_level, 'starred', v_row.starred, 'star_rank', v_row.star_rank);
END;
$$;

-- post_signal with conversation_id: where it goes. A channel or #general posts through today's channel
-- path; a 1:1 or group gets its address set by the route rule. Takes the conversation FOR SHARE.
CREATE FUNCTION swarm.conversation_post_route(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid,
  p_named_users uuid[], p_named_agents uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t record;
  v_slug text;
  v_founders integer;
  v_to jsonb;
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.conversation_id = p_conversation AND c.workspace_id = p_workspace FOR SHARE;
  SELECT * INTO t FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation);
  IF t.kind IS NULL OR NOT t.visible THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF t.kind = 'general' THEN
    RETURN jsonb_build_object('status', 'ok', 'kind', t.kind);
  ELSIF t.kind IN ('public_channel', 'private_channel') THEN
    SELECT ch.slug INTO v_slug FROM swarm.channels AS ch
    WHERE ch.channel_id = t.channel_id AND ch.workspace_id = p_workspace;
    RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'channel_id', t.channel_id, 'slug', v_slug);
  END IF;
  -- Everyone named must be a live member here.
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_named_users, '{}')) AS u WHERE NOT EXISTS (
      SELECT 1 FROM swarm.conversation_members AS m
      WHERE m.conversation_id = p_conversation AND m.member_user_id = u AND m.left_at IS NULL))
    OR EXISTS (SELECT 1 FROM unnest(coalesce(p_named_agents, '{}')) AS a WHERE NOT EXISTS (
      SELECT 1 FROM swarm.conversation_members AS m
      WHERE m.conversation_id = p_conversation AND m.member_agent_principal_id = a AND m.left_at IS NULL)) THEN
    RETURN jsonb_build_object('status', 'not_in_conversation');
  END IF;
  SELECT count(*) INTO v_founders FROM swarm.conversation_members AS m WHERE m.conversation_id = p_conversation;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', w.kind, 'id', w.id) ORDER BY w.joined_at, w.kind DESC, w.id), '[]')
  INTO v_to
  FROM (
    SELECT CASE WHEN m.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END AS kind,
      coalesce(m.member_user_id, m.member_agent_principal_id) AS id, m.joined_at
    FROM swarm.conversation_members AS m
    WHERE m.conversation_id = p_conversation AND m.left_at IS NULL
      AND CASE WHEN m.member_user_id IS NOT NULL THEN swarm.actor_can_access_channel(p_workspace, NULL, 'user', m.member_user_id)
        ELSE swarm.actor_can_access_channel(p_workspace, NULL, 'agent', m.member_agent_principal_id) END
      AND (
        -- A note to oneself is addressed to oneself.
        (v_founders = 1)
        OR (NOT (coalesce(p_actor_kind = 'user' AND m.member_user_id = p_actor, false)
          OR coalesce(p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor, false))
          AND (t.kind = 'dm' OR p_actor_kind = 'user' OR m.member_user_id IS NOT NULL
            OR m.member_agent_principal_id = ANY (coalesce(p_named_agents, '{}'))))
      )
  ) AS w;
  IF jsonb_array_length(v_to) = 0 THEN
    RETURN jsonb_build_object('status', 'no_recipients', 'kind', t.kind,
      'name', swarm.conversation_departed_name(p_conversation));
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'kind', t.kind, 'to', v_to);
END;
$$;

-- The edge files a message it posted to a 1:1 or group, after its recipient rows. Only a message
-- created in this transaction; the deferred filer checks the row at commit (swarm.conversation_check_route).
CREATE FUNCTION swarm.conversation_prefile(p_workspace uuid, p_signal uuid, p_conversation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM swarm.signals AS s
    WHERE s.id = p_signal AND s.workspace_id = p_workspace
      AND s.creation_xact_id = pg_current_xact_id()
      AND s.creation_system_identifier = (SELECT system_identifier FROM pg_catalog.pg_control_system())) THEN
    RAISE EXCEPTION 'only a message posted in this transaction can be filed by its poster'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
  VALUES (p_signal, p_workspace, p_conversation, '-infinity', 'conversation');
END;
$$;

-- Before today's path posts to a set outside any channel: who left the newest generation of that set's
-- group, if anyone. The deferred filer refuses such a post anyway (step 1's group-leave fence); this
-- lets the edge say why.
CREATE FUNCTION swarm.conversation_group_departed(p_workspace uuid, p_actor_kind text, p_actor uuid,
  p_users uuid[], p_agents uuid[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Only a live sender of this workspace learns who left a group of its own set.
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent')
    OR NOT swarm.actor_can_access_channel(p_workspace, NULL, p_actor_kind, p_actor) THEN
    RETURN NULL;
  END IF;
  SELECT c.conversation_id INTO v_id
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace AND c.kind = 'group_dm'
    AND c.member_key = swarm.conversation_member_key(
      coalesce(p_users, '{}') || CASE WHEN p_actor_kind = 'user' THEN ARRAY[p_actor] ELSE '{}' END,
      coalesce(p_agents, '{}') || CASE WHEN p_actor_kind = 'agent' THEN ARRAY[p_actor] ELSE '{}' END)
  ORDER BY c.generation DESC LIMIT 1;
  RETURN CASE WHEN v_id IS NULL THEN NULL ELSE swarm.conversation_departed_name(v_id) END;
END;
$$;

-- Before a stored conversation answer is replayed: may the caller still open that conversation? The
-- same visibility the commands check (swarm.conversation_target).
CREATE FUNCTION swarm.conversation_visible(p_workspace uuid, p_actor_kind text, p_actor uuid, p_conversation uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce((SELECT t.visible
    FROM swarm.conversation_target(p_workspace, p_actor_kind, p_actor, p_conversation) AS t
    WHERE t.kind IS NOT NULL), false)
$$;

-- ---------------------------------------------------------------------------------------------------
-- The route rule for a message its poster filed in a 1:1 or group (audience 'conversation'). Raises,
-- aborting the transaction, unless the sender is a live member and the canonical address set is
-- exactly what the rule says. Takes the conversation FOR SHARE.
CREATE FUNCTION swarm.conversation_check_route(p_workspace uuid, p_signal uuid, p_conversation uuid) RETURNS void
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

-- Step 1's filer with one branch first: a row its poster filed in a 1:1 or group for audience
-- 'conversation', for a message new in this transaction, is checked by the route rule above and not
-- recomputed (recomputing would look for the conversation of the address set, which for an agent's
-- post or a group someone left is another set). Everything else is exactly step 1's check.
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

-- ---------------------------------------------------------------------------------------------------
-- Realtime.

-- Who hears that a message moved: the people who may read it, from its placement and audience (see the
-- header, point 4). Readers are chosen under the conversation's row lock (FOR SHARE), the lock every
-- membership change takes FOR UPDATE, so a reaction or post serialises with a leave or removal that is
-- in flight; the conversation's kind and channel are read from the locked row, so a channel made private
-- while this waits is read as private. A message with no placement (history only) locks its channel's or
-- #general's row; if it was for everyone it keeps its pre-2a audience, if it was addressed only its sender
-- and the people it was addressed to hear of it (never an agent's owner by ownership), and if it is a
-- thread reply, whose audience depends on a root that has no placement either, nobody hears of it here.
CREATE FUNCTION swarm.signal_frame_readers(p_workspace uuid, p_signal uuid) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_signal record;
  v_place record;
  v_kind text;
  v_conversation uuid;
  v_channel uuid;
  v_visibility text;
BEGIN
  SELECT s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id, s.channel_id, s.in_reply_to,
    s.thread_root_id, EXISTS (SELECT 1 FROM swarm.signal_recipients AS sr
      WHERE sr.signal_id = s.id AND sr.workspace_id = s.workspace_id) AS has_recipients
  INTO v_signal
  FROM swarm.signals AS s
  WHERE s.id = p_signal AND s.workspace_id = p_workspace;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT cs.audience, cs.conversation_id INTO v_place
  FROM swarm.conversation_signals AS cs
  WHERE cs.signal_id = p_signal AND cs.workspace_id = p_workspace;
  IF FOUND THEN
    v_conversation := v_place.conversation_id;
    SELECT c.kind, c.channel_id INTO v_kind, v_channel
    FROM swarm.conversations AS c
    WHERE c.conversation_id = v_conversation AND c.workspace_id = p_workspace
    FOR SHARE;
    IF v_channel IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('conversation-frames:' || p_workspace::text || ':' || v_channel::text, 0));
    END IF;
    IF v_place.audience = 'conversation' THEN
      IF v_kind IN ('general', 'public_channel') THEN
        RETURN QUERY SELECT m.user_id FROM swarm.memberships AS m
          WHERE m.workspace_id = p_workspace AND m.revoked_at IS NULL AND swarm.is_member(p_workspace, m.user_id);
      ELSIF v_kind = 'private_channel' THEN
        RETURN QUERY SELECT cm.user_id FROM swarm.channel_members AS cm
          WHERE cm.workspace_id = p_workspace AND cm.channel_id = v_channel AND cm.member_kind = 'user'
            AND swarm.actor_can_access_channel(p_workspace, v_channel, 'user', cm.user_id);
      ELSE
        RETURN QUERY SELECT m.member_user_id FROM swarm.conversation_members AS m
          WHERE m.conversation_id = v_conversation AND m.member_user_id IS NOT NULL
            AND m.left_at IS NULL AND swarm.is_member(p_workspace, m.member_user_id);
      END IF;
      RETURN;
    END IF;
  ELSE
    IF v_signal.thread_root_id IS NOT NULL THEN
      RETURN;
    END IF;
    v_channel := v_signal.channel_id;
    PERFORM 1 FROM swarm.conversations AS c
    WHERE c.workspace_id = p_workspace
      AND CASE WHEN v_signal.channel_id IS NULL THEN c.kind = 'general' ELSE c.conversation_id = v_signal.channel_id END
    FOR SHARE;
    IF v_signal.channel_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('conversation-frames:' || p_workspace::text || ':' || v_signal.channel_id::text, 0));
    END IF;
    IF v_signal.to_user_id IS NULL AND v_signal.to_agent_principal_id IS NULL AND v_signal.in_reply_to IS NULL
      AND NOT v_signal.has_recipients THEN
      IF v_signal.channel_id IS NOT NULL THEN
        SELECT c.visibility INTO v_visibility
        FROM swarm.channels AS c
        WHERE c.workspace_id = p_workspace AND c.channel_id = v_signal.channel_id;
        IF v_visibility = 'private' THEN
          RETURN QUERY SELECT cm.user_id FROM swarm.channel_members AS cm
            WHERE cm.workspace_id = p_workspace AND cm.channel_id = v_signal.channel_id AND cm.member_kind = 'user'
              AND swarm.actor_can_access_channel(p_workspace, v_signal.channel_id, 'user', cm.user_id);
          RETURN;
        ELSIF v_visibility IS DISTINCT FROM 'open' THEN
          RETURN;
        END IF;
      END IF;
      RETURN QUERY SELECT m.user_id FROM swarm.memberships AS m
        WHERE m.workspace_id = p_workspace AND m.revoked_at IS NULL AND swarm.is_member(p_workspace, m.user_id);
      RETURN;
    END IF;
  END IF;
  -- A narrower audience, placed or not: its sender and the people it is addressed to, who can still read
  -- where it is.
  RETURN QUERY
    SELECT DISTINCT a.user_id
    FROM (
      SELECT CASE WHEN v_signal.from_kind = 'user' THEN v_signal.from_principal END AS user_id
      UNION ALL SELECT v_signal.to_user_id
      UNION ALL SELECT sr.recipient_user_id FROM swarm.signal_recipients AS sr
        WHERE sr.signal_id = p_signal AND sr.workspace_id = p_workspace
    ) AS a
    WHERE a.user_id IS NOT NULL AND swarm.is_member(p_workspace, a.user_id)
      AND CASE
        WHEN v_kind IN ('dm', 'group_dm') THEN EXISTS (
          SELECT 1 FROM swarm.conversation_members AS m
          WHERE m.conversation_id = v_conversation AND m.member_user_id = a.user_id AND m.left_at IS NULL)
        WHEN v_channel IS NOT NULL THEN
          swarm.actor_can_access_channel(p_workspace, v_channel, 'user', a.user_id)
        ELSE true END;
END;
$$;

-- A bare {"v": 1} on each reader's own topic. Owned by postgres, which may write realtime.messages
-- (the rule of 20260906000010); a Realtime failure never fails the write that caused it.
CREATE FUNCTION swarm.send_signal_frames(p_workspace uuid, p_signal uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_readers uuid[];
  v_user uuid;
BEGIN
  v_readers := ARRAY(SELECT swarm.signal_frame_readers(p_workspace, p_signal));
  BEGIN
    FOREACH v_user IN ARRAY v_readers LOOP
      PERFORM realtime.send(pg_catalog.jsonb_build_object('v', 1), 'signal',
        'cswarm-member:' || p_workspace::text || ':' || v_user::text, true);
    END LOOP;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN;
  END;
END;
$fn$;

-- Step 1's commit-time trigger, plus the frames: sent once per new message, when its mapping row is
-- checked. That row is written after the message and its recipients (by the filer at commit, or by
-- the poster last), so its check is the final one; the backfill's rows are history and send nothing.
CREATE OR REPLACE FUNCTION swarm.file_signal_conversation_at_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'signals' THEN
    PERFORM swarm.file_conversation_signal(NEW.workspace_id, NEW.id);
  ELSE
    PERFORM swarm.file_conversation_signal(NEW.workspace_id, NEW.signal_id);
    IF TG_TABLE_NAME = 'conversation_signals' AND EXISTS (
      SELECT 1 FROM swarm.signals AS s
      WHERE s.id = NEW.signal_id AND s.workspace_id = NEW.workspace_id
        AND s.creation_xact_id = pg_current_xact_id()
        AND s.creation_system_identifier = (SELECT system_identifier FROM pg_catalog.pg_control_system())) THEN
      PERFORM swarm.send_signal_frames(NEW.workspace_id, NEW.signal_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- The workspace topic's emitter: nothing is sent there now.
DROP TRIGGER signals_wake_workspace ON swarm.signals;
DROP FUNCTION swarm.wake_workspace_signal();

-- Reactions: the same readers as the message, on their own topics.
CREATE OR REPLACE FUNCTION swarm.push_signal_reaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  r record;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
    PERFORM swarm.send_signal_frames(r.workspace_id, r.signal_id);
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  RETURN NULL;
END;
$fn$;

-- ---------------------------------------------------------------------------------------------------
-- Membership upkeep.

-- Lock every conversation of a workspace, in one order, before someone stops being able to read them:
-- public readers have no row of their own, so a post anywhere there serialises with the removal.
CREATE FUNCTION swarm.conversation_lock_workspace(p_workspace uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace
  ORDER BY c.conversation_id
  FOR UPDATE;
END;
$$;

-- A person: live joins #general (and only #general); not live leaves everything in the workspace,
-- with the agents they own there.
CREATE FUNCTION swarm.conversation_person_upkeep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_was boolean := false;
  v_is boolean := NEW.revoked_at IS NULL;
  v_general uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_was := OLD.revoked_at IS NULL;
  END IF;
  IF v_is AND NOT v_was THEN
    v_general := swarm.conversation_general(NEW.workspace_id);
    PERFORM 1 FROM swarm.conversations AS c WHERE c.conversation_id = v_general FOR UPDATE;
    PERFORM swarm.conversation_member_join(v_general, NEW.workspace_id, 'user', NEW.user_id);
  ELSIF v_was AND NOT v_is THEN
    PERFORM swarm.conversation_lock_workspace(NEW.workspace_id);
    UPDATE swarm.conversation_members AS m
    SET left_at = greatest(m.joined_at, statement_timestamp())
    WHERE m.workspace_id = NEW.workspace_id AND m.left_at IS NULL
      AND (m.member_user_id = NEW.user_id
        OR m.member_agent_principal_id IN (
          SELECT p.principal_id FROM swarm.agent_principals AS p WHERE p.owner_user_id = NEW.user_id));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER memberships_conversation_upkeep
  AFTER INSERT OR UPDATE OF revoked_at ON swarm.memberships
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_person_upkeep();

-- An agent: a seat (or its first workspace) that becomes live joins #general when the agent is live
-- there; a seat that ends leaves that workspace; an agent revoked leaves everywhere.
CREATE FUNCTION swarm.conversation_agent_upkeep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_row record;
  v_joins boolean := false;
  v_ends boolean := false;
  v_general uuid;
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_ends := true;
  ELSIF TG_OP = 'INSERT' THEN
    v_row := NEW;
    v_joins := NEW.revoked_at IS NULL;
  ELSE
    v_row := NEW;
    v_joins := OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL;
    v_ends := OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL;
  END IF;
  IF v_joins THEN
    IF swarm.actor_can_access_channel(v_row.workspace_id, NULL, 'agent', v_row.principal_id) THEN
      v_general := swarm.conversation_general(v_row.workspace_id);
      PERFORM 1 FROM swarm.conversations AS c WHERE c.conversation_id = v_general FOR UPDATE;
      PERFORM swarm.conversation_member_join(v_general, v_row.workspace_id, 'agent', v_row.principal_id);
    END IF;
  ELSIF v_ends AND TG_TABLE_NAME = 'agent_workspace_memberships' THEN
    PERFORM swarm.conversation_lock_workspace(v_row.workspace_id);
    UPDATE swarm.conversation_members AS m
    SET left_at = greatest(m.joined_at, statement_timestamp())
    WHERE m.workspace_id = v_row.workspace_id AND m.member_agent_principal_id = v_row.principal_id
      AND m.left_at IS NULL;
  ELSIF v_ends THEN
    FOR r IN
      SELECT DISTINCT m.workspace_id FROM swarm.conversation_members AS m
      WHERE m.member_agent_principal_id = v_row.principal_id AND m.left_at IS NULL
      ORDER BY m.workspace_id
    LOOP
      PERFORM swarm.conversation_lock_workspace(r.workspace_id);
    END LOOP;
    UPDATE swarm.conversation_members AS m
    SET left_at = greatest(m.joined_at, statement_timestamp())
    WHERE m.member_agent_principal_id = v_row.principal_id AND m.left_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;
-- Named to fire before the private-channel cleanup triggers on the same tables, so an agent's exit locks
-- conversation rows before channel-access, as a person's removal does.
CREATE TRIGGER agent_workspace_memberships_apply_conversations
  AFTER INSERT OR UPDATE OF revoked_at OR DELETE ON swarm.agent_workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_agent_upkeep();
CREATE TRIGGER agent_principals_apply_conversations
  AFTER INSERT OR UPDATE OF revoked_at ON swarm.agent_principals
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_agent_upkeep();

-- A public channel's creator is its first member. On the channel's insert, after its conversation exists
-- (trigger names fire in order: channels_sync_conversation, then this), so the backfill, which makes
-- conversations for channels that already exist, adds nobody this way.
CREATE FUNCTION swarm.conversation_creator_joins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM swarm.conversations AS c
      WHERE c.conversation_id = NEW.channel_id AND c.workspace_id = NEW.workspace_id AND c.kind = 'public_channel')
    AND swarm.actor_can_access_channel(NEW.workspace_id, NULL, NEW.created_by_kind, NEW.created_by_principal) THEN
    PERFORM swarm.conversation_member_join(NEW.channel_id, NEW.workspace_id, NEW.created_by_kind,
      NEW.created_by_principal);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER channels_sync_creator_member
  AFTER INSERT ON swarm.channels
  FOR EACH ROW WHEN (NEW.visibility = 'open') EXECUTE FUNCTION swarm.conversation_creator_joins();

-- A person leaving a private channel (channel_member_remove, channel_leave, workspace removal) takes the
-- channel's frame key exclusively; frame readers take it shared before they read the channel's members.
-- Both take it last of their locks (lock order: conversation rows, then channel-access, then this key), so
-- a post or reaction in flight either commits first or sees them gone, and the two never wait in a cycle.
CREATE FUNCTION swarm.conversation_private_member_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('conversation-frames:' || OLD.workspace_id::text || ':' || OLD.channel_id::text, 0));
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_members_lock_conversation
  AFTER DELETE ON swarm.channel_members
  FOR EACH ROW WHEN (OLD.member_kind = 'user') EXECUTE FUNCTION swarm.conversation_private_member_lock();

-- Every write of today's read positions, from any writer, is copied forward into conversation_reads.
-- A position with no message (a person's "through now", an agent's "through now" marker id) is kept
-- as a moment with no id.
CREATE FUNCTION swarm.conversation_reads_follow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_conversation uuid;
  v_last constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_id uuid := nullif(NEW.read_through_id, v_last);
BEGIN
  IF NEW.channel_id IS NULL THEN
    SELECT c.conversation_id INTO v_conversation
    FROM swarm.conversations AS c WHERE c.workspace_id = NEW.workspace_id AND c.kind = 'general';
  ELSE
    SELECT c.conversation_id INTO v_conversation
    FROM swarm.conversations AS c WHERE c.workspace_id = NEW.workspace_id AND c.conversation_id = NEW.channel_id;
  END IF;
  IF v_conversation IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'human_channel_reads' THEN
    IF NOT EXISTS (SELECT 1 FROM swarm.memberships AS m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id) THEN
      RETURN NULL;
    END IF;
    INSERT INTO swarm.conversation_reads AS r
      (conversation_id, workspace_id, member_user_id, read_through_at, read_through_id, first_read_at, updated_at)
    VALUES (v_conversation, NEW.workspace_id, NEW.user_id, NEW.read_through_at, v_id, NEW.first_read_at, NEW.updated_at)
    ON CONFLICT (conversation_id, member_user_id) DO UPDATE
      SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
        updated_at = excluded.updated_at
      WHERE excluded.read_through_at IS NOT NULL AND (r.read_through_at IS NULL
        OR (excluded.read_through_at, coalesce(excluded.read_through_id, v_last))
          > (r.read_through_at, coalesce(r.read_through_id, v_last)));
  ELSE
    INSERT INTO swarm.conversation_reads AS r
      (conversation_id, workspace_id, member_agent_principal_id, read_through_at, read_through_id, first_read_at, updated_at)
    VALUES (v_conversation, NEW.workspace_id, NEW.principal_id, NEW.read_through_at, v_id, NEW.first_read_at, NEW.updated_at)
    ON CONFLICT (conversation_id, member_agent_principal_id) DO UPDATE
      SET read_through_at = excluded.read_through_at, read_through_id = excluded.read_through_id,
        updated_at = excluded.updated_at
      WHERE excluded.read_through_at IS NOT NULL AND (r.read_through_at IS NULL
        OR (excluded.read_through_at, coalesce(excluded.read_through_id, v_last))
          > (r.read_through_at, coalesce(r.read_through_id, v_last)));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER human_channel_reads_follow_conversation
  AFTER INSERT OR UPDATE ON swarm.human_channel_reads
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_reads_follow();
CREATE TRIGGER agent_channel_reads_follow_conversation
  AFTER INSERT OR UPDATE ON swarm.agent_channel_reads
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_reads_follow();

-- Today's channel_preference_set (star, involvement) is copied onto the person's live member row.
CREATE FUNCTION swarm.conversation_preferences_follow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE swarm.conversation_members AS m
  SET notify_level = NEW.involvement, starred = NEW.starred, star_rank = NEW.star_rank
  FROM swarm.conversations AS c
  WHERE c.conversation_id = m.conversation_id AND c.workspace_id = NEW.workspace_id
    AND (CASE WHEN NEW.channel_id IS NULL THEN c.kind = 'general' ELSE c.conversation_id = NEW.channel_id END)
    AND m.member_user_id = NEW.user_id AND m.left_at IS NULL
    AND (m.notify_level, m.starred, m.star_rank) IS DISTINCT FROM (NEW.involvement, NEW.starred, NEW.star_rank);
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_preferences_follow_conversation
  AFTER INSERT OR UPDATE ON swarm.channel_preferences
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_preferences_follow();

-- ---------------------------------------------------------------------------------------------------
-- Ownership and grants: everything is swarm_admin's except the Realtime sender (postgres, see above).
-- The edge (swarm_command) may call the command functions and nothing else; no client role may call
-- anything here.

ALTER FUNCTION swarm.conversation_member_join(uuid, uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_member_leave(uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_target(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_departed_name(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_member_key(uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_next_generation(uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_live_members(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_open(uuid, text, uuid, uuid[], uuid[], boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_join(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_leave(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_invite(uuid, text, uuid, uuid, uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_remove(uuid, text, uuid, uuid, text, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_mark_read(uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_set_notify(uuid, text, uuid, uuid, text, boolean, integer) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_post_route(uuid, text, uuid, uuid, uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_prefile(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_group_departed(uuid, text, uuid, uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_check_route(uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_visible(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_private_member_lock() OWNER TO swarm_admin;
ALTER FUNCTION swarm.signal_frame_readers(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.send_signal_frames(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION swarm.conversation_lock_workspace(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_person_upkeep() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_agent_upkeep() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_creator_joins() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_reads_follow() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_preferences_follow() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.conversation_member_join(uuid, uuid, text, uuid),
  swarm.conversation_member_leave(uuid, text, uuid), swarm.conversation_target(uuid, text, uuid, uuid),
  swarm.conversation_departed_name(uuid), swarm.conversation_member_key(uuid[], uuid[]),
  swarm.conversation_next_generation(uuid, text, uuid), swarm.conversation_live_members(uuid),
  swarm.conversation_open(uuid, text, uuid, uuid[], uuid[], boolean), swarm.conversation_join(uuid, text, uuid, uuid),
  swarm.conversation_leave(uuid, text, uuid, uuid), swarm.conversation_invite(uuid, text, uuid, uuid, uuid[], uuid[]),
  swarm.conversation_remove(uuid, text, uuid, uuid, text, uuid),
  swarm.conversation_mark_read(uuid, text, uuid, uuid, uuid),
  swarm.conversation_set_notify(uuid, text, uuid, uuid, text, boolean, integer),
  swarm.conversation_post_route(uuid, text, uuid, uuid, uuid[], uuid[]), swarm.conversation_prefile(uuid, uuid, uuid),
  swarm.conversation_group_departed(uuid, text, uuid, uuid[], uuid[]), swarm.conversation_check_route(uuid, uuid, uuid),
  swarm.conversation_visible(uuid, text, uuid, uuid), swarm.conversation_private_member_lock(),
  swarm.signal_frame_readers(uuid, uuid), swarm.send_signal_frames(uuid, uuid),
  swarm.conversation_lock_workspace(uuid), swarm.conversation_person_upkeep(), swarm.conversation_agent_upkeep(),
  swarm.conversation_creator_joins(), swarm.conversation_reads_follow(), swarm.conversation_preferences_follow()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.send_signal_frames(uuid, uuid) TO swarm_admin;
GRANT EXECUTE ON FUNCTION swarm.conversation_open(uuid, text, uuid, uuid[], uuid[], boolean),
  swarm.conversation_join(uuid, text, uuid, uuid), swarm.conversation_leave(uuid, text, uuid, uuid),
  swarm.conversation_invite(uuid, text, uuid, uuid, uuid[], uuid[]),
  swarm.conversation_remove(uuid, text, uuid, uuid, text, uuid),
  swarm.conversation_mark_read(uuid, text, uuid, uuid, uuid),
  swarm.conversation_set_notify(uuid, text, uuid, uuid, text, boolean, integer),
  swarm.conversation_post_route(uuid, text, uuid, uuid, uuid[], uuid[]), swarm.conversation_prefile(uuid, uuid, uuid),
  swarm.conversation_group_departed(uuid, text, uuid, uuid[], uuid[]),
  swarm.conversation_visible(uuid, text, uuid, uuid)
TO swarm_command;

-- ---------------------------------------------------------------------------------------------------
-- Release. Since step 1: anyone no longer live in a workspace leaves its conversations; messages, read
-- marks and new people are brought in by the backfill, which runs here for the last time.
UPDATE swarm.conversation_members AS m
SET left_at = greatest(m.joined_at, statement_timestamp())
WHERE m.left_at IS NULL
  AND CASE WHEN m.member_user_id IS NOT NULL
    THEN NOT EXISTS (SELECT 1 FROM swarm.memberships AS wm
      WHERE wm.workspace_id = m.workspace_id AND wm.user_id = m.member_user_id AND wm.revoked_at IS NULL)
    ELSE NOT swarm.actor_can_access_channel(m.workspace_id, NULL, 'agent', m.member_agent_principal_id) END;
SELECT swarm.conversations_backfill();
RESET search_path;
