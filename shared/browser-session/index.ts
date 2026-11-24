import type {
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
  constructor() {
    super("CommonSwarm could not check your sign-in. Try again when the connection recovers.");
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

// SDK retries can last one 30s tick. Let them finish under the lock while the
// caller gets a bounded recovery panel; never steal an active peer's lock.
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

export type CreateBrowserSessionResult =
  | BrowserSession
  | BrowserSessionLocksUnavailable;

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
  let sessionStorageKey: string | null = null;
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

  const onStorage = (event: StorageEvent): void => {
    if (quiesced) return;
    if (event.storageArea !== globalThis.localStorage) return;
    const keys = event.key === null ? [...importedStorageKeys] : [event.key];
    for (const key of keys) {
      // Even remove/reinsert of identical bytes must cancel an older pending save.
      if (!importedStorageKeys.has(key)) continue;
      const value = readPersistentAuthItem(key);
      if (value !== undefined) {
        removedStorageKeys.delete(key);
        acceptPersistentAuthItem(key, value);
      }
    }
  };

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("storage", onStorage);
  }

  function savedSession(value: string | null): Session | null {
    try {
      const saved = value ? JSON.parse(value) : null;
      return saved && typeof saved.access_token === "string" && typeof saved.refresh_token === "string"
        ? saved as Session : null;
    } catch { return null; }
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
      importedStorageKeys.add(key);
      reconcileAuthItem(key);
      const value = authMemory.get(key) ?? null;
      if (savedSession(value)) sessionStorageKey = key;
      return value;
    },
    setItem(key: string, value: string): void {
      if (quiesced) {
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      importedStorageKeys.add(key);
      const pending = pendingStorageWrites.get(key);
      const disk = readPersistentAuthItem(key);
      if (pending && pending.expected !== undefined && disk !== undefined && disk !== pending.expected) {
        acceptPersistentAuthItem(key, disk);
        // Stop the SDK before it can announce a save that lost ownership.
        throw new AuthRetryableFetchError("Sign-in changed during storage save", 0);
      }
      if (savedSession(value)) sessionStorageKey = key;
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
        if (authStorage.getItem(key) !== expected) {
          throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
        }
      }
      importedStorageKeys.add(key);
      pendingStorageWrites.delete(key);
      removedStorageKeys.add(key);
      authMemory.delete(key);
      removePersistentAuthItem(key);
    },
  };

  let refreshRetryAfter = 0;
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

  function quiescedRefreshResponse(): Response {
    // Returning a synthetic session payload while authStorage.getItem returns null
    // triggers GoTrue's built-in commit guard (AuthRefreshDiscardedError): exits
    // immediately on attempt 0 with zero backoff retries, zero storage writes or
    // removals, zero SIGNED_OUT broadcast, and clean Web Lock release. authStorage
    // independently throws on any direct write/removal while quiesced.
    return new Response(
      JSON.stringify({
        access_token: "quiesced",
        refresh_token: "quiesced",
        expires_in: 1,
        token_type: "bearer",
        user: { id: "quiesced" },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  /** Adapt only refresh failures that the pinned SDK would otherwise destroy.
   * Its retry loop retains credentials; a cooldown prevents repeated HTTP calls.
   * Other endpoints keep their SDK method, body and error contracts.
   */
  const authFetch: typeof fetch = async (input, init) => {
    const run = (async (): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const isRefresh = method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "refresh_token";
      const isUser = method === "GET" && url.pathname.endsWith("/auth/v1/user");
      if (quiesced) {
        if (isRefresh) return quiescedRefreshResponse();
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      if (!isRefresh && !isUser) {
        const response = await fetch(input, init);
        if (url.pathname.includes("/rest/v1/") && await isRestSessionEnded(response)) checkSessionAfterRestRefusal();
        return response;
      }
      if (isRefresh && Date.now() < refreshRetryAfter) {
        // Keep the SDK's single-flight refresh pending through our cooldown. Fast
        // failures exhaust its backoff and then cache the failure for another 60s,
        // preventing a recovered backend from being reached by Try again.
        // The caller's 4s deadline still owns the UI; the SDK retains its lock.
        const delayMs = Math.min(refreshRetryAfter - Date.now(), 30_000);
        await new Promise<void>((resolve) => {
          if (quiesced || quiesceController.signal.aborted) { resolve(); return; }
          const onAbort = (): void => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            quiesceController.signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          quiesceController.signal.addEventListener("abort", onAbort, { once: true });
        });
        if (quiesced) return quiescedRefreshResponse();
        if (Date.now() < refreshRetryAfter) {
          throw new AuthRetryableFetchError("Sign-in check interrupted", 0);
        }
      }
      const savedAtStart = sessionStorageKey ? authStorage.getItem(sessionStorageKey) : null;
      const savedCredential = savedSession(savedAtStart);
      let requestRefresh: unknown;
      if (isRefresh && typeof init?.body === "string") {
        try { requestRefresh = JSON.parse(init.body)?.refresh_token; } catch { /* SDK owns request validation. */ }
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
          if (isRefresh) return quiescedRefreshResponse();
          throw new AuthRetryableFetchError("Session quiesced", 0);
        }
        if (isRefresh) refreshRetryAfter = Date.now() + 30_000;
        throw error;
      }
      if (quiesced) {
        if (isRefresh) return quiescedRefreshResponse();
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      if (response.ok) {
        if (isRefresh) {
          refreshRetryAfter = 0;
          // auth-js's storedAfter guard discards a peer replacement/logout without
          // re-sending the now-consumed predecessor or entering a retry cooldown.
        }
        return response;
      }
      const body = await response.clone().json().catch(() => null);
      if (quiesced) {
        if (isRefresh) return quiescedRefreshResponse();
        throw new AuthRetryableFetchError("Session quiesced", 0);
      }
      // Match auth-js's versioned GoTrue error contract.
      const version = response.headers.get("x-supabase-api-version");
      const code = version && version >= "2024-01-01" && typeof body?.code === "string"
        ? body.code : body?.error_code;
      const terminal = [400, 401, 403, 404].includes(response.status) && terminalRefreshCodes.has(code);
      const matches = isRefresh ? savedCredential?.refresh_token === requestRefresh
        : savedCredential?.access_token === access;
      if (terminal && (!matches || !savedAtStart ||
          (sessionStorageKey && authStorage.getItem(sessionStorageKey) !== savedAtStart))) {
        if (isRefresh) refreshRetryAfter = Date.now() + 30_000;
        throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
      }
      if (terminal && ((isUser && code === "session_not_found") ||
          (isRefresh && savedCredential?.expires_at && savedCredential.expires_at * 1000 <= Date.now()))) {
        removalSnapshot = savedAtStart;
      }
      if (isRefresh && !terminal) {
        // already_used is ambiguous rotation evidence, never terminal proof.
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter ?? "");
        refreshRetryAfter = Math.max(Date.now() + 30_000, Number.isFinite(until) ? until : 0);
        throw new AuthRetryableFetchError("Sign-in check interrupted", response.status);
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

  const client = createClient(options.url, options.anonKey, {
    global: { fetch: authFetch },
    auth: {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: options.detectSessionInUrl,
      storage: authStorage,
      lockAcquireTimeout: -1,
      // 2.111.0 defaults to lockless auth. Opt into the public SDK lock hook:
      // getUser's terminal removal and refresh must serialize with other tabs.
      lock: hasWebLocks() ? navigatorLock : processLock,
    },
  });
  // 2.111.0 also defaults PostgREST GET queries to 3 exponential-backoff retries (1s/2s/4s);
  // keep single-attempt reads so readWithDeadline and explicit UI retry controls own recovery.
  if ((client as unknown as { rest?: { retry?: boolean } }).rest) {
    (client as unknown as { rest: { retry: boolean } }).rest.retry = false;
  }
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") { deadSession = false; removalSnapshot = null; refreshRetryAfter = 0; }
    else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") deadSession = false;
  });

  async function verifiedSession(): Promise<Session | null> {
    if (quiesced) throw new AuthRecoveryRequired();
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (quiesced) throw new AuthRecoveryRequired();
      if (sessionError) {
        if (isAuthSessionMissingError(sessionError) || terminalRefreshCodes.has(sessionError.code ?? "")) {
          const successor = await client.auth.getSession();
          if (successor.data.session) throw new AuthRecoveryRequired();
          throw new SessionExpired();
        }
        throw new AuthRecoveryRequired();
      }
      const session = data.session ?? null;
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
          throw new AuthRecoveryRequired();
        }
        if (isAuthSessionMissingError(error)) { deadSession = true; throw new SessionExpired(); }
        throw new AuthRecoveryRequired();
      }
      if (latest.error || !latest.data.session || !userData.user ||
          userData.user.id !== latest.data.session.user.id) throw new AuthRecoveryRequired();
      deadSession = false;
      return latest.data.session;
    } catch (error) {
      if (error instanceof SessionExpired || error instanceof AuthRecoveryRequired) throw error;
      // Lock contention and storage/transport exceptions also leave saved auth
      // intact. They must reach the initial-load retry panel, not sign-in controls.
      throw new AuthRecoveryRequired();
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
    removalSnapshot = null;
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
    };
    const sdkDispose =
      typeof authApi.dispose === "function"
        ? authApi.dispose()
        : typeof authApi.stopAutoRefresh === "function"
          ? authApi.stopAutoRefresh()
          : Promise.resolve();

    quiescePromise = (async () => {
      await Promise.allSettled([
        sdkDispose,
        ...(authApi.initializePromise ? [authApi.initializePromise] : []),
        ...activeAuthFetches,
        ...(activeStorageRetry ? [activeStorageRetry] : []),
        ...(restSessionCheck ? [restSessionCheck] : []),
      ]);
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
