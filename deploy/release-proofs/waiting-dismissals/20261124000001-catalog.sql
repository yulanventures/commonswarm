-- Read-only catalog verification for 20261124000001 (waiting_dismissals).
SELECT
  to_regclass('swarm.waiting_dismissals') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'swarm'
      AND c.relname = 'waiting_dismissals'
      AND c.relrowsecurity
      AND c.relowner = 'swarm_admin'::regrole
  )
  AND to_regclass('swarm.waiting_dismissals_workspace_user_active') IS NOT NULL
  AND NOT has_table_privilege('anon', 'swarm.waiting_dismissals', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'swarm.waiting_dismissals', 'SELECT')
  AND NOT has_table_privilege('swarm_read', 'swarm.waiting_dismissals', 'SELECT')
  AND NOT has_table_privilege('swarm_command', 'swarm.waiting_dismissals', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'swarm.waiting_dismissals', 'INSERT')
  AND NOT has_table_privilege('swarm_command', 'swarm.waiting_dismissals', 'INSERT')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.dismiss_waiting_item(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND has_function_privilege('swarm_command', 'swarm.dismiss_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND has_function_privilege('swarm_command', 'swarm.restore_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.dismiss_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.restore_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.dismiss_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.restore_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.dismiss_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.restore_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.waiting_item_can_read(uuid,uuid,text,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.decision_queue(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.decision_queue_page(uuid,timestamp with time zone,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.home_overview()', 'EXECUTE')
  AS catalog_ok
\gset
