-- Apply after 20261019000003. t only when the three hosted resolvers and
-- commonswarm_oauth.resolve_hosted_grant_status carry the migration's exact
-- bodies (md5 of prosrc, computed from the migration file) with their original
-- language, volatility, security definer setting, search_path, owner and single
-- grantee, and commonswarm_oauth.lock_hosted_family exists the same way with
-- EXECUTE for commonswarm_oauth_runtime only. Error-safe before the migration:
-- every function resolves through to_regprocedure and a missing one fails the
-- count.
WITH expected(fn, lang, volatility, config, body, grantee) AS (
 VALUES
  (to_regprocedure('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)'),'sql','s',
    ARRAY['search_path=swarm, pg_catalog']::text[],'1ea544115d61eb99d749b1b30b306b84','swarm_command'),
  (to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)'),'sql','s',
    ARRAY['search_path=swarm, pg_catalog']::text[],'9a40ec0f733fbea335397b3c3ba85c3d','swarm_command'),
  (to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)'),'sql','s',
    ARRAY['search_path=swarm, pg_catalog']::text[],'1ecdf1467d0bf05ad242a73e48e9362e','swarm_read'),
  (to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)'),'plpgsql','s',
    ARRAY['search_path=pg_catalog']::text[],'72cadd77edf6edf6569be767c3249d5a','commonswarm_oauth_runtime'),
  (to_regprocedure('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)'),'plpgsql','v',
    ARRAY['search_path=pg_catalog']::text[],'cbb6c97a0d3d5014834857534a312465','commonswarm_oauth_runtime')
)
SELECT (SELECT count(*)=5 FROM expected e JOIN pg_proc p ON p.oid=e.fn JOIN pg_language l ON l.oid=p.prolang
  WHERE l.lanname::text=e.lang AND p.provolatile::text=e.volatility AND p.proconfig=e.config AND md5(p.prosrc)=e.body
    AND p.proowner='swarm_admin'::regrole AND p.prosecdef
    AND has_function_privilege(e.grantee,p.oid,'EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      WHERE x.grantee NOT IN (p.proowner,e.grantee::regrole) OR x.is_grantable))
 AS catalog_ok
\gset
