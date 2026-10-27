-- After the 20261019000008 rollback reserve: the cascade carries the exact
-- 20260728000002 body again as an invoker-rights function with the same owner,
-- search_path and owner-only ACL, its AFTER UPDATE trigger is still bound and
-- enabled, and the residual revoke API is gone. Error-safe: objects resolve
-- through to_regclass and to_regprocedure.
SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.renewal_grants_revoke_cascade()')
   AND p.proowner='swarm_admin'::regrole AND NOT p.prosecdef AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prorettype='trigger'::regtype
   AND md5(p.prosrc)='516d4d0dc0ce280114a8468dce078ae6'
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee<>p.proowner OR x.privilege_type<>'EXECUTE' OR x.is_grantable))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.renewal_grants')
   AND tgname='renewal_grants_revoke_cascade' AND NOT tgisinternal AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.renewal_grants_revoke_cascade()'))
 AND to_regprocedure('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)') IS NULL
 AS rollback_ok
\gset
