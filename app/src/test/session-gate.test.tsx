import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthRecoveryRequired,
  SessionExpired,
  deploymentOriginHash,
} from '../../../shared/browser-session/index.js';
import { AppRoutes } from '../App';
import { readConversations, readWorkspaces } from '../data/api';
import { StaleFenceError } from '../data/fence';
import { createDataController } from '../data/queries';
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

describe('Session gate fail-closed states', () => {
  it('not configured -> sample data, creates no client, issues zero requests', () => {
    const createSession = vi.fn();
    const fetchImpl = vi.fn();
    const gate = createSessionGate({
      runtimeConfig: { status: 'not_configured' },
      createSession,
      fetchImpl,
    });
    const controller = createDataController(gate);

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    expect(gate.state).toEqual({ status: 'sample' });
    expect(gate.client).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByTestId('sample-data-marker')).toHaveTextContent(
      'Sample data',
    );
    controller.dispose();
    gate.dispose();
  });

  it('Web Locks unavailable -> closed screen with /app link, no client, zero requests', () => {
    const createSession = vi.fn();
    const fetchImpl = vi.fn();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => false,
      storage: createFakeStorage(),
      createSession,
      fetchImpl,
    });
    const controller = createDataController(gate);

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    expect(gate.state).toEqual({ status: 'closed', reason: 'locks_unavailable' });
    expect(gate.client).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const closed = screen.getByTestId('closed-screen');
    expect(closed).toHaveAttribute('data-closed-reason', 'locks_unavailable');
    expect(screen.getByRole('link', { name: 'Open CommonSwarm' })).toHaveAttribute(
      'href',
      '/app',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    controller.dispose();
    gate.dispose();
  });

  it('multi-account build flag on -> closed screen, no client, zero requests', () => {
    const createSession = vi.fn();
    const fetchImpl = vi.fn();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: true,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession,
      fetchImpl,
    });
    const controller = createDataController(gate);

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    expect(gate.state).toEqual({ status: 'closed', reason: 'multi_account_flag' });
    expect(gate.client).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByTestId('closed-screen')).toHaveAttribute(
      'data-closed-reason',
      'multi_account_flag',
    );
    expect(screen.getByRole('link', { name: 'Open CommonSwarm' })).toHaveAttribute(
      'href',
      '/app',
    );

    controller.dispose();
    gate.dispose();
  });

  it('multi-account probe returns in_use -> closed screen, no client, zero requests', () => {
    const createSession = vi.fn();
    const fetchImpl = vi.fn();
    const hash = deploymentOriginHash(DEPLOY_URL);
    const storage = createFakeStorage({
      [`commonswarm:accounts:v1:${hash}`]: '{"version":1,"accounts":[]}',
    });
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage,
      createSession,
      fetchImpl,
    });
    const controller = createDataController(gate);

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    expect(gate.state).toEqual({ status: 'closed', reason: 'multi_account_in_use' });
    expect(gate.client).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByTestId('closed-screen')).toHaveAttribute(
      'data-closed-reason',
      'multi_account_in_use',
    );

    controller.dispose();
    gate.dispose();
  });

  it('multi-account probe returns unknown -> closed screen, no client, zero requests', () => {
    const createSession = vi.fn();
    const fetchImpl = vi.fn();
    const throwingStorage = {
      get length(): number {
        throw new Error('storage denied');
      },
      key(): string | null {
        return null;
      },
    };
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: throwingStorage,
      createSession,
      fetchImpl,
    });
    const controller = createDataController(gate);

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    expect(gate.state).toEqual({
      status: 'closed',
      reason: 'multi_account_unknown',
    });
    expect(gate.client).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByTestId('closed-screen')).toHaveAttribute(
      'data-closed-reason',
      'multi_account_unknown',
    );

    controller.dispose();
    gate.dispose();
  });

  it('signed out (no stored session) -> renders single signed-out screen with /app link and issues zero data requests', async () => {
    const harness = createFakeSessionHarness(null);
    const createSession = vi.fn(() => harness.browserSession);
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate);

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('signed-out-screen')).toBeInTheDocument();
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        detectSessionInUrl: false,
        allowProcessLockFallback: false,
      }),
    );
    expect(gate.state).toEqual({ status: 'signed_out' });
    expect(gate.userId).toBeNull();
    expect(harness.postgrestCalls).toHaveLength(0);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Open CommonSwarm' })).toHaveAttribute(
      'href',
      '/app',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    controller.dispose();
    gate.dispose();
  });

  it('unreadable session_id claim fails closed to signed_out and never falls back to a prior bearer', async () => {
    const badToken = makeFakeJwt({ sub: 'user-1', aud: 'authenticated' }); // missing session_id
    const badSession = makeFakeSession({
      userId: 'user-1',
      sessionId: 'ignored',
      accessToken: badToken,
    });
    const harness = createFakeSessionHarness(badSession);
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });

    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'signed_out' });
    });
    expect(gate.userId).toBeNull();
    expect(await gate.acquireAccessToken()).toBeNull();

    gate.dispose();
  });

  it('fence that goes stale between token acquisition and dispatch sends zero requests', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const harness = createFakeSessionHarness(session1);
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });

    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'authenticated' });
    });

    gate.fenceTracker.setActiveWorkspace('ws-1');
    const capturedFence = gate.fenceTracker.capture({
      workspaceId: 'ws-1',
      conversationId: null,
    });

    // Hold token acquisition; invalidate the fence BEFORE token acquisition resolves.
    const tokenDeferred = createDeferred<{
      data: { session: typeof session1 | null };
      error: Error | null;
    }>();
    harness.setGetSessionHandler(() => tokenDeferred.promise);

    const convPromise = readConversations(gate, 'ws-1', { fence: capturedFence });
    const wsPromise = readWorkspaces(gate, { fence: capturedFence });

    // Switch workspace (or retire it) while token acquisition is pending.
    gate.fenceTracker.setActiveWorkspace('ws-2');

    // Now token acquisition resolves with the valid token.
    tokenDeferred.resolve({ data: { session: session1 }, error: null });

    await expect(convPromise).rejects.toBeInstanceOf(StaleFenceError);
    await expect(wsPromise).rejects.toBeInstanceOf(StaleFenceError);

    // Zero HTTP / PostgREST requests dispatched.
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.postgrestCalls).toHaveLength(0);

    gate.dispose();
  });
});

