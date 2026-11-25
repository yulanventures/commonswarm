-- Retired-seat ask clearing (Phase 2 / enable, R4 design):
-- Deferred migration (MIGRATION_DEFERRED_VERSIONS), applied only after the new command edge
-- bundle supplying explicit sender_lifecycle_epoch is live and old edge containers have drained.
-- Atomically enables clear_retired_seat_asks, advance_seat_lifecycle_epoch, and strict 42501
-- rejection of NULL sender_lifecycle_epoch on new agent asks.
SET search_path = swarm, pg_catalog, public;

UPDATE swarm.config
SET value = 'true'::jsonb
WHERE key = 'retired_seat_ask_clear_enabled';

RESET search_path;
