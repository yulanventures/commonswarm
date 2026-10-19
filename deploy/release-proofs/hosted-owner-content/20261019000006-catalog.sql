-- Exact additive authority: command writes only; no OAuth runtime membership.
WITH target AS (
 SELECT c.* FROM pg_class c WHERE c.oid=to_regclass('swarm.household_hosted_content_restrictions')
), allowed AS (
 SELECT coalesce(array_agg(x.privilege_type ORDER BY x.privilege_type),ARRAY[]::text[]) AS privileges
 FROM target c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
 WHERE x.grantee='swarm_command'::regrole
), column_updates AS (
 SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname),ARRAY[]::text[]) AS columns
 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
 WHERE a.attrelid=to_regclass('swarm.household_hosted_content_restrictions') AND a.attnum>0 AND NOT a.attisdropped
 AND x.grantee='swarm_command'::regrole AND x.privilege_type='UPDATE'
)
SELECT coalesce((SELECT relrowsecurity AND relowner='swarm_admin'::regrole FROM target),false)
 AND (SELECT privileges=ARRAY['INSERT','SELECT']::text[] FROM allowed)
 AND (SELECT columns=ARRAY['operations','origin','principal_id','replaces_legacy']::text[] FROM column_updates)
 AND NOT EXISTS(SELECT 1 FROM target c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   WHERE x.grantee NOT IN ('swarm_admin'::regrole,'swarm_command'::regrole))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid=to_regclass('swarm.household_hosted_content_restrictions') AND a.attnum>0 AND NOT a.attisdropped
   AND x.grantee NOT IN ('swarm_admin'::regrole,'swarm_command'::regrole))
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.household_hosted_content_restrictions')
   AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (grant_id, workspace_id)')
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_hosted_content_restrictions')
   AND tgname='household_hosted_restriction_audit' AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.audit_household_hosted_restriction()'))
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.audit_household_hosted_restriction()')
   AND p.proowner='swarm_admin'::regrole AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>p.proowner))
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='swarm.household_content_connections'::regclass
   AND polname='hosted_owner_content_rollback_gate')
 AND NOT pg_has_role('swarm_command','commonswarm_oauth_runtime','MEMBER')
 AS catalog_ok
\gset
