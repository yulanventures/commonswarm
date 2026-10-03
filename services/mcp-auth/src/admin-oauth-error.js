import { errors } from "oidc-provider";

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
  invalid_dpop_proof: "invalid_dpop_proof",
  use_dpop_nonce: "use_dpop_nonce",
  temporarily_unavailable: "temporarily_unavailable",
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

// All HTTP writers use this boundary. Only owned admin errors and actual
// provider error instances may supply public protocol fields; error_detail,
// causes, internal codes and arbitrary Error properties remain private.
export function oauthErrorResponse(error) {
  if (error instanceof AdminOAuthError) {
    return { status: error.statusCode, body: { error: error.error } };
  }
  if (error instanceof errors.OIDCProviderError) {
    return { status: error.statusCode, body: error.expose ? {
      error: error.error,
      ...(error.error_description !== undefined ? { error_description: error.error_description } : {}),
      ...(error.scope !== undefined ? { scope: error.scope } : {}),
    } : { error: "server_error", error_description: "oops! something went wrong" } };
  }
  return null;
}
