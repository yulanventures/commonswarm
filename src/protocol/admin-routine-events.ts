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
] as const;
export type AdminRoutineEventType = typeof ADMIN_ROUTINE_EVENT_TYPES[number];
