SELECT to_regclass('swarm_read.organizations') IS NULL
 AND to_regprocedure('swarm.org_allows_workspace_create(uuid,uuid)') IS NULL
 AND to_regprocedure('swarm.move_workspace_to_org(uuid,uuid,uuid,uuid)') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.organizations') AND attname='generated' AND NOT attisdropped)
 AND coalesce((SELECT md5(prosrc)='6b1916b81b153429ff80ed4185f25bac' FROM pg_proc WHERE oid=to_regprocedure('swarm.ensure_workspace_org()')),false)
 AND coalesce((SELECT md5(prosrc)='9c970d08d1b1ca22362a5b7f0ad46ec0' FROM pg_proc WHERE oid=to_regprocedure('swarm.sync_membership_to_org()')),false)
 AS rollback_ok
\gset
