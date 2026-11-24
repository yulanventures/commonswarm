import {
  RealtimeClient,
  type RealtimeClientOptions,
  type SupabaseClient,
} from '@supabase/supabase-js';
import {
  FEED_POLL_MS,
  FEED_PUSH_BACKOFF_MS,
  FEED_RECONCILE_MS,
  FeedPushController,
  attachFeedChannels,
  type FeedPushChannelClient,
  type FeedPushSubscription,
  type FeedPushTimers,
} from './contracts/feed-push';
import type { Fence } from './fence';
import type { SessionGate } from './session';

export { FEED_POLL_MS, FEED_PUSH_BACKOFF_MS, FEED_RECONCILE_MS };

export interface RealtimeCapableClient extends FeedPushChannelClient {
  getChannels?(): unknown[];
  endpointURL?(): string;
  endPoint?: string;
  realtime?: {
    setAuth(token?: string | null): Promise<void> | void;
    disconnect?(): Promise<unknown> | unknown;
    removeAllChannels?(): Promise<unknown> | unknown;
    getChannels?(): unknown[];
    isConnected?(): boolean;
    isConnecting?(): boolean;
    connectionState?(): string;
    endpointURL?(): string;
    endPoint?: string;
  };
  removeAllChannels?(): Promise<unknown> | unknown;
}

/**
 * Confirm that the Supabase Realtime client's endpoint matches the configured API
 * origin over `wss:` (matching the CSP `connect-src ... wss://api.commonswarm.com`).
 * Returns `false` if an unexpected host or non-`wss:` protocol is detected.
 */
export function realtimeEndpointMatchesApiOrigin(
  client: RealtimeCapableClient,
  apiUrl: string,
): boolean {
  let apiOrigin: URL;
  try {
    apiOrigin = new URL(apiUrl);
  } catch {
    return false;
  }
  if (apiOrigin.protocol !== 'https:' || !apiOrigin.host) {
    return false;
  }

  const rawEndpoint =
    typeof client.realtime?.endpointURL === 'function'
      ? client.realtime.endpointURL()
      : typeof client.realtime?.endPoint === 'string'
        ? client.realtime.endPoint
        : typeof client.endpointURL === 'function'
          ? client.endpointURL()
          : typeof client.endPoint === 'string'
            ? client.endPoint
            : null;

  // Test doubles without an endpointURL are checked at channel/setAuth boundary;
  // any real RealtimeClient exposes endpointURL() / endPoint and MUST match wss://<api-host>.
  if (rawEndpoint === null) {
    return true;
  }

  try {
    const parsed = new URL(rawEndpoint);
    return parsed.protocol === 'wss:' && parsed.host === apiOrigin.host;
  } catch {
    return false;
  }
}

export interface WorkspaceLiveManagerOptions {
  readonly sessionGate: SessionGate;
  readonly workspaceId: string;
  /** Authorized refresh invoked on realtime hint, fallback poll, or reconcile tick. */
  readonly onRefresh: (fence: Fence) => Promise<void> | void;
  /** Override visibility document (defaults to global `document`). */
  readonly doc?: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  > | null;
  /** Override timers (for deterministic tests). */
  readonly timers?: FeedPushTimers;
}

export interface WorkspaceLiveManager {
  /** Synchronously stop timers, bump generation, drop channels, and disconnect this generation's transport. */
  teardown(options?: { disconnectSocket?: boolean }): void;
  /** Permanently dispose listeners and subscriptions. */
  dispose(): void;
  /** Current healthy-push flag (true only while BOTH private topics are SUBSCRIBED). */
  readonly subscribed: boolean;
}

function defaultTimers(): FeedPushTimers {
  return {
    setInterval(handler, ms) {
      return globalThis.setInterval(handler, ms) as unknown as number;
    },
    clearInterval(id) {
      if (id !== undefined) {
        globalThis.clearInterval(id as unknown as ReturnType<typeof setInterval>);
      }
    },
    setTimeout(handler, ms) {
      return globalThis.setTimeout(handler, ms) as unknown as number;
    },
    clearTimeout(id) {
      if (id !== undefined) {
        globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      }
    },
  };
}

function isDocumentVisible(
  doc: Pick<Document, 'visibilityState'> | null | undefined,
): boolean {
  if (!doc) return true;
  return doc.visibilityState !== 'hidden';
}

