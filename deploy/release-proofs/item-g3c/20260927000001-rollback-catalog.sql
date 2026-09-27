SELECT
  NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('swarm.signals')
      AND attname = 'reply_status' AND NOT attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.signals')
      AND conname = 'signals_reply_status_valid'
  )
  AND COALESCE((
    SELECT c.relkind = 'v'
      AND c.reloptions @> ARRAY['security_barrier=true']
      AND pg_get_userbyid(c.relowner) = 'swarm_admin'
      AND has_table_privilege('authenticated', c.oid, 'SELECT')
      AND has_table_privilege('swarm_read', c.oid, 'SELECT')
      AND NOT has_table_privilege('anon', c.oid, 'SELECT')
      AND pg_get_viewdef(c.oid) NOT LIKE '%reply_status%'
      AND pg_get_viewdef(c.oid) LIKE '%signal_recipients%'
      AND pg_get_viewdef(c.oid) LIKE '%recipient_user_id = auth.uid()%'
    FROM pg_class AS c
    WHERE c.oid = to_regclass('swarm_read.signals')
  ), false)
  AND COALESCE((
    SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'id', 'workspace_id', 'from', 'from_kind', 'to', 'about', 'kind', 'body',
      'until', 'created_at', 'to_agent', 'in_reply_to', 'attachments',
      'channel_id', 'thread_root_id', 'broadcast_to_channel', 'recipients'
    ]::text[]
    FROM information_schema.columns
    WHERE table_schema::text = 'swarm_read' AND table_name::text = 'signals'
  ), false)
  AND COALESCE((
    SELECT p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'swarm_admin'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_get_functiondef(p.oid) NOT LIKE '%jsonb_build_object(''replies'', v_replies)%'
      AND pg_get_functiondef(p.oid) LIKE '%signal_delivery_receipts_without_wake_path%'
      AND pg_get_functiondef(p.oid) LIKE '%RETURN jsonb_set(v_result, ''{receipts}'', v_receipts, false)%'
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure(
      'swarm_read.signal_delivery_receipts(uuid,uuid,bytea)'
    )
  ), false)
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260927000001'
  )
  AS rollback_ok
\gset
