-- Apply after 20261019000002. t only when both deadline columns exist on
-- swarm.hosted_mcp_grants and swarm.renewal_grants as nullable timestamptz
-- without default or column grants, both partial deadline indexes carry the
-- migration's exact predicate, swarm.household_content_connections has the
-- nullable uuid column renewal_grant_id with its validated foreign key to
-- swarm.renewal_grants (column updates, if any, only for swarm_command), and
-- commonswarm_oauth.registered_clients.expires_at is nullable while its 30 day
-- default, ordering check, expiry index, owner, RLS, policy and runtime grants
-- are unchanged. Error-safe before the migration: every object resolves
-- through to_regclass or pg_attribute; nothing names a new column directly.
WITH deadline_columns AS (
 SELECT count(*) AS n FROM pg_attribute a
 WHERE a.attrelid IN (to_regclass('swarm.hosted_mcp_grants'),to_regclass('swarm.renewal_grants'))
   AND a.attname IN ('connection_expires_at','connection_expired_at') AND NOT a.attisdropped
   AND a.atttypid='timestamptz'::regtype AND NOT a.attnotnull AND NOT a.atthasdef AND a.attacl IS NULL
), deadline_indexes AS (
 SELECT count(*) AS n FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
 WHERE ((i.indrelid=to_regclass('swarm.hosted_mcp_grants') AND ic.relname='hosted_mcp_grants_connection_deadline_idx')
     OR (i.indrelid=to_regclass('swarm.renewal_grants') AND ic.relname='renewal_grants_connection_deadline_idx'))
   AND i.indisvalid AND NOT i.indisunique AND i.indnatts=1 AND a.attname='connection_expires_at'
   AND pg_get_expr(i.indpred,i.indrelid)='((connection_expires_at IS NOT NULL) AND (connection_expired_at IS NULL))'
), binding_column AS (
 SELECT a.attnum FROM pg_attribute a
 WHERE a.attrelid=to_regclass('swarm.household_content_connections') AND a.attname='renewal_grant_id'
   AND NOT a.attisdropped AND a.atttypid='uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef
), runtime_privileges AS (
 SELECT coalesce(array_agg(x.privilege_type ORDER BY x.privilege_type),ARRAY[]::text[]) AS privileges
 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
 WHERE c.oid=to_regclass('commonswarm_oauth.registered_clients') AND x.grantee='commonswarm_oauth_runtime'::regrole
)
SELECT (SELECT n=4 FROM deadline_columns)
 AND (SELECT n=2 FROM deadline_indexes)
 AND EXISTS(SELECT 1 FROM binding_column)
 AND EXISTS(SELECT 1 FROM pg_constraint k, binding_column b
   WHERE k.conrelid=to_regclass('swarm.household_content_connections') AND k.contype='f' AND k.convalidated
     AND k.conkey=ARRAY[b.attnum]::int2[] AND k.confrelid=to_regclass('swarm.renewal_grants')
     AND k.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('swarm.renewal_grants')
       AND attname='renewal_grant_id' AND NOT attisdropped)]::int2[])
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid=to_regclass('swarm.household_content_connections') AND a.attname='renewal_grant_id'
     AND (x.grantee<>'swarm_command'::regrole OR x.privilege_type<>'UPDATE' OR x.is_grantable))
 AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('commonswarm_oauth.registered_clients')
   AND a.attname='expires_at' AND NOT a.attisdropped AND a.atttypid='timestamptz'::regtype
   AND NOT a.attnotnull AND a.atthasdef)
 AND EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('commonswarm_oauth.registered_clients')
   AND k.contype='c' AND pg_get_constraintdef(k.oid)='CHECK ((expires_at > registered_at))')
 AND to_regclass('commonswarm_oauth.registered_clients_expiry_idx') IS NOT NULL
 AND (SELECT privileges=ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[] FROM runtime_privileges)
 AND NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   WHERE c.oid=to_regclass('commonswarm_oauth.registered_clients')
     AND (x.grantee NOT IN (c.relowner,'commonswarm_oauth_runtime'::regrole) OR x.is_grantable))
 AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('commonswarm_oauth.registered_clients')
   AND p.polname='oauth_runtime_registered_clients')
 AND (SELECT count(*)=4 AND bool_and(c.relowner='swarm_admin'::regrole AND c.relrowsecurity) FROM pg_class c
   WHERE c.oid IN (to_regclass('swarm.hosted_mcp_grants'),to_regclass('swarm.renewal_grants'),
     to_regclass('swarm.household_content_connections'),to_regclass('commonswarm_oauth.registered_clients')))
 AS catalog_ok
\gset
