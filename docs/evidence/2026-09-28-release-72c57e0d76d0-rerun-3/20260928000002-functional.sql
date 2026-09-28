-- Read-only functional reconciliation. Internal fixture/race coverage runs in
-- the server suite; a dark production release need not already contain grants.
SELECT
  NOT EXISTS (
    SELECT 1
    FROM swarm.hosted_mcp_seats AS hs
    JOIN swarm.agent_principals AS p ON p.principal_id = hs.principal_id
    WHERE p.workspace_id <> hs.workspace_id
       OR p.owner_user_id <> hs.owner_user_id
       OR p.transport <> 'hosted_mcp'
       OR p.turn_only = false
       OR p.name <> hs.name
  )
  AND NOT EXISTS (
    SELECT 1
    FROM swarm.hosted_mcp_grants AS g
    WHERE g.state = 'active'
      AND EXISTS (
        SELECT required.workspace_id
        FROM unnest(g.selected_workspace_ids) AS required(workspace_id)
        EXCEPT
        SELECT c.workspace_id
        FROM swarm.hosted_mcp_grant_workspaces AS c
        WHERE c.grant_id = g.grant_id AND c.revoked_at IS NULL
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM swarm.hosted_mcp_seats
    WHERE revoked_at IS NULL
    GROUP BY grant_id
    HAVING count(*) > 10
  )
  AND NOT EXISTS (
    SELECT 1
    FROM swarm.hosted_mcp_seat_handles AS h
    JOIN swarm.hosted_mcp_seats AS hs USING (seat_id)
    JOIN swarm.agent_principals AS p ON p.principal_id = hs.principal_id
    WHERE h.grant_id <> hs.grant_id
       OR h.workspace_id <> hs.workspace_id
       OR h.principal_id <> hs.principal_id
       OR (hs.revoked_at IS NULL) <> (h.revoked_at IS NULL)
       OR (hs.revoked_at IS NULL) <> (p.revoked_at IS NULL)
  )
  AS functional_ok
\gset
\if :functional_ok
\echo t
\else
DO $$ BEGIN RAISE EXCEPTION 'HM hosted authority functional proof FAILED'; END $$;
\endif
