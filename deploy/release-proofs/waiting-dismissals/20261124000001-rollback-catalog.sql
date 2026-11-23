-- Read-only rollback catalog verification for 20261124000001 (waiting_dismissals).
SELECT
  to_regclass('swarm.waiting_dismissals') IS NULL
  AND to_regprocedure('swarm.dismiss_waiting_item(uuid,uuid,text,uuid)') IS NULL
  AND to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_item_can_read(uuid,uuid,text,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_dismissal_validate_refs()') IS NULL
  AND has_function_privilege('authenticated', 'swarm_read.decision_queue(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.decision_queue_page(uuid,timestamp with time zone,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.home_overview()', 'EXECUTE')
  AS rollback_ok
\gset
