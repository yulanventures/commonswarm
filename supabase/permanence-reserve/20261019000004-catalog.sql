-- Apply after 20261019000004. t only when
-- commonswarm_oauth.lock_hosted_client_streams(text) exists as a volatile
-- plpgsql security definer owned by swarm_admin with search_path pg_catalog,
-- the migration's exact body (md5 of prosrc, computed from the migration file)
-- and EXECUTE for commonswarm_oauth_runtime only. Error-safe before the
-- migration: the function resolves through to_regprocedure.
SELECT coalesce((SELECT l.lanname='plpgsql' AND p.provolatile='v' AND p.prosecdef AND p.proowner='swarm_admin'::regrole
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='8fad9227ff62b4c94c120f9f8dfe68ac'
   AND has_function_privilege('commonswarm_oauth_runtime',p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee NOT IN (p.proowner,'commonswarm_oauth_runtime'::regrole) OR x.is_grantable)
   FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_hosted_client_streams(text)')),false)
 AS catalog_ok
\gset
