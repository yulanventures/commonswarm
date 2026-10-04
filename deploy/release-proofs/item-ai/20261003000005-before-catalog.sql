-- Before-apply catalog for 20261003000005: proves the W2 preflight state without invoking a reserve.
-- Derived from 20261003000005-rollback-catalog.sql: reverse rows except private-tables, which asserts the six tables the reserve KEEPS; before apply they must be absent instead.
-- Shared labels keep the reverse row text byte for byte; tests/admin-release-plan.test.ts checks it.
-- Every row is NULL-safe on a pre-W2 database: no name casts or name-based privilege calls on W2 objects.
WITH checks(label,ok) AS (VALUES
 ('20261003000005-function-contract',coalesce((SELECT
   p.prosecdef AND p.provolatile='s' AND p.prorettype='jsonb'::regtype
   AND pg_get_userbyid(p.proowner)='swarm_admin'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
   AND md5(p.prosrc)='5de08119ca1b0a039061379df8775b5c'
   AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1
   AND EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=to_regrole('swarm_read') AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
   FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)')),false)),
 ('20261003000005-no-public-execution',coalesce(NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')
   AND has_function_privilege(r.oid,to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)'),'EXECUTE')),false)),
 ('20261003000005-before-private-tables-absent',coalesce(NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='commonswarm_oauth' AND c.relname IN ('admin_verified_clients','admin_client_owner_approvals','admin_grant_bindings','admin_access_issuances','admin_oauth_audit','admin_interactions')),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS before_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS before_ok_checks_ok FROM checks
\gset
\if :before_ok_checks_ok
\else
\warn 20261003000005-before failed checks: :before_ok_failed_checks
\endif
SELECT :'before_ok_checks_ok'::boolean AS before_ok
\gset
