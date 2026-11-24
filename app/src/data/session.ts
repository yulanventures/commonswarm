import {
  AuthRetryableFetchError,
  createClient,
  isAuthSessionMissingError,
  navigatorLock,
  processLock,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import {
  AuthRecoveryRequired,
  MULTI_ACCOUNT_ENABLED,
  createBrowserSession,
  multiAccountInUse,
  type BrowserSession,
  type BrowserSessionSdk,
  type CreateBrowserSessionOptions,
  type CreateBrowserSessionResult,
  type StorageKeysLike,
} from '../../../shared/browser-session/index.js';
import { readRuntimeConfig, type RuntimeConfig } from './config';
import {
  FenceTracker,
  createFenceTracker,
  extractLoginIdentity,
  sameLoginIdentity,
  type Fence,
  type LoginIdentity,
} from './fence';

export type SessionClosedReason =
  | 'invalid_config'
  | 'locks_unavailable'
  | 'unsupported_sdk'
  | 'multi_account_flag'
  | 'multi_account_in_use'
  | 'multi_account_unknown';

export type SessionGateState =
  | { readonly status: 'sample' }
  | { readonly status: 'closed'; readonly reason: SessionClosedReason }
  | { readonly status: 'checking' }
  | { readonly status: 'recovery'; readonly retryAt: number | null }
  | { readonly status: 'signed_out' }
  | { readonly status: 'authenticated' };

const RECOVERY_BACKOFF_INITIAL_MS = 2_000;
const RECOVERY_BACKOFF_MAX_MS = 30_000;
const RECOVERY_RETRY_AFTER_MIN_MS = 250;
const RECOVERY_RETRY_AFTER_MAX_MS = 60_000;
const RECOVERY_RETRY_AFTER_CUSHION_MS = 50;

export interface SessionSnapshot {
  readonly state: SessionGateState;
  readonly userId: string | null;
  readonly loginGeneration: number;
  readonly client: SupabaseClient | null;
}

export interface AcquiredAccessToken {
  readonly accessToken: string;
  readonly identity: LoginIdentity;
  readonly url: string;
  readonly anonKey: string;
}

export type SessionListener = () => void;
export type LoginPurgeListener = (loginGeneration: number) => void;
export type SynchronousViewRetireListener = () => void;
export type TokenRefreshListener = () => void;

export interface SessionGateDependencies {
  /** Override document used to read `<meta>` runtime config. */
  doc?: Document | null;
  /** Override pre-parsed runtime config (for tests). */
  runtimeConfig?: RuntimeConfig;
  /** Override multi-account build flag (defaults to shared `MULTI_ACCOUNT_ENABLED`). */
  multiAccountEnabled?: boolean;
  /** Override Web Locks presence check (defaults to `navigator.locks`). */
  hasWebLocks?: () => boolean;
  /** Override storage probed for multi-account keys and listened on for storage events. */
  storage?: StorageKeysLike | null;
  /** Override window-like target for `storage`, `pagehide`, and `pageshow` listeners. */
  eventTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  /** Override session factory (defaults to shared `createBrowserSession`). */
  createSession?: (
    options: CreateBrowserSessionOptions,
  ) => CreateBrowserSessionResult;
  /** Override fetch implementation used by edge and PostgREST reads. */
  fetchImpl?: typeof fetch;
  /** Override SDK passed into `createBrowserSession`. */
  sdk?: BrowserSessionSdk;
}

export interface SessionGate {
  readonly state: SessionGateState;
  readonly userId: string | null;
  readonly loginGeneration: number;
  readonly client: SupabaseClient | null;
  readonly deployment: { readonly url: string; readonly anonKey: string } | null;
  readonly isHidden: boolean;
  readonly fenceTracker: FenceTracker;
  readonly fetchImpl: typeof fetch;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: SessionListener): () => void;
  onLoginPurge(listener: LoginPurgeListener): () => void;
  onSynchronousViewRetire(listener: SynchronousViewRetireListener): () => void;
  onTokenRefresh(listener: TokenRefreshListener): () => void;
  acquireAccessToken(): Promise<AcquiredAccessToken | null>;
  handleUnauthorized(fence: Fence, loginIdentity?: LoginIdentity | null): boolean;
  handlePagehide(): void;
  handlePageshow(persisted: boolean): void;
  reverify(): Promise<void>;
  dispose(): void;
}

function defaultHasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks);
}

