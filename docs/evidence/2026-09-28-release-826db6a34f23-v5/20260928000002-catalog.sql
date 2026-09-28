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
), policy_checks AS (
  SELECT count(p.oid) = 4 AND bool_and(
    p.polname = 'swarm_command_all'
    AND p.polcmd = '*'
    AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command')]
  ) AS ok
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
)
SELECT
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
\gset
