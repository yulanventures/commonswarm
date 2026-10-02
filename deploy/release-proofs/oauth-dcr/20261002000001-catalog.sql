-- Forward catalog; missing objects yield false. Runtime grants stay isolated.
SELECT COALESCE(
  (SELECT pg_get_userbyid(relowner) = 'swarm_admin' AND relrowsecurity
     FROM pg_class WHERE oid = to_regclass('commonswarm_oauth.registered_clients'))
  AND (SELECT count(*) = 5 FROM pg_attribute
    WHERE attrelid = to_regclass('commonswarm_oauth.registered_clients')
      AND attnum > 0 AND NOT attisdropped
      AND (attname::text, atttypid) IN (('client_id','text'::regtype), ('metadata','jsonb'::regtype),
        ('registered_at','timestamptz'::regtype), ('last_used_at','timestamptz'::regtype),
        ('expires_at','timestamptz'::regtype)))
  AND (SELECT count(*) = 4 FROM pg_attribute
    WHERE attrelid = to_regclass('commonswarm_oauth.registered_clients')
      AND attname IN ('client_id','metadata','registered_at','expires_at') AND attnotnull)
  AND (SELECT count(*) = 5 FROM pg_constraint
    WHERE conrelid = to_regclass('commonswarm_oauth.registered_clients') AND contype IN ('p','c'))
  AND (SELECT count(*) = 2 FROM pg_attrdef
    WHERE adrelid = to_regclass('commonswarm_oauth.registered_clients')
      AND pg_get_expr(adbin,adrelid) IN ('statement_timestamp()', '(statement_timestamp() + ''30 days''::interval)'))
  AND to_regclass('commonswarm_oauth.registered_clients_expiry_idx') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_policy
    WHERE polrelid = to_regclass('commonswarm_oauth.registered_clients')
      AND polname = 'oauth_runtime_registered_clients' AND polcmd = '*'
      AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname='commonswarm_oauth_runtime')]
      AND pg_get_expr(polqual,polrelid) = 'true' AND pg_get_expr(polwithcheck,polrelid) = 'true')
  AND has_table_privilege('commonswarm_oauth_runtime', to_regclass('commonswarm_oauth.registered_clients'), 'SELECT')
  AND has_table_privilege('commonswarm_oauth_runtime', to_regclass('commonswarm_oauth.registered_clients'), 'INSERT')
  AND has_table_privilege('commonswarm_oauth_runtime', to_regclass('commonswarm_oauth.registered_clients'), 'UPDATE')
  AND has_table_privilege('commonswarm_oauth_runtime', to_regclass('commonswarm_oauth.registered_clients'), 'DELETE')
  AND NOT has_table_privilege('anon', to_regclass('commonswarm_oauth.registered_clients'), 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', to_regclass('commonswarm_oauth.registered_clients'), 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('swarm_command', to_regclass('commonswarm_oauth.registered_clients'), 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('swarm_read', to_regclass('commonswarm_oauth.registered_clients'), 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class
    WHERE oid = to_regclass('commonswarm_oauth.registered_clients'))) WHERE grantee = 0)
, false) AS catalog_ok
\gset
