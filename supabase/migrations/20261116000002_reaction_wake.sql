-- A person's reaction on an agent's message wakes that agent.
--
-- The wake is content-free, on the agent's own topic, like a delivery's (20260906000010). The agent
-- then reads its inbox, where the read edge shows the reaction as a note addressed to it. Only a
-- reaction on a message the whole channel reads wakes (see below). Only a
-- person's chosen reaction wakes: never an agent's (so two agents cannot wake each other by
-- reacting), never an automatic "seen" mark, never a removal. The agent must still be live, still a
-- member of the workspace, and still able to read the channel, the same facts the delivery wake
-- checks (swarm.agent_delivery_is_wakeable), read when the reaction is written.
--
-- Rollback: drop the trigger and the function.

CREATE FUNCTION swarm.wake_reacted_agent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_wake_id text;
BEGIN
  IF NEW.actor_user_id IS NULL OR NEW.source <> 'manual' THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT p.wake_id
      INTO v_wake_id
      FROM swarm.signals AS s
      JOIN swarm.agent_principals AS p
        ON p.principal_id = s.from_principal
      JOIN swarm.agent_workspace_memberships AS seat
        ON seat.principal_id = p.principal_id
       AND seat.workspace_id = s.workspace_id
     WHERE s.id = NEW.signal_id
       AND s.workspace_id = NEW.workspace_id
       AND s.from_kind = 'agent'
       -- Only a message the whole channel reads: the agent's read shows it the reaction there.
       -- swarm_read.signals does not show an agent its own private messages, so a reaction on one
       -- would wake it to nothing; that waits on a read-policy decision.
       AND s.to_user_id IS NULL
       AND s.to_agent_principal_id IS NULL
       AND s.in_reply_to IS NULL
       AND NOT EXISTS (SELECT 1 FROM swarm.signal_recipients AS sr
                       WHERE sr.signal_id = s.id AND sr.workspace_id = s.workspace_id)
       AND p.revoked_at IS NULL
       AND seat.revoked_at IS NULL
       AND (s.channel_id IS NULL
            OR swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'agent', p.principal_id));
    IF v_wake_id IS NULL THEN
      RETURN NULL;
    END IF;
    PERFORM realtime.send(
      pg_catalog.jsonb_build_object('v', 1, 'signal_id', NEW.reaction_id, 'enqueued_at', NEW.created_at),
      'wake',
      'cswarm-wake:' || v_wake_id,
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  RETURN NULL;
END;
$fn$;

ALTER FUNCTION swarm.wake_reacted_agent() OWNER TO postgres;
REVOKE ALL ON FUNCTION swarm.wake_reacted_agent() FROM PUBLIC;

COMMENT ON FUNCTION swarm.wake_reacted_agent() IS
  'AFTER INSERT on swarm.signal_reactions: a person''s manual reaction on a live agent''s message '
  'sends a content-free wake on that agent''s topic. Agents'' and automatic reactions wake nobody. '
  'A Realtime failure never fails the reaction.';

CREATE TRIGGER signal_reactions_wake_agent
  AFTER INSERT ON swarm.signal_reactions
  FOR EACH ROW EXECUTE FUNCTION swarm.wake_reacted_agent();
