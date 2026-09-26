-- Read-only Boolean for the state after 20260927000003-rollback.sql.
SELECT
  NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'signals'
      AND column_name IN ('parent_signal_id', 'chain_root_id', 'chain_hop', 'chain_participants'))
  AND to_regclass('swarm.signals_chain_parent_children') IS NULL
  AND pg_get_viewdef('swarm_read.signals'::regclass, true) NOT LIKE '%chain_hop%'
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260927000003')
  AS rollback_ok
\gset
