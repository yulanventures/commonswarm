-- Read-only catalog proof for reply status storage, reader projection, and receipt shape.
SELECT
  EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('swarm.signals')
      AND attname = 'reply_status' AND NOT attisdropped
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('swarm.signals')
      AND conname = 'signals_reply_status_valid'
      AND pg_get_constraintdef(oid) LIKE '%in_reply_to IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%answered%'
      AND pg_get_constraintdef(oid) LIKE '%failed%'
      AND pg_get_constraintdef(oid) LIKE '%declined%'
  )
  AND COALESCE((
    SELECT pg_get_viewdef(c.oid) LIKE '%reply_status%'
      AND c.reloptions @> ARRAY['security_barrier=true']
    FROM pg_class AS c
    WHERE c.oid = to_regclass('swarm_read.signals')
  ), false)
  AND COALESCE((
    SELECT p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'swarm_admin'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_get_functiondef(p.oid) LIKE '%jsonb_build_object(''replies'', v_replies)%'
      AND pg_get_functiondef(p.oid) LIKE '%ORDER BY reply.created_at, reply.id%'
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure(
      'swarm_read.signal_delivery_receipts(uuid,uuid,bytea)'
    )
  ), false)
  AS catalog_ok
\gset
