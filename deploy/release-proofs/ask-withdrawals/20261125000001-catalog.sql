-- Read-only catalog verification for 20261125000001 (ask_withdrawals + dismissal instance).
SELECT
  to_regclass('swarm.ask_withdrawals') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'swarm'
      AND c.relname = 'ask_withdrawals'
      AND c.relrowsecurity
      AND c.relowner = 'swarm_admin'::regrole
  )
  AND NOT has_table_privilege('public', 'swarm.ask_withdrawals', 'SELECT')
  AND NOT has_table_privilege('anon', 'swarm.ask_withdrawals', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'swarm.ask_withdrawals', 'SELECT')
  AND NOT has_table_privilege('swarm_read', 'swarm.ask_withdrawals', 'SELECT')
  AND NOT has_table_privilege('swarm_command', 'swarm.ask_withdrawals', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'swarm.ask_withdrawals', 'INSERT')
  AND NOT has_table_privilege('swarm_command', 'swarm.ask_withdrawals', 'INSERT')
  AND EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'swarm.waiting_dismissals'::regclass
      AND a.attname = 'dismissal_id'
      AND a.atttypid = 'uuid'::regtype
      AND a.attnotnull
      AND NOT a.attisdropped
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_is_withdrawn(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND has_function_privilege('swarm_command', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_sender_can_access_placement(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('actor_can_access_direct_conversation' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.ask_sender_can_access_placement(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.ask_sender_can_access_placement(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.ask_sender_can_access_placement(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.ask_sender_can_access_placement(uuid,uuid,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.ask_sender_can_access_placement(uuid,uuid,text,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_complete_for_withdrawal(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('ui_actions' IN p.prosrc) > 0
      AND position('to_agent_principal_id' IN p.prosrc) > 0
  )
  AND NOT has_function_privilege('swarm_command', 'swarm.ask_complete_for_withdrawal(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.ask_complete_for_withdrawal(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.ask_complete_for_withdrawal(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.ask_complete_for_withdrawal(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.ask_complete_for_withdrawal(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_withdrawal_release_allowed(uuid,text,uuid,uuid,uuid,boolean)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND p.provolatile = 'v'
      AND position('ask_sender_can_access_placement' IN p.prosrc) > 0
      AND position('clock_timestamp' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.ask_withdrawal_release_allowed(uuid,text,uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.ask_withdrawal_release_allowed(uuid,text,uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.ask_withdrawal_release_allowed(uuid,text,uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.ask_withdrawal_release_allowed(uuid,text,uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.ask_withdrawal_release_allowed(uuid,text,uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_withdrawal_effective_channel_ids(uuid,uuid[])')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('conversation_signals' IN p.prosrc) > 0
      AND position('coalesce' IN lower(p.prosrc)) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.ask_withdrawal_effective_channel_ids(uuid,uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.ask_withdrawal_effective_channel_ids(uuid,uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.ask_withdrawal_effective_channel_ids(uuid,uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.ask_withdrawal_effective_channel_ids(uuid,uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.ask_withdrawal_effective_channel_ids(uuid,uuid[])', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('ask_sender_can_access_placement' IN p.prosrc) > 0
      AND position('ask_complete_for_withdrawal' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('ask_withdrawals' IN p.prosrc) > 0
      AND position('Replaced by a newer question' IN p.prosrc) > 0
  )
  AND NOT has_function_privilege('public', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('waiting_dismissals' IN p.prosrc) = 0
      AND position('dismiss' IN lower(p.prosrc)) = 0
      AND position('ask_sender_can_access_placement' IN p.prosrc) > 0
      AND position('ask_complete_for_withdrawal' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_read', 'swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('''offer_id''' IN p.prosrc) > 0
  )
  AND has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.dismiss_waiting_item(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('dismissal_id' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.dismiss_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('dismissal_id' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.restore_waiting_item(uuid,uuid,text,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.restore_waiting_item(uuid,uuid,text,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND has_function_privilege('swarm_command', 'swarm.restore_waiting_item(uuid,uuid,text,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'swarm_read'
      AND c.relname = 'audit_log'
      AND c.relkind = 'v'
      AND c.relowner = 'swarm_admin'::regrole
      AND 'security_barrier=true' = ANY(coalesce(c.reloptions, '{}'::text[]))
  )
  AND has_table_privilege('authenticated', 'swarm_read.audit_log', 'SELECT')
  AND has_table_privilege('swarm_read', 'swarm_read.audit_log', 'SELECT')
  AND NOT has_table_privilege('anon', 'swarm_read.audit_log', 'SELECT')
  AND NOT has_table_privilege('public', 'swarm_read.audit_log', 'SELECT')
  AND position('withdraw_ask' IN pg_get_viewdef('swarm_read.audit_log'::regclass, true)) > 0
  AND position('dismiss_waiting_item' IN pg_get_viewdef('swarm_read.audit_log'::regclass, true)) > 0
  AND position('restore_waiting_item' IN pg_get_viewdef('swarm_read.audit_log'::regclass, true)) > 0
  AS catalog_ok
\gset
