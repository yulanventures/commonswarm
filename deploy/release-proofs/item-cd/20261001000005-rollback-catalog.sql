-- Pre-migration catalog after reverse rollback for 20261001000005.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    to_regprocedure('swarm.admin_routine_workspace_history(uuid,uuid,uuid)') IS NULL
    AND to_regclass('swarm.admin_routine_workspace_events') IS NULL
    AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('swarm.events') AND attnum>0 AND NOT attisdropped AND NOT attnotnull AND (attname::text,atttypid) IN (('admin_identity_id','uuid'::regtype),('grant_id','uuid'::regtype),('grant_manifest_digest','text'::regtype))) = 3
    AND NOT has_table_privilege('swarm_command',to_regclass('swarm.events'),'SELECT')
    AND has_table_privilege('swarm_command',to_regclass('swarm.events'),'INSERT')
  ), false) AS rollback_ok
\gset
