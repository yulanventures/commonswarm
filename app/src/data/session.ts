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
  type LoginIdentity,
} from './fence';

export type SessionClosedReason =
  | 'invalid_config'
  | 'locks_unavailable'
  | 'multi_account_flag'
  | 'multi_account_in_use'
  | 'multi_account_unknown';

export type SessionGateState =
  | { readonly status: 'sample' }
  | { readonly status: 'closed'; readonly reason: SessionClosedReason }
  | { readonly status: 'checking' }
  | { readonly status: 'signed_out' }
  | { readonly status: 'authenticated' };

export interface SessionSnapshot {
  readonly state: SessionGateState;
  readonly userId: string | null;
  readonly loginGeneration: number;
  readonly client: SupabaseClient | null;
}

export interface AcquiredAccessToken {
  readonly accessToken: string;
  readonly identity: LoginIdentity;
  readonly client: SupabaseClient;
  readonly url: string;
  readonly anonKey: string;
}

export type SessionListener = () => void;
export type LoginPurgeListener = (loginGeneration: number) => void;

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
  /** Override window-like target for `storage` and `pageshow` listeners. */
  eventTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  /** Override session factory (defaults to shared `createBrowserSession`). */
  createSession?: (
    options: CreateBrowserSessionOptions,
  ) => CreateBrowserSessionResult;
  /** Override fetch implementation used by edge reads. */
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
  readonly fenceTracker: FenceTracker;
  readonly fetchImpl: typeof fetch;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: SessionListener): () => void;
  onLoginPurge(listener: LoginPurgeListener): () => void;
  acquireAccessToken(): Promise<AcquiredAccessToken | null>;
  handleUnauthorized(): void;
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
  let verifySequence = 0;
  let disposed = false;
  let authSubscription: { unsubscribe(): void } | null = null;

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

  const failClosedSignedOut = (): void => {
    verifySequence += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'signed_out' };
    runPurgeSynchronously(nextGen);
    emit();
  };

  const closeFailClosed = (reason: SessionClosedReason): void => {
    verifySequence += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'closed', reason };
    runPurgeSynchronously(nextGen);
    emit();
  };

  const checkClosedBeforeSession = (
    url: string,
  ): SessionClosedReason | null => {
    if (multiAccountFlag) return 'multi_account_flag';
    if (!checkWebLocks()) return 'locks_unavailable';
    const probe = multiAccountInUse(resolveStorage(), url);
    if (probe === 'in_use') return 'multi_account_in_use';
    if (probe === 'unknown') return 'multi_account_unknown';
    return null;
  };

  const reverify = async (): Promise<void> => {
    if (disposed || !browserSession || !deployment) return;

    const closedReason = checkClosedBeforeSession(deployment.url);
    if (closedReason) {
      closeFailClosed(closedReason);
      return;
    }

    const seq = ++verifySequence;
    const expectedGenAtStart = fenceTracker.loginGeneration;

    let session: Session | null;
    try {
      session = await browserSession.currentSession();
    } catch {
      if (disposed || seq !== verifySequence) return;
      failClosedSignedOut();
      return;
    }

    if (disposed || seq !== verifySequence) return;

    // Re-check multi-account storage probe after async verification before painting.
    const postClosed = checkClosedBeforeSession(deployment.url);
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
        state = { status: 'signed_out' };
        emit();
      }
      return;
    }

    const reconciled = fenceTracker.reconcileSession(session);
    if (reconciled.changed || fenceTracker.loginGeneration !== expectedGenAtStart) {
      runPurgeSynchronously(fenceTracker.loginGeneration);
    }
    state = { status: 'authenticated' };
    emit();
  };

  const handleStorageEvent = (event: Event): void => {
    if (disposed || !browserSession || !deployment) return;
    const storageEvent = event as StorageEvent;
    const probedStorage = resolveStorage();
    if (
      probedStorage &&
      storageEvent.storageArea &&
      storageEvent.storageArea !== (probedStorage as unknown)
    ) {
      return;
    }

    // Fail closed immediately if multi-account keys appear or storage breaks.
    const probe = multiAccountInUse(probedStorage, deployment.url);
    if (probe === 'in_use') {
      closeFailClosed('multi_account_in_use');
      return;
    }
    if (probe === 'unknown') {
      closeFailClosed('multi_account_unknown');
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

    // Same login (refresh of same session_id): keep state intact.
    if (sameLoginIdentity(fenceTracker.loginIdentity, nextIdentity)) {
      return;
    }

    // Different user OR same user with new session_id: synchronously purge old login, then reverify.
    verifySequence += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'checking' };
    runPurgeSynchronously(nextGen);
    emit();
    void reverify();
  };

  const handlePageshow = (persisted: boolean): void => {
    if (disposed || !persisted) return;
    if (!browserSession || !deployment) return;
    // Retire all private state synchronously BEFORE bfcache restore can show it, then revalidate.
    verifySequence += 1;
    const nextGen = fenceTracker.forceLoginLoss();
    state = { status: 'checking' };
    runPurgeSynchronously(nextGen);
    emit();
    void reverify();
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
        state = { status: 'closed', reason: 'locks_unavailable' };
      } else {
        browserSession = created;
        deployment = { url: runtimeConfig.url, anonKey: runtimeConfig.anonKey };
        state = { status: 'checking' };

        const subResult = browserSession.client.auth.onAuthStateChange(
          (event, nextSession) => {
            if (disposed) return;

            if (event === 'SIGNED_OUT' || !nextSession) {
              failClosedSignedOut();
              return;
            }

            // Wait for verifiedSession() on initial load; never trust unverified storage alone.
            if (event === 'INITIAL_SESSION') {
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
              // Token refresh of the same login: keep loginGeneration and cache intact.
              return;
            }

            // Sign-in, account switch, or same-user re-sign-in (new session_id):
            // synchronously bump loginGeneration and purge prior private state before any await.
            const reconciled = fenceTracker.reconcileSession(nextSession);
            if (reconciled.changed) {
              runPurgeSynchronously(reconciled.loginGeneration);
            }
            if (state.status !== 'authenticated') {
              state = { status: 'authenticated' };
            }
            emit();
          },
        );
        authSubscription = subResult.data.subscription;

        eventTarget?.addEventListener('storage', handleStorageEvent);
        eventTarget?.addEventListener('pageshow', onPageshowEvent);

        void reverify();
      }
    }
  }

  cachedSnapshot = rebuildSnapshot();

  const acquireAccessToken = async (): Promise<AcquiredAccessToken | null> => {
    if (disposed || !browserSession || !deployment || state.status !== 'authenticated') {
      return null;
    }

    let session: Session | null;
    try {
      const { data, error } = await browserSession.client.auth.getSession();
      if (error || !data.session) {
        failClosedSignedOut();
        return null;
      }
      session = data.session;
    } catch {
      // Inconclusive acquisition: fail closed, never fall back to a previously held bearer.
      failClosedSignedOut();
      return null;
    }

    const identity = extractLoginIdentity(session);
    if (!identity) {
      failClosedSignedOut();
      return null;
    }

    // If the acquired token belongs to a different login (including same user with new session_id),
    // synchronously retire the old login and fail this acquisition closed.
    if (!sameLoginIdentity(fenceTracker.loginIdentity, identity)) {
      const reconciled = fenceTracker.reconcileSession(session);
      if (reconciled.changed) {
        runPurgeSynchronously(reconciled.loginGeneration);
      }
      state = { status: 'authenticated' };
      emit();
      return null;
    }

    return {
      accessToken: session.access_token,
      identity,
      client: browserSession.client,
      url: deployment.url,
      anonKey: deployment.anonKey,
    };
  };

  const handleUnauthorized = (): void => {
    if (disposed || !browserSession) return;
    // Synchronously retire in-memory state and let the shared session run locked verification
    // without touching stored credentials outside the shared module's guarded path.
    failClosedSignedOut();
    void browserSession.verifiedSession().catch(() => undefined);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    verifySequence += 1;
    authSubscription?.unsubscribe();
    authSubscription = null;
    eventTarget?.removeEventListener('storage', handleStorageEvent);
    eventTarget?.removeEventListener('pageshow', onPageshowEvent);
    listeners.clear();
    purgeListeners.clear();
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
    acquireAccessToken,
    handleUnauthorized,
    handlePageshow,
    reverify,
    dispose,
  };
}
