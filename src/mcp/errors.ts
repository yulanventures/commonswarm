import { AgentSetupError } from "../cloud/agent-profile.js";
import { AgentCredentialInputError } from "../cloud/agent-credential-input.js";
import { CommandHttpError } from "../cloud/command-client.js";
import { classifySignalReadFailure, followErrorEnvelope, followHttpDetails, LocalCredentialSecretAbsentError, SignalRecipientError } from "../cloud/signals.js";
import { RenewalCredentialCheckError, RenewalOutcomeUnknown, RenewalReauthorisationRequired, RenewalRefused, RenewalRetryError, RenewalRevoked, RenewalSuperseded, RenewalSuspended, RenewalUnsupported } from "../cloud/renewal.js";
import { SessionContextError } from "../cloud/session-context.js";
import { AGENT_SESSION_PROOF_REFUSAL_CODES } from "../cloud/session-wire.js";
import { FileLockTimeoutError, StoredRecordOversizedError } from "../cloud/storage.js";

type Action = "retry the same call" | "fix the named argument" | "a person must restore this agent's access outside this session" | "stop and tell the operator" | "stop and keep the same request id" | "check the named arguments; if they are right, a person may need to restore this agent's access" | "check the arguments; if the problem stays, ask a person" | "restart this MCP server with the current host session" | "wait, then retry the same call with the same request_id";
type Sentence = { message: string; next_step: Action };
const RETRY: Action = "retry the same call";
const FIX: Action = "fix the named argument";
const PERSON: Action = "a person must restore this agent's access outside this session";
const STOP_OPERATOR: Action = "stop and tell the operator";
const STOP: Action = "stop and keep the same request id";
const CHECK_ACCESS: Action = "check the named arguments; if they are right, a person may need to restore this agent's access";
const CHECK_ARGUMENTS: Action = "check the arguments; if the problem stays, ask a person";
const RESTART_SESSION: Action = "restart this MCP server with the current host session";
const WAIT_AND_RETRY: Action = "wait, then retry the same call with the same request_id";
const entry = (message: string, next_step: Action): Sentence => ({ message, next_step });