function realtimeEndpointForDeployment(apiUrl: string): string | null {
  let base: URL;
  try {
    const trimmed = apiUrl.trim();
    base = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' || !base.host) {
    return null;
  }
  const realtimeUrl = new URL('realtime/v1', base);
  realtimeUrl.protocol = 'wss:';
  return realtimeUrl.href;
}

type TransportCtor = NonNullable<RealtimeClientOptions['transport']>;

function createClosedStubSocket() {
  return {
    readyState: 3, // WebSocket.CLOSED
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send() {},
    close() {},
  };
}

/**
 * Wrap the underlying WebSocket constructor for one generation's `RealtimeClient`.
 * While live, delegates directly to `BaseTransport`. Once retired, returns a closed
 * no-op socket so even Phoenix's own window `pageshow` listener (`socket.js:108-113`)
 * can never open a new socket for an abandoned generation.
 */
function createGenerationTransportCtor(
  BaseTransport: TransportCtor,
  isRetired: () => boolean,
): TransportCtor {
  return function GenerationWebSocket(
    address: string | URL,
    subprotocols?: string | string[],
  ) {
    if (isRetired()) {
      return createClosedStubSocket();
    }
    return new BaseTransport(address, subprotocols);
  } as unknown as TransportCtor;
}

type OwnedChannel = Parameters<FeedPushChannelClient['removeChannel']>[0] & {
  teardown?(): void;
};

interface GenerationRealtimeTransport extends FeedPushChannelClient {
  readonly dedicated: boolean;
  setAuth(token: string): Promise<void> | void;
  isConnected(): boolean;
  clearSendBuffer(): void;
  removeAllChannels?(): Promise<unknown> | unknown;
  disconnect?(): Promise<unknown> | unknown;
}

interface OwnedRealtimeSession {
  readonly generation: number;
  readonly fence: Fence;
  readonly transport: GenerationRealtimeTransport;
  readonly channels: Set<OwnedChannel>;
  lastAccessToken: string;
  retired: boolean;
  cleanupPromise: Promise<void> | null;
}

