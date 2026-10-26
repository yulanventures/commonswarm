-- After the 20261019000010 rollback reserve: the selection helper is gone,
-- swarm_read.home_overview() carries the 20261006000002 body and
-- swarm_read.renewal_grant_roster(uuid) the 20261019000007 body, each with its
-- unchanged owner, definer flag, search_path and EXECUTE grants, and
-- swarm_read.hosted_mcp_connections is back to its nine 20260928000002 columns
-- with owner, security barrier and SELECT grants restored. Error-safe: objects
-- resolve through to_regprocedure/to_regclass; bodies compare as md5(prosrc).
WITH routine(oid, secdef, config, grantees, body) AS (VALUES
 (to_regprocedure('swarm_read.home_overview()'), true,
  ARRAY['search_path=pg_catalog']::text[], ARRAY['authenticated','swarm_admin']::text[], '587cf514acc70bfee112d5f0e433e643'),
 (to_regprocedure('swarm_read.renewal_grant_roster(uuid)'), true,
  ARRAY['search_path=pg_catalog']::text[], ARRAY['authenticated','swarm_admin','swarm_read']::text[], 'e764508c50f69d08098d1cf2879d1db4')
), view_columns AS (
 SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum),ARRAY[]::text[]) AS names
 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm_read.hosted_mcp_connections') AND a.attnum>0 AND NOT a.attisdropped
)
SELECT to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)') IS NULL
 AND coalesce((SELECT count(*)=2 AND bool_and(coalesce(
   p.proowner='swarm_admin'::regrole AND p.prosecdef=r.secdef AND p.provolatile='v' AND p.proconfig=r.config AND md5(p.prosrc)=r.body
   AND (SELECT coalesce(array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text COLLATE "C"),ARRAY[]::text[])
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x)=r.grantees
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.privilege_type<>'EXECUTE' OR x.is_grantable),false))
  FROM routine r JOIN pg_proc p ON p.oid=r.oid),false)
 AND coalesce((SELECT names=ARRAY['grant_id','client_id','resource','home_workspace_id','selected_workspace_ids','state','created_at','activated_at','revoked_at']::text[] FROM view_columns),false)
 AND coalesce((SELECT c.relkind='v' AND c.relowner='swarm_admin'::regrole AND c.reloptions @> ARRAY['security_barrier=true']::text[]
   AND pg_get_viewdef(c.oid) LIKE '%auth.uid()%'
   AND has_table_privilege('authenticated',c.oid,'SELECT') AND has_table_privilege('swarm_read',c.oid,'SELECT')
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
     WHERE x.is_grantable OR (x.grantee<>c.relowner
       AND (x.privilege_type<>'SELECT' OR x.grantee NOT IN ('authenticated'::regrole,'swarm_read'::regrole))))
   FROM pg_class c WHERE c.oid=to_regclass('swarm_read.hosted_mcp_connections')),false)
 AS rollback_ok
\gset
