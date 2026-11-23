-- Read-only rollback catalog verification for 20261124000001 (waiting_dismissals).
SELECT
  to_regclass('swarm.waiting_dismissals') IS NULL
  AND to_regprocedure('swarm.dismiss_waiting_item(uuid,uuid,text,uuid)') IS NULL
  AND to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_dismissal_replay_allowed(uuid,uuid,text,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_item_eligible(uuid,uuid,text,uuid,timestamp with time zone)') IS NULL
  AND to_regprocedure('swarm.waiting_review_eligible(uuid,uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_todo_eligible(uuid,uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_todo_reason(uuid,uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)') IS NULL
  AND to_regprocedure('swarm.waiting_dismissal_validate_refs()') IS NULL
  AND has_function_privilege('authenticated', 'swarm_read.decision_queue(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.decision_queue_page(uuid,timestamp with time zone,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'swarm_read.home_overview()', 'EXECUTE')
  AND has_table_privilege('authenticated', 'swarm_read.audit_log', 'SELECT')
  AND has_table_privilege('swarm_read', 'swarm_read.audit_log', 'SELECT')
  AND NOT has_table_privilege('anon', 'swarm_read.audit_log', 'SELECT')
  AND position('dismiss_waiting_item' IN pg_get_viewdef('swarm_read.audit_log'::regclass, true)) = 0
  AND position('restore_waiting_item' IN pg_get_viewdef('swarm_read.audit_log'::regclass, true)) = 0
  AS rollback_ok
\gset
