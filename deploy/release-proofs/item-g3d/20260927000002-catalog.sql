-- Read-only section-5 catalog proof. One false Boolean stops the window.
SELECT
  COALESCE((SELECT c.relkind = 'r'
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND c.relrowsecurity
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
    AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
    AND NOT has_table_privilege('swarm_read', c.oid, 'SELECT')
    AND has_table_privilege('swarm_command', c.oid, 'SELECT')
    AND has_table_privilege('swarm_command', c.oid, 'INSERT')
    AND has_table_privilege('swarm_command', c.oid, 'UPDATE')
    FROM pg_class c WHERE c.oid = to_regclass('swarm.agent_presence')), false)
  AND COALESCE((SELECT array_agg(column_name ORDER BY ordinal_position) = ARRAY[
      'workspace_id', 'principal_id', 'last_command_at', 'client_build',
      'watcher_at', 'channel_at', 'listener_at', 'turn_at'
    ]
    FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'agent_presence'), false)
  AND COALESCE((SELECT count(*) = 2 FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.agent_presence')
      AND contype IN ('p', 'f')), false)
  AND EXISTS (SELECT 1 FROM pg_policy
    WHERE polrelid = to_regclass('swarm.agent_presence')
      AND polname = 'agent_presence_command_all')
  AND COALESCE((SELECT data_type = 'text' AND is_nullable = 'YES'
    FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'signal_deliveries'
      AND column_name = 'ack_via'), false)
  AND COALESCE((SELECT count(*) = 1 AND bool_and(
      pg_get_constraintdef(oid) LIKE '%ack_via%leased%unclaimed%')
    FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.signal_deliveries')
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ack_via%'), false)
  AND to_regclass('swarm.signal_deliveries_presence_latest_ack') IS NOT NULL
  AND COALESCE((SELECT value = 'null'::jsonb OR jsonb_typeof(value) = 'string'
    FROM swarm.config WHERE key = 'current_client_build'), false)
  AND COALESCE((SELECT c.relkind = 'v'
    AND c.reloptions @> ARRAY['security_barrier=true']
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND has_table_privilege('authenticated', c.oid, 'SELECT')
    AND has_table_privilege('swarm_read', c.oid, 'SELECT')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
    AND pg_get_viewdef(c.oid) LIKE '%is_member%'
    AND pg_get_viewdef(c.oid) NOT LIKE '%SELECT *%'
    FROM pg_class c WHERE c.oid = to_regclass('swarm_read.agent_presence')), false)
  AND COALESCE((SELECT array_agg(column_name ORDER BY ordinal_position) = ARRAY[
      'workspace_id', 'principal_id', 'last_command_at', 'client_build',
      'watcher_at', 'channel_at', 'listener_at', 'turn_at',
      'last_ack_via', 'last_ack_at', 'current_client_build'
    ]
    FROM information_schema.columns
    WHERE table_schema = 'swarm_read' AND table_name = 'agent_presence'), false)
  AS catalog_ok
\gset
