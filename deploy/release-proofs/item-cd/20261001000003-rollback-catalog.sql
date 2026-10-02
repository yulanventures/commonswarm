-- Pre-migration catalog after reverse rollback for 20261001000003.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)') IS NULL
    AND to_regclass('swarm.admin_grants') IS NOT NULL
    AND to_regclass('swarm.admin_created_workspaces') IS NOT NULL
  ), false) AS rollback_ok
\gset
