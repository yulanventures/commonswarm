import type { SupabaseClient } from '@supabase/supabase-js';
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
  /** Synchronously stop timers, bump generation, drop channels, and optionally disconnect socket. */
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

type OwnedChannel = Parameters<FeedPushChannelClient['removeChannel']>[0] & {
  teardown?(): void;
};

interface OwnedRealtimeSession {
  readonly owner: symbol;
  readonly client: RealtimeCapableClient;
  readonly channels: Set<OwnedChannel>;
  retired: boolean;
  cleaned: boolean;
  cleanupPromise: Promise<void> | null;
}

/**
 * Single per-client lifecycle coordinator that serializes channel/socket cleanup
 * against successor setup on the same realtime client.
 *
 * In the pinned `@supabase/realtime-js` (2.111.0):
 * - `RealtimeClient.channel(topic)` (RealtimeClient.ts:452-465) returns the EXISTING
 *   channel instance while it is still registered in `this.channels`.
 * - `RealtimeClient.removeAllChannels()` (RealtimeClient.ts:384-394) awaits every
 *   channel's `unsubscribe()` and then unconditionally calls `await this.disconnect()`.
 * - `RealtimeClient.connect()` (RealtimeClient.ts:296-300) returns without connecting
 *   while `this.isDisconnecting()` is true.
 *
 * Serializing teardown and setup through one owner per client prevents a successor from
 * reusing a retiring channel or being disconnected when a predecessor's teardown finishes.
 * Tracking `activeOwner` ensures a stale/already-superseded manager can never call
 * `removeAllChannels()` or `disconnect()` on a successor's socket.
 * When idle, the first task starts synchronously so teardown immediately initiates leave /
 * disconnect (e.g. synchronously inside a `pagehide` handler).
 */
class RealtimeClientCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private activeOwner: symbol | null = null;

  claimOwner(owner: symbol): void {
    this.activeOwner = owner;
  }

  isOwner(owner: symbol | null): boolean {
    return owner !== null && this.activeOwner === owner;
  }

  releaseOwner(owner: symbol | null): void {
    if (owner !== null && this.activeOwner === owner) {
      this.activeOwner = null;
    }
  }

  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.inFlight === 0) {
      this.inFlight += 1;
      let resultPromise: Promise<T>;
      try {
        resultPromise = Promise.resolve(task());
      } catch (err) {
        resultPromise = Promise.reject(err);
      }
      const done = resultPromise
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.inFlight -= 1;
        });
      this.tail = done;
      return resultPromise;
    }

    this.inFlight += 1;
    const resultPromise = this.tail.then(() => task());
    const done = resultPromise
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.inFlight -= 1;
      });
    this.tail = done;
    return resultPromise;
  }
}

const clientCoordinators = new WeakMap<object, RealtimeClientCoordinator>();

function coordinatorForClient(
  client: RealtimeCapableClient,
): RealtimeClientCoordinator {
  const key = (client.realtime ?? client) as object;
  let coordinator = clientCoordinators.get(key);
  if (!coordinator) {
    coordinator = new RealtimeClientCoordinator();
    clientCoordinators.set(key, coordinator);
  }
  return coordinator;
}

function getClientChannels(client: RealtimeCapableClient): unknown[] | null {
  const rt = client.realtime;
  if (typeof client.getChannels === 'function') {
    return client.getChannels();
  }
  if (typeof rt?.getChannels === 'function') {
    return rt.getChannels();
  }
  return null;
}

function isClientKnownIdle(client: RealtimeCapableClient): boolean {
  const rt = client.realtime;
  const channels = getClientChannels(client);
  return (
    channels !== null &&
    channels.length === 0 &&
    typeof rt?.connectionState === 'function' &&
    rt.connectionState() === 'closed' &&
    !rt.isConnected?.() &&
    !rt.isConnecting?.()
  );
}

