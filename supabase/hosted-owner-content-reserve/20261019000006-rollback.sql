-- Apply this compatibility gate BEFORE restoring the prior edge source.
-- Retain additive restriction/audit state: deleting it could revive a sibling
-- seat with a legacy approval. The old source still requires a manual approval.
-- Gate only live, unexpired approvals that the old source could honor. Keep
-- revoked/expired denials visible to the new source during roll forward.
-- Deny a live legacy connection if its operations exceed the explicit ceiling;
-- conservative refusal during rollback is safer than widening that ceiling.
-- Roll forward: activate the reviewed new source FIRST, verify its identity,
-- then explicitly DROP this gate in the operator transaction. Retain both
-- migration ledgers and all restriction, consent, approval and audit rows.
DROP POLICY IF EXISTS hosted_owner_content_rollback_gate ON swarm.household_content_connections;
CREATE POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections
 AS RESTRICTIVE FOR SELECT TO swarm_command USING (
   hosted_grant_id IS NULL OR revoked_at IS NOT NULL
   OR (expires_at IS NOT NULL AND expires_at<=clock_timestamp()) OR NOT EXISTS(
     SELECT 1 FROM swarm.household_hosted_content_restrictions r
     WHERE r.grant_id=household_content_connections.hosted_grant_id
       AND r.workspace_id=household_content_connections.workspace_id
       AND NOT ((EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=r.grant_id
          AND cs.workspace_id=r.workspace_id AND cs.principal_id=r.principal_id AND cs.owner_user_id=r.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=r.grant_id AND ls.workspace_id=r.workspace_id
            AND ls.principal_id=r.principal_id AND ls.owner_user_id=r.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)) AND EXISTS(
         SELECT 1 FROM swarm.household_hosted_content_restrictions marker
         CROSS JOIN LATERAL jsonb_array_elements(marker.closed_target_replacements) entry
         WHERE marker.grant_id=r.grant_id AND marker.workspace_id=r.workspace_id
           AND marker.origin='human_allow' AND entry=jsonb_build_object('kind','restriction','principal_id',r.principal_id,'operations',r.operations,'origin',r.origin,'changed_at',r.changed_at,'changed_by',r.changed_by)))
       AND NOT household_content_connections.operations <@ r.operations
   )
 );
