-- Read-only rollback catalog verification for 20261125000004 (todo_approvals).
SELECT
  NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'swarm'
      AND table_name = 'household_todos'
      AND column_name IN ('kind', 'decision_status', 'decision_by_user', 'decision_at', 'decision_note')
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('offer_gate' IN p.prosrc) = 0
      AND position('notes_preview' IN p.prosrc) = 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('decision_status' IN p.prosrc) = 0
      AND position('decision_note' IN p.prosrc) = 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.home_overview()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('decision_status' IN p.prosrc) = 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.home_overview()', 'EXECUTE')
  AS rollback_ok
\gset
