/**
 * Shared machine error-reason catalog for CommonSwarm CLI (`src/cli/ax.ts`),
 * local stdio MCP (`src/mcp/errors.ts`), and hosted MCP (`supabase/functions/mcp/tool-errors.ts`).
 *
 * Pure zero-dependency module so Node and Deno import the exact same mapping.
 */

export type AxErrorReason =
  | "profile_session_mismatch"
  | "not_configured"
  | "auth_expired"
  | "access_lost"
  | "channel_not_found"
  | "conversation_not_found"
  | "not_a_member"
  | "invalid_cursor"
  | "invalid_arguments"
  | "rate_limited"
  | "timeout"
  | "request_id_conflict"
  | "command_failed";

/** Canonical mapping from backend/CLI/MCP machine error codes to stable AX reasons. */
export const ERROR_REASON_CATALOG: Readonly<Record<string, AxErrorReason>> = {
  // Invalid cursor
  invalid_cursor: "invalid_cursor",
  cursor_not_found: "invalid_cursor",

  // Session / profile binding mismatch
  profile_other_session: "profile_session_mismatch",
  profile_session_conflict: "profile_session_mismatch",
  host_session_required: "profile_session_mismatch",
  setup_host_session_required: "profile_session_mismatch",
  host_session_invalid: "profile_session_mismatch",

  // Request / command idempotency conflict
  request_id_conflict: "request_id_conflict",
  command_id_conflict: "request_id_conflict",
  file_id_unavailable: "request_id_conflict",
  version_id_unavailable: "request_id_conflict",

  // Channel / conversation / membership
  channel_not_found: "channel_not_found",
  channel_archived: "channel_not_found",
  conversation_not_found: "conversation_not_found",
  conversation_not_member: "not_a_member",

  // Invalid arguments / input validation
  invalid_request: "invalid_arguments",
  check_options_invalid: "invalid_arguments",
  hook_options_invalid: "invalid_arguments",
  receive_command_invalid: "invalid_arguments",
  profile_flags_conflict: "invalid_arguments",
  profile_command_invalid: "invalid_arguments",
  message_id_invalid: "invalid_arguments",
  workspace_id_invalid: "invalid_arguments",
  until_invalid: "invalid_arguments",
  recipient_unknown: "invalid_arguments",
  recipient_ambiguous: "invalid_arguments",
  recipient_invalid: "invalid_arguments",
  request_id_invalid: "invalid_arguments",
  if_version_invalid: "invalid_arguments",
  hosted_seat_name_invalid: "invalid_arguments",
  payload_too_large: "invalid_arguments",
  file_too_large: "invalid_arguments",
  file_type_refused: "invalid_arguments",
  file_text_type_required: "invalid_arguments",
  signal_attachment_limit: "invalid_arguments",
  signal_attachment_duplicate: "invalid_arguments",

  // Rate limits & quota
  rate_limited: "rate_limited",
  quota_exceeded: "rate_limited",
  memory_rate_limited: "rate_limited",
  workspace_quota_exceeded: "rate_limited",
  workspace_file_count: "rate_limited",

  // Transient / timeouts
  check_timeout: "timeout",
  ETIMEDOUT: "timeout",
  temporarily_unavailable: "timeout",
  transient_auth_error: "timeout",

  // Access lost / revoked / forbidden
  forbidden: "access_lost",
  authenticated_identity_mismatch: "access_lost",
  renewal_grant_revoked: "access_lost",
  renewal_lineage_revoked: "access_lost",
  predecessor_revoked: "access_lost",
  renewal_grant_suspended: "access_lost",
  renewal_forbidden: "access_lost",
  hosted_grant_forbidden: "access_lost",
  hosted_grant_unavailable: "access_lost",
  hosted_grant_binding_mismatch: "access_lost",
  credential_kind_forbidden: "access_lost",
  hosted_seat_forbidden: "access_lost",
  hosted_seat_revoked: "access_lost",
  hosted_seat_unavailable: "access_lost",
  hosted_check_batch_forbidden: "access_lost",

  // Auth expired / unauthenticated
  unauthenticated: "auth_expired",
  token_expired: "auth_expired",
  human_session_refresh_failed: "auth_expired",

  // Not configured / missing setup or workspace
  profile_missing: "not_configured",
  profile_credential_missing: "not_configured",
  human_session_missing: "not_configured",
  workspace_not_selected: "not_configured",
  workspace_ambiguous: "not_configured",
  no_workspaces: "not_configured",
};

/** Resolve a stable AX reason from any known CLI/MCP/backend error code. */
export function reasonForErrorCode(code: string | null | undefined): AxErrorReason | null {
  if (typeof code !== "string" || code.length === 0) return null;
  if (Object.hasOwn(ERROR_REASON_CATALOG, code)) {
    return ERROR_REASON_CATALOG[code]!;
  }
  if (code.startsWith("agent_credential_")) {
    return "not_configured";
  }
  return null;
}
