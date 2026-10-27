-- After the 20261019000003 rollback reserve: the three hosted resolvers carry
-- the 20260928000002 bodies and commonswarm_oauth.resolve_hosted_grant_status
-- the 20261019000001 body (md5 of prosrc from those files) with language,
-- volatility, security definer setting, search_path, owner and grantee
-- unchanged, and commonswarm_oauth.lock_hosted_family is gone. Error-safe:
-- functions resolve through to_regprocedure.
WITH expected(fn, lang, volatility, config, body, grantee) AS (
 VALUES
  (to_regprocedure('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)'),'sql','s',
    ARRAY['search_path=swarm, pg_catalog']::text[],'89449e80e4d397aafad8ceecd99991fe','swarm_command'),
  (to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)'),'sql','s',
    ARRAY['search_path=swarm, pg_catalog']::text[],'b5db2450789479c24abdaced718bb01f','swarm_command'),
  (to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)'),'sql','s',
    ARRAY['search_path=swarm, pg_catalog']::text[],'114a556ffb209c4205c4438b78c76d9f','swarm_read'),
  (to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)'),'plpgsql','s',
    ARRAY['search_path=pg_catalog']::text[],'9aaa0e91fbedbb7b5137d7d0dba16066','commonswarm_oauth_runtime')
)
SELECT (SELECT count(*)=4 FROM expected e JOIN pg_proc p ON p.oid=e.fn JOIN pg_language l ON l.oid=p.prolang
  WHERE l.lanname::text=e.lang AND p.provolatile::text=e.volatility AND p.proconfig=e.config AND md5(p.prosrc)=e.body
    AND p.proowner='swarm_admin'::regrole AND p.prosecdef
    AND has_function_privilege(e.grantee,p.oid,'EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      WHERE x.grantee NOT IN (p.proowner,e.grantee::regrole) OR x.is_grantable))
 AND to_regprocedure('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)') IS NULL
 AS rollback_ok
\gset
