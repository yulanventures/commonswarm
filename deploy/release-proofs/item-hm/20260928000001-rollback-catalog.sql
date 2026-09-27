-- Read-only proof that the complete pre-HM view definitions, ACLs, and table
-- shape were restored by 20260928000001-rollback.sql.
SELECT
  NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('swarm.agent_principals')
      AND attname IN ('transport', 'turn_only') AND NOT attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.agent_principals')
      AND conname IN (
        'agent_principals_transport_valid',
        'agent_principals_hosted_turn_only'
      )
  )
  AND to_regprocedure('swarm.agent_principal_transport(uuid)') IS NULL
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
      AND pg_get_viewdef(v.oid) NOT LIKE '%transport%'
      AND pg_get_viewdef(v.oid) NOT LIKE '%turn_only%'
    FROM pg_class AS v
    WHERE v.oid = to_regclass('swarm_read.agent_principals')
  ), false)
  AND COALESCE((
    SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'principal_id', 'workspace_id', 'owner_user_id', 'name', 'created_at',
      'revoked_at', 'model', 'managed_at'
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
      AND pg_get_viewdef(v.oid) LIKE '%observed.ack_outcome%'
      AND pg_get_viewdef(v.oid) LIKE '%d.enqueued_at >= ( SELECT wake_path_release.applied_at%'
      AND pg_get_viewdef(v.oid) LIKE '%ROW(date_trunc(''milliseconds''::text, later_signal.created_at), later_signal.id) > ROW(date_trunc(''milliseconds''::text, s.created_at), s.id)%'
      AND pg_get_viewdef(v.oid) LIKE '%later_signal.kind = ANY%'
      AND pg_get_viewdef(v.oid) NOT LIKE '%p.turn_only%'
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
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260928000001'
  )
  AS rollback_ok
\gset
