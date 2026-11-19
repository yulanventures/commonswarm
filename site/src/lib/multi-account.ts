/*
 * Multi-account session core (CS 48abec6a — Rev 4, dormant behind MULTI_ACCOUNT_ENABLED until PR 2).
 *
 * Security invariants enforced by construction:
 *  - C1 (Redirect staging): Direct GoTrue HTTP for S256 PKCE OAuth, pinned-email OTP, and password
 *    sign-in. Never constructs a persistent staging SupabaseClient, never writes sessions to staging,
 *    scrubs callback URLs before app work, refuses bearer fragments / token_hash / recovery /
 *    email_change callbacks, verifies identity via GET /auth/v1/user, and strips upstream provider tokens.
 *  - C2 (Operation & login binding): Every login mints a fresh loginId (UUID) distinct from userId.
 *    Callers pin { runtime, userId, loginId, viewGeneration } before any await and recheck before every
 *    send, 401 retry, Realtime join, and UI commit.
 *  - C3 (SDK isolation & authoritative durable ownership): Each login's SupabaseClient uses a unique
 *    per-login storageKey (`commonswarm:auth:v1:<origin>:login:<loginId>`), closes/disables the SDK's
 *    internal BroadcastChannel BEFORE auth.initialize() (zero credentials ever cross BroadcastChannel),
 *    and gates every read, write, refresh, and Realtime auth on positive durable ownership in
 *    `commonswarm:accounts:v1:<origin>`. Logout writes & verifies durable ownership removal FIRST; if
 *    that write fails, slots are NOT deleted and browser-wide sign-out is reported unconfirmed while
 *    the current tab still tears down immediately.
 *  - C4 (Exact lock alignment & fresh-sign-in cutover): Uses the exact SDK lock derivation
 *    `lock:${storageKey}` (`GoTrueClient.ts:2904`) in strict order `registry -> lock:${legacyKey} ->
 *    lock:${slotKey}` (ascending loginId). Never imports or copies the legacy `sb-<ref>-auth-token`
 *    session; on first load clears `legacyKey` under `registry -> lock:${legacyKey}` for a single
 *    fresh sign-in. Requires cross-context Web Locks for shared persistent rotation; falls back to
 *    single-context memory-only sessions when `navigator.locks` is unavailable.
 *  - C5 (Explicit logout scopes): Ordinary sign-out is `scope=local` ("Sign out on this device"),
 *    preserving other devices and other signed-in accounts on this device. Remote revocation runs
 *    best-effort after verified local fencing and teardown; reported confirmed only on GoTrue 204
 *    or proven session_not_found.
 */

import {
  AuthRetryableFetchError,
  createClient,
  isAuthSessionMissingError,
  navigatorLock,
  processLock,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { authProvider } from "./auth-providers.js";

/** Dormant feature gate for PR 1. Flipped to true in PR 2 once all account-sensitive routes wire in. */
export const MULTI_ACCOUNT_ENABLED = false;

/** Maximum simultaneous signed-in accounts per browser profile. */
export const MAX_SIGNED_IN_ACCOUNTS = 5;

/** One-use sign-in attempt lifetime (10 minutes). */
export const SIGN_IN_ATTEMPT_TTL_MS = 10 * 60_000;

/** Allowed same-origin callback routes matching the GoTrue redirect allowlist. */
export const ALLOWED_AUTH_RETURN_ROUTES: ReadonlySet<string> = new Set(["/app", "/invite"]);

const TERMINAL_REFRESH_CODES = new Set([
  "refresh_token_not_found",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
]);

const REMOTE_LOGOUT_TIMEOUT_MS = 8_000;
const VERIFY_TIMEOUT_MS = 4_000;

export interface MultiAccountDeployment {
  url: string;
  anonKey: string;
}

export type SignInPurpose = "add-account" | "signed-out" | "invite";
export type SignInMethod = "oauth" | "email-otp" | "password";

export interface AccountRecord {
  userId: string;
  loginId: string;
  label: string;
  secondary: string;
  addedAt: number;
}

export interface DurableOwnershipTable {
  version: 1;
  allSignOutGen: number;
  accounts: AccountRecord[];
}

export type OwnershipReadResult =
  | { ok: true; state: DurableOwnershipTable }
  | { ok: false; reason: "missing" | "unreadable" | "corrupt" };

export interface SignInAttempt {
  attemptId: string;
  originHash: string;
  purpose: SignInPurpose;
  returnRoute: string;
  method: SignInMethod;
  codeVerifier?: string;
  email?: string;
  allSignOutGenAtStart: number;
  createdAt: number;
  expiresAt: number;
}

export interface MinimizedSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
  user: User;
}

export type CrossTabAccountEvent = {
  type: "ownership-changed" | "login-rotated";
  originHash: string;
  userId?: string;
  loginId?: string;
  allSignOutGen: number;
};

export interface AccountRuntimeErrors {
  SessionExpired: new () => Error;
  AuthRecoveryRequired: new () => Error;
}

export class MultiAccountSessionExpired extends Error {
  override name = "SessionExpired";
  constructor() {
    super("Your session expired — sign in again.");
  }
}

export class MultiAccountAuthRecoveryRequired extends Error {
  override name = "AuthRecoveryRequired";
  constructor() {
    super("CommonSwarm could not check your sign-in. Try again when the connection recovers.");
  }
}

export class DurableOwnershipWriteError extends Error {
  override name = "DurableOwnershipWriteError";
  constructor(message = "Browser-wide sign-out could not be confirmed. Try again.") {
    super(message);
  }
}

export class AccountCapReachedError extends Error {
  override name = "AccountCapReachedError";
  constructor() {
    super(`You can stay signed in to up to ${MAX_SIGNED_IN_ACCOUNTS} accounts at once. Sign out of one to add another.`);
  }
}

export interface LockLike {
  <R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface LocationLike {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export interface MultiAccountEnv {
  localStorage: Storage | null;
  sessionStorage: Storage | null;
  fetcher: typeof fetch;
  now: () => number;
  randomUUID: () => string;
  getRandomValues: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  subtle: SubtleCrypto;
  webLocks: LockLike | null;
  createBroadcastChannel: ((name: string) => BroadcastChannelLike) | null;
  addStorageListener?: (listener: (event: StorageEvent) => void) => () => void;
  addVisibilityListener?: (listener: () => void) => () => void;
  onForcedTeardown?: (detail: { reason: "signed-out" | "all-signed-out" | "expired" | "storage-unavailable"; userId?: string; loginId?: string }) => void;
  onOwnershipChange?: (accounts: readonly AccountRecord[], active: { userId: string; loginId: string } | null) => void;
}

export interface RemoteRevocationResult {
  status: "confirmed" | "unconfirmed" | "skipped";
  httpStatus?: number;
}

export interface SignOutAccountResult {
  browserSignedOut: boolean;
  localTabTornDown: boolean;
  slotDeleted: boolean;
  remoteRevocation: RemoteRevocationResult;
  nextActive: { userId: string; loginId: string } | null;
  notice?: string;
}

export interface SignOutAllResult {
  browserSignedOut: boolean;
  localTabTornDown: boolean;
  slotsDeleted: number;
  remoteRevocations: ReadonlyArray<{ userId: string; loginId: string; result: RemoteRevocationResult }>;
  notice?: string;
}

export type PromotionOutcome =
  | { kind: "promoted"; account: AccountRecord; replacedLoginId?: string }
  | { kind: "kept-existing"; account: AccountRecord; stagingRevoked: RemoteRevocationResult }
  | { kind: "refused"; reason: "cap_reached" | "fenced_by_signout_all" | "identity_unverified" | "ownership_write_failed"; stagingRevoked: RemoteRevocationResult };

export type CallbackBootstrapResult =
  | { kind: "none" }
  | { kind: "promoted"; account: AccountRecord; purpose: SignInPurpose; replacedLoginId?: string }
  | { kind: "kept-existing"; account: AccountRecord; purpose: SignInPurpose; stagingRevoked: RemoteRevocationResult }
  | {
      kind: "refused";
      reason:
        | "bearer_fragment"
        | "token_hash_refused"
        | "unsupported_callback_type"
        | "missing_attempt"
        | "invalid_attempt"
        | "expired_attempt"
        | "separate_context_email"
        | "provider_error"
        | "exchange_failed"
        | "identity_unverified"
        | "fenced_by_signout_all"
        | "cap_reached"
        | "ownership_write_failed";
      message: string;
    };

/** Deterministic 12-hex origin hash (dual FNV-1a 32-bit) for synchronous storage key scoping. */
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

/** Exact Supabase JS v2.111.0 default storage key (`SupabaseClient.ts:327`). */
export function legacyStorageKey(url: string): string {
  const baseUrl = new URL(url);
  return `sb-${baseUrl.hostname.split(".")[0]}-auth-token`;
}

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

export const crossTabChannelName = (originHash: string): string =>
  `commonswarm:accounts:v1:${originHash}`;

/** Exact ordered lock names shared between AccountManager and pinned GoTrueClient (`GoTrueClient.ts:2904`). */
export const registryLockName = (originHash: string): string =>
  `lock:commonswarm:auth:v1:${originHash}:registry`;

export const legacyLockName = (url: string): string =>
  `lock:${legacyStorageKey(url)}`;

export const loginLockName = (originHash: string, loginId: string): string =>
  `lock:${slotStorageKey(originHash, loginId)}`;

function normalizeReturnRoute(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  return trimmed;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Generate a 256-bit random S256 PKCE verifier and challenge using Web Crypto. */
export async function generatePkcePair(
  env: Pick<MultiAccountEnv, "getRandomValues" | "subtle">,
): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const raw = new Uint8Array(32);
  env.getRandomValues(raw);
  const codeVerifier = base64UrlEncode(raw);
  const digest = await env.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

/** Strip upstream provider tokens and keep only the required GoTrue session fields. */
export function stripSessionFields(raw: unknown, verifiedUser: User): MinimizedSession | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.access_token !== "string" || !obj.access_token) return null;
  if (typeof obj.refresh_token !== "string" || !obj.refresh_token) return null;
  const expiresIn = typeof obj.expires_in === "number" && Number.isFinite(obj.expires_in) ? obj.expires_in : 3600;
  const expiresAt = typeof obj.expires_at === "number" && Number.isFinite(obj.expires_at)
    ? obj.expires_at
    : Math.floor(Date.now() / 1000) + expiresIn;
  const tokenType = typeof obj.token_type === "string" && obj.token_type ? obj.token_type : "bearer";
  return {
    access_token: obj.access_token,
    refresh_token: obj.refresh_token,
    expires_in: expiresIn,
    expires_at: expiresAt,
    token_type: tokenType,
    user: verifiedUser,
  };
}

function parseSavedSession(value: string | null): Session | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    if (
      parsed &&
      typeof parsed.access_token === "string" &&
      typeof parsed.refresh_token === "string"
    ) {
      return parsed as unknown as Session;
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip provider_token / provider_refresh_token from any JSON session string written by the SDK. */
function sanitizeSerializedSession(value: string): string {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      ("provider_token" in parsed || "provider_refresh_token" in parsed)
    ) {
      const { provider_token: _pt, provider_refresh_token: _prt, ...rest } = parsed;
      return JSON.stringify(rest);
    }
    return value;
  } catch {
    return value;
  }
}

