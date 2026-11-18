-- Conversations, step 1 of 6: one model for #general, channels, DMs and group DMs. Schema, filing and
-- backfill only; inert.
--
-- Every message belongs to at most one conversation. A message posted from now on is filed at commit,
-- unless a member of its set does not resolve (then it stays unmapped, as such history does). A conversation is a workspace's one #general ('general'), a channel ('public_channel' or
-- 'private_channel'; its conversation id IS its channel_id), a 1:1 ('dm', or a note to oneself) or a
-- group of three to nine ('group_dm': the sender plus the existing eight-recipient cap).
--
-- swarm.signals is append-only (signals_append_only), so a message's conversation is NOT a column on
-- signals: it is a row in swarm.conversation_signals, itself insert-only. The row also records the
-- message's audience, which never changes: 'conversation' (everyone who may read the conversation) or
-- 'addressed' (the sender and the message's own recipients). Placement says where a message lives;
-- audience says who may read it. Nothing reads either yet.
--
-- Filing. A deferred constraint trigger files each new message at commit, after its recipient rows
-- exist, by one rule (swarm.conversation_placement):
--   1. a message in a channel, in that channel's conversation;
--   2. a thread reply, in its root's conversation, with its OWN audience;
--   3. an unaddressed message (mentions do not address), in #general;
--   4. an addressed message, in the 1:1 or group of its sender and canonical recipients: the scalar
--      recipient and swarm.signal_recipients merged, overlap removed, each id tagged u: or a:.
-- A mapping row that already exists (a later edge may write one) is recomputed and must match; so must
-- one written for an older message. Any mismatch aborts the whole transaction, and so does an addressed
-- post to the founding set of a group someone has left (the group-leave fence): the deliveries and
-- realtime frames its earlier triggers queued roll back with it. A message whose set cannot be filed (a
-- member that does not resolve, or more than nine) stays unmapped, and the legacy read rule keeps
-- serving it exactly as today; the release proof counts them.
--
-- Membership (swarm.conversation_members) is of record for 'general', 'public_channel', 'dm' and
-- 'group_dm'. Private channels keep swarm.channel_members until they move (step 5). The backfill
-- follows the owner's decision "it should work like Slack": every live person joins #general and every
-- existing public channel; an agent with a live seat joins #general, and a public channel only where it
-- leads, has posted or has a read mark; a 1:1 or group has its founding members. Read marks
-- (swarm.conversation_reads) are copied from both channel read tables; a NULL channel there is #general.
-- swarm.conversations_backfill() is idempotent; the edge release (step 2) runs it again.
--
-- Inert: every new object is owned by swarm_admin with RLS on, and no client role can read, write or
-- call any of it. No read rule, grant, edge, realtime or wake change: the edge keeps posting exactly as
-- today and the triggers do the filing.
--
-- Rollback: deploy/release-proofs/conversations/20261118000004-rollback.sql (backup first).
SET search_path = swarm, pg_catalog, public;

CREATE TABLE swarm.conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('general', 'public_channel', 'private_channel', 'dm', 'group_dm')),
  -- A channel's conversation id is its channel_id; this column pins it to that channel.
  channel_id uuid GENERATED ALWAYS AS (
    CASE WHEN kind IN ('public_channel', 'private_channel') THEN conversation_id END) STORED,
  -- 1:1s and groups only: sha256 of the founding set, each id tagged u: or a:, sorted, comma-joined.
  -- Never recomputed when someone leaves. Only an explicit new-group action (a later step) may start
  -- a new generation for the same set.
  member_key text CHECK (member_key ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_principal uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  CHECK ((kind IN ('dm', 'group_dm')) = (member_key IS NOT NULL)),
  CHECK (kind IN ('dm', 'group_dm') OR generation = 0),
  CHECK (kind IN ('public_channel', 'private_channel') OR archived_at IS NULL),
  UNIQUE (conversation_id, workspace_id),
  UNIQUE (workspace_id, member_key, generation),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES swarm.channels (channel_id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX conversations_one_general ON swarm.conversations (workspace_id) WHERE kind = 'general';

-- A conversation's identity is fixed. Only a channel's kind follows its visibility, and never from
-- private back to public (channels_forbid_private_reopen).
CREATE FUNCTION swarm.conversation_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.member_key IS DISTINCT FROM OLD.member_key
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind
    OR NEW.created_by_principal IS DISTINCT FROM OLD.created_by_principal
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.kind IS DISTINCT FROM OLD.kind
      AND NOT (OLD.kind = 'public_channel' AND NEW.kind = 'private_channel')) THEN
    RAISE EXCEPTION 'a conversation''s identity and kind are fixed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversations_identity_fixed
  BEFORE UPDATE ON swarm.conversations
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_identity_guard();

CREATE TABLE swarm.conversation_members (
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  member_user_id uuid,
  member_agent_principal_id uuid,
  joined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  left_at timestamptz,
  notify_level text NOT NULL DEFAULT 'everything' CHECK (notify_level IN ('everything', 'mentions', 'muted')),
  starred boolean NOT NULL DEFAULT false,
  star_rank integer CHECK (star_rank IS NULL OR star_rank >= 0),
  CHECK (num_nonnulls(member_user_id, member_agent_principal_id) = 1),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  CHECK ((starred = false AND star_rank IS NULL) OR (starred = true AND star_rank IS NOT NULL)),
  UNIQUE (conversation_id, member_user_id),
  UNIQUE (conversation_id, member_agent_principal_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES swarm.conversations (conversation_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, member_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id) ON DELETE CASCADE,
  -- An agent may have its first workspace elsewhere, so its row is pinned by principal alone; a reader
  -- (step 3) asks for its live seat in this workspace.
  FOREIGN KEY (member_agent_principal_id)
    REFERENCES swarm.agent_principals (principal_id) ON DELETE CASCADE
);
CREATE INDEX conversation_members_user
  ON swarm.conversation_members (workspace_id, member_user_id) WHERE member_user_id IS NOT NULL;
CREATE INDEX conversation_members_agent
  ON swarm.conversation_members (member_agent_principal_id) WHERE member_agent_principal_id IS NOT NULL;

-- Private channels keep swarm.channel_members until step 5; nothing duplicates them here.
CREATE FUNCTION swarm.conversation_member_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM swarm.conversations AS c
      WHERE c.conversation_id = NEW.conversation_id AND c.kind = 'private_channel') THEN
    RAISE EXCEPTION 'a private channel''s members are in swarm.channel_members' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_members_not_private
  BEFORE INSERT OR UPDATE OF conversation_id ON swarm.conversation_members
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_member_guard();

-- Which conversation a message belongs to, and who it is for. One per message; insert-only, like
-- swarm.signals.
CREATE TABLE swarm.conversation_signals (
  signal_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- The message's own created_at, copied by the guard below, so a conversation pages from one index.
  created_at timestamptz NOT NULL,
  audience text NOT NULL CHECK (audience IN ('conversation', 'addressed')),
  FOREIGN KEY (signal_id, workspace_id) REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES swarm.conversations (conversation_id, workspace_id)
);
CREATE INDEX conversation_signals_page
  ON swarm.conversation_signals (conversation_id, created_at DESC, signal_id DESC);

CREATE TRIGGER conversation_signals_append_only
  BEFORE UPDATE OR DELETE ON swarm.conversation_signals
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

CREATE FUNCTION swarm.conversation_signal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_created timestamptz;
BEGIN
  SELECT s.created_at INTO v_created
  FROM swarm.signals AS s
  WHERE s.id = NEW.signal_id AND s.workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation message not found' USING ERRCODE = '23503';
  END IF;
  NEW.created_at := v_created;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_signals_guard
  BEFORE INSERT ON swarm.conversation_signals
  FOR EACH ROW EXECUTE FUNCTION swarm.conversation_signal_guard();

-- A member's read position in a conversation; replaces human_channel_reads and agent_channel_reads.
CREATE TABLE swarm.conversation_reads (
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  member_user_id uuid,
  member_agent_principal_id uuid,
  read_through_at timestamptz,
  read_through_id uuid,
  first_read_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (num_nonnulls(member_user_id, member_agent_principal_id) = 1),
  CHECK (read_through_id IS NULL OR read_through_at IS NOT NULL),
  UNIQUE (conversation_id, member_user_id),
  UNIQUE (conversation_id, member_agent_principal_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES swarm.conversations (conversation_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, member_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (member_agent_principal_id)
    REFERENCES swarm.agent_principals (principal_id) ON DELETE CASCADE
);

-- A workspace's #general, made if it is missing.
CREATE FUNCTION swarm.conversation_general(p_workspace uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT c.conversation_id INTO v_id
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace AND c.kind = 'general';
  IF FOUND THEN
    RETURN v_id;
  END IF;
  INSERT INTO swarm.conversations (workspace_id, kind, created_by_kind, created_by_principal, created_at)
  SELECT w.workspace_id, 'general', 'user', w.created_by, w.created_at
  FROM swarm.workspaces AS w
  WHERE w.workspace_id = p_workspace
  ON CONFLICT (workspace_id) WHERE kind = 'general' DO NOTHING;
  SELECT c.conversation_id INTO v_id
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace AND c.kind = 'general';
  RETURN v_id;
END;
$$;

-- A channel's conversation (same id), made or brought up to date from the channel: kind follows
-- visibility (channels.visibility stays authoritative until step 5) and archive follows archive. A
-- channel that turns private keeps its members in swarm.channel_members only.
CREATE FUNCTION swarm.conversation_for_channel(p_workspace uuid, p_channel uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_channel record;
  v_kind text;
BEGIN
  SELECT c.visibility, c.archived_at, c.created_by_kind, c.created_by_principal, c.created_at
  INTO v_channel
  FROM swarm.channels AS c
  WHERE c.workspace_id = p_workspace AND c.channel_id = p_channel;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_kind := CASE WHEN v_channel.visibility = 'private' THEN 'private_channel' ELSE 'public_channel' END;
  INSERT INTO swarm.conversations
    (conversation_id, workspace_id, kind, created_by_kind, created_by_principal, created_at, archived_at)
  VALUES (p_channel, p_workspace, v_kind, v_channel.created_by_kind, v_channel.created_by_principal,
    v_channel.created_at, v_channel.archived_at)
  ON CONFLICT (conversation_id) DO UPDATE SET kind = EXCLUDED.kind, archived_at = EXCLUDED.archived_at
  WHERE (swarm.conversations.kind, swarm.conversations.archived_at)
    IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.archived_at);
  IF v_kind = 'private_channel' THEN
    DELETE FROM swarm.conversation_members AS m WHERE m.conversation_id = p_channel;
  END IF;
  RETURN p_channel;
END;
$$;

-- Find or create the 1:1 or group for a founding set: the creator plus the people and agents named.
-- Duplicates and the creator named again collapse. p_latest picks the newest generation (new posts)
-- instead of the founding one (history). Returns null for an empty or oversized set; the caller
-- resolves members first, since the foreign keys need them.
CREATE FUNCTION swarm.conversation_for_members(
  p_workspace uuid, p_creator_kind text, p_creator uuid, p_users uuid[], p_agents uuid[],
  p_latest boolean, p_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_users uuid[];
  v_agents uuid[];
  v_key text;
  v_count integer;
  v_id uuid;
BEGIN
  IF p_workspace IS NULL OR p_creator IS NULL OR p_creator_kind IS NULL
    OR p_creator_kind NOT IN ('user', 'agent') THEN
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

  SELECT c.conversation_id INTO v_id
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace AND c.member_key = v_key AND (p_latest OR c.generation = 0)
  ORDER BY c.generation DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN v_id;
  END IF;
  INSERT INTO swarm.conversations
    (workspace_id, kind, member_key, generation, created_by_kind, created_by_principal, created_at)
  VALUES (p_workspace, CASE WHEN v_count <= 2 THEN 'dm' ELSE 'group_dm' END, v_key, 0, p_creator_kind,
    p_creator, coalesce(p_at, statement_timestamp()))
  ON CONFLICT (workspace_id, member_key, generation) DO NOTHING
  RETURNING conversation_id INTO v_id;
  IF v_id IS NULL THEN
    -- Another transaction made it first.
    SELECT c.conversation_id INTO v_id
    FROM swarm.conversations AS c
    WHERE c.workspace_id = p_workspace AND c.member_key = v_key AND (p_latest OR c.generation = 0)
    ORDER BY c.generation DESC
    LIMIT 1;
    RETURN v_id;
  END IF;
  INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_user_id, joined_at)
  SELECT v_id, p_workspace, u, coalesce(p_at, statement_timestamp()) FROM unnest(v_users) AS u;
  INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_agent_principal_id, joined_at)
  SELECT v_id, p_workspace, a, coalesce(p_at, statement_timestamp()) FROM unnest(v_agents) AS a;
  RETURN v_id;
END;
$$;

-- Where a message belongs and who it is for, from its final rows. p_new: the message was created in
-- this transaction, so the group-leave fence applies and a group's newest generation is used; history
-- (p_new false) uses the founding generation and never raises. A message that cannot be placed returns
-- a null conversation and the reason. A new message that breaks a rule raises, aborting its transaction.
CREATE FUNCTION swarm.conversation_placement(p_workspace uuid, p_signal uuid, p_new boolean,
  OUT conversation_id uuid, OUT audience text, OUT unplaced text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_signal record;
  v_users uuid[];
  v_agents uuid[];
  v_root uuid;
  v_kind text;
  v_agent uuid;
BEGIN
  SELECT s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id, s.channel_id,
    s.thread_root_id, s.created_at
  INTO v_signal
  FROM swarm.signals AS s
  WHERE s.id = p_signal AND s.workspace_id = p_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation message % not found in its workspace', p_signal USING ERRCODE = '23503';
  END IF;

  -- The canonical recipients: the scalar column and every recipient row, each id once.
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
  audience := CASE WHEN cardinality(v_users) + cardinality(v_agents) > 0 THEN 'addressed' ELSE 'conversation' END;

  IF v_signal.thread_root_id IS NOT NULL THEN
    SELECT cs.conversation_id INTO v_root
    FROM swarm.conversation_signals AS cs
    JOIN swarm.conversations AS c
      ON c.conversation_id = cs.conversation_id AND c.workspace_id = p_workspace
    WHERE cs.signal_id = v_signal.thread_root_id AND cs.workspace_id = p_workspace;
  END IF;

  IF v_signal.channel_id IS NOT NULL THEN
    -- 1. A channel message: its channel's conversation. A reply there must share its root's.
    SELECT c.conversation_id INTO conversation_id
    FROM swarm.conversations AS c
    WHERE c.conversation_id = v_signal.channel_id AND c.workspace_id = p_workspace
      AND c.kind IN ('public_channel', 'private_channel');
    IF NOT FOUND THEN
      conversation_id := swarm.conversation_for_channel(p_workspace, v_signal.channel_id);
    END IF;
    IF conversation_id IS NULL THEN
      RAISE EXCEPTION 'channel % has no conversation in its workspace', v_signal.channel_id USING ERRCODE = '23503';
    END IF;
    IF v_signal.thread_root_id IS NOT NULL AND v_root IS DISTINCT FROM conversation_id THEN
      IF p_new THEN
        RAISE EXCEPTION 'a thread reply belongs in its root''s conversation'
          USING ERRCODE = '23514', CONSTRAINT = 'conversation_signals_placement';
      END IF;
      conversation_id := NULL;
      audience := NULL;
      unplaced := 'reply_outside_root';
      RETURN;
    END IF;
  ELSIF v_signal.thread_root_id IS NOT NULL THEN
    -- 2. A thread reply: its root's conversation, with its own audience.
    IF v_root IS NULL THEN
      audience := NULL;
      unplaced := 'root_unfiled';
      RETURN;
    END IF;
    conversation_id := v_root;
  ELSIF audience = 'conversation' THEN
    -- 3. Unaddressed (mentions do not address): #general.
    conversation_id := swarm.conversation_general(p_workspace);
    IF conversation_id IS NULL THEN
      RAISE EXCEPTION 'workspace % has no #general', p_workspace USING ERRCODE = '23503';
    END IF;
  ELSE
    -- 4. Addressed: the 1:1 or group of the sender and recipients. Every member must resolve in this
    -- workspace, or the message stays unmapped: it fails closed, and never lands in #general.
    IF v_signal.from_kind = 'user' THEN
      v_users := v_users || v_signal.from_principal;
    ELSE
      v_agents := v_agents || v_signal.from_principal;
    END IF;
    SELECT coalesce(array_agg(DISTINCT u), '{}') INTO v_users FROM unnest(v_users) AS u;
    SELECT coalesce(array_agg(DISTINCT a), '{}') INTO v_agents FROM unnest(v_agents) AS a;
    IF cardinality(v_users) + cardinality(v_agents) > 9 THEN
      audience := NULL;
      unplaced := 'over_nine';
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_users) AS u
        WHERE NOT EXISTS (SELECT 1 FROM swarm.memberships AS m
          WHERE m.workspace_id = p_workspace AND m.user_id = u)) THEN
      audience := NULL;
      unplaced := 'member_unresolved';
      RETURN;
    END IF;
    -- An agent resolves in this workspace by its first workspace or a seat here, live or not.
    FOREACH v_agent IN ARRAY v_agents LOOP
      IF NOT EXISTS (SELECT 1 FROM swarm.agent_principals AS p
          WHERE p.principal_id = v_agent AND p.workspace_id = p_workspace) THEN
        IF to_regclass('swarm.agent_workspace_memberships') IS NULL THEN
          audience := NULL;
          unplaced := 'member_unresolved';
          RETURN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships AS seat
            WHERE seat.principal_id = v_agent AND seat.workspace_id = p_workspace) THEN
          audience := NULL;
          unplaced := 'member_unresolved';
          RETURN;
        END IF;
      END IF;
    END LOOP;
    conversation_id := swarm.conversation_for_members(p_workspace, v_signal.from_kind, v_signal.from_principal,
      v_users, v_agents, p_new, CASE WHEN p_new THEN NULL ELSE v_signal.created_at END);
    IF conversation_id IS NULL THEN
      audience := NULL;
      unplaced := 'member_unresolved';
      RETURN;
    END IF;
  END IF;

  IF p_new THEN
    -- A new post holds its conversation FOR SHARE until commit; membership and visibility changes
    -- take it FOR UPDATE, so the two serialise.
    SELECT c.kind INTO v_kind
    FROM swarm.conversations AS c
    WHERE c.conversation_id = conversation_placement.conversation_id
    FOR SHARE;
    -- The group-leave fence: a post filed by the rules above into a group someone has left (its
    -- founding set, or a reply under one of its messages) is refused, so an old edge or CLI can
    -- neither deliver to them nor quietly reopen the group.
    IF v_kind = 'group_dm'
      AND EXISTS (SELECT 1 FROM swarm.conversation_members AS m
        WHERE m.conversation_id = conversation_placement.conversation_id AND m.left_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a member left this group conversation'
        USING ERRCODE = '23514', CONSTRAINT = 'conversation_group_member_left',
          HINT = 'Start a new group to message these people.';
    END IF;
  END IF;
END;
$$;

-- File one message, or check the row that files it. Called at commit by the three triggers below.
CREATE FUNCTION swarm.file_conversation_signal(p_workspace uuid, p_signal uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_new boolean;
  v_expected record;
  v_row record;
BEGIN
  -- The server stamp the recipient and mention guards read (20261022000992): new in this transaction.
  v_new := EXISTS (
    SELECT 1 FROM swarm.signals AS s
    WHERE s.id = p_signal AND s.workspace_id = p_workspace
      AND s.creation_xact_id = pg_current_xact_id()
      AND s.creation_system_identifier = (SELECT system_identifier FROM pg_catalog.pg_control_system()));
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
    -- Cannot be placed: stays unmapped, and the legacy read rule serves it as today.
    RETURN;
  END IF;
  INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
  VALUES (p_signal, p_workspace, v_expected.conversation_id, '-infinity', v_expected.audience);
END;
$$;

CREATE FUNCTION swarm.file_signal_conversation_at_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'signals' THEN
    PERFORM swarm.file_conversation_signal(NEW.workspace_id, NEW.id);
  ELSE
    PERFORM swarm.file_conversation_signal(NEW.workspace_id, NEW.signal_id);
  END IF;
  RETURN NULL;
END;
$$;

-- At commit: every new message is filed after its recipient rows exist; a recipient row written after
-- the message is filed (SET CONSTRAINTS ... IMMEDIATE) re-checks it; and any mapping row, however it
-- was written, is recomputed. Names sort after the existing recipient checks, which report first.
CREATE CONSTRAINT TRIGGER signals_settle_conversation
  AFTER INSERT ON swarm.signals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION swarm.file_signal_conversation_at_commit();
CREATE CONSTRAINT TRIGGER signal_recipients_settle_conversation
  AFTER INSERT ON swarm.signal_recipients
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION swarm.file_signal_conversation_at_commit();
CREATE CONSTRAINT TRIGGER conversation_signals_settle
  AFTER INSERT ON swarm.conversation_signals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION swarm.file_signal_conversation_at_commit();

-- Every workspace has its #general from the start.
CREATE FUNCTION swarm.create_workspace_general() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM swarm.conversation_general(NEW.workspace_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER workspaces_create_general
  AFTER INSERT ON swarm.workspaces
  FOR EACH ROW EXECUTE FUNCTION swarm.create_workspace_general();

-- Every channel has its conversation, kept in step with its visibility and archive. No column list, so
-- the trigger does not pin channel columns that older rollbacks drop.
CREATE FUNCTION swarm.sync_channel_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM swarm.conversation_for_channel(NEW.workspace_id, NEW.channel_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER channels_sync_conversation
  AFTER INSERT OR UPDATE ON swarm.channels
  FOR EACH ROW EXECUTE FUNCTION swarm.sync_channel_conversation();

-- The backfill: idempotent, and run again by the edge release (step 2). Returns what it added.
CREATE FUNCTION swarm.conversations_backfill() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r record;
  v_place record;
  v_n bigint;
  v_general bigint;
  v_filed bigint := 0;
  v_unplaced jsonb := '{}';
  v_members bigint := 0;
  v_reads bigint := 0;
BEGIN
  INSERT INTO swarm.conversations (workspace_id, kind, created_by_kind, created_by_principal, created_at)
  SELECT w.workspace_id, 'general', 'user', w.created_by, w.created_at
  FROM swarm.workspaces AS w
  ON CONFLICT (workspace_id) WHERE kind = 'general' DO NOTHING;
  GET DIAGNOSTICS v_general = ROW_COUNT;
  FOR r IN SELECT c.workspace_id, c.channel_id FROM swarm.channels AS c ORDER BY c.created_at, c.channel_id LOOP
    PERFORM swarm.conversation_for_channel(r.workspace_id, r.channel_id);
  END LOOP;

  -- Messages, roots before replies, oldest first.
  FOR r IN
    SELECT s.id, s.workspace_id
    FROM swarm.signals AS s
    WHERE NOT EXISTS (SELECT 1 FROM swarm.conversation_signals AS cs WHERE cs.signal_id = s.id)
    ORDER BY (s.thread_root_id IS NOT NULL), s.created_at, s.id
  LOOP
    SELECT p.conversation_id, p.audience, p.unplaced INTO v_place
    FROM swarm.conversation_placement(r.workspace_id, r.id, false) AS p;
    IF v_place.conversation_id IS NULL THEN
      v_unplaced := jsonb_set(v_unplaced, ARRAY[v_place.unplaced],
        to_jsonb(coalesce((v_unplaced ->> v_place.unplaced)::bigint, 0) + 1));
      CONTINUE;
    END IF;
    INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
    VALUES (r.id, r.workspace_id, v_place.conversation_id, '-infinity', v_place.audience);
    v_filed := v_filed + 1;
  END LOOP;

  -- People: every live member joins #general and every public channel, with the star and notification
  -- level they already chose there.
  INSERT INTO swarm.conversation_members
    (conversation_id, workspace_id, member_user_id, joined_at, notify_level, starred, star_rank)
  SELECT c.conversation_id, c.workspace_id, m.user_id, greatest(m.joined_at, c.created_at),
    coalesce(pref.involvement, 'everything'), coalesce(pref.starred, false), pref.star_rank
  FROM swarm.conversations AS c
  JOIN swarm.memberships AS m ON m.workspace_id = c.workspace_id AND m.revoked_at IS NULL
  LEFT JOIN swarm.channel_preferences AS pref
    ON pref.workspace_id = c.workspace_id AND pref.user_id = m.user_id
   AND pref.channel_id IS NOT DISTINCT FROM c.channel_id
  WHERE c.kind IN ('general', 'public_channel')
  ON CONFLICT (conversation_id, member_user_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_members := v_members + v_n;

  -- Agents with a live seat: #general, and a public channel they lead, have posted in or have read.
  INSERT INTO swarm.conversation_members (conversation_id, workspace_id, member_agent_principal_id, joined_at)
  SELECT c.conversation_id, c.workspace_id, seat.principal_id, greatest(seat.added_at, c.created_at)
  FROM swarm.conversations AS c
  JOIN (
    SELECT am.workspace_id, am.principal_id, am.added_at
    FROM swarm.agent_workspace_memberships AS am
    WHERE am.revoked_at IS NULL
    UNION
    SELECT p.workspace_id, p.principal_id, p.created_at
    FROM swarm.agent_principals AS p
    WHERE p.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships AS any_am
        WHERE any_am.principal_id = p.principal_id AND any_am.workspace_id = p.workspace_id)
  ) AS seat ON seat.workspace_id = c.workspace_id
  LEFT JOIN swarm.channels AS ch ON ch.channel_id = c.channel_id AND ch.workspace_id = c.workspace_id
  LEFT JOIN swarm.workspaces AS w ON w.workspace_id = c.workspace_id
  WHERE swarm.actor_can_access_channel(c.workspace_id, NULL, 'agent', seat.principal_id)
    AND (c.kind = 'general'
      OR (c.kind = 'public_channel' AND (
        (ch.lead_mode = 'agent' AND ch.lead_agent_principal_id = seat.principal_id)
        OR (ch.lead_mode = 'workspace' AND w.lead_agent_principal_id = seat.principal_id)
        OR EXISTS (SELECT 1 FROM swarm.signals AS s
          WHERE s.workspace_id = c.workspace_id AND s.channel_id = c.channel_id
            AND s.from_kind = 'agent' AND s.from_principal = seat.principal_id)
        OR EXISTS (SELECT 1 FROM swarm.agent_channel_reads AS ar
          WHERE ar.workspace_id = c.workspace_id AND ar.channel_id = c.channel_id
            AND ar.principal_id = seat.principal_id))))
  ON CONFLICT (conversation_id, member_agent_principal_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_members := v_members + v_n;

  -- Read marks; a NULL channel is #general. A later mark replaces an earlier one, never the reverse.
  INSERT INTO swarm.conversation_reads AS cr
    (conversation_id, workspace_id, member_user_id, read_through_at, read_through_id, first_read_at, updated_at)
  SELECT c.conversation_id, h.workspace_id, h.user_id, h.read_through_at, h.read_through_id,
    h.first_read_at, h.updated_at
  FROM swarm.human_channel_reads AS h
  JOIN swarm.memberships AS m ON m.workspace_id = h.workspace_id AND m.user_id = h.user_id
  JOIN swarm.conversations AS c
    ON c.workspace_id = h.workspace_id
   AND (CASE WHEN h.channel_id IS NULL THEN c.kind = 'general' ELSE c.conversation_id = h.channel_id END)
  ON CONFLICT (conversation_id, member_user_id) DO UPDATE
    SET read_through_at = EXCLUDED.read_through_at, read_through_id = EXCLUDED.read_through_id,
      updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.read_through_at > cr.read_through_at
      OR (cr.read_through_at IS NULL AND EXCLUDED.read_through_at IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_reads := v_reads + v_n;
  INSERT INTO swarm.conversation_reads AS cr
    (conversation_id, workspace_id, member_agent_principal_id, read_through_at, read_through_id, first_read_at, updated_at)
  SELECT c.conversation_id, a.workspace_id, a.principal_id, a.read_through_at, a.read_through_id,
    a.first_read_at, a.updated_at
  FROM swarm.agent_channel_reads AS a
  JOIN swarm.conversations AS c
    ON c.workspace_id = a.workspace_id
   AND (CASE WHEN a.channel_id IS NULL THEN c.kind = 'general' ELSE c.conversation_id = a.channel_id END)
  ON CONFLICT (conversation_id, member_agent_principal_id) DO UPDATE
    SET read_through_at = EXCLUDED.read_through_at, read_through_id = EXCLUDED.read_through_id,
      updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.read_through_at > cr.read_through_at
      OR (cr.read_through_at IS NULL AND EXCLUDED.read_through_at IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_reads := v_reads + v_n;

  RETURN jsonb_build_object('general', v_general, 'filed', v_filed, 'unplaced', v_unplaced,
    'members', v_members, 'reads', v_reads);
END;
$$;

ALTER TABLE swarm.conversations OWNER TO swarm_admin;
ALTER TABLE swarm.conversation_members OWNER TO swarm_admin;
ALTER TABLE swarm.conversation_signals OWNER TO swarm_admin;
ALTER TABLE swarm.conversation_reads OWNER TO swarm_admin;
ALTER TABLE swarm.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.conversation_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.conversation_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE swarm.conversations, swarm.conversation_members, swarm.conversation_signals,
  swarm.conversation_reads
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

ALTER FUNCTION swarm.conversation_identity_guard() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_member_guard() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_signal_guard() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_general(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_for_channel(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_for_members(uuid, text, uuid, uuid[], uuid[], boolean, timestamptz) OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversation_placement(uuid, uuid, boolean) OWNER TO swarm_admin;
ALTER FUNCTION swarm.file_conversation_signal(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.file_signal_conversation_at_commit() OWNER TO swarm_admin;
ALTER FUNCTION swarm.create_workspace_general() OWNER TO swarm_admin;
ALTER FUNCTION swarm.sync_channel_conversation() OWNER TO swarm_admin;
ALTER FUNCTION swarm.conversations_backfill() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.conversation_identity_guard(), swarm.conversation_member_guard(),
  swarm.conversation_signal_guard(), swarm.conversation_general(uuid), swarm.conversation_for_channel(uuid, uuid),
  swarm.conversation_for_members(uuid, text, uuid, uuid[], uuid[], boolean, timestamptz),
  swarm.conversation_placement(uuid, uuid, boolean), swarm.file_conversation_signal(uuid, uuid),
  swarm.file_signal_conversation_at_commit(), swarm.create_workspace_general(), swarm.sync_channel_conversation(),
  swarm.conversations_backfill()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

SELECT swarm.conversations_backfill();
RESET search_path;
