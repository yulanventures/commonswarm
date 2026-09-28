function verified(identity) {
  if (!identity?.identityVerified || typeof identity.userId !== "string") {
    const error = new Error("verified human identity required");
    error.code = "authentication_required";
    throw error;
  }
  return identity;
}

/**
 * Owner management stays behind the same trusted human-only boundary as consent.
 * The browser never supplies an owner id; readers and commands receive the verified
 * session identity separately and enforce owner scoping at the lane-2 boundary.
 */
export function createConnectionManager({ readConnections, consentOrchestrator }) {
  if (typeof readConnections !== "function") throw new TypeError("connection reader is required");
  return {
    async list(identity) {
      return await readConnections(verified(identity));
    },
    async revokeGrant({ grantId, homeWorkspaceId }, identity) {
      const actor = verified(identity);
      return await consentOrchestrator.revoke({
        interactionRef: `manage-grant:${grantId}`,
        grantId,
        homeWorkspaceId,
        identity: actor,
      });
    },
    async revokeSeat({ grantId, workspaceId, seatId }, identity) {
      const actor = verified(identity);
      return await consentOrchestrator.revokeSeat({
        interactionRef: `manage-seat:${seatId}`,
        grantId,
        workspaceId,
        seatId,
        identity: actor,
      });
    },
  };
}
