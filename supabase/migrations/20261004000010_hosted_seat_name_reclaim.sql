-- Tom D3, plan-hh section 4 option C: same-owner name reclaim creates a new
-- identity while retaining removed seats. Replace permanent per-grant name
-- uniqueness with a workspace-wide backstop for live hosted seats only.
ALTER TABLE swarm.hosted_mcp_seats
  DROP CONSTRAINT hosted_mcp_seats_grant_id_workspace_id_name_key;
CREATE UNIQUE INDEX hosted_mcp_seats_live_name
  ON swarm.hosted_mcp_seats (workspace_id, name) WHERE revoked_at IS NULL;
