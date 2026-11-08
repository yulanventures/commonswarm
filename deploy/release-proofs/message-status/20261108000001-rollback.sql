-- Guarded rollback for 20261108000001: restore the home-workspace reference. It refuses while any
-- snapshot belongs to a non-home workspace, which the old constraint cannot hold. Snapshots expire
-- after two minutes, so stop secondary-workspace agents' status frames and retry if it refuses.
SET search_path = swarm, pg_catalog, public;
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.agent_message_working w WHERE NOT EXISTS(
   SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=w.principal_id AND p.workspace_id=w.workspace_id))
 THEN RAISE EXCEPTION 'Working snapshots outside home workspaces exist; rollback refused' USING ERRCODE='55000'; END IF;
END $guard$;
ALTER TABLE swarm.agent_message_working DROP CONSTRAINT agent_message_working_principal_id_workspace_id_fkey;
ALTER TABLE swarm.agent_message_working ADD CONSTRAINT agent_message_working_principal_id_workspace_id_fkey
  FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals (principal_id, workspace_id);
RESET search_path;
