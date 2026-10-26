-- After the 20261019000002 rollback reserve: both deadline columns, both
-- partial deadline indexes and the approval binding column with its foreign
-- key are gone, commonswarm_oauth.registered_clients.expires_at is mandatory
-- again with no NULL row left, and owners, RLS, the 30 day default, the
-- ordering check, the expiry index, the policy and the runtime grants are
-- unchanged. Error-safe: objects resolve through to_regclass or pg_attribute;
-- the only row check reads a column that predates 20261019000002.
WITH runtime_privileges AS (
 SELECT coalesce(array_agg(x.privilege_type ORDER BY x.privilege_type),ARRAY[]::text[]) AS privileges
 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
 WHERE c.oid=to_regclass('commonswarm_oauth.registered_clients') AND x.grantee='commonswarm_oauth_runtime'::regrole
)
SELECT NOT EXISTS(SELECT 1 FROM pg_attribute a
   WHERE a.attrelid IN (to_regclass('swarm.hosted_mcp_grants'),to_regclass('swarm.renewal_grants'))
     AND a.attname IN ('connection_expires_at','connection_expired_at') AND NOT a.attisdropped)
 AND to_regclass('swarm.hosted_mcp_grants_connection_deadline_idx') IS NULL
 AND to_regclass('swarm.renewal_grants_connection_deadline_idx') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.household_content_connections')
   AND a.attname='renewal_grant_id' AND NOT a.attisdropped)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('swarm.household_content_connections')
   AND k.contype='f' AND k.confrelid=to_regclass('swarm.renewal_grants'))
 AND coalesce((SELECT a.attnotnull AND a.atthasdef AND a.atttypid='timestamptz'::regtype FROM pg_attribute a
   WHERE a.attrelid=to_regclass('commonswarm_oauth.registered_clients') AND a.attname='expires_at' AND NOT a.attisdropped),false)
 AND NOT EXISTS(SELECT 1 FROM commonswarm_oauth.registered_clients WHERE expires_at IS NULL)
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
 AS rollback_ok
\gset
