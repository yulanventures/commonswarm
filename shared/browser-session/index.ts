import type {
  AuthChangeEvent,
  AuthRetryableFetchError as AuthRetryableFetchErrorCtor,
  Session,
  SupabaseClient,
  createClient as createClientFn,
  isAuthSessionMissingError as isAuthSessionMissingErrorFn,
  navigatorLock as navigatorLockFn,
  processLock as processLockFn,
} from "@supabase/supabase-js";

export interface Deployment {
  url: string;
  anonKey: string;
}

export interface DeploymentEnv {
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_ANON_KEY?: string;
}

/**
 * Resolve deployment coordinates from build-time env vars first, falling back to
 * `<meta name="commonswarm:url">` and `<meta name="commonswarm:anon-key">`.
 */
export function resolveDeployment(
  buildEnv?: DeploymentEnv,
  doc: Document | null = typeof document !== "undefined" ? document : null,
): Deployment | null {
  const meta = (name: string): string | null =>
    doc
      ? doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() || null
      : null;

  const url = buildEnv?.PUBLIC_SUPABASE_URL ?? meta("commonswarm:url");
  const anonKey = buildEnv?.PUBLIC_SUPABASE_ANON_KEY ?? meta("commonswarm:anon-key");
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Exact Supabase JS v2.111.0 default storage key (`SupabaseClient.ts`). */
export function sessionStorageKeyForDeployment(url: string): string {
  const baseUrl = new URL(url);
  return `sb-${baseUrl.hostname.split(".")[0] ?? ""}-auth-token`;
}

/** Separate cross-tab refresh backoff entry stored beside the session key. */
export function refreshBackoffStorageKeyForDeployment(url: string): string {
  return `${sessionStorageKeyForDeployment(url)}:refresh-backoff`;
}

export const PINNED_SUPABASE_JS_VERSION = "2.111.0";

export const REFRESH_BACKOFF_FLOOR_MS = 1_000;
export const REFRESH_BACKOFF_BASE_MS = 2_000;
export const REFRESH_BACKOFF_CAP_MS = 60_000;
/**
 * Maximum interval between screen-level recovery rechecks reported on
 * `AuthRecoveryRequired.retryAfter` (15 minutes). The wire gate itself honours
 * the full valid server `Retry-After` deadline stored in the backoff record;
 * callers may recheck sooner and the wire gate still refuses until that full
 * server deadline elapses.
 */
export const RECOVERY_RECHECK_MAX_MS = 15 * 60 * 1_000;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Read GoTrue's refresh-stable `session_id` claim from an access JWT for non-authoritative
 * client-side coordination. Returns `null` when the token is not a decodable JWT or carries
 * no non-empty `session_id` claim.
 */
export function sessionIdFromAccessToken(accessToken: string | null | undefined): string | null {
  if (typeof accessToken !== "string" || !accessToken) return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1] || !BASE64URL_RE.test(parts[1]) || parts[1].length % 4 === 1) {
    return null;
  }
  try {
    const padded = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    let json: string;
    if (typeof globalThis.atob === "function") {
      const binary = globalThis.atob(padded);
      if (typeof TextDecoder === "function") {
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } else {
        json = binary;
      }
    } else {
      return null;
    }
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const sessionId = (parsed as Record<string, unknown>).session_id;
    if (typeof sessionId !== "string") return null;
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Non-secret credential generation key for cross-tab refresh backoff coordination.
 * Combines the access JWT's `session_id` claim (unique per login), `user.id`, and
 * `expires_at` (advances on each rotation). Falls back to `user.id` plus `expires_at`
 * when `session_id` is absent. Never copies raw tokens or session payloads.
 */
export function credentialGenerationKey(
  session: Pick<Session, "access_token" | "expires_at" | "user"> | null | undefined,
): string | null {
  if (!session) return null;
  const userId = typeof session.user?.id === "string" ? session.user.id.trim() : "";
  const expiresAt =
    typeof session.expires_at === "number" && Number.isFinite(session.expires_at)
      ? String(session.expires_at)
      : "";
  const sessionId = sessionIdFromAccessToken(session.access_token);
  if (sessionId) {
    return `v1:sid:${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}:${expiresAt}`;
  }
  if (!userId && !expiresAt) return null;
  return `v1:uid:${encodeURIComponent(userId)}:${expiresAt}`;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    const ms = secs * 1000;
    if (Number.isFinite(secs) && Number.isFinite(ms) && Number.isFinite(now + ms)) {
      return ms;
    }
    return null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return null;
}

function isRefreshDiscardedError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "AuthRefreshDiscardedError",
  );
}

function isUnexpiredSession(session: Session | null): boolean {
  if (!session) return false;
  if (typeof session.expires_at !== "number") return true;
  return session.expires_at * 1000 > Date.now();
}

/** Deterministic 12-hex origin hash (dual FNV-1a 32-bit) matching multi-account storage key scoping. */
export function deploymentOriginHash(url: string): string {
  const normalized = new URL(url).origin.toLowerCase();
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0").slice(0, 4)}`;
}

/** Dormant multi-account feature gate; single source of truth for `/app` and `/next`. */
export const MULTI_ACCOUNT_ENABLED = false;

/** Canonical multi-account storage key builders shared with `/app` (`site/src/lib/multi-account.ts`). */
export const slotStorageKey = (originHash: string, loginId: string): string =>
  `commonswarm:auth:v1:${originHash}:login:${loginId}`;

export const slotStoragePrefix = (originHash: string): string =>
  `commonswarm:auth:v1:${originHash}:login:`;

export const accountsStorageKey = (originHash: string): string =>
  `commonswarm:accounts:v1:${originHash}`;

export const activeAccountStorageKey = (originHash: string): string =>
  `commonswarm:active-account:v1:${originHash}`;

export const tabAccountStorageKey = (originHash: string): string =>
  `commonswarm:tab-account:v1:${originHash}`;

export const attemptStorageKey = (originHash: string, attemptId: string): string =>
  `commonswarm:auth:v1:${originHash}:attempt:${attemptId}`;

export const attemptStoragePrefix = (originHash: string): string =>
  `commonswarm:auth:v1:${originHash}:attempt:`;

/** Storage key namespace prefixes owned by `/app`'s multi-account mode. */
export const MULTI_ACCOUNT_STORAGE_KEY_PREFIXES = [
  "commonswarm:auth:v1:",
  "commonswarm:accounts:v1:",
  "commonswarm:active-account:v1:",
  "commonswarm:tab-account:v1:",
] as const;

export function multiAccountStorageKeyPrefixesForDeployment(url: string): readonly string[] {
  const originHash = deploymentOriginHash(url);
  return [
    slotStoragePrefix(originHash),
    attemptStoragePrefix(originHash),
    accountsStorageKey(originHash),
    activeAccountStorageKey(originHash),
    tabAccountStorageKey(originHash),
  ];
}

export interface StorageKeysLike {
  readonly length: number;
  key(index: number): string | null;
}

export type MultiAccountProbeResult = "in_use" | "absent" | "unknown";

/**
 * Pure check for whether multi-account storage keys exist in `storage`.
 * Distinguishes `"absent"` (complete readable scan found no keys) from `"unknown"`
 * (storage unavailable or threw at any point during enumeration), so callers can fail closed.
 * When `deploymentUrl` is supplied, checks keys scoped to that deployment's origin hash;
 * otherwise checks any key matching `MULTI_ACCOUNT_STORAGE_KEY_PREFIXES`.
 */
export function multiAccountInUse(
  storage: StorageKeysLike | null | undefined,
  deploymentUrl?: string,
): MultiAccountProbeResult {
  if (!storage) return "unknown";
  try {
    const length = storage.length;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return "unknown";
    if (typeof storage.key !== "function") return "unknown";
    if (deploymentUrl !== undefined) {
      const originHash = deploymentOriginHash(deploymentUrl);
      const exactKeys = new Set([
        accountsStorageKey(originHash),
        activeAccountStorageKey(originHash),
        tabAccountStorageKey(originHash),
      ]);
      const loginPrefix = slotStoragePrefix(originHash);
      const attemptPrefix = attemptStoragePrefix(originHash);
      for (let i = 0; i < length; i += 1) {
        const key = storage.key(i);
        if (key === null) continue;
        if (typeof key !== "string") return "unknown";
        if (exactKeys.has(key) || key.startsWith(loginPrefix) || key.startsWith(attemptPrefix)) {
          return "in_use";
        }
      }
      return "absent";
    }
    for (let i = 0; i < length; i += 1) {
      const key = storage.key(i);
      if (key === null) continue;
      if (typeof key !== "string") return "unknown";
      if (MULTI_ACCOUNT_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        return "in_use";
      }
    }
    return "absent";
  } catch {
    return "unknown";
  }
}

/** An interrupted identity check is safe to retry; it is not a sign-out. */
export class AuthRecoveryRequired extends Error {
  override name = "AuthRecoveryRequired";
  /** Earliest epoch timestamp (ms) when a refresh retry may be attempted, if known. */
  readonly retryAfter?: number;
  constructor(retryAfter?: number) {
    super("CommonSwarm could not check your sign-in. Try again when the connection recovers.");
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      this.retryAfter = retryAfter;
    }
  }
}

