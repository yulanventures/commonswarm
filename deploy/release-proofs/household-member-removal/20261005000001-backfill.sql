DO $household_member_removal_backfill$
DECLARE
 pending_at timestamptz := statement_timestamp();
BEGIN
 -- Take every workspace lock first, then memberships, then content, then invites.
 -- Each class has a total key order; no UPDATE can acquire a row out of order.
 PERFORM w.workspace_id FROM swarm.workspaces w
 WHERE EXISTS (SELECT 1 FROM swarm.memberships m
  WHERE m.workspace_id=w.workspace_id AND m.revoked_at IS NOT NULL)
 ORDER BY w.workspace_id FOR UPDATE OF w;

 PERFORM m.workspace_id, m.user_id FROM swarm.memberships m
 WHERE m.revoked_at IS NOT NULL
 ORDER BY m.workspace_id, m.user_id FOR UPDATE OF m;

 PERFORM r.workspace_id, r.user_id FROM swarm.household_member_content_roles r
 JOIN swarm.memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.user_id
 WHERE m.revoked_at IS NOT NULL AND r.revoked_at IS NULL
 ORDER BY r.workspace_id, r.user_id FOR UPDATE OF r;

 PERFORM c.connection_id FROM swarm.household_content_connections c
 JOIN swarm.memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
 WHERE m.revoked_at IS NOT NULL AND c.revoked_at IS NULL
 ORDER BY c.workspace_id, c.connection_id, c.grant_id, c.principal_id FOR UPDATE OF c;

 -- The live helper revokes all unaccepted delegated invitations, even expired ones.
 PERFORM i.invitation_id FROM swarm.admin_routine_invitations i
 JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=i.recipient_user_id
 WHERE m.revoked_at IS NOT NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at
 ORDER BY i.workspace_id, i.invitation_id FOR UPDATE OF i;

 -- Link recipients use the same case-insensitive stored email match as the helper.
 -- Only still-pending links need repair; expired/consumed/revoked links stay intact.
 PERFORM i.invitation_id FROM swarm.invitations i
 JOIN swarm.users u ON i.email IS NOT NULL AND lower(i.email)=lower(u.email)
 JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=u.user_id
 WHERE m.revoked_at IS NOT NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at AND i.expires_at>pending_at
 ORDER BY i.workspace_id, i.invitation_id FOR UPDATE OF i;

 UPDATE swarm.household_member_content_roles r SET revoked_at=m.revoked_at
 FROM swarm.memberships m
 WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id
  AND m.revoked_at IS NOT NULL AND r.revoked_at IS NULL;

 -- Deliberately includes expired connections, as does live member removal.
 UPDATE swarm.household_content_connections c SET revoked_at=m.revoked_at
 FROM swarm.memberships m
 WHERE m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
  AND m.revoked_at IS NOT NULL AND c.revoked_at IS NULL;

 UPDATE swarm.admin_routine_invitations i SET revoked_at=m.revoked_at
 FROM swarm.memberships m
 WHERE m.workspace_id=i.workspace_id AND m.user_id=i.recipient_user_id
  AND m.revoked_at IS NOT NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at;

 UPDATE swarm.invitations i SET revoked_at=m.revoked_at
 FROM swarm.memberships m JOIN swarm.users u ON u.user_id=m.user_id
 WHERE m.workspace_id=i.workspace_id AND i.email IS NOT NULL AND lower(i.email)=lower(u.email)
  AND m.revoked_at IS NOT NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at AND i.expires_at>pending_at;
END;
$household_member_removal_backfill$;
