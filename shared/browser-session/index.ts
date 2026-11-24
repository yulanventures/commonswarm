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
    } else if (typeof Buffer !== "undefined") {
      json = Buffer.from(padded, "base64").toString("utf8");
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
    if (Number.isFinite(secs)) return secs * 1000;
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

export interface BrowserSession {
  readonly ok: true;
  readonly client: SupabaseClient;
  readonly storageKey: string;
  currentSession(): Promise<Session | null>;
  verifiedSession(): Promise<Session | null>;
  boundedAuth<T>(operation: Promise<T>): Promise<T>;
  signOut(): Promise<void>;
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
  const backoffStorageKey = refreshBackoffStorageKeyForDeployment(options.url);
  let sessionStorageKey: string | null = null;
  const effectiveStorageKey = (): string => sessionStorageKey ?? defaultStorageKey;
  let removalSnapshot: string | null = null;
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

  function parseBackoffRecord(raw: string | null, now: number): RefreshBackoffRecord | null {
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
        nextAttemptAt: Math.min(parsed.nextAttemptAt, now + REFRESH_BACKOFF_CAP_MS),
        attempts: parsed.attempts,
      };
    } catch {
      return null;
    }
  }

  function clearBackoffRecord(): void {
    memoryBackoff = null;
    if (readPersistentAuthItem(backoffStorageKey) !== null) {
      try { globalThis.localStorage?.removeItem(backoffStorageKey); } catch { /* ignore storage errors */ }
    }
  }

  function syncMemoryBackoffFromDisk(): void {
    const raw = readPersistentAuthItem(backoffStorageKey);
    if (raw === undefined) return;
    if (raw === null) {
      memoryBackoff = null;
      return;
    }
    const parsed = parseBackoffRecord(raw, Date.now());
    if (!parsed) {
      clearBackoffRecord();
      return;
    }
    memoryBackoff = parsed;
  }

  function readBackoffRecord(expectedGen: string | null): RefreshBackoffRecord | null {
    const now = Date.now();
    const raw = readPersistentAuthItem(backoffStorageKey);
    if (raw === null) {
      memoryBackoff = null;
      return null;
    }
    if (raw === undefined) {
      if (!memoryBackoff) return null;
      if (!expectedGen || memoryBackoff.gen !== expectedGen) {
        memoryBackoff = null;
        return null;
      }
      return {
        gen: memoryBackoff.gen,
        nextAttemptAt: Math.min(memoryBackoff.nextAttemptAt, now + REFRESH_BACKOFF_CAP_MS),
        attempts: memoryBackoff.attempts,
      };
    }
    const parsed = parseBackoffRecord(raw, now);
    if (!parsed || !expectedGen || parsed.gen !== expectedGen) {
      clearBackoffRecord();
      return null;
    }
    memoryBackoff = parsed;
    return parsed;
  }

  function recordBackoffFailure(gen: string, retryAfterHeader: string | null): RefreshBackoffRecord {
    const now = Date.now();
    const existing = readBackoffRecord(gen);
    const attempts = (existing?.attempts ?? 0) + 1;
    const expDelay = Math.min(
      REFRESH_BACKOFF_BASE_MS * (2 ** Math.min(attempts - 1, 10)),
      REFRESH_BACKOFF_CAP_MS,
    );
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
    const rawDelay = retryAfterMs !== null ? Math.max(expDelay, retryAfterMs) : expDelay;
    const delayMs = Math.min(Math.max(rawDelay, REFRESH_BACKOFF_FLOOR_MS), REFRESH_BACKOFF_CAP_MS);
    const record: RefreshBackoffRecord = {
      gen,
      nextAttemptAt: now + delayMs,
      attempts,
    };
    memoryBackoff = record;
    try {
      globalThis.localStorage?.setItem(backoffStorageKey, JSON.stringify(record));
    } catch { /* memory fallback still bounds this tab */ }
    return record;
  }

  function reconcileBackoffWithCredential(currentGen: string | null): void {
    const raw = readPersistentAuthItem(backoffStorageKey);
    if (raw === null) {
      memoryBackoff = null;
      return;
    }
    if (raw === undefined) {
      if (memoryBackoff && (currentGen === null || memoryBackoff.gen !== currentGen)) {
        memoryBackoff = null;
      }
      return;
    }
    const parsed = parseBackoffRecord(raw, Date.now());
    if (!parsed || currentGen === null || parsed.gen !== currentGen) {
      clearBackoffRecord();
      return;
    }
    memoryBackoff = parsed;
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
        const lock = hasWebLocks()
          ? navigatorLock
          : options.allowProcessLockFallback
            ? processLock
            : null;
        if (!lock) return;
        for (const [key, pending] of pendingStorageWrites) {
          if (quiesced) return;
          // A fresh sign-in identifies its SDK key before the first successful read.
          // Try once without waiting or stealing; a busy owner gets the next tick.
          try {
            await lock(`lock:${sessionStorageKey ?? key}`, 0, async () => {
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
    const value = authMemory.get(key) ?? null;
    if (savedSession(value)) sessionStorageKey = key;
    return value;
  }

  function currentStoredSession(): Session | null {
    return savedSession(readAuthItem(effectiveStorageKey()));
  }

  function currentBackoffRetryAfter(session?: Session | null): number | undefined {
    const cred = session === undefined ? currentStoredSession() : session;
    if (!cred) return undefined;
    const record = readBackoffRecord(credentialGenerationKey(cred));
    return record && record.nextAttemptAt > Date.now() ? record.nextAttemptAt : undefined;
  }

  const onStorage = (event: StorageEvent): void => {
    if (quiesced) return;
    if (event.storageArea !== globalThis.localStorage) return;
    const targetSessionKey = effectiveStorageKey();
    if (event.key === null || event.key === backoffStorageKey) {
      syncMemoryBackoffFromDisk();
    }
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
      if (key === targetSessionKey) {
        const nextSession = savedSession(value ?? null);
        reconcileBackoffWithCredential(credentialGenerationKey(nextSession));
      }
    }
  };

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("storage", onStorage);
  }

  function removePersistentAuthItem(key: string): void {
    // Explicit logout and matching terminal proof still remove persistent auth,
    // even when the write probe failed.
    try { globalThis.localStorage?.removeItem(key); }
    catch { persistentStorage = null; }
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
      if (nextSession) sessionStorageKey = key;
      if (key === sessionStorageKey) removalSnapshot = null;
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
        reconcileBackoffWithCredential(credentialGenerationKey(nextSession));
      }
      scheduleStorageRetry();
    },
    removeItem(key: string): void {
      if (quiesced) {
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      if (key === sessionStorageKey && removalSnapshot !== null) {
        const expected = removalSnapshot;
        removalSnapshot = null;
        // Abort SDK cleanup before SIGNED_OUT can broadcast over a successor.
        if (readAuthItem(key) !== expected) {
          throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
        }
      }
      if (key === effectiveStorageKey()) {
        if (activeRefreshAttempt) activeRefreshAttempt.commitGuardReadArmed = false;
        clearBackoffRecord();
      }
      importedStorageKeys.add(key);
      pendingStorageWrites.delete(key);
      removedStorageKeys.add(key);
      authMemory.delete(key);
      removePersistentAuthItem(key);
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
      if (quiesced) {
        if (isRefresh) return makeDiscardResponse(false, null);
        throw new AuthRetryableFetchError("Session quiesced", 0);
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
        // Condition 2: if storage already holds a different credential than the request token,
        // abandon without touching the network or recording backoff.
        if (savedCredential !== null && requestRefresh !== null && savedCredential.refresh_token !== requestRefresh) {
          reconcileBackoffWithCredential(storedGen);
          return makeDiscardResponse(true, requestRefresh);
        }
        // Cross-tab backoff outside the lock: during an active window for this credential generation,
        // exit immediately through the discard path with zero network I/O and zero lock sleep.
        const existingBackoff = readBackoffRecord(storedGen);
        if (
          savedCredential !== null &&
          requestRefresh !== null &&
          savedCredential.refresh_token === requestRefresh &&
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
            recordBackoffFailure(storedGen, null);
          } else {
            reconcileBackoffWithCredential(currentGen);
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
          clearBackoffRecord();
          lastDiscardedRefreshToken = null;
          // auth-js's storedAfter guard discards a peer replacement/logout without
          // re-sending the now-consumed predecessor or entering a retry cooldown.
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
          reconcileBackoffWithCredential(currentGen);
          return makeDiscardResponse(true, requestRefresh);
        }
        if (terminal) {
          // Confirmed terminal refusal for the still-current stored credential.
          clearBackoffRecord();
          if (savedCredential?.expires_at && savedCredential.expires_at * 1000 <= Date.now()) {
            removalSnapshot = savedAtStart;
          }
          return response;
        }
        // Non-terminal refusal (400 refresh_token_already_used, 429, 5xx, etc.):
        // record external backoff honoring Retry-After and release the lock via discard.
        if (storedGen !== null) {
          recordBackoffFailure(storedGen, response.headers.get("retry-after"));
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

  const baseLock = hasWebLocks() ? navigatorLock : processLock;
  const trackedLock: typeof navigatorLock = (name, acquireTimeout, fn) => {
    if (quiesced) {
      return Promise.resolve(undefined as never);
    }
    return baseLock(name, acquireTimeout, async () => {
      if (quiesced) {
        return undefined as never;
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
  // If the runtime client does not match the pinned 2.111.0 shape or version,
  // fail closed immediately: neutralize & tear down the instance and hand out no client.
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
    typeof authClient._emitInitialSession === "function" &&
    typeof authClient.onAuthStateChange === "function" &&
    typeof authClient._callRefreshToken === "function" &&
    typeof authClient._refreshAccessToken === "function" &&
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
  authClientRef = authClient;

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

  const origCallRefreshToken = authClient._callRefreshToken!.bind(client.auth);
  const origRefreshAccessToken = authClient._refreshAccessToken!.bind(client.auth);
  authClient._callRefreshToken = async (refreshToken: string) => {
    // Re-entrant call while a refresh is already active on this client dedupes via
    // GoTrue's `refreshingDeferred`; preserve the outermost attempt scope.
    if (activeRefreshAttempt !== null) {
      return origCallRefreshToken(refreshToken);
    }
    const lockToken = activeLockToken;
    if (lockToken === null) {
      return origCallRefreshToken(refreshToken);
    }
    const attempt: RefreshAttemptScope = {
      id: Symbol("refresh-attempt"),
      lockToken,
      storageKey:
        typeof authClient.storageKey === "string" && authClient.storageKey.length > 0
          ? authClient.storageKey
          : effectiveStorageKey(),
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
    if (event === "SIGNED_OUT") {
      deadSession = false;
      removalSnapshot = null;
      lastDiscardedRefreshToken = null;
      clearBackoffRecord();
    } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
      deadSession = false;
      lastDiscardedRefreshToken = null;
      clearBackoffRecord();
    }
  });

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
      const { data: userData, error } = await client.auth.getUser();
      if (quiesced) throw new AuthRecoveryRequired();
      const latest = await client.auth.getSession();
      if (quiesced) throw new AuthRecoveryRequired();
      if (error) {
        if (latest.data.session && !sameCredentials(session, latest.data.session)) {
          throw new AuthRecoveryRequired(currentBackoffRetryAfter(latest.data.session));
        }
        if (isAuthSessionMissingError(error)) { deadSession = true; throw new SessionExpired(); }
        throw new AuthRecoveryRequired(currentBackoffRetryAfter());
      }
      if (latest.error || !latest.data.session || !userData.user ||
          userData.user.id !== latest.data.session.user.id) {
        throw new AuthRecoveryRequired(currentBackoffRetryAfter());
      }
      deadSession = false;
      return latest.data.session;
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

  async function signOut(): Promise<void> {
    deadSession = false;
    await client.auth.signOut();
    deadSession = false;
  }

  function quiesce(): Promise<void> {
    if (quiescePromise) return quiescePromise;
    quiesced = true;
    retireRefreshAttempt();
    memoryBackoff = null;
    removalSnapshot = null;
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
