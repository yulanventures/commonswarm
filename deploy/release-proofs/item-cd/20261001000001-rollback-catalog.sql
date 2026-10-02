-- Pre-migration catalog after reverse rollback for 20261001000001.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    to_regclass('swarm.admin_accounts') IS NULL
    AND to_regclass('swarm.admin_grants') IS NULL
    AND to_regclass('swarm.admin_consents') IS NULL
    AND to_regclass('swarm.admin_credentials') IS NULL
    AND to_regclass('swarm.admin_events') IS NULL
    AND to_regclass('swarm.admin_command_results') IS NULL
    AND to_regclass('swarm.admin_rate_buckets') IS NULL
    AND to_regclass('swarm.admin_security_audit') IS NULL
    AND to_regclass('swarm.users') IS NOT NULL
    AND to_regclass('swarm.admin_grants_owner') IS NULL
    AND to_regclass('swarm.admin_grants_connection') IS NULL
    AND to_regclass('swarm.admin_grants_active_connection') IS NULL
    AND to_regclass('swarm.admin_credentials_grant') IS NULL
  ), false) AS rollback_ok
\gset