/** The only model-visible error prose. No producer message is copied here. */
export const MCP_ERROR_SENTENCES: Readonly<Record<string, Sentence>> = {
  profile_path_invalid: entry("The profile location is invalid.", PERSON),
  agent_credential_invalid_json: entry("The saved agent credential is damaged.", PERSON),
  agent_credential_not_object: entry("The saved agent credential is damaged.", PERSON),
  agent_credential_missing_agent_token: entry("The saved agent credential is incomplete.", PERSON),
  agent_credential_invalid_agent_token: entry("The saved agent credential is invalid.", PERSON),
  agent_credential_fields_invalid: entry("The saved agent credential is damaged.", PERSON),
  profile_symlink: entry("The profile location is unsafe.", PERSON),
  profile_inside_repository: entry("The profile location is unsafe.", PERSON),
  profile_missing: entry("The profile is missing.", PERSON),
  profile_invalid: entry("The profile is damaged.", PERSON),
  profile_credential_missing: entry("The agent credential is missing.", PERSON),
  profile_identity_mismatch: entry("The credential belongs to another agent.", PERSON),
  profile_session_conflict: entry("The host session does not match this agent.", PERSON),
  profile_other_session: entry("This profile belongs to another session. Stop and tell the operator.", STOP_OPERATOR),
  profile_conflict: entry("The profile belongs to another agent or workspace.", PERSON),
  connection_invalid: entry("The connection is invalid.", PERSON),
  connection_target_invalid: entry("The connection target is invalid.", PERSON),
  connection_identity_mismatch: entry("The connection names another agent.", PERSON),
  authenticated_identity_mismatch: entry("The service did not confirm this agent.", PERSON),
  check_state_invalid: entry("The saved message state is damaged.", PERSON),
  check_paging_unsupported: entry("The service cannot page messages safely.", PERSON),
  check_recipient_mismatch: entry("The service returned a message for another recipient.", RETRY),
  check_page_order_invalid: entry("The message page is out of order.", RETRY),
  check_timeout: entry("The message check timed out; the inbox state is unknown.", RETRY),
  message_id_invalid: entry("The message_id argument is invalid.", FIX),
  message_not_cached: entry("That message is absent from the local cache.", FIX),
  host_session_required: entry("This agent requires its current host session.", RESTART_SESSION),
  setup_host_session_required: entry("Setup needs this session's ID or an intentional manual choice.", PERSON),
  host_session_invalid: entry("The host session is invalid.", PERSON),
  until_invalid: entry("The until argument is invalid.", FIX),
  recipient_unknown: entry("The to argument does not name a live recipient.", FIX),
  recipient_ambiguous: entry("The to argument names more than one recipient; use a unique identifier.", FIX),
  recipient_invalid: entry("The to argument is invalid.", FIX),
  command_id_conflict: entry("This request id was used for different arguments.", STOP),
  signal_refused: entry("The service refused this signal.", PERSON),
  // The post_signal edge uses this same bare code for an ineligible reply,
  // an expired reference, an inactive recipient, and the scope gate.
  forbidden: entry("The service refused this post. Possible causes: a reply to your own ask; a reply to a signal that has expired or is not addressed to this agent; a recipient that is no longer active; a change to this agent's access.", CHECK_ACCESS),
  renewal_forbidden: entry("The service refused this agent's credential renewal.", PERSON),
  channel_not_found: entry("The channel argument names no channel in this workspace.", FIX),
  channel_archived: entry("The channel argument names an archived channel.", FIX),
  invalid_request: entry("The service did not accept the named arguments.", FIX),
  payload_too_large: entry("The body or about argument is too large.", FIX),
  rate_limited: entry("The signal rate limit for this agent or its workspace was reached; it resets within an hour.", WAIT_AND_RETRY),
  ...Object.fromEntries(AGENT_SESSION_PROOF_REFUSAL_CODES.map(code =>
    [code, entry("The current host session was refused by the service.", RESTART_SESSION)])),
  unauthenticated: entry("The service refused this agent's credential.", PERSON),
  upgrade_required: entry("This client must be upgraded before access can resume.", PERSON),
  horizon_reached: entry("This agent reached its renewal horizon.", PERSON),
  grant_exhausted: entry("This agent exhausted its renewal grant.", PERSON),
  renewal_lineage_revoked: entry("This agent's renewal lineage was revoked.", PERSON),
  renewal_grant_revoked: entry("This agent's renewal grant was revoked.", PERSON),
  predecessor_revoked: entry("This agent's prior credential was revoked.", PERSON),
  predecessor_not_found: entry("This agent's prior credential is unavailable.", PERSON),
  predecessor_not_owned: entry("This agent's prior credential is unavailable.", PERSON),
  predecessor_expired: entry("This agent's credential expired.", PERSON),
  predecessor_expired_local: entry("This agent's credential expired.", PERSON),
  predecessor_superseded: entry("Another process renewed this agent's credential.", RETRY),
  successor_not_recoverable: entry("The renewed credential cannot be recovered.", PERSON),
  predecessor_not_presented: entry("The prior credential was not presented.", PERSON),
  predecessor_pending_first_use: entry("The prior credential is still pending first use.", RETRY),
  renewal_requires_agent_credential: entry("Renewal requires an agent credential.", PERSON),
  renewal_binding_incomplete: entry("The renewal binding is incomplete.", PERSON),
  renewal_grant_not_found: entry("The renewal grant is unavailable.", PERSON),
  renewal_grant_mismatch: entry("The renewal grant does not match this agent.", PERSON),
  renewal_horizon_reached: entry("This agent reached its renewal horizon.", PERSON),
  renewal_horizon_invalid: entry("The renewal horizon is invalid.", PERSON),
  renewal_successors_exhausted: entry("This agent exhausted its renewal grant.", PERSON),
  renewal_scope_widened: entry("The renewed credential would exceed its prior scope.", PERSON),
  renewal_idle_suspended: entry("This agent's renewal is suspended.", PERSON),
  renewal_grant_suspended: entry("This agent's renewal grant is suspended.", PERSON),
  renewal_revoked: entry("This agent's renewal was revoked.", PERSON),
  renewal_suspended: entry("This agent's renewal is suspended.", PERSON),
  renewal_device_unavailable: entry("This agent's renewal device is unavailable.", PERSON),
  renewal_device_mismatch: entry("This agent's renewal device does not match.", PERSON),
  renewal_unsupported: entry("This agent cannot renew its credential.", PERSON),
  renewal_outcome_unknown: entry("The renewal outcome is unknown.", RETRY),
  renewal_superseded: entry("Another process renewed this credential.", RETRY),
  renewal_retry: entry("The credential renewal is retrying.", RETRY),
  renewal_credential_check: entry("The service could not verify this credential.", PERSON),
  malformed_successor: entry("The service returned a malformed renewed credential.", RETRY),
  incomplete_successor: entry("The service returned an incomplete renewed credential.", RETRY),
  successor_expiry_missing: entry("The renewed credential has no expiry.", RETRY),
  successor_ttl_too_long: entry("The renewed credential lifetime exceeds the safe limit.", RETRY),
  malformed_wake: entry("The renewed credential has an invalid wake hint.", RETRY),
  read_refused: entry("The service refused this read.", PERSON),
  read_failed: entry("The service could not complete this read.", RETRY),
  read_malformed: entry("The service returned an invalid read response.", RETRY),
  read_transport: entry("The read could not reach the service.", RETRY),
  read_timeout: entry("The read timed out.", RETRY),
  session_context_invalid: entry("The host session context is invalid.", PERSON),
  file_lock_timeout: entry("The local credential store is busy.", RETRY),
  stored_record_oversized: entry("The saved credential state is too large.", PERSON),
  local_credential_absent: entry("The local credential is missing.", PERSON),
  mcp_call_failed: entry("The tool could not complete this call.", RETRY),
};