function parseOwnershipTable(raw: string | null): OwnershipReadResult {
  if (raw === null) return { ok: false, reason: "missing" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.allSignOutGen !== "number" ||
      !Number.isInteger(parsed.allSignOutGen) ||
      parsed.allSignOutGen < 1 ||
      !Array.isArray(parsed.accounts)
    ) {
      return { ok: false, reason: "corrupt" };
    }
    const accounts: AccountRecord[] = [];
    const seenUsers = new Set<string>();
    const seenLogins = new Set<string>();
    for (const entry of parsed.accounts) {
      if (!entry || typeof entry !== "object") return { ok: false, reason: "corrupt" };
      const rec = entry as Record<string, unknown>;
      if (
        typeof rec.userId !== "string" || !rec.userId ||
        typeof rec.loginId !== "string" || !rec.loginId ||
        typeof rec.label !== "string" ||
        typeof rec.secondary !== "string" ||
        typeof rec.addedAt !== "number" || !Number.isFinite(rec.addedAt)
      ) {
        return { ok: false, reason: "corrupt" };
      }
      if (seenUsers.has(rec.userId) || seenLogins.has(rec.loginId)) return { ok: false, reason: "corrupt" };
      seenUsers.add(rec.userId);
      seenLogins.add(rec.loginId);
      accounts.push({
        userId: rec.userId,
        loginId: rec.loginId,
        label: rec.label,
        secondary: rec.secondary,
        addedAt: rec.addedAt,
      });
    }
    return {
      ok: true,
      state: { version: 1, allSignOutGen: parsed.allSignOutGen, accounts },
    };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

function accountLabelsFromUser(user: User): { label: string; secondary: string } {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName = typeof meta.full_name === "string" && meta.full_name.trim()
    ? meta.full_name.trim()
    : typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim()
      : typeof meta.user_name === "string" && meta.user_name.trim()
        ? meta.user_name.trim()
        : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (fullName) return { label: fullName, secondary: email };
  if (email) return { label: email, secondary: "" };
  return { label: "Account", secondary: "" };
}

function sameCredentials(a: Session, b: Session): boolean {
  return (
    a.access_token === b.access_token &&
    a.refresh_token === b.refresh_token &&
    a.user.id === b.user.id
  );
}

async function isRestSessionEnded(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return body?.code === "session_not_found";
}

function defaultEnv(): MultiAccountEnv {
  let ls: Storage | null = null;
  let ss: Storage | null = null;
  try { ls = globalThis.localStorage ?? null; } catch { ls = null; }
  try { ss = globalThis.sessionStorage ?? null; } catch { ss = null; }
  const hasWebLocks = typeof navigator !== "undefined" && Boolean(navigator.locks);
  return {
    localStorage: ls,
    sessionStorage: ss,
    fetcher: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (arr) => crypto.getRandomValues(arr),
    subtle: crypto.subtle,
    webLocks: hasWebLocks ? navigatorLock : null,
    createBroadcastChannel: typeof globalThis.BroadcastChannel === "function"
      ? (name) => new globalThis.BroadcastChannel(name)
      : null,
    addStorageListener: typeof globalThis.addEventListener === "function"
      ? (listener) => {
          globalThis.addEventListener("storage", listener);
          return () => globalThis.removeEventListener("storage", listener);
        }
      : undefined,
    addVisibilityListener: typeof document !== "undefined" && typeof document.addEventListener === "function"
      ? (listener) => {
          const wrapped = () => { if (document.visibilityState === "visible") listener(); };
          document.addEventListener("visibilitychange", wrapped);
          return () => document.removeEventListener("visibilitychange", wrapped);
        }
      : undefined,
  };
}

/**
 * Isolated per-login Supabase runtime.
 * Owns its own storage slot, SDK client, Web Lock (`lock:${slotKey}`), authFetch, and Realtime socket.
 */
export class AccountSessionRuntime {
  readonly userId: string;
  readonly loginId: string;
  readonly allSignOutGen: number;
  readonly slotKey: string;
  readonly lockName: string;
  readonly client: SupabaseClient;
  readonly persistent: boolean;

  private disposed = false;
  private deadSession = false;
  private removalSnapshot: string | null = null;
  private refreshRetryAfter = 0;
  private restSessionCheck: Promise<unknown> | null = null;
  private authMemory = new Map<string, string>();
  private diskSnapshots = new Map<string, string | null>();
  private pendingStorageWrites = new Map<string, { expected: string | null | undefined; value: string }>();
  private removedStorageKeys = new Set<string>();
  private storageRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private storageRetryDelay = 1_000;
  private storageRetryInFlight = false;
  private authSubscription: { unsubscribe: () => void } | null = null;
  private initialized: Promise<void>;

  private readonly deployment: MultiAccountDeployment;
  private readonly env: MultiAccountEnv;
  private readonly checkOwned: () => boolean;
  private readonly onSessionUpdated: (event: string, session: Session | null) => void;
  private readonly onTerminalExpiry: () => void;

  constructor(params: {
    deployment: MultiAccountDeployment;
    originHash: string;
    userId: string;
    loginId: string;
    allSignOutGen: number;
    persistent: boolean;
    initialSession?: MinimizedSession;
    env: MultiAccountEnv;
    checkOwned: () => boolean;
    onSessionUpdated: (event: string, session: Session | null) => void;
    onTerminalExpiry: () => void;
  }) {
    this.deployment = params.deployment;
    this.userId = params.userId;
    this.loginId = params.loginId;
    this.allSignOutGen = params.allSignOutGen;
    this.persistent = params.persistent;
    this.slotKey = slotStorageKey(params.originHash, params.loginId);
    this.lockName = loginLockName(params.originHash, params.loginId);
    this.env = params.env;
    this.checkOwned = params.checkOwned;
    this.onSessionUpdated = params.onSessionUpdated;
    this.onTerminalExpiry = params.onTerminalExpiry;

    if (params.initialSession) {
      const serialized = JSON.stringify(params.initialSession);
      this.authMemory.set(this.slotKey, serialized);
      if (this.persistent) {
        this.diskSnapshots.set(this.slotKey, serialized);
      }
    }

    const storageAdapter = this.buildStorageAdapter();
    const authFetch = this.buildAuthFetch();
    const lockImpl: LockLike = this.persistent && this.env.webLocks
      ? this.env.webLocks
      : processLock;

    const supa = createClient(this.deployment.url, this.deployment.anonKey, {
      global: { fetch: authFetch },
      auth: {
        storageKey: this.slotKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: storageAdapter,
        lockAcquireTimeout: -1,
        skipAutoInitialize: true,
        lock: lockImpl,
      },
    });

    // C3: Disable & close the SDK's internal BroadcastChannel synchronously BEFORE initialize()
    // so NOT EVEN INITIAL_SESSION can publish credentials on any BroadcastChannel.
    const internalAuth = supa.auth as unknown as { broadcastChannel?: BroadcastChannel | null };
    if (internalAuth.broadcastChannel) {
      try { internalAuth.broadcastChannel.close(); } catch { /* ignore */ }
      internalAuth.broadcastChannel = null;
    }

    if ((supa as unknown as { rest?: { retry?: boolean } }).rest) {
      (supa as unknown as { rest: { retry: boolean } }).rest.retry = false;
    }

    const { data } = supa.auth.onAuthStateChange((event, nextSession) => {
      if (this.disposed || !this.checkOwned()) return;
      if (event === "SIGNED_OUT") {
        this.deadSession = false;
        this.removalSnapshot = null;
        this.refreshRetryAfter = 0;
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        this.deadSession = false;
      }
      this.onSessionUpdated(event, nextSession);
    });
    this.authSubscription = data.subscription;
    this.client = supa;
    this.initialized = supa.auth
      .initialize()
      .then(() => {
        if (this.disposed) {
          try { void supa.auth.dispose(); } catch { /* ignore */ }
        }
      })
      .catch(() => undefined);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  isLiveOwned(): boolean {
    return !this.disposed && !this.deadSession && this.checkOwned();
  }

  async ready(): Promise<void> {
    await this.initialized;
  }

  /** Reconcile this login's memory with disk after a peer tab rotated its refresh token. */
  reconcileFromDisk(): Session | null {
    if (this.disposed || !this.checkOwned()) {
      this.authMemory.clear();
      this.pendingStorageWrites.clear();
      return null;
    }
    if (!this.persistent) {
      return parseSavedSession(this.authMemory.get(this.slotKey) ?? null);
    }
    const disk = this.readDisk(this.slotKey);
    if (disk !== undefined) {
      this.removedStorageKeys.delete(this.slotKey);
      this.acceptDisk(this.slotKey, disk);
    }
    const latest = parseSavedSession(this.authMemory.get(this.slotKey) ?? null);
    if (latest && !this.disposed && this.checkOwned()) {
      void this.client.realtime.setAuth(latest.access_token);
    }
    return latest;
  }

  /** Return current access_token from memory/disk if still live and owned (for best-effort logout). */
  peekAccessToken(): string | null {
    const raw = this.authMemory.get(this.slotKey) ?? (this.persistent ? (this.readDisk(this.slotKey) ?? null) : null);
    return parseSavedSession(raw)?.access_token ?? null;
  }

  /** Bounded, identity-safe verification strictly on this login's runtime (QA-010 + C2/C3). */
  async verifySession(): Promise<Session | null> {
    if (this.disposed || !this.checkOwned()) {
      throw new MultiAccountSessionExpired();
    }
    await this.ready();
    return this.bounded(this.verifiedSessionInner());
  }

  /** Dispose this login runtime: stop auto-refresh, disconnect Realtime, block further writes/auth. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingStorageWrites.clear();
    this.authMemory.clear();
    this.removalSnapshot = null;
    if (this.storageRetryTimer !== undefined) {
      clearTimeout(this.storageRetryTimer);
      this.storageRetryTimer = undefined;
    }
    try { this.authSubscription?.unsubscribe(); } catch { /* ignore */ }
    this.authSubscription = null;
    try { void this.client.auth.stopAutoRefresh(); } catch { /* ignore */ }
    try { void this.client.auth.dispose(); } catch { /* ignore */ }
    try { void this.client.removeAllChannels(); } catch { /* ignore */ }
    try { void this.client.realtime.disconnect(); } catch { /* ignore */ }
    // Fence late setAuth calls on disposed clients.
    const rt = this.client.realtime as unknown as { setAuth: (...args: unknown[]) => Promise<void> };
    rt.setAuth = async () => undefined;
  }

  private readDisk(key: string): string | null | undefined {
    if (!this.persistent || !this.env.localStorage) return undefined;
    try {
      return this.env.localStorage.getItem(key);
    } catch {
      return undefined;
    }
  }

  private acceptDisk(key: string, value: string | null): void {
    this.pendingStorageWrites.delete(key);
    this.diskSnapshots.set(key, value);
    if (value === null) this.authMemory.delete(key);
    else this.authMemory.set(key, value);
  }

  private reconcileKey(key: string): void {
    if (!this.persistent) return;
    const value = this.readDisk(key);
    if (value === undefined || this.removedStorageKeys.has(key)) return;
    const pending = this.pendingStorageWrites.get(key);
    if (pending && (pending.expected === undefined || value === pending.expected)) return;
    this.acceptDisk(key, value);
  }

  private scheduleStorageRetry(): void {
    if (!this.persistent || !this.env.localStorage) return;
    if (this.disposed || this.storageRetryTimer !== undefined || this.storageRetryInFlight || this.pendingStorageWrites.size === 0) {
      return;
    }
    this.storageRetryTimer = setTimeout(() => { void this.retryStorageWrites(); }, this.storageRetryDelay);
    (this.storageRetryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async retryStorageWrites(): Promise<void> {
    this.storageRetryTimer = undefined;
    if (this.disposed || !this.checkOwned()) {
      this.pendingStorageWrites.clear();
      return;
    }
    this.storageRetryInFlight = true;
    try {
      const lockImpl = this.env.webLocks ?? processLock;
      for (const [key, pending] of this.pendingStorageWrites) {
        if (this.disposed || !this.checkOwned()) {
          this.pendingStorageWrites.clear();
          return;
        }
        try {
          await lockImpl(this.lockName, 0, async () => {
            // C3: Recheck positive durable ownership INSIDE the lock before writing!
            if (this.disposed || !this.checkOwned()) {
              this.pendingStorageWrites.clear();
              return;
            }
            this.reconcileKey(key);
            if (
              this.pendingStorageWrites.get(key) !== pending ||
              !this.env.localStorage ||
              pending.expected === undefined ||
              this.readDisk(key) === undefined
            ) {
              return;
            }
            try {
              this.env.localStorage.setItem(key, pending.value);
              if (this.env.localStorage.getItem(key) === pending.value) {
                this.acceptDisk(key, pending.value);
              }
            } catch { /* retry later while owned */ }
          });
        } catch { /* busy lock: retry next tick */ }
      }
    } finally {
      this.storageRetryInFlight = false;
      this.storageRetryDelay = Math.min(this.storageRetryDelay * 2, 30_000);
      this.scheduleStorageRetry();
    }
  }

  private buildStorageAdapter(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
    return {
      getItem: (key: string): string | null => {
        // C3: Positive durable ownership required for every credential read/restore.
        if (this.disposed || !this.checkOwned()) {
          this.authMemory.delete(key);
          this.pendingStorageWrites.delete(key);
          return null;
        }
        if (this.persistent) this.reconcileKey(key);
        return this.authMemory.get(key) ?? null;
      },
      setItem: (key: string, rawValue: string): void => {
        // C3: Refuse any write (including post-dispose SDK writes & peer refreshes) when unowned!
        if (this.disposed || !this.checkOwned()) {
          this.authMemory.delete(key);
          this.pendingStorageWrites.delete(key);
          throw new MultiAccountSessionExpired();
        }
        const value = sanitizeSerializedSession(rawValue);
        if (!this.persistent) {
          this.authMemory.set(key, value);
          return;
        }
        const pending = this.pendingStorageWrites.get(key);
        const disk = this.readDisk(key);
        if (pending && pending.expected !== undefined && disk !== undefined && disk !== pending.expected) {
          this.acceptDisk(key, disk);
          throw new AuthRetryableFetchError("Sign-in changed during storage save", 0);
        }
        if (key === this.slotKey) this.removalSnapshot = null;
        this.removedStorageKeys.delete(key);
        this.authMemory.set(key, value);
        this.pendingStorageWrites.set(key, {
          expected: pending ? pending.expected : disk === undefined ? this.diskSnapshots.get(key) : disk,
          value,
        });
        this.storageRetryDelay = 1_000;
        try {
          if (this.env.localStorage && disk !== undefined && this.pendingStorageWrites.get(key)?.expected !== undefined) {
            this.env.localStorage.setItem(key, value);
            if (this.env.localStorage.getItem(key) === value) {
              this.acceptDisk(key, value);
            }
          }
        } catch { /* keep in memory & schedule retry while owned */ }
        this.scheduleStorageRetry();
      },
      removeItem: (key: string): void => {
        // C3: Once disposed or unowned (including tab-local fence after a failed Step 1 logout),
        // clear memory only — never let an SDK cleanup delete localStorage slots out from under Step 1.
        if (this.disposed || !this.checkOwned()) {
          this.pendingStorageWrites.delete(key);
          this.removedStorageKeys.add(key);
          this.authMemory.delete(key);
          return;
        }
        if (key === this.slotKey && this.removalSnapshot !== null) {
          const expected = this.removalSnapshot;
          this.removalSnapshot = null;
          const current = this.persistent ? (this.readDisk(key) ?? this.authMemory.get(key) ?? null) : (this.authMemory.get(key) ?? null);
          if (current !== expected) {
            throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
          }
        }
        this.pendingStorageWrites.delete(key);
        this.removedStorageKeys.add(key);
        this.authMemory.delete(key);
        if (this.persistent && this.env.localStorage) {
          try { this.env.localStorage.removeItem(key); } catch { /* ignore */ }
        }
      },
    };
  }

  private checkSessionAfterRestRefusal(): void {
    if (this.disposed || !this.checkOwned() || this.restSessionCheck) return;
    this.restSessionCheck = Promise.resolve()
      .then(() => this.verifiedSessionInner())
      .catch(() => undefined)
      .finally(() => { this.restSessionCheck = null; });
  }

  private buildAuthFetch(): typeof fetch {
    const fencedResponse = () =>
      Response.json(
        { code: "session_not_found", error_code: "session_not_found", msg: "Sign-in ended" },
        { status: 400 },
      );
    return async (input, init) => {
      if (this.disposed || !this.checkOwned()) {
        return fencedResponse();
      }
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const isRefresh =
        method === "POST" &&
        url.pathname.endsWith("/auth/v1/token") &&
        url.searchParams.get("grant_type") === "refresh_token";
      const isUser = method === "GET" && url.pathname.endsWith("/auth/v1/user");

      if (!isRefresh && !isUser) {
        const response = await this.env.fetcher(input, init);
        if (url.pathname.includes("/rest/v1/") && await isRestSessionEnded(response)) {
          this.checkSessionAfterRestRefusal();
        }
        return response;
      }

      if (isRefresh && this.env.now() < this.refreshRetryAfter) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(this.refreshRetryAfter - this.env.now(), 30_000)),
        );
        if (this.disposed || !this.checkOwned() || this.env.now() < this.refreshRetryAfter) {
          throw new AuthRetryableFetchError("Sign-in check interrupted", 0);
        }
      }

      const savedAtStart = this.persistent
        ? (this.readDisk(this.slotKey) ?? this.authMemory.get(this.slotKey) ?? null)
        : (this.authMemory.get(this.slotKey) ?? null);
      const savedCredential = parseSavedSession(savedAtStart);

      let requestRefresh: unknown;
      if (isRefresh && typeof init?.body === "string") {
        try { requestRefresh = JSON.parse(init.body)?.refresh_token; } catch { /* ignore */ }
      }
      const access = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        .get("authorization")
        ?.replace(/^Bearer /i, "");

      let response: Response;
      try {
        const existingSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
        const signals = existingSignal
          ? [existingSignal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]
          : [AbortSignal.timeout(VERIFY_TIMEOUT_MS)];
        response = await this.env.fetcher(input, { ...init, signal: AbortSignal.any(signals) });
      } catch (error) {
        if (isRefresh) this.refreshRetryAfter = this.env.now() + 30_000;
        throw error;
      }

      if (this.disposed || !this.checkOwned()) {
        return fencedResponse();
      }

      if (response.ok) {
        if (isRefresh) this.refreshRetryAfter = 0;
        return response;
      }

      const body = await response.clone().json().catch(() => null) as { code?: unknown; error_code?: unknown } | null;
      const version = response.headers.get("x-supabase-api-version");
      const code = version && version >= "2024-01-01" && typeof body?.code === "string"
        ? body.code
        : typeof body?.error_code === "string"
          ? body.error_code
          : typeof body?.code === "string"
            ? body.code
            : "";
      const terminal = [400, 401, 403, 404].includes(response.status) && TERMINAL_REFRESH_CODES.has(code);
      const matches = isRefresh
        ? savedCredential?.refresh_token === requestRefresh
        : savedCredential?.access_token === access;

      const latestNow = this.persistent
        ? (this.readDisk(this.slotKey) ?? this.authMemory.get(this.slotKey) ?? null)
        : (this.authMemory.get(this.slotKey) ?? null);
      if (terminal && (!matches || !savedAtStart || latestNow !== savedAtStart)) {
        if (isRefresh) this.refreshRetryAfter = this.env.now() + 30_000;
        throw new AuthRetryableFetchError("Sign-in changed during verification", 0);
      }
      if (
        terminal &&
        ((isUser && code === "session_not_found") ||
          (isRefresh && savedCredential?.expires_at && savedCredential.expires_at * 1000 <= this.env.now()))
      ) {
        this.removalSnapshot = savedAtStart;
      }
      if (isRefresh && !terminal) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const until = Number.isFinite(seconds) ? this.env.now() + seconds * 1000 : Date.parse(retryAfter ?? "");
        this.refreshRetryAfter = Math.max(this.env.now() + 30_000, Number.isFinite(until) ? until : 0);
        throw new AuthRetryableFetchError("Sign-in check interrupted", response.status);
      }
      return response;
    };
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MultiAccountAuthRecoveryRequired()), VERIFY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifiedSessionInner(): Promise<Session | null> {
    if (this.disposed || !this.checkOwned()) throw new MultiAccountSessionExpired();
    try {
      const { data, error: sessionError } = await this.client.auth.getSession();
      if (sessionError) {
        if (isAuthSessionMissingError(sessionError) || TERMINAL_REFRESH_CODES.has(sessionError.code ?? "")) {
          const successor = await this.client.auth.getSession();
          if (successor.data.session) throw new MultiAccountAuthRecoveryRequired();
          this.deadSession = true;
          this.onTerminalExpiry();
          throw new MultiAccountSessionExpired();
        }
        throw new MultiAccountAuthRecoveryRequired();
      }
      const session = data.session ?? null;
      if (!session) {
        if (this.deadSession) throw new MultiAccountSessionExpired();
        return null;
      }
      const { data: userData, error } = await this.client.auth.getUser();
      const latest = await this.client.auth.getSession();
      if (this.disposed || !this.checkOwned()) throw new MultiAccountSessionExpired();
      if (error) {
        if (latest.data.session && !sameCredentials(session, latest.data.session)) {
          throw new MultiAccountAuthRecoveryRequired();
        }
        if (isAuthSessionMissingError(error)) {
          this.deadSession = true;
          this.onTerminalExpiry();
          throw new MultiAccountSessionExpired();
        }
        throw new MultiAccountAuthRecoveryRequired();
      }
      if (
        latest.error ||
        !latest.data.session ||
        !userData.user ||
        userData.user.id !== this.userId ||
        userData.user.id !== latest.data.session.user.id
      ) {
        throw new MultiAccountAuthRecoveryRequired();
      }
      this.deadSession = false;
      return latest.data.session;
    } catch (error) {
      if (error instanceof MultiAccountSessionExpired || error instanceof MultiAccountAuthRecoveryRequired) {
        throw error;
      }
      throw new MultiAccountAuthRecoveryRequired();
    }
  }
}

