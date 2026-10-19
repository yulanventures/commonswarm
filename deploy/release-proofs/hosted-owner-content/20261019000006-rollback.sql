-- Apply this compatibility gate BEFORE restoring the prior edge source.
-- Retain additive restriction/audit state: deleting it could revive a sibling
-- seat with a legacy approval. The old source still requires a manual approval.
-- Deny a whole legacy connection if its operations exceed the explicit ceiling;
-- conservative refusal during rollback is safer than widening that ceiling.
-- Reapply migration 00006 before restoring the new source / human reallow path.
DROP POLICY IF EXISTS hosted_owner_content_rollback_gate ON swarm.household_content_connections;
CREATE POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections
 AS RESTRICTIVE FOR SELECT TO swarm_command USING (
   hosted_grant_id IS NULL OR NOT EXISTS(
     SELECT 1 FROM swarm.household_hosted_content_restrictions r
     WHERE r.grant_id=household_content_connections.hosted_grant_id
       AND r.workspace_id=household_content_connections.workspace_id
       AND NOT household_content_connections.operations <@ r.operations
   )
 );
