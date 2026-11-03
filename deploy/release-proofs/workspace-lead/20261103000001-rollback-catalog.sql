-- Read-only rollback catalog verification for 20261103000001.
SELECT NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.workspaces'::regclass AND attname='lead_agent_principal_id' AND NOT attisdropped)
 AND to_regprocedure('swarm.workspace_live_lead(uuid)') IS NULL
 AND to_regprocedure('swarm.set_workspace_lead(uuid,uuid,uuid)') IS NULL
 AND to_regprocedure('swarm.clear_workspace_lead_on_principal_revoke()') IS NULL
 AND to_regprocedure('swarm.clear_workspace_lead_on_agent_exit()') IS NULL
 AND to_regprocedure('swarm.clear_workspace_lead_on_owner_exit()') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm_read.workspaces'::regclass AND attname='lead_agent_principal_id' AND NOT attisdropped)
 AND has_table_privilege('authenticated','swarm_read.workspaces','SELECT')
 AND (SELECT relowner='swarm_admin'::regrole FROM pg_class WHERE oid='swarm_read.workspaces'::regclass)
 AS rollback_ok
\gset
