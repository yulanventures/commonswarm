-- Read-only Boolean for the state after 20260926000001-rollback.sql.
-- The primary-key index, policy, constraints and internal FK triggers cannot
-- survive removal of their table; check the named index and policy as well.
SELECT
  to_regclass('swarm.agent_wake_leases') IS NULL
  AND to_regclass('swarm.agent_wake_leases_pkey') IS NULL
  AND to_regclass('swarm_read.agent_wake_leases') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'wake_lease_server_read')
  AND to_regprocedure('swarm.wake_seat_lock(uuid,uuid)') IS NULL
  AND to_regprocedure('swarm.claim_agent_wake_lease(uuid,uuid,uuid,text,uuid,text,boolean,integer)') IS NULL
  AND to_regprocedure('swarm.renew_agent_wake_lease(uuid,uuid,uuid,bigint)') IS NULL
  AND to_regprocedure('swarm.release_agent_wake_lease(uuid,uuid,uuid,bigint)') IS NULL
  AND to_regprocedure('swarm.agent_wake_lease_for_token(bytea,uuid)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260926000001')
  AS rollback_ok
\gset
