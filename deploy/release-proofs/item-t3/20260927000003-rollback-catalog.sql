-- Read-only Boolean for the state after 20260927000003-rollback.sql.
SELECT
  NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema::text = 'swarm' AND table_name::text = 'signals'
      AND column_name::text IN ('parent_signal_id', 'chain_root_id', 'chain_hop', 'chain_participants'))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.signals')
      AND conname IN (
        'signals_chain_parent_workspace',
        'signals_chain_columns_together',
        'signals_chain_parent_ask'
      ))
  AND to_regclass('swarm.signals_chain_parent_children') IS NULL
  AND EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = to_regclass('swarm.signals')
      AND tgname = 'signals_append_only' AND NOT tgisinternal)
  AND COALESCE((SELECT c.relkind = 'v'
      AND c.reloptions @> ARRAY['security_barrier=true']
      AND pg_get_userbyid(c.relowner) = 'swarm_admin'
      AND has_table_privilege('authenticated', c.oid, 'SELECT')
      AND has_table_privilege('swarm_read', c.oid, 'SELECT')
      AND NOT has_table_privilege('anon', c.oid, 'SELECT')
      AND pg_get_viewdef(c.oid) NOT LIKE '%chain_hop%'
      AND pg_get_viewdef(c.oid) NOT LIKE '%parent_signal_id%'
      AND pg_get_viewdef(c.oid) NOT LIKE '%chain_root_id%'
      AND pg_get_viewdef(c.oid) NOT LIKE '%chain_participants%'
      AND pg_get_viewdef(c.oid) LIKE '%reply_status%'
      AND pg_get_viewdef(c.oid) LIKE '%recipient_user_id = auth.uid()%'
    FROM pg_class AS c
    WHERE c.oid = to_regclass('swarm_read.signals')), false)
  AND COALESCE((SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'id', 'workspace_id', 'from', 'from_kind', 'to', 'about', 'kind', 'body',
      'until', 'created_at', 'to_agent', 'in_reply_to', 'attachments',
      'channel_id', 'thread_root_id', 'broadcast_to_channel', 'recipients',
      'reply_status'
    ]::text[]
    FROM information_schema.columns
    WHERE table_schema::text = 'swarm_read' AND table_name::text = 'signals'), false)
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260927000003')
  AS rollback_ok
\gset
