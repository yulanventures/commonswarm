-- Read-only catalog verification for 20261119000002 (agent removal scope read).
SELECT
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('swarm_read.agent_removal_scope(uuid,uuid)') AND p.prosecdef AND p.provolatile = 's')
  AND has_function_privilege('authenticated', 'swarm_read.agent_removal_scope(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm_read.agent_removal_scope(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm_read.agent_removal_scope(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm_read.agent_removal_scope(uuid,uuid)', 'EXECUTE')
  AS catalog_ok
\gset