function safeInvoke(
  fn: (() => Promise<unknown> | unknown) | undefined,
): Promise<void> {
  if (!fn) return Promise.resolve();
  try {
    return Promise.resolve(fn()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/**
 * Create a generation-scoped realtime transport.
 *
 * When backed by a real Supabase client (`rawClient.realtime instanceof RealtimeClient`),
 * every generation constructs a brand-new `RealtimeClient` from the configured deployment
 * endpoint and public anon key (inheriting the transport constructor, heartbeat interval,
 * and timeout). No `accessToken` storage callback is passed; auth is set exclusively via
 * `setAuth(token)` from the fenced `SessionGate.acquireAccessToken()`.
 *
 * For non-SDK unit test doubles (`fake-session.ts`), adapts the provided mock client.
 */
function createGenerationTransport(
  rawClient: RealtimeCapableClient,
  apiUrl: string,
  anonKey: string,
  isRetired: () => boolean,
): GenerationRealtimeTransport {
  if (rawClient.realtime instanceof RealtimeClient) {
    const realtimeEndpoint = realtimeEndpointForDeployment(apiUrl);
    if (!realtimeEndpoint) {
      throw new Error('live_realtime_origin_mismatch');
    }
    const baseRealtime = rawClient.realtime;
    const rtClient = new RealtimeClient(realtimeEndpoint, {
      params: { apikey: anonKey },
      transport: createGenerationTransportCtor(baseRealtime.transport, isRetired),
      heartbeatIntervalMs: baseRealtime.heartbeatIntervalMs,
      timeout: baseRealtime.timeout,
    });
    if (
      !realtimeEndpointMatchesApiOrigin(
        rtClient as unknown as RealtimeCapableClient,
        apiUrl,
      )
    ) {
      void safeInvoke(() => rtClient.disconnect());
      throw new Error('live_realtime_origin_mismatch');
    }
    return {
      dedicated: true,
      channel(name, opts) {
        return rtClient.channel(name, opts);
      },
      removeChannel(ch) {
        return rtClient.removeChannel(
          ch as Parameters<RealtimeClient['removeChannel']>[0],
        );
      },
      removeAllChannels() {
        return rtClient.removeAllChannels();
      },
      disconnect() {
        return rtClient.disconnect();
      },
      setAuth(token) {
        return rtClient.setAuth(token);
      },
      isConnected() {
        return rtClient.isConnected();
      },
      clearSendBuffer() {
        if (Array.isArray(rtClient.sendBuffer)) {
          rtClient.sendBuffer.length = 0;
        }
      },
    };
  }

  // Test double adapter (unit/C1 tests without a real RealtimeClient).
  return {
    dedicated: false,
    channel(name, opts) {
      return rawClient.channel(name, opts);
    },
    removeChannel(ch) {
      return rawClient.removeChannel(ch);
    },
    setAuth(token) {
      return rawClient.realtime?.setAuth(token);
    },
    isConnected() {
      return Boolean(rawClient.realtime?.isConnected?.());
    },
    clearSendBuffer() {},
  };
}

/**
 * Synchronously retire callbacks and abandon a generation's dedicated transport.
 *
 * Because each generation owns its own `RealtimeClient`, a retired generation's socket,
 * channels, and `sendBuffer` can never be touched or flushed by a successor:
 * - While not yet connected (`CONNECTING`), synchronously clears `sendBuffer`, disconnects
 *   immediately (closing the connecting socket so `onopen` can never fire), tears down all
 *   channels, and clears `sendBuffer` again so any `phx_leave` queued by `leave()` is also
 *   discarded before any microtask runs.
 * - While already connected (`OPEN`), calls `removeAllChannels()` (which sends `phx_leave`,
 *   tears down channels, and calls `disconnect()`), then wipes `sendBuffer` and drops refs.
 */
function retireAndCleanupSession(session: OwnedRealtimeSession): Promise<void> {
  session.retired = true;
  session.transport.clearSendBuffer();

  if (session.cleanupPromise) {
    return session.cleanupPromise;
  }

  const ownedChannels = [...session.channels];
  const { transport } = session;

  if (transport.dedicated) {
    if (!transport.isConnected()) {
      const disconnectPromise = safeInvoke(() => transport.disconnect?.());
      const removePromise = safeInvoke(() => transport.removeAllChannels?.());
      for (const ch of ownedChannels) {
        try {
          ch.teardown?.();
        } catch {
          // Ignore teardown errors.
        }
      }
      // `channel.leave()` pushes `phx_leave` onto `sendBuffer` synchronously when disconnected.
      transport.clearSendBuffer();

      session.cleanupPromise = Promise.allSettled([
        disconnectPromise,
        removePromise,
      ]).then(() => {
        transport.clearSendBuffer();
        session.channels.clear();
        // Advance `connectClock` once closed so Phoenix's `pageshow` listener cannot revive it.
        return safeInvoke(() => transport.disconnect?.());
      });
      return session.cleanupPromise;
    }

    const removePromise = safeInvoke(() => transport.removeAllChannels?.());
    session.cleanupPromise = removePromise.then(() => {
      transport.clearSendBuffer();
      for (const ch of ownedChannels) {
        try {
          ch.teardown?.();
        } catch {
          // Ignore teardown errors.
        }
      }
      session.channels.clear();
      return safeInvoke(() => transport.disconnect?.());
    });
    return session.cleanupPromise;
  }

  // Test double: remove only channels created by this generation.
  const removals = ownedChannels.map((ch) =>
    safeInvoke(() => transport.removeChannel(ch)),
  );
  session.cleanupPromise = Promise.allSettled(removals).then(() => {
    session.channels.clear();
  });
  return session.cleanupPromise;
}

/**
 * Manages the single workspace live-update subscription (`cswarm-signals:<ws>` and
 * `cswarm-member:<ws>:<user>`) for one `(loginGeneration, workspaceId)`.
 *
 * Security & lifecycle invariants:
 * - Subscribes ONLY while authenticated, not hidden by `pagehide`, and tab visible.
 * - Constructs a fresh `RealtimeClient` per generation from the configured HTTPS API
 *   origin (`wss://<api-host>/realtime/v1`) and public key, authenticated exclusively
 *   with the bearer returned by `sessionGate.acquireAccessToken()` (never from storage).
 * - Broadcast messages are hints ONLY (zero payload content is read); they trigger
 *   fenced, coalesced refreshes (one in flight, at most one queued).
 * - Falls back to `FEED_POLL_MS` (2s) polling and `FEED_PUSH_BACKOFF_MS` resubscribe
 *   backoff whenever either topic is not `SUBSCRIBED`; reconciles at `FEED_RECONCILE_MS` (30s).
 * - Synchronous callback retirement and transport abandonment on login change, workspace
 *   change, access loss, gate closure, `pagehide`, tab hide, partial attach, or dispose:
 *   queued outbound frames on a retiring generation can never be flushed by a successor,
 *   and an old teardown can never touch a successor's transport.
 * - In-generation same-login token refreshes update the active generation's client bearer
 *   through the fenced `sessionGate.acquireAccessToken()` path.
 */
export function createWorkspaceLiveManager(
  options: WorkspaceLiveManagerOptions,
): WorkspaceLiveManager {
  const { sessionGate, onRefresh } = options;
  const workspaceId = options.workspaceId.toLowerCase();
  const doc =
    'doc' in options
      ? options.doc
      : typeof document !== 'undefined'
        ? document
        : null;
  const timers = options.timers ?? defaultTimers();

  let disposed = false;
  let activeGeneration = 0;
  let activeSession: OwnedRealtimeSession | null = null;
  let activeFence: Fence | null = null;
  let tokenRefreshSeq = 0;

  const isEligibleToRun = (fence: Fence | null): boolean => {
    if (disposed) return false;
    if (sessionGate.state.status !== 'authenticated') return false;
    if (sessionGate.isHidden) return false;
    if (!isDocumentVisible(doc)) return false;
    if (sessionGate.fenceTracker.isWorkspaceRevoked(workspaceId)) return false;
    if (!fence) return false;
    return sessionGate.fenceTracker.isCurrent(fence, {
      requireActiveWorkspace: true,
      requireActiveConversation: false,
    });
  };

  const refreshActiveSessionAuth = async (): Promise<void> => {
    const session = activeSession;
    if (disposed || !session || session.retired) return;
    if (!isEligibleToRun(session.fence)) return;
    if (session.generation !== activeGeneration) return;

    const auth = await sessionGate.acquireAccessToken();
    if (
      disposed ||
      !auth ||
      session.retired ||
      activeSession !== session ||
      session.generation !== activeGeneration ||
      sessionGate.isHidden ||
      !isDocumentVisible(doc) ||
      !sessionGate.fenceTracker.isCurrent(session.fence, {
        loginIdentity: auth.identity,
        requireActiveWorkspace: true,
        requireActiveConversation: false,
      })
    ) {
      return;
    }

    if (auth.accessToken === session.lastAccessToken) {
      return;
    }
    session.lastAccessToken = auth.accessToken;
    try {
      await session.transport.setAuth(auth.accessToken);
    } catch {
      // Ignore transient setAuth errors on a live or retiring transport.
    }
  };

  const controller = new FeedPushController({
    timers,
    subscribe: async (wsId, onEvent, onStatus) => {
      const capturedGen = activeGeneration;
      const capturedFence = activeFence;
      if (!isEligibleToRun(capturedFence) || !capturedFence) {
        throw new Error('live_subscription_not_eligible');
      }

      const deployment = sessionGate.deployment;
      const rawClient = sessionGate.client as
        | (SupabaseClient & RealtimeCapableClient)
        | null;
      if (!deployment || !rawClient || typeof rawClient.channel !== 'function') {
        throw new Error('live_client_unavailable');
      }

      if (!realtimeEndpointMatchesApiOrigin(rawClient, deployment.url)) {
        throw new Error('live_realtime_origin_mismatch');
      }

      const refreshSeqAtAcquire = tokenRefreshSeq;
      const auth = await sessionGate.acquireAccessToken();

      const isCapturedStillCurrent = (): boolean =>
        !disposed &&
        capturedGen === activeGeneration &&
        Boolean(auth) &&
        !sessionGate.isHidden &&
        isDocumentVisible(doc) &&
        sessionGate.fenceTracker.isCurrent(capturedFence, {
          loginIdentity: auth!.identity,
          requireActiveWorkspace: true,
          requireActiveConversation: false,
        });

      if (!isCapturedStillCurrent() || !auth) {
        throw new Error('live_fence_retired_after_token');
      }

      let retiredFlag = false;
      const generationTransport = createGenerationTransport(
        rawClient,
        auth.url,
        auth.anonKey,
        () => retiredFlag || disposed || capturedGen !== activeGeneration,
      );

      const session: OwnedRealtimeSession = {
        generation: capturedGen,
        fence: capturedFence,
        transport: generationTransport,
        channels: new Set<OwnedChannel>(),
        lastAccessToken: auth.accessToken,
        get retired() {
          return retiredFlag;
        },
        set retired(value: boolean) {
          retiredFlag = value;
        },
        cleanupPromise: null,
      };
      activeSession = session;

      try {
        await generationTransport.setAuth(auth.accessToken);
      } catch (authError) {
        if (activeSession === session) {
          activeSession = null;
        }
        await retireAndCleanupSession(session);
        throw authError;
      }

      if (session.retired || !isCapturedStillCurrent()) {
        if (activeSession === session) {
          activeSession = null;
        }
        await retireAndCleanupSession(session);
        throw new Error('live_fence_retired_after_set_auth');
      }

      // Own every channel from creation so partial second-attach failures clean up immediately.
      const trackingClient: FeedPushChannelClient = {
        channel(name, opts) {
          if (session.retired || !isCapturedStillCurrent()) {
            throw new Error('live_fence_retired_during_attach');
          }
          const ch = generationTransport.channel(name, opts) as OwnedChannel;
          session.channels.add(ch);
          return ch;
        },
        removeChannel() {
          // Cleanup is owned by `retireAndCleanupSession`, never by duplicate channel calls.
          return Promise.resolve();
        },
      };

      try {
        attachFeedChannels(
          trackingClient,
          wsId,
          auth.identity.userId,
          () => {
            // Hint only: zero payload read; strictly fenced to captured generation & login.
            if (session.retired || !isCapturedStillCurrent()) {
              return;
            }
            onEvent();
          },
          (status) => {
            if (session.retired || !isCapturedStillCurrent()) {
              return;
            }
            onStatus(status);
          },
        );
      } catch (attachError) {
        if (activeSession === session) {
          activeSession = null;
        }
        await retireAndCleanupSession(session);
        throw attachError;
      }

      // Re-verify synchronously in case teardown ran re-entrantly during subscribe().
      if (session.retired || !isCapturedStillCurrent()) {
        if (activeSession === session) {
          activeSession = null;
        }
        await retireAndCleanupSession(session);
        throw new Error('live_fence_retired_during_attach');
      }

      if (tokenRefreshSeq !== refreshSeqAtAcquire) {
        void refreshActiveSessionAuth();
      }

      const wrappedSub: FeedPushSubscription = {
        unsubscribe() {
          if (activeSession === session) {
            activeSession = null;
          }
          return retireAndCleanupSession(session);
        },
      };

      return wrappedSub;
    },
    refresh: async () => {
      const capturedGen = activeGeneration;
      const capturedFence = activeFence;
      if (!isEligibleToRun(capturedFence) || !capturedFence) return;
      if (capturedGen !== activeGeneration) return;
      await onRefresh(capturedFence);
    },
  });

  const teardown = (): void => {
    activeGeneration += 1;
    activeFence = null;
    const sessionToDrop = activeSession;
    activeSession = null;

    controller.stop();
    if (sessionToDrop) {
      void retireAndCleanupSession(sessionToDrop).catch(() => undefined);
    }
  };

  const startIfEligible = (): void => {
    if (disposed) return;
    if (
      sessionGate.state.status !== 'authenticated' ||
      sessionGate.isHidden ||
      !isDocumentVisible(doc) ||
      sessionGate.fenceTracker.isWorkspaceRevoked(workspaceId)
    ) {
      return;
    }
    const rawClient = sessionGate.client as
      | (SupabaseClient & RealtimeCapableClient)
      | null;
    if (!rawClient || typeof rawClient.channel !== 'function') {
      return;
    }
    const fence = sessionGate.fenceTracker.capture({
      workspaceId,
      conversationId: null,
    });
    if (
      !sessionGate.fenceTracker.isCurrent(fence, {
        requireActiveWorkspace: true,
        requireActiveConversation: false,
      })
    ) {
      return;
    }

    activeGeneration += 1;
    activeFence = fence;
    controller.arm();
    controller.start(workspaceId);
  };

  const onVisibilityChange = (): void => {
    if (disposed) return;
    if (!isDocumentVisible(doc) || sessionGate.isHidden) {
      teardown();
      return;
    }
    startIfEligible();
  };

  const unsubscribeTokenRefresh = sessionGate.onTokenRefresh?.(() => {
    tokenRefreshSeq += 1;
    void refreshActiveSessionAuth();
  });

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  startIfEligible();

  return {
    teardown,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeTokenRefresh?.();
      doc?.removeEventListener('visibilitychange', onVisibilityChange);
      teardown();
    },
    get subscribed() {
      return controller.subscribed;
    },
  };
}
