-- Real direct messages, step 1 of 5: conversation tables, the filer, and the backfill.
--
-- A direct message (an unfiled, addressed message) becomes part of a conversation for its sender and
-- recipients: a 1:1 ('dm') or a group of up to nine ('group': the sender plus the existing eight-
-- recipient cap, swarm.signal_recipients.position 0..7). The same founding set always reuses one
-- conversation (member_key). Members may later leave a group or mute a 1:1 (left_at, muted_at; the
-- edge enforces which, owner decision 2026-11-17).
--
-- swarm.signals is append-only (signals_append_only), so a message's conversation is NOT a column on
-- signals: it is a row in swarm.conversation_signals, itself insert-only. Filing never changes an
-- existing row anywhere, and the rollback drops only what this file creates.
--
-- This step is inert: no view, no read rule, no client grant, no unread state and no realtime change.
-- Nothing reads these tables yet; delivery, wake, receipts and every existing read are unchanged.
-- swarm.file_direct_messages() files every unfiled direct message posted so far and is safe to run
-- again: the edge release (step 2) runs it once more to file the ones posted in between.
--
-- What counts, matching swarm_read.signals' addressed arm and the web's directConversationFilter:
-- channel_id IS NULL, thread_root_id IS NULL, and to_user_id, to_agent_principal_id or a
-- swarm.signal_recipients row. @mentions and lead routing write swarm.signal_mentions, never these,
-- so #general posts stay out. A thread reply is filed in its root's conversation when the root is
-- filed, and never otherwise.
--
-- Rollback: deploy/release-proofs/conversations/20261118000002-rollback.sql.
SET search_path = swarm, pg_catalog, public;

CREATE TABLE swarm.conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  kind text NOT NULL CHECK (kind IN ('dm', 'group')),
  -- sha256 of the founding member set, each id tagged u: or a:, sorted, comma-joined. Never
  -- recomputed when someone leaves, so a group that loses a member never collides with a 1:1.
  member_key text NOT NULL CHECK (member_key ~ '^[0-9a-f]{64}$'),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_principal uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, member_key),
  UNIQUE (conversation_id, workspace_id)
);

CREATE TABLE swarm.conversation_members (
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  member_user_id uuid,
  member_agent_principal_id uuid,
  joined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  left_at timestamptz,
  muted_at timestamptz,
  CHECK (num_nonnulls(member_user_id, member_agent_principal_id) = 1),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  UNIQUE (conversation_id, member_user_id),
  UNIQUE (conversation_id, member_agent_principal_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES swarm.conversations (conversation_id, workspace_id),
  FOREIGN KEY (workspace_id, member_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id),
  -- An agent may belong to another workspace first (agent_workspace_memberships), so its row is
  -- pinned by principal alone; the read rule (step 2) asks for its live seat in this workspace.
  FOREIGN KEY (member_agent_principal_id)
    REFERENCES swarm.agent_principals (principal_id)
);
CREATE INDEX conversation_members_user
  ON swarm.conversation_members (workspace_id, member_user_id) WHERE member_user_id IS NOT NULL;
CREATE INDEX conversation_members_agent
  ON swarm.conversation_members (member_agent_principal_id) WHERE member_agent_principal_id IS NOT NULL;

-- Which conversation a message belongs to. One per message; insert-only, like swarm.signals.
CREATE TABLE swarm.conversation_signals (
  signal_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- The message's own created_at, copied by the trigger below, so a conversation pages from one index.
  created_at timestamptz NOT NULL,
  FOREIGN KEY (signal_id, workspace_id) REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES swarm.conversations (conversation_id, workspace_id)
);
CREATE INDEX conversation_signals_page
  ON swarm.conversation_signals (conversation_id, created_at DESC, signal_id DESC);

CREATE TRIGGER conversation_signals_append_only
  BEFORE UPDATE OR DELETE ON swarm.conversation_signals
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

-- A filed message is never in a channel, and its row carries the message's own time.
CREATE FUNCTION swarm.conversation_signal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_channel uuid;
  v_created timestamptz;
BEGIN
  SELECT s.channel_id, s.created_at INTO v_channel, v_created
  FROM swarm.signals AS s
  WHERE s.id = NEW.signal_id AND s.workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation message not found' USING ERRCODE = '23503';
  END IF;
  IF v_channel IS NOT NULL THEN
    RAISE EXCEPTION 'a channel message cannot join a conversation' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := v_created;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_signals_guard
  BEFORE INSERT ON swarm.conversation_signals
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_signal_guard();

-- Find or create the conversation for a founding set: the creator plus the people and agents named.
-- Duplicates and the creator named again collapse. Returns null for an empty or oversized set, so
-- the caller decides what an unfilable message means. The one place member_key is computed: the
-- backfill below and the edge (step 2) both call it.
CREATE FUNCTION swarm.conversation_for_members(
  p_workspace uuid, p_creator_kind text, p_creator uuid, p_users uuid[], p_agents uuid[]
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_users uuid[];
  v_agents uuid[];
  v_key text;
  v_count integer;
  v_id uuid;
BEGIN
  IF p_workspace IS NULL OR p_creator IS NULL OR p_creator_kind NOT IN ('user', 'agent') THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}') INTO v_users
  FROM unnest(coalesce(p_users, '{}') || CASE WHEN p_creator_kind = 'user' THEN ARRAY[p_creator] ELSE '{}' END) AS u
  WHERE u IS NOT NULL;
  SELECT coalesce(array_agg(DISTINCT a ORDER BY a), '{}') INTO v_agents
  FROM unnest(coalesce(p_agents, '{}') || CASE WHEN p_creator_kind = 'agent' THEN ARRAY[p_creator] ELSE '{}' END) AS a
  WHERE a IS NOT NULL;
  v_count := cardinality(v_users) + cardinality(v_agents);
  IF v_count = 0 OR v_count > 9 THEN
    RETURN NULL;
  END IF;
  SELECT encode(sha256(convert_to(string_agg(tagged, ',' ORDER BY tagged), 'UTF8')), 'hex') INTO v_key
  FROM (
    SELECT 'u:' || u::text AS tagged FROM unnest(v_users) AS u
    UNION ALL
    SELECT 'a:' || a::text FROM unnest(v_agents) AS a
  ) AS members;

  INSERT INTO swarm.conversations (workspace_id, kind, member_key, created_by_kind, created_by_principal)
  VALUES (p_workspace, CASE WHEN v_count <= 2 THEN 'dm' ELSE 'group' END, v_key, p_creator_kind, p_creator)
  ON CONFLICT (workspace_id, member_key) DO NOTHING
  RETURNING conversation_id INTO v_id;
  IF v_id IS NULL THEN
    SELECT c.conversation_id INTO v_id
    FROM swarm.conversations AS c
    WHERE c.workspace_id = p_workspace AND c.member_key = v_key;
    RETURN v_id;
  END IF;
  INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id)
  SELECT v_id, p_workspace, u FROM unnest(v_users) AS u;
  INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_agent_principal_id)
  SELECT v_id, p_workspace, a FROM unnest(v_agents) AS a;
  RETURN v_id;
