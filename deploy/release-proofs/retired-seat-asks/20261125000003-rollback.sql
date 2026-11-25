-- Rollback for 20261125000003 (retired_seat_asks_enable):
-- Restores the rollout gate in swarm.config back to false.
SET search_path = swarm, pg_catalog, public;

UPDATE swarm.config
SET value = 'false'::jsonb
WHERE key = 'retired_seat_ask_clear_enabled';

RESET search_path;
