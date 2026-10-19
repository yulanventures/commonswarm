-- Rollback deliberately preserves durable restrictions and audit provenance.
SELECT to_regclass('swarm.household_hosted_content_restrictions') IS NOT NULL
 AND to_regprocedure('swarm.audit_household_hosted_restriction()') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='swarm.household_content_connections'::regclass
   AND p.polname='hosted_owner_content_rollback_gate' AND NOT p.polpermissive AND p.polcmd='r'
   AND p.polroles=ARRAY['swarm_command'::regrole::oid])
 AND to_regclass('swarm.household_member_content_roles') IS NOT NULL
 AND to_regclass('swarm.household_object_audit') IS NOT NULL
 AND NOT pg_has_role('swarm_command','commonswarm_oauth_runtime','MEMBER')
 AS rollback_ok
\gset
