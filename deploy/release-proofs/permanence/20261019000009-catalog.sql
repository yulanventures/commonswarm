-- Apply after 20261019000009. t only when the hosted restriction audit trigger
-- function carries the exact 00009 body (a closed-target snapshot saved before
-- M00002 may omit the renewal_grant_id key on its legacy rows) with the identity
-- 00006 gave it: owner swarm_admin, invoker rights, VOLATILE, search_path pinned
-- to pg_catalog, EXECUTE for the owner only, and the BEFORE INSERT OR UPDATE row
-- audit trigger still bound to it and enabled. Error-safe before the migration:
-- every object resolves through to_regclass and to_regprocedure, so an absent
-- object or a different body yields f, never an error.
SELECT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.audit_household_hosted_restriction()')
   AND p.proowner='swarm_admin'::regrole AND NOT p.prosecdef AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prorettype='trigger'::regtype
   AND md5(p.prosrc)='1753bfd1db60cf912fbf4e3df7c32422'
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee<>p.proowner OR x.privilege_type<>'EXECUTE' OR x.is_grantable))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_hosted_content_restrictions')
   AND tgname='household_hosted_restriction_audit' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23
   AND tgfoid=to_regprocedure('swarm.audit_household_hosted_restriction()'))
 AS catalog_ok
\gset
