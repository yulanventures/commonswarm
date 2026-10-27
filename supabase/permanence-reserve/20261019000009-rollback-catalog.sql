-- After the 20261019000009 rollback reserve: the hosted restriction audit
-- trigger function carries the exact 20261019000006 body again, with the same
-- owner, invoker rights, VOLATILE, search_path pinned to pg_catalog and EXECUTE
-- for the owner only, and the audit trigger is still bound to it and enabled.
-- Error-safe: objects resolve through to_regclass and to_regprocedure.
SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.audit_household_hosted_restriction()')
   AND p.proowner='swarm_admin'::regrole AND NOT p.prosecdef AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prorettype='trigger'::regtype
   AND md5(p.prosrc)='d1204de1d024a528a066d211d1668274'
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee<>p.proowner OR x.privilege_type<>'EXECUTE' OR x.is_grantable))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_hosted_content_restrictions')
   AND tgname='household_hosted_restriction_audit' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23
   AND tgfoid=to_regprocedure('swarm.audit_household_hosted_restriction()'))
 AS rollback_ok
\gset
