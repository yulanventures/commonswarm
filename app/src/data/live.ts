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

function disconnectClientRealtime(client: RealtimeCapableClient | null): void {
  if (!client) return;
  const rt = client.realtime;
  const channels =
    typeof client.getChannels === 'function'
      ? client.getChannels()
      : typeof rt?.getChannels === 'function'
        ? rt.getChannels()
        : null;
  const knownIdle =
    channels !== null &&
    channels.length === 0 &&
    typeof rt?.connectionState === 'function' &&
    rt.connectionState() === 'closed' &&
    !rt.isConnected?.() &&
    !rt.isConnecting?.();
  if (knownIdle) return;

  try {
    if (typeof client.removeAllChannels === 'function') {
      void Promise.resolve(client.removeAllChannels()).catch(() => undefined);
      return;
    }
    if (typeof rt?.removeAllChannels === 'function') {
      void Promise.resolve(rt.removeAllChannels()).catch(() => undefined);
      return;
    }
    if (typeof rt?.disconnect === 'function') {
      void Promise.resolve(rt.disconnect()).catch(() => undefined);
    }
  } catch {
    // Isolate teardown errors so synchronous retirement always completes.
  }
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
 * - Synchronous teardown on login change, workspace change, access loss, gate closure,
 *   `pagehide`, tab hide, or dispose; any late hint or settlement for a retired
 *   generation is discarded with zero reads and zero socket retention.
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
  let activeSub: FeedPushSubscription | null = null;
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

      // Fence check after acquiring token, before setAuth / subscribe.
      if (
        disposed ||
        capturedGen !== activeGeneration ||
        !auth ||
        sessionGate.isHidden ||
        !isDocumentVisible(doc) ||
        !sessionGate.fenceTracker.isCurrent(capturedFence, {
          loginIdentity: auth.identity,
          requireActiveWorkspace: true,
          requireActiveConversation: false,
        })
      ) {
        throw new Error('live_fence_retired_after_token');
      }

      if (typeof rawClient.realtime?.setAuth === 'function') {
        await rawClient.realtime.setAuth(auth.accessToken);
      }

      // Fence check again immediately after setAuth, before attaching channels.
      if (
        disposed ||
        capturedGen !== activeGeneration ||
        sessionGate.isHidden ||
        !isDocumentVisible(doc) ||
        !sessionGate.fenceTracker.isCurrent(capturedFence, {
          loginIdentity: auth.identity,
          requireActiveWorkspace: true,
          requireActiveConversation: false,
        })
      ) {
        throw new Error('live_fence_retired_after_set_auth');
      }

      const attachedChannels: Parameters<FeedPushChannelClient['removeChannel']>[0][] = [];
      const trackingClient: FeedPushChannelClient = {
        channel(name, opts) {
          const ch = rawClient.channel(name, opts);
          attachedChannels.push(ch);
          return ch;
        },
        removeChannel(ch) {
          return rawClient.removeChannel(ch);
        },
      };

      const sub = attachFeedChannels(
        trackingClient,
        wsId,
        auth.identity.userId,
        () => {
          // Hint only: zero payload read; strictly fenced to captured generation & login.
          if (
            disposed ||
            capturedGen !== activeGeneration ||
            sessionGate.isHidden ||
            !isDocumentVisible(doc) ||
            !sessionGate.fenceTracker.isCurrent(capturedFence, {
              loginIdentity: auth.identity,
              requireActiveWorkspace: true,
              requireActiveConversation: false,
            })
          ) {
            return;
          }
          onEvent();
        },
        (status) => {
          if (
            disposed ||
            capturedGen !== activeGeneration ||
            sessionGate.isHidden ||
            !isDocumentVisible(doc) ||
            !sessionGate.fenceTracker.isCurrent(capturedFence, {
              loginIdentity: auth.identity,
              requireActiveWorkspace: true,
              requireActiveConversation: false,
            })
          ) {
            return;
          }
          onStatus(status);
        },
      );

      let syncCleaned = false;
      const syncUnsubscribe = (): void => {
        if (syncCleaned) return;
        syncCleaned = true;
        for (const ch of attachedChannels) {
          try {
            void Promise.resolve(rawClient.removeChannel(ch)).catch(() => undefined);
          } catch {
            // Isolate channel removal errors.
          }
        }
        void sub.unsubscribe().catch(() => undefined);
      };

      // Re-verify synchronously in case teardown ran re-entrantly during subscribe().
      if (
        disposed ||
        capturedGen !== activeGeneration ||
        sessionGate.isHidden ||
        !isDocumentVisible(doc) ||
        !sessionGate.fenceTracker.isCurrent(capturedFence, {
          loginIdentity: auth.identity,
          requireActiveWorkspace: true,
          requireActiveConversation: false,
        })
      ) {
        syncUnsubscribe();
        throw new Error('live_fence_retired_during_attach');
      }

      const wrappedSub: FeedPushSubscription = {
        async unsubscribe() {
          syncUnsubscribe();
        },
      };

      activeSub = wrappedSub;
      activeClient = rawClient;
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

  const teardown = (opts: { disconnectSocket?: boolean } = {}): void => {
    activeGeneration += 1;
    activeFence = null;
    const subToDrop = activeSub;
    const clientToDrop =
      activeClient ??
      (sessionGate.client as (SupabaseClient & RealtimeCapableClient) | null);
    activeSub = null;
    activeClient = null;

    controller.stop();
    if (subToDrop) {
      void subToDrop.unsubscribe().catch(() => undefined);
    }
    if (opts.disconnectSocket) {
      disconnectClientRealtime(clientToDrop);
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
