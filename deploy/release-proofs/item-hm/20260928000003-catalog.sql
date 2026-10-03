-- Safe before migration: every object lookup and privilege call is guarded.
-- Lane 6 deliberately depends on lane 2 migration 20260928000002 and reports
-- that dependency as a named false instead of dereferencing an absent table.
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
), hm6_tables AS (
  -- Later migrations (such as OAuth DCR) own additional tables in this schema.
  -- Keep exact index/policy counts for HM6's tables; their proofs own the additions.
  SELECT unnest(ARRAY[object_state.artifacts_oid, object_state.tombstones_oid,
    object_state.sessions_oid, object_state.interactions_oid, object_state.cimd_oid,
    object_state.orchestration_oid]) AS table_oid
  FROM object_state
)
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
    SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum) = ARRAY[
      'model', 'artifact_id_hash', 'payload', 'grant_id', 'uid', 'user_code_hash',
      'expires_at', 'consumed_at', 'created_at', 'updated_at'
    ]::text[]
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = object_state.artifacts_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ), false)
  AND COALESCE((
    SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum) = ARRAY[
      'interaction_uid', 'session_hash', 'client_id', 'redirect_uri', 'resource',
      'requested_scopes', 'pkce_challenge', 'oauth_state', 'signin_state_hash',
      'signin_pkce_verifier', 'signin_state_consumed_at', 'user_id',
      'selected_workspace_ids', 'selection_version', 'manifest_digest',
      'provider_grant_id', 'commonswarm_grant_id', 'consent_token_hash',
      'consent_token_consumed_at', 'expires_at', 'completed_at', 'created_at', 'updated_at'
    ]::text[]
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = object_state.interactions_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
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
    SELECT count(*) = 15 AND bool_and(index_rel.relname::text = ANY (ARRAY[
      'provider_artifacts_pkey', 'provider_artifacts_grant_idx',
      'provider_artifacts_uid_idx', 'provider_artifacts_user_code_idx',
      'provider_artifacts_expiry_idx', 'refresh_family_tombstones_pkey',
      'browser_sessions_pkey', 'browser_sessions_expiry_idx',
      'interactions_pkey', 'interactions_session_idx', 'interactions_expiry_idx',
      'cimd_cache_pkey', 'cimd_cache_expiry_idx',
      'consent_orchestration_pkey', 'consent_orchestration_command_id_key'
    ]::text[]))
    FROM pg_index AS index_state
    JOIN pg_class AS index_rel ON index_rel.oid = index_state.indexrelid
    WHERE index_state.indrelid IN (SELECT table_oid FROM hm6_tables)
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
    SELECT count(*) = 7 AND bool_and(polroles = ARRAY[
      (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime')
    ])
    FROM pg_policy WHERE polrelid IN (SELECT table_oid FROM hm6_tables)
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
      AND COALESCE((
        SELECT p.prosecdef
          AND p.provolatile = 's'::"char"
          AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
          AND l.lanname = 'plpgsql'
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
        FROM pg_proc AS p
        JOIN pg_language AS l ON l.oid = p.prolang
        WHERE p.oid = object_state.status_oid
      ), false)
    ELSE false END
  AND CASE WHEN role_state.present AND object_state.active_oid IS NOT NULL
    THEN NOT has_function_privilege('commonswarm_oauth_runtime', object_state.active_oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', object_state.active_oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', object_state.active_oid, 'EXECUTE')
      AND COALESCE((
        SELECT NOT p.prosecdef
          AND p.provolatile = 'i'::"char"
          AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
          AND p.proargnames = ARRAY[
            'p_state', 'p_revoked_at', 'p_person_exists', 'p_tombstoned'
          ]::text[]
          AND l.lanname = 'sql'
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
        FROM pg_proc AS p
        JOIN pg_language AS l ON l.oid = p.prolang
        WHERE p.oid = object_state.active_oid
      ), false)
    ELSE false END
  AND CASE WHEN role_state.present AND object_state.family_oid IS NOT NULL
    THEN has_function_privilege('swarm_read', object_state.family_oid, 'EXECUTE')
      AND NOT has_function_privilege('commonswarm_oauth_runtime', object_state.family_oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', object_state.family_oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', object_state.family_oid, 'EXECUTE')
      AND COALESCE((
        SELECT p.prosecdef
          AND p.provolatile = 's'::"char"
          AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
          AND l.lanname = 'sql'
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
        FROM pg_proc AS p
        JOIN pg_language AS l ON l.oid = p.prolang
        WHERE p.oid = object_state.family_oid
      ), false)
    ELSE false END
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members AS membership
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS parent ON parent.oid = membership.roleid
    WHERE member.rolname = 'commonswarm_oauth_runtime'
      AND parent.rolname IN ('swarm_admin', 'swarm_command', 'swarm_read')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members AS membership
    JOIN pg_roles AS parent ON parent.oid = membership.roleid
    WHERE parent.rolname = 'commonswarm_oauth_runtime'
      AND (membership.inherit_option OR membership.set_option)
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
FROM role_state CROSS JOIN object_state), false)
  AS catalog_ok
\gset
