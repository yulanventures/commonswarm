-- swarm_command deliberately has INSERT, not SELECT, on the raw event log.
-- This owner-backed view exposes only reducer-complete delegated routine facts;
-- ordinary events (which can contain invitation hashes or content) stay private.
CREATE VIEW swarm.admin_routine_workspace_events WITH (security_barrier = true) AS
SELECT e.* FROM swarm.events e
WHERE e.grant_id IS NOT NULL AND e.type IN (
  'AdminWorkspaceCreated', 'AdminSeatCreated', 'AdminSeatProvisioned',
  'AdminSeatRenewed', 'AdminSeatCredentialReplaced', 'AdminSeatRevoked',
  'AdminSeatCredentialRevoked', 'AdminMemberInvited',
  'AdminAgentInvitationIssued', 'AdminInvitationRevoked'
);
ALTER VIEW swarm.admin_routine_workspace_events OWNER TO swarm_admin;
REVOKE ALL ON swarm.admin_routine_workspace_events FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT ON swarm.admin_routine_workspace_events TO swarm_command;