export interface PinnedAccountContext {
  readonly runtime: AccountSessionRuntime;
  readonly userId: string;
  readonly loginId: string;
  readonly viewGeneration: number;
  isCurrent(): boolean;
}

/**
 * Coordinates per-login runtimes, durable positive ownership, attempt-bound direct GoTrue staging,
 * fresh-sign-in cutover, and cross-tab reconciliation for one deployment.
 */
export class AccountManager {
  readonly deployment: MultiAccountDeployment;
  readonly originHash: string;
  readonly legacyKey: string;
  readonly sharedPersistenceAvailable: boolean;

  private readonly env: MultiAccountEnv;
  private readonly runtimes = new Map<string, AccountSessionRuntime>();
  private readonly channel: BroadcastChannelLike | null;
  private readonly cleanups: Array<() => void> = [];

  private memoryOwnership: DurableOwnershipTable = { version: 1, allSignOutGen: 1, accounts: [] };
  private readonly tabFencedLoginIds = new Set<string>();
  private tabActive: { userId: string; loginId: string } | null = null;
  private viewGeneration = 0;
  private destroyed = false;

  constructor(deployment: MultiAccountDeployment, envOverrides: Partial<MultiAccountEnv> = {}) {
    this.deployment = deployment;
    this.originHash = deploymentOriginHash(deployment.url);
    this.legacyKey = legacyStorageKey(deployment.url);
    this.env = { ...defaultEnv(), ...envOverrides };

    // C4: Shared persistent rotation requires cross-context Web Locks + readable localStorage.
    // Without Web Locks, fall back strictly to single-context memory-only mode.
    this.sharedPersistenceAvailable = Boolean(this.env.webLocks && this.env.localStorage);

    if (this.sharedPersistenceAvailable && this.env.createBroadcastChannel) {
      let ch: BroadcastChannelLike | null = null;
      try { ch = this.env.createBroadcastChannel(crossTabChannelName(this.originHash)); } catch { ch = null; }
      this.channel = ch;
      if (ch) {
        const onMessage = (event: MessageEvent) => {
          const payload = event.data as CrossTabAccountEvent | null;
          if (!payload || payload.originHash !== this.originHash) return;
          if (payload.type === "ownership-changed" || payload.type === "login-rotated") {
            this.reconcile();
          }
        };
        ch.addEventListener("message", onMessage);
        this.cleanups.push(() => {
          try { ch.removeEventListener("message", onMessage); } catch { /* ignore */ }
          try { ch.close(); } catch { /* ignore */ }
        });
      }
    } else {
      this.channel = null;
    }

    if (this.sharedPersistenceAvailable && this.env.addStorageListener) {
      this.cleanups.push(
        this.env.addStorageListener((event) => {
          if (this.env.localStorage && event.storageArea && event.storageArea !== this.env.localStorage) return;
          const k = event.key;
          if (
            k === null ||
            k === accountsStorageKey(this.originHash) ||
            k.startsWith(slotStoragePrefix(this.originHash))
          ) {
            this.reconcile();
          }
        }),
      );
    }

    if (this.env.addVisibilityListener) {
      this.cleanups.push(this.env.addVisibilityListener(() => this.reconcile()));
    }
  }

