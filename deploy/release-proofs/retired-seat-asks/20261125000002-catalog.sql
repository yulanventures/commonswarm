-- Read-only catalog verification for 20261125000002 (retired_seat_asks_prep).
SELECT
  EXISTS (
    SELECT 1 FROM swarm.config c
    WHERE c.key = 'retired_seat_ask_clear_enabled'
      AND c.value IN ('false'::jsonb, 'true'::jsonb)
  )
  AND to_regclass('swarm.agent_ask_lifecycle') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'swarm'
      AND c.relname = 'agent_ask_lifecycle'
      AND c.relrowsecurity
      AND c.relowner = 'swarm_admin'::regrole
  )
  AND NOT has_table_privilege('public', 'swarm.agent_ask_lifecycle', 'SELECT')
  AND NOT has_table_privilege('anon', 'swarm.agent_ask_lifecycle', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'swarm.agent_ask_lifecycle', 'SELECT')
  AND NOT has_table_privilege('swarm_read', 'swarm.agent_ask_lifecycle', 'SELECT')
  AND NOT has_table_privilege('swarm_command', 'swarm.agent_ask_lifecycle', 'SELECT')
  AND NOT has_table_privilege('swarm_command', 'swarm.agent_ask_lifecycle', 'INSERT')
  AND NOT has_table_privilege('swarm_command', 'swarm.agent_ask_lifecycle', 'UPDATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    WHERE con.conrelid = 'swarm.agent_ask_lifecycle'::regclass
      AND con.contype = 'f'
  )
  AND to_regclass('swarm.agent_ask_clear_events') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'swarm'
      AND c.relname = 'agent_ask_clear_events'
      AND c.relrowsecurity
      AND c.relowner = 'swarm_admin'::regrole
  )
  AND NOT has_table_privilege('public', 'swarm.agent_ask_clear_events', 'SELECT')
  AND NOT has_table_privilege('anon', 'swarm.agent_ask_clear_events', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'swarm.agent_ask_clear_events', 'SELECT')
  AND NOT has_table_privilege('swarm_read', 'swarm.agent_ask_clear_events', 'SELECT')
  AND NOT has_table_privilege('swarm_command', 'swarm.agent_ask_clear_events', 'SELECT')
  AND NOT has_table_privilege('swarm_command', 'swarm.agent_ask_clear_events', 'INSERT')
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    WHERE con.conrelid = 'swarm.agent_ask_clear_events'::regclass
      AND con.contype = 'f'
  )
  AND EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'swarm.signals'::regclass
      AND a.attname = 'sender_lifecycle_epoch'
      AND a.atttypid = 'bigint'::regtype
      AND NOT a.attnotnull
      AND NOT a.attisdropped
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'swarm.signals'::regclass
      AND t.tgname = 'signals_bind_seat_lifecycle_epoch'
      AND NOT t.tgisinternal
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'swarm.agent_workspace_memberships'::regclass
      AND t.tgname = 'agent_workspace_memberships_seed_ask_lifecycle'
      AND NOT t.tgisinternal
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.agent_ask_lifecycle_validate_refs()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND NOT has_function_privilege('public', 'swarm.agent_ask_lifecycle_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.agent_ask_lifecycle_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.agent_ask_lifecycle_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.agent_ask_lifecycle_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.agent_ask_lifecycle_validate_refs()', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.agent_workspace_memberships_seed_ask_lifecycle()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND NOT has_function_privilege('public', 'swarm.agent_workspace_memberships_seed_ask_lifecycle()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.agent_workspace_memberships_seed_ask_lifecycle()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.agent_workspace_memberships_seed_ask_lifecycle()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.agent_workspace_memberships_seed_ask_lifecycle()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.agent_workspace_memberships_seed_ask_lifecycle()', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.agent_ask_clear_events_validate_refs()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
  )
  AND NOT has_function_privilege('public', 'swarm.agent_ask_clear_events_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.agent_ask_clear_events_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.agent_ask_clear_events_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.agent_ask_clear_events_validate_refs()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.agent_ask_clear_events_validate_refs()', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.signals_bind_seat_lifecycle_epoch()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('SEAT_LIFECYCLE_EPOCH_REQUIRED' IN p.prosrc) > 0
      AND position('SEAT_LIFECYCLE_EPOCH_INVALID' IN p.prosrc) > 0
      AND position('SEAT_LIFECYCLE_EPOCH_UNEXPECTED' IN p.prosrc) > 0
  )
  AND NOT has_function_privilege('public', 'swarm.signals_bind_seat_lifecycle_epoch()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.signals_bind_seat_lifecycle_epoch()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.signals_bind_seat_lifecycle_epoch()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.signals_bind_seat_lifecycle_epoch()', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.signals_bind_seat_lifecycle_epoch()', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND p.provolatile = 's'
      AND position('provider_family_active' IN p.prosrc) > 0
      AND position('refresh_family_tombstones' IN p.prosrc) > 0
  )
  AND NOT has_function_privilege('public', 'swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.seat_ask_lifecycle_epoch(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND p.provolatile = 's'
  )
  AND has_function_privilege('swarm_command', 'swarm.seat_ask_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.seat_ask_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.seat_ask_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.seat_ask_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.seat_ask_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.advance_seat_lifecycle_epoch(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND p.provolatile = 'v'
      AND position('retired_seat_ask_clear_enabled' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.advance_seat_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.advance_seat_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.advance_seat_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.advance_seat_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.advance_seat_lifecycle_epoch(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.clear_retired_seat_asks(uuid,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND p.provolatile = 'v'
      AND position('retired_seat_ask_clear_enabled' IN p.prosrc) > 0
      AND position('seat_is_disconnected_for_ask_clear' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.clear_retired_seat_asks(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.clear_retired_seat_asks(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.clear_retired_seat_asks(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.clear_retired_seat_asks(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.clear_retired_seat_asks(uuid,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND p.provolatile = 's'
      AND position('agent_ask_clear_events' IN p.prosrc) > 0
      AND position('seat_is_disconnected_for_ask_clear' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.hosted_connection_policy(uuid,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('seat.revoked_at IS NULL AND family.revoked_at IS NULL' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.hosted_connection_policy(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.hosted_connection_policy(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.hosted_connection_policy(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.hosted_connection_policy(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.hosted_connection_policy(uuid,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('seat_cleared' IN p.prosrc) > 0
      AND position('Cleared (seat inactive)' IN p.prosrc) > 0
      AND position('agent_ask_clear_events' IN p.prosrc) > 0
  )
  AND NOT has_function_privilege('public', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_command', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_is_withdrawn(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('agent_ask_clear_events' IN p.prosrc) > 0
      AND position('ask_complete_for_withdrawal' IN p.prosrc) = 0
      AND position('ask_answered' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('swarm_read', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('agent_ask_clear_events' IN p.prosrc) > 0
      AND position('swarm.waiting_ask_autoclear_status(' IN p.prosrc) > 0
      AND position('swarm.ask_complete_for_withdrawal(' IN p.prosrc) > 0
      AND position('swarm.waiting_ask_autoclear_status(' IN p.prosrc) < position('swarm.ask_complete_for_withdrawal(' IN p.prosrc)
  )
  AND has_function_privilege('swarm_command', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('advance_seat_lifecycle_epoch' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('advance_seat_lifecycle_epoch' IN p.prosrc) > 0
  )
  AND has_function_privilege('swarm_command', 'swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)', 'EXECUTE')
  AS catalog_ok
\gset
