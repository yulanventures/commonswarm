-- Reactions: an emoji from a person or an agent on a message.
--
-- Who may react is who may read. Every rule below defers to swarm_read.signals, the view that IS the
-- read policy (members, private messages, private channels): the command edge asks
-- swarm.signal_reactable() under the reactor's own claims, and swarm_read.signal_reactions shows a
-- reaction only beside a message the reader can read. Nothing here restates that policy.
--
-- This migration stores reactions and tells open tabs that a message's reactions changed. It wakes
-- no agent; a person's reaction to an agent's message is delivered to that agent by a later change.
--
-- Rollback: drop the two triggers, their functions, swarm.signal_reactable, the view and the table.
-- Nothing else reads them.

CREATE TABLE swarm.signal_reactions (
  reaction_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  signal_id    uuid NOT NULL,
  actor_user_id uuid,
  actor_agent_principal_id uuid,
  -- One emoji, already normalized by the edge (SIGNAL_REACTION_EMOJI in src/protocol). The bound and
  -- the character rule are the database's own floor under that.
  emoji        text NOT NULL CHECK (
    octet_length(emoji) BETWEEN 1 AND 32
    AND emoji = btrim(emoji)
    AND emoji !~ '[[:cntrl:][:space:]]'
  ),
  -- 'manual': someone chose it. 'ack': an agent's client marked a message it surfaced as seen.
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ack')),
  created_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (num_nonnulls(actor_user_id, actor_agent_principal_id) = 1),
  CHECK (source <> 'ack' OR actor_agent_principal_id IS NOT NULL),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id),
  FOREIGN KEY (actor_agent_principal_id, workspace_id)
    REFERENCES swarm.agent_workspace_memberships (principal_id, workspace_id)
);

CREATE UNIQUE INDEX signal_reactions_user_unique
  ON swarm.signal_reactions (signal_id, actor_user_id, emoji)
  WHERE actor_user_id IS NOT NULL;
CREATE UNIQUE INDEX signal_reactions_agent_unique
  ON swarm.signal_reactions (signal_id, actor_agent_principal_id, emoji)
  WHERE actor_agent_principal_id IS NOT NULL;
CREATE INDEX signal_reactions_by_signal
  ON swarm.signal_reactions (workspace_id, signal_id, created_at, reaction_id);

ALTER TABLE swarm.signal_reactions OWNER TO swarm_admin;
ALTER TABLE swarm.signal_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.signal_reactions
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.signal_reactions FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT, DELETE ON TABLE swarm.signal_reactions TO swarm_command;

COMMENT ON TABLE swarm.signal_reactions IS
  'Emoji reactions on signals, one row per message, reactor and emoji. Readable only beside a '
  'message the reader can read (swarm_read.signal_reactions).';

-- A generous bound on distinct emojis per reactor per message, so a loop cannot grow a message
-- without limit. SIGNAL_REACTION_MAX_PER_ACTOR in src/protocol is the edge's copy and the refusal's
-- number. The transaction lock serializes concurrent adds by the same reactor on the same message.
CREATE FUNCTION swarm.signal_reactions_bound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor uuid := COALESCE(NEW.actor_user_id, NEW.actor_agent_principal_id);
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('signal_reactions:' || NEW.signal_id::text || ':' || v_actor::text, 0)
  );
  IF (
    SELECT count(*)
    FROM swarm.signal_reactions AS r
    WHERE r.signal_id = NEW.signal_id
      AND r.workspace_id = NEW.workspace_id
      AND COALESCE(r.actor_user_id, r.actor_agent_principal_id) = v_actor
  ) >= 64 THEN
    RAISE EXCEPTION 'a reactor may add at most 64 emojis to one message'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signal_reactions_per_actor';
  END IF;
  RETURN NEW;
END;
$fn$;

ALTER FUNCTION swarm.signal_reactions_bound() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.signal_reactions_bound() FROM PUBLIC;

