/** Content and invitation revocation that rides with MemberRemoved.
 * Lock order, same as household approval and withdrawal: workspace row,
 * then the target membership, then content role and connections.
 * A caller that already holds the workspace stream must lock the workspace
 * row before that stream. Membership is locked here and stamped by the
 * caller afterwards, so the acting member is still live when the audit
 * trigger checks them. */
import type postgres from "npm:postgres@3.4.9";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export async function pendingLinkInvitationIds(
  tx: Sql,
  workspaceId: string,
  userId: string,
): Promise<string[]> {
  const rows = await tx<{ invitation_id: string }[]>`
    SELECT i.invitation_id
    FROM swarm.invitations AS i
    JOIN swarm.users AS u
      ON u.user_id = ${userId}::uuid
     AND i.email IS NOT NULL
     AND lower(i.email) = lower(u.email)
    WHERE i.workspace_id = ${workspaceId}::uuid
      AND i.consumed_at IS NULL
      AND i.revoked_at IS NULL
    ORDER BY i.invitation_id
  `;
  return rows.map((row) => row.invitation_id);
}

export async function revokeRemovedMemberHousehold(
  tx: Sql,
  workspaceId: string,
  userId: string,
  revokedAt: Date,
  actorUserId: string | null,
  commandId: string,
  requestDigest: string,
): Promise<void> {
  if (typeof actorUserId !== "string") {
    throw new Error("MemberRemoved actor is missing");
  }
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
    throw new Error("household removal digest is malformed");
  }
  await tx`
    SELECT
      set_config('cswarm.household_actor', ${actorUserId}, true),
      set_config('cswarm.household_request', ${commandId}, true),
      set_config('cswarm.household_digest', ${requestDigest}, true),
      set_config('cswarm.household_command', 'remove_member', true)
  `;
  // Workspace, then membership, then content role and connections.
  await tx`
    SELECT workspace_id
    FROM swarm.workspaces
    WHERE workspace_id = ${workspaceId}::uuid
    FOR NO KEY UPDATE
  `; // Lock order: lockPrincipalName in command/index.ts.
  await tx`
    SELECT user_id
    FROM swarm.memberships
    WHERE workspace_id = ${workspaceId}::uuid
      AND user_id = ${userId}::uuid
    FOR UPDATE
  `;
  await tx`
    UPDATE swarm.household_member_content_roles
    SET revoked_at = ${revokedAt}
    WHERE workspace_id = ${workspaceId}::uuid
      AND user_id = ${userId}::uuid
      AND revoked_at IS NULL
  `;
  await tx`
    UPDATE swarm.household_content_connections
    SET revoked_at = ${revokedAt}
    WHERE workspace_id = ${workspaceId}::uuid
      AND owner_user_id = ${userId}::uuid
      AND revoked_at IS NULL
  `;
  await tx`
    UPDATE swarm.admin_routine_invitations
    SET revoked_at = ${revokedAt}
    WHERE workspace_id = ${workspaceId}::uuid
      AND recipient_user_id = ${userId}::uuid
      AND accepted_at IS NULL
      AND revoked_at IS NULL
  `;
}
