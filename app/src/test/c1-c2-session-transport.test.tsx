import {
  AuthRetryableFetchError,
  createClient,
  isAuthSessionMissingError,
  navigatorLock,
  processLock,
  type Session,
} from '@supabase/supabase-js';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserSession,
  deploymentOriginHash,
  sessionStorageKeyForDeployment,
} from '../../../shared/browser-session/index.js';
import { AppRoutes } from '../App';
import {
  readAgentPresence,
  readAgentPrincipals,
  readAgentWakePath,
  readConversations,
  readDecisionQueue,
  readHomeOverview,
  readMemberProfiles,
  readWaitingTodos,
  readWorkspaces,
} from '../data/api';
import { StaleFenceError } from '../data/fence';
import { createAppQueryClient, createDataController } from '../data/queries';
import { createSessionGate } from '../data/session';
import {
  createDeferred,
  createFakeSessionHarness,
  createFakeStorage,
  makeFakeJwt,
  makeFakeSession,
} from './fake-session';

const DEPLOY_URL = 'https://api.commonswarm.com';
const ANON_KEY = 'anon-public-key';
const WS_1 = '11111111-1111-4111-8111-111111111111';
const WS_2 = '22222222-2222-4222-8222-222222222222';
const CONV_GEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeStandardHandlers(workspaceNameByToken?: (authHeader: string | null) => string) {
  return {
    onFrom(call: { target: string; filters: Record<string, unknown> }) {
      if (call.target === 'workspaces') {
        return {
          data: [{ workspace_id: WS_1, name: 'Workspace One' }],
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
    onRpc(call: { target: string }) {
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
    onFetch(_input: RequestInfo | URL, init?: RequestInit) {
      const auth = new Headers(init?.headers).get('authorization');
      const slug = workspaceNameByToken ? workspaceNameByToken(auth) : 'general';
      return new Response(
        JSON.stringify({
          conversations: [
            {
              conversation_id: CONV_GEN,
              kind: 'public_channel',
              channel_id: CONV_GEN,
              slug,
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
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  };
}

describe('C1: generation-owned login acquisition, publication, and quiesce', () => {
  it('held token lookup settling (success, empty, or error) after sign-out is discarded with no mutation and zero data dispatch', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const harness = createFakeSessionHarness(session1, makeStandardHandlers());
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));

    const heldSuccess = createDeferred<{ data: { session: Session | null }; error: Error | null }>();
    const heldEmpty = createDeferred<{ data: { session: Session | null }; error: Error | null }>();
    const heldError = createDeferred<{ data: { session: Session | null }; error: Error | null }>();

    const queue = [heldSuccess.promise, heldEmpty.promise, heldError.promise];
    harness.setGetSessionHandler(() => queue.shift()!);

    const fence = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    const p1 = readWorkspaces(gate, { fence });
    const p2 = gate.acquireAccessToken();
    const p3 = gate.acquireAccessToken();

    // Peer signs out while all three token lookups are held.
    harness.emitAuthChange('SIGNED_OUT', null);
    expect(gate.state).toEqual({ status: 'signed_out' });
    const genAfterSignOut = gate.loginGeneration;

    // Late settlements arrive: old session success, empty, and error.
    heldSuccess.resolve({ data: { session: session1 }, error: null });
    heldEmpty.resolve({ data: { session: null }, error: null });
    heldError.reject(new Error('late network error'));

    await expect(p1).rejects.toBeInstanceOf(StaleFenceError);
    expect(await p2).toBeNull();
    expect(await p3).toBeNull();

    expect(gate.state).toEqual({ status: 'signed_out' });
    expect(gate.userId).toBeNull();
    expect(gate.loginGeneration).toBe(genAfterSignOut);
    expect(harness.wireCalls).toHaveLength(0);

    gate.dispose();
  });

  it('held token lookup settling (success, empty, or error) after same-user replacement does not resurrect sid-1 or clear sid-2', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2' });
    const harness = createFakeSessionHarness(session1, makeStandardHandlers());
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));

    const heldSuccess = createDeferred<{ data: { session: Session | null }; error: Error | null }>();
    const heldEmpty = createDeferred<{ data: { session: Session | null }; error: Error | null }>();
    const heldError = createDeferred<{ data: { session: Session | null }; error: Error | null }>();
    const pending = [heldSuccess.promise, heldEmpty.promise, heldError.promise];
    harness.setGetSessionHandler(() =>
      pending.length > 0
        ? pending.shift()!
        : Promise.resolve({ data: { session: session2 }, error: null }),
    );

    const fence1 = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    const staleRead = readWorkspaces(gate, { fence: fence1 });
    const staleLookupEmpty = gate.acquireAccessToken();
    const staleLookupErr = gate.acquireAccessToken();

    // Same user signs out and in again with sid-2; gate verifies sid-2 through shared currentSession().
    harness.emitAuthChange('SIGNED_OUT', null);
    harness.emitAuthChange('SIGNED_IN', session2);
    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');
    });
    const sid2LoginGen = gate.loginGeneration;

    // Now the three older lookups from sid-1 settle (old success, empty, and error).
    heldSuccess.resolve({ data: { session: session1 }, error: null });
    heldEmpty.resolve({ data: { session: null }, error: null });
    heldError.reject(new Error('stale getSession boom'));

    await expect(staleRead).rejects.toBeInstanceOf(StaleFenceError);
    expect(await staleLookupEmpty).toBeNull();
    expect(await staleLookupErr).toBeNull();

    // Zero stale wire requests; sid-2 remains intact and usable.
    expect(harness.wireCalls).toHaveLength(0);
    expect(gate.state).toEqual({ status: 'authenticated' });
    expect(gate.loginGeneration).toBe(sid2LoginGen);
    expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');

    // Legitimate successor sid-2 dispatches with sid-2 bearer.
    const fence2 = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    await readWorkspaces(gate, { fence: fence2 });
    expect(harness.wireCalls).toHaveLength(1);
    expect(harness.wireCalls[0]!.authHeader).toBe(`Bearer ${session2.access_token}`);

    gate.dispose();
  });

  it('held token lookup settling after multi-account closure is discarded and preview stays closed with quiesced client', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
    const peerStored = JSON.stringify(session1);
    const storage = createFakeStorage({ [storageKey]: peerStored });
    const harness = createFakeSessionHarness(session1, makeStandardHandlers());
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage,
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));

    const heldLookup = createDeferred<{ data: { session: Session | null }; error: Error | null }>();
    harness.setGetSessionHandler(() => heldLookup.promise);

    const fence = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    const readPromise = readWorkspaces(gate, { fence });

    // Peer enables multi-account in storage and fires storage event.
    const hash = deploymentOriginHash(DEPLOY_URL);
    const maKey = `commonswarm:accounts:v1:${hash}`;
    storage.setItem(maKey, '{"version":1,"accounts":[]}');
    const storageEv = new Event('storage');
    Object.defineProperty(storageEv, 'key', { value: maKey });
    Object.defineProperty(storageEv, 'newValue', { value: '{"version":1,"accounts":[]}' });
    Object.defineProperty(storageEv, 'storageArea', { value: storage });
    window.dispatchEvent(storageEv);

    expect(gate.state).toEqual({ status: 'closed', reason: 'multi_account_in_use' });
    expect(gate.client).toBeNull();
    expect(harness.quiesceCalls).toBe(1);
    expect(storage.getItem(storageKey)).toBe(peerStored);

    // Held lookup settles with valid session1 -> discarded, stays closed, zero wire requests.
    heldLookup.resolve({ data: { session: session1 }, error: null });
    await expect(readPromise).rejects.toBeInstanceOf(StaleFenceError);
    expect(gate.state).toEqual({ status: 'closed', reason: 'multi_account_in_use' });
    expect(harness.wireCalls).toHaveLength(0);

    gate.dispose();
  });

  it('held verification across sign-out, auth-callback same-user replacement, and multi-account closure never publishes stale or unverified login', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2' });
    const verify1 = createDeferred<Session | null>();
    const verify2 = createDeferred<Session | null>();
    let verifyCount = 0;

    const storage = createFakeStorage();
    const harness = createFakeSessionHarness(
      session1,
      makeStandardHandlers((auth) =>
        auth === `Bearer ${session2.access_token}` ? 'fresh-sid2' : 'old-sid1',
      ),
    );
    harness.setCurrentSessionHandler(() => {
      verifyCount += 1;
      if (verifyCount === 1) return verify1.promise;
      if (verifyCount === 2) return verify2.promise;
      return Promise.resolve(session2);
    });

    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage,
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    expect(gate.state).toEqual({ status: 'checking' });
    expect(verifyCount).toBe(1);

    // Same-user replacement arrives via SDK onAuthStateChange while verify1 is still held.
    // Auth callback MUST NOT adopt session2 directly; it must stay checking and start verify2.
    act(() => {
      harness.emitAuthChange('SIGNED_IN', session2);
    });
    expect(gate.state).toEqual({ status: 'checking' });
    expect(verifyCount).toBe(2);
    expect(harness.wireCalls).toHaveLength(0);

    // verify1 resolves late with old session1 -> discarded! Gate stays checking.
    await act(async () => {
      verify1.resolve(session1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(gate.state).toEqual({ status: 'checking' });
    expect(harness.wireCalls).toHaveLength(0);

    // Now verify2 settles with session2 -> publishes authenticated with sid-2 and paints sid-2 data.
    await act(async () => {
      verify2.resolve(session2);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText('fresh-sid2')).toBeInTheDocument();
    });
    expect(screen.queryByText('old-sid1')).not.toBeInTheDocument();
    expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');

    // Held verification across sign-out: start reverify, sign out before it settles -> stays signed_out.
    const verify3 = createDeferred<Session | null>();
    harness.setCurrentSessionHandler(() => verify3.promise);
    const reverifyPromise = gate.reverify();
    act(() => {
      harness.emitAuthChange('SIGNED_OUT', null);
    });
    expect(gate.state).toEqual({ status: 'signed_out' });
    const wireCountAtSignOut = harness.wireCalls.length;
    await act(async () => {
      verify3.resolve(session2);
      await reverifyPromise;
    });
    expect(gate.state).toEqual({ status: 'signed_out' });
    expect(harness.wireCalls.length).toBe(wireCountAtSignOut);

    // Re-running closed-gate checks at publication: multi-account appears silently before verification settles.
    const verify4 = createDeferred<Session | null>();
    harness.setCurrentSessionHandler(() => verify4.promise);
    const reverifyBeforeClose = gate.reverify();
    const hash = deploymentOriginHash(DEPLOY_URL);
    storage.setItem(`commonswarm:accounts:v1:${hash}`, '{}');
    await act(async () => {
      verify4.resolve(session2);
      await reverifyBeforeClose;
    });
    expect(gate.state).toEqual({ status: 'closed', reason: 'multi_account_in_use' });
    expect(harness.quiesceCalls).toBe(1);
    expect(screen.getByTestId('closed-screen')).toBeInTheDocument();

    controller.dispose();
    gate.dispose();
  });

  it('control: same-login token rotation preserves loginGeneration and cache and uses the rotated bearer', async () => {
    const token1 = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 'tok-1' });
    const token2 = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 'tok-2' });
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1', accessToken: token1 });
    const session1Rotated = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1', accessToken: token2 });

    const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
    const storage = createFakeStorage({ [storageKey]: JSON.stringify(session1) });
    const harness = createFakeSessionHarness(session1, makeStandardHandlers());
    const queryClient = createAppQueryClient();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage,
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate, queryClient);

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    const genBefore = gate.loginGeneration;

    const fence = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    await readWorkspaces(gate, { fence });
    expect(harness.wireCalls.at(-1)!.authHeader).toBe(`Bearer ${token1}`);

    // Rotate access token via both TOKEN_REFRESHED and storage event (same userId & sessionId).
    storage.setItem(storageKey, JSON.stringify(session1Rotated));
    harness.emitAuthChange('TOKEN_REFRESHED', session1Rotated);
    const storageEv = new Event('storage');
    Object.defineProperty(storageEv, 'key', { value: storageKey });
    Object.defineProperty(storageEv, 'newValue', { value: JSON.stringify(session1Rotated) });
    Object.defineProperty(storageEv, 'storageArea', { value: storage });
    window.dispatchEvent(storageEv);

    // Same loginGeneration, still authenticated, cache preserved, next read uses rotated bearer.
    expect(gate.state).toEqual({ status: 'authenticated' });
    expect(gate.loginGeneration).toBe(genBefore);

    await readWorkspaces(gate, { fence });
    expect(harness.wireCalls.at(-1)!.authHeader).toBe(`Bearer ${token2}`);

    controller.dispose();
    gate.dispose();
  });
});