/** Signals that the saved login no longer names a server-side session. */
export class SessionExpired extends Error {
  override name = "SessionExpired";
  constructor() {
    super("Your session expired — sign in again.");
  }
}

export const terminalRefreshCodes = new Set([
  "refresh_token_not_found", "session_not_found",
  "session_expired", "user_not_found", "user_banned",
]);

/** PostgREST's refusal when a human token's session has ended (CS-E04 db-pre-request): 401 and this code. */
export async function isRestSessionEnded(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return body?.code === "session_not_found";
}

// Outer 4s deadline around verified loading; known refresh backoff settles promptly
// outside the cross-tab lock with retryAfter rather than waiting out this bound.
export async function boundedAuth<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AuthRecoveryRequired()), 4_000);
    })]);
  } finally { clearTimeout(timer); }
}

export function sameCredentials(a: Session, b: Session): boolean {
  return a.access_token === b.access_token && a.refresh_token === b.refresh_token && a.user.id === b.user.id;
}

export interface BrowserSessionSdk {
  createClient: typeof createClientFn;
  navigatorLock: typeof navigatorLockFn;
  processLock: typeof processLockFn;
  isAuthSessionMissingError: typeof isAuthSessionMissingErrorFn;
  AuthRetryableFetchError: typeof AuthRetryableFetchErrorCtor;
}

export interface CreateBrowserSessionOptions {
  url: string;
  anonKey: string;
  detectSessionInUrl: boolean;
  allowProcessLockFallback: boolean;
  sdk: BrowserSessionSdk;
}

export interface BrowserSignOutOptions {
  /** Scope forwarded to `/auth/v1/logout` when a usable access token exists (defaults to `"local"`). */
  scope?: "global" | "local" | "others";
  /** Optional initiating login identity captured at click time. */
  expected?: {
    userId?: string | null;
    sessionId?: string | null;
  } | null;
}

export interface BrowserSignOutResult {
  /** True iff the initiating login's local browser credential is confirmed cleared (or absent). */
  readonly signedOutLocally: boolean;
  /** True iff GoTrue confirmed server-side logout (2xx) for the initiating login's access token. */
  readonly serverRevoked: boolean;
  /** True iff another login replaced the initiating login before sign-out ran; replacement left intact. */
  readonly replaced: boolean;
  /** True iff durable local removal failed or could not be confirmed; caller should keep view retired and offer retry. */
  readonly retry: boolean;
}

export interface BrowserSession {
  readonly ok: true;
  readonly client: SupabaseClient;
  readonly storageKey: string;
  currentSession(): Promise<Session | null>;
  verifiedSession(): Promise<Session | null>;
  boundedAuth<T>(operation: Promise<T>): Promise<T>;
  signOut(options?: BrowserSignOutOptions): Promise<BrowserSignOutResult>;
  /** Stop this instance's background auth work without modifying stored credentials or signing out. */
  quiesce(): Promise<void>;
}

export interface BrowserSessionLocksUnavailable {
  readonly ok: false;
  readonly reason: "locks_unavailable";
}

export interface BrowserSessionUnsupportedSdk {
  readonly ok: false;
  readonly reason: "unsupported_sdk";
}

export type CreateBrowserSessionResult =
  | BrowserSession
  | BrowserSessionLocksUnavailable
  | BrowserSessionUnsupportedSdk;

