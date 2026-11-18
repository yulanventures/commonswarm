-- Rollback for 20261118000005 (conversations, step 2a: commands, conversation posts, membership upkeep and
-- per-person live updates). HezOps takes a verified full database backup before the release applies the
-- migration. Roll the edge back first (deploy/edge-runtime/EDGE-RELEASE.md): the step 2a edge calls
-- functions this drops.
--
-- Drops every trigger and function 20261118000005 added, and puts back, exactly as they were written, step 1's
-- two filing functions (20261118000004), the reaction push (20261116000001) and the workspace topic's emitter
-- with its trigger (20261114000001). Rows the step wrote stay, and stay valid under step 1: memberships it
-- changed or ended, read marks it copied, generations it opened, and the filing rows of messages posted to a
-- 1:1 or group (audience 'conversation'), which nothing reads before step 2b. Step 1's own rollback
-- (deploy/release-proofs/conversations/20261118000004-rollback.sql) runs after this one, never before.
SET search_path = swarm, pg_catalog, public;
DROP TRIGGER IF EXISTS memberships_conversation_upkeep ON swarm.memberships;
DROP TRIGGER IF EXISTS agent_workspace_memberships_conversation_upkeep ON swarm.agent_workspace_memberships;
DROP TRIGGER IF EXISTS agent_principals_conversation_upkeep ON swarm.agent_principals;
DROP TRIGGER IF EXISTS channels_sync_creator_member ON swarm.channels;
DROP TRIGGER IF EXISTS human_channel_reads_follow_conversation ON swarm.human_channel_reads;
DROP TRIGGER IF EXISTS agent_channel_reads_follow_conversation ON swarm.agent_channel_reads;
DROP TRIGGER IF EXISTS channel_preferences_follow_conversation ON swarm.channel_preferences;
DROP TRIGGER IF EXISTS channel_members_lock_conversation ON swarm.channel_members;

-- Step 1's filer and its commit-time trigger function, from 20261118000004.
CREATE OR REPLACE FUNCTION swarm.file_conversation_signal(p_workspace uuid, p_signal uuid) RETURNS void
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

CREATE OR REPLACE FUNCTION swarm.file_signal_conversation_at_commit() RETURNS trigger
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

-- The reaction push, from 20261116000001.
CREATE OR REPLACE FUNCTION swarm.push_signal_reaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  r record;
  s record;
  v_visibility text;
  v_user_id uuid;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
    SELECT sig.id, sig.workspace_id, sig.created_at, sig.channel_id, sig.from_kind, sig.from_principal,
           sig.to_user_id, sig.to_agent_principal_id, sig.in_reply_to,
           EXISTS (SELECT 1 FROM swarm.signal_recipients AS sr
                   WHERE sr.signal_id = sig.id AND sr.workspace_id = sig.workspace_id) AS has_recipients
      INTO s
      FROM swarm.signals AS sig
     WHERE sig.id = r.signal_id AND sig.workspace_id = r.workspace_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL AND s.in_reply_to IS NULL
       AND NOT s.has_recipients THEN
      IF s.channel_id IS NOT NULL THEN
        SELECT c.visibility INTO v_visibility
          FROM swarm.channels AS c
         WHERE c.workspace_id = s.workspace_id AND c.channel_id = s.channel_id;
        IF v_visibility IS DISTINCT FROM 'open' THEN
          IF v_visibility = 'private' THEN
            FOR v_user_id IN
              SELECT cm.user_id
                FROM swarm.channel_members AS cm
               WHERE cm.workspace_id = s.workspace_id
                 AND cm.channel_id = s.channel_id
                 AND cm.member_kind = 'user'
                 AND swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'user', cm.user_id)
            LOOP
              PERFORM realtime.send(pg_catalog.jsonb_build_object('v', 1), 'signal',
                'cswarm-member:' || s.workspace_id::text || ':' || v_user_id::text, true);
            END LOOP;
          END IF;
          RETURN NULL;
        END IF;
      END IF;
      PERFORM realtime.send(
        pg_catalog.jsonb_build_object('v', 1, 'signal_id', s.id, 'created_at', s.created_at),
        'signal', 'cswarm-signals:' || s.workspace_id::text, true);
      RETURN NULL;
    END IF;

    FOR v_user_id IN
      SELECT DISTINCT party.user_id
        FROM (
          SELECT s.to_user_id AS user_id
          UNION ALL SELECT sr.recipient_user_id
                      FROM swarm.signal_recipients AS sr
                     WHERE sr.signal_id = s.id AND sr.workspace_id = s.workspace_id
          UNION ALL SELECT p.owner_user_id
                      FROM swarm.agent_principals AS p
                     WHERE p.principal_id IN (
                       SELECT s.to_agent_principal_id
                       UNION ALL SELECT sr.recipient_agent_principal_id
                                   FROM swarm.signal_recipients AS sr
                                  WHERE sr.signal_id = s.id AND sr.workspace_id = s.workspace_id)
        ) AS party
       WHERE party.user_id IS NOT NULL
         AND swarm.is_member(s.workspace_id, party.user_id)
         AND (s.channel_id IS NULL
              OR swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'user', party.user_id))
    LOOP
      PERFORM realtime.send(pg_catalog.jsonb_build_object('v', 1), 'signal',
        'cswarm-member:' || s.workspace_id::text || ':' || v_user_id::text, true);
    END LOOP;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  RETURN NULL;
