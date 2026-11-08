-- Read-only catalog verification for 20261108000001: the Working snapshot references memberships.
SELECT (SELECT count(*)=1 FROM pg_constraint WHERE conrelid='swarm.agent_message_working'::regclass AND contype='f')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.agent_message_working'::regclass AND contype='f'
   AND conname='agent_message_working_principal_id_workspace_id_fkey' AND convalidated
   AND confrelid='swarm.agent_workspace_memberships'::regclass)
 AS catalog_ok
\gset
