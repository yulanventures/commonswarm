SELECT coalesce((
SELECT coalesce((SELECT pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef AND p.proconfig=ARRAY['search_path=swarm, storage, pg_catalog']::text[]
 AND md5(p.prosrc)='4b9693e7375541315685f620ad55b790' AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0)
 AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.purge_file_artifacts()')),false) AND coalesce((SELECT pg_get_userbyid(relowner)='swarm_admin' AND relkind='v' AND reloptions @> ARRAY['security_barrier=true']::text[]
 AND has_table_privilege('authenticated',oid,'SELECT') AND has_table_privilege('swarm_read',oid,'SELECT') AND NOT has_table_privilege('anon',oid,'SELECT')
 FROM pg_class WHERE oid=to_regclass('swarm_read.files')),false) AND position('household_managed' in pg_get_viewdef(to_regclass('swarm_read.files'))) = 0
),false) AS rollback_ok
\gset
