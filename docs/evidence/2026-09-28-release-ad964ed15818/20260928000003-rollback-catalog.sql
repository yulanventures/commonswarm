SELECT
  to_regnamespace('commonswarm_oauth') IS NULL
  AND to_regclass('commonswarm_oauth.provider_artifacts') IS NULL
  AND to_regclass('commonswarm_oauth.refresh_family_tombstones') IS NULL
  AND to_regclass('commonswarm_oauth.browser_sessions') IS NULL
  AND to_regclass('commonswarm_oauth.interactions') IS NULL
  AND to_regclass('commonswarm_oauth.cimd_cache') IS NULL
  AND to_regclass('commonswarm_oauth.consent_orchestration') IS NULL
  AND to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.provider_family_active(text)') IS NULL
  AND to_regprocedure('commonswarm_oauth.hosted_grant_is_active(text,timestamp with time zone,boolean,boolean)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting AS setting
    JOIN pg_roles AS role ON role.oid = setting.setrole
    WHERE role.rolname = 'commonswarm_oauth_runtime'
  )
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260928000003'
  )
  AS rollback_ok
\gset
