import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import {
  CONVERSATION_UNAVAILABLE_TEXT,
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
const AGENT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CONV_GEN = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CONV_PRIV = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const CONV_DM = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const NOW_ISO = '2026-11-23T12:00:00.000Z';

function makeConv(overrides: Record<string, unknown> = {}) {
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

function makeOverviewWithAsk(workspaceId: string, workspaceName: string, agentId: string) {
  return {
    viewer_user_id: 'user-1',
    generated_at: NOW_ISO,
    workspaces: [
      {
        workspace_id: workspaceId,
        name: workspaceName,
        role: 'owner',
        last_seen_at: null,
        new_messages: 1,
        content: null,
        people: [
          {
            user_id: 'user-1',
            display_name: 'Alice',
            role: 'owner',
            is_viewer: true,
            agents: [
              {
                principal_id: agentId,
                name: 'Scout',
                queue: null,
                status: {
                  work: 'idle',
                  facts: {
                    transport: 'local',
                    turn_only: false,
                    connection: 'live',
                    last_activity_at: NOW_ISO,
                    messages_waiting_since: null,
                    doing: null,
                    working_on: null,
                  },
                },
              },
            ],
          },
        ],
        needs_you: {
          asks: [
            {
              signal_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
              from: { kind: 'agent', id: agentId },
              created_at: NOW_ISO,
              until: '2026-11-23T13:00:00.000Z',
            },
          ],
          assigned: [],
          waiting: [],
        },
      },
    ],
  };
}

function makeDecisionQueueWithAsk(workspaceId: string, agentId: string, convId: string) {
  return {
    workspace_id: workspaceId,
    generated_at: NOW_ISO,
    total: 1,
    truncated: false,
    asks: [
      {
        signal_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        from: { kind: 'agent', id: agentId, name: 'Scout' },
        body: 'Approve secret deploy?',
        created_at: NOW_ISO,
        until: '2026-11-23T13:00:00.000Z',
        conversation_id: convId,
        conversation_kind: 'private_channel',
        reraised: null,
      },
    ],
  };
}

describe('C3: immediate full-scope retirement, overview fencing, and identity-bound unavailable state', () => {
  it('Waiting production NULL with held sibling retires WS_1 immediately, prunes rail & overview, fences held overview, blocks selectWorkspace(WS_1), and preserves unaffected WS_2', async () => {
    const user = userEvent.setup();
    const session = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const heldTodos = createDeferred<PostgrestResponse>();
    const heldOverview = createDeferred<PostgrestResponse>();
    let ws1DecisionCalls = 0;

    const harness = createFakeSessionHarness(session, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [
              { workspace_id: WS_1, name: 'Revoked Corp' },
              { workspace_id: WS_2, name: 'Healthy Corp' },
            ],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'agent_principals') {
          return {
            data:
              call.filters.workspace_id === WS_1
                ? [
                    {
                      principal_id: AGENT_1,
                      name: 'Scout',
                      model: 'claude-opus',
                      transport: 'local',
                      turn_only: false,
                      owner_user_id: 'user-1',
                      revoked_at: null,
                      workspace_id: WS_1,
                      created_at: NOW_ISO,
                    },
                  ]
                : [],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'member_profiles') {
          return {
            data:
              call.filters.workspace_id === WS_2
                ? [{ user_id: 'user-1', display_name: 'Healthy Owner', role: 'owner' }]
                : [{ user_id: 'user-1', display_name: 'Alice', role: 'owner' }],
            error: null,
            status: 200,
          };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call) {
        if (call.target === 'home_overview') {
          return heldOverview.promise;
        }
        const ws = String(call.params?.p_workspace_id ?? '');
        if (ws === WS_1) {
          if (call.target === 'decision_queue') {
            ws1DecisionCalls += 1;
            // Production non-member shape: HTTP 200 JSON null.
            return { data: null, error: null, status: 200 };
          }
          if (call.target === 'waiting_todos_page') {
            // Held sibling: never resolves before retirement must complete!
            return heldTodos.promise;
          }
        }
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: ws,
              generated_at: NOW_ISO,
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
              workspace_id: ws,
              generated_at: NOW_ISO,
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
      onFetch(_input, init) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { workspace_id?: string };
        return new Response(
          JSON.stringify({
            conversations: [
              makeConv({
                kind: 'public_channel',
                channel_id: CONV_GEN,
                slug: parsed.workspace_id === WS_2 ? 'healthy-general' : 'revoked-general',
              }),
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
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
      <MemoryRouter initialEntries={['/waiting']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    // Waiting decision_queue NULL retires WS_1 IMMEDIATELY while waiting_todos_page is STILL HELD!
    await waitFor(() => {
      expect(screen.getByTestId('workspace-unavailable')).toHaveTextContent(
        WORKSPACE_UNAVAILABLE_TEXT,
      );
      expect(screen.getByTestId('workspace-unavailable-pane')).toHaveTextContent(
        WORKSPACE_UNAVAILABLE_TEXT,
      );
    });
    expect(ws1DecisionCalls).toBe(1);

    // Rail pruned: no Revoked Corp button or label survives; Healthy Corp stays selectable.
    expect(
      screen.queryByRole('button', { name: 'Revoked Corp workspace' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Revoked Corp')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Healthy Corp workspace' }),
    ).toBeInTheDocument();

    // Selecting the revoked workspace MUST NOT clear its unavailable state or issue queries.
    const callsBeforeSelect = harness.wireCalls.length;
    act(() => {
      controller.selectWorkspace(WS_1);
    });
    expect(getStoreSnapshot().unavailableWorkspaceId).toBe(WS_1);
    expect(screen.getByTestId('workspace-unavailable')).toBeInTheDocument();
    expect(harness.wireCalls.length).toBe(callsBeforeSelect);

    // Held overview resolving late with Revoked Corp + old ask is fenced and discarded.
    await act(async () => {
      heldOverview.resolve({
        data: makeOverviewWithAsk(WS_1, 'Revoked Corp', AGENT_1),
        error: null,
        status: 200,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('Revoked Corp')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(queryKeys.homeOverview(gate.loginGeneration, 0)),
    ).toBeUndefined();

    // Unaffected workspace control: clicking Healthy Corp loads WS_2 cleanly.
    await user.click(screen.getByRole('button', { name: 'Healthy Corp workspace' }));
    await waitFor(() => {
      expect(screen.getByText('healthy-general')).toBeInTheDocument();
      expect(screen.getByText('Healthy Owner')).toBeInTheDocument();
    });
    expect(screen.queryByText('Revoked Corp')).not.toBeInTheDocument();

    controller.dispose();
    gate.dispose();
  });

  it('Waiting production NULL still retires WS_1 when the sibling RPC fails before NULL arrives', async () => {
    const session = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const delayedNull = createDeferred<PostgrestResponse>();

    const harness = createFakeSessionHarness(session, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [{ workspace_id: WS_1, name: 'Failing Sibling WS' }],
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
              generated_at: NOW_ISO,
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        if (call.target === 'waiting_todos_page') {
          // Sibling fails immediately with HTTP 500 BEFORE decision_queue settles!
          return {
            data: null,
            error: { message: 'transient 500', code: '50000' },
            status: 500,
          };
        }
        if (call.target === 'decision_queue') {
          return delayedNull.promise;
        }
        return { data: null, error: null, status: 200 };
      },
      onFetch() {
        return new Response(JSON.stringify({ conversations: [makeConv()] }), {
          status: 200,
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

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        harness.postgrestCalls.some((c) => c.target === 'decision_queue'),
      ).toBe(true);
    });

    // Now decision_queue returns production NULL AFTER waiting_todos_page already failed.
    await act(async () => {
      delayedNull.resolve({ data: null, error: null, status: 200 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('workspace-unavailable')).toHaveTextContent(
        WORKSPACE_UNAVAILABLE_TEXT,
      );
      expect(screen.getByTestId('workspace-unavailable-pane')).toHaveTextContent(
        WORKSPACE_UNAVAILABLE_TEXT,
      );
    });
    expect(
      screen.queryByRole('button', { name: 'Failing Sibling WS workspace' }),
    ).not.toBeInTheDocument();

    controller.dispose();
    gate.dispose();
  });

  it('private channel and DM omission while selected reaches uniform unavailable state, drops Needs you despite held overview, and keeps unchanged-access control working', async () => {
    const user = userEvent.setup();
    const session = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    let conversations = [
      makeConv(),
      makeConv({
        conversation_id: CONV_PRIV,
        kind: 'private_channel',
        channel_id: CONV_PRIV,
        slug: 'secret-room',
        joined: true,
      }),
      makeConv({
        conversation_id: CONV_DM,
        kind: 'dm',
        slug: null,
        joined: true,
        members: [
          { kind: 'user', id: 'user-1', name: 'Alice' },
          { kind: 'agent', id: AGENT_1, name: 'Scout' },
        ],
      }),
    ];
    let decisionHasAsk = true;
    let heldOverview: ReturnType<typeof createDeferred<PostgrestResponse>> | null =
      null;

    const harness = createFakeSessionHarness(session, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [{ workspace_id: WS_1, name: 'Acme' }],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'agent_principals') {
          return {
            data: [
              {
                principal_id: AGENT_1,
                name: 'Scout',
                model: 'claude-opus',
                transport: 'local',
                turn_only: false,
                owner_user_id: 'user-1',
                revoked_at: null,
                workspace_id: WS_1,
                created_at: NOW_ISO,
              },
            ],
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
          if (heldOverview) return heldOverview.promise;
          return {
            data: makeOverviewWithAsk(WS_1, 'Acme', AGENT_1),
            error: null,
            status: 200,
          };
        }
        if (call.target === 'decision_queue') {
          return {
            data: decisionHasAsk
              ? makeDecisionQueueWithAsk(WS_1, AGENT_1, CONV_PRIV)
              : {
                  workspace_id: WS_1,
                  generated_at: NOW_ISO,
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
              generated_at: NOW_ISO,
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
        return new Response(JSON.stringify({ conversations }), {
          status: 200,
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

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('secret-room')).toBeInTheDocument();
      const agentGroup = screen.getByTestId('workspace-agent-group');
      expect(within(agentGroup).getByText('Needs you')).toBeInTheDocument();
    });

    // Click the real private channel in the sidebar: binds canonical conversation UUID!
    await user.click(screen.getByRole('link', { name: /secret-room/ }));
    expect(gate.fenceTracker.activeConversationId).toBe(CONV_PRIV);
    expect(getStoreSnapshot().selectedConversation).toEqual({
      workspaceId: WS_1,
      conversationId: CONV_PRIV,
    });

    // Unchanged-access control: refetch while secret-room is still joined -> stays available, Needs you intact.
    const loginGen = gate.loginGeneration;
    const wsGen = gate.fenceTracker.getWorkspaceGeneration(WS_1);
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.workspaceConversations(loginGen, WS_1, wsGen),
      });
    });
    expect(screen.getByText('secret-room')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-unavailable')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('workspace-agent-group')).getByText('Needs you'),
    ).toBeInTheDocument();

    // Start a held overview response that STILL contains the old ask.
    const staleOverviewDeferred = createDeferred<PostgrestResponse>();
    heldOverview = staleOverviewDeferred;
    const overviewRefetchPromise = queryClient.refetchQueries({
      queryKey: queryKeys.homeOverviewPrefix(loginGen),
    });

    // Now omit secret-room from fresh conversations and clear its ask from fresh decision_queue.
    decisionHasAsk = false;
    conversations = conversations.filter((c) => c.conversation_id !== CONV_PRIV);
    heldOverview = null;

    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.workspaceConversations(loginGen, WS_1, wsGen),
      });
    });

    // Selected real private channel reaches the uniform unavailable state immediately!
    expect(screen.getByTestId('conversation-unavailable')).toHaveTextContent(
      CONVERSATION_UNAVAILABLE_TEXT,
    );
    expect(screen.queryByText('secret-room')).not.toBeInTheDocument();
    // "Needs you" MUST NOT survive from cached overview!
    expect(
      within(screen.getByTestId('workspace-agent-group')).queryByText('Needs you'),
    ).not.toBeInTheDocument();

    // Held overview containing the old ask resolves late -> fenced and discarded; Needs you stays gone!
    await act(async () => {
      staleOverviewDeferred.resolve({
        data: makeOverviewWithAsk(WS_1, 'Acme', AGENT_1),
        error: null,
        status: 200,
      });
      await overviewRefetchPromise;
      await Promise.resolve();
    });
    expect(
      within(screen.getByTestId('workspace-agent-group')).queryByText('Needs you'),
    ).not.toBeInTheDocument();

    // Now select the real DM row in the sidebar, then omit it -> DM reaches uniform unavailable state!
    const dmLinks = screen.getAllByRole('link', { name: 'Scout' });
    const dmLink = dmLinks.find((el) =>
      el.getAttribute('href')?.includes(CONV_DM),
    );
    expect(dmLink).toBeDefined();
    await user.click(dmLink!);
    expect(gate.fenceTracker.activeConversationId).toBe(CONV_DM);
    expect(screen.queryByTestId('conversation-unavailable')).not.toBeInTheDocument();

    conversations = conversations.filter((c) => c.conversation_id !== CONV_DM);
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.workspaceConversations(loginGen, WS_1, wsGen),
      });
    });
    expect(screen.getByTestId('conversation-unavailable')).toHaveTextContent(
      CONVERSATION_UNAVAILABLE_TEXT,
    );

    controller.dispose();
    gate.dispose();
  });
});

describe('C4: synchronous pagehide retirement before browser history snapshot + bfcache restore controls', () => {
  it('synchronously removes private DOM and aborts in-flight reads on pagehide BEFORE returning (without React act), then revalidates on persisted pageshow across unchanged, sign-out, and same-user replacement', async () => {
    const session1 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const session2 = makeFakeSession({ userId: 'user-1', sessionId: 'sid-2' });
    let activeSession: typeof session1 | null = session1;
    let workspaceName = 'Top Secret Org';
    let workspaceRanges: unknown[] = [];
    let heldConvSignal: AbortSignal | undefined;
    let holdNextConv = false;
    const heldConvDeferred = createDeferred<Response>();

    const harness = createFakeSessionHarness(session1, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          workspaceRanges.push(call.filters.range);
          return {
            data: [{ workspace_id: WS_1, name: workspaceName }],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'member_profiles') {
          return {
            data: [{ user_id: 'user-1', display_name: 'Private Alice', role: 'owner' }],
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
              generated_at: NOW_ISO,
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
              generated_at: NOW_ISO,
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
              generated_at: NOW_ISO,
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
      onFetch(_input, init) {
        if (holdNextConv) {
          holdNextConv = false;
          heldConvSignal = init?.signal ?? undefined;
          return heldConvDeferred.promise;
        }
        const auth = new Headers(init?.headers).get('authorization');
        return new Response(
          JSON.stringify({
            conversations: [
              makeConv({
                kind: 'public_channel',
                channel_id: CONV_GEN,
                slug:
                  auth === `Bearer ${session2.access_token}`
                    ? 'sid2-channel'
                    : 'secret-channel',
              }),
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    let heldReverify: ReturnType<typeof createDeferred<typeof session1 | null>> | null =
      null;
    harness.setCurrentSessionHandler(() =>
      heldReverify ? heldReverify.promise : Promise.resolve(activeSession),
    );

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
      expect(screen.getByText('Top Secret Org')).toBeInTheDocument();
      expect(screen.getByText('secret-channel')).toBeInTheDocument();
      expect(screen.getByText('Private Alice')).toBeInTheDocument();
    });

    // Start an in-flight conversations read to verify pagehide aborts it synchronously.
    holdNextConv = true;
    const loginGen1 = gate.loginGeneration;
    const wsGen1 = gate.fenceTracker.getWorkspaceGeneration(WS_1);
    void queryClient.refetchQueries({
      queryKey: queryKeys.workspaceConversations(loginGen1, WS_1, wsGen1),
    });
    await waitFor(() => expect(heldConvSignal).toBeDefined());
    expect(heldConvSignal!.aborted).toBe(false);

    const wireCountBeforePagehide = harness.wireCalls.length;
    workspaceRanges = [];

    // 1. Dispatch pagehide OUTSIDE React act() — asserting the synchronous DOM snapshot boundary!
    const pagehideEv = new Event('pagehide');
    Object.defineProperty(pagehideEv, 'persisted', { value: true });
    window.dispatchEvent(pagehideEv);

    // IMMEDIATELY (zero awaits, zero act flush): private DOM is already gone before bfcache capture!
    expect(document.body.textContent).not.toContain('Top Secret Org');
    expect(document.body.textContent).not.toContain('secret-channel');
    expect(document.body.textContent).not.toContain('Private Alice');
    expect(screen.getByTestId('session-checking-screen')).toBeInTheDocument();
    expect(heldConvSignal!.aborted).toBe(true);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(getStoreSnapshot().selectedWorkspaceId).toBeNull();
    // Zero network requests started while hiding.
    expect(harness.wireCalls.length).toBe(wireCountBeforePagehide);

    // 2. Real history-cache control: persisted pageshow keeps private view unavailable until verified login settles.
    heldReverify = createDeferred<typeof session1 | null>();
    const pageshowControl = new Event('pageshow');
    Object.defineProperty(pageshowControl, 'persisted', { value: true });
    window.dispatchEvent(pageshowControl);

    expect(document.body.textContent).not.toContain('Top Secret Org');
    expect(screen.getByTestId('session-checking-screen')).toBeInTheDocument();

    await act(async () => {
      heldReverify!.resolve(session1);
      heldReverify = null;
    });
    await waitFor(() => {
      expect(screen.getByText('Top Secret Org')).toBeInTheDocument();
      expect(screen.getByText('secret-channel')).toBeInTheDocument();
    });
    expect(workspaceRanges[0]).toEqual([0, 49]);

    // 3. Peer-tab same-user replacement (sid-1 -> sid-2) while preview is away in bfcache.
    window.dispatchEvent(new Event('pagehide'));
    expect(document.body.textContent).not.toContain('Top Secret Org');
    expect(screen.getByTestId('session-checking-screen')).toBeInTheDocument();

    activeSession = session2;
    harness.setSession(session2);
    workspaceName = 'Replacement Org';
    const pageshowReplace = new Event('pageshow');
    Object.defineProperty(pageshowReplace, 'persisted', { value: true });
    act(() => {
      window.dispatchEvent(pageshowReplace);
    });

    await waitFor(() => {
      expect(screen.getByText('Replacement Org')).toBeInTheDocument();
      expect(screen.getByText('sid2-channel')).toBeInTheDocument();
    });
    expect(gate.fenceTracker.loginIdentity?.sessionId).toBe('sid-2');
    expect(screen.queryByText('Top Secret Org')).not.toBeInTheDocument();

    // 4. Peer-tab sign-out while preview is away in bfcache.
    window.dispatchEvent(new Event('pagehide'));
    expect(document.body.textContent).not.toContain('Replacement Org');
    const wireCountBeforeSignOutRestore = harness.wireCalls.length;

    activeSession = null;
    harness.setSession(null);
    const pageshowSignedOut = new Event('pageshow');
    Object.defineProperty(pageshowSignedOut, 'persisted', { value: true });
    act(() => {
      window.dispatchEvent(pageshowSignedOut);
    });

    await waitFor(() => {
      expect(screen.getByTestId('signed-out-screen')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('Replacement Org');
    expect(harness.wireCalls.length).toBe(wireCountBeforeSignOutRestore);

    controller.dispose();
    gate.dispose();
  });
});
