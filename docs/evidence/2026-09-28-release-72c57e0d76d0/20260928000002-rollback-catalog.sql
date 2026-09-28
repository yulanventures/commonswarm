SELECT
  to_regclass('swarm.hosted_mcp_grants') IS NULL
  AND to_regclass('swarm.hosted_mcp_grant_workspaces') IS NULL
  AND to_regclass('swarm.hosted_mcp_seats') IS NULL
  AND to_regclass('swarm.hosted_mcp_seat_handles') IS NULL
  AND to_regclass('swarm_read.hosted_mcp_connections') IS NULL
  AND to_regclass('swarm_read.hosted_mcp_seats') IS NULL
  AND to_regprocedure('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)') IS NULL
  AND to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)') IS NULL
  AND to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)') IS NULL
  AND COALESCE((
    SELECT pg_get_constraintdef(c.oid)
      LIKE '%user%agent%join%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%hosted_grant%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%hosted_seat%'
    FROM pg_constraint AS c
    WHERE c.conrelid = 'swarm.idempotency_keys'::regclass
      AND c.conname = 'idempotency_keys_principal_kind_check'
  ), false)
  AS rollback_ok
\gset
