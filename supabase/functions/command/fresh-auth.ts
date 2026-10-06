export const FRESH_INTERACTIVE_AUTH_SECONDS = 300;

/**
 * Auth-service (GoTrue claims timestamps) versus command-path database
 * `statement_timestamp()` can disagree by a small amount. A just-signed-in user
 * whose interactive AMR is a few seconds "in the future" relative to the DB
 * clock must not loop forever on fresh_auth_required. This bound is only a
 * negative-age allowance; the 300-second upper freshness window is unchanged.
 */
export const FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS = 5;

const INTERACTIVE_METHODS = new Set([
  "oauth",
  "password",
  "otp",
  "totp",
  "sso/saml",
  "magiclink",
  "email/signup",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Returns the newest verified interactive authentication timestamp in epoch
 * seconds. The caller must pass claims produced by auth.getClaims() for the
 * currently presented JWT; unverified JWT payloads are never accepted here.
 *
 * AMR entries must be objects `{ method, timestamp }` as defined by Supabase
 * JWT Claims (`Array<{ method: string; timestamp: number }>`). Bare method
 * strings without timestamps cannot prove freshness and are ignored (fail
 * closed when no object entry qualifies).
 */
export function newestInteractiveAmrSeconds(claims: unknown): number | null {
  const entries = record(claims)?.amr;
  if (!Array.isArray(entries)) return null;
  let newest: number | null = null;
  for (const entry of entries) {
    const amr = record(entry);
    if (!amr || typeof amr.method !== "string") continue;
    const method = amr.method.toLowerCase();
    const timestamp = amr.timestamp;
    if (
      !INTERACTIVE_METHODS.has(method) ||
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp < 0
    ) {
      continue;
    }
    newest = newest === null ? timestamp : Math.max(newest, timestamp);
  }
  return newest;
}

export function hasFreshInteractiveAuth(
  interactiveAtSeconds: number | null,
  serverNowMs: number,
): boolean {
  if (
    interactiveAtSeconds === null ||
    !Number.isFinite(interactiveAtSeconds) ||
    !Number.isFinite(serverNowMs)
  ) {
    return false;
  }
  const ageSeconds = serverNowMs / 1000 - interactiveAtSeconds;
  return (
    ageSeconds >= -FRESH_INTERACTIVE_AUTH_CLOCK_SKEW_SECONDS &&
    ageSeconds <= FRESH_INTERACTIVE_AUTH_SECONDS
  );
}

/**
 * Membership commands a stale interactive session must not run. Idempotency
 * replay stays in front of this check: a stored result is returned as stored.
 */
export const FRESH_INTERACTIVE_COMMAND_KINDS = [
  "remove_member",
  "change_role",
] as const;

const FRESH_AUTH_REFUSAL_MESSAGE: Record<
  (typeof FRESH_INTERACTIVE_COMMAND_KINDS)[number],
  string
> = {
  remove_member:
    "Sign in again, then retry member removal. No membership change was recorded.",
  change_role:
    "Sign in again, then retry the role change. No membership change was recorded.",
};

export function commandNeedsFreshInteractiveAuth(kind: string): boolean {
  return (FRESH_INTERACTIVE_COMMAND_KINDS as readonly string[]).includes(kind);
}

/**
 * Null means the command may proceed to the reducer. A refusal is authentication
 * only: the caller's role has not been evaluated.
 */
export function freshInteractiveAuthRefusal(
  kind: string,
  credentialKind: string,
  interactiveAtSeconds: number | null,
  serverNowMs: number,
): { error: "fresh_auth_required"; message: string } | null {
  if (!commandNeedsFreshInteractiveAuth(kind)) return null;
  if (
    credentialKind === "user" &&
    hasFreshInteractiveAuth(interactiveAtSeconds, serverNowMs)
  ) {
    return null;
  }
  const message = kind === "change_role"
    ? FRESH_AUTH_REFUSAL_MESSAGE.change_role
    : FRESH_AUTH_REFUSAL_MESSAGE.remove_member;
  return { error: "fresh_auth_required", message };
}
