import type { CommandResult } from "../command/contract.d.ts";
import type { HostedToolName } from "./tools.ts";

const ACCESS_MESSAGE = "Workspace access is missing or no longer authorized. Ask a workspace admin to restore your membership, then reconnect and approve this workspace.";
const SEAT_MESSAGE = "This seat is unavailable to your connection. Call claim_seat and use its returned handle; if access is still denied, ask a workspace admin to restore your membership and reconnect.";
export const TOOL_FAILURE_MESSAGE = "Something failed on our side; retry with the same request_id; if it repeats, contact support@commonswarm.com";

// Only codes returned by the hosted claim/check/read/post_signal paths belong here.
// Never forward backend prose, arbitrary codes, or exception messages to a client.
const MESSAGES = {
  hosted_grant_forbidden: ACCESS_MESSAGE,
  hosted_grant_unavailable: ACCESS_MESSAGE,
  hosted_grant_binding_mismatch: ACCESS_MESSAGE,
  forbidden: ACCESS_MESSAGE,
  credential_kind_forbidden: "This connection cannot perform this operation. Reconnect your CommonSwarm account and approve workspace access.",
  unauthenticated: "Your connection is no longer authenticated. Reconnect your CommonSwarm account and retry.",
  hosted_seat_forbidden: SEAT_MESSAGE,
  hosted_seat_revoked: "This seat was removed and cannot be restored. Call claim_seat with a new request_id to get a new seat; its owner may reuse the same name.",
  hosted_seat_name_invalid: "The seat name is invalid. Use 1 to 80 characters with no surrounding spaces or control characters.",
  hosted_seat_name_taken: "That seat name is taken in this workspace. Call claim_seat with another name and a new request_id.",
  hosted_seat_limit_reached: "This connection has reached its seat limit. Reuse a seat returned by claim_seat, or ask a workspace admin to revoke an unused seat.",
  principal_limit_reached: "This workspace has reached its agent limit. Reuse an existing seat, or ask a workspace admin to revoke an unused agent.",
  hosted_check_batch_forbidden: "This inbox batch is unavailable to this seat. Call check without ack, then acknowledge only the batch_id returned for the same seat.",
  command_id_conflict: "This request_id was already used for different arguments. Retry the original request unchanged, or use a new request_id for a different request.",
  invalid_request: "The request arguments were rejected. Check the tool's input schema and correct the arguments before retrying.",
  payload_too_large: "The request is too large. Shorten body to at most 8000 characters and retry with a new request_id.",
  upgrade_required: "This hosted connection needs a service update. Contact support@commonswarm.com, then retry with the same request_id.",
  identity_resume_unavailable: "This connection cannot resume that identity. Reconnect and approve workspace access.",
  context_expired: "This chat identity expired. Start a new identity to continue; shared work is still here.",
  context_closed: "This chat identity is closed. Start a new identity to continue; shared work is still here.",
  workspace_unavailable: "No authorized home workspace is available. Select an authorized workspace or reconnect and approve workspace access.",
  workspace_mismatch: "This handle belongs to a different workspace. Continue in its workspace or start a new identity in the selected workspace.",
  session_capacity_reached: "The active chat limit or creation budget has been reached. Wait before retrying with the same request_id. Closing an unused context frees active capacity; the creation budget resets over time.",
  name_allocation_busy: "A separate name could not be allocated yet. Retry with the same request_id.",
  rate_limited: "Too many requests. Retry after the current rate-limit window resets; reuse the same request_id.",
} as const;

export interface ToolError {
  error: string;
  message: string;
  can_start_new: boolean;
  retry_after_seconds?: number;
}
// Bound externally supplied delay metadata; never forward arbitrary backend values.
const MAX_RETRY_SECONDS = 86_400;
function boundedRetry(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(value))) : undefined;
}
const NEW_ALLOWED = new Set<string>([
  "context_expired", "context_closed", "hosted_seat_revoked", "hosted_seat_name_invalid", "hosted_seat_name_taken", "workspace_mismatch",
]);

type ToolErrorCode = keyof typeof MESSAGES;
function knownCode(value: unknown): value is ToolErrorCode {
  return typeof value === "string" && Object.hasOwn(MESSAGES, value);
}