async function removeOwnedChannelsOnly(
  client: RealtimeCapableClient,
  coordinator: RealtimeClientCoordinator,
  owner: symbol | null,
  uniqueChannels: readonly OwnedChannel[],
): Promise<void> {
  if (uniqueChannels.length === 0) {
    return;
  }

  await Promise.allSettled(
    uniqueChannels.map((ch) => {
      try {
        return Promise.resolve(client.removeChannel(ch));
      } catch {
        return Promise.resolve();
      }
    }),
  );

  // In pinned `RealtimeClient.removeChannel` (RealtimeClient.ts:369-377), non-'ok'
  // unsubscribe skips `channel.teardown()`. Ensure none of our owned channels stay
  // registered to poison a subsequent `channel(topic)` call.
  const remaining = getClientChannels(client);
  if (remaining && uniqueChannels.some((ch) => remaining.includes(ch))) {
    for (const ch of uniqueChannels) {
      if (remaining.includes(ch)) {
        try {
          ch.teardown?.();
        } catch {
          // Ignore teardown errors.
        }
      }
    }
    const stillRegistered = getClientChannels(client);
    if (
      coordinator.isOwner(owner) &&
      stillRegistered &&
      uniqueChannels.some((ch) => stillRegistered.includes(ch))
    ) {
      coordinator.releaseOwner(owner);
      const rt = client.realtime;
      try {
        if (typeof client.removeAllChannels === 'function') {
          await Promise.resolve(client.removeAllChannels());
        } else if (typeof rt?.removeAllChannels === 'function') {
          await Promise.resolve(rt.removeAllChannels());
        }
      } catch {
        // Isolate cleanup errors.
      }
    }
  }
}

async function cleanupClientRealtime(
  client: RealtimeCapableClient,
  coordinator: RealtimeClientCoordinator,
  owner: symbol | null,
  channels: Iterable<OwnedChannel>,
  disconnectSocket: boolean,
): Promise<void> {
  const uniqueChannels = [...new Set(channels)];
  const rt = client.realtime;
  const ownsClient = coordinator.isOwner(owner);

  if (disconnectSocket) {
    if (!ownsClient) {
      // A successor already owns this client/socket: NEVER call removeAllChannels() or
      // disconnect(). Only clean up any channels still belonging to this retired session.
      await removeOwnedChannelsOnly(client, coordinator, owner, uniqueChannels);
      return;
    }

    coordinator.releaseOwner(owner);

    if (uniqueChannels.length === 0 && isClientKnownIdle(client)) {
      return;
    }
    try {
      if (typeof client.removeAllChannels === 'function') {
        await Promise.resolve(client.removeAllChannels());
        return;
      }
      if (typeof rt?.removeAllChannels === 'function') {
        await Promise.resolve(rt.removeAllChannels());
        return;
      }
      if (uniqueChannels.length > 0) {
        await Promise.allSettled(
          uniqueChannels.map((ch) => {
            try {
              return Promise.resolve(client.removeChannel(ch));
            } catch {
              return Promise.resolve();
            }
          }),
        );
      }
      if (typeof rt?.disconnect === 'function') {
        await Promise.resolve(rt.disconnect());
      }
    } catch {
      // Isolate teardown errors so queued successor setup can proceed.
    }
    return;
  }

  await removeOwnedChannelsOnly(client, coordinator, owner, uniqueChannels);
}

