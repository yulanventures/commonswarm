-- Run in one transaction. Duplicate historical same-grant names make this
-- constraint fail; the transaction then retains the forward schema unchanged.
ALTER TABLE swarm.hosted_mcp_seats
  ADD CONSTRAINT hosted_mcp_seats_grant_id_workspace_id_name_key
  UNIQUE (grant_id, workspace_id, name);
DROP INDEX swarm.hosted_mcp_seats_live_name;
