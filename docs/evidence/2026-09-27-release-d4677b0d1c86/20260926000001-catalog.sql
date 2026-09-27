-- Read-only section-5 catalog proof. One false Boolean stops the window.
SELECT
  COALESCE((SELECT c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND c.relrowsecurity AND
    NOT has_table_privilege('anon', c.oid, 'SELECT') AND
    NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND
    NOT has_table_privilege('swarm_read', c.oid, 'SELECT')
    FROM pg_class c WHERE c.oid = to_regclass('swarm.agent_wake_leases')), false)
  AND COALESCE((SELECT count(*) = 2 FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.agent_wake_leases')
      AND contype IN ('p', 'f')), false)
  AND COALESCE((SELECT c.relkind = 'v' AND c.reloptions @> ARRAY['security_barrier=true']
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND has_table_privilege('authenticated', c.oid, 'SELECT')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
    AND pg_get_viewdef(c.oid) LIKE '%is_member%'
    AND pg_get_viewdef(c.oid) LIKE '%renewed_at%'
    FROM pg_class c WHERE c.oid = to_regclass('swarm_read.agent_wake_leases')), false)
  AND COALESCE((SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'swarm_admin'
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND pg_get_functiondef(p.oid) LIKE '%h0_poll_locks%'
    AND pg_get_functiondef(p.oid) LIKE '%generation + 1%'
    FROM pg_proc p WHERE p.oid = to_regprocedure(
      'swarm.claim_agent_wake_lease(uuid,uuid,uuid,text,uuid,text,boolean,integer)')), false)
  AND COALESCE((SELECT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND pg_get_functiondef(p.oid) LIKE '%watcher_id = p_watcher%'
    AND pg_get_functiondef(p.oid) LIKE '%generation = p_generation%'
    FROM pg_proc p WHERE p.oid = to_regprocedure(
      'swarm.release_agent_wake_lease(uuid,uuid,uuid,bigint)')), false)
  AND COALESCE((SELECT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND pg_get_functiondef(p.oid) LIKE '%wake_lease_superseded%'
    FROM pg_proc p WHERE p.oid = to_regprocedure(
      'swarm.renew_agent_wake_lease(uuid,uuid,uuid,bigint)')), false)
  AND COALESCE((SELECT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND pg_get_functiondef(p.oid) LIKE '%agent_delivery_read_context%'
    FROM pg_proc p WHERE p.oid = to_regprocedure(
      'swarm.agent_wake_lease_for_token(bytea,uuid)')), false)
  AS catalog_ok
\gset
