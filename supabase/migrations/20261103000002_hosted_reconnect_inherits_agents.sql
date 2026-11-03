-- Reconnect restores stranded hosted agents (GameMaster, 2026-11-03).
-- When an owner activates a new hosted grant, it inherits that owner's hosted agents that were
-- bound only to grants from the SAME OAuth client whose refresh family was retired
-- (refresh_family_tombstones) while the grant itself was never revoked or expired. Those agents
-- otherwise could never be claimed again. Revoked or expired grants are owner intent and are not
-- inherited; an agent with any still-usable binding is left alone. The stranded agent's live seats on
-- the retired grants are closed so its name is free to claim again. Additive; no backfill.
SET search_path = swarm, pg_catalog, public;

CREATE FUNCTION swarm.inherit_stranded_hosted_agents(p_grant uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 INSERT INTO swarm.hosted_mcp_grant_agents(grant_id,principal_id,owner_user_id)
 SELECT DISTINCT g.grant_id,p.principal_id,p.owner_user_id
 FROM swarm.hosted_mcp_grants g
 JOIN swarm.hosted_mcp_grants o ON o.owner_user_id=g.owner_user_id AND o.client_id=g.client_id AND o.grant_id<>g.grant_id
 JOIN swarm.hosted_mcp_grant_agents oa ON oa.grant_id=o.grant_id AND oa.owner_user_id=o.owner_user_id AND oa.revoked_at IS NULL
 JOIN swarm.agent_principals p ON p.principal_id=oa.principal_id AND p.owner_user_id=g.owner_user_id
 WHERE g.grant_id=p_grant AND g.state='active' AND g.revoked_at IS NULL AND g.connection_expired_at IS NULL
   AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
   AND commonswarm_oauth.provider_family_active(g.provider_grant_id)
   AND o.state='active' AND o.revoked_at IS NULL AND o.connection_expired_at IS NULL
   AND (o.connection_expires_at IS NULL OR o.connection_expires_at>clock_timestamp())
   AND EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones t WHERE t.grant_id=o.provider_grant_id)
   AND p.transport='hosted_mcp' AND p.turn_only AND p.revoked_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='principal' AND z.target_id=p.principal_id)
   -- Stranded: no live binding of this agent on any grant whose family can still mint tokens.
   AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_agents la JOIN swarm.hosted_mcp_grants lg ON lg.grant_id=la.grant_id
     WHERE la.principal_id=p.principal_id AND la.revoked_at IS NULL AND lg.state='active' AND lg.revoked_at IS NULL
       AND commonswarm_oauth.provider_family_active(lg.provider_grant_id))
   -- The new grant must consent to the agent's workspace, as bind_hosted_agent requires.
   AND swarm.hosted_binding_eligible(g.grant_id,p.workspace_id,NULL)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n = ROW_COUNT;
 -- A stranded agent's live seat on a retired-family grant still holds its live name
 -- (hosted_mcp_seats_live_name), so claiming on the new grant would collide. That grant can never
 -- mint again; close only its seats and handles for agents now bound to this grant, as the claim
 -- path's name reclaim does. Principal, memberships and history are untouched.
 WITH closed AS (
  UPDATE swarm.hosted_mcp_seats s SET revoked_at=clock_timestamp()
  FROM swarm.hosted_mcp_grants g, swarm.hosted_mcp_grants o
  WHERE g.grant_id=p_grant AND o.grant_id=s.grant_id AND o.grant_id<>g.grant_id
    AND o.owner_user_id=g.owner_user_id AND o.client_id=g.client_id AND s.owner_user_id=g.owner_user_id
    AND s.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones t WHERE t.grant_id=o.provider_grant_id)
    AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_agents ga WHERE ga.grant_id=g.grant_id AND ga.principal_id=s.principal_id AND ga.revoked_at IS NULL)
    AND swarm.hosted_binding_eligible(g.grant_id,s.workspace_id,s.principal_id)
  RETURNING s.seat_id)
 UPDATE swarm.hosted_mcp_seat_handles h SET revoked_at=clock_timestamp()
 FROM closed WHERE h.seat_id=closed.seat_id AND h.revoked_at IS NULL;
 RETURN n;
END $$;
ALTER FUNCTION swarm.inherit_stranded_hosted_agents(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.inherit_stranded_hosted_agents(uuid) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.inherit_stranded_hosted_agents(uuid) TO swarm_command;
