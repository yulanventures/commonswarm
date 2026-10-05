WITH expected(name, privileges, immutable) AS (VALUES
 ('household_object_streams',ARRAY['SELECT','INSERT','UPDATE']::text[],false),
 ('household_object_events',ARRAY['INSERT']::text[],true),
 ('household_object_audit',ARRAY['INSERT']::text[],true)), checks AS (
 SELECT c.oid IS NOT NULL AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.relrowsecurity
 AND (SELECT count(*)=1 AND bool_and(polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')] AND polcmd='*' AND pg_get_expr(polqual,polrelid)='true' AND pg_get_expr(polwithcheck,polrelid)='true') FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type),ARRAY[]::text[])=(SELECT array_agg(p ORDER BY p) FROM unnest(e.privileges) p) FROM aclexplode(c.relacl) a WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command'))
 AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee NOT IN (c.relowner,(SELECT oid FROM pg_roles WHERE rolname='swarm_command')) OR a.is_grantable)
 AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL)
 AND (SELECT count(*)=CASE WHEN e.immutable THEN 1 ELSE 0 END FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal AND tgenabled='O' AND tgtype=27 AND tgfoid='swarm.prevent_append_only_mutation()'::regprocedure)
 AS ok FROM expected e LEFT JOIN pg_class c ON c.oid=to_regclass('swarm.'||e.name))
SELECT
 to_regclass('swarm.household_todo_streams') IS NULL
 AND to_regclass('swarm.household_todo_events') IS NULL
 AND to_regclass('swarm.household_todos') IS NULL
 AND to_regclass('swarm.household_comments') IS NULL
 AND to_regclass('swarm.household_agent_work_policies') IS NULL
 AND to_regclass('swarm.household_todo_receipts') IS NULL
 AND (SELECT count(*)=3 AND coalesce(bool_and(ok),false) FROM checks)
 AS rollback_ok
\gset