END;
$$;

-- File every direct message not yet filed: roots first, then the thread replies under filed roots.
-- Idempotent. A message whose founding set cannot be filed (oversized, or a member that no longer
-- resolves) stays unfiled and readable exactly as today. Returns how many messages it filed.
CREATE FUNCTION swarm.file_direct_messages() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r record;
  v_conversation uuid;
  v_filed bigint := 0;
  v_replies bigint;
BEGIN
  FOR r IN
    SELECT s.id, s.workspace_id, s.from_kind, s.from_principal,
      array_remove(ARRAY[s.to_user_id] || coalesce(array_agg(sr.recipient_user_id), '{}'), NULL) AS users,
      array_remove(ARRAY[s.to_agent_principal_id] || coalesce(array_agg(sr.recipient_agent_principal_id), '{}'), NULL) AS agents
    FROM swarm.signals AS s
    LEFT JOIN swarm.signal_recipients AS sr
      ON sr.workspace_id = s.workspace_id AND sr.signal_id = s.id
    WHERE s.channel_id IS NULL AND s.thread_root_id IS NULL
      AND (s.to_user_id IS NOT NULL OR s.to_agent_principal_id IS NOT NULL OR sr.signal_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM swarm.conversation_signals AS cs WHERE cs.signal_id = s.id)
    GROUP BY s.id
    ORDER BY s.created_at, s.id
  LOOP
    -- Every member must still resolve for the foreign keys; one that does not leaves this message as is.
    IF EXISTS (SELECT 1 FROM unnest(r.users || CASE WHEN r.from_kind = 'user' THEN ARRAY[r.from_principal] ELSE '{}' END) AS u
        WHERE NOT EXISTS (SELECT 1 FROM swarm.memberships AS m WHERE m.workspace_id = r.workspace_id AND m.user_id = u))
      OR EXISTS (SELECT 1 FROM unnest(r.agents || CASE WHEN r.from_kind = 'agent' THEN ARRAY[r.from_principal] ELSE '{}' END) AS a
        WHERE NOT EXISTS (SELECT 1 FROM swarm.agent_principals AS p WHERE p.principal_id = a)) THEN
      CONTINUE;
    END IF;
    v_conversation := swarm.conversation_for_members(r.workspace_id, r.from_kind, r.from_principal, r.users, r.agents);
    IF v_conversation IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at)
    VALUES (r.id, r.workspace_id, v_conversation, '-infinity');
    v_filed := v_filed + 1;
  END LOOP;

  INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at)
  SELECT s.id, s.workspace_id, root.conversation_id, '-infinity'
  FROM swarm.signals AS s
  JOIN swarm.conversation_signals AS root
    ON root.signal_id = s.thread_root_id AND root.workspace_id = s.workspace_id
  WHERE s.thread_root_id IS NOT NULL AND s.channel_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM swarm.conversation_signals AS cs WHERE cs.signal_id = s.id)
  ORDER BY s.created_at, s.id;
  GET DIAGNOSTICS v_replies = ROW_COUNT;
  RETURN v_filed + v_replies;
END;
$$;

ALTER TABLE swarm.conversations OWNER TO swarm_admin;
ALTER TABLE swarm.conversation_members OWNER TO swarm_admin;
ALTER TABLE swarm.conversation_signals OWNER TO swarm_admin;
ALTER TABLE swarm.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.conversation_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE swarm.conversations, swarm.conversation_members, swarm.conversation_signals
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

ALTER FUNCTION swarm.conversation_signal_guard() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_for_members(uuid, text, uuid, uuid[], uuid[]) OWNER TO swarm_admin;
ALTER FUNCTION swarm.file_direct_messages() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.conversation_signal_guard(), swarm.conversation_for_members(uuid, text, uuid, uuid[], uuid[]),
  swarm.file_direct_messages()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

SELECT swarm.file_direct_messages();
RESET search_path;
