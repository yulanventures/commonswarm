-- Channel lead backup: a channel whose own lead is not listening wakes the workspace lead instead.
--
-- In 'agent' mode, swarm.channel_effective_live_lead (20261117000002) woke the named agent even while
-- it had no listener, so the post waited in a queue nobody read; and a named agent that failed a
-- live check woke nobody. Now, when the named agent is not eligible or not listening, the post goes
-- to the workspace lead instead, if the workspace lead is eligible, listening and can read the
-- channel. Otherwise the answer is what it was: the named agent when it is eligible (its delivery
-- waits for it), or null. One agent is woken, never both. 'workspace' and 'none' modes, archived
-- channels and general are unchanged. Only who is woken changes: the edge (command/index.ts) asks
-- this function and is not changed.
--
-- "Listening" (swarm.agent_listener_is_live) reads the agent's presence rows and wake leases. They
-- are keyed by (workspace, principal) for any workspace the agent belongs to (the edge stamps its
-- first workspace), so it reads them through the agent's swarm.agent_workspace_memberships rows, in
-- whichever workspace they were written. Each route has the window its idle heartbeat allows: a wake lease
-- renews every 60 s and the watcher and channel routes stamp at least as often, so 180 s
-- (WAKE_LEASE_STALE_MS, as the app's presence labels use); a `cswarm listen` listener on push wake
-- claims only on its 300 s reconcile when idle, so listener_at gets 360 s. turn_at and
-- last_command_at never count: a turn-only touch is not a listener.
--
-- Rollback: deploy/release-proofs/channel-lead-backup/20261118000001-rollback.sql.
SET search_path = swarm, pg_catalog, public;

CREATE FUNCTION swarm.agent_listener_is_live(p_principal uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
      SELECT 1
      FROM swarm.agent_workspace_memberships AS am
      JOIN swarm.agent_presence AS pr
        ON pr.workspace_id = am.workspace_id AND pr.principal_id = am.principal_id
      WHERE am.principal_id = p_principal
        AND (pr.watcher_at >= statement_timestamp() - interval '180 seconds'
          OR pr.channel_at >= statement_timestamp() - interval '180 seconds'
          OR pr.listener_at >= statement_timestamp() - interval '360 seconds'))
    OR EXISTS (
      SELECT 1
      FROM swarm.agent_workspace_memberships AS am
      JOIN swarm.agent_wake_leases AS l
        ON l.workspace_id = am.workspace_id AND l.principal_id = am.principal_id
      WHERE am.principal_id = p_principal
        AND l.renewed_at >= statement_timestamp() - interval '180 seconds')
$$;

-- Who an untagged top-level person post in this channel wakes now, or null.
CREATE OR REPLACE FUNCTION swarm.channel_effective_live_lead(p_workspace uuid, p_channel uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_mode text;
  v_agent uuid;
  v_archived timestamptz;
  v_lead uuid;
  v_backup uuid;
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
    IF v_lead IS NULL OR NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', v_lead) THEN
      RETURN NULL;
    END IF;
    RETURN v_lead;
  END IF;
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
  IF v_lead IS NOT NULL AND NOT swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', v_lead) THEN
    v_lead := NULL;
  END IF;
  IF v_lead IS NOT NULL AND swarm.agent_listener_is_live(v_lead) THEN
    RETURN v_lead;
  END IF;
  -- The channel's own agent is not eligible or not listening: the workspace lead instead, if it is.
  v_backup := swarm.workspace_live_lead(p_workspace);
  IF v_backup IS NOT NULL AND v_backup IS DISTINCT FROM v_lead
    AND swarm.actor_can_access_channel(p_workspace, p_channel, 'agent', v_backup)
    AND swarm.agent_listener_is_live(v_backup) THEN
    RETURN v_backup;
  END IF;
  RETURN v_lead;
END;
$$;

ALTER FUNCTION swarm.agent_listener_is_live(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_listener_is_live(uuid)
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
RESET search_path;
