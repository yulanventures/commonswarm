export const ADMIN_ROUTINE_EVENT_TYPES = [
  "AdminWorkspaceCreated",
  "AdminSeatCreated",
  "AdminSeatProvisioned",
  "AdminSeatRenewed",
  "AdminSeatCredentialReplaced",
  "AdminSeatRevoked",
  "AdminSeatCredentialRevoked",
  "AdminMemberInvited",
  "AdminAgentInvitationIssued",
  "AdminInvitationRevoked",
  "AdminMemberInvitationAccepted",
] as const;
export type AdminRoutineEventType = typeof ADMIN_ROUTINE_EVENT_TYPES[number];
