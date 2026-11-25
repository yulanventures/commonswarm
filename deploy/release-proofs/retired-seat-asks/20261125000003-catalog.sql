-- Read-only catalog verification for 20261125000003 (retired_seat_asks_enable).
SELECT
  EXISTS (
    SELECT 1 FROM swarm.config c
    WHERE c.key = 'retired_seat_ask_clear_enabled'
      AND c.value = 'true'::jsonb
  )
  AND to_regclass('swarm.agent_ask_lifecycle') IS NOT NULL
  AND to_regclass('swarm.agent_ask_clear_events') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('swarm.signals_bind_seat_lifecycle_epoch()')
      AND p.prosecdef AND p.proowner = 'swarm_admin'::regrole
      AND position('SEAT_LIFECYCLE_EPOCH_REQUIRED' IN p.prosrc) > 0
  )
  AS catalog_ok
\gset
