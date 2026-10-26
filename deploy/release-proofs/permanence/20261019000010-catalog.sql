-- Apply after 20261019000010. t only when the selection helper exists with the
-- 00010 body and owner-only EXECUTE, both human projections carry the 00010
-- bodies with their unchanged owner, definer flag, search_path and EXECUTE
-- grants, and swarm_read.hosted_mcp_connections exposes the two appended
-- connection-expiry columns with its owner, security barrier and SELECT grants
-- intact. Error-safe before the migration: objects resolve through
-- to_regprocedure/to_regclass and bodies are compared as md5(prosrc).
WITH routine(oid, secdef, config, grantees, body) AS (VALUES
 (to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)'), false,
  ARRAY['search_path=pg_catalog']::text[], ARRAY['swarm_admin']::text[], '160d28ccf92ef7b52c2eb3472e479af0'),
 (to_regprocedure('swarm_read.home_overview()'), true,
  ARRAY['search_path=pg_catalog']::text[], ARRAY['authenticated','swarm_admin']::text[], '97041e1c94990f5a40006935a3163f98'),
 (to_regprocedure('swarm_read.renewal_grant_roster(uuid)'), true,
  ARRAY['search_path=pg_catalog']::text[], ARRAY['authenticated','swarm_admin','swarm_read']::text[], '878a72454f1f2b1989a1067f0d0e2383')
), view_columns AS (
 SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum),ARRAY[]::text[]) AS names
 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm_read.hosted_mcp_connections') AND a.attnum>0 AND NOT a.attisdropped
)
SELECT coalesce((SELECT count(*)=3 AND bool_and(coalesce(
   p.proowner='swarm_admin'::regrole AND p.prosecdef=r.secdef AND p.provolatile='v' AND p.proconfig=r.config AND md5(p.prosrc)=r.body
   AND (SELECT coalesce(array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text COLLATE "C"),ARRAY[]::text[])
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x)=r.grantees
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.privilege_type<>'EXECUTE' OR x.is_grantable),false))
  FROM routine r JOIN pg_proc p ON p.oid=r.oid),false)
 AND coalesce((SELECT names=ARRAY['grant_id','client_id','resource','home_workspace_id','selected_workspace_ids','state','created_at','activated_at','revoked_at',
   'connection_expires_at','connection_expired_at']::text[] FROM view_columns),false)
 AND coalesce((SELECT c.relkind='v' AND c.relowner='swarm_admin'::regrole AND c.reloptions @> ARRAY['security_barrier=true']::text[]
   AND pg_get_viewdef(c.oid) LIKE '%auth.uid()%'
   AND has_table_privilege('authenticated',c.oid,'SELECT') AND has_table_privilege('swarm_read',c.oid,'SELECT')
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
     WHERE x.is_grantable OR (x.grantee<>c.relowner
       AND (x.privilege_type<>'SELECT' OR x.grantee NOT IN ('authenticated'::regrole,'swarm_read'::regrole))))
   FROM pg_class c WHERE c.oid=to_regclass('swarm_read.hosted_mcp_connections')),false)
 AS catalog_ok
\gset
