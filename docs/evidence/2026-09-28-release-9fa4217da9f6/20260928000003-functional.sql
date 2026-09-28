-- Read-only functional and positive/negative privilege controls. This proof
-- deliberately depends on lane 2's swarm.hosted_mcp_grants (migration
-- 20260928000002); absence is a named false and never a relation error.
SELECT to_regclass('swarm.hosted_mcp_grants') IS NOT NULL
  AS lane_2_authority_present
\gset

\if :lane_2_authority_present
WITH runtime_role AS (
  SELECT
    count(*) = 1 AS present,
    COALESCE(bool_and(rolcanlogin), false) AS can_login,
    COALESCE(bool_and(NOT rolinherit), false) AS no_inherit,
    COALESCE(bool_and(NOT rolsuper), false) AS no_super,
    COALESCE(bool_and(NOT rolcreatedb), false) AS no_createdb,
    COALESCE(bool_and(NOT rolcreaterole), false) AS no_createrole,
    COALESCE(bool_and(NOT rolreplication), false) AS no_replication,
    COALESCE(bool_and(NOT rolbypassrls), false) AS no_bypassrls
  FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime'
)
SELECT
  COALESCE((SELECT present AND can_login AND no_inherit AND no_super
    AND no_createdb AND no_createrole AND no_replication AND no_bypassrls
    FROM runtime_role), false)
  AND has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.provider_artifacts', 'SELECT')
  AND has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.provider_artifacts', 'INSERT')
  AND has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.provider_artifacts', 'UPDATE')
  AND has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.provider_artifacts', 'DELETE')
  AND has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.refresh_family_tombstones', 'SELECT')
  AND has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.refresh_family_tombstones', 'INSERT')
  AND NOT has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.refresh_family_tombstones', 'UPDATE')
  AND NOT has_table_privilege('commonswarm_oauth_runtime',
    'commonswarm_oauth.refresh_family_tombstones', 'DELETE')
  AND NOT has_table_privilege('swarm_read',
    'commonswarm_oauth.provider_artifacts', 'SELECT')
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE')
  AND commonswarm_oauth.hosted_grant_is_active(
    'active', NULL, true, false
  ) = true
  AND commonswarm_oauth.hosted_grant_is_active(
    'revoked', statement_timestamp(), true, false
  ) = false
  AND commonswarm_oauth.hosted_grant_is_active(
    'active', NULL, false, false
  ) = false
  AND commonswarm_oauth.hosted_grant_is_active(
    'active', NULL, true, true
  ) = false
  AND commonswarm_oauth.provider_family_active('release-proof-missing-family') = false
  AS functional_ok
\gset
\else
SELECT false AS functional_ok
\gset
\endif
\if :functional_ok
\echo t
\else
DO $$ BEGIN RAISE EXCEPTION 'HM OAuth functional proof FAILED'; END $$;
\endif
