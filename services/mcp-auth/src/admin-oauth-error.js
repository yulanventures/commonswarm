// Internal refusal codes remain available for diagnostics. OAuth boundaries
// expose only protocol errors, never database messages or staged credentials.
const OAUTH_CODES = Object.freeze({
  invalid_grant: "invalid_grant",
  invalid_scope: "invalid_scope",
  unauthorized_client: "unauthorized_client",
  invalid_target: "invalid_target",
  invalid_request: "invalid_request",
  invalid_manifest: "invalid_request",
  consent_receipt_invalid: "invalid_request",
  authentication_required: "access_denied",
  fresh_authentication_required: "access_denied",
  origin_forbidden: "access_denied",
  workspace_forbidden: "access_denied",
  dpop_required: "invalid_dpop_proof",
  admin_issuance_disabled: "temporarily_unavailable",
  admin_migration_evidence_incomplete: "temporarily_unavailable",
});

export class AdminOAuthError extends Error {
  constructor(code, status) {
    const oauth = Object.hasOwn(OAUTH_CODES, code) ? OAUTH_CODES[code]
      : status >= 400 && status < 500 ? "invalid_request" : "temporarily_unavailable";
    super(oauth);
    this.code = code;
    this.error = oauth;
    this.status = this.statusCode = ((status >= 400 && status < 500) || status === 503) ? status : 503;
    this.expose = true;
  }
}
