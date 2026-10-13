-- Read-only pre-session-binding schema proof. The HM store remains installed.
-- RELEASE-TO-BOX.md:2214-2221 governs rollback; the reserve includes this
-- proof before commit. Invalidated logins remain invalidated (schema inverse).
SELECT
  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commonswarm_oauth_session_guard')
  AND to_regprocedure('commonswarm_oauth.live_gotrue_session(uuid,uuid)') IS NULL
  AND to_regprocedure('commonswarm_oauth.invalidate_gotrue_session()') IS NULL
  AND to_regclass('commonswarm_oauth.browser_sessions_gotrue_idx') IS NULL
  AND to_regclass('commonswarm_oauth.finish_records') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('auth.sessions')
      AND tgname = 'commonswarm_oauth_session_revocation'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polname = 'oauth_session_guard_read'
      AND polrelid IN (to_regclass('auth.sessions'), to_regclass('auth.users'), to_regclass('auth.mfa_amr_claims'))
  )
  AND COALESCE((SELECT relkind = 'r' AND relrowsecurity AND NOT relforcerowsecurity
      AND relowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
    FROM pg_class WHERE oid = to_regclass('commonswarm_oauth.browser_sessions')), false)
  AND COALESCE((SELECT array_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
      || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum)
      = ARRAY[
        'session_hash:bytea:true:', 'user_id:uuid:false:', 'user_email:text:false:',
        'user_display_name:text:false:', 'authenticated_at:timestamp with time zone:false:',
        'expires_at:timestamp with time zone:true:', 'invalidated_at:timestamp with time zone:false:',
        'created_at:timestamp with time zone:true:statement_timestamp()'
      ]::text[]
    FROM pg_attribute AS a LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('commonswarm_oauth.browser_sessions')
      AND a.attnum > 0 AND NOT a.attisdropped), false)
  AND COALESCE((SELECT count(*) = 2 AND bool_and(c.relname IN ('browser_sessions_pkey', 'browser_sessions_expiry_idx')
      AND i.indisvalid AND i.indisready)
    FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('commonswarm_oauth.browser_sessions')), false)
  AND COALESCE((SELECT count(*) = 4 AND bool_and(convalidated)
      AND count(*) FILTER (WHERE contype = 'p') = 1
      AND count(*) FILTER (WHERE contype = 'c') = 3
    FROM pg_constraint WHERE conrelid = to_regclass('commonswarm_oauth.browser_sessions')), false)
  AND COALESCE((SELECT count(*) = 1 AND bool_and(p.polname = 'oauth_runtime_sessions'
      AND p.polcmd = '*' AND p.polpermissive
      AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime')]
      AND pg_get_expr(p.polqual, p.polrelid) = 'true'
      AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true')
    FROM pg_policy AS p WHERE p.polrelid = to_regclass('commonswarm_oauth.browser_sessions')), false)
  AND COALESCE((SELECT array_agg(a.privilege_type ORDER BY a.privilege_type)
      = ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] AND NOT bool_or(a.is_grantable)
    FROM pg_class AS c CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    WHERE c.oid = to_regclass('commonswarm_oauth.browser_sessions')
      AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime')), false)
  AND NOT EXISTS (SELECT 1 FROM pg_class AS c CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    WHERE c.oid = to_regclass('commonswarm_oauth.browser_sessions') AND a.grantee <> c.relowner
      AND a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime'))
  AND NOT EXISTS (SELECT 1 FROM pg_attribute AS a
    WHERE a.attrelid = to_regclass('commonswarm_oauth.browser_sessions')
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL AND cardinality(a.attacl) > 0)
  AND to_regclass('auth.sessions') IS NOT NULL AND to_regclass('auth.users') IS NOT NULL
  AND to_regclass('auth.mfa_amr_claims') IS NOT NULL
  AND to_regclass('commonswarm_oauth.interactions') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261014000001')
  AS rollback_ok
\gset
