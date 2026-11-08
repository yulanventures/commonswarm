-- Read-only rollback catalog verification for 20261108000001.
SELECT (SELECT count(*)=1 FROM pg_constraint WHERE conrelid='swarm.agent_message_working'::regclass AND contype='f')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.agent_message_working'::regclass AND contype='f'
   AND conname='agent_message_working_principal_id_workspace_id_fkey' AND confrelid='swarm.agent_principals'::regclass)
 AS rollback_ok
\gset
