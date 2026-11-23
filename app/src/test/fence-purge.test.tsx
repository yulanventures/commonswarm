import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import {
  WORKSPACE_UNAVAILABLE_TEXT,
  createAppQueryClient,
  createDataController,
  queryKeys,
} from '../data/queries';
import { createSessionGate } from '../data/session';
import { getSnapshot as getStoreSnapshot } from '../store/appStore';
import {
  createDeferred,
  createFakeSessionHarness,
  createFakeStorage,
  makeFakeSession,
  type PostgrestResponse,
} from './fake-session';

const DEPLOY_URL = 'https://api.commonswarm.com';
const ANON_KEY = 'anon-public-key';
const WS_1 = '11111111-1111-4111-8111-111111111111';
const WS_2 = '22222222-2222-4222-8222-222222222222';
const CONV_GEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_PRIV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeConversationsResponse(
  conversations: Array<Record<string, unknown>>,
): Response {
  return new Response(JSON.stringify({ conversations }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeStandardConversation(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: CONV_GEN,
    kind: 'general',
    channel_id: null,
    slug: 'general',
    description: null,
    archived_at: null,
    joined: true,
    members: [],
    notify_level: 'everything',
    starred: false,
    star_rank: null,
    unread_count: 0,
    mention_count: 0,
    last_message_at: null,
    last_message_id: null,
    ...overrides,
  };
}

describe('Synchronous purge, login identity fence, authoritative loss, and bfcache', () => {
  it('purges cache, store, and realtime synchronously on login-generation change while a read is in flight, and discards the held response', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const heldConversations = createDeferred<Response>();

    const harness = createFakeSessionHarness(session1, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [{ workspace_id: WS_1, name: 'Secret Workspace' }],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'agent_principals') {
          return { data: [], error: null, status: 200 };
        }
        if (call.target === 'agent_presence') {
          return { data: [], error: null, status: 200 };
        }
        if (call.target === 'agent_wake_path') {
          return { data: [], error: null, status: 200 };
        }
        if (call.target === 'member_profiles') {
          return {
            data: [{ user_id: 'user-1', display_name: 'Alice', role: 'owner' }],
            error: null,
            status: 200,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call) {
        if (call.target === 'home_overview') {
          return {
            data: {
              viewer_user_id: 'user-1',
              generated_at: '2026-11-23T12:00:00.000Z',
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              asks: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'waiting_todos_page') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              todos: [],
            },
            error: null,
            status: 200,
          };
        }
        return { data: null, error: null, status: 200 };
      },
      onFetch() {
        return heldConversations.promise;
      },
    });

    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);
    const realtimeDrop = vi.fn();
    controller.registerRealtimeSubscription(realtimeDrop, { workspaceId: WS_1 });

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    // Wait until workspaces loaded and conversations read is in flight.
    await waitFor(() => {
      expect(getStoreSnapshot().selectedWorkspaceId).toBe(WS_1);
      expect(harness.fetchCalls.length).toBeGreaterThanOrEqual(1);
    });
    const genBefore = gate.loginGeneration;
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    // Trigger sign-out synchronously while conversations read is still in flight.
    act(() => {
      harness.emitAuthChange('SIGNED_OUT', null);
      // Assert SYNCHRONOUSLY before any await: cache is empty, store reset, realtime dropped!
      expect(gate.loginGeneration).toBeGreaterThan(genBefore);
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(getStoreSnapshot().selectedWorkspaceId).toBeNull();
      expect(getStoreSnapshot().knownPrivateConversationIds).toEqual([]);
      expect(realtimeDrop).toHaveBeenCalledTimes(1);
    });

    // Now resolve the held conversations read with private data.
    await act(async () => {
      heldConversations.resolve(
        makeConversationsResponse([
          makeStandardConversation({
            conversation_id: CONV_PRIV,
            kind: 'private_channel',
            channel_id: CONV_PRIV,
            slug: 'top-secret',
          }),
        ]),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Nothing was written to cache and nothing of it painted.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByText('top-secret')).not.toBeInTheDocument();
    expect(screen.getByTestId('signed-out-screen')).toBeInTheDocument();

    controller.dispose();
    gate.dispose();
  });

  it('same person signs out and in again (new session_id) while a read is held: old response is discarded', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2' });
    const heldFirstConversations = createDeferred<Response>();
    let conversationsFetchCount = 0;

    const harness = createFakeSessionHarness(session1, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [{ workspace_id: WS_1, name: 'Acme' }],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'member_profiles') {
          return {
            data: [{ user_id: 'user-1', display_name: 'Alice', role: 'owner' }],
            error: null,
            status: 200,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call) {
        if (call.target === 'home_overview') {
          return {
            data: {
              viewer_user_id: 'user-1',
              generated_at: '2026-11-23T12:00:00.000Z',
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              asks: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'waiting_todos_page') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              todos: [],
            },
            error: null,
            status: 200,
          };
        }
        return { data: null, error: null, status: 200 };
      },
      onFetch() {
        conversationsFetchCount += 1;
        if (conversationsFetchCount === 1) {
          return heldFirstConversations.promise;
        }
        return makeConversationsResponse([
          makeStandardConversation({
            conversation_id: CONV_GEN,
            kind: 'general',
            slug: 'general',
          }),
        ]);
      },
    });

    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(conversationsFetchCount).toBe(1);
    });
    const gen1 = gate.loginGeneration;

    // Same user signs out and signs back in with a new session_id.
    act(() => {
      harness.emitAuthChange('SIGNED_OUT', null);
      harness.emitAuthChange('SIGNED_IN', session2);
    });
    expect(gate.loginGeneration).toBeGreaterThan(gen1);

    // Resolve the OLD held read with a channel that only existed in login 1.
    await act(async () => {
      heldFirstConversations.resolve(
        makeConversationsResponse([
          makeStandardConversation({
            conversation_id: CONV_PRIV,
            kind: 'private_channel',
            channel_id: CONV_PRIV,
            slug: 'stale-login-secret',
          }),
        ]),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('general')).toBeInTheDocument();
    });
    expect(screen.queryByText('stale-login-secret')).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(
        queryKeys.workspaceConversations(gen1, WS_1, 0),
      ),
    ).toBeUndefined();

    controller.dispose();
    gate.dispose();
  });

  it('workspace removed from the list while its sidebar read is held: nothing of it paints and uniform state shows', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const heldSidebarConv = createDeferred<Response>();
    let workspaceList = [
      { workspace_id: WS_1, name: 'Removed Workspace' },
      { workspace_id: WS_2, name: 'Remaining Workspace' },
    ];

    const harness = createFakeSessionHarness(session1, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return { data: workspaceList, error: null, status: 200 };
        }
        if (call.target === 'member_profiles') {
          return {
            data: [{ user_id: 'user-1', display_name: 'Alice', role: 'owner' }],
            error: null,
            status: 200,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call) {
        if (call.target === 'home_overview') {
          return {
            data: {
              viewer_user_id: 'user-1',
              generated_at: '2026-11-23T12:00:00.000Z',
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              asks: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'waiting_todos_page') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              todos: [],
            },
            error: null,
            status: 200,
          };
        }
        return { data: null, error: null, status: 200 };
      },
      onFetch() {
        return heldSidebarConv.promise;
      },
    });

    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getStoreSnapshot().selectedWorkspaceId).toBe(WS_1);
      expect(harness.fetchCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Server removes WS_1 from the workspace list; trigger a fresh workspaces read.
    workspaceList = [{ workspace_id: WS_2, name: 'Remaining Workspace' }];
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.workspaces(gate.loginGeneration),
      });
    });

    // Uniform unavailable state shows immediately.
    expect(screen.getByTestId('workspace-unavailable')).toHaveTextContent(
      WORKSPACE_UNAVAILABLE_TEXT,
    );

    // Held sidebar response resolves late: nothing of WS_1 paints or enters cache.
    await act(async () => {
      heldSidebarConv.resolve(
        makeConversationsResponse([
          makeStandardConversation({
            conversation_id: CONV_PRIV,
            kind: 'private_channel',
            channel_id: CONV_PRIV,
            slug: 'leaked-after-removal',
          }),
        ]),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('leaked-after-removal')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-unavailable')).toHaveTextContent(
      WORKSPACE_UNAVAILABLE_TEXT,
    );
    expect(
      queryClient.getQueryData(
        queryKeys.workspaceConversations(gate.loginGeneration, WS_1, 0),
      ),
    ).toBeUndefined();

    controller.dispose();
    gate.dispose();
  });

  it('private channel missing from a fresh conversations list is evicted synchronously and its row disappears', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    let conversationsList = [
      makeStandardConversation(),
      makeStandardConversation({
        conversation_id: CONV_PRIV,
        kind: 'private_channel',
        channel_id: CONV_PRIV,
        slug: 'board-room',
        joined: true,
      }),
    ];

    const harness = createFakeSessionHarness(session1, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [{ workspace_id: WS_1, name: 'Acme' }],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'member_profiles') {
          return {
            data: [{ user_id: 'user-1', display_name: 'Alice', role: 'owner' }],
            error: null,
            status: 200,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call) {
        if (call.target === 'home_overview') {
          return {
            data: {
              viewer_user_id: 'user-1',
              generated_at: '2026-11-23T12:00:00.000Z',
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 1,
              truncated: false,
              asks: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'waiting_todos_page') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              todos: [],
            },
            error: null,
            status: 200,
          };
        }
        return { data: null, error: null, status: 200 };
      },
      onFetch() {
        return makeConversationsResponse(conversationsList);
      },
    });

    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('board-room')).toBeInTheDocument();
    });

    // Seed review-checks & conversation caches to prove they are also evicted on loss.
    const loginGen = gate.loginGeneration;
    const wsGen = gate.fenceTracker.getWorkspaceGeneration(WS_1);
    const convGenBefore = gate.fenceTracker.getConversationGeneration(CONV_PRIV);
    queryClient.setQueryData(
      queryKeys.workspaceReviewChecks(loginGen, WS_1, wsGen),
      [{ checkId: 'chk-1' }],
    );
    queryClient.setQueryData(
      queryKeys.conversationMessages(loginGen, WS_1, wsGen, CONV_PRIV, convGenBefore),
      [{ id: 'msg-1' }],
    );

    // Fresh conversations list omits the private channel.
    conversationsList = [makeStandardConversation()];
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.workspaceConversations(loginGen, WS_1, wsGen),
      });
    });

    // Evicted synchronously in fence tracker and query cache (including Waiting & review data):
    expect(
      gate.fenceTracker.getConversationGeneration(CONV_PRIV),
    ).toBeGreaterThan(convGenBefore);
    expect(
      queryClient.getQueryData(
        queryKeys.workspaceReviewChecks(loginGen, WS_1, wsGen),
      ),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(
        queryKeys.workspaceWaiting(loginGen, WS_1, wsGen),
      ),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(
        queryKeys.conversationMessages(loginGen, WS_1, wsGen, CONV_PRIV, convGenBefore),
      ),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData<Array<{ conversationId: string }>>(
        queryKeys.workspaceConversations(loginGen, WS_1, wsGen),
      )?.some((c) => c.conversationId === CONV_PRIV),
    ).toBe(false);

    await waitFor(() => {
      expect(screen.queryByText('board-room')).not.toBeInTheDocument();
    });

    controller.dispose();
    gate.dispose();
  });

  it('return from back-forward cache (pageshow persisted) retires private state before paint and refetches from page 1', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    let workspaceRanges: unknown[] = [];
    let currentSessionDeferred: ReturnType<typeof createDeferred<typeof session1 | null>> | null =
      null;

    const harness = createFakeSessionHarness(session1, {
      onFrom(call): PostgrestResponse {
        if (call.target === 'workspaces') {
          workspaceRanges.push(call.filters.range);
          return {
            data: [{ workspace_id: WS_1, name: 'Private Corp' }],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'member_profiles') {
          return {
            data: [{ user_id: 'user-1', display_name: 'Alice', role: 'owner' }],
            error: null,
            status: 200,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call) {
        if (call.target === 'home_overview') {
          return {
            data: {
              viewer_user_id: 'user-1',
              generated_at: '2026-11-23T12:00:00.000Z',
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              asks: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'waiting_todos_page') {
          return {
            data: {
              workspace_id: WS_1,
              generated_at: '2026-11-23T12:00:00.000Z',
              total: 0,
              truncated: false,
              todos: [],
            },
            error: null,
            status: 200,
          };
        }
        return { data: null, error: null, status: 200 };
      },
      onFetch() {
        return makeConversationsResponse([
          makeStandardConversation({
            conversation_id: CONV_GEN,
            kind: 'general',
            slug: 'general',
          }),
        ]);
      },
    });

    const originalCurrentSession = harness.browserSession.currentSession.bind(
      harness.browserSession,
    );
    harness.browserSession.currentSession = async () => {
      if (currentSessionDeferred) return currentSessionDeferred.promise;
      return originalCurrentSession();
    };

    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Private Corp')).toBeInTheDocument();
      expect(screen.getByText('general')).toBeInTheDocument();
    });
    const genBefore = gate.loginGeneration;
    workspaceRanges = [];

    // Hold revalidation so we can observe the DOM right after bfcache pageshow before refetch finishes.
    currentSessionDeferred = createDeferred<typeof session1 | null>();

    act(() => {
      const ev = new Event('pageshow');
      Object.defineProperty(ev, 'persisted', { value: true });
      window.dispatchEvent(ev);
      // Synchronously retired before paint:
      expect(gate.loginGeneration).toBeGreaterThan(genBefore);
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(getStoreSnapshot().selectedWorkspaceId).toBeNull();
    });

    // Private DOM is retired while revalidating.
    expect(screen.queryByText('Private Corp')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-checking-screen')).toBeInTheDocument();

    // Revalidation succeeds -> refetches fresh from page 1 (range [0, 49]).
    await act(async () => {
      currentSessionDeferred!.resolve(session1);
      currentSessionDeferred = null;
    });

    await waitFor(() => {
      expect(screen.getByText('Private Corp')).toBeInTheDocument();
    });
    expect(workspaceRanges[0]).toEqual([0, 49]);

    controller.dispose();
    gate.dispose();
  });
});