END;
$fn$;

-- The workspace topic emitter, from 20261114000001, with the owner, grant and comment it left.
CREATE OR REPLACE FUNCTION swarm.wake_workspace_signal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_visibility text;
  v_user_id uuid;
BEGIN
  BEGIN
    IF NEW.channel_id IS NOT NULL THEN
      SELECT c.visibility INTO v_visibility
      FROM swarm.channels AS c
      WHERE c.workspace_id = NEW.workspace_id
        AND c.channel_id = NEW.channel_id;
      IF v_visibility IS DISTINCT FROM 'open' THEN
        IF v_visibility = 'private' THEN
          FOR v_user_id IN
            SELECT cm.user_id
            FROM swarm.channel_members AS cm
            WHERE cm.workspace_id = NEW.workspace_id
              AND cm.channel_id = NEW.channel_id
              AND cm.member_kind = 'user'
              AND swarm.actor_can_access_channel(
                NEW.workspace_id, NEW.channel_id, 'user', cm.user_id
              )
          LOOP
            PERFORM realtime.send(
              pg_catalog.jsonb_build_object('v', 1),
              'signal',
              'cswarm-member:' || NEW.workspace_id::text || ':' || v_user_id::text,
              true
            );
          END LOOP;
        END IF;
        RETURN NULL;
      END IF;
    END IF;
    PERFORM realtime.send(
      pg_catalog.jsonb_build_object(
        'v', 1,
        'signal_id', NEW.id,
        'created_at', NEW.created_at
      ),
      'signal',
      'cswarm-signals:' || NEW.workspace_id::text,
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  RETURN NULL;
END;
$fn$;

ALTER FUNCTION swarm.wake_workspace_signal() OWNER TO postgres;
REVOKE ALL ON FUNCTION swarm.wake_workspace_signal() FROM PUBLIC;

COMMENT ON FUNCTION swarm.wake_workspace_signal() IS
  'AFTER INSERT on swarm.signals: send a content-free payload on the workspace '
  'signal topic for unfiled and open-channel signals, and a bare version frame on '
  'the member topic of each person who can read a private channel. A private '
  'signal never reaches the workspace topic. A Realtime failure never fails the '
  'signal insert.';
DROP TRIGGER IF EXISTS signals_wake_workspace ON swarm.signals;
CREATE TRIGGER signals_wake_workspace
  AFTER INSERT ON swarm.signals
  FOR EACH ROW
  EXECUTE FUNCTION swarm.wake_workspace_signal();

DROP FUNCTION IF EXISTS swarm.conversation_private_member_lock();
DROP FUNCTION IF EXISTS swarm.conversation_visible(uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_preferences_follow();
DROP FUNCTION IF EXISTS swarm.conversation_reads_follow();
DROP FUNCTION IF EXISTS swarm.conversation_creator_joins();
DROP FUNCTION IF EXISTS swarm.conversation_agent_upkeep();
DROP FUNCTION IF EXISTS swarm.conversation_person_upkeep();
DROP FUNCTION IF EXISTS swarm.conversation_lock_workspace(uuid);
DROP FUNCTION IF EXISTS swarm.send_signal_frames(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.signal_frame_readers(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_check_route(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_group_departed(uuid, text, uuid, uuid[], uuid[]);
DROP FUNCTION IF EXISTS swarm.conversation_prefile(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_post_route(uuid, text, uuid, uuid, uuid[], uuid[]);
DROP FUNCTION IF EXISTS swarm.conversation_set_notify(uuid, text, uuid, uuid, text, boolean, integer);
DROP FUNCTION IF EXISTS swarm.conversation_mark_read(uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_remove(uuid, text, uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_invite(uuid, text, uuid, uuid, uuid[], uuid[]);
DROP FUNCTION IF EXISTS swarm.conversation_leave(uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_join(uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_open(uuid, text, uuid, uuid[], uuid[], boolean);
DROP FUNCTION IF EXISTS swarm.conversation_live_members(uuid);
DROP FUNCTION IF EXISTS swarm.conversation_next_generation(uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_member_key(uuid[], uuid[]);
DROP FUNCTION IF EXISTS swarm.conversation_departed_name(uuid);
DROP FUNCTION IF EXISTS swarm.conversation_target(uuid, text, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_member_leave(uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_member_join(uuid, uuid, text, uuid);
RESET search_path;
