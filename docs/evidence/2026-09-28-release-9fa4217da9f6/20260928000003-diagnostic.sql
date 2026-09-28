-- Purpose: identify the exact 20260928000003 catalog predicate that differs on production.
-- Anvil runs this with the section 5 write helper and flags (deploy/RELEASE-TO-BOX.md:1199):
--   release_psql --file /proof/20260928000003-diagnostic.sql
-- The migration inclusion at runbook line 1173 is reproduced with psql \ir, relative to
-- this proof's staged /proof location and the sibling /migrations mount.
-- read-only in effect: ends with ROLLBACK

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
\ir ../migrations/20260928000003_hm_oauth_store.sql

-- Keep the psql variable used by the catalog proof so the copied predicate below
-- is byte-for-byte the same SQL expression as the proof.
SELECT to_regclass('swarm.hosted_mcp_grants') IS NOT NULL
  AS lane_2_authority_present
\gset

WITH role_state AS (
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
), object_state AS (
  SELECT
    to_regnamespace('commonswarm_oauth') AS namespace_oid,
    to_regclass('commonswarm_oauth.provider_artifacts') AS artifacts_oid,
    to_regclass('commonswarm_oauth.refresh_family_tombstones') AS tombstones_oid,
    to_regclass('commonswarm_oauth.browser_sessions') AS sessions_oid,
    to_regclass('commonswarm_oauth.interactions') AS interactions_oid,
    to_regclass('commonswarm_oauth.cimd_cache') AS cimd_oid,
    to_regclass('commonswarm_oauth.consent_orchestration') AS orchestration_oid,
    to_regprocedure('commonswarm_oauth.hosted_grant_is_active(text,timestamp with time zone,boolean,boolean)') AS active_oid,
    to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)') AS status_oid,
    to_regprocedure('commonswarm_oauth.provider_family_active(text)') AS family_oid
), role_oids AS (
  SELECT
    to_regrole('commonswarm_oauth_runtime') AS runtime_oid,
    to_regrole('swarm_admin') AS admin_oid,
    to_regrole('swarm_command') AS command_oid,
    to_regrole('swarm_read') AS read_oid,
    to_regrole('authenticated') AS authenticated_oid,
    to_regrole('anon') AS anon_oid
), predicates AS (
  SELECT
    role_state.present AS runtime_role_present,
    role_state.can_login AS runtime_role_can_login,
    role_state.no_inherit AS runtime_role_no_inherit,
    role_state.no_super AS runtime_role_no_super,
    role_state.no_createdb AS runtime_role_no_createdb,
    role_state.no_createrole AS runtime_role_no_createrole,
    role_state.no_replication AS runtime_role_no_replication,
    role_state.no_bypassrls AS runtime_role_no_bypassrls,
    object_state.namespace_oid IS NOT NULL AS oauth_schema_exists,
    object_state.artifacts_oid IS NOT NULL AS provider_artifacts_exists,
    object_state.tombstones_oid IS NOT NULL AS refresh_family_tombstones_exists,
    object_state.sessions_oid IS NOT NULL AS browser_sessions_exists,
    object_state.interactions_oid IS NOT NULL AS interactions_exists,
    object_state.cimd_oid IS NOT NULL AS cimd_cache_exists,
    object_state.orchestration_oid IS NOT NULL AS consent_orchestration_exists,
    object_state.active_oid IS NOT NULL AS hosted_grant_is_active_exists,
    object_state.status_oid IS NOT NULL AS resolve_hosted_grant_status_exists,
    object_state.family_oid IS NOT NULL AS provider_family_active_exists,
    COALESCE((
      SELECT pg_get_userbyid(nspowner) = 'swarm_admin'
      FROM pg_namespace WHERE oid = object_state.namespace_oid
    ), false) AS oauth_schema_owner_is_swarm_admin,
    CASE WHEN role_state.present
      THEN has_database_privilege('commonswarm_oauth_runtime', current_database(), 'CONNECT')
      ELSE false END AS runtime_database_connect,
    CASE WHEN role_state.present AND object_state.namespace_oid IS NOT NULL
      THEN has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'USAGE')
        AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'CREATE')
        AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE')
      ELSE false END AS runtime_schema_privileges_ok,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'SELECT')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'INSERT')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'UPDATE')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'DELETE')
        AND NOT has_table_privilege('authenticated', object_state.artifacts_oid, 'SELECT')
        AND NOT has_table_privilege('anon', object_state.artifacts_oid, 'SELECT')
        AND NOT has_table_privilege('swarm_read', object_state.artifacts_oid, 'SELECT')
      ELSE false END AS provider_artifacts_privileges_ok,
    COALESCE((
      SELECT bool_and(c.relrowsecurity AND pg_get_userbyid(c.relowner) = 'swarm_admin')
      FROM pg_class AS c
      WHERE c.oid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_tables_rls_and_owner_ok,
    COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
        'model', 'artifact_id_hash', 'payload', 'grant_id', 'uid', 'user_code_hash',
        'expires_at', 'consumed_at', 'created_at', 'updated_at'
      ]::text[]
      FROM information_schema.columns
      WHERE table_schema = 'commonswarm_oauth' AND table_name = 'provider_artifacts'
    ), false) AS provider_artifacts_columns_ok,
    COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
        'interaction_uid', 'session_hash', 'client_id', 'redirect_uri', 'resource',
        'requested_scopes', 'pkce_challenge', 'oauth_state', 'signin_state_hash',
        'signin_pkce_verifier', 'signin_state_consumed_at', 'user_id',
        'selected_workspace_ids', 'selection_version', 'manifest_digest',
        'provider_grant_id', 'commonswarm_grant_id', 'consent_token_hash',
        'consent_token_consumed_at', 'expires_at', 'completed_at', 'created_at', 'updated_at'
      ]::text[]
      FROM information_schema.columns
      WHERE table_schema = 'commonswarm_oauth' AND table_name = 'interactions'
    ), false) AS interactions_columns_ok,
    CASE WHEN role_state.present
      THEN COALESCE((
        SELECT bool_and(
          has_table_privilege('commonswarm_oauth_runtime', table_oid, 'SELECT')
          AND has_table_privilege('commonswarm_oauth_runtime', table_oid, 'INSERT')
          AND has_table_privilege('commonswarm_oauth_runtime', table_oid, 'UPDATE')
          AND has_table_privilege('commonswarm_oauth_runtime', table_oid, 'DELETE')
        )
        FROM unnest(ARRAY[object_state.artifacts_oid, object_state.sessions_oid,
          object_state.interactions_oid, object_state.cimd_oid,
          object_state.orchestration_oid]) AS required(table_oid)
      ), false)
      ELSE false END AS runtime_required_table_privileges_ok,
    COALESCE((
      SELECT count(*) = 15 AND bool_and(indexname = ANY (ARRAY[
        'provider_artifacts_pkey', 'provider_artifacts_grant_idx',
        'provider_artifacts_uid_idx', 'provider_artifacts_user_code_idx',
        'provider_artifacts_expiry_idx', 'refresh_family_tombstones_pkey',
        'browser_sessions_pkey', 'browser_sessions_expiry_idx',
        'interactions_pkey', 'interactions_session_idx', 'interactions_expiry_idx',
        'cimd_cache_pkey', 'cimd_cache_expiry_idx',
        'consent_orchestration_pkey', 'consent_orchestration_command_id_key'
      ]::text[]))
      FROM pg_indexes
      WHERE schemaname = 'commonswarm_oauth'
    ), false) AS oauth_indexes_ok,
    COALESCE((
      SELECT count(*) FILTER (WHERE contype = 'p') = 6
        AND count(*) FILTER (WHERE contype = 'f') = 2
        AND count(*) FILTER (WHERE contype = 'u') = 1
        AND count(*) FILTER (WHERE contype = 'c') = 29
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_constraints_ok,
    COALESCE((
      SELECT count(*) = 7 AND bool_and(roles = ARRAY['commonswarm_oauth_runtime']::name[])
      FROM pg_policies WHERE schemaname = 'commonswarm_oauth'
    ), false) AS oauth_policies_ok,
    CASE WHEN role_state.present AND object_state.tombstones_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'SELECT')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'INSERT')
        AND NOT has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'UPDATE')
        AND NOT has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'DELETE')
      ELSE false END AS tombstones_privileges_ok,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN has_function_privilege('commonswarm_oauth_runtime', object_state.status_oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', object_state.status_oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', object_state.status_oid, 'EXECUTE')
        AND pg_get_functiondef(object_state.status_oid) LIKE '%SECURITY DEFINER%'
        AND pg_get_functiondef(object_state.status_oid) LIKE '%SET search_path TO pg_catalog%'
        AND COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
          FROM pg_proc WHERE oid = object_state.status_oid), false)
      ELSE false END AS resolve_hosted_grant_status_ok,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN NOT has_function_privilege('commonswarm_oauth_runtime', object_state.active_oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', object_state.active_oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', object_state.active_oid, 'EXECUTE')
        AND pg_get_functiondef(object_state.active_oid) LIKE '%p_person_exists%'
        AND pg_get_functiondef(object_state.active_oid) LIKE '%NOT p_tombstoned%'
        AND COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
          FROM pg_proc WHERE oid = object_state.active_oid), false)
      ELSE false END AS hosted_grant_is_active_ok,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN has_function_privilege('swarm_read', object_state.family_oid, 'EXECUTE')
        AND NOT has_function_privilege('commonswarm_oauth_runtime', object_state.family_oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', object_state.family_oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', object_state.family_oid, 'EXECUTE')
        AND pg_get_functiondef(object_state.family_oid) LIKE '%SECURITY DEFINER%'
        AND pg_get_functiondef(object_state.family_oid) LIKE '%SET search_path TO pg_catalog%'
        AND COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
          FROM pg_proc WHERE oid = object_state.family_oid), false)
      ELSE false END AS provider_family_active_ok,
    NOT EXISTS (
      SELECT 1 FROM pg_auth_members AS membership
      JOIN pg_roles AS member ON member.oid = membership.member
      JOIN pg_roles AS parent ON parent.oid = membership.roleid
      WHERE member.rolname = 'commonswarm_oauth_runtime'
        AND parent.rolname IN ('swarm_admin', 'swarm_command', 'swarm_read')
    ) AS runtime_forbidden_memberships_absent,
    EXISTS (
      SELECT 1
      FROM pg_default_acl AS defaults
      WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
        AND defaults.defaclnamespace = 0
        AND defaults.defaclobjtype = 'f'
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(defaults.defaclacl) AS privilege
          WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
        )
    ) AS public_function_execute_default_revoked,
    :'lane_2_authority_present'::boolean AS lane_2_authority_present
  FROM role_state CROSS JOIN object_state
), predicate_details AS (
  SELECT
    CASE WHEN role_state.present AND object_state.namespace_oid IS NOT NULL
      THEN has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'USAGE')
      ELSE false END AS runtime_oauth_schema_usage,
    CASE WHEN role_state.present AND object_state.namespace_oid IS NOT NULL
      THEN NOT has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'CREATE')
      ELSE false END AS runtime_oauth_schema_create_denied,
    CASE WHEN role_state.present AND object_state.namespace_oid IS NOT NULL
      THEN NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE')
      ELSE false END AS runtime_swarm_schema_usage_denied,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'SELECT')
      ELSE false END AS runtime_artifacts_select,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'INSERT')
      ELSE false END AS runtime_artifacts_insert,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'UPDATE')
      ELSE false END AS runtime_artifacts_update,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'DELETE')
      ELSE false END AS runtime_artifacts_delete,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN NOT has_table_privilege('authenticated', object_state.artifacts_oid, 'SELECT')
      ELSE false END AS authenticated_artifacts_select_denied,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN NOT has_table_privilege('anon', object_state.artifacts_oid, 'SELECT')
      ELSE false END AS anon_artifacts_select_denied,
    CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN NOT has_table_privilege('swarm_read', object_state.artifacts_oid, 'SELECT')
      ELSE false END AS swarm_read_artifacts_select_denied,
    COALESCE((
      SELECT bool_and(c.relrowsecurity)
      FROM pg_class AS c
      WHERE c.oid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_tables_rls_enabled,
    COALESCE((
      SELECT bool_and(pg_get_userbyid(c.relowner) = 'swarm_admin')
      FROM pg_class AS c
      WHERE c.oid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_table_owners_are_swarm_admin,
    CASE WHEN role_state.present
      THEN COALESCE((
        SELECT bool_and(has_table_privilege(
          'commonswarm_oauth_runtime', table_oid, 'SELECT'))
        FROM unnest(ARRAY[object_state.artifacts_oid, object_state.sessions_oid,
          object_state.interactions_oid, object_state.cimd_oid,
          object_state.orchestration_oid]) AS required(table_oid)
      ), false)
      ELSE false END AS runtime_required_tables_select,
    CASE WHEN role_state.present
      THEN COALESCE((
        SELECT bool_and(has_table_privilege(
          'commonswarm_oauth_runtime', table_oid, 'INSERT'))
        FROM unnest(ARRAY[object_state.artifacts_oid, object_state.sessions_oid,
          object_state.interactions_oid, object_state.cimd_oid,
          object_state.orchestration_oid]) AS required(table_oid)
      ), false)
      ELSE false END AS runtime_required_tables_insert,
    CASE WHEN role_state.present
      THEN COALESCE((
        SELECT bool_and(has_table_privilege(
          'commonswarm_oauth_runtime', table_oid, 'UPDATE'))
        FROM unnest(ARRAY[object_state.artifacts_oid, object_state.sessions_oid,
          object_state.interactions_oid, object_state.cimd_oid,
          object_state.orchestration_oid]) AS required(table_oid)
      ), false)
      ELSE false END AS runtime_required_tables_update,
    CASE WHEN role_state.present
      THEN COALESCE((
        SELECT bool_and(has_table_privilege(
          'commonswarm_oauth_runtime', table_oid, 'DELETE'))
        FROM unnest(ARRAY[object_state.artifacts_oid, object_state.sessions_oid,
          object_state.interactions_oid, object_state.cimd_oid,
          object_state.orchestration_oid]) AS required(table_oid)
      ), false)
      ELSE false END AS runtime_required_tables_delete,
    COALESCE((
      SELECT count(*) = 15
      FROM pg_indexes
      WHERE schemaname = 'commonswarm_oauth'
    ), false) AS oauth_index_count_is_15,
    COALESCE((
      SELECT bool_and(indexname = ANY (ARRAY[
        'provider_artifacts_pkey', 'provider_artifacts_grant_idx',
        'provider_artifacts_uid_idx', 'provider_artifacts_user_code_idx',
        'provider_artifacts_expiry_idx', 'refresh_family_tombstones_pkey',
        'browser_sessions_pkey', 'browser_sessions_expiry_idx',
        'interactions_pkey', 'interactions_session_idx', 'interactions_expiry_idx',
        'cimd_cache_pkey', 'cimd_cache_expiry_idx',
        'consent_orchestration_pkey', 'consent_orchestration_command_id_key'
      ]::text[]))
      FROM pg_indexes
      WHERE schemaname = 'commonswarm_oauth'
    ), false) AS oauth_index_names_expected,
    COALESCE((
      SELECT count(*) FILTER (WHERE contype = 'p') = 6
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_primary_key_count_is_6,
    COALESCE((
      SELECT count(*) FILTER (WHERE contype = 'f') = 2
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_foreign_key_count_is_2,
    COALESCE((
      SELECT count(*) FILTER (WHERE contype = 'u') = 1
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_unique_constraint_count_is_1,
    COALESCE((
      SELECT count(*) FILTER (WHERE contype = 'c') = 29
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false) AS oauth_check_constraint_count_is_29,
    COALESCE((
      SELECT count(*) = 7
      FROM pg_policies WHERE schemaname = 'commonswarm_oauth'
    ), false) AS oauth_policy_count_is_7,
    COALESCE((
      SELECT bool_and(roles = ARRAY['commonswarm_oauth_runtime']::name[])
      FROM pg_policies WHERE schemaname = 'commonswarm_oauth'
    ), false) AS oauth_policy_roles_are_runtime,
    CASE WHEN role_state.present AND object_state.tombstones_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'SELECT')
      ELSE false END AS runtime_tombstones_select,
    CASE WHEN role_state.present AND object_state.tombstones_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'INSERT')
      ELSE false END AS runtime_tombstones_insert,
    CASE WHEN role_state.present AND object_state.tombstones_oid IS NOT NULL
      THEN NOT has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'UPDATE')
      ELSE false END AS runtime_tombstones_update_denied,
    CASE WHEN role_state.present AND object_state.tombstones_oid IS NOT NULL
      THEN NOT has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'DELETE')
      ELSE false END AS runtime_tombstones_delete_denied,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN has_function_privilege('commonswarm_oauth_runtime', object_state.status_oid, 'EXECUTE')
      ELSE false END AS runtime_status_execute,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN NOT has_function_privilege('authenticated', object_state.status_oid, 'EXECUTE')
      ELSE false END AS authenticated_status_execute_denied,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN NOT has_function_privilege('anon', object_state.status_oid, 'EXECUTE')
      ELSE false END AS anon_status_execute_denied,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN pg_get_functiondef(object_state.status_oid) LIKE '%SECURITY DEFINER%'
      ELSE false END AS status_is_security_definer,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN pg_get_functiondef(object_state.status_oid) LIKE '%SET search_path TO pg_catalog%'
      ELSE false END AS status_search_path_is_fixed,
    CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
        FROM pg_proc WHERE oid = object_state.status_oid), false)
      ELSE false END AS status_owner_is_swarm_admin,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN NOT has_function_privilege('commonswarm_oauth_runtime', object_state.active_oid, 'EXECUTE')
      ELSE false END AS runtime_active_execute_denied,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN NOT has_function_privilege('authenticated', object_state.active_oid, 'EXECUTE')
      ELSE false END AS authenticated_active_execute_denied,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN NOT has_function_privilege('anon', object_state.active_oid, 'EXECUTE')
      ELSE false END AS anon_active_execute_denied,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN pg_get_functiondef(object_state.active_oid) LIKE '%p_person_exists%'
      ELSE false END AS active_definition_has_person_exists,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN pg_get_functiondef(object_state.active_oid) LIKE '%NOT p_tombstoned%'
      ELSE false END AS active_definition_has_not_tombstoned,
    CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
        FROM pg_proc WHERE oid = object_state.active_oid), false)
      ELSE false END AS active_owner_is_swarm_admin,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN has_function_privilege('swarm_read', object_state.family_oid, 'EXECUTE')
      ELSE false END AS swarm_read_family_execute,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN NOT has_function_privilege('commonswarm_oauth_runtime', object_state.family_oid, 'EXECUTE')
      ELSE false END AS runtime_family_execute_denied,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN NOT has_function_privilege('authenticated', object_state.family_oid, 'EXECUTE')
      ELSE false END AS authenticated_family_execute_denied,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN NOT has_function_privilege('anon', object_state.family_oid, 'EXECUTE')
      ELSE false END AS anon_family_execute_denied,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN pg_get_functiondef(object_state.family_oid) LIKE '%SECURITY DEFINER%'
      ELSE false END AS family_is_security_definer,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN pg_get_functiondef(object_state.family_oid) LIKE '%SET search_path TO pg_catalog%'
      ELSE false END AS family_search_path_is_fixed,
    CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
        FROM pg_proc WHERE oid = object_state.family_oid), false)
      ELSE false END AS family_owner_is_swarm_admin
  FROM role_state CROSS JOIN object_state
), actuals AS (
  SELECT
    current_user::text AS current_user_actual,
    session_user::text AS session_user_actual,
    current_setting('search_path')::text AS search_path_actual,
    COALESCE((
      SELECT format(
        'oid=%s rolsuper=%s rolcreaterole=%s rolcanlogin=%s rolinherit=%s rolbypassrls=%s rolcreatedb=%s rolreplication=%s',
        oid, rolsuper, rolcreaterole, rolcanlogin, rolinherit, rolbypassrls,
        rolcreatedb, rolreplication
      )
      FROM pg_roles
      WHERE oid = role_oids.runtime_oid
    ), '<missing>') AS runtime_role_attributes_actual,
    COALESCE((
      SELECT string_agg(parent.rolname, ', ' ORDER BY parent.rolname)
      FROM pg_auth_members AS membership
      JOIN pg_roles AS parent ON parent.oid = membership.roleid
      WHERE membership.member = role_oids.runtime_oid
    ), '<none>') AS runtime_role_memberships_actual,
    COALESCE((
      SELECT format('owner=%s acl=%s', pg_get_userbyid(nspowner), COALESCE(nspacl::text, '<null>'))
      FROM pg_namespace
      WHERE oid = object_state.namespace_oid
    ), '<missing>') AS oauth_schema_owner_acl_actual,
    COALESCE((
      SELECT string_agg(
        format('%s owner=%s rls=%s acl=%s', c.oid::regclass::text,
          pg_get_userbyid(c.relowner), c.relrowsecurity, COALESCE(c.relacl::text, '<null>')),
        E'\n' ORDER BY c.oid::regclass::text
      )
      FROM pg_class AS c
      WHERE c.oid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), '<none>') AS oauth_table_owners_acls_actual,
    CASE WHEN role_oids.runtime_oid IS NULL THEN '<missing-role>'
      ELSE format('connect=%s',
        has_database_privilege(role_oids.runtime_oid, current_database(), 'CONNECT'))
      END AS runtime_database_privileges_actual,
    format('runtime_usage=%s runtime_create=%s runtime_swarm_usage=%s schema_acl=%s',
      COALESCE(has_schema_privilege(role_oids.runtime_oid, object_state.namespace_oid, 'USAGE')::text, '<missing>'),
      COALESCE(has_schema_privilege(role_oids.runtime_oid, object_state.namespace_oid, 'CREATE')::text, '<missing>'),
      COALESCE(has_schema_privilege(role_oids.runtime_oid, to_regnamespace('swarm'), 'USAGE')::text, '<missing>'),
      COALESCE((SELECT nspacl::text FROM pg_namespace WHERE oid = object_state.namespace_oid), '<null>')
    ) AS runtime_schema_privileges_actual,
    format('runtime_select=%s runtime_insert=%s runtime_update=%s runtime_delete=%s authenticated_select=%s anon_select=%s swarm_read_select=%s acl=%s',
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.artifacts_oid, 'SELECT')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.artifacts_oid, 'INSERT')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.artifacts_oid, 'UPDATE')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.artifacts_oid, 'DELETE')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.authenticated_oid, object_state.artifacts_oid, 'SELECT')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.anon_oid, object_state.artifacts_oid, 'SELECT')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.read_oid, object_state.artifacts_oid, 'SELECT')::text, '<missing>'),
      COALESCE((SELECT relacl::text FROM pg_class WHERE oid = object_state.artifacts_oid), '<null>')
    ) AS provider_artifacts_privileges_actual,
    COALESCE((
      SELECT string_agg(format('%s select=%s insert=%s update=%s delete=%s acl=%s',
        required.name,
        COALESCE(has_table_privilege(role_oids.runtime_oid, required.table_oid, 'SELECT')::text, '<missing>'),
        COALESCE(has_table_privilege(role_oids.runtime_oid, required.table_oid, 'INSERT')::text, '<missing>'),
        COALESCE(has_table_privilege(role_oids.runtime_oid, required.table_oid, 'UPDATE')::text, '<missing>'),
        COALESCE(has_table_privilege(role_oids.runtime_oid, required.table_oid, 'DELETE')::text, '<missing>'),
        COALESCE((SELECT relacl::text FROM pg_class WHERE oid = required.table_oid), '<null>')),
        E'\n' ORDER BY required.name)
      FROM (VALUES
        ('provider_artifacts', object_state.artifacts_oid),
        ('browser_sessions', object_state.sessions_oid),
        ('interactions', object_state.interactions_oid),
        ('cimd_cache', object_state.cimd_oid),
        ('consent_orchestration', object_state.orchestration_oid)
      ) AS required(name, table_oid)
    ), '<none>') AS runtime_required_table_privileges_actual,
    format('select=%s insert=%s update=%s delete=%s acl=%s',
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.tombstones_oid, 'SELECT')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.tombstones_oid, 'INSERT')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.tombstones_oid, 'UPDATE')::text, '<missing>'),
      COALESCE(has_table_privilege(role_oids.runtime_oid, object_state.tombstones_oid, 'DELETE')::text, '<missing>'),
      COALESCE((SELECT relacl::text FROM pg_class WHERE oid = object_state.tombstones_oid), '<null>')
    ) AS tombstones_privileges_actual,
    COALESCE((
      SELECT string_agg(format('%s owner=%s acl=%s hash=%s',
        functions.name, pg_get_userbyid(p.proowner), COALESCE(p.proacl::text, '<null>'),
        md5(pg_get_functiondef(p.oid))), E'\n' ORDER BY functions.name)
      FROM (VALUES
        ('hosted_grant_is_active', object_state.active_oid),
        ('resolve_hosted_grant_status', object_state.status_oid),
        ('provider_family_active', object_state.family_oid)
      ) AS functions(name, function_oid)
      JOIN pg_proc AS p ON p.oid = functions.function_oid
    ), '<none>') AS function_owners_acls_definition_hashes_actual,
    format('runtime=%s authenticated=%s anon=%s owner=%s security_definer=%s fixed_search_path=%s hash=%s acl=%s',
      COALESCE(has_function_privilege(role_oids.runtime_oid, object_state.status_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.authenticated_oid, object_state.status_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.anon_oid, object_state.status_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = object_state.status_oid), '<missing>'),
      COALESCE((pg_get_functiondef(object_state.status_oid) LIKE '%SECURITY DEFINER%')::text, '<missing>'),
      COALESCE((pg_get_functiondef(object_state.status_oid) LIKE '%SET search_path TO pg_catalog%')::text, '<missing>'),
      COALESCE(md5(pg_get_functiondef(object_state.status_oid)), '<missing>'),
      COALESCE((SELECT proacl::text FROM pg_proc WHERE oid = object_state.status_oid), '<null>')
    ) AS resolve_hosted_grant_status_actual,
    format('runtime=%s authenticated=%s anon=%s owner=%s has_person=%s has_not_tombstoned=%s hash=%s acl=%s',
      COALESCE(has_function_privilege(role_oids.runtime_oid, object_state.active_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.authenticated_oid, object_state.active_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.anon_oid, object_state.active_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = object_state.active_oid), '<missing>'),
      COALESCE((pg_get_functiondef(object_state.active_oid) LIKE '%p_person_exists%')::text, '<missing>'),
      COALESCE((pg_get_functiondef(object_state.active_oid) LIKE '%NOT p_tombstoned%')::text, '<missing>'),
      COALESCE(md5(pg_get_functiondef(object_state.active_oid)), '<missing>'),
      COALESCE((SELECT proacl::text FROM pg_proc WHERE oid = object_state.active_oid), '<null>')
    ) AS hosted_grant_is_active_actual,
    format('swarm_read=%s runtime=%s authenticated=%s anon=%s owner=%s security_definer=%s fixed_search_path=%s hash=%s acl=%s',
      COALESCE(has_function_privilege(role_oids.read_oid, object_state.family_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.runtime_oid, object_state.family_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.authenticated_oid, object_state.family_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE(has_function_privilege(role_oids.anon_oid, object_state.family_oid, 'EXECUTE')::text, '<missing>'),
      COALESCE((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = object_state.family_oid), '<missing>'),
      COALESCE((pg_get_functiondef(object_state.family_oid) LIKE '%SECURITY DEFINER%')::text, '<missing>'),
      COALESCE((pg_get_functiondef(object_state.family_oid) LIKE '%SET search_path TO pg_catalog%')::text, '<missing>'),
      COALESCE(md5(pg_get_functiondef(object_state.family_oid)), '<missing>'),
      COALESCE((SELECT proacl::text FROM pg_proc WHERE oid = object_state.family_oid), '<null>')
    ) AS provider_family_active_actual,
    COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position)::text
      FROM information_schema.columns
      WHERE table_schema = 'commonswarm_oauth' AND table_name = 'provider_artifacts'
    ), '{}') AS provider_artifacts_columns_actual,
    COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position)::text
      FROM information_schema.columns
      WHERE table_schema = 'commonswarm_oauth' AND table_name = 'interactions'
    ), '{}') AS interactions_columns_actual,
    COALESCE((
      SELECT format('count=%s names=%s', count(*), array_agg(indexname ORDER BY indexname)::text)
      FROM pg_indexes
      WHERE schemaname = 'commonswarm_oauth'
    ), '<none>') AS oauth_indexes_actual,
    COALESCE((
      SELECT format('primary=%s foreign=%s unique=%s check=%s',
        count(*) FILTER (WHERE contype = 'p'), count(*) FILTER (WHERE contype = 'f'),
        count(*) FILTER (WHERE contype = 'u'), count(*) FILTER (WHERE contype = 'c'))
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), '<none>') AS oauth_constraints_actual,
    COALESCE((
      SELECT format('count=%s policies=%s', count(*),
        string_agg(format('%s roles=%s', policyname, roles::text), ', ' ORDER BY policyname))
      FROM pg_policies WHERE schemaname = 'commonswarm_oauth'
    ), '<none>') AS oauth_policies_actual,
    COALESCE((
      SELECT string_agg(format('owner=%s namespace=%s type=%s acl=%s',
        pg_get_userbyid(defaults.defaclrole), defaults.defaclnamespace,
        defaults.defaclobjtype, COALESCE(defaults.defaclacl::text, '<null>')),
        E'\n' ORDER BY defaults.defaclnamespace, defaults.defaclobjtype)
      FROM pg_default_acl AS defaults
      WHERE defaults.defaclrole = role_oids.admin_oid
    ), '<none>') AS swarm_admin_default_acls_actual,
    format('oid=%s', COALESCE(to_regclass('swarm.hosted_mcp_grants')::text, '<missing>'))
      AS lane_2_authority_actual
  FROM object_state CROSS JOIN role_oids
), overall_result AS (
  SELECT COALESCE((SELECT
    role_state.present
    AND role_state.can_login
    AND role_state.no_inherit
    AND role_state.no_super
    AND role_state.no_createdb
    AND role_state.no_createrole
    AND role_state.no_replication
    AND role_state.no_bypassrls
    AND object_state.namespace_oid IS NOT NULL
    AND object_state.artifacts_oid IS NOT NULL
    AND object_state.tombstones_oid IS NOT NULL
    AND object_state.sessions_oid IS NOT NULL
    AND object_state.interactions_oid IS NOT NULL
    AND object_state.cimd_oid IS NOT NULL
    AND object_state.orchestration_oid IS NOT NULL
    AND object_state.active_oid IS NOT NULL
    AND object_state.status_oid IS NOT NULL
    AND object_state.family_oid IS NOT NULL
    AND COALESCE((
      SELECT pg_get_userbyid(nspowner) = 'swarm_admin'
      FROM pg_namespace WHERE oid = object_state.namespace_oid
    ), false)
    AND CASE WHEN role_state.present
      THEN has_database_privilege('commonswarm_oauth_runtime', current_database(), 'CONNECT')
      ELSE false END
    AND CASE WHEN role_state.present AND object_state.namespace_oid IS NOT NULL
      THEN has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'USAGE')
        AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'CREATE')
        AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE')
      ELSE false END
    AND CASE WHEN role_state.present AND object_state.artifacts_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'SELECT')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'INSERT')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'UPDATE')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.artifacts_oid, 'DELETE')
        AND NOT has_table_privilege('authenticated', object_state.artifacts_oid, 'SELECT')
        AND NOT has_table_privilege('anon', object_state.artifacts_oid, 'SELECT')
        AND NOT has_table_privilege('swarm_read', object_state.artifacts_oid, 'SELECT')
      ELSE false END
    AND COALESCE((
      SELECT bool_and(c.relrowsecurity AND pg_get_userbyid(c.relowner) = 'swarm_admin')
      FROM pg_class AS c
      WHERE c.oid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false)
    AND COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
        'model', 'artifact_id_hash', 'payload', 'grant_id', 'uid', 'user_code_hash',
        'expires_at', 'consumed_at', 'created_at', 'updated_at'
      ]::text[]
      FROM information_schema.columns
      WHERE table_schema = 'commonswarm_oauth' AND table_name = 'provider_artifacts'
    ), false)
    AND COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
        'interaction_uid', 'session_hash', 'client_id', 'redirect_uri', 'resource',
        'requested_scopes', 'pkce_challenge', 'oauth_state', 'signin_state_hash',
        'signin_pkce_verifier', 'signin_state_consumed_at', 'user_id',
        'selected_workspace_ids', 'selection_version', 'manifest_digest',
        'provider_grant_id', 'commonswarm_grant_id', 'consent_token_hash',
        'consent_token_consumed_at', 'expires_at', 'completed_at', 'created_at', 'updated_at'
      ]::text[]
      FROM information_schema.columns
      WHERE table_schema = 'commonswarm_oauth' AND table_name = 'interactions'
    ), false)
    AND CASE WHEN role_state.present
      THEN COALESCE((
        SELECT bool_and(
          has_table_privilege('commonswarm_oauth_runtime', table_oid, 'SELECT')
          AND has_table_privilege('commonswarm_oauth_runtime', table_oid, 'INSERT')
          AND has_table_privilege('commonswarm_oauth_runtime', table_oid, 'UPDATE')
          AND has_table_privilege('commonswarm_oauth_runtime', table_oid, 'DELETE')
        )
        FROM unnest(ARRAY[object_state.artifacts_oid, object_state.sessions_oid,
          object_state.interactions_oid, object_state.cimd_oid,
          object_state.orchestration_oid]) AS required(table_oid)
      ), false)
      ELSE false END
    AND COALESCE((
      SELECT count(*) = 15 AND bool_and(indexname = ANY (ARRAY[
        'provider_artifacts_pkey', 'provider_artifacts_grant_idx',
        'provider_artifacts_uid_idx', 'provider_artifacts_user_code_idx',
        'provider_artifacts_expiry_idx', 'refresh_family_tombstones_pkey',
        'browser_sessions_pkey', 'browser_sessions_expiry_idx',
        'interactions_pkey', 'interactions_session_idx', 'interactions_expiry_idx',
        'cimd_cache_pkey', 'cimd_cache_expiry_idx',
        'consent_orchestration_pkey', 'consent_orchestration_command_id_key'
      ]::text[]))
      FROM pg_indexes
      WHERE schemaname = 'commonswarm_oauth'
    ), false)
    AND COALESCE((
      SELECT count(*) FILTER (WHERE contype = 'p') = 6
        AND count(*) FILTER (WHERE contype = 'f') = 2
        AND count(*) FILTER (WHERE contype = 'u') = 1
        AND count(*) FILTER (WHERE contype = 'c') = 29
      FROM pg_constraint
      WHERE conrelid IN (object_state.artifacts_oid, object_state.tombstones_oid,
        object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
        object_state.orchestration_oid)
    ), false)
    AND COALESCE((
      SELECT count(*) = 7 AND bool_and(roles = ARRAY['commonswarm_oauth_runtime']::name[])
      FROM pg_policies WHERE schemaname = 'commonswarm_oauth'
    ), false)
    AND CASE WHEN role_state.present AND object_state.tombstones_oid IS NOT NULL
      THEN has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'SELECT')
        AND has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'INSERT')
        AND NOT has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'UPDATE')
        AND NOT has_table_privilege('commonswarm_oauth_runtime', object_state.tombstones_oid, 'DELETE')
      ELSE false END
    AND CASE WHEN role_state.present AND object_state.status_oid IS NOT NULL
      THEN has_function_privilege('commonswarm_oauth_runtime', object_state.status_oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', object_state.status_oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', object_state.status_oid, 'EXECUTE')
        AND pg_get_functiondef(object_state.status_oid) LIKE '%SECURITY DEFINER%'
        AND pg_get_functiondef(object_state.status_oid) LIKE '%SET search_path TO pg_catalog%'
        AND COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
          FROM pg_proc WHERE oid = object_state.status_oid), false)
      ELSE false END
    AND CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
      THEN NOT has_function_privilege('commonswarm_oauth_runtime', object_state.active_oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', object_state.active_oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', object_state.active_oid, 'EXECUTE')
        AND pg_get_functiondef(object_state.active_oid) LIKE '%p_person_exists%'
        AND pg_get_functiondef(object_state.active_oid) LIKE '%NOT p_tombstoned%'
        AND COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
          FROM pg_proc WHERE oid = object_state.active_oid), false)
      ELSE false END
    AND CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
      THEN has_function_privilege('swarm_read', object_state.family_oid, 'EXECUTE')
        AND NOT has_function_privilege('commonswarm_oauth_runtime', object_state.family_oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', object_state.family_oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', object_state.family_oid, 'EXECUTE')
        AND pg_get_functiondef(object_state.family_oid) LIKE '%SECURITY DEFINER%'
        AND pg_get_functiondef(object_state.family_oid) LIKE '%SET search_path TO pg_catalog%'
        AND COALESCE((SELECT pg_get_userbyid(proowner) = 'swarm_admin'
          FROM pg_proc WHERE oid = object_state.family_oid), false)
      ELSE false END
    AND NOT EXISTS (
      SELECT 1 FROM pg_auth_members AS membership
      JOIN pg_roles AS member ON member.oid = membership.member
      JOIN pg_roles AS parent ON parent.oid = membership.roleid
      WHERE member.rolname = 'commonswarm_oauth_runtime'
        AND parent.rolname IN ('swarm_admin', 'swarm_command', 'swarm_read')
    )
    AND EXISTS (
      SELECT 1
      FROM pg_default_acl AS defaults
      WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
        AND defaults.defaclnamespace = 0
        AND defaults.defaclobjtype = 'f'
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(defaults.defaclacl) AS privilege
          WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
        )
    )
    AND :'lane_2_authority_present'::boolean
  FROM role_state CROSS JOIN object_state), false) AS catalog_ok
)
SELECT
  predicates.*,
  predicate_details.*,
  actuals.*,
  overall_result.catalog_ok
FROM predicates
CROSS JOIN predicate_details
CROSS JOIN actuals
CROSS JOIN overall_result;

ROLLBACK;
