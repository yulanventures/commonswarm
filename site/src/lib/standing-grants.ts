/** Canonical owner policy. Missing or malformed metadata is never a NULL policy. */
export interface ConnectionPolicy {
  connectionExpiresAt?: string | null;
  connectionExpiredAt?: string | null;
}

function policyDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Absent keys stay absent; explicit NULL stays NULL; malformed keys remain own
 * undefined properties. Callers can distinguish all three without trusting bad dates. */
export function connectionPolicyFields(row: Record<string, unknown>): ConnectionPolicy {
  const policy: ConnectionPolicy = {};
  if (Object.hasOwn(row, "connection_expires_at"))
    policy.connectionExpiresAt = row.connection_expires_at === null || policyDate(row.connection_expires_at) ? row.connection_expires_at : undefined;
  if (Object.hasOwn(row, "connection_expired_at"))
    policy.connectionExpiredAt = row.connection_expired_at === null || policyDate(row.connection_expired_at) ? row.connection_expired_at : undefined;
  return policy;
}

export function connectionPolicyState(policy: ConnectionPolicy, live: boolean, now = Date.now()): "unknown" | "ended" | "permanent" | "dated" {
  if (policyDate(policy.connectionExpiredAt) || (policyDate(policy.connectionExpiresAt) && Date.parse(policy.connectionExpiresAt) <= now)) return "ended";
  if (!live || policy.connectionExpiredAt !== null) return "unknown";
  if (policy.connectionExpiresAt === null) return "permanent";
  return policyDate(policy.connectionExpiresAt) ? "dated" : "unknown";
}

export function connectionPolicyCopy(policy: ConnectionPolicy, live: boolean, now = Date.now()): string {
  switch (connectionPolicyState(policy, live, now)) {
    case "permanent": return "Stays connected until you remove it";
    case "dated": return `Connection ends ${new Date(policy.connectionExpiresAt!).toLocaleString(undefined, { timeZoneName: "short" })}`;
    case "ended": return "Connection ended";
    default: return "Connection settings are managed by the server.";
  }
}

// Pre-mint copy has no confirmed live family or returned policy.
export const STANDING_GRANT_RULES: readonly string[] = ["Connection settings are managed by the server."];
export const STANDING_GRANT_COPY = STANDING_GRANT_RULES.join(" ");

export type GrantRiskBadge =
  | "REVOKED"
  | "SUSPENDED"
  | "NEW HOST"
  | "UNBOUND"
  | "ENDED";

export interface GrantRiskInput extends ConnectionPolicy {
  kind: "timeboxed" | "standing";
  horizonExpiresAt: string | null;
  boundDeviceId: string | null;
  lastUsedAt: string | null;
  issuedAt: string;
  newHostAt: string | null;
  /**
   * CURRENT suspension, not the last one that happened. The read functions
   * report the effective value — swarm_read.renewal_grant_roster returns NULL
   * here once a grant has been resumed — so a resumed grant stops wearing the
   * SUSPENDED badge without this file having to know about resume at all.
   */
  suspendedAt: string | null;
  revokedAt: string | null;
}

/** Technical horizons never establish an owner-chosen end date. */
export function renewalGrantEnded(grant: GrantRiskInput, now = Date.now()): boolean {
  return connectionPolicyState(grant, true, now) === "ended";
}

/** Select exactly one risk in the design's required precedence. */
export function grantRiskBadge(
  grant: GrantRiskInput,
  now = Date.now(),
): GrantRiskBadge | null {
  if (grant.revokedAt !== null) return "REVOKED";
  if (grant.suspendedAt !== null) return "SUSPENDED";
  if (renewalGrantEnded(grant, now)) return "ENDED";
  if (grant.newHostAt !== null) return "NEW HOST";
  if (grant.kind === "standing" && grant.boundDeviceId === null) return "UNBOUND";
  return null;
}
