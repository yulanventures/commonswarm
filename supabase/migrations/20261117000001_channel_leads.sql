-- Channel leads: each named channel chooses who an untagged top-level person post wakes.
--
-- lead_mode 'workspace' (the default) keeps today's behaviour: the workspace lead, when it can read
-- the channel. 'agent' names one live local agent for this channel. 'none' wakes nobody. general
-- (no channel) always uses the workspace lead. Additive; every existing channel reads 'workspace'.
--
-- swarm.channel_effective_live_lead answers who to wake right now, checked at use: an archived
-- channel and 'none' answer null, and the named agent (or the workspace lead) must still be live,
-- local, not turn-only, a member of the workspace with a live owner, and able to read the channel.
-- Triggers put a channel back on 'workspace' when its named agent is revoked, leaves the workspace,
-- loses its owner, or is removed from the private channel. Their names sort after the private-channel
-- cleanup triggers on the same tables, so a revocation takes the channel-access lock before it
-- touches a channel row, as the command edge does.
--
-- swarm_read.channels appends lead_mode and lead_agent_principal_id; earlier columns, the
-- private-channel gate, the owner and the grants are unchanged.
--
-- Rollback: deploy/release-proofs/channel-leads/20261117000001-rollback.sql.
SET search_path = swarm, pg_catalog, public;

ALTER TABLE swarm.channels
  ADD COLUMN lead_mode text NOT NULL DEFAULT 'workspace'
    CONSTRAINT channels_lead_mode_check CHECK (lead_mode IN ('workspace', 'agent', 'none')),
  ADD COLUMN lead_agent_principal_id uuid REFERENCES swarm.agent_principals (principal_id),
  ADD CONSTRAINT channels_lead_agent_named_check
    CHECK ((lead_mode = 'agent') = (lead_agent_principal_id IS NOT NULL));

-- Who an untagged top-level person post in this channel wakes now, or null.
CREATE FUNCTION swarm.channel_effective_live_lead(p_workspace uuid, p_channel uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_mode text;
  v_agent uuid;
  v_archived timestamptz;
  v_lead uuid;
BEGIN
  IF p_workspace IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_channel IS NULL THEN
    RETURN swarm.workspace_live_lead(p_workspace);
  END IF;
  SELECT c.lead_mode, c.lead_agent_principal_id, c.archived_at
  INTO v_mode, v_agent, v_archived
  FROM swarm.channels AS c
  WHERE c.workspace_id = p_workspace AND c.channel_id = p_channel;
  IF NOT FOUND OR v_archived IS NOT NULL OR v_mode = 'none' THEN
    RETURN NULL;
  END IF;
  IF v_mode = 'workspace' THEN
    v_lead := swarm.workspace_live_lead(p_workspace);
  ELSE
    SELECT p.principal_id INTO v_lead
    FROM swarm.agent_principals AS p
    JOIN swarm.workspaces AS w
      ON w.workspace_id = p_workspace AND w.archived_at IS NULL
    JOIN swarm.agent_workspace_memberships AS am
      ON am.principal_id = p.principal_id AND am.workspace_id = p_workspace AND am.revoked_at IS NULL
    JOIN swarm.memberships AS owner_m
      ON owner_m.workspace_id = p_workspace AND owner_m.user_id = p.owner_user_id AND owner_m.revoked_at IS NULL
    WHERE p.principal_id = v_agent
      AND p.revoked_at IS NULL AND p.transport = 'local' AND NOT p.turn_only
      AND NOT EXISTS (
        SELECT 1 FROM swarm.agent_join_credentials AS j WHERE j.registrar_principal_id = p.principal_id);
  END IF;
  IF v_lead IS NULL OR NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', v_lead) THEN
    RETURN NULL;
  END IF;
  RETURN v_lead;
END;
$$;

-- Invariant: a named channel lead that leaves is cleared back to the workspace lead.
CREATE FUNCTION swarm.reset_channel_lead_on_principal_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE swarm.channels SET lead_mode = 'workspace', lead_agent_principal_id = NULL
  WHERE lead_agent_principal_id = NEW.principal_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_principals_reset_channel_lead AFTER UPDATE OF revoked_at ON swarm.agent_principals
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION swarm.reset_channel_lead_on_principal_revoke();

CREATE FUNCTION swarm.reset_channel_lead_on_agent_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE swarm.channels SET lead_mode = 'workspace', lead_agent_principal_id = NULL
  WHERE workspace_id = NEW.workspace_id AND lead_agent_principal_id = NEW.principal_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_workspace_memberships_reset_channel_lead AFTER UPDATE OF revoked_at ON swarm.agent_workspace_memberships
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION swarm.reset_channel_lead_on_agent_exit();

CREATE FUNCTION swarm.reset_channel_lead_on_owner_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE swarm.channels AS c SET lead_mode = 'workspace', lead_agent_principal_id = NULL
  FROM swarm.agent_principals AS p
  WHERE c.workspace_id = NEW.workspace_id AND p.principal_id = c.lead_agent_principal_id
    AND p.owner_user_id = NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memberships_reset_channel_lead AFTER UPDATE OF revoked_at ON swarm.memberships
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION swarm.reset_channel_lead_on_owner_exit();

CREATE FUNCTION swarm.reset_channel_lead_on_member_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE swarm.channels SET lead_mode = 'workspace', lead_agent_principal_id = NULL
  WHERE workspace_id = OLD.workspace_id AND channel_id = OLD.channel_id
    AND visibility = 'private' AND lead_agent_principal_id = OLD.agent_principal_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER channel_members_reset_channel_lead AFTER DELETE ON swarm.channel_members
FOR EACH ROW WHEN (OLD.member_kind = 'agent')
EXECUTE FUNCTION swarm.reset_channel_lead_on_member_removal();

ALTER FUNCTION swarm.channel_effective_live_lead(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.reset_channel_lead_on_principal_revoke() OWNER TO swarm_admin;
ALTER FUNCTION swarm.reset_channel_lead_on_agent_exit() OWNER TO swarm_admin;
ALTER FUNCTION swarm.reset_channel_lead_on_owner_exit() OWNER TO swarm_admin;
ALTER FUNCTION swarm.reset_channel_lead_on_member_removal() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.channel_effective_live_lead(uuid, uuid),
  swarm.reset_channel_lead_on_principal_revoke(), swarm.reset_channel_lead_on_agent_exit(),
  swarm.reset_channel_lead_on_owner_exit(), swarm.reset_channel_lead_on_member_removal()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.channel_effective_live_lead(uuid, uuid) TO swarm_command;

-- Append the lead setting at the end; the private-channel gate is unchanged.
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
    c.visibility,
    c.lead_mode,
    c.lead_agent_principal_id
  FROM swarm.channels AS c
  WHERE swarm.is_member(c.workspace_id, auth.uid())
    AND swarm.claims_can_access_channel(c.workspace_id, c.channel_id);

ALTER VIEW swarm_read.channels OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.channels TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.channels FROM PUBLIC, anon;
RESET search_path;