describe('C2: fenced PostgREST wire transport against real pinned Supabase SDK 2.111.0', () => {
  const originalFetch = globalThis.fetch;
  const originalNavigatorLocks = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'locks',
  );

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
    if (originalNavigatorLocks) {
      Object.defineProperty(globalThis.navigator, 'locks', originalNavigatorLocks);
    } else {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
    vi.restoreAllMocks();
  });

  function installFakeWebLocks() {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: {
        async request(name: string, _opts: unknown, cb: (lock: { name: string }) => unknown) {
          return cb({ name });
        },
      },
    });
  }

  it('unchanged login control: real pinned SDK + wire spy sends exact acquired bearer (never anon key) on every PostgREST and Edge read', async () => {
    installFakeWebLocks();
    const token1 = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 'wire-1' });
    const session1 = makeFakeSession({
      userId: 'user-1',
      sessionId: 'sid-1',
      accessToken: token1,
    });
    const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...session1,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );

    // Mock GoTrue /auth/v1/user for real pinned createBrowserSession verification.
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'user-1', aud: 'authenticated' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected global fetch to ${url}`);
    }) as typeof fetch;

    const wireRequests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      apikey: string | null;
      profile: string | null;
    }> = [];

    const wireFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      wireRequests.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        authorization: headers.get('authorization'),
        apikey: headers.get('apikey'),
        profile: headers.get('accept-profile') ?? headers.get('content-profile'),
      });
      if (url.includes('/rest/v1/workspaces')) {
        return new Response(JSON.stringify([{ workspace_id: WS_1, name: 'Real Wire WS' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/v1/rpc/home_overview')) {
        return new Response(
          JSON.stringify({
            viewer_user_id: 'user-1',
            generated_at: '2026-11-23T12:00:00.000Z',
            workspaces: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/rpc/decision_queue')) {
        return new Response(
          JSON.stringify({
            workspace_id: WS_1,
            generated_at: '2026-11-23T12:00:00.000Z',
            total: 0,
            truncated: false,
            asks: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/rpc/waiting_todos_page')) {
        return new Response(
          JSON.stringify({
            workspace_id: WS_1,
            generated_at: '2026-11-23T12:00:00.000Z',
            total: 0,
            truncated: false,
            todos: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/functions/v1/read')) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: localStorage,
      createSession: createBrowserSession,
      sdk: {
        createClient,
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
      fetchImpl: wireFetch,
    });

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    gate.fenceTracker.setActiveWorkspace(WS_1);

    // Spy on client.auth.getSession to prove PostgREST reads call getSession ONCE (for acquireAccessToken),
    // never a second time inside SupabaseClient's fetchWithAuth transport.
    const getSessionSpy = vi.spyOn(gate.client!.auth, 'getSession');

    const loginFence = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    const wsFence = gate.fenceTracker.capture({ workspaceId: WS_1, conversationId: null });

    const workspaces = await readWorkspaces(gate, { fence: loginFence });
    expect(workspaces[0]!.name).toBe('Real Wire WS');
    expect(getSessionSpy).toHaveBeenCalledTimes(1);

    await readHomeOverview(gate, { fence: loginFence });
    await readAgentPrincipals(gate, WS_1, { fence: wsFence });
    await readAgentPresence(gate, WS_1, { fence: wsFence });
    await readAgentWakePath(gate, WS_1, { fence: wsFence });
    await readMemberProfiles(gate, WS_1, { fence: wsFence });
    await readDecisionQueue(gate, WS_1, { fence: wsFence });
    await readWaitingTodos(gate, WS_1, { fence: wsFence });
    await readConversations(gate, WS_1, { fence: wsFence });

    expect(wireRequests).toHaveLength(9);
    // Exactly 1 getSession() per read (never 2 via fetchWithAuth).
    expect(getSessionSpy).toHaveBeenCalledTimes(9);

    for (const req of wireRequests) {
      expect(req.authorization).toBe(`Bearer ${token1}`);
      expect(req.authorization).not.toBe(`Bearer ${ANON_KEY}`);
      expect(req.apikey).toBe(ANON_KEY);
      if (req.url.includes('/rest/v1/')) {
        expect(req.profile).toBe('swarm_read');
      }
    }

    gate.dispose();
  });

  it('real pinned SDK with held auth across login replacement and access retirement dispatches ZERO stale wire requests (including page 2 and wake-path fallback)', async () => {
    installFakeWebLocks();
    const token1 = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 't1' });
    const token2 = makeFakeJwt({ sub: 'user-1', session_id: 'sid-2', jti: 't2' });
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1', accessToken: token1 });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2', accessToken: token2 });
    const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...session1, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    );

    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'user-1', aud: 'authenticated' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected global fetch to ${url}`);
    }) as typeof fetch;

    const wireUrls: string[] = [];
    let wakePathAttempt = 0;
    const wireFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      wireUrls.push(url);
      if (url.includes('/rest/v1/workspaces')) {
        // Return a full page of 50 so readWorkspaces attempts page 2!
        const page = Array.from({ length: 50 }, (_, idx) => ({
          workspace_id: `11111111-1111-4111-8111-${String(idx).padStart(12, '0')}`,
          name: `WS ${idx}`,
        }));
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/v1/agent_wake_path')) {
        wakePathAttempt += 1;
        return new Response(JSON.stringify({ code: 'PGRST204', message: 'unseen_count missing' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: localStorage,
      createSession: createBrowserSession,
      sdk: {
        createClient,
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
      fetchImpl: wireFetch,
    });

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    gate.fenceTracker.setActiveWorkspace(WS_1);

    // 1. Held auth across workspace access retirement -> ZERO stale wire requests.
    const heldForRetirement = createDeferred<{ data: { session: Session }; error: null }>();
    const getSessionSpy = vi
      .spyOn(gate.client!.auth, 'getSession')
      .mockImplementationOnce(() => heldForRetirement.promise);

    const wsFence = gate.fenceTracker.capture({ workspaceId: WS_1, conversationId: null });
    const retiredRead = readDecisionQueue(gate, WS_1, { fence: wsFence });

    // Retire WS_1 while getSession is held.
    gate.fenceTracker.retireWorkspace(WS_1);
    heldForRetirement.resolve({ data: { session: session1 }, error: null });
    await expect(retiredRead).rejects.toBeInstanceOf(StaleFenceError);
    expect(wireUrls).toHaveLength(0);

    // 2. Wake-path fallback read: primary returns PGRST204, then WS_2 retires while fallback auth is held -> ZERO fallback wire request!
    gate.fenceTracker.setActiveWorkspace(WS_2);
    const ws2Fence = gate.fenceTracker.capture({ workspaceId: WS_2, conversationId: null });
    const heldFallbackAuth = createDeferred<{ data: { session: Session }; error: null }>();
    getSessionSpy
      .mockImplementationOnce(async () => ({ data: { session: session1 }, error: null }))
      .mockImplementationOnce(() => heldFallbackAuth.promise);

    const wakePromise = readAgentWakePath(gate, WS_2, { fence: ws2Fence });
    await waitFor(() => expect(wakePathAttempt).toBe(1));
    expect(wireUrls).toHaveLength(1);

    // Retire WS_2 before fallback auth settles.
    gate.fenceTracker.retireWorkspace(WS_2);
    heldFallbackAuth.resolve({ data: { session: session1 }, error: null });
    await expect(wakePromise).rejects.toBeInstanceOf(StaleFenceError);
    expect(wireUrls).toHaveLength(1);

    // 3. Paginated read (page 2) with held auth across login replacement (sid-1 -> sid-2) -> ZERO page-2 wire requests!
    wireUrls.length = 0;
    const loginFence1 = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    const heldPage2Auth = createDeferred<{ data: { session: Session }; error: null }>();
    getSessionSpy
      .mockImplementationOnce(async () => ({ data: { session: session1 }, error: null }))
      .mockImplementationOnce(() => heldPage2Auth.promise);

    const workspacesPromise = readWorkspaces(gate, { fence: loginFence1 });
    await waitFor(() => expect(wireUrls).toHaveLength(1));

    // Replace login in storage while page 2 auth is held.
    const nextStored = JSON.stringify({
      ...session2,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    localStorage.setItem(storageKey, nextStored);
    const storageEv = new Event('storage');
    Object.defineProperty(storageEv, 'key', { value: storageKey });
    Object.defineProperty(storageEv, 'newValue', { value: nextStored });
    Object.defineProperty(storageEv, 'storageArea', { value: localStorage });
    window.dispatchEvent(storageEv);

    heldPage2Auth.resolve({ data: { session: session1 }, error: null });
    await expect(workspacesPromise).rejects.toBeInstanceOf(StaleFenceError);
    expect(wireUrls).toHaveLength(1);

    // 4. API-key-as-bearer refusal: token matching anonKey never dispatches.
    const apiKeySession = makeFakeSession({
      userId: 'user-1',
      sessionId: 'sid-api',
      accessToken: ANON_KEY,
    });
    const fakeHarness = createFakeSessionHarness(apiKeySession);
    const apiKeyGate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => fakeHarness.browserSession,
      fetchImpl: fakeHarness.fetchImpl,
    });
    await waitFor(() => expect(apiKeyGate.state).toEqual({ status: 'signed_out' }));
    expect(await apiKeyGate.acquireAccessToken()).toBeNull();
    expect(fakeHarness.wireCalls).toHaveLength(0);

    apiKeyGate.dispose();
    gate.dispose();
  });
});
