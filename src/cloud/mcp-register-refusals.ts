/** Generated from the h0 register and command handlers. Run node scripts/generate-mcp-register-refusals.mjs. */
export const REGISTER_REFUSALS: Readonly<Record<string, number>> = {
  "command_id_conflict": 409,
  "forbidden": 403,
  "invalid_request": 400,
  "join_credential_seat_cap_reached": 409,
  "method_not_allowed": 405,
  "not_found": 404,
  "payload_too_large": 413,
  "principal_limit_reached": 403,
  "registration_seat_revoked": 409,
  "registration_token_already_used": 409,
  "upgrade_required": 426
};
export const REGISTER_NO_SEAT_THIS_ATTEMPT: Readonly<Record<string, number>> = {
  "forbidden": 403,
  "invalid_request": 400,
  "method_not_allowed": 405,
  "not_found": 404,
  "payload_too_large": 413,
  "principal_limit_reached": 403,
  "upgrade_required": 426
};
export const REGISTER_EXISTING_SEAT_REFUSALS: Readonly<Record<string, number>> = {
  "join_credential_seat_cap_reached": 409,
  "registration_seat_revoked": 409,
  "registration_token_already_used": 409
};
