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
    SELECT c.contype = 'c' AND c.convalidated
      AND pg_get_constraintdef(c.oid) =
        $check$CHECK ((principal_kind = ANY (ARRAY['user'::text, 'agent'::text, 'join'::text, 'hosted_grant'::text, 'hosted_seat'::text])))$check$
    FROM pg_constraint AS c
    WHERE c.conrelid = 'swarm.idempotency_keys'::regclass
      AND c.conname = 'idempotency_keys_principal_kind_check'
  ), false)
  AS rollback_ok
\gset
