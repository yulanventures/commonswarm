SELECT
  NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('swarm.signals')
      AND attname = 'reply_status' AND NOT attisdropped
  )
  AND COALESCE((
    SELECT pg_get_viewdef(c.oid) NOT LIKE '%reply_status%'
    FROM pg_class AS c
    WHERE c.oid = to_regclass('swarm_read.signals')
  ), false)
  AND COALESCE((
    SELECT pg_get_functiondef(p.oid) NOT LIKE '%jsonb_build_object(''replies'', v_replies)%'
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
