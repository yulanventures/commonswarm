-- Live updates for private channels: one Realtime topic per person.
--
-- 20261113000003 stopped private-channel signals from reaching the workspace topic, so a
-- member's open tab only learned of a new message at its next 30-second reconcile. This adds
-- the missing push without widening who learns anything:
--
-- 1. Topic `cswarm-member:<workspace_id>:<user_id>`. The name holds only ids the person
--    already has; no channel id is ever a topic name, so a refused join says nothing about
--    which channels exist.
-- 2. swarm.wake_workspace_signal() sends a private channel's signal to the topic of each
--    person who can read that channel at that moment. Access is read when the signal is
--    written (swarm.actor_can_access_channel, the same rule every read uses), never when a
--    socket joined, so a person removed from the channel gets nothing from the next message
--    on, even on a socket that is still open. Agents get no topic: they are woken by their
--    own deliveries.
-- 3. A SELECT policy on realtime.messages admits a signed-in person to their own topic in a
--    workspace they belong to, with a live session, like the two workspace topics. A token
--    that names an agent is refused: an agent never stands in for the person who owns it.
--
-- Open-channel and unfiled signals are unchanged. A member-topic frame is {"v": 1}: no signal
-- id, no time, no channel. The browser reads nothing from a frame; it refreshes its feed, and
-- every read is checked again there. A socket whose session has ended but whose token has not
-- yet expired therefore receives only the fact that one of the person's private channels moved.
--
-- Rollback: recreate swarm.wake_workspace_signal() from 20261113000003 and drop the policy.
-- Nothing else reads either.

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

-- The function reads swarm.channels and swarm.channel_members and calls the access rule as its
-- owner, postgres, which holds them through its swarm_admin membership (the same way the
-- function has read swarm.channels since 20261113000003). The function swallows every error, so
-- a missing privilege would show only as silence: the tests assert the stored rows and the
-- frames on a real socket rather than the absence of an error.

-- substring() returns NULL for a topic of any other shape, so the casts never raise and
-- every refusal is the same refusal.
CREATE POLICY "a person receives their own private channel signals"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND substring(
    (SELECT realtime.topic())
    FROM '^cswarm-member:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  )::uuid = (SELECT auth.uid())
  AND swarm.is_member(
    substring(
      (SELECT realtime.topic())
      FROM '^cswarm-member:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )::uuid,
    (SELECT auth.uid())
  )
  AND NOT coalesce(
    (SELECT nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb) ? 'agent_principal_id',
    false
  )
  AND (SELECT swarm_session.current_human_session_live())
);
