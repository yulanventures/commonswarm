-- Read-only rollback catalog verification for 20261125000001 (ask_withdrawals + dismissal instance).
SELECT
  to_regclass('swarm.ask_withdrawals') IS NULL
  AND to_regprocedure('swarm.ask_withdrawal_validate_refs()') IS NULL
  AND to_regprocedure('swarm.ask_is_withdrawn(uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)') IS NULL
  AND to_regprocedure('swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)') IS NULL
  AND to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'swarm.waiting_dismissals'::regclass
      AND a.attname = 'dismissal_id'
      AND NOT a.attisdropped
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('ask_withdrawals' IN p.prosrc) = 0
  )
  AND NOT has_function_privilege('public', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.dismiss_waiting_item(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('dismissal_id' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.dismiss_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('dismissal_id' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.restore_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('''offer_id''' IN p.prosrc) = 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AS rollback_ok
\gset
