SELECT to_regclass('swarm.organizations') IS NULL AND to_regclass('swarm.org_memberships') IS NULL
 AND to_regprocedure('swarm.ensure_workspace_org()') IS NULL AND to_regprocedure('swarm.sync_membership_to_org()') IS NULL
 AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.workspaces') AND attname='org_id' AND NOT attisdropped)
 AND (SELECT array_agg(attname::text ORDER BY attnum)=ARRAY['workspace_id','name','archived_at']
 FROM pg_attribute WHERE attrelid=to_regclass('swarm_read.workspaces') AND attnum>0 AND NOT attisdropped)
 AND coalesce((SELECT relowner='swarm_admin'::regrole AND reloptions @> ARRAY['security_barrier=true']
 AND md5(regexp_replace(pg_get_viewdef(oid), '(swarm[.]|auth[.])', '', 'g'))='82e15a957682d2bc42d1d42f1034ade9'
 AND has_table_privilege('authenticated',oid,'SELECT') AND has_table_privilege('swarm_read',oid,'SELECT')
 AND NOT has_table_privilege('anon',oid,'SELECT') FROM pg_class WHERE oid=to_regclass('swarm_read.workspaces')),false)
 AS rollback_ok
\gset