export function createBrowserSession(options: CreateBrowserSessionOptions): CreateBrowserSessionResult {
  const {
    createClient,
    navigatorLock,
    processLock,
    isAuthSessionMissingError,
    AuthRetryableFetchError,
  } = options.sdk;

  const hasWebLocks = (): boolean => typeof navigator !== "undefined" && Boolean(navigator.locks);

  if (!options.allowProcessLockFallback && !hasWebLocks()) {
    return { ok: false, reason: "locks_unavailable" };
  }

  let deadSession = false;
  let quiesced = false;
  let quiescePromise: Promise<void> | null = null;
  const quiesceController = new AbortController();
  const defaultStorageKey = sessionStorageKeyForDeployment(options.url);
  const expectedLockName = `lock:${defaultStorageKey}`;
  const backoffStorageKey = refreshBackoffStorageKeyForDeployment(options.url);
  let sessionStorageKey: string = defaultStorageKey;
  const effectiveStorageKey = (): string => sessionStorageKey;
  let removalSnapshot: string | null = null;
  interface SignOutRemovalGuard {
    readonly lockToken: symbol;
    readonly expectedDurableRaw: string;
    readonly matchesInitiating: (cred: Session | null) => boolean;
  }
  let signOutRemovalGuard: SignOutRemovalGuard | null = null;
  const authMemory = new Map<string, string>();
  const importedStorageKeys = new Set<string>();
  const diskSnapshots = new Map<string, string | null>();
  let persistentStorage: Storage | null | undefined;
  let nextStorageProbe = 0;
  const pendingStorageWrites = new Map<string, { expected: string | null | undefined; value: string }>();
  const removedStorageKeys = new Set<string>();
  let storageRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let storageRetryDelay = 1_000;
  let storageRetryInFlight = false;
  let activeStorageRetry: Promise<void> | null = null;
  const activeAuthFetches = new Set<Promise<unknown>>();

  // Immutable per-instance 128-bit CSPRNG prefix; each discard attempt adds a fresh
  // 128-bit CSPRNG suffix. The write fence recognises sentinels purely from this
  // immutable prefix with no shared mutable list that could be raced.
  const discardSentinelPrefix = `__cs_discard_v1_${randomHex(16)}_`;
  let activeLockToken: symbol | null = null;
  let lastDiscardedRefreshToken: string | null = null;

  interface RefreshAttemptScope {
    readonly id: symbol;
    readonly lockToken: symbol;
    readonly storageKey: string;
    discardSentinel: string | null;
    commitGuardReadArmed: boolean;
  }

  interface InternalAuthClientShape {
    _emitInitialSession?: (id: string | symbol) => Promise<void>;
    _callRefreshToken?: (refreshToken: string) => Promise<unknown>;
    _refreshAccessToken?: (refreshToken: string) => Promise<{
      data?: { session?: Session | null } | null;
      error?: unknown;
    }>;
    _acquireLock?: <R>(acquireTimeout: number, fn: () => Promise<R>) => Promise<R>;
    _removeSession?: () => Promise<void>;
    admin?: {
      signOut?: (jwt: string, scope?: "global" | "local" | "others") => Promise<{ data: null; error: unknown }>;
    };
    onAuthStateChange?: typeof client.auth.onAuthStateChange;
    storageKey?: string;
    lockAcquired?: boolean;
    refreshingDeferred?: unknown;
    headers?: Record<string, unknown>;
    dispose?: () => Promise<void>;
    stopAutoRefresh?: () => Promise<void>;
    initializePromise?: Promise<unknown> | null;
    autoRefreshToken?: boolean;
    lock?: unknown;
  }

  let activeRefreshAttempt: RefreshAttemptScope | null = null;
  let authClientRef: InternalAuthClientShape | null = null;
  let userCheckChain: Promise<void> = Promise.resolve();
  let activeUserCheck: { verifiedAccessToken: string | null } | null = null;

  function retireRefreshAttempt(expected?: RefreshAttemptScope): void {
    if (!activeRefreshAttempt) return;
    if (expected && activeRefreshAttempt !== expected) return;
    activeRefreshAttempt.commitGuardReadArmed = false;
    activeRefreshAttempt.discardSentinel = null;
    activeRefreshAttempt = null;
  }

  function retireRefreshAttemptForLock(lockToken: symbol): void {
    if (activeRefreshAttempt && activeRefreshAttempt.lockToken === lockToken) {
      retireRefreshAttempt(activeRefreshAttempt);
    }
  }

  interface RefreshBackoffRecord {
    gen: string;
    nextAttemptAt: number;
    attempts: number;
  }

  let memoryBackoff: RefreshBackoffRecord | null = null;
  let memoryBackoffWriteRefused = false;

  function isSentinelString(value: unknown): boolean {
    return typeof value === "string" && value.startsWith(discardSentinelPrefix);
  }

  function isSentinelSession(session: Session | null | undefined): boolean {
    return Boolean(
      session && (
        isSentinelString(session.access_token) ||
        isSentinelString(session.refresh_token) ||
        isSentinelString(session.user?.id)
      ),
    );
  }

  function isSentinelPayload(raw: string): boolean {
    if (raw.includes(discardSentinelPrefix)) return true;
    try {
      const parsed = JSON.parse(raw) as {
        access_token?: unknown;
        refresh_token?: unknown;
        user?: { id?: unknown } | null;
      } | null;
      return Boolean(
        parsed && (
          isSentinelString(parsed.access_token) ||
          isSentinelString(parsed.refresh_token) ||
          isSentinelString(parsed.user?.id)
        ),
      );
    } catch {
      return false;
    }
  }

  function nextDiscardSentinel(): string {
    return `${discardSentinelPrefix}${randomHex(16)}`;
  }

  function storageBackend(): Storage | null {
    if (persistentStorage) return persistentStorage;
    if (Date.now() < nextStorageProbe) return null;
    nextStorageProbe = Date.now() + 1_000;
    try {
      const storage = globalThis.localStorage;
      const probe = `commonswarm-storage-${crypto.randomUUID()}`;
      storage.setItem(probe, probe);
      storage.removeItem(probe);
      persistentStorage = storage;
    } catch { persistentStorage = null; }
    return persistentStorage ?? null;
  }

  function readPersistentAuthItem(key: string): string | null | undefined {
    try { return globalThis.localStorage?.getItem(key); } catch { return undefined; }
  }

  type DurableSlotRead =
    | { readonly status: "unreadable" }
    | { readonly status: "empty" }
    | { readonly status: "present"; readonly raw: string; readonly session: Session | null };

  /**
   * Authoritative direct read of persistent browser storage (never `authMemory` or
   * reconciled local state). Distinguishes unreadable/unavailable storage from an
   * empty slot and a present slot.
   */
  function readDurableSlot(key: string): DurableSlotRead {
    let storage: Storage | null | undefined;
    try {
      storage = globalThis.localStorage;
    } catch {
      persistentStorage = null;
      return { status: "unreadable" };
    }
    if (!storage || typeof storage.getItem !== "function") {
      persistentStorage = null;
      return { status: "unreadable" };
    }
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      persistentStorage = null;
      return { status: "unreadable" };
    }
    if (raw === null) {
      return { status: "empty" };
    }
    if (typeof raw !== "string") {
      return { status: "unreadable" };
    }
    return { status: "present", raw, session: savedSession(raw) };
  }

  function parseBackoffRecord(raw: string | null): RefreshBackoffRecord | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        gen?: unknown;
        nextAttemptAt?: unknown;
        attempts?: unknown;
      } | null;
      if (
        !parsed ||
        typeof parsed.gen !== "string" ||
        parsed.gen.length === 0 ||
        typeof parsed.nextAttemptAt !== "number" ||
        !Number.isFinite(parsed.nextAttemptAt) ||
        parsed.nextAttemptAt <= 0 ||
        typeof parsed.attempts !== "number" ||
        !Number.isInteger(parsed.attempts) ||
        parsed.attempts < 1
      ) {
        return null;
      }
      return {
        gen: parsed.gen,
        nextAttemptAt: parsed.nextAttemptAt,
        attempts: parsed.attempts,
      };
    } catch {
      return null;
    }
  }

  function matchingMemoryBackoff(expectedGen: string | null): RefreshBackoffRecord | null {
    if (!memoryBackoff) return null;
    if (!expectedGen || memoryBackoff.gen !== expectedGen) {
      memoryBackoff = null;
      memoryBackoffWriteRefused = false;
      return null;
    }
    return {
      gen: memoryBackoff.gen,
      nextAttemptAt: memoryBackoff.nextAttemptAt,
      attempts: memoryBackoff.attempts,
    };
  }

  function mergeSameGenBackoff(
    disk: RefreshBackoffRecord,
    local: RefreshBackoffRecord,
  ): RefreshBackoffRecord {
    return {
      gen: disk.gen,
      nextAttemptAt: Math.max(disk.nextAttemptAt, local.nextAttemptAt),
      attempts: Math.max(disk.attempts, local.attempts),
    };
  }

  function writeBackoffRecordLocked(record: RefreshBackoffRecord): boolean {
    if (activeLockToken === null) return false;
    const serialized = JSON.stringify(record);
    try {
      const storage = globalThis.localStorage;
      if (storage) {
        storage.setItem(backoffStorageKey, serialized);
        if (readPersistentAuthItem(backoffStorageKey) === serialized) {
          return true;
        }
      }
    } catch { /* readable-but-write-refused storage still honours memoryBackoff */ }
    return false;
  }

  // Condition 1: ALL mutations of the shared durable backoff record happen ONLY under
  // the tracked cross-tab lock (`activeLockToken !== null`). Read paths and event handlers
  // never mutate `backoffStorageKey` on disk.
  function clearBackoffRecordLocked(): void {
    memoryBackoff = null;
    memoryBackoffWriteRefused = false;
    if (activeLockToken === null) return;
    if (readPersistentAuthItem(backoffStorageKey) !== null) {
      try { globalThis.localStorage?.removeItem(backoffStorageKey); } catch { /* ignore storage errors */ }
    }
  }

  /**
   * Read-only view of the active backoff record for `expectedGen`.
   * Never mutates `localStorage`; treats a mismatched or corrupt disk entry as ignorable
   * until the next locked attempt cleans it up. Preserves the stronger same-generation
   * in-memory deadline when storage is readable but a newer write was refused, and never
   * shortens a parsed server deadline on read.
   */
  function readBackoffRecord(expectedGen: string | null): RefreshBackoffRecord | null {
    const raw = readPersistentAuthItem(backoffStorageKey);
    if (raw === undefined) {
      return matchingMemoryBackoff(expectedGen);
    }
    if (raw === null) {
      if (memoryBackoffWriteRefused) {
        return matchingMemoryBackoff(expectedGen);
      }
      memoryBackoff = null;
      return null;
    }
    const parsed = parseBackoffRecord(raw);
    if (!parsed || !expectedGen || parsed.gen !== expectedGen) {
      if (memoryBackoffWriteRefused) {
        return matchingMemoryBackoff(expectedGen);
      }
      if (!expectedGen || (memoryBackoff && memoryBackoff.gen !== expectedGen)) {
        memoryBackoff = null;
      }
      return null;
    }
    if (memoryBackoffWriteRefused && memoryBackoff && memoryBackoff.gen === expectedGen) {
      const merged = mergeSameGenBackoff(parsed, memoryBackoff);
      memoryBackoff = merged;
      if (parsed.nextAttemptAt >= merged.nextAttemptAt && parsed.attempts >= merged.attempts) {
        memoryBackoffWriteRefused = false;
      }
      return merged;
    }
    memoryBackoff = parsed;
    memoryBackoffWriteRefused = false;
    return parsed;
  }

  /**
   * Read-only re-sync of the in-memory backoff mirror after a BroadcastChannel auth event
   * or `storage` event. Never mutates `localStorage`, and preserves any matching record.
   */
  function syncMemoryBackoffFromStorage(currentGen: string | null): void {
    readBackoffRecord(currentGen);
  }

  function recordBackoffFailureLocked(gen: string, retryAfterHeader: string | null): RefreshBackoffRecord {
    const now = Date.now();
    const existing = readBackoffRecord(gen);
    const attempts = (existing?.attempts ?? 0) + 1;
    // Cap only the exponential part at REFRESH_BACKOFF_CAP_MS (60s); honour any
    // valid server Retry-After deadline in full on the wire gate.
    const expDelay = Math.min(
      REFRESH_BACKOFF_BASE_MS * (2 ** Math.min(attempts - 1, 10)),
      REFRESH_BACKOFF_CAP_MS,
    );
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
    const rawDelay =
      retryAfterMs !== null ? Math.max(expDelay, retryAfterMs) : expDelay;
    const delayMs = Math.max(rawDelay, REFRESH_BACKOFF_FLOOR_MS);
    const record: RefreshBackoffRecord = {
      gen,
      nextAttemptAt: now + delayMs,
      attempts,
    };
    memoryBackoff = record;
    memoryBackoffWriteRefused = !writeBackoffRecordLocked(record);
    return record;
  }

  function reconcileBackoffOnDiskLocked(currentGen: string | null): void {
    if (activeLockToken === null) {
      syncMemoryBackoffFromStorage(currentGen);
      return;
    }
    const raw = readPersistentAuthItem(backoffStorageKey);
    const localMatching =
      currentGen !== null && memoryBackoff && memoryBackoff.gen === currentGen
        ? memoryBackoff
        : null;
    if (raw === null) {
      if (memoryBackoffWriteRefused && localMatching) {
        memoryBackoff = localMatching;
        memoryBackoffWriteRefused = !writeBackoffRecordLocked(localMatching);
        return;
      }
      memoryBackoff = null;
      memoryBackoffWriteRefused = false;
      return;
    }
    if (raw === undefined) {
      if (!localMatching) {
        memoryBackoff = null;
        memoryBackoffWriteRefused = false;
      }
      return;
    }
    const parsed = parseBackoffRecord(raw);
    if (!parsed || currentGen === null || parsed.gen !== currentGen) {
      try { globalThis.localStorage?.removeItem(backoffStorageKey); } catch { /* ignore storage errors */ }
      if (localMatching) {
        memoryBackoff = localMatching;
        memoryBackoffWriteRefused = !writeBackoffRecordLocked(localMatching);
      } else {
        memoryBackoff = null;
        memoryBackoffWriteRefused = false;
      }
      return;
    }
    if (localMatching) {
      const merged = mergeSameGenBackoff(parsed, localMatching);
      memoryBackoff = merged;
      if (parsed.nextAttemptAt >= merged.nextAttemptAt && parsed.attempts >= merged.attempts) {
        memoryBackoffWriteRefused = false;
      } else {
        memoryBackoffWriteRefused = !writeBackoffRecordLocked(merged);
      }
      return;
    }
    memoryBackoff = parsed;
    memoryBackoffWriteRefused = false;
  }

  function acceptPersistentAuthItem(key: string, value: string | null): void {
    pendingStorageWrites.delete(key);
    diskSnapshots.set(key, value);
    if (value === null) authMemory.delete(key); else authMemory.set(key, value);
  }

  function reconcileAuthItem(key: string): void {
    const value = readPersistentAuthItem(key);
    if (value === undefined || removedStorageKeys.has(key)) return;
    const pending = pendingStorageWrites.get(key);
    // Without a readable pre-write snapshot, neither replacing memory with disk
    // nor writing over disk can establish ownership. Keep the page successor.
    if (pending && (pending.expected === undefined || value === pending.expected)) return;
    // A peer successor or logout wins over a delayed page-local save.
    acceptPersistentAuthItem(key, value);
  }

  async function retryStorageWrites(): Promise<void> {
    storageRetryTimer = undefined;
    if (quiesced) return;
    storageRetryInFlight = true;
    const run = (async () => {
      try {
        for (const [key, pending] of pendingStorageWrites) {
          if (quiesced) return;
          // Try once without waiting or stealing; a busy owner gets the next tick.
          // Route through trackedLock so the processLock fallback is covered identically.
          try {
            await trackedLock(expectedLockName, 0, async () => {
              if (quiesced) return;
              const storage = storageBackend();
              reconcileAuthItem(key);
              if (quiesced || pendingStorageWrites.get(key) !== pending || !storage ||
                  pending.expected === undefined || readPersistentAuthItem(key) === undefined) return;
              if (isSentinelPayload(pending.value)) {
                pendingStorageWrites.delete(key);
                return;
              }
              try {
                storage.setItem(key, pending.value);
                if (storage.getItem(key) === pending.value) acceptPersistentAuthItem(key, pending.value);
              } catch { persistentStorage = null; }
            });
          } catch { /* A busy SDK lock is retried without stealing or queueing. */ }
        }
      } catch { persistentStorage = null; }
      finally {
        storageRetryInFlight = false;
        activeStorageRetry = null;
        if (!quiesced) {
          storageRetryDelay = Math.min(storageRetryDelay * 2, 30_000);
          scheduleStorageRetry();
        }
      }
    })();
    activeStorageRetry = run;
    await run;
  }

  function scheduleStorageRetry(): void {
    if (quiesced) return;
    if (!("localStorage" in globalThis)) return;
    if (storageRetryTimer !== undefined || storageRetryInFlight || pendingStorageWrites.size === 0) return;
    storageRetryTimer = setTimeout(retryStorageWrites, storageRetryDelay);
    // Browser retries stay live; a denied Node localStorage must not keep Node alive.
    (storageRetryTimer as unknown as { unref?: () => void }).unref?.();
  }

  function savedSession(value: string | null): Session | null {
    try {
      const saved = value ? JSON.parse(value) : null;
      return saved && typeof saved.access_token === "string" && typeof saved.refresh_token === "string"
        ? saved as Session : null;
    } catch { return null; }
  }

  function readAuthItem(key: string): string | null {
    importedStorageKeys.add(key);
    reconcileAuthItem(key);
    return authMemory.get(key) ?? null;
  }

  function currentStoredSession(): Session | null {
    return savedSession(readAuthItem(effectiveStorageKey()));
  }

  function currentBackoffRetryAfter(session?: Session | null): number | undefined {
    const cred = session === undefined ? currentStoredSession() : session;
    if (!cred) return undefined;
    const record = readBackoffRecord(credentialGenerationKey(cred));
    const now = Date.now();
    if (!record || record.nextAttemptAt <= now) return undefined;
    return Math.min(record.nextAttemptAt, now + RECOVERY_RECHECK_MAX_MS);
  }

  const onStorage = (event: StorageEvent): void => {
    if (quiesced) return;
    if (event.storageArea !== globalThis.localStorage) return;
    const targetSessionKey = effectiveStorageKey();
    const keys = event.key === null
      ? [...new Set([...importedStorageKeys, targetSessionKey])]
      : [event.key];
    for (const key of keys) {
      // Even remove/reinsert of identical bytes must cancel an older pending save.
      if (!importedStorageKeys.has(key) && key !== targetSessionKey) continue;
      const value = readPersistentAuthItem(key);
      if (value !== undefined) {
        removedStorageKeys.delete(key);
        acceptPersistentAuthItem(key, value);
      }
    }
    // Condition 1: storage events are read-only hints. Re-read current storage and
    // preserve any active backoff record matching the current credential without mutating disk.
    if (event.key === null || event.key === backoffStorageKey || event.key === targetSessionKey) {
      syncMemoryBackoffFromStorage(credentialGenerationKey(currentStoredSession()));
    }
  };

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("storage", onStorage);
  }

  function removePersistentAuthItem(key: string): void {
    // Auxiliary keys (PKCE verifiers, -user cache) still attempt best-effort removal.
    try { globalThis.localStorage?.removeItem(key); }
    catch { persistentStorage = null; }
  }

  function removePersistentAuthItemConfirmed(key: string): boolean {
    let storage: Storage | null | undefined;
    try {
      storage = globalThis.localStorage;
    } catch {
      persistentStorage = null;
      return false;
    }
    if (!storage) return !("localStorage" in globalThis);
    try {
      storage.removeItem(key);
    } catch {
      persistentStorage = null;
      return false;
    }
    // Confirm durable removal by reading the slot back.
    return readDurableSlot(key).status === "empty";
  }

  // Readable disk remains untouched when writes fail; memory holds the current
  // page's successor until a still-owned save can be written and read back.
  const authStorage = {
    getItem(key: string): string | null {
      if (quiesced) return null;
      const attempt = activeRefreshAttempt;
      // Consume the discard marker ONLY for this client instance's active locked
      // `_callRefreshToken` post-request commit-guard read on the exact session slot key.
      // `commitGuardReadArmed` is armed solely when `_refreshAccessToken` returns this
      // attempt's sentinel, and is retired in `finally` on every exit.
      if (
        attempt !== null &&
        attempt.commitGuardReadArmed &&
        activeLockToken !== null &&
        attempt.lockToken === activeLockToken &&
        key === attempt.storageKey &&
        authClientRef?.lockAcquired === true &&
        authClientRef?.refreshingDeferred != null
      ) {
        attempt.commitGuardReadArmed = false;
        return null;
      }
      return readAuthItem(key);
    },
    setItem(key: string, value: string): void {
      if (quiesced) {
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      // Independent write fence: refuse any sentinel payload before touching memory or localStorage.
      if (isSentinelPayload(value)) {
        if (activeRefreshAttempt) activeRefreshAttempt.commitGuardReadArmed = false;
        throw new AuthRetryableFetchError("Storage write refused fabricated sentinel payload", 0);
      }
      importedStorageKeys.add(key);
      const pending = pendingStorageWrites.get(key);
      const disk = readPersistentAuthItem(key);
      if (pending && pending.expected !== undefined && disk !== undefined && disk !== pending.expected) {
        acceptPersistentAuthItem(key, disk);
        // Stop the SDK before it can announce a save that lost ownership.
        throw new AuthRetryableFetchError("Sign-in changed during storage save", 0);
      }
      const nextSession = savedSession(value);
      if (key === effectiveStorageKey()) {
        removalSnapshot = null;
        signOutRemovalGuard = null;
      }
      removedStorageKeys.delete(key);
      authMemory.set(key, value);
      pendingStorageWrites.set(key, { expected: pending ? pending.expected : disk === undefined ? diskSnapshots.get(key) : disk, value });
      storageRetryDelay = 1_000;
      try {
        const storage = storageBackend();
        if (storage && disk !== undefined && pendingStorageWrites.get(key)?.expected !== undefined) {
          storage.setItem(key, value);
          if (storage.getItem(key) === value) acceptPersistentAuthItem(key, value);
        }
      } catch { persistentStorage = null; }
      if (key === effectiveStorageKey() && nextSession) {
        reconcileBackoffOnDiskLocked(credentialGenerationKey(nextSession));
      }
      scheduleStorageRetry();
    },
    removeItem(key: string): void {
      if (quiesced) {
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      if (key === effectiveStorageKey() && signOutRemovalGuard !== null) {
        const guard = signOutRemovalGuard;
        signOutRemovalGuard = null;
        // Authoritatively re-read durable persistent storage directly (never the in-memory
        // or reconciled view) and require it to still match the locked durable read and
        // initiating login identity before calling persistent removeItem or broadcasting SIGNED_OUT.
        if (activeLockToken === null || guard.lockToken !== activeLockToken) {
          throw new AuthRetryableFetchError("Sign-out lock no longer active", 0);
        }
        const durableNow = readDurableSlot(key);
        if (
          durableNow.status !== "present" ||
          durableNow.raw !== guard.expectedDurableRaw ||
          !guard.matchesInitiating(durableNow.session)
        ) {
          throw new AuthRetryableFetchError("Sign-in changed or storage became unreadable before removal", 0);
        }
      } else if (key === effectiveStorageKey() && removalSnapshot !== null) {
        const expected = removalSnapshot;
        removalSnapshot = null;
        // Abort SDK cleanup before SIGNED_OUT can broadcast over a successor.
        if (readAuthItem(key) !== expected) {
          throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
        }
      }
      importedStorageKeys.add(key);
      if (key === effectiveStorageKey()) {
        if (activeRefreshAttempt) activeRefreshAttempt.commitGuardReadArmed = false;
        if (!removePersistentAuthItemConfirmed(key)) {
          // Persistent removal failed or could not be confirmed by reading the slot back.
          // Abort before GoTrueClient._removeSession() can announce SIGNED_OUT, and keep
          // memory/backoff intact so retries and fresh instances never believe removal succeeded.
          throw new AuthRetryableFetchError("Could not remove saved sign-in from browser storage", 0);
        }
        clearBackoffRecordLocked();
      } else {
        removePersistentAuthItem(key);
      }
      pendingStorageWrites.delete(key);
      removedStorageKeys.add(key);
      authMemory.delete(key);
      diskSnapshots.set(key, null);
    },
  };

  let restSessionCheck: Promise<unknown> | null = null;

  /**
   * After PostgREST says a session ended, check the SDK's CURRENT credential the identity-safe way
   * (verifiedSession: getUser under the SDK lock, which removes it only when GoTrue no longer knows
   * it). A refusal for an older token never removes a newer or another account's session. One check
   * at a time; the removal's SIGNED_OUT drives the page's signed-out view.
   */
  function checkSessionAfterRestRefusal(verify: () => Promise<unknown> = () => verifiedSession()): void {
    if (quiesced || restSessionCheck) return;
    restSessionCheck = Promise.resolve().then(verify).catch(() => undefined).finally(() => { restSessionCheck = null; });
  }

  function makeDiscardResponse(armCommitGuard: boolean, discardedRefreshToken: string | null): Response {
    // Returning a synthetic session payload carrying a per-attempt sentinel while
    // `_refreshAccessToken` arms `commitGuardReadArmed` for ONLY GoTrueClient._callRefreshToken's
    // post-request `storedAfter` check triggers GoTrue's built-in commit guard
    // (AuthRefreshDiscardedError): exits immediately on attempt 0 with zero backoff
    // retries, zero storage writes/removals, zero SIGNED_OUT broadcast, no 60s
    // lastRefreshFailure cache, and immediate Web Lock release. authStorage.setItem
    // independently fences any sentinel payload even when storedAtStart === null.
    lastDiscardedRefreshToken = discardedRefreshToken;
    const sentinel = nextDiscardSentinel();
    if (
      armCommitGuard &&
      activeRefreshAttempt !== null &&
      activeLockToken !== null &&
      activeRefreshAttempt.lockToken === activeLockToken
    ) {
      activeRefreshAttempt.discardSentinel = sentinel;
    }
    return new Response(
      JSON.stringify({
        access_token: sentinel,
        refresh_token: sentinel,
        expires_in: 1,
        token_type: "bearer",
        user: { id: sentinel },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  /** Adapt only refresh failures that the pinned SDK would otherwise destroy or retry
   * inside the cross-tab Web Lock. Backoff lives outside the lock in a shared storage
   * entry keyed by the non-secret credential generation (`session_id`, `user.id`, `expires_at`).
   */
  const authFetch: typeof fetch = async (input, init) => {
    const run = (async (): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const isRefresh = method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "refresh_token";
      const isUser = method === "GET" && url.pathname.endsWith("/auth/v1/user");
      const isLogout = method === "POST" && url.pathname.endsWith("/auth/v1/logout");
      if (quiesced) {
        if (isRefresh) return makeDiscardResponse(false, null);
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      if (isLogout) {
        return await fetch(input, { ...init, signal: AbortSignal.any([
          ...((init?.signal ?? (input instanceof Request ? input.signal : null))
            ? [init?.signal ?? (input as Request).signal] : []),
          quiesceController.signal,
          AbortSignal.timeout(4_000),
        ]) });
      }
      if (!isRefresh && !isUser) {
        const response = await fetch(input, init);
        if (url.pathname.includes("/rest/v1/") && await isRestSessionEnded(response)) checkSessionAfterRestRefusal();
        return response;
      }

      const targetKey = effectiveStorageKey();
      const savedAtStart = readAuthItem(targetKey);
      const savedCredential = savedSession(savedAtStart);
      let requestRefresh: string | null = null;
      if (isRefresh && typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body)?.refresh_token;
          if (typeof parsed === "string" && parsed.length > 0) requestRefresh = parsed;
        } catch { /* SDK owns request validation. */ }
      }
      const storedGen = credentialGenerationKey(savedCredential);

      if (isRefresh) {
        // Condition 3: refuse to put a refresh on the wire unless this client holds the
        // active tracked lock on the exact managed session slot with an active refresh
        // attempt scope bound to that lock token.
        const hasTrackedLockedAttempt = Boolean(
          activeRefreshAttempt !== null &&
          activeLockToken !== null &&
          activeRefreshAttempt.lockToken === activeLockToken &&
          activeRefreshAttempt.storageKey === defaultStorageKey &&
          authClientRef?.lockAcquired === true,
        );
        if (!hasTrackedLockedAttempt) {
          return makeDiscardResponse(false, requestRefresh);
        }
        // Condition 3: require the managed slot (or current in-memory managed credential when
        // disk is unreadable) to hold a session whose refresh token matches the parsed request
        // token. Discard before the network when empty, unreadable without memory, unparseable,
        // or mismatched.
        if (
          savedCredential === null ||
          requestRefresh === null ||
          savedCredential.refresh_token !== requestRefresh
        ) {
          reconcileBackoffOnDiskLocked(storedGen);
          return makeDiscardResponse(savedCredential !== null, requestRefresh);
        }
        // Clean up any stale/mismatched backoff record on disk under the active lock.
        reconcileBackoffOnDiskLocked(storedGen);
        // Cross-tab backoff outside the lock: during an active window for this credential generation,
        // exit immediately through the discard path with zero network I/O and zero lock sleep.
        const existingBackoff = readBackoffRecord(storedGen);
        if (
          existingBackoff &&
          Date.now() < existingBackoff.nextAttemptAt
        ) {
          return makeDiscardResponse(true, requestRefresh);
        }
      }

      const access = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        .get("authorization")?.replace(/^Bearer /i, "");
      let response: Response;
      try {
        response = await fetch(input, { ...init, signal: AbortSignal.any([
          ...((init?.signal ?? (input instanceof Request ? input.signal : null))
            ? [init?.signal ?? (input as Request).signal] : []),
          quiesceController.signal,
          AbortSignal.timeout(4_000),
        ]) });
      } catch (error) {
        if (quiesced) {
          if (isRefresh) return makeDiscardResponse(false, null);
          throw new AuthRetryableFetchError("Session quiesced", 0);
        }
        if (isRefresh) {
          const currentRaw = readAuthItem(targetKey);
          const currentCred = savedSession(currentRaw);
          const currentGen = credentialGenerationKey(currentCred);
          const sameCurrent = Boolean(
            savedAtStart &&
            currentRaw === savedAtStart &&
            savedCredential?.refresh_token === requestRefresh &&
            currentCred?.refresh_token === requestRefresh,
          );
          if (sameCurrent && storedGen !== null) {
            recordBackoffFailureLocked(storedGen, null);
          } else {
            reconcileBackoffOnDiskLocked(currentGen);
          }
          return makeDiscardResponse(true, requestRefresh);
        }
        throw error;
      }
      if (quiesced) {
        if (isRefresh) return makeDiscardResponse(false, null);
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      if (response.ok) {
        if (isRefresh) {
          clearBackoffRecordLocked();
          lastDiscardedRefreshToken = null;
          // auth-js's storedAfter guard discards a peer replacement/logout without
          // re-sending the now-consumed predecessor or entering a retry cooldown.
        } else if (isUser && activeLockToken !== null && activeUserCheck !== null) {
          // Condition 4: bind verifiedSession success to the exact access token checked by GoTrue.
          activeUserCheck.verifiedAccessToken = access ?? null;
        }
        return response;
      }
      const body = await response.clone().json().catch(() => null);
      if (quiesced) {
        if (isRefresh) return makeDiscardResponse(false, null);
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      // Match auth-js's versioned GoTrue error contract.
      const version = response.headers.get("x-supabase-api-version");
      const code = version && version >= "2024-01-01" && typeof body?.code === "string"
        ? body.code : body?.error_code;
      const terminal = [400, 401, 403, 404].includes(response.status) && terminalRefreshCodes.has(code);

      if (isRefresh) {
        const currentRaw = readAuthItem(targetKey);
        const currentCred = savedSession(currentRaw);
        const currentGen = credentialGenerationKey(currentCred);
        const credentialMatches = Boolean(
          savedAtStart &&
          currentRaw === savedAtStart &&
          savedCredential?.refresh_token === requestRefresh &&
          currentCred?.refresh_token === requestRefresh,
        );
        if (!credentialMatches) {
          // Condition 2: credential changed, rotated, or cleared (even on terminal refusal).
          // Do not back off, overwrite, remove, or announce; exit via discard.
          reconcileBackoffOnDiskLocked(currentGen);
          return makeDiscardResponse(true, requestRefresh);
        }
        if (terminal) {
          // Confirmed terminal refusal for the still-current stored credential.
          clearBackoffRecordLocked();
          if (savedCredential?.expires_at && savedCredential.expires_at * 1000 <= Date.now()) {
            removalSnapshot = savedAtStart;
          }
          return response;
        }
        // Non-terminal refusal (400 refresh_token_already_used, 429, 5xx, etc.):
        // record external backoff honoring Retry-After and release the lock via discard.
        if (storedGen !== null) {
          recordBackoffFailureLocked(storedGen, response.headers.get("retry-after"));
        }
        return makeDiscardResponse(true, requestRefresh);
      }

      // isUser path
      const matches = savedCredential?.access_token === access;
      if (terminal && (!matches || !savedAtStart || readAuthItem(targetKey) !== savedAtStart)) {
        throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
      }
      if (terminal && code === "session_not_found") {
        removalSnapshot = savedAtStart;
      }
      return response;
    })();
    activeAuthFetches.add(run);
    try {
      return await run;
    } finally {
      activeAuthFetches.delete(run);
    }
  };

  // Select navigatorLock when Web Locks exist, or processLock where allowProcessLockFallback
  // permits it (already gated above). Both lock implementations run through trackedLock so
  // activeLockToken tracks lock ownership identically for both Web Locks and processLock.
  const baseLock = hasWebLocks() ? navigatorLock : processLock;
  const trackedLock: typeof navigatorLock = (name, acquireTimeout, fn) => {
    if (quiesced) {
      return Promise.resolve(undefined as never);
    }
    return baseLock(name, acquireTimeout, async () => {
      if (quiesced) {
        return undefined as never;
      }
      if (name !== expectedLockName) {
        return await fn();
      }
      const token = Symbol("session-lock");
      activeLockToken = token;
      try {
        return await fn();
      } finally {
        if (activeLockToken === token) {
          activeLockToken = null;
        }
        retireRefreshAttemptForLock(token);
      }
    });
  };

  const client = createClient(options.url, options.anonKey, {
    global: { fetch: authFetch },
    auth: {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: options.detectSessionInUrl,
      storage: authStorage,
      lockAcquireTimeout: -1,
      // 2.111.0 defaults to lockless auth. Opt into the public SDK lock hook:
      // getUser's terminal removal and refresh must serialize with other tabs.
      lock: trackedLock,
    },
  });

  // Synchronously validate the created SDK instance BEFORE any microtask runs.
  // If the runtime client does not match the pinned 2.111.0 shape, version, or exact
  // managed storage slot, fail closed immediately: neutralize & tear down the instance
  // and hand out no client.
  const authClient = (client as unknown as { auth?: InternalAuthClientShape } | null)?.auth ?? null;
  const clientHeaders = (client as unknown as { headers?: Record<string, unknown> } | null)?.headers;
  const clientInfo = clientHeaders?.["X-Client-Info"] ?? authClient?.headers?.["X-Client-Info"];
  const pinnedVersionRe = new RegExp(
    `^supabase-js/${PINNED_SUPABASE_JS_VERSION.replace(/\./g, "\\.")}(?:$|[^0-9.])`,
  );
  const supportedInstance = Boolean(
    client &&
    typeof client === "object" &&
    authClient &&
    typeof authClient === "object" &&
    typeof authClient.storageKey === "string" &&
    authClient.storageKey === defaultStorageKey &&
    typeof authClient._emitInitialSession === "function" &&
    typeof authClient.onAuthStateChange === "function" &&
    typeof authClient._callRefreshToken === "function" &&
    typeof authClient._refreshAccessToken === "function" &&
    typeof authClient._acquireLock === "function" &&
    typeof authClient._removeSession === "function" &&
    typeof authClient.admin?.signOut === "function" &&
    "lockAcquired" in authClient &&
    "refreshingDeferred" in authClient &&
    typeof clientInfo === "string" &&
    pinnedVersionRe.test(clientInfo),
  );
  if (!supportedInstance || !authClient) {
    quiesced = true;
    retireRefreshAttempt();
    quiesceController.abort();
    if (typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("storage", onStorage);
    }
    if (authClient && typeof authClient === "object") {
      if (typeof authClient._emitInitialSession === "function") {
        authClient._emitInitialSession = async () => {};
      }
      if ("autoRefreshToken" in authClient) {
        authClient.autoRefreshToken = false;
      }
      // Keep `trackedLock` attached (not null): while `quiesced === true`, `trackedLock`
      // short-circuits without acquiring any lock or executing `fn`, preventing GoTrue's
      // unawaited constructor IIFE from falling into its unlocked `else` branch.
      if (typeof authClient.dispose === "function") {
        void Promise.resolve().then(() => authClient.dispose!()).catch(() => undefined);
      } else if (typeof authClient.stopAutoRefresh === "function") {
        void Promise.resolve().then(() => authClient.stopAutoRefresh!()).catch(() => undefined);
      }
    }
    return { ok: false, reason: "unsupported_sdk" };
  }
  const verifiedAuthClient: InternalAuthClientShape = authClient;
  authClientRef = verifiedAuthClient;

  // 2.111.0 also defaults PostgREST GET queries to 3 exponential-backoff retries (1s/2s/4s);
  // keep single-attempt reads so readWithDeadline and explicit UI retry controls own recovery.
  if ((client as unknown as { rest?: { retry?: boolean } }).rest) {
    (client as unknown as { rest: { retry: boolean } }).rest.retry = false;
  }

  // Condition 4 (lock-safe subscription, pinned to @supabase/auth-js 2.111.0):
  // GoTrueClient.onAuthStateChange invokes `_emitInitialSession` unawaited inside its
  // `_acquireLock` callback (`GoTrueClient.ts:4324-4326`), and SupabaseClient's constructor
  // registers an internal listener before createClient() returns (`SupabaseClient.ts:411->660`).
  // Synchronously neutralize `_emitInitialSession` before any microtask runs, scope the
  // discard commit-guard marker to `_callRefreshToken`/`_refreshAccessToken` with `finally`
  // retirement, register one real SDK listener, and route all subsequent subscriptions
  // through our fan-out so no subscription starts an implicit unlocked session load.
  authClient._emitInitialSession = async () => {};

  function makeRefreshDiscardResult(message: string): { data: null; error: Error } {
    const discarded = new AuthRetryableFetchError(message, 0);
    discarded.name = "AuthRefreshDiscardedError";
    return { data: null, error: discarded };
  }

  const origCallRefreshToken = authClient._callRefreshToken!.bind(client.auth);
  const origRefreshAccessToken = authClient._refreshAccessToken!.bind(client.auth);
  authClient._callRefreshToken = async (refreshToken: string) => {
    const lockToken = activeLockToken;
    // Condition 3: refuse any refresh attempt outside this client's active tracked lock,
    // or when the managed slot does not hold a credential matching `refreshToken`.
    // Ends immediately through the discard error shape with zero wire requests, zero
    // storage mutations, zero events, and without arming the commit-guard read marker.
    if (quiesced || lockToken === null || authClient.lockAcquired !== true) {
      return makeRefreshDiscardResult("Refresh attempt refused outside active session lock");
    }
    const currentCred = currentStoredSession();
    const currentGen = credentialGenerationKey(currentCred);
    if (
      currentCred === null ||
      typeof refreshToken !== "string" ||
      refreshToken.length === 0 ||
      currentCred.refresh_token !== refreshToken
    ) {
      reconcileBackoffOnDiskLocked(currentGen);
      lastDiscardedRefreshToken =
        typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null;
      return makeRefreshDiscardResult("Refresh attempt refused without matching managed credential");
    }
    // Re-entrant call while a refresh is already active under this lock dedupes via
    // GoTrue's `refreshingDeferred`; preserve the outermost attempt scope.
    if (activeRefreshAttempt !== null) {
      if (activeRefreshAttempt.lockToken !== lockToken) {
        return makeRefreshDiscardResult("Refresh attempt refused outside active session lock");
      }
      return origCallRefreshToken(refreshToken);
    }
    const attempt: RefreshAttemptScope = {
      id: Symbol("refresh-attempt"),
      lockToken,
      storageKey: defaultStorageKey,
      discardSentinel: null,
      commitGuardReadArmed: false,
    };
    activeRefreshAttempt = attempt;
    try {
      return await origCallRefreshToken(refreshToken);
    } finally {
      retireRefreshAttempt(attempt);
    }
  };
  authClient._refreshAccessToken = async (refreshToken: string) => {
    const result = await origRefreshAccessToken(refreshToken);
    const attempt = activeRefreshAttempt;
    if (
      !quiesced &&
      attempt !== null &&
      activeLockToken !== null &&
      attempt.lockToken === activeLockToken &&
      attempt.discardSentinel !== null &&
      !result?.error &&
      result?.data?.session &&
      result.data.session.access_token === attempt.discardSentinel
    ) {
      attempt.commitGuardReadArmed = true;
    }
    return result;
  };

  const authListeners = new Map<
    string,
    (event: AuthChangeEvent, session: Session | null) => void | Promise<void>
  >();
  let nextAuthListenerId = 0;
  const origOnAuthStateChange = authClient.onAuthStateChange!.bind(client.auth);
  origOnAuthStateChange((event, session) => {
    if (quiesced) return;
    if (session && isSentinelSession(session)) return;
    for (const cb of [...authListeners.values()]) {
      try {
        const res = cb(event, session);
        if (res && typeof (res as Promise<unknown>).catch === "function") {
          void (res as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // Isolate subscriber errors so remaining listeners still receive the event.
      }
    }
  });
  authClient.onAuthStateChange = ((callback) => {
    const id = `cs-auth-listener-${++nextAuthListenerId}`;
    if (!quiesced) {
      authListeners.set(id, callback);
    }
    const subscription = {
      id,
      callback,
      unsubscribe: () => {
        authListeners.delete(id);
      },
    };
    return { data: { subscription } };
  }) as typeof client.auth.onAuthStateChange;

  client.auth.onAuthStateChange((event) => {
    // Condition 1: SDK auth events (including delayed cross-tab BroadcastChannel
    // messages forwarded outside the lock) are read-only hints. Never mutate the
    // shared durable backoff record here; re-read current storage and preserve any
    // active backoff matching the current stored credential.
    if (event === "SIGNED_OUT") {
      deadSession = false;
      removalSnapshot = null;
      signOutRemovalGuard = null;
      lastDiscardedRefreshToken = null;
      syncMemoryBackoffFromStorage(credentialGenerationKey(currentStoredSession()));
    } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
      deadSession = false;
      lastDiscardedRefreshToken = null;
      syncMemoryBackoffFromStorage(credentialGenerationKey(currentStoredSession()));
    }
  });

  async function runSerializedUserCheck(): Promise<{
    userResult: Awaited<ReturnType<typeof client.auth.getUser>>;
    verifiedAccessToken: string | null;
  }> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = userCheckChain;
    userCheckChain = prev.then(() => next);
    await prev;
    if (quiesced) {
      release();
      throw new AuthRecoveryRequired();
    }
    const scope = { verifiedAccessToken: null as string | null };
    activeUserCheck = scope;
    try {
      const userResult = await client.auth.getUser();
      return { userResult, verifiedAccessToken: scope.verifiedAccessToken };
    } finally {
      if (activeUserCheck === scope) activeUserCheck = null;
      release();
    }
  }

  async function verifiedSession(): Promise<Session | null> {
    if (quiesced) throw new AuthRecoveryRequired();
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (quiesced) throw new AuthRecoveryRequired();
      let session: Session | null = data.session ?? null;
      if (sessionError) {
        if (isRefreshDiscardedError(sessionError)) {
          const storedNow = currentStoredSession();
          if (storedNow === null) {
            // Slot cleared mid-flight (e.g. concurrent sign-out): load once so callers
            // run their existing missing-session retirement path.
            const reloaded = await client.auth.getSession();
            if (quiesced) throw new AuthRecoveryRequired();
            if (reloaded.error) {
              if (isAuthSessionMissingError(reloaded.error) || terminalRefreshCodes.has(reloaded.error.code ?? "")) {
                const successor = await client.auth.getSession();
                if (successor.data.session) throw new AuthRecoveryRequired(currentBackoffRetryAfter(successor.data.session));
                throw new SessionExpired();
              }
              throw new AuthRecoveryRequired(currentBackoffRetryAfter());
            }
            session = reloaded.data.session ?? null;
          } else if (
            storedNow.refresh_token !== lastDiscardedRefreshToken &&
            (isUnexpiredSession(storedNow) || currentBackoffRetryAfter(storedNow) === undefined)
          ) {
            // Stored slot now holds a different credential (rotation or replacement login):
            // read once under the lock and proceed to the single getUser() verification below.
            const reloaded = await client.auth.getSession();
            if (quiesced) throw new AuthRecoveryRequired();
            if (reloaded.error) {
              if (isAuthSessionMissingError(reloaded.error) || terminalRefreshCodes.has(reloaded.error.code ?? "")) {
                const successor = await client.auth.getSession();
                if (successor.data.session) throw new AuthRecoveryRequired(currentBackoffRetryAfter(successor.data.session));
                throw new SessionExpired();
              }
              throw new AuthRecoveryRequired(currentBackoffRetryAfter());
            }
            session = reloaded.data.session ?? null;
          } else {
            throw new AuthRecoveryRequired(currentBackoffRetryAfter(storedNow));
          }
        } else if (isAuthSessionMissingError(sessionError) || terminalRefreshCodes.has(sessionError.code ?? "")) {
          const successor = await client.auth.getSession();
          if (successor.data.session) throw new AuthRecoveryRequired(currentBackoffRetryAfter(successor.data.session));
          throw new SessionExpired();
        } else {
          throw new AuthRecoveryRequired(currentBackoffRetryAfter());
        }
      }
      if (!session) {
        if (deadSession) throw new SessionExpired();
        return null;
      }
      // No explicit JWT: the SDK reads and verifies the current credential while
      // holding its lock, including terminal removal. A stale caller cannot clear a
      // successor by validating an old token outside that lock.
      // Condition 4: bind success to the exact access credential checked by GET /auth/v1/user.
      // If a different access credential (e.g. a same-user replacement login with a new
      // session_id) lands between getUser() and getSession(), verify THAT credential
      // directly up to a small fixed bound before releasing it.
      const MAX_VERIFICATION_ATTEMPTS = 3;
      let candidateSession: Session = session;
      for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
        const { userResult, verifiedAccessToken } = await runSerializedUserCheck();
        if (quiesced) throw new AuthRecoveryRequired();
        const { data: userData, error } = userResult;
        const latest = await client.auth.getSession();
        if (quiesced) throw new AuthRecoveryRequired();
        if (error) {
          if (latest.data.session && !sameCredentials(candidateSession, latest.data.session)) {
            throw new AuthRecoveryRequired(currentBackoffRetryAfter(latest.data.session));
          }
          if (isAuthSessionMissingError(error)) { deadSession = true; throw new SessionExpired(); }
          throw new AuthRecoveryRequired(currentBackoffRetryAfter());
        }
        if (latest.error || !latest.data.session || !userData.user) {
          throw new AuthRecoveryRequired(currentBackoffRetryAfter(latest.data.session));
        }
        if (
          verifiedAccessToken !== null &&
          latest.data.session.access_token === verifiedAccessToken &&
          userData.user.id === latest.data.session.user.id
        ) {
          deadSession = false;
          return latest.data.session;
        }
        candidateSession = latest.data.session;
      }
      throw new AuthRecoveryRequired(currentBackoffRetryAfter());
    } catch (error) {
      if (error instanceof SessionExpired || error instanceof AuthRecoveryRequired) throw error;
      // Lock contention and storage/transport exceptions also leave saved auth
      // intact. They must reach the initial-load retry panel, not sign-in controls.
      throw new AuthRecoveryRequired(currentBackoffRetryAfter());
    }
  }

  function currentSession(): Promise<Session | null> {
    return boundedAuth(verifiedSession());
  }

  async function signOut(signOutOptions?: BrowserSignOutOptions): Promise<BrowserSignOutResult> {
    if (quiesced) {
      return { signedOutLocally: false, serverRevoked: false, replaced: false, retry: false };
    }
    deadSession = false;
    const scope = signOutOptions?.scope ?? "local";
    const targetKey = effectiveStorageKey();
    // Capture the initiating login's identity before awaiting initialization or the lock.
    // Never adopt a durable successor as the initiating login if this tab's local view is stale.
    const initialLocalCred = savedSession(readAuthItem(targetKey));
    const expectedUserId =
      signOutOptions?.expected?.userId?.trim() || initialLocalCred?.user?.id?.trim() || null;
    const expectedSessionId =
      signOutOptions?.expected?.sessionId?.trim() ||
      sessionIdFromAccessToken(initialLocalCred?.access_token) ||
      null;
    const initiatingRefreshToken =
      initialLocalCred !== null &&
      (expectedUserId === null || initialLocalCred.user?.id === expectedUserId) &&
      (expectedSessionId === null || sessionIdFromAccessToken(initialLocalCred.access_token) === expectedSessionId)
        ? initialLocalCred.refresh_token
        : null;

    const matchesInitiatingLogin = (cred: Session | null): boolean => {
      if (!cred) return false;
      if (expectedUserId !== null && cred.user?.id !== expectedUserId) return false;
      const credSid = sessionIdFromAccessToken(cred.access_token);
      if (expectedSessionId !== null) {
        return credSid === expectedSessionId;
      }
      if (initiatingRefreshToken !== null) {
        return cred.refresh_token === initiatingRefreshToken;
      }
      return false;
    };

    if (verifiedAuthClient.initializePromise) {
      await Promise.resolve(verifiedAuthClient.initializePromise).catch(() => undefined);
    }
    if (quiesced) {
      return { signedOutLocally: false, serverRevoked: false, replaced: false, retry: false };
    }

    return await verifiedAuthClient._acquireLock!(-1, async () => {
      if (quiesced) {
        return { signedOutLocally: false, serverRevoked: false, replaced: false, retry: false };
      }

      // Authoritatively identify the durable slot directly from persistent storage under the lock
      // before any server logout or deletion. Never trust a stale in-memory or reconciled view.
      const durableBeforeLogout = readDurableSlot(targetKey);
      if (durableBeforeLogout.status === "unreadable") {
        return { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true };
      }
      if (durableBeforeLogout.status === "empty") {
        acceptPersistentAuthItem(targetKey, null);
        clearBackoffRecordLocked();
        deadSession = false;
        return { signedOutLocally: scope !== "others", serverRevoked: false, replaced: false, retry: false };
      }
      if (durableBeforeLogout.session === null) {
        return { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true };
      }
      if (!matchesInitiatingLogin(durableBeforeLogout.session)) {
        removedStorageKeys.delete(targetKey);
        acceptPersistentAuthItem(targetKey, durableBeforeLogout.raw);
        return { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false };
      }

      let serverRevoked = false;
      const accessToken = durableBeforeLogout.session.access_token;
      if (
        typeof accessToken === "string" &&
        accessToken.length > 0 &&
        isUnexpiredSession(durableBeforeLogout.session)
      ) {
        try {
          const { error } = await verifiedAuthClient.admin!.signOut!(accessToken, scope);
          if (!error) {
            serverRevoked = true;
          }
        } catch {
          serverRevoked = false;
        }
      }

      if (quiesced) {
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: false };
      }
      if (scope === "others") {
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: false };
      }

      // Re-identify the durable slot directly under the lock after the network logout call
      // before touching persistent storage.
      const durableBeforeRemove = readDurableSlot(targetKey);
      if (durableBeforeRemove.status === "unreadable") {
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: true };
      }
      if (durableBeforeRemove.status === "empty") {
        acceptPersistentAuthItem(targetKey, null);
        clearBackoffRecordLocked();
        deadSession = false;
        return { signedOutLocally: true, serverRevoked, replaced: false, retry: false };
      }
      if (durableBeforeRemove.session === null) {
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: true };
      }
      if (!matchesInitiatingLogin(durableBeforeRemove.session)) {
        removedStorageKeys.delete(targetKey);
        acceptPersistentAuthItem(targetKey, durableBeforeRemove.raw);
        return { signedOutLocally: false, serverRevoked, replaced: true, retry: false };
      }
      if (activeLockToken === null) {
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: true };
      }

      // Guard local removal with the durable read captured under this lock so authStorage.removeItem
      // re-verifies persistent storage directly against this sign-out's durable bytes and identity
      // before calling persistent removeItem or letting _removeSession announce SIGNED_OUT.
      signOutRemovalGuard = {
        lockToken: activeLockToken,
        expectedDurableRaw: durableBeforeRemove.raw,
        matchesInitiating: matchesInitiatingLogin,
      };
      try {
        await verifiedAuthClient._removeSession!();
      } catch {
        signOutRemovalGuard = null;
        const durableAfter = readDurableSlot(targetKey);
        if (durableAfter.status === "empty") {
          acceptPersistentAuthItem(targetKey, null);
          clearBackoffRecordLocked();
          deadSession = false;
          return { signedOutLocally: true, serverRevoked, replaced: false, retry: false };
        }
        if (
          durableAfter.status === "present" &&
          durableAfter.session !== null &&
          !matchesInitiatingLogin(durableAfter.session)
        ) {
          removedStorageKeys.delete(targetKey);
          acceptPersistentAuthItem(targetKey, durableAfter.raw);
          return { signedOutLocally: false, serverRevoked, replaced: true, retry: false };
        }
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: true };
      } finally {
        signOutRemovalGuard = null;
      }
      const durableAfterRemove = readDurableSlot(targetKey);
      if (durableAfterRemove.status !== "empty") {
        if (
          durableAfterRemove.status === "present" &&
          durableAfterRemove.session !== null &&
          !matchesInitiatingLogin(durableAfterRemove.session)
        ) {
          removedStorageKeys.delete(targetKey);
          acceptPersistentAuthItem(targetKey, durableAfterRemove.raw);
          return { signedOutLocally: false, serverRevoked, replaced: true, retry: false };
        }
        return { signedOutLocally: false, serverRevoked, replaced: false, retry: true };
      }
      deadSession = false;
      return { signedOutLocally: true, serverRevoked, replaced: false, retry: false };
    });
  }

  function quiesce(): Promise<void> {
    if (quiescePromise) return quiescePromise;
    quiesced = true;
    retireRefreshAttempt();
    memoryBackoff = null;
    memoryBackoffWriteRefused = false;
    removalSnapshot = null;
    signOutRemovalGuard = null;
    authListeners.clear();
    pendingStorageWrites.clear();
    if (storageRetryTimer !== undefined) {
      clearTimeout(storageRetryTimer);
      storageRetryTimer = undefined;
    }
    if (typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("storage", onStorage);
    }
    quiesceController.abort();

    const authApi = client.auth as unknown as {
      dispose?: () => Promise<void>;
      stopAutoRefresh?: () => Promise<void>;
      initializePromise?: Promise<unknown> | null;
      autoRefreshToken?: boolean;
      lock?: unknown;
    };
    // Prevent a still-pending `_initialize()` from arming a new auto-refresh interval
    // or 0ms tick timeout when its `finally` block calls `_handleVisibilityChange()`,
    // and prevent post-init untracked `onAuthStateChange` `_emitInitialSession` IIFEs
    // (`GoTrueClient.ts:4319-4330`) or any other callback on this closed instance from
    // acquiring the shared Web Lock after `quiesce()` begins.
    if ("autoRefreshToken" in authApi) {
      authApi.autoRefreshToken = false;
    }
    if ("lock" in authApi) {
      authApi.lock = null;
    }
    const runSdkDispose = (): Promise<void> =>
      typeof authApi.dispose === "function"
        ? authApi.dispose()
        : typeof authApi.stopAutoRefresh === "function"
          ? authApi.stopAutoRefresh()
          : Promise.resolve();

    const runRealtimeTeardown = (): Promise<void> => {
      const realtimeApi = (
        client as unknown as {
          getChannels?: () => unknown[];
          removeAllChannels?: () => Promise<unknown>;
          realtime?: {
            getChannels?: () => unknown[];
            removeAllChannels?: () => Promise<unknown>;
            disconnect?: () => Promise<unknown>;
            isConnected?: () => boolean;
            isConnecting?: () => boolean;
            connectionState?: () => string;
          };
        }
      );
      const rt = realtimeApi.realtime;
      const channels =
        typeof realtimeApi.getChannels === "function"
          ? realtimeApi.getChannels()
          : typeof rt?.getChannels === "function"
            ? rt.getChannels()
            : [];
      const hasSocketActivity =
        (Array.isArray(channels) && channels.length > 0) ||
        Boolean(rt?.isConnected?.()) ||
        Boolean(rt?.isConnecting?.()) ||
        (typeof rt?.connectionState === "function" && rt.connectionState() !== "closed");
      if (!hasSocketActivity) {
        return Promise.resolve();
      }
      try {
        if (typeof realtimeApi.removeAllChannels === "function") {
          return Promise.resolve(realtimeApi.removeAllChannels()).then(() => undefined, () => undefined);
        }
        if (typeof rt?.removeAllChannels === "function") {
          return Promise.resolve(rt.removeAllChannels()).then(() => undefined, () => undefined);
        }
        if (typeof rt?.disconnect === "function") {
          return Promise.resolve(rt.disconnect()).then(() => undefined, () => undefined);
        }
      } catch {
        return Promise.resolve();
      }
      return Promise.resolve();
    };

    // Immediate teardown closes BroadcastChannel, clears auth listeners, drops realtime channels/sockets,
    // and stops any already-registered visibility listener or auto-refresh timer right away.
    const initialDispose = runSdkDispose();
    const initialRealtimeTeardown = runRealtimeTeardown();

    // `_initialize()` unconditionally calls `_handleVisibilityChange()` in its `finally`
    // (`GoTrueClient.ts`), which attaches a new `visibilitychange` listener on `window`
    // and (if auto-refresh is still enabled) starts `_startAutoRefresh()` without awaiting it.
    // Wait for `initializePromise` to settle, flush microtasks in the same turn so any
    // unawaited `_startAutoRefresh()` finishes assigning its timer handles, then dispose again.
    const initTeardown = (async () => {
      if (!authApi.initializePromise) return;
      await Promise.allSettled([authApi.initializePromise]);
      await Promise.resolve();
      await Promise.resolve();
      await runSdkDispose();
    })();

    quiescePromise = (async () => {
      await Promise.allSettled([
        initialDispose,
        initialRealtimeTeardown,
        initTeardown,
        ...activeAuthFetches,
        ...(activeStorageRetry ? [activeStorageRetry] : []),
        ...(restSessionCheck ? [restSessionCheck] : []),
      ]);
      // Final idempotent teardown after every in-flight operation has settled.
      await runSdkDispose();
      await runRealtimeTeardown();
      // Allow any SDK lock callback catching our abort/quiesce error to finish its finally block.
      await Promise.resolve();
    })();
    return quiescePromise;
  }

  return {
    ok: true,
    client,
    storageKey: sessionStorageKeyForDeployment(options.url),
    currentSession,
    verifiedSession,
    boundedAuth,
    signOut,
    quiesce,
  };
}
