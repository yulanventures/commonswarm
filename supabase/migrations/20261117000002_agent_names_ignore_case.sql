-- Agent names are unique in a workspace ignoring case ("Lead" and "lead" are one name).
--
-- The edge already compares names with lower() everywhere it checks them (the hosted claim,
-- rename_agent, create_agent_principal, the seat admin's create_agent_seat and the name lock).
-- This index is the database backstop for the rows that carry a per-workspace live name:
-- swarm.hosted_mcp_seats, one row per agent per workspace it holds a seat in.
--
-- swarm.agent_principals gets no such index on purpose. Its workspace_id is only the workspace
-- an agent started in (agent_workspace_memberships carries the others), and
-- create_agent_principal's allow_duplicate_name deliberately creates same-name local agents
-- (site/src/lib/identity-label.ts adds a short id to tell them apart).
--
-- hosted_mcp_seats_live_name (workspace_id, name), from 20261004000010, stays: its release
-- catalog and rollback drill name it exactly. The new index is stricter and sits beside it.
-- No view, function, trigger or grant changes, so no rollback drill has a new dependency.
--
-- Existing collisions stop the migration with a message naming them, and nothing is renamed:
-- each one is a person's live agent, and its owner should choose the new name.

DO $guard$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(format('workspace %s: %s', workspace_id, names), '; ' ORDER BY workspace_id, names)
  INTO collisions
  FROM (
    SELECT workspace_id, string_agg(format('%L', name), ', ' ORDER BY name, seat_id) AS names
    FROM swarm.hosted_mcp_seats
    WHERE revoked_at IS NULL
    GROUP BY workspace_id, lower(name)
    HAVING count(*) > 1
  ) AS taken;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_NAME_CASE_COLLISION: live hosted agents share a name ignoring case. Rename all but one of each group (rename_agent), then migrate again. %', collisions
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

CREATE UNIQUE INDEX hosted_mcp_seats_live_name_ci
  ON swarm.hosted_mcp_seats (workspace_id, lower(name))
  WHERE revoked_at IS NULL;
