export interface ServerErrorEnvelope {
  readonly error: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean | null;
}

export const EMPTY_SERVER_ERROR_ENVELOPE: ServerErrorEnvelope = {
  error: null,
  requestId: null,
  retryable: null,
};

/**
 * Both fields are machine tokens in the server contract — a slug like
 * `internal_error` and a `crypto.randomUUID()`. Accepting only that shape keeps
 * server-controlled text out of the error messages that this client's own
 * classifiers match on: `isFollowCredentialFailure` tests for the phrase
 * "secret is absent", so free-form prose in an error body would otherwise let a
 * server steer client-side classification. Anything else is dropped, not
 * truncated — a mangled token is worse than no token.
 */
const ERROR_SLUG_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function tokenField(value: unknown, shape: RegExp): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return shape.test(trimmed) ? trimmed : null;
}

export function parseServerErrorEnvelope(body: unknown): ServerErrorEnvelope {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return EMPTY_SERVER_ERROR_ENVELOPE;
  }
  const record = body as Record<string, unknown>;
  return {
    error: tokenField(record.error, ERROR_SLUG_RE),
    requestId: tokenField(record.request_id, REQUEST_ID_RE),
    retryable: typeof record.retryable === "boolean" ? record.retryable : null,
  };
}

export function serverRefusedRetry(envelope: ServerErrorEnvelope): boolean {
  return envelope.retryable === false;
}

export function describeServerError(
  prefix: string,
  envelope: ServerErrorEnvelope,
): string {
  const parts: string[] = [];
  if (envelope.error !== null) parts.push(envelope.error);
  if (envelope.requestId !== null) parts.push(`request_id ${envelope.requestId}`);
  if (parts.length === 0) return prefix;
  return `${prefix}: ${parts.join(", ")}`;
}