  /**
   * Startup initialization + fresh-sign-in cutover (C4).
   * Never imports or copies `sb-<projectRef>-auth-token`; clears it once under
   * `registry -> lock:${legacyKey}` and initializes durable ownership cleanly.
   */
  async initialize(): Promise<{ accounts: readonly AccountRecord[]; active: { userId: string; loginId: string } | null; cutoverClearedLegacy: boolean }> {
    let cutoverClearedLegacy = false;
    if (this.sharedPersistenceAvailable) {
      const read = this.readDurableOwnership();
      if (!read.ok && read.reason === "missing") {
        try {
          cutoverClearedLegacy = await this.withRegistryLock(async () => {
            return this.withLegacyLock(async () => {
              const recheck = this.readDurableOwnership();
              if (recheck.ok) return false;
              if (!recheck.ok && recheck.reason !== "missing") return false;
              const hadLegacy = this.safeLocalGet(this.legacyKey) !== null;
              this.safeLocalRemove(this.legacyKey);
              this.writeDurableOwnership({ version: 1, allSignOutGen: 1, accounts: [] });
              this.sweepOrphanSlots([]);
              return hadLegacy;
            });
          });
        } catch {
          // Fail closed cleanly on storage write failure during cutover.
          cutoverClearedLegacy = false;
        }
      }
    }

    this.reconcile();
    return {
      accounts: this.listAccounts(),
      active: this.activeAccount(),
      cutoverClearedLegacy,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }

  /** Current view generation (bumps on every account switch / forced teardown so A->B->A never revives old work). */
  currentViewGeneration(): number {
    return this.viewGeneration;
  }

  /** Authoritative list of owned accounts (fails closed to empty if durable ownership is unreadable). */
  listAccounts(): readonly AccountRecord[] {
    if (!this.sharedPersistenceAvailable) {
      return this.memoryOwnership.accounts.filter((a) => !this.tabFencedLoginIds.has(a.loginId));
    }
    const read = this.readDurableOwnership();
    return read.ok ? read.state.accounts.filter((a) => !this.tabFencedLoginIds.has(a.loginId)) : [];
  }

  /** Current tab's pinned active account, falling back to shared default -> first owned account. */
  activeAccount(): { userId: string; loginId: string } | null {
    const accounts = this.listAccounts();
    if (accounts.length === 0) {
      this.tabActive = null;
      return null;
    }
    if (this.tabActive) {
      const stillOwned = accounts.find(
        (a) => a.userId === this.tabActive!.userId && a.loginId === this.tabActive!.loginId,
      );
      if (stillOwned) return { userId: stillOwned.userId, loginId: stillOwned.loginId };
    }
    const storedTab = this.readTabAccount();
    if (storedTab) {
      const match = accounts.find((a) => a.userId === storedTab.userId && a.loginId === storedTab.loginId);
      if (match) {
        this.tabActive = { userId: match.userId, loginId: match.loginId };
        return this.tabActive;
      }
    }
    const defaultUserId = this.safeLocalGet(activeAccountStorageKey(this.originHash));
    const defaultMatch = defaultUserId ? accounts.find((a) => a.userId === defaultUserId) : undefined;
    const chosen = defaultMatch ?? accounts[0]!;
    this.setTabActiveInternal(chosen.userId, chosen.loginId, false);
    return { userId: chosen.userId, loginId: chosen.loginId };
  }

  /** Switch this tab's active account (bumps viewGeneration so A->B->A cannot revive stale operations). */
  switchActiveAccount(userId: string): AccountRecord | null {
    const accounts = this.listAccounts();
    const target = accounts.find((a) => a.userId === userId);
    if (!target) return null;
    const changed = !this.tabActive || this.tabActive.userId !== target.userId || this.tabActive.loginId !== target.loginId;
    if (changed) this.viewGeneration += 1;
    this.setTabActiveInternal(target.userId, target.loginId, true);
    this.ensureRuntime(target);
    this.env.onOwnershipChange?.(accounts, { userId: target.userId, loginId: target.loginId });
    return target;
  }

  /**
   * Synchronous entry-point helper (C2): pin the active (or specified) runtime + loginId + viewGeneration
   * BEFORE the first `await`, returning `isCurrent()` to recheck before every send, retry, join, or commit.
   */
  pinContext(userId?: string): PinnedAccountContext | null {
    const target = userId
      ? this.listAccounts().find((a) => a.userId === userId) ?? null
      : (() => {
          const active = this.activeAccount();
          return active ? this.listAccounts().find((a) => a.userId === active.userId && a.loginId === active.loginId) ?? null : null;
        })();
    if (!target) return null;
    const runtime = this.ensureRuntime(target);
    if (!runtime || !runtime.isLiveOwned()) return null;
    const pinnedViewGen = this.viewGeneration;
    const pinnedUserId = target.userId;
    const pinnedLoginId = target.loginId;
    return {
      runtime,
      userId: pinnedUserId,
      loginId: pinnedLoginId,
      viewGeneration: pinnedViewGen,
      isCurrent: () => {
        if (this.destroyed || runtime.isDisposed()) return false;
        if (this.viewGeneration !== pinnedViewGen) return false;
        if (!runtime.isLiveOwned()) return false;
        const active = this.tabActive;
        return Boolean(active && active.userId === pinnedUserId && active.loginId === pinnedLoginId);
      },
    };
  }

  /** Retrieve the live, owned AccountSessionRuntime for a specific userId (or active account). */
  runtimeFor(userId?: string): AccountSessionRuntime | null {
    const accounts = this.listAccounts();
    const record = userId
      ? accounts.find((a) => a.userId === userId)
      : (() => {
          const active = this.activeAccount();
          return active ? accounts.find((a) => a.userId === active.userId && a.loginId === active.loginId) : undefined;
        })();
    if (!record) return null;
    return this.ensureRuntime(record);
  }

  /** Retrieve a runtime pinned to an exact { userId, loginId } pair (for 401 command retry). */
  runtimeForLogin(userId: string, loginId: string): AccountSessionRuntime | null {
    const accounts = this.listAccounts();
    const record = accounts.find((a) => a.userId === userId && a.loginId === loginId);
    if (!record) return null;
    return this.ensureRuntime(record);
  }

  /**
   * Reconcile in-memory runtimes and active tab state against durable positive ownership.
   * Disposes any unowned runtime immediately and triggers forced teardown if the tab's active login ended.
   */
  reconcile(): void {
    if (this.destroyed) return;
    const read = this.sharedPersistenceAvailable
      ? this.readDurableOwnership()
      : ({ ok: true, state: this.memoryOwnership } as const);

    if (!read.ok) {
      const hadActive = this.tabActive;
      for (const runtime of this.runtimes.values()) runtime.dispose();
      this.runtimes.clear();
      this.tabActive = null;
      if (hadActive) {
        this.viewGeneration += 1;
        this.clearTabAccount();
        this.env.onForcedTeardown?.({
          reason: read.reason === "missing" ? "all-signed-out" : "storage-unavailable",
          userId: hadActive.userId,
          loginId: hadActive.loginId,
        });
      }
      this.env.onOwnershipChange?.([], null);
      return;
    }

    const visibleAccounts = read.state.accounts.filter((a) => !this.tabFencedLoginIds.has(a.loginId));
    const ownedByLogin = new Map(visibleAccounts.map((a) => [a.loginId, a]));

    // Dispose any runtime whose loginId is no longer positively owned (or whose allSignOutGen is stale).
    for (const [loginId, runtime] of [...this.runtimes.entries()]) {
      const owned = ownedByLogin.get(loginId);
      if (!owned || owned.userId !== runtime.userId || runtime.allSignOutGen !== read.state.allSignOutGen) {
        runtime.dispose();
        this.runtimes.delete(loginId);
      } else {
        runtime.reconcileFromDisk();
      }
    }

    // Check if the tab's pinned active login was signed out in another tab.
    if (this.tabActive && !ownedByLogin.has(this.tabActive.loginId)) {
      const departed = this.tabActive;
      this.tabActive = null;
      this.clearTabAccount();
      this.viewGeneration += 1;
      this.env.onForcedTeardown?.({
        reason: visibleAccounts.length === 0 ? "all-signed-out" : "signed-out",
        userId: departed.userId,
        loginId: departed.loginId,
      });
    }

    const nextActive = this.activeAccount();
    this.env.onOwnershipChange?.(visibleAccounts, nextActive);
  }

  // ── C1: Direct GoTrue PKCE / Pinned-Email OTP / Password Staging ──────────────────────────────

  /**
   * Start an OAuth sign-in attempt (S256 PKCE). Stores ONLY attempt metadata + codeVerifier in
   * sessionStorage; returns the GoTrue authorize URL to navigate to.
   */
  async startOAuthAttempt(options: {
    provider: string;
    purpose: SignInPurpose;
    returnRoute: string;
    origin: string;
  }): Promise<{ attemptId: string; authorizeUrl: string }> {
    const entry = authProvider(options.provider);
    const route = normalizeReturnRoute(options.returnRoute);
    if (!ALLOWED_AUTH_RETURN_ROUTES.has(route)) {
      throw new Error("Unsupported sign-in return route.");
    }
    const { codeVerifier, codeChallenge } = await generatePkcePair(this.env);
    const attemptId = this.env.randomUUID();
    const createdAt = this.env.now();
    const allSignOutGenAtStart = this.currentAllSignOutGen();
    const attempt: SignInAttempt = {
      attemptId,
      originHash: this.originHash,
      purpose: options.purpose,
      returnRoute: route,
      method: "oauth",
      codeVerifier,
      allSignOutGenAtStart,
      createdAt,
      expiresAt: createdAt + SIGN_IN_ATTEMPT_TTL_MS,
    };
    this.writeAttempt(attempt);

    const returnUrl = new URL(route, options.origin);
    returnUrl.searchParams.set("cs_attempt", attemptId);

    const authorize = new URL(`${this.deployment.url.replace(/\/+$/, "")}/auth/v1/authorize`);
    authorize.searchParams.set("provider", entry.id);
    authorize.searchParams.set("redirect_to", returnUrl.href);
    authorize.searchParams.set("code_challenge", codeChallenge);
    authorize.searchParams.set("code_challenge_method", "s256");
    if (entry.id === "google" && options.purpose === "add-account") {
      authorize.searchParams.set("prompt", "select_account");
    }
    return { attemptId, authorizeUrl: authorize.href };
  }

  /**
   * Start a pinned-email OTP sign-in attempt. Pins normalized email and purpose in sessionStorage
   * and requests an email OTP code directly from GoTrue (no persistent staging client).
   */
  async startEmailOtpAttempt(options: {
    email: string;
    purpose: SignInPurpose;
    returnRoute: string;
  }): Promise<{ attemptId: string }> {
    const normalizedEmail = options.email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error("Enter your email address.");
    const route = normalizeReturnRoute(options.returnRoute);
    if (!ALLOWED_AUTH_RETURN_ROUTES.has(route)) {
      throw new Error("Unsupported sign-in return route.");
    }
    const attemptId = this.env.randomUUID();
    const createdAt = this.env.now();
    const attempt: SignInAttempt = {
      attemptId,
      originHash: this.originHash,
      purpose: options.purpose,
      returnRoute: route,
      method: "email-otp",
      email: normalizedEmail,
      allSignOutGenAtStart: this.currentAllSignOutGen(),
      createdAt,
      expiresAt: createdAt + SIGN_IN_ATTEMPT_TTL_MS,
    };
    this.writeAttempt(attempt);

    const response = await this.env.fetcher(
      `${this.deployment.url.replace(/\/+$/, "")}/auth/v1/otp`,
      {
        method: "POST",
        headers: {
          apikey: this.deployment.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: normalizedEmail, create_user: true }),
      },
    );
    if (!response.ok) {
      this.clearAttempt(attemptId);
      const errBody = await response.json().catch(() => null) as { error_code?: string; code?: string; msg?: string } | null;
      const err = new Error(errBody?.msg || "Could not send sign-in code.") as Error & { status?: number; code?: string };
      err.status = response.status;
      err.code = errBody?.error_code ?? errBody?.code;
      throw err;
    }
    return { attemptId };
  }

