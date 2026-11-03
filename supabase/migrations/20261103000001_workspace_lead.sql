-- Workspace Lead: an untagged top-level note or ask from a person wakes this agent.
-- Null means no lead: posts keep today's broadcast behaviour. Additive; no backfill.
SET search_path = swarm, pg_catalog, public;
LOCK TABLE swarm.workspaces, swarm.memberships, swarm.agent_principals, swarm.agent_workspace_memberships
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE swarm.workspaces
  ADD COLUMN lead_agent_principal_id uuid REFERENCES swarm.agent_principals(principal_id);

-- The lead only while it can be woken here: a live local, non-turn-only principal with a live
-- membership in this workspace, whose owner is still a member, in a workspace that is not archived.
CREATE FUNCTION swarm.workspace_live_lead(p_workspace uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.principal_id FROM swarm.workspaces w
 JOIN swarm.agent_principals p ON p.principal_id=w.lead_agent_principal_id
 JOIN swarm.agent_workspace_memberships am ON am.principal_id=p.principal_id AND am.workspace_id=w.workspace_id
 JOIN swarm.memberships owner ON owner.workspace_id=w.workspace_id AND owner.user_id=p.owner_user_id
 WHERE w.workspace_id=p_workspace AND w.archived_at IS NULL
   AND p.revoked_at IS NULL AND p.transport='local' AND NOT p.turn_only
   AND am.revoked_at IS NULL AND owner.revoked_at IS NULL
$$;

-- Owners and admins of a live workspace set or clear (null) the lead. The lead must be woken by
-- deliveries, so hosted and turn-only principals and join registrars are refused.
CREATE FUNCTION swarm.set_workspace_lead(p_workspace uuid, p_principal uuid, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w ON w.workspace_id=m.workspace_id
   WHERE m.workspace_id=p_workspace AND m.user_id=p_actor AND m.revoked_at IS NULL
     AND m.role IN ('owner','admin') AND w.archived_at IS NULL) THEN RETURN false; END IF;
 IF p_principal IS NOT NULL AND NOT EXISTS(SELECT 1 FROM swarm.agent_principals p
   JOIN swarm.agent_workspace_memberships am ON am.principal_id=p.principal_id AND am.workspace_id=p_workspace AND am.revoked_at IS NULL
   JOIN swarm.memberships owner ON owner.workspace_id=p_workspace AND owner.user_id=p.owner_user_id AND owner.revoked_at IS NULL
   WHERE p.principal_id=p_principal AND p.revoked_at IS NULL AND p.transport='local' AND NOT p.turn_only
     AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p_principal)) THEN RETURN false; END IF;
 UPDATE swarm.workspaces SET lead_agent_principal_id=p_principal WHERE workspace_id=p_workspace;
 RETURN true;
END $$;

-- Invariant: a lead that leaves (principal revoked, removed from the workspace, or its owner
-- leaves the workspace) is cleared, so the stored value never names a dead agent.
CREATE FUNCTION swarm.clear_workspace_lead_on_principal_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE swarm.workspaces SET lead_agent_principal_id=NULL WHERE lead_agent_principal_id=NEW.principal_id;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_principals_clear_workspace_lead AFTER UPDATE OF revoked_at ON swarm.agent_principals
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION swarm.clear_workspace_lead_on_principal_revoke();

CREATE FUNCTION swarm.clear_workspace_lead_on_agent_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE swarm.workspaces SET lead_agent_principal_id=NULL
 WHERE workspace_id=NEW.workspace_id AND lead_agent_principal_id=NEW.principal_id;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_workspace_memberships_clear_lead AFTER UPDATE OF revoked_at ON swarm.agent_workspace_memberships
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION swarm.clear_workspace_lead_on_agent_exit();

CREATE FUNCTION swarm.clear_workspace_lead_on_owner_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE swarm.workspaces w SET lead_agent_principal_id=NULL FROM swarm.agent_principals p
 WHERE w.workspace_id=NEW.workspace_id AND p.principal_id=w.lead_agent_principal_id AND p.owner_user_id=NEW.user_id;
 RETURN NEW;
END $$;
CREATE TRIGGER memberships_clear_workspace_lead AFTER UPDATE OF revoked_at ON swarm.memberships
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION swarm.clear_workspace_lead_on_owner_exit();

ALTER FUNCTION swarm.workspace_live_lead(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.set_workspace_lead(uuid,uuid,uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.clear_workspace_lead_on_principal_revoke() OWNER TO swarm_admin;
ALTER FUNCTION swarm.clear_workspace_lead_on_agent_exit() OWNER TO swarm_admin;
ALTER FUNCTION swarm.clear_workspace_lead_on_owner_exit() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.workspace_live_lead(uuid), swarm.set_workspace_lead(uuid,uuid,uuid),
  swarm.clear_workspace_lead_on_principal_revoke(), swarm.clear_workspace_lead_on_agent_exit(),
  swarm.clear_workspace_lead_on_owner_exit()
FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.workspace_live_lead(uuid), swarm.set_workspace_lead(uuid,uuid,uuid) TO swarm_command;

-- Members see their workspace's lead. Appended column; earlier columns are unchanged.
CREATE OR REPLACE VIEW swarm_read.workspaces WITH (security_barrier = true) AS
SELECT w.workspace_id, w.name, w.archived_at, w.org_id, o.display_name AS org_display_name,
  w.lead_agent_principal_id
FROM swarm.workspaces w JOIN swarm.organizations o ON o.id = w.org_id
WHERE swarm.is_member(w.workspace_id, auth.uid()) AND w.archived_at IS NULL;
ALTER VIEW swarm_read.workspaces OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.workspaces TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.workspaces FROM PUBLIC, anon;
RESET search_path;
