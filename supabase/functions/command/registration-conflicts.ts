/** The command edge's 409 registration responses. H0's document refers callers to these messages. */
export const REGISTRATION_TOKEN_ALREADY_USED = {
  status: 409,
  code: "registration_token_already_used",
  message: "Revoke that seat and register again.",
} as const;

export const REGISTRATION_SEAT_REVOKED = {
  status: 409,
  code: "registration_seat_revoked",
  message: "This seat was revoked. Register again with a new attempt.",
} as const;
