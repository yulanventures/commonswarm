import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('unsupported SDK instance -> closed screen with unsupported_sdk reason, no client, zero requests', () => {
    const createSession = vi.fn(() => ({
      ok: false as const,
      reason: 'unsupported_sdk' as const,
    }));
    const fetchImpl = vi.fn();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
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

    expect(gate.state).toEqual({ status: 'closed', reason: 'unsupported_sdk' });
    expect(gate.client).toBeNull();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    const closed = screen.getByTestId('closed-screen');
    expect(closed).toHaveAttribute('data-closed-reason', 'unsupported_sdk');
    expect(closed).toHaveTextContent('Sign-in could not be checked in this build.');
    expect(screen.getByRole('link', { name: 'Open CommonSwarm' })).toHaveAttribute(
      'href',
      '/app',
    );

    controller.dispose();
    gate.dispose();
  });

  it('factory locks_unavailable failure preserves previous locks_unavailable closed reason', () => {
    const createSession = vi.fn(() => ({
      ok: false as const,
      reason: 'locks_unavailable' as const,
    }));
    const fetchImpl = vi.fn();
    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
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

    expect(gate.state).toEqual({ status: 'closed', reason: 'locks_unavailable' });
    expect(gate.client).toBeNull();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByTestId('closed-screen')).toHaveAttribute(
      'data-closed-reason',
      'locks_unavailable',
    );

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
  it('AuthRecoveryRequired stays closed (not signed_out, no private view), retries, and authenticates on recovery', async () => {
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
      expect(gate.state.status).toBe('recovery');
      expect(screen.getByTestId('session-recovery-screen')).toBeInTheDocument();
      expect(screen.getByText("Couldn't check your sign-in.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
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
      expect(screen.queryByTestId('session-recovery-screen')).not.toBeInTheDocument();
      expect(screen.getByTestId('private-view-root')).toBeInTheDocument();
    } finally {
      controller.dispose();
      gate.dispose();
      vi.useRealTimers();
    }
  });

  it('entering recovery state purges private data and outstanding reads synchronously, and Try again button recovers', async () => {
    vi.useFakeTimers();
    const initialSession = makeFakeSession({ userId: 'user-1', sessionId: 'sid-live-1' });
    const harness = createFakeSessionHarness(initialSession);
    let mode: 'ok' | 'recovery' = 'ok';
    let retryAfterTs = 0;

    harness.setCurrentSessionHandler(async () => {
      if (mode === 'recovery') {
        throw new AuthRecoveryRequired(retryAfterTs);
      }
      harness.setSession(initialSession);
      return initialSession;
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
    const purgeEvents: Array<{ gen: number; statusAtPurge: string }> = [];
    gate.onLoginPurge((gen) => {
      purgeEvents.push({ gen, statusAtPurge: gate.state.status });
    });

    try {
      render(
        <MemoryRouter initialEntries={['/agents/atlas']}>
          <AppRoutes controller={controller} />
        </MemoryRouter>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(screen.getByTestId('private-view-root')).toBeInTheDocument();

      // Track an in-flight private operation and verify entering recovery aborts it synchronously.
      let abortedSynchronously = false;
      const pendingFence = gate.fenceTracker.capture({
        workspaceId: null,
        conversationId: null,
      });
      const pendingOp = controller.runFenced(
        pendingFence,
        undefined,
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              abortedSynchronously = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      pendingOp.catch(() => undefined);

      const purgesBefore = purgeEvents.length;
      const loginGenBefore = gate.loginGeneration;
      mode = 'recovery';
      retryAfterTs = Date.now() + 5_000;

      // Trigger reverify -> rejects with AuthRecoveryRequired(retryAfter).
      await act(async () => {
        await gate.reverify();
      });

      expect(gate.state.status).toBe('recovery');
      expect(gate.loginGeneration).toBeGreaterThan(loginGenBefore);
      expect(purgeEvents.length).toBe(purgesBefore + 1);
      expect(purgeEvents.at(-1)?.statusAtPurge).toBe('recovery');
      expect(abortedSynchronously).toBe(true);
      expect(gate.userId).toBeNull();
      expect(screen.queryByTestId('private-view-root')).not.toBeInTheDocument();
      expect(screen.getByTestId('session-recovery-screen')).toBeInTheDocument();

      // Clicking "Try again" once the session check succeeds mounts the private view immediately.
      mode = 'ok';
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.userId).toBe('user-1');
      expect(screen.getByTestId('private-view-root')).toBeInTheDocument();
      expect(screen.queryByTestId('session-recovery-screen')).not.toBeInTheDocument();
    } finally {
      controller.dispose();
      gate.dispose();
      vi.useRealTimers();
    }
  });

  it('retry result (success or late failure) after a same-user replacement login is ignored and leaves replacement intact', async () => {
    vi.useFakeTimers();
    const oldSession = makeFakeSession({ userId: 'user-1', sessionId: 'sid-old-1' });
    const replacementSession = makeFakeSession({ userId: 'user-1', sessionId: 'sid-new-2' });
    const harness = createFakeSessionHarness(null);

    let callIndex = 0;
    const retryDeferred = createDeferred<typeof oldSession | null>();
    const lateFailureDeferred = createDeferred<typeof oldSession | null>();

    harness.setCurrentSessionHandler(() => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.reject(new AuthRecoveryRequired(Date.now() + 1_000));
      }
      if (callIndex === 2) {
        // Scheduled retry from recovery: held so a replacement login can supersede it.
        return retryDeferred.promise;
      }
      if (callIndex === 3) {
        // Replacement login's verification succeeds immediately.
        harness.setSession(replacementSession);
        return Promise.resolve(replacementSession);
      }
      if (callIndex === 4) {
        // Second test phase: late failure from a superseded retry.
        return lateFailureDeferred.promise;
      }
      harness.setSession(replacementSession);
      return Promise.resolve(replacementSession);
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

      // First check hits AuthRecoveryRequired -> enters recovery with scheduled retry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gate.state.status).toBe('recovery');

      // Advance past retryAfter so call #2 (the retry) is now in flight.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_200);
      });
      expect(callIndex).toBe(2);

      // Same-user replacement login arrives (new session_id) while retry #2 is in flight.
      await act(async () => {
        harness.emitAuthChange('SIGNED_IN', replacementSession);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(callIndex).toBe(3);
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-new-2');

      // Now the superseded retry #2 resolves with the old session -> must be ignored!
      await act(async () => {
        retryDeferred.resolve(oldSession);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-new-2');
      expect(screen.getByTestId('private-view-root')).toBeInTheDocument();

      // Also verify a late failure from a superseded retry leaves the replacement login alone.
      void gate.reverify(); // call #4 (held)
      expect(callIndex).toBe(4);
      await act(async () => {
        harness.emitAuthChange('SIGNED_IN', makeFakeSession({ userId: 'user-1', sessionId: 'sid-new-3' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-new-2');

      await act(async () => {
        lateFailureDeferred.reject(new SessionExpired());
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-new-2');
      expect(screen.getByTestId('private-view-root')).toBeInTheDocument();
    } finally {
      controller.dispose();
      gate.dispose();
      vi.useRealTimers();
    }
  });

  it('pagehide during recovery cancels scheduled retries and drops in-flight retry results until pageshow', async () => {
    vi.useFakeTimers();
    const validSession = makeFakeSession({ userId: 'user-1', sessionId: 'sid-after-pageshow' });
    const harness = createFakeSessionHarness(null);

    let calls = 0;
    const inflightRetry = createDeferred<typeof validSession | null>();

    harness.setCurrentSessionHandler(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new AuthRecoveryRequired(Date.now() + 1_000));
      }
      if (calls === 2) {
        return inflightRetry.promise;
      }
      harness.setSession(validSession);
      return Promise.resolve(validSession);
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

      // Call #1 fails with AuthRecoveryRequired -> recovery timer scheduled for ~1_050ms.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(1);
      expect(gate.state.status).toBe('recovery');

      // Trigger pagehide BEFORE the scheduled timer fires: timer must be cancelled!
      await act(async () => {
        gate.handlePagehide();
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(calls).toBe(1);
      expect(gate.state).toEqual({ status: 'checking' });
      expect(screen.queryByTestId('private-view-root')).not.toBeInTheDocument();

      // Return via pageshow -> starts call #2 (held in flight).
      await act(async () => {
        gate.handlePageshow(true);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(2);

      // Fire pagehide while call #2 is in flight, then resolve call #2 -> must be dropped!
      await act(async () => {
        gate.handlePagehide();
        inflightRetry.resolve(validSession);
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(calls).toBe(2);
      expect(gate.state).toEqual({ status: 'checking' });
      expect(screen.queryByTestId('private-view-root')).not.toBeInTheDocument();

      // Return via pageshow -> call #3 runs and authenticates cleanly.
      await act(async () => {
        gate.handlePageshow(true);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(3);
      expect(gate.state).toEqual({ status: 'authenticated' });
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
