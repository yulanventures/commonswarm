-- After the 20261019000004 rollback reserve: no function named
-- lock_hosted_client_streams remains in commonswarm_oauth under any signature,
-- and commonswarm_oauth.registered_clients keeps its owner, RLS, policy and
-- runtime grants. Error-safe: objects resolve through to_regclass and
-- to_regnamespace.
WITH runtime_privileges AS (
 SELECT coalesce(array_agg(x.privilege_type ORDER BY x.privilege_type),ARRAY[]::text[]) AS privileges
 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
 WHERE c.oid=to_regclass('commonswarm_oauth.registered_clients') AND x.grantee='commonswarm_oauth_runtime'::regrole
)
SELECT NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proname='lock_hosted_client_streams'
   AND p.pronamespace=to_regnamespace('commonswarm_oauth'))
 AND coalesce((SELECT c.relowner='swarm_admin'::regrole AND c.relrowsecurity FROM pg_class c
   WHERE c.oid=to_regclass('commonswarm_oauth.registered_clients')),false)
 AND (SELECT privileges=ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[] FROM runtime_privileges)
 AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('commonswarm_oauth.registered_clients')
   AND p.polname='oauth_runtime_registered_clients')
 AS rollback_ok
\gset
