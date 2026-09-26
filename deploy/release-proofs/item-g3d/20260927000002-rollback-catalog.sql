-- Read-only Boolean for the state after 20260927000002-rollback.sql.
SELECT
  to_regclass('swarm_read.agent_presence') IS NULL
  AND to_regclass('swarm.agent_presence') IS NULL
  AND to_regclass('swarm.agent_presence_pkey') IS NULL
  AND to_regclass('swarm.signal_deliveries_presence_latest_ack') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_policy
    WHERE polname = 'agent_presence_command_all')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'signal_deliveries'
      AND column_name = 'ack_via')
  AND NOT EXISTS (SELECT 1 FROM swarm.config
    WHERE key = 'current_client_build')
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260927000002')
  AS rollback_ok
\gset
