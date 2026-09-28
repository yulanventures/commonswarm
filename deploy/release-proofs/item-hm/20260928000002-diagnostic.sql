-- Purpose: identify the exact 20260928000002 catalog predicate that differs on production.
-- Anvil runs this with the section 5 write helper and flags (deploy/RELEASE-TO-BOX.md:1199):
--   release_psql --file /proof/20260928000002-diagnostic.sql
-- The migration inclusion at runbook line 1173 is reproduced with psql \ir, relative to
-- this proof's staged /proof location and the sibling /migrations mount.
-- read-only in effect: ends with ROLLBACK

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
\ir ../migrations/20260928000002_hm_hosted_authority.sql

WITH authority_tables(name, oid) AS (
  VALUES
    ('hosted_mcp_grants', to_regclass('swarm.hosted_mcp_grants')),
    ('hosted_mcp_grant_workspaces', to_regclass('swarm.hosted_mcp_grant_workspaces')),
    ('hosted_mcp_seats', to_regclass('swarm.hosted_mcp_seats')),
    ('hosted_mcp_seat_handles', to_regclass('swarm.hosted_mcp_seat_handles'))
), hosted_functions(name, oid, allowed_role, denied_role) AS (
  VALUES
    ('grant', to_regprocedure('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)'), 'swarm_command', 'swarm_read'),
    ('seat_command', to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)'), 'swarm_command', 'swarm_read'),
    ('seat_read', to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)'), 'swarm_read', 'swarm_command')
), hosted_views(name, oid) AS (
  VALUES
    ('hosted_mcp_connections', to_regclass('swarm_read.hosted_mcp_connections')),
    ('hosted_mcp_seats', to_regclass('swarm_read.hosted_mcp_seats'))
), table_checks AS (
  SELECT count(*) = 4 AND bool_and(
    expected.oid IS NOT NULL
    AND c.relkind = 'r'
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND c.relrowsecurity
    AND has_table_privilege('swarm_command', c.oid, 'SELECT')
    AND has_table_privilege('swarm_command', c.oid, 'INSERT')
    AND has_table_privilege('swarm_command', c.oid, 'UPDATE')
    AND NOT has_table_privilege('swarm_read', c.oid, 'SELECT')
    AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
  ) AS ok
  FROM authority_tables AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), table_predicates AS (
  SELECT
    count(*) = 4 AS authority_table_count_is_4,
    bool_and(expected.oid IS NOT NULL) AS authority_tables_exist,
    bool_and(c.relkind = 'r') AS authority_tables_are_tables,
    bool_and(pg_get_userbyid(c.relowner) = 'swarm_admin') AS authority_table_owners_are_swarm_admin,
    bool_and(c.relrowsecurity) AS authority_table_rls_enabled,
    bool_and(has_table_privilege('swarm_command', c.oid, 'SELECT')) AS swarm_command_table_select,
    bool_and(has_table_privilege('swarm_command', c.oid, 'INSERT')) AS swarm_command_table_insert,
    bool_and(has_table_privilege('swarm_command', c.oid, 'UPDATE')) AS swarm_command_table_update,
    bool_and(NOT has_table_privilege('swarm_read', c.oid, 'SELECT')) AS swarm_read_table_select_denied,
    bool_and(NOT has_table_privilege('authenticated', c.oid, 'SELECT')) AS authenticated_table_select_denied,
    bool_and(NOT has_table_privilege('anon', c.oid, 'SELECT')) AS anon_table_select_denied
  FROM authority_tables AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), table_actuals AS (
  SELECT
    string_agg(format('%s=%s', expected.name, COALESCE(expected.oid::text, '<missing>')), ', ' ORDER BY expected.name) AS authority_table_oids_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(c.relkind::text, '<missing>')), ', ' ORDER BY expected.name) AS authority_table_relkinds_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(pg_get_userbyid(c.relowner), '<missing>')), ', ' ORDER BY expected.name) AS authority_table_owners_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(c.relrowsecurity::text, '<missing>')), ', ' ORDER BY expected.name) AS authority_table_rls_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('swarm_command', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS swarm_command_table_select_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('swarm_command', c.oid, 'INSERT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS swarm_command_table_insert_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('swarm_command', c.oid, 'UPDATE')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS swarm_command_table_update_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('swarm_read', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS swarm_read_table_select_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('authenticated', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS authenticated_table_select_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('anon', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS anon_table_select_actual
  FROM authority_tables AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), policy_checks AS (
  SELECT count(p.oid) = 4 AND bool_and(
    p.polname = 'swarm_command_all'
    AND p.polcmd = '*'
    AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command')]
  ) AS ok
  FROM authority_tables AS expected
  LEFT JOIN pg_policy AS p
    ON p.polrelid = expected.oid AND p.polname = 'swarm_command_all'
), policy_predicates AS (
  SELECT
    count(p.oid) = 4 AS swarm_command_policy_count_is_4,
    bool_and(p.polname = 'swarm_command_all') AS policy_names_are_swarm_command_all,
    bool_and(p.polcmd = '*') AS policies_apply_to_all_commands,
    bool_and(p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command')]) AS policy_roles_are_swarm_command
  FROM authority_tables AS expected
  LEFT JOIN pg_policy AS p
    ON p.polrelid = expected.oid AND p.polname = 'swarm_command_all'
), policy_actuals AS (
  SELECT
    string_agg(format('%s=%s', expected.name, COALESCE(p.polname, '<missing>')), ', ' ORDER BY expected.name) AS policy_names_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(p.polcmd::text, '<missing>')), ', ' ORDER BY expected.name) AS policy_commands_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(p.polroles::text, '<missing>')), ', ' ORDER BY expected.name) AS policy_role_oids_actual
  FROM authority_tables AS expected
  LEFT JOIN pg_policy AS p
    ON p.polrelid = expected.oid AND p.polname = 'swarm_command_all'
), function_checks AS (
  SELECT count(p.oid) = 3 AND bool_and(
    expected.oid IS NOT NULL
    AND p.prosecdef
    AND p.provolatile = 's'
    AND pg_get_userbyid(p.proowner) = 'swarm_admin'
    AND p.proconfig @> ARRAY['search_path=swarm, pg_catalog']::text[]
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND CASE WHEN expected.oid IS NULL THEN false
      ELSE has_function_privilege(expected.allowed_role, expected.oid, 'EXECUTE')
    END
    AND CASE WHEN expected.oid IS NULL THEN false
      ELSE NOT has_function_privilege(expected.denied_role, expected.oid, 'EXECUTE')
    END
  ) AS ok
  FROM hosted_functions AS expected
  LEFT JOIN pg_proc AS p ON p.oid = expected.oid
), function_predicates AS (
  SELECT
    count(p.oid) = 3 AS hosted_function_count_is_3,
    bool_and(expected.oid IS NOT NULL) AS hosted_functions_exist,
    bool_and(p.prosecdef) AS hosted_functions_are_security_definer,
    bool_and(p.provolatile = 's') AS hosted_functions_are_stable,
    bool_and(pg_get_userbyid(p.proowner) = 'swarm_admin') AS hosted_function_owners_are_swarm_admin,
    bool_and(p.proconfig @> ARRAY['search_path=swarm, pg_catalog']::text[]) AS hosted_function_search_path_is_fixed,
    bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS authenticated_function_execute_denied,
    bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_function_execute_denied,
    bool_and(CASE WHEN expected.oid IS NULL THEN false
      ELSE has_function_privilege(expected.allowed_role, expected.oid, 'EXECUTE')
    END) AS allowed_role_function_execute,
    bool_and(CASE WHEN expected.oid IS NULL THEN false
      ELSE NOT has_function_privilege(expected.denied_role, expected.oid, 'EXECUTE')
    END) AS denied_role_function_execute_denied
  FROM hosted_functions AS expected
  LEFT JOIN pg_proc AS p ON p.oid = expected.oid
), function_actuals AS (
  SELECT
    string_agg(format('%s=%s', expected.name, COALESCE(expected.oid::text, '<missing>')), ', ' ORDER BY expected.name) AS hosted_function_oids_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(p.prosecdef::text, '<missing>')), ', ' ORDER BY expected.name) AS hosted_function_security_definer_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(p.provolatile::text, '<missing>')), ', ' ORDER BY expected.name) AS hosted_function_volatility_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(pg_get_userbyid(p.proowner), '<missing>')), ', ' ORDER BY expected.name) AS hosted_function_owners_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(p.proconfig::text, '<null>')), ', ' ORDER BY expected.name) AS hosted_function_config_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_function_privilege('authenticated', p.oid, 'EXECUTE')::text, '<missing>'), COALESCE(p.proacl::text, '<null>')), ', ' ORDER BY expected.name) AS authenticated_function_execute_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_function_privilege('anon', p.oid, 'EXECUTE')::text, '<missing>'), COALESCE(p.proacl::text, '<null>')), ', ' ORDER BY expected.name) AS anon_function_execute_actual,
    string_agg(format('%s role=%s value=%s acl=%s', expected.name, expected.allowed_role, COALESCE(has_function_privilege(expected.allowed_role, expected.oid, 'EXECUTE')::text, '<missing>'), COALESCE(p.proacl::text, '<null>')), ', ' ORDER BY expected.name) AS allowed_role_function_execute_actual,
    string_agg(format('%s role=%s value=%s acl=%s', expected.name, expected.denied_role, COALESCE(has_function_privilege(expected.denied_role, expected.oid, 'EXECUTE')::text, '<missing>'), COALESCE(p.proacl::text, '<null>')), ', ' ORDER BY expected.name) AS denied_role_function_execute_actual
  FROM hosted_functions AS expected
  LEFT JOIN pg_proc AS p ON p.oid = expected.oid
), view_checks AS (
  SELECT count(c.oid) = 2 AND bool_and(
    expected.oid IS NOT NULL
    AND c.relkind = 'v'
    AND c.reloptions @> ARRAY['security_barrier=true']
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND has_table_privilege('authenticated', c.oid, 'SELECT')
    AND has_table_privilege('swarm_read', c.oid, 'SELECT')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
    AND EXISTS (
      SELECT 1
      FROM pg_rewrite AS r
      JOIN pg_depend AS d
        ON d.classid = 'pg_rewrite'::regclass
        AND d.objid = r.oid
        AND d.refclassid = 'pg_proc'::regclass
      WHERE r.ev_class = c.oid
        AND d.refobjid = to_regprocedure('auth.uid()')
    )
  ) AS ok
  FROM hosted_views AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), view_predicates AS (
  SELECT
    count(c.oid) = 2 AS hosted_view_count_is_2,
    bool_and(expected.oid IS NOT NULL) AS hosted_views_exist,
    bool_and(c.relkind = 'v') AS hosted_views_are_views,
    bool_and(c.reloptions @> ARRAY['security_barrier=true']) AS hosted_views_have_security_barrier,
    bool_and(pg_get_userbyid(c.relowner) = 'swarm_admin') AS hosted_view_owners_are_swarm_admin,
    bool_and(has_table_privilege('authenticated', c.oid, 'SELECT')) AS authenticated_view_select,
    bool_and(has_table_privilege('swarm_read', c.oid, 'SELECT')) AS swarm_read_view_select,
    bool_and(NOT has_table_privilege('anon', c.oid, 'SELECT')) AS anon_view_select_denied,
    bool_and(EXISTS (
      SELECT 1
      FROM pg_rewrite AS r
      JOIN pg_depend AS d
        ON d.classid = 'pg_rewrite'::regclass
        AND d.objid = r.oid
        AND d.refclassid = 'pg_proc'::regclass
      WHERE r.ev_class = c.oid
        AND d.refobjid = to_regprocedure('auth.uid()')
    )) AS hosted_view_definitions_use_auth_uid
  FROM hosted_views AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), view_actuals AS (
  SELECT
    string_agg(format('%s=%s', expected.name, COALESCE(expected.oid::text, '<missing>')), ', ' ORDER BY expected.name) AS hosted_view_oids_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(c.relkind::text, '<missing>')), ', ' ORDER BY expected.name) AS hosted_view_relkinds_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(c.reloptions::text, '<null>')), ', ' ORDER BY expected.name) AS hosted_view_options_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(pg_get_userbyid(c.relowner), '<missing>')), ', ' ORDER BY expected.name) AS hosted_view_owners_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('authenticated', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS authenticated_view_select_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('swarm_read', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS swarm_read_view_select_actual,
    string_agg(format('%s=%s acl=%s', expected.name, COALESCE(has_table_privilege('anon', c.oid, 'SELECT')::text, '<missing>'), COALESCE(c.relacl::text, '<null>')), ', ' ORDER BY expected.name) AS anon_view_select_actual,
    string_agg(format('%s=%s', expected.name, COALESCE(pg_get_viewdef(c.oid), '<missing>')), E'\n' ORDER BY expected.name) AS hosted_view_definitions_actual
  FROM hosted_views AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), composite_checks AS (
  SELECT
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_seats')
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%grant_id, workspace_id, owner_user_id%'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_seat_handles')
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%seat_id, grant_id, workspace_id, principal_id%'
    ) AS ok
), composite_predicates AS (
  SELECT
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_seats')
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%grant_id, workspace_id, owner_user_id%'
    ) AS hosted_mcp_seats_composite_fk_exists,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_seat_handles')
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%seat_id, grant_id, workspace_id, principal_id%'
    ) AS hosted_mcp_seat_handles_composite_fk_exists
), composite_actuals AS (
  SELECT
    COALESCE((
      SELECT string_agg(format('%s=%s', conname, pg_get_constraintdef(oid)), E'\n' ORDER BY conname)
      FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_seats')
        AND contype = 'f'
    ), '<none>') AS hosted_mcp_seats_foreign_keys_actual,
    COALESCE((
      SELECT string_agg(format('%s=%s', conname, pg_get_constraintdef(oid)), E'\n' ORDER BY conname)
      FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_seat_handles')
        AND contype = 'f'
    ), '<none>') AS hosted_mcp_seat_handles_foreign_keys_actual
), idempotency_check AS (
  SELECT COALESCE((
    SELECT pg_get_constraintdef(c.oid) LIKE '%user%agent%join%hosted_grant%hosted_seat%'
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.idempotency_keys')
      AND c.conname = 'idempotency_keys_principal_kind_check'
  ), false) AS idempotency_principal_kinds_include_hosted_values
), idempotency_actual AS (
  SELECT COALESCE((
    SELECT pg_get_constraintdef(c.oid)
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.idempotency_keys')
      AND c.conname = 'idempotency_keys_principal_kind_check'
  ), '<missing>') AS idempotency_principal_kind_definition_actual
)
SELECT
  COALESCE((SELECT ok FROM table_checks), false) AS table_checks_ok,
  table_predicates.authority_table_count_is_4,
  table_predicates.authority_tables_exist,
  table_actuals.authority_table_oids_actual,
  table_predicates.authority_tables_are_tables,
  table_actuals.authority_table_relkinds_actual,
  table_predicates.authority_table_owners_are_swarm_admin,
  table_actuals.authority_table_owners_actual,
  table_predicates.authority_table_rls_enabled,
  table_actuals.authority_table_rls_actual,
  table_predicates.swarm_command_table_select,
  table_actuals.swarm_command_table_select_actual,
  table_predicates.swarm_command_table_insert,
  table_actuals.swarm_command_table_insert_actual,
  table_predicates.swarm_command_table_update,
  table_actuals.swarm_command_table_update_actual,
  table_predicates.swarm_read_table_select_denied,
  table_actuals.swarm_read_table_select_actual,
  table_predicates.authenticated_table_select_denied,
  table_actuals.authenticated_table_select_actual,
  table_predicates.anon_table_select_denied,
  table_actuals.anon_table_select_actual,
  COALESCE((SELECT ok FROM policy_checks), false) AS policy_checks_ok,
  policy_predicates.swarm_command_policy_count_is_4,
  policy_predicates.policy_names_are_swarm_command_all,
  policy_actuals.policy_names_actual,
  policy_predicates.policies_apply_to_all_commands,
  policy_actuals.policy_commands_actual,
  policy_predicates.policy_roles_are_swarm_command,
  policy_actuals.policy_role_oids_actual,
  COALESCE((SELECT ok FROM function_checks), false) AS function_checks_ok,
  function_predicates.hosted_function_count_is_3,
  function_predicates.hosted_functions_exist,
  function_actuals.hosted_function_oids_actual,
  function_predicates.hosted_functions_are_security_definer,
  function_actuals.hosted_function_security_definer_actual,
  function_predicates.hosted_functions_are_stable,
  function_actuals.hosted_function_volatility_actual,
  function_predicates.hosted_function_owners_are_swarm_admin,
  function_actuals.hosted_function_owners_actual,
  function_predicates.hosted_function_search_path_is_fixed,
  function_actuals.hosted_function_config_actual,
  function_predicates.authenticated_function_execute_denied,
  function_actuals.authenticated_function_execute_actual,
  function_predicates.anon_function_execute_denied,
  function_actuals.anon_function_execute_actual,
  function_predicates.allowed_role_function_execute,
  function_actuals.allowed_role_function_execute_actual,
  function_predicates.denied_role_function_execute_denied,
  function_actuals.denied_role_function_execute_actual,
  COALESCE((SELECT ok FROM view_checks), false) AS view_checks_ok,
  view_predicates.hosted_view_count_is_2,
  view_predicates.hosted_views_exist,
  view_actuals.hosted_view_oids_actual,
  view_predicates.hosted_views_are_views,
  view_actuals.hosted_view_relkinds_actual,
  view_predicates.hosted_views_have_security_barrier,
  view_actuals.hosted_view_options_actual,
  view_predicates.hosted_view_owners_are_swarm_admin,
  view_actuals.hosted_view_owners_actual,
  view_predicates.authenticated_view_select,
  view_actuals.authenticated_view_select_actual,
  view_predicates.swarm_read_view_select,
  view_actuals.swarm_read_view_select_actual,
  view_predicates.anon_view_select_denied,
  view_actuals.anon_view_select_actual,
  view_predicates.hosted_view_definitions_use_auth_uid,
  view_actuals.hosted_view_definitions_actual,
  COALESCE((SELECT ok FROM composite_checks), false) AS composite_checks_ok,
  composite_predicates.hosted_mcp_seats_composite_fk_exists,
  composite_actuals.hosted_mcp_seats_foreign_keys_actual,
  composite_predicates.hosted_mcp_seat_handles_composite_fk_exists,
  composite_actuals.hosted_mcp_seat_handles_foreign_keys_actual,
  idempotency_check.idempotency_principal_kinds_include_hosted_values,
  idempotency_actual.idempotency_principal_kind_definition_actual,
  COALESCE((SELECT ok FROM table_checks), false)
  AND COALESCE((SELECT ok FROM policy_checks), false)
  AND COALESCE((SELECT ok FROM function_checks), false)
  AND COALESCE((SELECT ok FROM view_checks), false)
  AND COALESCE((SELECT ok FROM composite_checks), false)
  AND COALESCE((
    SELECT pg_get_constraintdef(c.oid) LIKE '%user%agent%join%hosted_grant%hosted_seat%'
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.idempotency_keys')
      AND c.conname = 'idempotency_keys_principal_kind_check'
  ), false)
  AS catalog_ok
FROM table_predicates
CROSS JOIN table_actuals
CROSS JOIN policy_predicates
CROSS JOIN policy_actuals
CROSS JOIN function_predicates
CROSS JOIN function_actuals
CROSS JOIN view_predicates
CROSS JOIN view_actuals
CROSS JOIN composite_predicates
CROSS JOIN composite_actuals
CROSS JOIN idempotency_check
CROSS JOIN idempotency_actual;

ROLLBACK;