  /**
   * Verify a pinned-email OTP code in the initiating tab using the attempt's pinned email address.
   * Keeps credentials strictly in memory until verified via GET /auth/v1/user and promoted under lock.
   */
  async verifyEmailOtpAttempt(options: {
    attemptId: string;
    token: string;
    replaceExisting?: boolean;
  }): Promise<PromotionOutcome | { kind: "refused"; reason: "missing_attempt" | "invalid_attempt" | "expired_attempt" | "exchange_failed" }> {
    const attempt = this.readAttempt(options.attemptId);
    this.clearAttempt(options.attemptId);
    if (!attempt) return { kind: "refused", reason: "missing_attempt" };
    if (attempt.originHash !== this.originHash || attempt.method !== "email-otp" || !attempt.email) {
      return { kind: "refused", reason: "invalid_attempt" };
    }
    if (this.env.now() > attempt.expiresAt) return { kind: "refused", reason: "expired_attempt" };
    if (attempt.allSignOutGenAtStart !== this.currentAllSignOutGen()) {
      return { kind: "refused", reason: "fenced_by_signout_all", stagingRevoked: { status: "skipped" } };
    }

    const response = await this.env.fetcher(
      `${this.deployment.url.replace(/\/+$/, "")}/auth/v1/verify`,
      {
        method: "POST",
        headers: {
          apikey: this.deployment.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: attempt.email,
          token: options.token.trim(),
          type: "email",
        }),
      },
    );
    if (!response.ok) return { kind: "refused", reason: "exchange_failed" };
    const payload = await response.json().catch(() => null);
    return this.verifyAndPromoteStagingSession(payload, attempt.allSignOutGenAtStart, Boolean(options.replaceExisting));
  }

  /**
   * Sign in with email and password directly against GoTrue in memory (zero staging client/broadcast).
   */
  async signInWithPasswordStaging(options: {
    email: string;
    password: string;
    replaceExisting?: boolean;
  }): Promise<PromotionOutcome | { kind: "refused"; reason: "exchange_failed"; status: number; code?: string }> {
    const allSignOutGenAtStart = this.currentAllSignOutGen();
    const response = await this.env.fetcher(
      `${this.deployment.url.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: this.deployment.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: options.email.trim(), password: options.password }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error_code?: string; code?: string } | null;
      return { kind: "refused", reason: "exchange_failed", status: response.status, code: body?.error_code ?? body?.code };
    }
    const payload = await response.json().catch(() => null);
    return this.verifyAndPromoteStagingSession(payload, allSignOutGenAtStart, Boolean(options.replaceExisting));
  }

  /** Cancel an in-progress attempt and erase its verifier from sessionStorage. */
  cancelAttempt(attemptId: string): void {
    this.clearAttempt(attemptId);
  }

  /**
   * Dedicated startup callback bootstrap (C1).
   * Runs BEFORE app init or analytics: captures callback params, immediately scrubs them from the URL,
   * refuses bearer fragments / token_hash / recovery / email_change, validates the one-use attempt in
   * sessionStorage, exchanges S256 PKCE code directly with GoTrue in memory, verifies identity, strips
   * provider tokens, and promotes under the strict lock order.
   */
  async consumeAuthCallbackBootstrap(location: LocationLike, history: HistoryLike): Promise<CallbackBootstrapResult> {
    const search = new URLSearchParams(location.search.replace(/^\?/, ""));
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));

    const hasBearerFragment = hash.has("access_token") || hash.has("refresh_token");
    const hasTokenHash = search.has("token_hash") || hash.has("token_hash");
    const callbackType = (search.get("type") ?? hash.get("type") ?? "").toLowerCase();
    const code = search.get("code");
    const attemptId = search.get("cs_attempt");
    const errorCode = search.get("error_code") ?? hash.get("error_code") ?? search.get("error") ?? hash.get("error");

    const hasAnyAuthParam =
      hasBearerFragment ||
      hasTokenHash ||
      Boolean(code) ||
      Boolean(attemptId) ||
      Boolean(errorCode) ||
      Boolean(callbackType && ["recovery", "email_change", "magiclink", "email", "signup", "invite"].includes(callbackType));

    if (!hasAnyAuthParam) return { kind: "none" };

    // Scrub ALL credential-bearing and attempt params immediately before any network/app work.
    const cleanSearch = new URLSearchParams(search);
    for (const key of ["code", "cs_attempt", "token_hash", "type", "error", "error_code", "error_description"]) {
      cleanSearch.delete(key);
    }
    const qs = cleanSearch.toString();
    const cleanUrl = `${location.pathname}${qs ? `?${qs}` : ""}`;
    try { history.replaceState(null, "", cleanUrl); } catch { /* ignore */ }

    const currentRoute = normalizeReturnRoute(location.pathname);

    // Refuse bearer fragments (#access_token=...) outright on multi-account callback bootstrap.
    if (hasBearerFragment) {
      if (attemptId) this.clearAttempt(attemptId);
      return { kind: "refused", reason: "bearer_fragment", message: "That sign-in callback is not supported. Start sign-in from CommonSwarm." };
    }

    // Refuse recovery and email_change callbacks on this path.
    if (callbackType === "recovery" || callbackType === "email_change") {
      if (attemptId) this.clearAttempt(attemptId);
      return { kind: "refused", reason: "unsupported_callback_type", message: "That link cannot be used to add an account." };
    }

    // Refuse generic token_hash callbacks on this path (email continuation uses pinned OTP in initiating tab).
    if (hasTokenHash) {
      if (attemptId) this.clearAttempt(attemptId);
      return {
        kind: "refused",
        reason: this.listAccounts().length > 0 ? "separate_context_email" : "token_hash_refused",
        message: "Enter the emailed sign-in code in the tab where you started sign-in, or sign in again here.",
      };
    }

    if (errorCode) {
      if (attemptId) this.clearAttempt(attemptId);
      return {
        kind: "refused",
        reason: "provider_error",
        message: errorCode === "otp_expired"
          ? "That sign-in link has expired or was already used."
          : "That sign-in did not work.",
      };
    }

    if (!code) {
      if (attemptId) this.clearAttempt(attemptId);
      return { kind: "refused", reason: "invalid_attempt", message: "That sign-in could not be verified." };
    }

    if (!attemptId) {
      return {
        kind: "refused",
        reason: this.listAccounts().length > 0 ? "separate_context_email" : "missing_attempt",
        message: "Sign in from this tab to add an account.",
      };
    }

    const attempt = this.readAttempt(attemptId);
    // One-use: clear attempt & verifier from sessionStorage immediately before network exchange.
    this.clearAttempt(attemptId);

    if (!attempt) {
      return {
        kind: "refused",
        reason: this.listAccounts().length > 0 ? "separate_context_email" : "missing_attempt",
        message: "That sign-in attempt was not found in this tab. Start sign-in again here.",
      };
    }
    if (
      attempt.originHash !== this.originHash ||
      attempt.method !== "oauth" ||
      !attempt.codeVerifier ||
      attempt.returnRoute !== currentRoute
    ) {
      return { kind: "refused", reason: "invalid_attempt", message: "That sign-in attempt did not match this page." };
    }
    if (this.env.now() > attempt.expiresAt) {
      return { kind: "refused", reason: "expired_attempt", message: "That sign-in attempt expired. Try again." };
    }
    if (attempt.allSignOutGenAtStart !== this.currentAllSignOutGen()) {
      return { kind: "refused", reason: "fenced_by_signout_all", message: "Sign-in was cancelled because you signed out." };
    }

    // Exchange S256 PKCE code directly with GoTrue; keep credentials strictly in memory until promotion.
    let exchangeResp: Response;
    try {
      exchangeResp = await this.env.fetcher(
        `${this.deployment.url.replace(/\/+$/, "")}/auth/v1/token?grant_type=pkce`,
        {
          method: "POST",
          headers: {
            apikey: this.deployment.anonKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ auth_code: code, code_verifier: attempt.codeVerifier }),
        },
      );
    } catch {
      return { kind: "refused", reason: "exchange_failed", message: "Could not complete sign-in. Try again." };
    }

    if (!exchangeResp.ok) {
      return { kind: "refused", reason: "exchange_failed", message: "Could not complete sign-in. Try again." };
    }
    const payload = await exchangeResp.json().catch(() => null);
    const outcome = await this.verifyAndPromoteStagingSession(payload, attempt.allSignOutGenAtStart, false);
    if (outcome.kind === "promoted") {
      return { kind: "promoted", account: outcome.account, purpose: attempt.purpose, replacedLoginId: outcome.replacedLoginId };
    }
    if (outcome.kind === "kept-existing") {
      return { kind: "kept-existing", account: outcome.account, purpose: attempt.purpose, stagingRevoked: outcome.stagingRevoked };
    }
    return {
      kind: "refused",
      reason: outcome.reason,
      message: outcome.reason === "cap_reached"
        ? new AccountCapReachedError().message
        : "Sign-in could not be completed. Try again.",
    };
  }

  // ── C3 & C5: Authoritative Durable Sign-Out (One Account vs All Accounts) ────────────────────

  /**
   * Ordinary sign-out ("Sign out on this device", scope=local).
   * Step 1: Write & verify durable ownership removal FIRST under registry lock.
   *         If Step 1 fails, DO NOT delete the slot and DO NOT report browser-wide sign-out succeeded;
   *         still tear down the current tab immediately and report browser cleanup unconfirmed.
   * Step 2: Only after Step 1 verifies read-back, delete the slot, dispose runtime, broadcast
   *         credential-free ownership-changed, and perform bounded best-effort remote scope=local logout.
   */
  async signOutAccount(userId: string, loginId: string): Promise<SignOutAccountResult> {
    const existingRuntime = this.runtimes.get(loginId) ?? null;
    let capturedAccessToken = existingRuntime?.peekAccessToken() ?? null;
    if (!capturedAccessToken && this.sharedPersistenceAvailable) {
      capturedAccessToken = parseSavedSession(this.safeLocalGet(slotStorageKey(this.originHash, loginId)))?.access_token ?? null;
    }

    let step1Succeeded = false;
    let nextGen = this.currentAllSignOutGen();
    let remainingAccounts: AccountRecord[] = [];

    try {
      await this.withRegistryLock(async () => {
        if (!this.sharedPersistenceAvailable) {
          this.memoryOwnership = {
            ...this.memoryOwnership,
            accounts: this.memoryOwnership.accounts.filter((a) => !(a.userId === userId && a.loginId === loginId)),
          };
          remainingAccounts = [...this.memoryOwnership.accounts];
          nextGen = this.memoryOwnership.allSignOutGen;
          step1Succeeded = true;
          return;
        }
        const read = this.readDurableOwnership();
        if (!read.ok) throw new DurableOwnershipWriteError();
        const nextAccounts = read.state.accounts.filter((a) => !(a.userId === userId && a.loginId === loginId));
        const nextTable: DurableOwnershipTable = {
          version: 1,
          allSignOutGen: read.state.allSignOutGen,
          accounts: nextAccounts,
        };
        // Step 1: Write & verify durable ownership removal BEFORE deleting any slot.
        this.writeDurableOwnership(nextTable);
        remainingAccounts = nextAccounts;
        nextGen = nextTable.allSignOutGen;
        step1Succeeded = true;
      });
    } catch {
      step1Succeeded = false;
    }

    // Always tear down the current tab immediately regardless of storage failure!
    // If Step 1 failed, fence this loginId locally in this tab so activeAccount()/runtimeFor()/pinContext()
    // cannot resurrect it from the unchanged durable table.
    if (step1Succeeded) {
      this.tabFencedLoginIds.delete(loginId);
    } else {
      this.tabFencedLoginIds.add(loginId);
    }
    existingRuntime?.dispose();
    this.runtimes.delete(loginId);
    const wasActive = Boolean(this.tabActive && this.tabActive.userId === userId && this.tabActive.loginId === loginId);
    if (wasActive) {
      this.tabActive = null;
      this.clearTabAccount();
      this.viewGeneration += 1;
    }

    if (!step1Succeeded) {
      // C3: Step 1 failed -> DO NOT delete the slot and DO NOT report browser-wide sign-out succeeded.
      const nextActive = this.activeAccount();
      this.env.onOwnershipChange?.(this.listAccounts(), nextActive);
      return {
        browserSignedOut: false,
        localTabTornDown: true,
        slotDeleted: false,
        remoteRevocation: { status: "skipped" },
        nextActive,
        notice: "Signed out in this tab, but browser-wide sign-out could not be confirmed. Try again.",
      };
    }

    // Step 2: Durable ownership removal is verified -> now delete slot without blocking behind a slow
    // peer refresh (durable ownership already fences any peer holding lock:${slotKey}).
    let slotDeleted = true;
    if (this.sharedPersistenceAvailable) {
      try {
        await this.tryWithLoginLock(loginId, async () => {
          this.env.localStorage!.removeItem(slotStorageKey(this.originHash, loginId));
        });
      } catch {
        // Lock busy or removal failed; attempt direct removal since loginId is already durably unowned.
        try {
          this.env.localStorage!.removeItem(slotStorageKey(this.originHash, loginId));
        } catch {
          slotDeleted = false;
        }
      }
      if (this.safeLocalGet(activeAccountStorageKey(this.originHash)) === userId) {
        if (remainingAccounts.length > 0) {
          this.safeLocalSet(activeAccountStorageKey(this.originHash), remainingAccounts[0]!.userId);
        } else {
          this.safeLocalRemove(activeAccountStorageKey(this.originHash));
        }
      }
    }

    this.broadcast({
      type: "ownership-changed",
      originHash: this.originHash,
      userId,
      loginId,
      allSignOutGen: nextGen,
    });

    const nextActive = this.activeAccount();
    this.env.onOwnershipChange?.(remainingAccounts, nextActive);

    // Best-effort remote scope=local revocation AFTER durable local fencing & teardown.
    const remoteRevocation = await this.bestEffortRemoteLocalLogout(capturedAccessToken);
    const notice = remoteRevocation.status === "unconfirmed"
      ? "Signed out on this device. Could not reach the server to confirm remote sign-out."
      : undefined;

    return {
      browserSignedOut: true,
      localTabTornDown: true,
      slotDeleted,
      remoteRevocation,
      nextActive,
      notice,
    };
  }

  /**
   * "Sign out all accounts on this device" (scope=local for each browser-registered session).
   * Step 1: Advance allSignOutGen and clear durable accounts FIRST (verified read-back) under
   *         `registry -> lock:${legacyKey}`. If Step 1 fails, DO NOT delete slots or claim
   *         browser-wide sign-out; tear down the current tab immediately and report unconfirmed.
   * Step 2: Only after Step 1 verifies, remove legacyKey, all login:* slots (ascending loginId),
   *         active pointer, and all in-tab attempt:* verifiers; broadcast; run bounded parallel
   *         best-effort remote scope=local revocations.
   */
  async signOutAllAccounts(): Promise<SignOutAllResult> {
    const capturedSessions: Array<{ userId: string; loginId: string; accessToken: string | null }> = [];
    let step1Succeeded = false;
    let nextGen = this.currentAllSignOutGen() + 1;

    try {
      await this.withRegistryLock(async () => {
        await this.withLegacyLock(async () => {
          if (!this.sharedPersistenceAvailable) {
            for (const rec of this.memoryOwnership.accounts) {
              capturedSessions.push({
                userId: rec.userId,
                loginId: rec.loginId,
                accessToken: this.runtimes.get(rec.loginId)?.peekAccessToken() ?? null,
              });
            }
            nextGen = this.memoryOwnership.allSignOutGen + 1;
            this.memoryOwnership = { version: 1, allSignOutGen: nextGen, accounts: [] };
            step1Succeeded = true;
            return;
          }

          const read = this.readDurableOwnership();
          if (!read.ok && read.reason !== "missing") throw new DurableOwnershipWriteError();
          const currentAccounts = read.ok ? read.state.accounts : [];
          for (const rec of currentAccounts) {
            const tok =
              this.runtimes.get(rec.loginId)?.peekAccessToken() ??
              parseSavedSession(this.safeLocalGet(slotStorageKey(this.originHash, rec.loginId)))?.access_token ??
              null;
            capturedSessions.push({ userId: rec.userId, loginId: rec.loginId, accessToken: tok });
          }
          nextGen = (read.ok ? read.state.allSignOutGen : 1) + 1;
          // Step 1: Write & verify durable ownership clear + allSignOutGen bump FIRST.
          this.writeDurableOwnership({ version: 1, allSignOutGen: nextGen, accounts: [] });
          step1Succeeded = true;
          // Step 2a (still holding registry -> lock:${legacyKey}): remove any stray legacyKey.
          this.safeLocalRemove(this.legacyKey);
        });
      });
    } catch {
      step1Succeeded = false;
    }

    // Always tear down all in-tab runtimes, sockets, attempts, and active state immediately!
    if (step1Succeeded) {
      this.tabFencedLoginIds.clear();
    } else {
      for (const s of capturedSessions) this.tabFencedLoginIds.add(s.loginId);
      for (const id of this.runtimes.keys()) this.tabFencedLoginIds.add(id);
      const rawRead = this.sharedPersistenceAvailable ? this.readDurableOwnership() : null;
      if (rawRead?.ok) {
        for (const a of rawRead.state.accounts) this.tabFencedLoginIds.add(a.loginId);
      }
    }
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.tabActive = null;
    this.clearTabAccount();
    this.clearAllInTabAttempts();
    this.viewGeneration += 1;

    if (!step1Succeeded) {
      this.env.onOwnershipChange?.(this.listAccounts(), null);
      return {
        browserSignedOut: false,
        localTabTornDown: true,
        slotsDeleted: 0,
        remoteRevocations: [],
        notice: "Signed out in this tab, but browser-wide sign-out could not be confirmed. Try again.",
      };
    }

    // Step 2b: Durable ownership fence verified -> clear all login:* slots (ascending loginId) & active pointer.
    let slotsDeleted = 0;
    if (this.sharedPersistenceAvailable) {
      const loginIds = [...new Set([
        ...capturedSessions.map((s) => s.loginId),
        ...this.listStoredLoginIds(),
      ])].sort();

      for (const loginId of loginIds) {
        try {
          await this.tryWithLoginLock(loginId, async () => {
            this.env.localStorage!.removeItem(slotStorageKey(this.originHash, loginId));
            slotsDeleted += 1;
          });
        } catch {
          try {
            this.env.localStorage!.removeItem(slotStorageKey(this.originHash, loginId));
            slotsDeleted += 1;
          } catch { /* durable fence already blocks this loginId */ }
        }
      }
      this.safeLocalRemove(activeAccountStorageKey(this.originHash));
    }

    this.broadcast({
      type: "ownership-changed",
      originHash: this.originHash,
      allSignOutGen: nextGen,
    });
    this.env.onOwnershipChange?.([], null);

    // Bounded parallel best-effort remote scope=local revocations for browser-registered sessions only.
    const remoteRevocations = await Promise.all(
      capturedSessions.map(async (entry) => ({
        userId: entry.userId,
        loginId: entry.loginId,
        result: await this.bestEffortRemoteLocalLogout(entry.accessToken),
      })),
    );
    const anyUnconfirmed = remoteRevocations.some((r) => r.result.status === "unconfirmed");
    return {
      browserSignedOut: true,
      localTabTornDown: true,
      slotsDeleted,
      remoteRevocations,
      notice: anyUnconfirmed
        ? "Signed out of all accounts on this device. Some sessions could not be confirmed on the server."
        : undefined,
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────────────────────

  private async verifyAndPromoteStagingSession(
    rawPayload: unknown,
    allSignOutGenAtStart: number,
    replaceExisting: boolean,
  ): Promise<PromotionOutcome> {
    const rawAccess =
      rawPayload && typeof rawPayload === "object" && typeof (rawPayload as Record<string, unknown>).access_token === "string"
        ? (rawPayload as Record<string, unknown>).access_token as string
        : null;

    if (!rawAccess) {
      return { kind: "refused", reason: "identity_unverified", stagingRevoked: { status: "skipped" } };
    }

    // Verify human identity against configured GoTrue with this access token before promotion.
    const verifiedUser = await this.verifyAccessTokenWithGoTrue(rawAccess);
    if (!verifiedUser) {
      const stagingRevoked = await this.bestEffortRemoteLocalLogout(rawAccess);
      return { kind: "refused", reason: "identity_unverified", stagingRevoked };
    }

    const minimized = stripSessionFields(rawPayload, verifiedUser);
    if (!minimized) {
      const stagingRevoked = await this.bestEffortRemoteLocalLogout(rawAccess);
      return { kind: "refused", reason: "identity_unverified", stagingRevoked };
    }

    const { label, secondary } = accountLabelsFromUser(verifiedUser);

    type LockedResult =
      | { kind: "promoted"; account: AccountRecord; replacedLoginId?: string; allSignOutGen: number; session: MinimizedSession }
      | { kind: "kept-existing"; account: AccountRecord }
      | { kind: "refused"; reason: "cap_reached" | "fenced_by_signout_all" | "ownership_write_failed" };

    const lockedResult: LockedResult = await this.withRegistryLock(async () => {
      const read = this.sharedPersistenceAvailable
        ? this.readDurableOwnership()
        : ({ ok: true, state: this.memoryOwnership } as const);

      let current: DurableOwnershipTable;
      if (read.ok) {
        current = read.state;
      } else if (!this.sharedPersistenceAvailable) {
        current = this.memoryOwnership;
      } else if (read.reason === "missing") {
        current = { version: 1, allSignOutGen: allSignOutGenAtStart, accounts: [] };
      } else {
        return { kind: "refused", reason: "ownership_write_failed" };
      }

      if (current.allSignOutGen !== allSignOutGenAtStart) {
        return { kind: "refused", reason: "fenced_by_signout_all" };
      }

      const existing = current.accounts.find((a) => a.userId === verifiedUser.id);
      if (existing && !replaceExisting) {
        return { kind: "kept-existing", account: existing };
      }

      if (!existing && current.accounts.length >= MAX_SIGNED_IN_ACCOUNTS) {
        return { kind: "refused", reason: "cap_reached" };
      }

      const newLoginId = this.env.randomUUID();
      const newRecord: AccountRecord = {
        userId: verifiedUser.id,
        loginId: newLoginId,
        label,
        secondary,
        addedAt: this.env.now(),
      };
      const nextAccounts = existing
        ? current.accounts.map((a) => (a.userId === verifiedUser.id ? newRecord : a))
        : [...current.accounts, newRecord];
      const nextTable: DurableOwnershipTable = {
        version: 1,
        allSignOutGen: current.allSignOutGen,
        accounts: nextAccounts,
      };

      if (this.sharedPersistenceAvailable) {
        const slot = slotStorageKey(this.originHash, newLoginId);
        const serializedSession = JSON.stringify(minimized);
        try {
          await this.withLoginLock(newLoginId, async () => {
            this.env.localStorage!.setItem(slot, serializedSession);
            if (this.env.localStorage!.getItem(slot) !== serializedSession) {
              throw new DurableOwnershipWriteError();
            }
          });
          // Publish durable ownership only after the new slot is safely written and read back.
          this.writeDurableOwnership(nextTable);
        } catch {
          this.safeLocalRemove(slot);
          return { kind: "refused", reason: "ownership_write_failed" };
        }
        if (existing) {
          this.safeLocalRemove(slotStorageKey(this.originHash, existing.loginId));
        }
        this.sweepOrphanSlots(nextAccounts);
      } else {
        this.memoryOwnership = nextTable;
      }

      return {
        kind: "promoted",
        account: newRecord,
        replacedLoginId: existing?.loginId,
        allSignOutGen: nextTable.allSignOutGen,
        session: minimized,
      };
    });

    if (lockedResult.kind === "kept-existing") {
      // C1/C4: Duplicate user keeps existing live session intact; remotely revoke ONLY the unused staging session.
      const stagingRevoked = await this.bestEffortRemoteLocalLogout(minimized.access_token);
      this.switchActiveAccount(lockedResult.account.userId);
      return { kind: "kept-existing", account: lockedResult.account, stagingRevoked };
    }

    if (lockedResult.kind === "refused") {
      const stagingRevoked = await this.bestEffortRemoteLocalLogout(minimized.access_token);
      return { kind: "refused", reason: lockedResult.reason, stagingRevoked };
    }

    if (lockedResult.replacedLoginId) {
      this.runtimes.get(lockedResult.replacedLoginId)?.dispose();
      this.runtimes.delete(lockedResult.replacedLoginId);
    }

    this.ensureRuntime(lockedResult.account, lockedResult.session);
    this.viewGeneration += 1;
    this.setTabActiveInternal(lockedResult.account.userId, lockedResult.account.loginId, true);
    this.broadcast({
      type: "ownership-changed",
      originHash: this.originHash,
      userId: lockedResult.account.userId,
      loginId: lockedResult.account.loginId,
      allSignOutGen: lockedResult.allSignOutGen,
    });
    this.env.onOwnershipChange?.(this.listAccounts(), {
      userId: lockedResult.account.userId,
      loginId: lockedResult.account.loginId,
    });

    return {
      kind: "promoted",
      account: lockedResult.account,
      replacedLoginId: lockedResult.replacedLoginId,
    };
  }

  private async verifyAccessTokenWithGoTrue(accessToken: string): Promise<User | null> {
    try {
      const response = await this.env.fetcher(
        `${this.deployment.url.replace(/\/+$/, "")}/auth/v1/user`,
        {
          method: "GET",
          headers: {
            apikey: this.deployment.anonKey,
            authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        },
      );
      if (!response.ok) return null;
      const body = await response.json().catch(() => null) as User | null;
      return body && typeof body.id === "string" && body.id.length > 0 ? body : null;
    } catch {
      return null;
    }
  }

  private async bestEffortRemoteLocalLogout(accessToken: string | null): Promise<RemoteRevocationResult> {
    if (!accessToken) return { status: "unconfirmed" };
    try {
      const response = await this.env.fetcher(
        `${this.deployment.url.replace(/\/+$/, "")}/auth/v1/logout?scope=local`,
        {
          method: "POST",
          headers: {
            apikey: this.deployment.anonKey,
            authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(REMOTE_LOGOUT_TIMEOUT_MS),
        },
      );
      if (response.status === 204) return { status: "confirmed", httpStatus: 204 };
      const body = await response.json().catch(() => null) as { code?: unknown; error_code?: unknown } | null;
      const code = body?.code ?? body?.error_code;
      if ((response.status === 401 || response.status === 403 || response.status === 404) && code === "session_not_found") {
        return { status: "confirmed", httpStatus: response.status };
      }
      return { status: "unconfirmed", httpStatus: response.status };
    } catch {
      return { status: "unconfirmed" };
    }
  }

  private ensureRuntime(record: AccountRecord, initialSession?: MinimizedSession): AccountSessionRuntime {
    const existing = this.runtimes.get(record.loginId);
    if (existing && !existing.isDisposed()) return existing;
    const allSignOutGen = this.currentAllSignOutGen();
    const runtime = new AccountSessionRuntime({
      deployment: this.deployment,
      originHash: this.originHash,
      userId: record.userId,
      loginId: record.loginId,
      allSignOutGen,
      persistent: this.sharedPersistenceAvailable,
      initialSession,
      env: this.env,
      checkOwned: () => this.isLoginOwned(record.userId, record.loginId, allSignOutGen),
      onSessionUpdated: (event) => {
        if (event === "TOKEN_REFRESHED") {
          this.broadcast({
            type: "login-rotated",
            originHash: this.originHash,
            userId: record.userId,
            loginId: record.loginId,
            allSignOutGen,
          });
        }
      },
      onTerminalExpiry: () => {
        this.tabFencedLoginIds.add(record.loginId);
        const expired = this.runtimes.get(record.loginId);
        this.runtimes.delete(record.loginId);
        expired?.dispose();
        if (this.tabActive?.loginId === record.loginId) {
          this.tabActive = null;
          this.clearTabAccount();
          this.viewGeneration += 1;
          this.env.onForcedTeardown?.({ reason: "expired", userId: record.userId, loginId: record.loginId });
        }
      },
    });
    this.runtimes.set(record.loginId, runtime);
    return runtime;
  }

  private isLoginOwned(userId: string, loginId: string, expectedAllSignOutGen: number): boolean {
    if (this.destroyed || this.tabFencedLoginIds.has(loginId)) return false;
    if (!this.sharedPersistenceAvailable) {
      return (
        this.memoryOwnership.allSignOutGen === expectedAllSignOutGen &&
        this.memoryOwnership.accounts.some((a) => a.userId === userId && a.loginId === loginId)
      );
    }
    const read = this.readDurableOwnership();
    // C3: Unreadable durable ownership fails closed for shared credentials.
    if (!read.ok) return false;
    if (read.state.allSignOutGen !== expectedAllSignOutGen) return false;
    return read.state.accounts.some((a) => a.userId === userId && a.loginId === loginId);
  }

  private currentAllSignOutGen(): number {
    if (!this.sharedPersistenceAvailable) return this.memoryOwnership.allSignOutGen;
    const read = this.readDurableOwnership();
    return read.ok ? read.state.allSignOutGen : 1;
  }

  private readDurableOwnership(): OwnershipReadResult {
    if (!this.env.localStorage) return { ok: false, reason: "unreadable" };
    let raw: string | null;
    try {
      raw = this.env.localStorage.getItem(accountsStorageKey(this.originHash));
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    return parseOwnershipTable(raw);
  }

  private writeDurableOwnership(next: DurableOwnershipTable): void {
    if (!this.env.localStorage) throw new DurableOwnershipWriteError();
    const key = accountsStorageKey(this.originHash);
    const serialized = JSON.stringify(next);
    try {
      this.env.localStorage.setItem(key, serialized);
      if (this.env.localStorage.getItem(key) !== serialized) {
        throw new DurableOwnershipWriteError();
      }
    } catch (error) {
      if (error instanceof DurableOwnershipWriteError) throw error;
      throw new DurableOwnershipWriteError();
    }
  }

  private listStoredLoginIds(): string[] {
    if (!this.env.localStorage) return [];
    const prefix = slotStoragePrefix(this.originHash);
    const found: string[] = [];
    try {
      for (let i = 0; i < this.env.localStorage.length; i += 1) {
        const key = this.env.localStorage.key(i);
        if (key && key.startsWith(prefix)) found.push(key.slice(prefix.length));
      }
    } catch { /* ignore */ }
    return found;
  }

  private sweepOrphanSlots(ownedAccounts: readonly AccountRecord[]): void {
    const ownedLogins = new Set(ownedAccounts.map((a) => a.loginId));
    for (const loginId of this.listStoredLoginIds()) {
      if (!ownedLogins.has(loginId)) {
        this.safeLocalRemove(slotStorageKey(this.originHash, loginId));
      }
    }
  }

  private readAttempt(attemptId: string): SignInAttempt | null {
    if (!this.env.sessionStorage) return null;
    try {
      const raw = this.env.sessionStorage.getItem(attemptStorageKey(this.originHash, attemptId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SignInAttempt | null;
      return parsed && parsed.attemptId === attemptId ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeAttempt(attempt: SignInAttempt): void {
    if (!this.env.sessionStorage) throw new Error("Session storage is unavailable.");
    this.env.sessionStorage.setItem(attemptStorageKey(this.originHash, attempt.attemptId), JSON.stringify(attempt));
  }

  private clearAttempt(attemptId: string): void {
    try { this.env.sessionStorage?.removeItem(attemptStorageKey(this.originHash, attemptId)); } catch { /* ignore */ }
  }

  private clearAllInTabAttempts(): void {
    if (!this.env.sessionStorage) return;
    const prefix = attemptStoragePrefix(this.originHash);
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.env.sessionStorage.length; i += 1) {
        const key = this.env.sessionStorage.key(i);
        if (key && key.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) this.env.sessionStorage.removeItem(key);
    } catch { /* ignore */ }
  }

  private readTabAccount(): { userId: string; loginId: string } | null {
    if (!this.env.sessionStorage) return null;
    try {
      const raw = this.env.sessionStorage.getItem(tabAccountStorageKey(this.originHash));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { userId?: unknown; loginId?: unknown } | null;
      return parsed && typeof parsed.userId === "string" && typeof parsed.loginId === "string"
        ? { userId: parsed.userId, loginId: parsed.loginId }
        : null;
    } catch {
      return null;
    }
  }

  private setTabActiveInternal(userId: string, loginId: string, updateDefault: boolean): void {
    this.tabActive = { userId, loginId };
    try {
      this.env.sessionStorage?.setItem(tabAccountStorageKey(this.originHash), JSON.stringify({ userId, loginId }));
    } catch { /* ignore */ }
    if (updateDefault && this.sharedPersistenceAvailable) {
      this.safeLocalSet(activeAccountStorageKey(this.originHash), userId);
    }
  }

  private clearTabAccount(): void {
    try { this.env.sessionStorage?.removeItem(tabAccountStorageKey(this.originHash)); } catch { /* ignore */ }
  }

  private safeLocalGet(key: string): string | null {
    try { return this.env.localStorage?.getItem(key) ?? null; } catch { return null; }
  }

  private safeLocalSet(key: string, value: string): void {
    try { this.env.localStorage?.setItem(key, value); } catch { /* ignore */ }
  }

  private safeLocalRemove(key: string): void {
    try { this.env.localStorage?.removeItem(key); } catch { /* ignore */ }
  }

  private broadcast(event: CrossTabAccountEvent): void {
    try { this.channel?.postMessage(event); } catch { /* ignore */ }
  }

  private withRegistryLock<R>(fn: () => Promise<R>): Promise<R> {
    const lockImpl = this.sharedPersistenceAvailable && this.env.webLocks ? this.env.webLocks : processLock;
    return lockImpl(registryLockName(this.originHash), -1, fn);
  }

  private withLegacyLock<R>(fn: () => Promise<R>): Promise<R> {
    const lockImpl = this.sharedPersistenceAvailable && this.env.webLocks ? this.env.webLocks : processLock;
    return lockImpl(legacyLockName(this.deployment.url), -1, fn);
  }

  private withLoginLock<R>(loginId: string, fn: () => Promise<R>): Promise<R> {
    const lockImpl = this.sharedPersistenceAvailable && this.env.webLocks ? this.env.webLocks : processLock;
    return lockImpl(loginLockName(this.originHash, loginId), -1, fn);
  }

  private tryWithLoginLock<R>(loginId: string, fn: () => Promise<R>): Promise<R> {
    const lockImpl = this.sharedPersistenceAvailable && this.env.webLocks ? this.env.webLocks : processLock;
    return lockImpl(loginLockName(this.originHash, loginId), 0, fn);
  }
}

/**
 * C2: Execute a credentialed command strictly bound to the initiating PinnedAccountContext.
 * On 401 unauthenticated, refreshes ONLY on `ctx.runtime` (never the ambient active account)
 * and rechecks `ctx.isCurrent()` before the retry send so A -> B -> A, sign-out, or same-user
 * re-sign-in cannot send under a different login or revive an old confirmation.
 */
export async function postPinnedCommand(
  ctx: PinnedAccountContext,
  deployment: MultiAccountDeployment,
  commandId: string,
  command: Record<string, unknown>,
  options: {
    clientVersion?: string;
    extra?: Record<string, unknown>;
    fetcher?: typeof fetch;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!ctx.isCurrent()) throw new MultiAccountAuthRecoveryRequired();
  const initial = await ctx.runtime.verifySession();
  if (!initial || !ctx.isCurrent() || initial.user.id !== ctx.userId) {
    throw new MultiAccountAuthRecoveryRequired();
  }
  const wireBody = JSON.stringify({
    command_id: commandId,
    client_version: options.clientVersion ?? "0.1.0",
    command,
    ...(options.extra ?? {}),
  });
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  let credential = initial;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!ctx.isCurrent()) throw new MultiAccountAuthRecoveryRequired();
    const response = await fetcher(`${deployment.url.replace(/\/+$/, "")}/functions/v1/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.access_token}`,
        apikey: deployment.anonKey,
        "content-type": "application/json",
      },
      body: wireBody,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = { error: "unreadable_response" }; }

    if (response.status === 401 && body.error === "unauthenticated") {
      if (attempt !== 0 || !ctx.isCurrent()) throw new MultiAccountAuthRecoveryRequired();
      const recovered = await ctx.runtime.client.auth.getSession();
      if (!ctx.isCurrent()) throw new MultiAccountAuthRecoveryRequired();
      if (recovered.error || !recovered.data.session || recovered.data.session.user.id !== ctx.userId) {
        throw new MultiAccountSessionExpired();
      }
      if (!sameCredentials(recovered.data.session, credential)) {
        credential = recovered.data.session;
      } else {
        const refreshed = await ctx.runtime.client.auth.refreshSession();
        if (!ctx.isCurrent()) throw new MultiAccountAuthRecoveryRequired();
        if (refreshed.error || !refreshed.data.session || refreshed.data.session.user.id !== ctx.userId) {
          throw new MultiAccountAuthRecoveryRequired();
        }
        credential = refreshed.data.session;
      }
      continue;
    }
    return { status: response.status, body };
  }
  throw new MultiAccountAuthRecoveryRequired();
}

/**
 * C2: Attach a Realtime subscription strictly from ONE pinned AccountSessionRuntime
 * (both client and verified session come from `ctx.runtime`; rechecks `ctx.isCurrent()`
 * before setting socket auth and joining, and before delivering frames).
 */
export async function attachPinnedRealtime<TSub>(
  ctx: PinnedAccountContext,
  join: (client: SupabaseClient, session: Session) => TSub,
): Promise<TSub | null> {
  if (!ctx.isCurrent()) return null;
  const active = await ctx.runtime.verifySession();
  if (!active || !ctx.isCurrent() || active.user.id !== ctx.userId) return null;
  await ctx.runtime.client.realtime.setAuth(active.access_token);
  if (!ctx.isCurrent()) return null;
  return join(ctx.runtime.client, active);
}

