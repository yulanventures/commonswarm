-- Read-only rollback catalog verification for 20261124000002 (waiting_autoclear).
SELECT
  to_regprocedure('swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)') IS NULL
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('waiting_ask_autoclear_status' IN p.prosrc) = 0
  )
  AND NOT has_function_privilege('public', 'swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.home_overview()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('waiting_ask_eligible' IN p.prosrc) = 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.home_overview()', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('waiting_ask_autoclear_status' IN p.prosrc) = 0
      AND position('withdrawn' IN p.prosrc) = 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
  AS rollback_ok
\gset
