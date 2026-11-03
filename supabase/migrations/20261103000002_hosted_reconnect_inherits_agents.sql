-- Reconnect restores stranded hosted agents (GameMaster, 2026-11-03).
-- When an owner activates a new hosted grant, it inherits that owner's hosted agents that were
-- bound only to grants from the SAME OAuth client whose refresh family was retired
-- (refresh_family_tombstones) while the grant itself was never revoked or expired. Those agents
-- otherwise could never be claimed again. Revoked or expired grants are owner intent and are not
-- inherited; an agent with any still-usable binding is left alone. Additive; no backfill.
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
 RETURN n;
END $$;
ALTER FUNCTION swarm.inherit_stranded_hosted_agents(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.inherit_stranded_hosted_agents(uuid) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.inherit_stranded_hosted_agents(uuid) TO swarm_command;