/** Carries a stable backend code, never an exception-message classification. */
export class HostedToolFailure extends Error {
  readonly code: ToolErrorCode | "tool_failed";
  readonly retryAt: string | null;
  readonly canStartNew: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: unknown, resetsAt?: unknown, recovery: { canStartNew?: unknown; retryAfterSeconds?: unknown } = {}) {
    super("Hosted tool failed");
    this.name = "HostedToolFailure";
    this.code = knownCode(code) ? code : "tool_failed";
    // Rate metadata is the only backend value allowed into failure copy. Accept
    // an ISO timestamp and canonicalize it so arbitrary strings cannot leak.
    const millis = typeof resetsAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(resetsAt)
      ? Date.parse(resetsAt) : NaN;
    // identity_resume_unavailable covers authorization and identity-only denials.
    // Only the authority caller can attest that a valid grant may start new.
    this.canStartNew = NEW_ALLOWED.has(this.code) ||
      (this.code === "identity_resume_unavailable" && recovery.canStartNew === true);
    this.retryAfterSeconds = ["rate_limited", "session_capacity_reached", "name_allocation_busy"].includes(this.code)
      ? boundedRetry(recovery.retryAfterSeconds) : undefined;
    this.retryAt = this.code === "rate_limited" && Number.isFinite(millis)
      ? new Date(millis).toISOString() : null;
  }
}

export function hostedToolError(error: unknown, tool: HostedToolName): ToolError {
  if (!(error instanceof HostedToolFailure) || error.code === "tool_failed") {
    return { error: "tool_failed", message: TOOL_FAILURE_MESSAGE, can_start_new: false };
  }
  const code = error.code;
  const message = code === "identity_resume_unavailable" && error.canStartNew
    ? "This connection cannot resume that identity. I can work as a separate chat agent."
    : code === "rate_limited" && error.retryAt !== null
    ? `Too many requests. Retry at ${error.retryAt}; reuse the same request_id.`
    : code === "forbidden" && tool === "reply"
    // The command intentionally combines missing/expired/unaddressed signals
    // and authorization denials. Do not turn this into an existence oracle.
    ? "The signal is unavailable for this seat, or reply access is missing. Check signal_id in check output and reply from the addressed seat; ask a workspace admin if access is missing."
    : code === "forbidden" && (tool === "ask" || tool === "note")
    ? "Workspace access or recipient access is missing. Ask a workspace admin to restore access, reconnect, and use members to select current recipients."
    : MESSAGES[code];
  const retry = error.retryAfterSeconds ?? (error.retryAt === null ? undefined : boundedRetry((Date.parse(error.retryAt) - Date.now()) / 1000));
  return { error: code, message, can_start_new: error.canStartNew,
    ...(retry === undefined ? {} : { retry_after_seconds: retry }),
  };
}

export function commandOutput(result: CommandResult): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    throw new HostedToolFailure(result.body.error, result.body.resets_at, {
      canStartNew: result.body.can_start_new, retryAfterSeconds: result.body.retry_after_seconds,
    });
  }
  const signal = result.body.signal;
  if (signal !== null && typeof signal === "object" && !Array.isArray(signal)) {
    const row = signal as Record<string, unknown>;
    return {
      signal_id: row.id,
      kind: row.kind,
      created_at: row.created_at,
      in_reply_to: row.in_reply_to ?? null,
    };
  }
  if (typeof result.body.handle === "string") {
    // Preserve legacy fields and every context contract field, without leaking
    // command internals or manufacturing server-owned values during migration.
    const fields = [
      "grant_id", "workspace_id", "workspace", "seat_id", "principal_id", "context_id",
      "seat", "handle", "name", "display_name", "disambiguator", "assurance", "lifetime", "kind",
      "created_at", "last_business_at", "idle_expires_at", "absolute_expires_at",
      "outcome", "original_outcome", "name_adjusted", "adjustment_reason", "context_status", "transport", "turn_only",
    ];
    return Object.fromEntries(fields.filter(key => Object.hasOwn(result.body, key)).map(key => [key, result.body[key]]));
  }
  return result.body;
}

export function readOutput(result: CommandResult): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    throw new HostedToolFailure(result.body.error, result.body.resets_at, {
      canStartNew: result.body.can_start_new, retryAfterSeconds: result.body.retry_after_seconds,
    });
  }
  return result.body;
}
