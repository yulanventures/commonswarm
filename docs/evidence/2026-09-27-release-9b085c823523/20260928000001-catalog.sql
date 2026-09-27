-- Read-only section-5 proof for HM lane 4 transport storage and both views.
SELECT
  COALESCE((
    SELECT c.relkind = 'r'
      AND pg_get_userbyid(c.relowner) = 'swarm_admin'
      AND c.relrowsecurity
      AND has_table_privilege('swarm_command', c.oid, 'SELECT')
      AND has_table_privilege('swarm_command', c.oid, 'INSERT')
      AND has_table_privilege('swarm_command', c.oid, 'UPDATE')
      AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
      AND NOT has_table_privilege('anon', c.oid, 'SELECT')
      AND NOT has_table_privilege('swarm_read', c.oid, 'SELECT')
    FROM pg_class AS c
    WHERE c.oid = to_regclass('swarm.agent_principals')
  ), false)
  AND COALESCE((
    SELECT array_agg(
      a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':'
        || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
      ORDER BY a.attnum
    ) FILTER (WHERE a.attname IN ('transport', 'turn_only'))
      = ARRAY[
        'transport:text:true:''local''::text',
        'turn_only:boolean:true:false'
      ]::text[]
    FROM pg_attribute AS a
    LEFT JOIN pg_attrdef AS d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('swarm.agent_principals')
      AND a.attnum > 0 AND NOT a.attisdropped
  ), false)
  AND COALESCE((
    SELECT count(*) = 2
      AND bool_and(c.convalidated)
      AND bool_or(c.conname = 'agent_principals_transport_valid'
        AND pg_get_constraintdef(c.oid) LIKE '%transport%local%hosted_mcp%')
      AND bool_or(c.conname = 'agent_principals_hosted_turn_only'
        AND pg_get_constraintdef(c.oid) LIKE '%transport%hosted_mcp%turn_only%')
    FROM pg_constraint AS c
    WHERE c.conrelid = to_regclass('swarm.agent_principals')
      AND c.conname IN (
        'agent_principals_transport_valid',
        'agent_principals_hosted_turn_only'
      )
  ), false)
  AND EXISTS (
    SELECT 1 FROM pg_policy AS p
    WHERE p.polrelid = to_regclass('swarm.agent_principals')
      AND p.polname = 'swarm_command_all'
      AND p.polcmd = '*'
      AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command')]
  )
  AND COALESCE((
    SELECT p.prosecdef
      AND p.provolatile = 's'
      AND pg_get_userbyid(p.proowner) = 'swarm_admin'
      AND p.proconfig @> ARRAY['search_path=swarm, pg_catalog']::text[]
      AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('swarm_command', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_get_functiondef(p.oid) LIKE '%SELECT p.transport%'
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('swarm.agent_principal_transport(uuid)')
  ), false)
  AND COALESCE((
    SELECT v.relkind = 'v'
      AND v.reloptions @> ARRAY['security_barrier=true']
      AND pg_get_userbyid(v.relowner) = 'swarm_admin'
      AND has_table_privilege('authenticated', v.oid, 'SELECT')
      AND has_table_privilege('swarm_read', v.oid, 'SELECT')
      AND NOT has_table_privilege('anon', v.oid, 'SELECT')
      AND pg_get_viewdef(v.oid) LIKE '%swarm.is_member%'
      AND pg_get_viewdef(v.oid) LIKE '%agent_join_credentials%'
      AND pg_get_viewdef(v.oid) LIKE '%registrar_principal_id%'
    FROM pg_class AS v
    WHERE v.oid = to_regclass('swarm_read.agent_principals')
  ), false)
  AND COALESCE((
    SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'principal_id', 'workspace_id', 'owner_user_id', 'name', 'created_at',
      'revoked_at', 'model', 'managed_at', 'transport', 'turn_only'
    ]::text[]
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read' AND table_name = 'agent_principals'
  ), false)
  AND COALESCE((
    SELECT v.relkind = 'v'
      AND v.reloptions @> ARRAY['security_barrier=true']
      AND pg_get_userbyid(v.relowner) = 'swarm_admin'
      AND NOT has_table_privilege('authenticated', v.oid, 'SELECT')
      AND NOT has_table_privilege('anon', v.oid, 'SELECT')
      AND NOT has_table_privilege('swarm_read', v.oid, 'SELECT')
      AND NOT has_table_privilege('swarm_command', v.oid, 'SELECT')
      AND pg_get_viewdef(v.oid) LIKE '%d.acked_at IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.lease_id IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.leased_by IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.last_lease_id IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%d.last_leased_by IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%wake_path_release%'
      AND pg_get_viewdef(v.oid) LIKE '%s.until > statement_timestamp()%'
      AND pg_get_viewdef(v.oid) LIKE '%s.kind = ANY%'
      AND pg_get_viewdef(v.oid) LIKE '%s.to_agent_principal_id = d.recipient_agent_principal_id%'
      AND pg_get_viewdef(v.oid) LIKE '%r.recipient_agent_principal_id = d.recipient_agent_principal_id%'
      AND pg_get_viewdef(v.oid) LIKE '%p.revoked_at IS NULL%'
      AND pg_get_viewdef(v.oid) LIKE '%p.turn_only = false%'
      AND pg_get_viewdef(v.oid) LIKE '%observed.ack_outcome%'
      AND pg_get_viewdef(v.oid) LIKE '%d.enqueued_at >= ( SELECT wake_path_release.applied_at%'
      AND pg_get_viewdef(v.oid) LIKE '%ROW(date_trunc(''milliseconds''::text, later_signal.created_at), later_signal.id) > ROW(date_trunc(''milliseconds''::text, s.created_at), s.id)%'
      AND pg_get_viewdef(v.oid) LIKE '%later_signal.kind = ANY%'
      AND pg_get_viewdef(v.oid) NOT LIKE '%later.enqueued_at > d.enqueued_at%'
    FROM pg_class AS v
    WHERE v.oid = to_regclass('swarm.wake_path_eligible_deliveries')
  ), false)
  AND COALESCE((
    SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'workspace_id', 'signal_id', 'principal_id', 'enqueued_at'
    ]::text[]
    FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'wake_path_eligible_deliveries'
  ), false)
  AS catalog_ok
\gset
