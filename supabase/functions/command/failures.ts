/** Durable, secret-minimising records for command failures that escape a transaction. */

/**
 * End-to-end request budget (ms) for command/admin failure handling.
 * Client requests time out at 30 s (src/cloud/command-client.ts, files.ts, delivery.ts);
 * server-side edge-runtime idle timeout is 150 s (deploy/edge-runtime/main/router.ts) and
 * Caddy response_header_timeout is 165 s. Leaving 2 s headroom below the 30 s client timeout
 * gives a 28 s request budget.
 */
export const COMMAND_REQUEST_BUDGET_MS = 28_000;
/** Maximum time (ms) any best-effort diagnostic/audit persistence may wait after a failure. */
export const FAILURE_PERSISTENCE_MAX_MS = 2_500;

export function remainingFailureBudgetMs(
  requestDeadlineAt: number,
  maxPersistenceMs: number = FAILURE_PERSISTENCE_MAX_MS,
): number {
  const remaining = requestDeadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(remaining, maxPersistenceMs);
}

/**
 * Run a best-effort async failure write within a bounded time budget.
 * When the budget is exhausted (<= 0 ms) or expires before settlement, the caller is released
 * immediately and any late settlement or rejection from the abandoned operation is swallowed.
 */
export async function runWithinFailureBudget<T>(
  budgetMs: number,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || signal?.aborted) {
    return { ok: false, error: new Error("failure persistence budget exhausted") };
  }

  let opPromise: Promise<T>;
  try {
    opPromise = Promise.resolve(operation());
  } catch (syncError) {
    return { ok: false, error: syncError };
  }
  opPromise.catch(() => {});

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  try {
    const value = await new Promise<T>((resolve, reject) => {
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        reject(reason);
      };
      timer = setTimeout(() => fail(new Error("failure persistence budget exceeded")), budgetMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
      if (signal) {
        onAbort = () => fail(new Error("failure persistence aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      opPromise.then(
        (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        },
        (err) => fail(err),
      );
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal && onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export type CommandFailureReason =
  | "internal_error"
  | "lock_timeout"
  | "test_rollback";

export interface DurableCommandFailure {
  command_kind: string;
  reason: CommandFailureReason;
  db_code: string | null;
  detail: string;
  request_id: string;
}

export interface CommandFailureResult {
  status: 500 | 503;
  body: { error: "internal_error" | "temporarily_unavailable" };
}

export type InsertCommandFailure = (
  failure: DurableCommandFailure,
) => Promise<void>;

const FAILURE_UNSAFE_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

function boundedSafeText(value: string, maximum: number): string {
  return value.replace(FAILURE_UNSAFE_GLOBAL_RE, "").slice(0, maximum);
}

/** Read only a stable database/library code from an unknown thrown value. */
export function dbCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Keep the existing bounded error presentation without copying request data. */
export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return boundedSafeText(`${error.name}: ${error.message}`, 512);
  }
  return "unknown error";
}

/** Admin diagnostics must never echo SQL values, bearer material or URLs.
 * Read only the class/message, never postgres detail, query or parameters.
 */
export function safeAdminError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const redact = (value: string) => value
    .replace(/swm_[A-Za-z0-9_-]+/gu, "[credential]")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[token]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/giu, "[url]")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.|'')*'/gu, "[value]")
    .replace(/\b(?:password|secret|token|credential|authorization)\s*[:=]\s*\S+/giu, "[secret]");
  return boundedSafeText(redact(`${error.name}: ${error.message}`), 512);
}

/** By SQLSTATE, never by message: 55P03 and 40P01 rolled back in full, so both get the retryable 503. */
export function classifyCommandFailure(
  isTestRollback: boolean,
  code: string | null,
): CommandFailureReason {
  if (isTestRollback) return "test_rollback";
  return code === "55P03" || code === "40P01" ? "lock_timeout" : "internal_error";
}

/** Build the allowlisted row; request bodies and credentials are not inputs. */
export function durableCommandFailure(input: {
  commandKind: string;
  reason: CommandFailureReason;
  code: string | null;
  error: unknown;
  requestId: string;
}): DurableCommandFailure {
  const commandKind = boundedSafeText(input.commandKind, 64) || "unknown";
  const code = input.code === null
    ? null
    : boundedSafeText(input.code, 64) || null;
  return {
    command_kind: commandKind,
    reason: input.reason,
    db_code: code,
    detail: safeError(input.error),
    request_id: input.requestId,
  };
}

/** Attempt one diagnostic insert within the remaining request budget without ever replacing or delaying the response. */
export async function finishCommandFailure(
  failure: DurableCommandFailure,
  insert: InsertCommandFailure,
  onInsertFailure: (error: unknown) => void = () => {},
  budgetMs: number = FAILURE_PERSISTENCE_MAX_MS,
): Promise<CommandFailureResult> {
  const persisted = await runWithinFailureBudget(budgetMs, () => insert(failure));
  if (!persisted.ok) {
    try {
      onInsertFailure(persisted.error);
    } catch {
      // Reporting a diagnostic failure must not mask the command failure either.
    }
  }
  return failure.reason === "lock_timeout" || failure.db_code === "EDGE_DATABASE_STALLED"
    ? { status: 503, body: { error: "temporarily_unavailable" } }
    : { status: 500, body: { error: "internal_error" } };
}

/** Whether a failed admin transaction is confirmed rolled back or its commit status is unknown. */
export type AdminFailureOutcome = "rolled_back" | "unknown";

/** Stable driver/holder/transport error codes where COMMIT may or may not have landed on Postgres. */
const ADMIN_UNKNOWN_OUTCOME_CODES = new Set([
  "EDGE_DATABASE_STALLED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENETRESET",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
]);

/** Distinguish an unknown transaction outcome (stall / lost connection / connection error) from a
 * confirmed rollback. Classified strictly by stable error code, never by message. */
export function adminFailureOutcome(error: unknown): AdminFailureOutcome {
  const code = dbCode(error);
  if (code === null) return "rolled_back";
  if (ADMIN_UNKNOWN_OUTCOME_CODES.has(code)) return "unknown";
  if (code.length === 5 && code.startsWith("08")) return "unknown";
  return "rolled_back";
}

/** An OAuth admin transaction that ended in SQLSTATE 40P01 (confirmed rollback) or an unknown
 * outcome (stall / lost connection) caches no catch-generated failure receipt in recordAdminFailure,
 * so the same command_id can recover cleanly (replaying a real commit or executing once).
 * Read by code, never by message. */
export function adminFailureRetryable(error: unknown): boolean {
  return dbCode(error) === "40P01" || adminFailureOutcome(error) === "unknown";
}

/** OAuth admin failure response. A retryable failure adds `retryable: true` (the
 * `{ error, request_id, retryable }` envelope the clients parse); every other body is unchanged. */
export function adminOAuthFailureResult(
  error: unknown,
  code: "admin_command_failed" | "admin_failure_audit_unavailable",
): { status: 503; body: { error: string; retryable?: true } } {
  return { status: 503, body: adminFailureRetryable(error) ? { error: code, retryable: true } : { error: code } };
}

/** Activity edge failure response (HezLead ruling 30). By SQLSTATE, never by message: a 40P01
 * rolled back in full, so it gets the 503 of finishCommandFailure; 55P03 and every other failure
 * keep the activity edge's 500. */
export function activityFailureResult(error: unknown): CommandFailureResult {
  return dbCode(error) === "40P01"
    ? { status: 503, body: { error: "temporarily_unavailable" } }
    : { status: 500, body: { error: "internal_error" } };
}