/**
 * Manages the single workspace live-update subscription (`cswarm-signals:<ws>` and
 * `cswarm-member:<ws>:<user>`) for one `(loginGeneration, workspaceId)`.
 *
 * Security & lifecycle invariants:
 * - Subscribes ONLY while authenticated, not hidden by `pagehide`, and tab visible.
 * - Uses the session's own Supabase client after confirming its Realtime endpoint
 *   matches the configured HTTPS API origin over `wss:`.
 * - Broadcast messages are hints ONLY (zero payload content is read); they trigger
 *   fenced, coalesced refreshes (one in flight, at most one queued).
 * - Falls back to `FEED_POLL_MS` (2s) polling and `FEED_PUSH_BACKOFF_MS` resubscribe
 *   backoff whenever either topic is not `SUBSCRIBED`; reconciles at `FEED_RECONCILE_MS` (30s).
 * - Synchronous callback retirement and single-owner serialized cleanup on login change,
 *   workspace change, access loss, gate closure, `pagehide`, tab hide, partial attach,
 *   or dispose; any late hint for a retired generation is discarded with zero reads, and
 *   no successor reuses a retiring channel or gets disconnected by an old teardown.
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
  let activeOwner: symbol | null = null;
  let activeClient: RealtimeCapableClient | null = null;
  let activeFence: Fence | null = null;

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

  const scheduleSessionCleanup = (
    client: RealtimeCapableClient | null,
    session: OwnedRealtimeSession | null,
    owner: symbol | null,
    disconnectSocket: boolean,
  ): Promise<void> => {
    if (session) {
      session.retired = true;
      const coordinator = coordinatorForClient(session.client);
      if (session.cleaned) {
        if (!disconnectSocket) {
          return session.cleanupPromise ?? Promise.resolve();
        }
        return coordinator.enqueue(() =>
          cleanupClientRealtime(session.client, coordinator, session.owner, [], true),
        );
      }
      session.cleaned = true;
      const cleanup = coordinator.enqueue(() =>
        cleanupClientRealtime(
          session.client,
          coordinator,
          session.owner,
          session.channels,
          disconnectSocket,
        ),
      );
      session.cleanupPromise = cleanup;
      return cleanup;
    }

    if (disconnectSocket && client && owner) {
      const coordinator = coordinatorForClient(client);
      return coordinator.enqueue(() =>
        cleanupClientRealtime(client, coordinator, owner, [], true),
      );
    }

    return Promise.resolve();
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

      // Fence check before acquiring token.
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

      // Fence check after acquiring token, before entering the client coordinator.
      if (!isCapturedStillCurrent() || !auth) {
        throw new Error('live_fence_retired_after_token');
      }

      const coordinator = coordinatorForClient(rawClient);

      return await coordinator.enqueue(async () => {
        if (!isCapturedStillCurrent()) {
          throw new Error('live_fence_retired_before_setup');
        }

        if (typeof rawClient.realtime?.setAuth === 'function') {
          await rawClient.realtime.setAuth(auth.accessToken);
        }

        // Fence check again immediately after setAuth, before attaching channels.
        if (!isCapturedStillCurrent()) {
          throw new Error('live_fence_retired_after_set_auth');
        }

        // Own the session and every channel from the moment each channel is created.
        const owner = Symbol('workspace-live-owner');
        const session: OwnedRealtimeSession = {
          owner,
          client: rawClient,
          channels: new Set<OwnedChannel>(),
          retired: false,
          cleaned: false,
          cleanupPromise: null,
        };
        coordinator.claimOwner(owner);
        activeSession = session;
        activeOwner = owner;
        activeClient = rawClient;

        const trackingClient: FeedPushChannelClient = {
          channel(name, opts) {
            if (session.retired || !isCapturedStillCurrent()) {
              throw new Error('live_fence_retired_during_attach');
            }
            const ch = rawClient.channel(name, opts) as OwnedChannel;
            session.channels.add(ch);
            return ch;
          },
          removeChannel() {
            // Cleanup is owned exclusively by the coordinator, never by duplicate channel-level calls.
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
          // Clean up any already-created channels immediately within this serialized turn
          // so a partial attach (e.g. failure of the second attach) cannot outlive a retry.
          session.retired = true;
          if (activeSession === session) {
            activeSession = null;
          }
          if (!session.cleaned) {
            session.cleaned = true;
            const cleanup = cleanupClientRealtime(
              rawClient,
              coordinator,
              session.owner,
              session.channels,
              false,
            );
            session.cleanupPromise = cleanup;
            await cleanup;
          }
          throw attachError;
        }

        // Re-verify synchronously in case teardown ran re-entrantly during subscribe().
        if (session.retired || !isCapturedStillCurrent()) {
          session.retired = true;
          if (activeSession === session) {
            activeSession = null;
          }
          if (!session.cleaned) {
            session.cleaned = true;
            const cleanup = cleanupClientRealtime(
              rawClient,
              coordinator,
              session.owner,
              session.channels,
              false,
            );
            session.cleanupPromise = cleanup;
            await cleanup;
          }
          throw new Error('live_fence_retired_during_attach');
        }

        const wrappedSub: FeedPushSubscription = {
          unsubscribe() {
            if (activeSession === session) {
              activeSession = null;
            }
            return scheduleSessionCleanup(rawClient, session, session.owner, false);
          },
        };

        return wrappedSub;
      });
    },
    refresh: async () => {
      const capturedGen = activeGeneration;
      const capturedFence = activeFence;
      if (!isEligibleToRun(capturedFence) || !capturedFence) return;
      if (capturedGen !== activeGeneration) return;
      await onRefresh(capturedFence);
    },
  });

  const teardown = (opts: { disconnectSocket?: boolean } = {}): void => {
    const disconnectSocket = Boolean(opts.disconnectSocket);
    activeGeneration += 1;
    activeFence = null;
    const sessionToDrop = activeSession;
    const ownerToDrop = sessionToDrop?.owner ?? activeOwner;
    const clientToDrop = sessionToDrop?.client ?? activeClient;
    activeSession = null;
    if (disconnectSocket) {
      activeOwner = null;
      activeClient = null;
    }

    controller.stop();
    void scheduleSessionCleanup(
      clientToDrop,
      sessionToDrop,
      ownerToDrop,
      disconnectSocket,
    ).catch(() => undefined);
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
      teardown({ disconnectSocket: true });
      return;
    }
    startIfEligible();
  };

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  startIfEligible();

  return {
    teardown,
    dispose() {
      if (disposed) return;
      disposed = true;
      doc?.removeEventListener('visibilitychange', onVisibilityChange);
      teardown({ disconnectSocket: true });
    },
    get subscribed() {
      return controller.subscribed;
    },
  };
}
