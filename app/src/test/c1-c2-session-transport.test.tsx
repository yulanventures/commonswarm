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
  SessionExpired,
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

describe('C1 (round 2): pinned SDK final teardown after pending initialization + peer usability', () => {
  const originalFetch = globalThis.fetch;
  const originalNavigatorLocks = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'locks',
  );
  const originalVisibilityState = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState',
  );

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
    if (originalNavigatorLocks) {
      Object.defineProperty(globalThis.navigator, 'locks', originalNavigatorLocks);
    } else {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
    if (originalVisibilityState) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityState);
    } else {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
    vi.restoreAllMocks();
  });

  function setVisibilityState(value: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => value,
    });
  }

  function createSharedMutexLocks() {
    const queues = new Map<string, Promise<void>>();
    const heldNames = new Set<string>();
    const acquisitions: Array<{ name: string; ifAvailable: boolean }> = [];

    const locks = {
      async request<T>(
        name: string,
        optsOrCb:
          | { ifAvailable?: boolean; signal?: AbortSignal }
          | ((lock: { name: string } | null) => Promise<T> | T),
        maybeCb?: (lock: { name: string } | null) => Promise<T> | T,
      ): Promise<T> {
        const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
        acquisitions.push({ name, ifAvailable: Boolean(opts.ifAvailable) });

        if (opts.ifAvailable && heldNames.has(name)) {
          return await cb(null);
        }

        const prev = queues.get(name) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((r) => {
          release = r;
        });
        queues.set(name, next);

        await prev;
        heldNames.add(name);
        try {
          return await cb({ name });
        } finally {
          heldNames.delete(name);
          release();
        }
      },
    };

    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: locks,
    });

    return { locks, acquisitions, heldNames };
  }

  function trackListenersAndTimers() {
    const activeWindowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const activeIntervals = new Set<unknown>();
    const activeTimeouts = new Set<unknown>();

    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    const origSetInterval = globalThis.setInterval.bind(globalThis);
    const origClearInterval = globalThis.clearInterval.bind(globalThis);
    const origSetTimeout = globalThis.setTimeout.bind(globalThis);
    const origClearTimeout = globalThis.clearTimeout.bind(globalThis);

    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) {
        let bucket = activeWindowListeners.get(type);
        if (!bucket) {
          bucket = new Set();
          activeWindowListeners.set(type, bucket);
        }
        bucket.add(listener);
      }
      return origAdd(type, listener, options);
    });

    vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (listener) {
        activeWindowListeners.get(type)?.delete(listener);
      }
      return origRemove(type, listener, options);
    });

    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const id = origSetInterval(handler, timeout, ...args);
      activeIntervals.add(id);
      return id;
    }) as typeof setInterval);

    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      id: unknown,
    ) => {
      if (id !== undefined) activeIntervals.delete(id);
      return origClearInterval(id as ReturnType<typeof setInterval>);
    }) as typeof clearInterval);

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      let id: unknown;
      const wrapped: TimerHandler =
        typeof handler === 'function'
          ? (...cbArgs: unknown[]) => {
              activeTimeouts.delete(id);
              return (handler as (...a: unknown[]) => unknown)(...cbArgs);
            }
          : handler;
      id = origSetTimeout(wrapped, timeout, ...args);
      activeTimeouts.add(id);
      return id;
    }) as typeof setTimeout);

    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      id: unknown,
    ) => {
      if (id !== undefined) activeTimeouts.delete(id);
      return origClearTimeout(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout);

    return {
      activeWindowListeners,
      activeIntervals,
      activeTimeouts,
      visibilityListenerCount: () =>
        activeWindowListeners.get('visibilitychange')?.size ?? 0,
      storageListenerCount: () => activeWindowListeners.get('storage')?.size ?? 0,
    };
  }

  it('closing while _initialize() refresh is held leaves zero visibility listeners, zero timers, zero post-quiesce auth fetches/locks, and peer tab remains usable', async () => {
    setVisibilityState('visible');
    const sharedLocks = createSharedMutexLocks();
    const tracker = trackListenersAndTimers();

    const expiredToken = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 'exp-1' });
    const rotatedToken = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 'rot-2' });
    const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
    const initialStored = JSON.stringify({
      access_token: expiredToken,
      refresh_token: 'rt-initial',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      token_type: 'bearer',
      user: { id: 'user-1', aud: 'authenticated' },
    });
    localStorage.setItem(storageKey, initialStored);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');

    const initRefreshStarted = createDeferred<void>();
    const releaseInitRefresh = createDeferred<void>();
    let initSignalAborted = false;
    let authFetchCount = 0;

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      authFetchCount += 1;
      if (url.includes('/auth/v1/token') && authFetchCount === 1) {
        initSignalAborted = Boolean(init?.signal?.aborted);
        init?.signal?.addEventListener('abort', () => {
          initSignalAborted = true;
        });
        initRefreshStarted.resolve();
        await releaseInitRefresh.promise;
        // Simulate a transport that resolves with rotated tokens despite abort.
        return new Response(
          JSON.stringify({
            access_token: 'at-from-aborted-tabA',
            refresh_token: 'rt-from-aborted-tabA',
            expires_in: 3600,
            token_type: 'bearer',
            user: { id: 'user-1', aud: 'authenticated' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/auth/v1/token')) {
        return new Response(
          JSON.stringify({
            access_token: rotatedToken,
            refresh_token: 'rt-peer-rotated',
            expires_in: 3600,
            token_type: 'bearer',
            user: { id: 'user-1', aud: 'authenticated' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'user-1', aud: 'authenticated' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const tabA = createBrowserSession({
      url: DEPLOY_URL,
      anonKey: ANON_KEY,
      detectSessionInUrl: false,
      allowProcessLockFallback: false,
      sdk: {
        createClient,
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
    });
    expect(tabA.ok).toBe(true);
    if (!tabA.ok) return;

    // Baseline listeners added synchronously by SupabaseClient's unconnected Phoenix Realtime Socket
    // constructor (not GoTrueClient auth). Track every auth visibilitychange listener added afterwards.
    const realtimeBaselineListeners = new Set(
      tracker.activeWindowListeners.get('visibilitychange') ?? [],
    );
    const activeAuthVisibilityListeners = () =>
      [...(tracker.activeWindowListeners.get('visibilitychange') ?? [])].filter(
        (fn) => !realtimeBaselineListeners.has(fn),
      ).length;

    // Wait until Tab A's constructor _initialize() enters the refresh fetch under the Web Lock.
    await initRefreshStarted.promise;
    expect(sharedLocks.heldNames.has(`lock:${storageKey}`)).toBe(true);

    // Quiesce Tab A while _initialize() is held (BEFORE _initialize()'s finally runs _handleVisibilityChange).
    const quiesceDone = tabA.quiesce();
    expect(initSignalAborted).toBe(true);

    // Release the held refresh fetch so _initialize() unwinds through finally -> _handleVisibilityChange().
    releaseInitRefresh.resolve();
    await quiesceDone;

    // Immediately after quiesce() resolves, Tab A must have ZERO attached auth listeners and ZERO timers,
    // and the shared Web Lock must already be released.
    expect(sharedLocks.heldNames.has(`lock:${storageKey}`)).toBe(false);
    expect(activeAuthVisibilityListeners()).toBe(0);
    expect(
      (tabA.client.auth as unknown as { visibilityChangedCallback?: unknown })
        .visibilityChangedCallback,
    ).toBeNull();
    expect(tracker.storageListenerCount()).toBe(0);
    expect(tracker.activeIntervals.size).toBe(0);
    expect(tracker.activeTimeouts.size).toBe(0);

    // Tab A wrote/removed ZERO auth entries in localStorage (peer credentials untouched).
    const authWritesByTabA = setItemSpy.mock.calls.filter(
      ([k]) => !String(k).startsWith('commonswarm-storage-'),
    );
    const authRemovalsByTabA = removeItemSpy.mock.calls.filter(
      ([k]) => !String(k).startsWith('commonswarm-storage-'),
    );
    expect(authWritesByTabA).toHaveLength(0);
    expect(authRemovalsByTabA).toHaveLength(0);
    expect(localStorage.getItem(storageKey)).toBe(initialStored);

    // Record counts after quiesce, then drive visibility transitions and macrotask turns.
    const fetchesAfterQuiesce = authFetchCount;
    const locksAfterQuiesce = sharedLocks.acquisitions.length;

    setVisibilityState('hidden');
    window.dispatchEvent(new Event('visibilitychange'));
    setVisibilityState('visible');
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 25));

    expect(authFetchCount).toBe(fetchesAfterQuiesce);
    expect(sharedLocks.acquisitions.length).toBe(locksAfterQuiesce);
    expect(activeAuthVisibilityListeners()).toBe(0);
    expect(tracker.activeIntervals.size).toBe(0);

    // Two-tab peer proof: a peer tab (/app) using the same storage and shared Web Locks
    // cleanly acquires the lock, refreshes the expired session, verifies, and persists rotated credentials.
    const tabB = createBrowserSession({
      url: DEPLOY_URL,
      anonKey: ANON_KEY,
      detectSessionInUrl: true,
      allowProcessLockFallback: true,
      sdk: {
        createClient,
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
    });
    expect(tabB.ok).toBe(true);
    if (!tabB.ok) return;

    const peerSession = await tabB.verifiedSession();
    expect(peerSession?.access_token).toBe(rotatedToken);
    expect(peerSession?.refresh_token).toBe('rt-peer-rotated');
    expect(localStorage.getItem(storageKey)).toContain(rotatedToken);

    await tabB.quiesce();
    expect(
      (tabB.client.auth as unknown as { visibilityChangedCallback?: unknown })
        .visibilityChangedCallback,
    ).toBeNull();
    expect(tracker.activeIntervals.size).toBe(0);
  });

  it('closing while _initialize() is queued behind a peer Web Lock cleans up late _handleVisibilityChange() with zero leaked listeners, timers, fetches, or lock acquisitions', async () => {
    setVisibilityState('visible');
    const sharedLocks = createSharedMutexLocks();
    const tracker = trackListenersAndTimers();

    const validToken = makeFakeJwt({ sub: 'user-1', session_id: 'sid-1', jti: 'ok-1' });
    const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
    const stored = JSON.stringify({
      access_token: validToken,
      refresh_token: 'rt-1',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'user-1', aud: 'authenticated' },
    });
    localStorage.setItem(storageKey, stored);

    let fetchCount = 0;
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetchCount += 1;
      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'user-1', aud: 'authenticated' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    // Peer holds the shared Web Lock before Tab A is created.
    const peerLockEntered = createDeferred<void>();
    const releasePeerLock = createDeferred<void>();
    const peerWork = sharedLocks.locks.request(`lock:${storageKey}`, {}, async () => {
      peerLockEntered.resolve();
      await releasePeerLock.promise;
    });
    await peerLockEntered.promise;

    const tabA = createBrowserSession({
      url: DEPLOY_URL,
      anonKey: ANON_KEY,
      detectSessionInUrl: false,
      allowProcessLockFallback: false,
      sdk: {
        createClient,
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
    });
    expect(tabA.ok).toBe(true);
    if (!tabA.ok) return;

    const realtimeBaselineListeners = new Set(
      tracker.activeWindowListeners.get('visibilitychange') ?? [],
    );
    const activeAuthVisibilityListeners = () =>
      [...(tracker.activeWindowListeners.get('visibilitychange') ?? [])].filter(
        (fn) => !realtimeBaselineListeners.has(fn),
      ).length;

    // Wait one microtask so Tab A's constructor `_initialize()` passes `navigatorLock`'s
    // leading `await Promise.resolve()` (`locks.js:102`) and is actively queued on the peer's Web Lock.
    await Promise.resolve();
    expect(sharedLocks.acquisitions.length).toBe(2);

    // Quiesce Tab A BEFORE peer releases the lock, so Tab A's _initialize() runs entirely after quiesce() starts.
    const quiesceDone = tabA.quiesce();
    const lockCountAtQuiesce = sharedLocks.acquisitions.length;
    releasePeerLock.resolve();
    await peerWork;
    await quiesceDone;

    expect(sharedLocks.heldNames.has(`lock:${storageKey}`)).toBe(false);
    // Zero NEW shared lock acquisitions after quiesce() started (including from onAuthStateChange IIFEs).
    expect(sharedLocks.acquisitions.length).toBe(lockCountAtQuiesce);
    expect(activeAuthVisibilityListeners()).toBe(0);
    expect(
      (tabA.client.auth as unknown as { visibilityChangedCallback?: unknown })
        .visibilityChangedCallback,
    ).toBeNull();
    expect(tracker.storageListenerCount()).toBe(0);
    expect(tracker.activeIntervals.size).toBe(0);
    expect(tracker.activeTimeouts.size).toBe(0);
    expect(fetchCount).toBe(0);
    expect(localStorage.getItem(storageKey)).toBe(stored);

    setVisibilityState('hidden');
    window.dispatchEvent(new Event('visibilitychange'));
    setVisibilityState('visible');
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 25));

    expect(sharedLocks.acquisitions.length).toBe(lockCountAtQuiesce);
    expect(fetchCount).toBe(0);
    expect(activeAuthVisibilityListeners()).toBe(0);
    expect(tracker.activeIntervals.size).toBe(0);
  });
});

describe('C2 (round 2): late terminal 401 refusals are scoped to their captured login lifetime across PostgREST and Edge', () => {
  it('terminal 401 refusal held across peer sign-out + re-sign-in as another user leaves successor state and pending verification untouched (PostgREST and Edge)', async () => {
    const sessionUser1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-u1' });
    const sessionUser2 = makeFakeSession({ userId: 'user-2', sessionId: 'sid-u2' });

    const heldPgBody = createDeferred<string>();
    const heldEdgeResp = createDeferred<Response>();

    let activeHandlersMode: 'hold-u1-401' | 'ok-u2' = 'hold-u1-401';
    const harness = createFakeSessionHarness(sessionUser1, makeStandardHandlers());
    const customFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (activeHandlersMode === 'hold-u1-401') {
        if (url.includes('/rest/v1/workspaces')) {
          // Return a 401 session_not_found whose body `.text()` is held across the retirement gap.
          return {
            ok: false,
            status: 401,
            text: () => heldPgBody.promise,
          } as unknown as Response;
        }
        if (url.includes('/functions/v1/read')) {
          return heldEdgeResp.promise;
        }
      }
      return harness.fetchImpl(input, init);
    };

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: customFetch,
    });
    const queryClient = createAppQueryClient();
    const controller = createDataController(gate, queryClient);

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    expect(gate.userId).toBe('user-1');

    const verifiedSpy = vi.spyOn(harness.browserSession, 'verifiedSession');
    gate.fenceTracker.setActiveWorkspace(WS_1);
    const fenceUser1 = gate.fenceTracker.capture({ workspaceId: WS_1, conversationId: null });
    const loginFenceUser1 = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });

    // Launch both PostgREST and Edge reads under user-1; both will receive terminal 401s.
    const pgRead = readWorkspaces(gate, { fence: loginFenceUser1 });
    const edgeRead = readConversations(gate, WS_1, { fence: fenceUser1 });

    // Wait for both reads to reach the network layer.
    await Promise.resolve();
    await Promise.resolve();

    // Hold successor user-2's verification so we verify the old 401 does not kill pending verification.
    const user2Verify = createDeferred<Session | null>();
    harness.setCurrentSessionHandler(() => user2Verify.promise);
    activeHandlersMode = 'ok-u2';

    // Peer signs out user-1 and signs in user-2 -> gate enters `checking` for user-2.
    harness.emitAuthChange('SIGNED_OUT', null);
    harness.emitAuthChange('SIGNED_IN', sessionUser2);
    expect(gate.state).toEqual({ status: 'checking' });
    const checkingGen = gate.loginGeneration;

    // Release BOTH old user-1 terminal refusals WHILE user-2's verification is still pending.
    heldPgBody.resolve(JSON.stringify({ code: 'session_not_found', message: 'Session ended' }));
    heldEdgeResp.resolve(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(pgRead).rejects.toBeInstanceOf(StaleFenceError);
    await expect(edgeRead).rejects.toBeInstanceOf(StaleFenceError);

    // Direct call with retired fence while successor is checking is also a no-op.
    expect(gate.handleUnauthorized(loginFenceUser1)).toBe(false);

    // Successor's pending verification was NOT invalidated or forced to signed_out.
    expect(gate.state).toEqual({ status: 'checking' });
    expect(gate.loginGeneration).toBe(checkingGen);
    expect(verifiedSpy).not.toHaveBeenCalled();

    // Complete user-2 verification -> publishes authenticated cleanly.
    user2Verify.resolve(sessionUser2);
    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.userId).toBe('user-2');
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-u2');
    });
    const user2Gen = gate.loginGeneration;

    // Direct call with retired fence AFTER user-2 is authenticated also changes nothing.
    expect(gate.handleUnauthorized(loginFenceUser1)).toBe(false);
    expect(gate.state).toEqual({ status: 'authenticated' });
    expect(gate.userId).toBe('user-2');
    expect(gate.loginGeneration).toBe(user2Gen);
    expect(verifiedSpy).not.toHaveBeenCalled();

    controller.dispose();
    gate.dispose();
  });

  it('terminal 401 refusal held across same-person replacement (sid-1 -> sid-2) leaves successor state and verification untouched (PostgREST and Edge)', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2' });

    const heldPgResp = createDeferred<Response>();
    const heldEdgeResp = createDeferred<Response>();
    const heldPgBodyAfterAuth = createDeferred<string>();
    const heldEdgeAfterAuth = createDeferred<Response>();
    let pgCount = 0;
    let edgeCount = 0;

    const harness = createFakeSessionHarness(session1, makeStandardHandlers());
    const customFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/rest/v1/workspaces')) {
        pgCount += 1;
        if (pgCount === 1) return heldPgResp.promise;
        if (pgCount === 2) {
          return {
            ok: false,
            status: 401,
            text: () => heldPgBodyAfterAuth.promise,
          } as unknown as Response;
        }
      }
      if (url.includes('/functions/v1/read')) {
        edgeCount += 1;
        if (edgeCount === 1) return heldEdgeResp.promise;
        if (edgeCount === 2) return heldEdgeAfterAuth.promise;
      }
      return harness.fetchImpl(input, init);
    };

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: customFetch,
    });

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    const verifiedSpy = vi.spyOn(harness.browserSession, 'verifiedSession');
    gate.fenceTracker.setActiveWorkspace(WS_1);
    const loginFence1 = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    const wsFence1 = gate.fenceTracker.capture({ workspaceId: WS_1, conversationId: null });

    const pgWhilePending = readWorkspaces(gate, { fence: loginFence1 });
    const edgeWhilePending = readConversations(gate, WS_1, { fence: wsFence1 });
    const pgAfterAuth = readWorkspaces(gate, { fence: loginFence1 });
    const edgeAfterAuth = readConversations(gate, WS_1, { fence: wsFence1 });

    await waitFor(() => {
      expect(pgCount).toBe(2);
      expect(edgeCount).toBe(2);
    });

    // Same user replaces login (sid-1 -> sid-2); hold sid-2 verification.
    const sid2Verify = createDeferred<Session | null>();
    harness.setCurrentSessionHandler(() => sid2Verify.promise);
    harness.emitAuthChange('SIGNED_IN', session2);
    expect(gate.state).toEqual({ status: 'checking' });

    // Release first pair while sid-2 verification is still pending.
    heldPgResp.resolve(
      new Response(JSON.stringify({ code: 'session_not_found', message: 'ended' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    heldEdgeResp.resolve(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(pgWhilePending).rejects.toBeInstanceOf(StaleFenceError);
    await expect(edgeWhilePending).rejects.toBeInstanceOf(StaleFenceError);
    expect(gate.state).toEqual({ status: 'checking' });
    expect(verifiedSpy).not.toHaveBeenCalled();

    // Let sid-2 verify and become authenticated.
    sid2Verify.resolve(session2);
    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');
    });
    const sid2Gen = gate.loginGeneration;

    // Release second pair AFTER sid-2 is authenticated.
    heldPgBodyAfterAuth.resolve(JSON.stringify({ code: 'session_not_found', message: 'ended' }));
    heldEdgeAfterAuth.resolve(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(pgAfterAuth).rejects.toBeInstanceOf(StaleFenceError);
    await expect(edgeAfterAuth).rejects.toBeInstanceOf(StaleFenceError);

    expect(gate.state).toEqual({ status: 'authenticated' });
    expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');
    expect(gate.loginGeneration).toBe(sid2Gen);
    expect(verifiedSpy).not.toHaveBeenCalled();

    gate.dispose();
  });

  it('control: terminal 401 refusal for the CURRENT login still retires it, purges state, and triggers locked verification (PostgREST and Edge)', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2' });

    const harness = createFakeSessionHarness(session1, {
      ...makeStandardHandlers(),
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: null,
            error: { code: 'session_not_found', message: 'Session ended' },
            status: 401,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onFetch() {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    const verifiedSpy = vi.spyOn(harness.browserSession, 'verifiedSession');
    queryClient.setQueryData(['probe'], { secret: true });

    // 1. PostgREST current-login 401 + session_not_found retires immediately.
    const pgFence = gate.fenceTracker.capture({ workspaceId: null, conversationId: null });
    await expect(readWorkspaces(gate, { fence: pgFence })).rejects.toBeInstanceOf(
      SessionExpired,
    );
    expect(gate.state).toEqual({ status: 'signed_out' });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(verifiedSpy).toHaveBeenCalledTimes(1);

    // Re-authenticate with session2 to test Edge current-login 401 control.
    harness.emitAuthChange('SIGNED_IN', session2);
    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');
    });
    queryClient.setQueryData(['probe-2'], { secret: true });
    gate.fenceTracker.setActiveWorkspace(WS_1);
    const edgeFence = gate.fenceTracker.capture({ workspaceId: WS_1, conversationId: null });

    // 2. Edge current-login 401 retires immediately.
    await expect(
      readConversations(gate, WS_1, { fence: edgeFence }),
    ).rejects.toBeInstanceOf(SessionExpired);
    expect(gate.state).toEqual({ status: 'signed_out' });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(verifiedSpy).toHaveBeenCalledTimes(2);

    controller.dispose();
    gate.dispose();
  });
});
