-- Read-only section-5 catalog proof. One false Boolean stops the window.
SELECT
  COALESCE((SELECT array_agg(column_name::text ORDER BY ordinal_position) = ARRAY[
      'parent_signal_id', 'chain_root_id', 'chain_hop', 'chain_participants'
    ]::text[]
    FROM information_schema.columns
    WHERE table_schema::text = 'swarm' AND table_name::text = 'signals'
      AND column_name::text IN ('parent_signal_id', 'chain_root_id', 'chain_hop', 'chain_participants')), false)
  AND COALESCE((SELECT data_type::text = 'smallint' AND is_nullable::text = 'YES'
    FROM information_schema.columns
    WHERE table_schema::text = 'swarm' AND table_name::text = 'signals'
      AND column_name::text = 'chain_hop'), false)
  AND COALESCE((SELECT data_type::text = 'ARRAY' AND udt_name::text = '_uuid'
      AND is_nullable::text = 'YES'
    FROM information_schema.columns
    WHERE table_schema::text = 'swarm' AND table_name::text = 'signals'
      AND column_name::text = 'chain_participants'), false)
  AND COALESCE((SELECT pg_get_constraintdef(oid) LIKE
      'FOREIGN KEY (parent_signal_id, workspace_id) REFERENCES %signals(id, workspace_id)'
    FROM pg_constraint
    WHERE conrelid = 'swarm.signals'::regclass
      AND conname = 'signals_chain_parent_workspace'), false)
  AND to_regclass('swarm.signals_chain_parent_children') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'swarm.signals'::regclass
      AND tgname = 'signals_append_only' AND NOT tgisinternal)
  AND COALESCE((SELECT c.relkind = 'v'
    AND c.reloptions @> ARRAY['security_barrier=true']
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND has_table_privilege('authenticated', c.oid, 'SELECT')
    AND has_table_privilege('swarm_read', c.oid, 'SELECT')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT')
    AND pg_get_viewdef(c.oid) LIKE '%chain_hop%'
    AND pg_get_viewdef(c.oid) NOT LIKE '%parent_signal_id%'
    AND pg_get_viewdef(c.oid) NOT LIKE '%chain_root_id%'
    AND pg_get_viewdef(c.oid) NOT LIKE '%chain_participants%'
    FROM pg_class c WHERE c.oid = to_regclass('swarm_read.signals')), false)
  AS catalog_ok
\gset
