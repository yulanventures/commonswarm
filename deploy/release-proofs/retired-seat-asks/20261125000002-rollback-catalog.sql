-- Read-only rollback catalog verification for 20261125000002 (retired_seat_asks_prep).
SELECT
  NOT EXISTS (
    SELECT 1 FROM swarm.config c
    WHERE c.key = 'retired_seat_ask_clear_enabled'
  )
  AND to_regclass('swarm.agent_ask_lifecycle') IS NULL
  AND to_regclass('swarm.agent_ask_clear_events') IS NULL
  AND to_regprocedure('swarm.agent_ask_lifecycle_validate_refs()') IS NULL
  AND to_regprocedure('swarm.agent_workspace_memberships_seed_ask_lifecycle()') IS NULL
  AND to_regprocedure('swarm.agent_workspace_memberships_cleanup_ask_lifecycle()') IS NULL
  AND to_regprocedure('swarm.agent_ask_clear_events_validate_refs()') IS NULL
  AND to_regprocedure('swarm.signals_bind_seat_lifecycle_epoch()') IS NULL
  AND to_regprocedure('swarm.seat_is_disconnected_for_ask_clear(uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.seat_ask_lifecycle_epoch(uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.advance_seat_lifecycle_epoch(uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.clear_retired_seat_asks(uuid,uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.seat_ask_clear_release_allowed(uuid,uuid,uuid,bigint,timestamp with time zone)') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'swarm.signals'::regclass
      AND a.attname = 'sender_lifecycle_epoch'
      AND NOT a.attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'swarm.signals'::regclass
      AND t.tgname = 'signals_bind_seat_lifecycle_epoch'
      AND NOT t.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'swarm.agent_workspace_memberships'::regclass
      AND t.tgname = 'agent_workspace_memberships_seed_ask_lifecycle'
      AND NOT t.tgisinternal
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'swarm.agent_workspace_memberships'::regclass
      AND t.tgname = 'agent_workspace_memberships_cleanup_ask_lifecycle'
      AND NOT t.tgisinternal
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.hosted_connection_policy(uuid,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('seat.revoked_at IS NULL AND family.revoked_at IS NULL' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.hosted_connection_policy(uuid,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('seat_cleared' IN p.prosrc) = 0
      AND position('agent_ask_clear_events' IN p.prosrc) = 0
  )
  AND NOT has_function_privilege('swarm_command', 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.ask_is_withdrawn(uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('agent_ask_clear_events' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.ask_is_withdrawn(uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('agent_ask_clear_events' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('advance_seat_lifecycle_epoch' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)', 'EXECUTE')
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('advance_seat_lifecycle_epoch' IN p.prosrc) = 0
  )
  AND has_function_privilege('swarm_command', 'swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)', 'EXECUTE')
  AS rollback_ok
\gset