CREATE TRIGGER signal_reactions_bound
  BEFORE INSERT ON swarm.signal_reactions
  FOR EACH ROW EXECUTE FUNCTION swarm.signal_reactions_bound();

-- Can the caller whose claims are installed read this signal? The command edge installs the
-- reactor's claims (a person: sub; an agent: its owner's sub plus agent_principal_id, as the read
-- edge and the hosted check do) and asks before every add or remove. An agent is narrowed the way the
-- agent read narrows it: the view admits its owner's view, and the agent reads only the messages the
-- whole channel reads and those addressed to it. An unknown id and a hidden one both answer false.
CREATE FUNCTION swarm.signal_reactable(p_workspace_id uuid, p_signal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm_read, swarm, auth, pg_catalog
AS $fn$
  WITH caller AS (
    SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'agent_principal_id')::uuid AS agent
  )
  SELECT EXISTS (
    SELECT 1
    FROM swarm_read.signals AS s, caller
    WHERE s.workspace_id = p_workspace_id
      AND s.id = p_signal_id
      AND (
        caller.agent IS NULL
        OR (s."to" IS NULL AND s.to_agent IS NULL)
        OR s.to_agent = caller.agent
        OR s.recipients @> jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', caller.agent))
      )
  );
$fn$;

ALTER FUNCTION swarm.signal_reactable(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.signal_reactable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.signal_reactable(uuid, uuid) TO swarm_command;

-- Readback: a reaction is shown only beside a message the reader can read, by the same view.
CREATE VIEW swarm_read.signal_reactions
WITH (security_barrier = true)
AS
  SELECT
    r.reaction_id,
    r.workspace_id,
    r.signal_id,
    CASE WHEN r.actor_user_id IS NOT NULL THEN 'user' ELSE 'agent' END AS kind,
    COALESCE(r.actor_user_id, r.actor_agent_principal_id) AS id,
    r.emoji,
    r.source,
    r.created_at
  FROM swarm.signal_reactions AS r
  WHERE EXISTS (
    SELECT 1 FROM swarm_read.signals AS s
    WHERE s.id = r.signal_id
      AND s.workspace_id = r.workspace_id
  );

ALTER VIEW swarm_read.signal_reactions OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.signal_reactions FROM PUBLIC, anon;
GRANT SELECT ON swarm_read.signal_reactions TO authenticated, swarm_read;

-- Open tabs learn that a message's reactions changed, on the topics its new messages already use
-- (20261114000001): the workspace topic for an unfiled or open-channel message that the whole
-- workspace reads, and a bare {"v": 1} on the member topic of each person who can read anything else
-- -- each member of a private channel, and each person party to a private message (its author,
-- its person recipients, and the owners of its agent author and agent recipients, who read it too).
-- Access is read now, so a person who has left a private channel learns nothing. A Realtime failure
-- never fails the reaction.
CREATE FUNCTION swarm.push_signal_reaction()
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
          SELECT s.from_principal AS user_id WHERE s.from_kind = 'user'
          UNION ALL SELECT s.to_user_id
          UNION ALL SELECT sr.recipient_user_id
                      FROM swarm.signal_recipients AS sr
                     WHERE sr.signal_id = s.id AND sr.workspace_id = s.workspace_id
          UNION ALL SELECT p.owner_user_id
                      FROM swarm.agent_principals AS p
                     WHERE p.principal_id IN (
                       SELECT s.from_principal WHERE s.from_kind = 'agent'
                       UNION ALL SELECT s.to_agent_principal_id
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

ALTER FUNCTION swarm.push_signal_reaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION swarm.push_signal_reaction() FROM PUBLIC;

CREATE TRIGGER signal_reactions_push
  AFTER INSERT OR DELETE ON swarm.signal_reactions
  FOR EACH ROW EXECUTE FUNCTION swarm.push_signal_reaction();
