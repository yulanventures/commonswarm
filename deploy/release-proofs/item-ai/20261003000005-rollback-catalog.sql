-- Read-only projection proof. Stable diagnostics, no private row contents.
WITH checks(label,ok) AS (VALUES
 ('20261003000005-function-contract',coalesce((SELECT
   p.prosecdef AND p.provolatile='s' AND p.prorettype='jsonb'::regtype
   AND pg_get_userbyid(p.proowner)='swarm_admin'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
   AND md5(p.prosrc)='5de08119ca1b0a039061379df8775b5c'
   AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1
   AND EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=to_regrole('swarm_read') AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
   FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)')),false)),
 ('20261003000005-private-tables',coalesce((SELECT count(*)=6 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='commonswarm_oauth' AND c.relname IN ('admin_verified_clients','admin_client_owner_approvals','admin_grant_bindings','admin_access_issuances','admin_oauth_audit','admin_interactions')) AND NOT EXISTS(
   SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE (n.nspname='commonswarm_oauth' AND c.relname IN ('admin_verified_clients','admin_client_owner_approvals','admin_grant_bindings','admin_access_issuances','admin_oauth_audit','admin_interactions'))
     AND (NOT c.relrowsecurity OR has_table_privilege('swarm_read',c.oid,'SELECT') OR has_table_privilege('authenticated',c.oid,'SELECT'))),false)),
 ('20261003000005-no-public-execution',coalesce(NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')
   AND has_function_privilege(r.oid,to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)'),'EXECUTE')),false))
)
SELECT coalesce(string_agg(label,',' ORDER BY label) FILTER(WHERE NOT ok),'') AS rollback_ok_failed_checks,
  coalesce(bool_and(ok),false) AS rollback_ok_checks_ok FROM checks
\gset
\if :rollback_ok_checks_ok
\else
\warn 20261003000005 failed checks: :rollback_ok_failed_checks
\endif
SELECT :'rollback_ok_checks_ok'::boolean AS rollback_ok
\gset