function defaultStorage(): StorageKeysLike | null {
  try {
    return typeof globalThis.localStorage !== 'undefined'
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function defaultSdk(): BrowserSessionSdk {
  return {
    createClient,
    navigatorLock,
    processLock,
    isAuthSessionMissingError,
    AuthRetryableFetchError,
  };
}

function parseStoredSession(raw: string | null): Pick<Session, 'access_token' | 'user'> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.access_token !== 'string' ||
      !obj.user ||
      typeof obj.user !== 'object' ||
      Array.isArray(obj.user) ||
      typeof (obj.user as Record<string, unknown>).id !== 'string'
    ) {
      return null;
    }
    return {
      access_token: obj.access_token,
      user: obj.user as Session['user'],
    };
  } catch {
    return null;
  }
}

export function createSessionGate(
  deps: SessionGateDependencies = {},
): SessionGate {
  const fenceTracker = createFenceTracker();
  const listeners = new Set<SessionListener>();
  const purgeListeners = new Set<LoginPurgeListener>();
  const viewRetireListeners = new Set<SynchronousViewRetireListener>();
  const tokenRefreshListeners = new Set<TokenRefreshListener>();
  const fetchImpl: typeof fetch =
    deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const runtimeConfig = deps.runtimeConfig ?? readRuntimeConfig(deps.doc);
  const multiAccountFlag = deps.multiAccountEnabled ?? MULTI_ACCOUNT_ENABLED;
  const checkWebLocks = deps.hasWebLocks ?? defaultHasWebLocks;
  const hasExplicitStorage = 'storage' in deps;
  const resolveStorage = (): StorageKeysLike | null =>
    hasExplicitStorage ? (deps.storage ?? null) : defaultStorage();
  const eventTarget =
    'eventTarget' in deps
      ? deps.eventTarget
      : typeof window !== 'undefined'
        ? window
        : null;

  let browserSession: BrowserSession | null = null;
  let deployment: { readonly url: string; readonly anonKey: string } | null =
    null;
  let state: SessionGateState;
  let gateGeneration = 0;
  let disposed = false;
  let hiddenByPagehide = false;
  let authSubscription: { unsubscribe(): void } | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryAttempts = 0;

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer !== null) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  };

  let cachedSnapshot: SessionSnapshot;

  const rebuildSnapshot = (): SessionSnapshot => {
    cachedSnapshot = {
      state,
      userId: state.status === 'authenticated' ? fenceTracker.userId : null,
      loginGeneration: fenceTracker.loginGeneration,
      client: browserSession?.client ?? null,
    };
    return cachedSnapshot;
  };

  const emit = (): void => {
    rebuildSnapshot();
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const runPurgeSynchronously = (generation: number): void => {
    for (const listener of [...purgeListeners]) {
      listener(generation);
    }
  };

  const runSynchronousViewRetire = (): void => {
    for (const listener of [...viewRetireListeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so retirement still completes synchronously.
      }
    }
  };

  const runTokenRefreshListeners = (): void => {
    for (const listener of [...tokenRefreshListeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors.
      }
    }
  };

  const detachAndQuiesceClient = (): void => {
    authSubscription?.unsubscribe();
    authSubscription = null;
    eventTarget?.removeEventListener('storage', handleStorageEvent);
    eventTarget?.removeEventListener('pagehide', onPagehideEvent);
    eventTarget?.removeEventListener('pageshow', onPageshowEvent);

    const sessionToQuiesce = browserSession;
    browserSession = null;
    if (!sessionToQuiesce) return;

    if (typeof sessionToQuiesce.quiesce === 'function') {
      void sessionToQuiesce.quiesce().catch(() => undefined);
    } else {
      const realtime = (
        sessionToQuiesce.client as unknown as {
          removeAllChannels?: () => Promise<unknown>;
          realtime?: {
            removeAllChannels?: () => Promise<unknown>;
            disconnect?: () => Promise<unknown>;
          };
        }
      );
      if (typeof realtime?.removeAllChannels === 'function') {
        void Promise.resolve()
          .then(() => realtime.removeAllChannels!())
          .catch(() => undefined);
      } else if (typeof realtime?.realtime?.removeAllChannels === 'function') {
        void Promise.resolve()
          .then(() => realtime.realtime!.removeAllChannels!())
          .catch(() => undefined);
      }
      if (typeof realtime?.realtime?.disconnect === 'function') {
        void Promise.resolve()
          .then(() => realtime.realtime!.disconnect!())
          .catch(() => undefined);
      }
      const auth = sessionToQuiesce.client?.auth as
        | { dispose?: () => Promise<void>; stopAutoRefresh?: () => Promise<void> }
        | undefined;
      if (typeof auth?.dispose === 'function') {
        void auth.dispose().catch(() => undefined);
      } else if (typeof auth?.stopAutoRefresh === 'function') {
        void auth.stopAutoRefresh().catch(() => undefined);
      }
    }
  };

  const failClosedSignedOut = (): void => {
    if (state.status === 'closed') return;
    clearRecoveryTimer();
    recoveryAttempts = 0;
    gateGeneration += 1;
    // Do NOT clear `hiddenByPagehide`: a sign-out arriving while the page is hidden
    // may retire the state, while keeping verification and private paint latched until `pageshow`.
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'signed_out' };
    runPurgeSynchronously(nextGen);
    emit();
    if (hiddenByPagehide) {
      runSynchronousViewRetire();
    }
  };

  const enterRecovery = (retryAfter?: number): void => {
    if (disposed || state.status === 'closed') return;
    clearRecoveryTimer();
    gateGeneration += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    const hasRetryAfter =
      typeof retryAfter === 'number' &&
      Number.isFinite(retryAfter) &&
      retryAfter > 0;
    if (!hasRetryAfter) {
      recoveryAttempts += 1;
    }
    const fallbackDelay = Math.min(
      RECOVERY_BACKOFF_MAX_MS,
      RECOVERY_BACKOFF_INITIAL_MS * 2 ** Math.max(0, recoveryAttempts - 1),
    );
    const delayMs = hasRetryAfter
      ? Math.min(
          RECOVERY_RETRY_AFTER_MAX_MS,
          Math.max(
            RECOVERY_RETRY_AFTER_MIN_MS,
            retryAfter - Date.now() + RECOVERY_RETRY_AFTER_CUSHION_MS,
          ),
        )
      : fallbackDelay;
    const retryAt = Date.now() + delayMs;
    state = { status: 'recovery', retryAt };
    rebuildSnapshot();
    runPurgeSynchronously(nextGen);
    emit();
    if (hiddenByPagehide) {
      runSynchronousViewRetire();
      return;
    }
    const scheduledGateGen = gateGeneration;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (
        disposed ||
        hiddenByPagehide ||
        gateGeneration !== scheduledGateGen ||
        state.status !== 'recovery'
      ) {
        return;
      }
      void reverify();
    }, delayMs);
  };

  const closeFailClosed = (reason: SessionClosedReason): void => {
    clearRecoveryTimer();
    recoveryAttempts = 0;
    gateGeneration += 1;
    hiddenByPagehide = false;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'closed', reason };
    detachAndQuiesceClient();
    runPurgeSynchronously(nextGen);
    emit();
    runSynchronousViewRetire();
  };

  const checkClosedBeforeSession = (
    url: string,
  ): SessionClosedReason | null => {
    if (runtimeConfig.status === 'invalid') return 'invalid_config';
    if (multiAccountFlag) return 'multi_account_flag';
    if (!checkWebLocks()) return 'locks_unavailable';
    const probe = multiAccountInUse(resolveStorage(), url);
    if (probe === 'in_use') return 'multi_account_in_use';
    if (probe === 'unknown') return 'multi_account_unknown';
    return null;
  };

  const retireAndRevalidate = (): void => {
    if (disposed || !browserSession || !deployment || state.status === 'closed') {
      return;
    }
    const closedReason = checkClosedBeforeSession(deployment.url);
    if (closedReason) {
      closeFailClosed(closedReason);
      return;
    }
    clearRecoveryTimer();
    recoveryAttempts = 0;
    gateGeneration += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'checking' };
    runPurgeSynchronously(nextGen);
    emit();
    if (hiddenByPagehide) {
      // Keep pagehide latched until `pageshow`: retire state without verifying, fetching, or painting.
      runSynchronousViewRetire();
      return;
    }
    void reverify();
  };

  const reverify = async (): Promise<void> => {
    if (
      disposed ||
      hiddenByPagehide ||
      !browserSession ||
      !deployment ||
      state.status === 'closed'
    ) {
      return;
    }

    const closedReason = checkClosedBeforeSession(deployment.url);
    if (closedReason) {
      closeFailClosed(closedReason);
      return;
    }

    clearRecoveryTimer();
    const capturedGateGen = ++gateGeneration;
    const expectedLoginGenAtStart = fenceTracker.loginGeneration;
    const capturedSession = browserSession;
    const capturedDeployment = deployment;

    let session: Session | null;
    try {
      session = await capturedSession.currentSession();
    } catch (error) {
      if (disposed || hiddenByPagehide || gateGeneration !== capturedGateGen) return;
      const postClosed = checkClosedBeforeSession(capturedDeployment.url);
      if (postClosed) {
        closeFailClosed(postClosed);
        return;
      }
      if (
        error instanceof AuthRecoveryRequired ||
        (error instanceof Error && error.name === 'AuthRecoveryRequired')
      ) {
        enterRecovery(
          error instanceof AuthRecoveryRequired ? error.retryAfter : undefined,
        );
        return;
      }
      failClosedSignedOut();
      return;
    }

    if (disposed || hiddenByPagehide || gateGeneration !== capturedGateGen) return;

    // Re-run all closed-gate checks at publication, not only at startup.
    const postClosed = checkClosedBeforeSession(capturedDeployment.url);
    if (postClosed) {
      closeFailClosed(postClosed);
      return;
    }

    const identity = extractLoginIdentity(session);
    if (!identity) {
      if (
        state.status !== 'signed_out' ||
        fenceTracker.loginIdentity !== null
      ) {
        failClosedSignedOut();
      } else {
        clearRecoveryTimer();
        recoveryAttempts = 0;
        state = { status: 'signed_out' };
        emit();
      }
      return;
    }

    if (
      !session?.access_token ||
      !session.access_token.trim() ||
      session.access_token === capturedDeployment.anonKey
    ) {
      failClosedSignedOut();
      return;
    }

    clearRecoveryTimer();
    recoveryAttempts = 0;
    const reconciled = fenceTracker.reconcileSession(session);
    if (
      reconciled.changed ||
      fenceTracker.loginGeneration !== expectedLoginGenAtStart
    ) {
      runPurgeSynchronously(fenceTracker.loginGeneration);
    }
    state = { status: 'authenticated' };
    emit();
  };

  const handleStorageEvent = (event: Event): void => {
    if (disposed || !browserSession || !deployment || state.status === 'closed') {
      return;
    }
    const storageEvent = event as StorageEvent;
    const probedStorage = resolveStorage();
    if (
      probedStorage &&
      storageEvent.storageArea &&
      storageEvent.storageArea !== (probedStorage as unknown)
    ) {
      return;
    }

    // Fail closed immediately if any closed-gate check (including multi-account probe) fails.
    const closedReason = checkClosedBeforeSession(deployment.url);
    if (closedReason) {
      closeFailClosed(closedReason);
      return;
    }

    if (
      storageEvent.key !== null &&
      storageEvent.key !== browserSession.storageKey
    ) {
      return;
    }

    // Storage cleared or session key removed: synchronously retire everything.
    if (storageEvent.key === null || storageEvent.newValue === null) {
      failClosedSignedOut();
      return;
    }

    const parsed = parseStoredSession(storageEvent.newValue);
    const nextIdentity = extractLoginIdentity(parsed);
    if (!nextIdentity) {
      failClosedSignedOut();
      return;
    }

    // Same login (refresh of same session_id while authenticated): keep state intact
    // and notify live realtime generations to refresh their bearer through the fenced path.
    if (
      state.status === 'authenticated' &&
      sameLoginIdentity(fenceTracker.loginIdentity, nextIdentity)
    ) {
      runTokenRefreshListeners();
      return;
    }

    // Different user, same user with new session_id, or sign-in from non-authenticated state:
    // synchronously purge old login, then reverify through the shared module.
    retireAndRevalidate();
  };

  const handlePagehide = (): void => {
    if (disposed || !browserSession || !deployment || state.status === 'closed') {
      return;
    }
    // Synchronously retire requests, caches, store, and mounted private DOM BEFORE the browser
    // can snapshot this page into history / back-forward cache. Do not start network verification
    // while leaving; `pageshow` triggers revalidation on return.
    clearRecoveryTimer();
    hiddenByPagehide = true;
    gateGeneration += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'checking' };
    runPurgeSynchronously(nextGen);
    emit();
    runSynchronousViewRetire();
  };

  const handlePageshow = (persisted: boolean): void => {
    if (disposed || (!persisted && !hiddenByPagehide)) return;
    if (!browserSession || !deployment || state.status === 'closed') return;
    // Keep private state retired until verified current-login data settles.
    clearRecoveryTimer();
    recoveryAttempts = 0;
    hiddenByPagehide = false;
    const closedReason = checkClosedBeforeSession(deployment.url);
    if (closedReason) {
      closeFailClosed(closedReason);
      runSynchronousViewRetire();
      return;
    }
    gateGeneration += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'checking' };
    runPurgeSynchronously(nextGen);
    emit();
    runSynchronousViewRetire();
    void reverify();
  };

  const onPagehideEvent = (): void => {
    handlePagehide();
  };

  const onPageshowEvent = (event: Event): void => {
    const persisted = Boolean((event as PageTransitionEvent).persisted);
    handlePageshow(persisted);
  };

  // Pre-creation fail-closed gates: never create a Supabase client in sample or closed states.
  if (runtimeConfig.status === 'not_configured') {
    state = { status: 'sample' };
  } else if (runtimeConfig.status === 'invalid') {
    state = { status: 'closed', reason: 'invalid_config' };
  } else {
    const closedReason = checkClosedBeforeSession(runtimeConfig.url);
    if (closedReason) {
      state = { status: 'closed', reason: closedReason };
    } else {
      const factory = deps.createSession ?? createBrowserSession;
      const created = factory({
        url: runtimeConfig.url,
        anonKey: runtimeConfig.anonKey,
        detectSessionInUrl: false,
        allowProcessLockFallback: false,
        sdk: deps.sdk ?? defaultSdk(),
      });
      if (!created.ok) {
        state = {
          status: 'closed',
          reason:
            created.reason === 'unsupported_sdk'
              ? 'unsupported_sdk'
              : 'locks_unavailable',
        };
      } else {
        browserSession = created;
        deployment = { url: runtimeConfig.url, anonKey: runtimeConfig.anonKey };
        state = { status: 'checking' };

        const subResult = browserSession.client.auth.onAuthStateChange(
          (event, nextSession) => {
            if (
              disposed ||
              !browserSession ||
              !deployment ||
              state.status === 'closed'
            ) {
              return;
            }

            // Wait for verifiedSession() on initial load; never trust unverified storage alone.
            if (event === 'INITIAL_SESSION') {
              return;
            }

            const authClosedReason = checkClosedBeforeSession(deployment.url);
            if (authClosedReason) {
              closeFailClosed(authClosedReason);
              return;
            }

            if (event === 'SIGNED_OUT' || !nextSession) {
              failClosedSignedOut();
              return;
            }

            const nextIdentity = extractLoginIdentity(nextSession);
            if (!nextIdentity) {
              failClosedSignedOut();
              return;
            }

            if (
              state.status === 'authenticated' &&
              sameLoginIdentity(fenceTracker.loginIdentity, nextIdentity)
            ) {
              // Token refresh of the same verified login: keep gateGeneration, loginGeneration, and cache intact,
              // and notify live realtime generations to update their bearer through the fenced path.
              runTokenRefreshListeners();
              return;
            }

            // Sign-in, account switch, or same-user re-sign-in (new session_id):
            // an SDK notification is a signal to retire and revalidate, never a session to adopt directly.
            retireAndRevalidate();
          },
        );
        authSubscription = subResult.data.subscription;

        eventTarget?.addEventListener('storage', handleStorageEvent);
        eventTarget?.addEventListener('pagehide', onPagehideEvent);
        eventTarget?.addEventListener('pageshow', onPageshowEvent);

        void reverify();
      }
    }
  }

  cachedSnapshot = rebuildSnapshot();

  const acquireAccessToken = async (): Promise<AcquiredAccessToken | null> => {
    if (
      disposed ||
      hiddenByPagehide ||
      !browserSession ||
      !deployment ||
      state.status !== 'authenticated'
    ) {
      return null;
    }

    const preClosed = checkClosedBeforeSession(deployment.url);
    if (preClosed) {
      closeFailClosed(preClosed);
      return null;
    }

    const capturedGateGen = gateGeneration;
    const capturedIdentity = fenceTracker.loginIdentity;
    const capturedSession = browserSession;
    const capturedDeployment = deployment;
    if (!capturedIdentity) {
      return null;
    }

    let session: Session | null;
    try {
      const { data, error } = await capturedSession.client.auth.getSession();
      if (disposed || hiddenByPagehide || gateGeneration !== capturedGateGen) {
        return null;
      }
      if (error || !data.session) {
        const postClosed = checkClosedBeforeSession(capturedDeployment.url);
        if (postClosed) {
          closeFailClosed(postClosed);
        } else if (
          error &&
          (error instanceof AuthRecoveryRequired ||
            error instanceof AuthRetryableFetchError ||
            error.name === 'AuthRefreshDiscardedError' ||
            error.name === 'AuthRecoveryRequired')
        ) {
          retireAndRevalidate();
        } else {
          failClosedSignedOut();
        }
        return null;
      }
      session = data.session;
    } catch (error) {
      if (disposed || hiddenByPagehide || gateGeneration !== capturedGateGen) {
        return null;
      }
      const postClosed = checkClosedBeforeSession(capturedDeployment.url);
      if (postClosed) {
        closeFailClosed(postClosed);
      } else if (
        error instanceof AuthRecoveryRequired ||
        error instanceof AuthRetryableFetchError ||
        (error instanceof Error &&
          (error.name === 'AuthRefreshDiscardedError' ||
            error.name === 'AuthRecoveryRequired'))
      ) {
        retireAndRevalidate();
      } else {
        failClosedSignedOut();
      }
      return null;
    }

    if (disposed || hiddenByPagehide || gateGeneration !== capturedGateGen) {
      return null;
    }

    const postClosed = checkClosedBeforeSession(capturedDeployment.url);
    if (postClosed) {
      closeFailClosed(postClosed);
      return null;
    }

    const identity = extractLoginIdentity(session);
    if (!identity) {
      failClosedSignedOut();
      return null;
    }

    // If the acquired token belongs to a different login (including same user with new session_id),
    // never publish it directly: synchronously retire the old login and revalidate through the shared module.
    if (!sameLoginIdentity(capturedIdentity, identity)) {
      retireAndRevalidate();
      return null;
    }

    if (
      !session.access_token ||
      !session.access_token.trim() ||
      session.access_token === capturedDeployment.anonKey
    ) {
      failClosedSignedOut();
      return null;
    }

    return {
      accessToken: session.access_token,
      identity,
      url: capturedDeployment.url,
      anonKey: capturedDeployment.anonKey,
    };
  };

  const handleUnauthorized = (
    fence: Fence,
    loginIdentity?: LoginIdentity | null,
  ): boolean => {
    if (
      disposed ||
      !browserSession ||
      hiddenByPagehide ||
      state.status !== 'authenticated'
    ) {
      return false;
    }
    if (
      !fenceTracker.isCurrent(fence, {
        ...(loginIdentity !== undefined ? { loginIdentity } : {}),
        requireActiveWorkspace: false,
        requireActiveConversation: false,
      })
    ) {
      return false;
    }
    const session = browserSession;
    // Synchronously retire in-memory state and let the shared session run locked verification
    // without touching stored credentials outside the shared module's guarded path.
    failClosedSignedOut();
    void session.verifiedSession().catch(() => undefined);
    return true;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearRecoveryTimer();
    gateGeneration += 1;
    detachAndQuiesceClient();
    listeners.clear();
    purgeListeners.clear();
    viewRetireListeners.clear();
    tokenRefreshListeners.clear();
  };

  return {
    get state() {
      return cachedSnapshot.state;
    },
    get userId() {
      return cachedSnapshot.userId;
    },
    get loginGeneration() {
      return cachedSnapshot.loginGeneration;
    },
    get client() {
      return cachedSnapshot.client;
    },
    get deployment() {
      return deployment;
    },
    get isHidden() {
      return hiddenByPagehide;
    },
    fenceTracker,
    fetchImpl,
    getSnapshot() {
      return cachedSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onLoginPurge(listener) {
      purgeListeners.add(listener);
      return () => {
        purgeListeners.delete(listener);
      };
    },
    onSynchronousViewRetire(listener) {
      viewRetireListeners.add(listener);
      return () => {
        viewRetireListeners.delete(listener);
      };
    },
    onTokenRefresh(listener) {
      tokenRefreshListeners.add(listener);
      return () => {
        tokenRefreshListeners.delete(listener);
      };
    },
    acquireAccessToken,
    handleUnauthorized,
    handlePagehide,
    handlePageshow,
    reverify,
    dispose,
  };
}