describe('Session gate recovery timeout vs genuine sign-out', () => {
  it('AuthRecoveryRequired stays closed (not signed_out, no private view), retries, and authenticates on recovery [fails until the refresh-stall fix]', async () => {
    vi.useFakeTimers();
    const validSession = makeFakeSession({ userId: 'user-1', sessionId: 'sid-recovered' });
    const harness = createFakeSessionHarness(null);
    let attempts = 0;
    harness.setCurrentSessionHandler(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new AuthRecoveryRequired();
      }
      harness.setSession(validSession);
      return validSession;
    });

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harness.browserSession,
      fetchImpl: harness.fetchImpl,
    });
    const controller = createDataController(gate);

    try {
      render(
        <MemoryRouter initialEntries={['/agents/atlas']}>
          <AppRoutes controller={controller} />
        </MemoryRouter>,
      );

      // Flush the first currentSession() rejection (AuthRecoveryRequired).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(attempts).toBe(1);
      expect(gate.state.status).not.toBe('signed_out');
      expect(gate.state.status).not.toBe('authenticated');
      expect(gate.state.status).not.toBe('sample');
      expect(screen.queryByTestId('signed-out-screen')).not.toBeInTheDocument();
      expect(screen.queryByTestId('private-view-root')).not.toBeInTheDocument();
      expect(gate.userId).toBeNull();
      expect(harness.fetchCalls).toHaveLength(0);
      expect(harness.postgrestCalls).toHaveLength(0);

      // Allow the gate's retry to run and observe the now-resolving session.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.userId).toBe('user-1');
      expect(screen.queryByTestId('signed-out-screen')).not.toBeInTheDocument();
      expect(screen.getByTestId('private-view-root')).toBeInTheDocument();
    } finally {
      controller.dispose();
      gate.dispose();
      vi.useRealTimers();
    }
  });

  it('control: genuine SessionExpired rejection and missing session still fail closed to signed_out', async () => {
    for (const mode of ['expired', 'missing'] as const) {
      const harness = createFakeSessionHarness(null);
      harness.setCurrentSessionHandler(async () => {
        if (mode === 'expired') {
          throw new SessionExpired();
        }
        return null;
      });

      const gate = createSessionGate({
        runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
        multiAccountEnabled: false,
        hasWebLocks: () => true,
        storage: createFakeStorage(),
        createSession: () => harness.browserSession,
        fetchImpl: harness.fetchImpl,
      });
      const controller = createDataController(gate);

      const { unmount } = render(
        <MemoryRouter initialEntries={['/agents/atlas']}>
          <AppRoutes controller={controller} />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('signed-out-screen')).toBeInTheDocument();
      });
      expect(gate.state).toEqual({ status: 'signed_out' });
      expect(gate.userId).toBeNull();
      expect(screen.queryByTestId('private-view-root')).not.toBeInTheDocument();
      expect(harness.fetchCalls).toHaveLength(0);
      expect(harness.postgrestCalls).toHaveLength(0);

      unmount();
      controller.dispose();
      gate.dispose();
    }
  });
});
