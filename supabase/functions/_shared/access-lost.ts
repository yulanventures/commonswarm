/**
 * `access_lost`: one JSON line on stderr when an established agent loses
 * access. An ops timer alerts on it, so the shape is a stable contract:
 * {"event":"access_lost","class":…,"principal_ref":…,"owner_ref":…,"grant_ref":…,"at":…}
 *
 * Fields hold only the first 8 characters of an identifier, never a token,
 * hash, IP or email. Each (class, ref) prints at most once per 60 s per
 * isolate, so a client refusing in a loop cannot flood the logs.
 */
export type AccessLostClass =
  | "local_renewal_superseded"
  | "local_credential_revoked"
  | "hosted_seat_refused";

export interface AccessLostFields {
  class: AccessLostClass;
  principal_ref: string | null;
  owner_ref: string | null;
  grant_ref: string | null;
}

export const ACCESS_LOST_INTERVAL_MS = 60_000;
const MAX_KEYS = 4096;

/** First 8 characters of an identifier, or null when it is not one. */
export function accessRef(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8}/u.test(value)
    ? value.slice(0, 8) : null;
}

/** Bounded per-key interval gate. Expired keys are pruned when it fills. */
export class AccessLostLimiter {
  readonly #next = new Map<string, number>();
  constructor(readonly intervalMs = ACCESS_LOST_INTERVAL_MS, readonly maxKeys = MAX_KEYS) {}
  allow(key: string, now: number): boolean {
    const next = this.#next.get(key);
    if (next !== undefined && now < next) return false;
    this.#next.delete(key);
    if (this.#next.size >= this.maxKeys) {
      for (const [k, at] of this.#next) if (at <= now) this.#next.delete(k);
      // Still full of live keys: drop the oldest rather than grow.
      if (this.#next.size >= this.maxKeys) this.#next.delete(this.#next.keys().next().value!);
    }
    this.#next.set(key, now + this.intervalMs);
    return true;
  }
}

const emitted = new AccessLostLimiter();
/** Gates the failure-path lookup that decides whether to emit, so a looping
 * client costs at most one extra query per key per interval. */
export const accessLostProbes = new AccessLostLimiter();

export function logAccessLost(
  fields: AccessLostFields,
  now = Date.now(),
  write: (line: string) => void = (line) => console.error(line),
  limiter: AccessLostLimiter = emitted,
): boolean {
  const ref = fields.principal_ref ?? fields.grant_ref ?? fields.owner_ref ?? "-";
  if (!limiter.allow(`${fields.class}:${ref}`, now)) return false;
  write(JSON.stringify({
    event: "access_lost",
    class: fields.class,
    principal_ref: accessRef(fields.principal_ref),
    owner_ref: accessRef(fields.owner_ref),
    grant_ref: accessRef(fields.grant_ref),
    at: new Date(now).toISOString(),
  }));
  return true;
}

/** Hosted tool calls refused because the caller's provider grant family was
 * retired: the access token is still signed and unexpired, the family is not. */
export async function reportHostedSeatRefused(
  code: unknown,
  token: { providerGrantId: string; subject: string },
  providerStatus: (providerGrantId: string) => Promise<{ active: boolean }>,
  now = Date.now(),
  write?: (line: string) => void,
): Promise<boolean> {
  if (code !== "hosted_seat_forbidden" && code !== "hosted_grant_forbidden") return false;
  const grantRef = accessRef(token.providerGrantId);
  if (grantRef === null || !accessLostProbes.allow(`hosted_seat_refused:${grantRef}`, now)) return false;
  let active: boolean;
  try {
    active = (await providerStatus(token.providerGrantId)).active === true;
  } catch {
    return false;
  }
  if (active) return false;
  return logAccessLost({
    class: "hosted_seat_refused",
    principal_ref: null,
    owner_ref: accessRef(token.subject),
    grant_ref: grantRef,
  }, now, write);
}