export function mapMcpError(error: unknown): { code: string; message: string; next_step: string; status?: number } {
  const readHttp = followHttpDetails(error);
  const readCode = followErrorEnvelope(error).error;
  const readFailure = classifySignalReadFailure(error);
  const code = error instanceof AgentSetupError ? error.code
    : error instanceof AgentCredentialInputError ? error.code
    : error instanceof CommandHttpError ? error.code ?? `http_${error.status}`
    : error instanceof SignalRecipientError ? error.code
    : readHttp ? (readCode && (AGENT_SESSION_PROOF_REFUSAL_CODES as readonly string[]).includes(readCode) ? readCode
      : [401, 403, 426].includes(readHttp.status) ? "read_refused"
      : readCode && Object.hasOwn(MCP_ERROR_SENTENCES, readCode) ? readCode : "read_failed")
    : error instanceof RenewalReauthorisationRequired ? error.reason
    : error instanceof RenewalRevoked && error.code === "forbidden" ? "renewal_forbidden"
    : error instanceof RenewalRefused || error instanceof RenewalRetryError || error instanceof RenewalRevoked || error instanceof RenewalSuspended ? error.code
    : error instanceof RenewalUnsupported ? "renewal_unsupported"
    : error instanceof RenewalSuperseded ? "renewal_superseded"
    : error instanceof RenewalOutcomeUnknown ? "renewal_outcome_unknown"
    : error instanceof RenewalCredentialCheckError ? "renewal_credential_check"
    : readFailure.code === "malformed_response" ? "read_malformed"
    : readFailure.code === "body_timeout" ? "read_timeout"
    : ["no_response", "host_ports_exhausted", "aborted"].includes(readFailure.code) ? "read_transport"
    : error instanceof SessionContextError ? "session_context_invalid"
    : error instanceof FileLockTimeoutError ? "file_lock_timeout"
    : error instanceof StoredRecordOversizedError ? "stored_record_oversized"
    : error instanceof LocalCredentialSecretAbsentError ? "local_credential_absent"
    : "mcp_call_failed";
  const safeCode = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code) && !code.includes("--") ? code : "mcp_call_failed";
  const sentence = Object.hasOwn(MCP_ERROR_SENTENCES, safeCode)
    ? MCP_ERROR_SENTENCES[safeCode]!
    : entry(`The service returned ${safeCode}${error instanceof CommandHttpError ? ` with status ${error.status}` : ""}.`,
      error instanceof CommandHttpError && error.status >= 500 ? RETRY : error instanceof CommandHttpError && error.status >= 400 && error.status < 500 ? CHECK_ARGUMENTS : PERSON);
  const status = error instanceof CommandHttpError ? error.status : readHttp?.status ?? (error instanceof RenewalRefused || error instanceof RenewalCredentialCheckError ? error.status : undefined);
  return { code: safeCode, ...sentence, ...(status !== undefined && status >= 400 ? { status } : {}) };
}
