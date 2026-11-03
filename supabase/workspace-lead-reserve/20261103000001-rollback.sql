-- Guarded rollback for 20261103000001: restore the 20261027000001 view and drop the lead objects.
-- CREATE OR REPLACE VIEW cannot drop a column, so the view is recreated with its owner and grants.
SET search_path = swarm, pg_catalog, public;
DROP VIEW swarm_read.workspaces;
CREATE VIEW swarm_read.workspaces WITH (security_barrier = true) AS
SELECT w.workspace_id, w.name, w.archived_at, w.org_id, o.display_name AS org_display_name
FROM swarm.workspaces w JOIN swarm.organizations o ON o.id = w.org_id
WHERE swarm.is_member(w.workspace_id, auth.uid()) AND w.archived_at IS NULL;
ALTER VIEW swarm_read.workspaces OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.workspaces TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.workspaces FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS agent_principals_clear_workspace_lead ON swarm.agent_principals;
DROP TRIGGER IF EXISTS agent_workspace_memberships_clear_lead ON swarm.agent_workspace_memberships;
DROP TRIGGER IF EXISTS memberships_clear_workspace_lead ON swarm.memberships;
DROP FUNCTION IF EXISTS swarm.clear_workspace_lead_on_principal_revoke();
DROP FUNCTION IF EXISTS swarm.clear_workspace_lead_on_agent_exit();
DROP FUNCTION IF EXISTS swarm.clear_workspace_lead_on_owner_exit();
DROP FUNCTION IF EXISTS swarm.set_workspace_lead(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS swarm.workspace_live_lead(uuid);
ALTER TABLE swarm.workspaces DROP COLUMN IF EXISTS lead_agent_principal_id;
RESET search_path;
