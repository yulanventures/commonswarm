-- Local rollback fixture only; production application requires a reviewed plan.
DROP TRIGGER IF EXISTS admin_end_pending_invitations ON swarm.admin_grants;
DROP FUNCTION IF EXISTS swarm.admin_end_pending_invitations();
DROP TRIGGER IF EXISTS admin_principal_ancestry ON swarm.agent_principals;
DROP FUNCTION IF EXISTS swarm.admin_principal_ancestry();
DROP TRIGGER IF EXISTS aa_admin_token_ancestry ON swarm.agent_tokens;
DROP FUNCTION IF EXISTS swarm.admin_token_ancestry();
DROP POLICY IF EXISTS admin_parent_select ON swarm.agent_tokens;
DROP FUNCTION IF EXISTS swarm.admin_child_scopes_live(uuid,jsonb);
DROP FUNCTION IF EXISTS swarm.admin_child_live(uuid,uuid);
ALTER TABLE swarm.agent_tokens DROP COLUMN IF EXISTS parent_admin_grant_id, DROP COLUMN IF EXISTS recipient_connection_id;
ALTER TABLE swarm.agent_principals DROP COLUMN IF EXISTS parent_admin_grant_id;
DROP TABLE IF EXISTS swarm.admin_routine_invitations;
DROP TABLE IF EXISTS swarm.admin_created_workspaces;
ALTER TABLE swarm.events DROP CONSTRAINT IF EXISTS delegated_event_actor;
ALTER TABLE swarm.events DROP COLUMN IF EXISTS admin_identity_id, DROP COLUMN IF EXISTS grant_id, DROP COLUMN IF EXISTS grant_manifest_digest;
