-- Undo only integration grants and provisioning triggers; retain consent and audit rows.
DROP TRIGGER IF EXISTS household_permission_audit ON swarm.household_workspace_boundaries;
REVOKE INSERT ON swarm.household_workspace_boundaries FROM swarm_command;
DROP TRIGGER IF EXISTS household_permission_audit ON swarm.household_member_content_roles;
REVOKE INSERT ON swarm.household_member_content_roles FROM swarm_command;
REVOKE UPDATE (content_role, content_consent_id, confirmed_at, revoked_at) ON swarm.household_member_content_roles FROM swarm_command;
DROP TRIGGER IF EXISTS household_permission_audit ON swarm.household_content_connections;
REVOKE INSERT ON swarm.household_content_connections FROM swarm_command;
REVOKE UPDATE (operations, consent_receipt_id, expires_at, revoked_at) ON swarm.household_content_connections FROM swarm_command;
DROP FUNCTION IF EXISTS swarm.audit_household_permission();
