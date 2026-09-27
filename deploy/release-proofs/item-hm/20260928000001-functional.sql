-- Read-only section-5 proof. Select one live local principal from the target;
-- this lane intentionally creates no hosted seat.
SELECT
  p.principal_id::text AS item_hm_principal_id,
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', p.owner_user_id::text,
      'role', 'authenticated'
    )::text,
    false
  ) AS item_hm_request_claims
FROM swarm.agent_principals AS p
JOIN swarm.memberships AS m
  ON m.workspace_id = p.workspace_id
 AND m.user_id = p.owner_user_id
 AND m.revoked_at IS NULL
JOIN swarm.workspaces AS w
  ON w.workspace_id = p.workspace_id
 AND w.archived_at IS NULL
WHERE p.revoked_at IS NULL
  AND p.transport = 'local'
  AND p.turn_only = false
  AND NOT EXISTS (
    SELECT 1
    FROM swarm.agent_join_credentials AS c
    WHERE c.registrar_principal_id = p.principal_id
  )
ORDER BY p.created_at, p.principal_id
LIMIT 1
\gset

\if :{?item_hm_principal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'a live local principal is required'; END $$;
\endif

WITH selected AS (
  SELECT principal_id, workspace_id, owner_user_id, transport, turn_only
  FROM swarm.agent_principals
  WHERE principal_id = :'item_hm_principal_id'::uuid
    AND revoked_at IS NULL
), roster AS (
  SELECT p.principal_id, p.transport, p.turn_only
  FROM swarm_read.agent_principals AS p
  WHERE p.principal_id = :'item_hm_principal_id'::uuid
)
SELECT
  (SELECT count(*) = 1 AND bool_and(transport = 'local' AND turn_only = false)
   FROM selected)
  AND (SELECT count(*) = 1 AND bool_and(transport = 'local' AND turn_only = false)
       FROM roster)
  AND swarm.agent_principal_transport(:'item_hm_principal_id'::uuid) = 'local'
  AND NOT EXISTS (
    SELECT 1
    FROM swarm.wake_path_eligible_deliveries AS d
    JOIN swarm.agent_principals AS p
      ON p.workspace_id = d.workspace_id AND p.principal_id = d.principal_id
    WHERE p.turn_only
  ) AS functional_ok
\gset
\if :functional_ok
\echo t
\else
DO $$ BEGIN RAISE EXCEPTION 'HM transport functional proof FAILED'; END $$;
\endif
