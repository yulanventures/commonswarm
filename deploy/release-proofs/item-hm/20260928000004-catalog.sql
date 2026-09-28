-- Catalog proof for 20260928000004_hm_hosted_check.sql.
-- Depends on 20260928000002_hm_hosted_authority.sql.
-- This query deliberately returns false, without error, before the migration.
WITH expected_tables(name, oid) AS (
  VALUES
    ('hosted_mcp_check_cursors', to_regclass('swarm.hosted_mcp_check_cursors')),
    ('hosted_mcp_check_batches', to_regclass('swarm.hosted_mcp_check_batches'))
), table_catalog AS (
  SELECT count(c.oid) = 2 AND bool_and(
    c.relkind = 'r'
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND c.relrowsecurity
    AND has_table_privilege('swarm_command', c.oid, 'SELECT')
    AND has_table_privilege('swarm_command', c.oid, 'INSERT')
    AND has_table_privilege('swarm_command', c.oid, 'UPDATE')
    AND NOT has_table_privilege('swarm_command', c.oid, 'DELETE')
    AND NOT has_table_privilege('swarm_read', c.oid, 'SELECT')
    AND NOT has_table_privilege('swarm_read', c.oid, 'INSERT')
    AND NOT has_table_privilege('swarm_read', c.oid, 'UPDATE')
    AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
    AND NOT has_table_privilege('authenticated', c.oid, 'INSERT')
    AND NOT has_table_privilege('authenticated', c.oid, 'UPDATE')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
    AND NOT has_table_privilege('anon', c.oid, 'INSERT')
    AND NOT has_table_privilege('anon', c.oid, 'UPDATE')
  ) AS ok
  FROM expected_tables AS expected
  LEFT JOIN pg_class AS c ON c.oid = expected.oid
), column_catalog AS (
  SELECT
    COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema::text = 'swarm'
        AND table_name::text = 'hosted_mcp_check_cursors'
    ), ARRAY[]::text[]) = ARRAY[
      'seat_id', 'grant_id', 'workspace_id', 'principal_id',
      'cursor_created_at', 'cursor_signal_id', 'updated_at'
    ]::text[]
    AND COALESCE((
      SELECT array_agg(column_name::text ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema::text = 'swarm'
        AND table_name::text = 'hosted_mcp_check_batches'
    ), ARRAY[]::text[]) = ARRAY[
      'batch_id', 'seat_id', 'grant_id', 'workspace_id', 'principal_id',
      'signal_ids', 'terminal_created_at', 'terminal_signal_id',
      'created_at', 'acknowledged_at'
    ]::text[] AS ok
), policy_catalog AS (
  SELECT count(p.oid) = 2 AND bool_and(
    p.polname = 'swarm_command_all'
    AND p.polcmd = '*'
    AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command')]
    AND pg_get_expr(p.polqual, p.polrelid) = 'true'
    AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
  ) AS ok
  FROM expected_tables AS expected
  LEFT JOIN pg_policy AS p
    ON p.polrelid = expected.oid AND p.polname = 'swarm_command_all'
), constraint_catalog AS (
  SELECT
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_cursors')) >= 6
    AND (SELECT count(*) FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_batches')) >= 10
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_cursors')
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE
          '%seat_id, grant_id, workspace_id, principal_id%hosted_mcp_seats%'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_batches')
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE
          '%seat_id, grant_id, workspace_id, principal_id%hosted_mcp_check_cursors%'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_batches')
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%cardinality(signal_ids) >= 1%'
        AND pg_get_constraintdef(oid) LIKE '%cardinality(signal_ids) <= 50%'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_cursors')
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%date_trunc(''milliseconds''%cursor_created_at%'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('swarm.hosted_mcp_check_batches')
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%date_trunc(''milliseconds''%terminal_created_at%'
    ) AS ok
), index_catalog AS (
  SELECT COALESCE((
    SELECT i.indisunique AND i.indisvalid AND i.indisready
      AND pg_get_expr(i.indpred, i.indrelid) = '(acknowledged_at IS NULL)'
      AND pg_get_indexdef(i.indexrelid) LIKE '%(seat_id)%'
    FROM pg_index AS i
    WHERE i.indexrelid = to_regclass('swarm.hosted_mcp_check_batches_one_active')
  ), false) AS ok
), function_catalog AS (
  SELECT
    COALESCE((
      SELECT p.prosecdef AND p.provolatile = 's'
        AND pg_get_userbyid(p.proowner) = 'swarm_admin'
        AND p.proconfig @> ARRAY['search_path=swarm, pg_catalog']::text[]
        AND has_function_privilege('swarm_command', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('swarm_read', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      FROM pg_proc AS p
      WHERE p.oid = to_regprocedure('swarm.resolve_hosted_mcp_check_authorization(uuid,text)')
    ), false)
    AND COALESCE((
      SELECT p.prosecdef AND p.provolatile = 's'
        AND pg_get_userbyid(p.proowner) = 'swarm_admin'
        AND p.proconfig @> ARRAY['search_path=swarm_read, swarm, auth, pg_catalog']::text[]
        -- Do not inspect pg_get_functiondef/prosrc source text: schema
        -- qualification is not a stable catalog contract. Prove the SQL
        -- function's explicit return contract with catalog columns instead.
        AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
        AND p.prorettype = 'record'::regtype
        AND p.proretset
        AND p.proargnames = ARRAY[
          'p_workspace_id', 'p_principal_id', 'p_signal_ids',
          'id', 'workspace_id', 'from', 'from_kind', 'to', 'about', 'kind',
          'body', 'until', 'created_at', 'to_agent', 'in_reply_to',
          'attachments', 'channel_id', 'thread_root_id',
          'broadcast_to_channel', 'recipients', 'reply_status', 'chain_hop'
        ]::text[]
        AND p.proallargtypes = ARRAY[
          'uuid'::regtype, 'uuid'::regtype, 'uuid[]'::regtype,
          'uuid'::regtype, 'uuid'::regtype, 'uuid'::regtype, 'text'::regtype,
          'uuid'::regtype, 'text'::regtype, 'text'::regtype, 'text'::regtype,
          'timestamptz'::regtype, 'timestamptz'::regtype, 'uuid'::regtype,
          'uuid'::regtype, 'jsonb'::regtype, 'uuid'::regtype, 'uuid'::regtype,
          'boolean'::regtype, 'jsonb'::regtype, 'text'::regtype, 'smallint'::regtype
        ]::oid[]
        AND NOT EXISTS (
          SELECT 1
          FROM pg_depend AS dependency
          JOIN pg_type AS depended_type ON depended_type.oid = dependency.refobjid
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = p.oid
            AND dependency.refclassid = 'pg_type'::regclass
            AND depended_type.typrelid = to_regclass('swarm_read.signals')
        )
        AND has_function_privilege('swarm_command', p.oid, 'EXECUTE')
        AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      FROM pg_proc AS p
      WHERE p.oid = to_regprocedure(
        'swarm.hosted_mcp_check_visible_signals(uuid,uuid,uuid[])'
      )
    ), false)
    AND COALESCE((
      SELECT NOT p.prosecdef AND p.provolatile = 'v'
        AND pg_get_userbyid(p.proowner) = 'swarm_admin'
        AND p.proconfig @> ARRAY['search_path=pg_catalog']::text[]
        AND NOT has_function_privilege('swarm_command', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('swarm_read', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      FROM pg_proc AS p
      WHERE p.oid = to_regprocedure('swarm.hosted_mcp_check_batches_guard()')
    ), false)
    AND COALESCE((
      SELECT NOT p.prosecdef AND p.provolatile = 'v'
        AND pg_get_userbyid(p.proowner) = 'swarm_admin'
        AND p.proconfig @> ARRAY['search_path=pg_catalog']::text[]
        AND NOT has_function_privilege('swarm_command', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('swarm_read', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      FROM pg_proc AS p
      WHERE p.oid = to_regprocedure('swarm.hosted_mcp_check_cursors_guard()')
    ), false) AS ok
), trigger_catalog AS (
  SELECT
    COALESCE((
      SELECT NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgfoid = to_regprocedure('swarm.hosted_mcp_check_batches_guard()')
      FROM pg_trigger AS t
      WHERE t.tgrelid = to_regclass('swarm.hosted_mcp_check_batches')
        AND t.tgname = 'hosted_mcp_check_batches_guard'
    ), false)
    AND COALESCE((
      SELECT NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgfoid = to_regprocedure('swarm.hosted_mcp_check_cursors_guard()')
      FROM pg_trigger AS t
      WHERE t.tgrelid = to_regclass('swarm.hosted_mcp_check_cursors')
        AND t.tgname = 'hosted_mcp_check_cursors_guard'
    ), false) AS ok
), schema_catalog AS (
  SELECT
    has_schema_privilege('swarm_command', 'swarm', 'USAGE')
    AND has_schema_privilege('swarm_read', 'swarm', 'USAGE')
    AND NOT has_schema_privilege('anon', 'swarm', 'USAGE') AS ok
)
SELECT
  COALESCE((SELECT ok FROM table_catalog), false)
  AND COALESCE((SELECT ok FROM column_catalog), false)
  AND COALESCE((SELECT ok FROM policy_catalog), false)
  AND COALESCE((SELECT ok FROM constraint_catalog), false)
  AND COALESCE((SELECT ok FROM index_catalog), false)
  AND COALESCE((SELECT ok FROM function_catalog), false)
  AND COALESCE((SELECT ok FROM trigger_catalog), false)
  AND COALESCE((SELECT ok FROM schema_catalog), false)
  AS catalog_ok
\gset
