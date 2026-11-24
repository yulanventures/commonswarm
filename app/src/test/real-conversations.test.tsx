import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AuthRetryableFetchError,
  RealtimeClient,
  createClient,
  isAuthSessionMissingError,
  navigatorLock,
  processLock,
} from '@supabase/supabase-js';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserSession,
  sessionStorageKeyForDeployment,
} from '../../../shared/browser-session/index.js';
import { AppRoutes } from '../App';
import {
  FEED_POLL_MS,
  FEED_PUSH_BACKOFF_MS,
  FEED_RECONCILE_MS,
  createWorkspaceLiveManager,
  realtimeEndpointMatchesApiOrigin,
} from '../data/live';
import {
  CONVERSATION_UNAVAILABLE_TEXT,
  createAppQueryClient,
  createDataController,
  queryKeys,
} from '../data/queries';
import { createSessionGate } from '../data/session';
import { resetAppStore } from '../store/appStore';
import {
  createDeferred,
  createFakeSessionHarness,
  createFakeStorage,
  makeFakeJwt,
  makeFakeSession,
  type RecordedWireFetchCall,
} from './fake-session';

const DEPLOY_URL = 'https://api.commonswarm.com';
const ANON_KEY = 'anon-public-key';
const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const USER_UNKNOWN = '99999999-9999-4999-8999-999999999999';
const AGENT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WS_1 = '33333333-3333-4333-8333-333333333333';
const CONV_LAUNCH = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CONV_DM = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const CONV_EMPTY = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const CONV_PRIVATE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';
const CONV_UNKNOWN = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9';

const ALLOWED_RPC_TARGETS = new Set([
  'home_overview',
  'decision_queue',
  'waiting_todos_page',
]);

/**
 * Assert that zero write requests were issued on the wire across every test.
 * Only read-only PostgREST GETs, allowlisted read-only RPCs, and `/functions/v1/read`
 * are permitted in Step 4.
 */
function assertZeroWriteRequests(wireCalls: readonly RecordedWireFetchCall[]): void {
  for (const call of wireCalls) {
    const parsed = new URL(call.url);
    expect(parsed.pathname).not.toContain('/functions/v1/command');
    expect(['GET', 'POST']).toContain(call.method);
    if (call.method === 'POST') {
      if (parsed.pathname === '/functions/v1/read') {
        continue;
      }
      if (parsed.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = parsed.pathname.slice('/rest/v1/rpc/'.length);
        expect(ALLOWED_RPC_TARGETS.has(fn)).toBe(true);
        continue;
      }
      throw new Error(`Unexpected POST write request: ${call.method} ${call.url}`);
    }
  }
}

function makeConversationRow(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: CONV_LAUNCH,
    kind: 'public_channel',
    channel_id: CONV_LAUNCH,
    slug: 'launch',
    description: null,
    archived_at: null,
    joined: true,
    members: [
      { kind: 'user', id: USER_1, name: 'Alice', left_at: null },
      { kind: 'user', id: USER_2, name: 'Bob', left_at: null },
      { kind: 'agent', id: AGENT_1, name: 'Builder', left_at: null },
    ],
    notify_level: 'everything',
    starred: false,
    star_rank: null,
    unread_count: 0,
    mention_count: 0,
    last_message_at: '2026-11-23T10:46:00.000Z',
    last_message_id: null,
    ...overrides,
  };
}

function makeMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    from: USER_1,
    from_kind: 'user',
    to: null,
    to_agent: null,
    kind: 'note',
    body: 'Hello channel',
    attachments: [],
    about: null,
    until: null,
    created_at: '2026-11-23T10:31:00.000Z',
    channel_id: CONV_LAUNCH,
    thread_root_id: null,
    in_reply_to: null,
    broadcast_to_channel: false,
    mentions: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeStandardFromAndRpc(nowIso: string) {
  return {
    onFrom(call: { target: string }) {
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
              name: 'Builder',
              model: 'claude',
              transport: 'local',
              turn_only: false,
              owner_user_id: USER_1,
              revoked_at: null,
              workspace_id: WS_1,
              created_at: nowIso,
            },
          ],
          error: null,
          status: 200,
        };
      }
      if (call.target === 'member_profiles') {
        return {
          data: [
            { user_id: USER_1, display_name: 'Alice', role: 'owner' },
            { user_id: USER_2, display_name: 'Bob', role: 'member' },
          ],
          error: null,
          status: 200,
        };
      }
      return { data: [], error: null, status: 200 };
    },
    onRpc(call: { target: string; params?: Record<string, unknown> }) {
      if (call.target === 'home_overview') {
        return {
          data: {
            viewer_user_id: USER_1,
            generated_at: nowIso,
            workspaces: [],
          },
          error: null,
          status: 200,
        };
      }
      const ws = String(call.params?.p_workspace_id ?? WS_1);
      if (call.target === 'decision_queue') {
        return {
          data: {
            workspace_id: ws,
            generated_at: nowIso,
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
            generated_at: nowIso,
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
  };
}

describe('Step 4: real read-only conversations, safe rendering, pagination, live hints, and fencing', () => {
  const allWireCalls: RecordedWireFetchCall[] = [];

  beforeEach(() => {
    resetAppStore();
    allWireCalls.length = 0;
  });

  afterEach(() => {
    assertZeroWriteRequests(allWireCalls);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders real channel and DM messages in order with authors, mentions, thread counts, quiet cards, redaction text, empty state, disabled composer, and uniform unavailable for unlisted ids', async () => {
    const user = userEvent.setup();
    const nowIso = '2026-11-23T12:00:00.000Z';
    const session = makeFakeSession({ userId: USER_1, sessionId: 'sid-1' });
    const launchConv = makeConversationRow();
    const dmConv = makeConversationRow({
      conversation_id: CONV_DM,
      kind: 'dm',
      channel_id: null,
      slug: null,
      members: [
        { kind: 'user', id: USER_1, name: 'Alice', left_at: null },
        { kind: 'agent', id: AGENT_1, name: 'Builder', left_at: null },
      ],
    });
    const emptyConv = makeConversationRow({
      conversation_id: CONV_EMPTY,
      kind: 'public_channel',
      channel_id: CONV_EMPTY,
      slug: 'quiet',
      members: [],
    });

    const historyRequests: Array<Record<string, unknown>> = [];
    const rootId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
    const todoUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

    const harness = createFakeSessionHarness(session, {
      ...makeStandardFromAndRpc(nowIso),
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [launchConv, dmConv, emptyConv] });
        }
        if (body.resource === 'conversation_history') {
          historyRequests.push(body);
          if (body.conversation_id === CONV_LAUNCH) {
            return jsonResponse({
              conversation: launchConv,
              messages: [
                makeMessageRow({
                  id: rootId,
                  from: USER_1,
                  from_kind: 'user',
                  body: '@Builder ship the release notes',
                  created_at: '2026-11-22T10:31:00.000Z',
                  mentions: [
                    { position: 0, kind: 'agent', id: AGENT_1, source: 'author' },
                  ],
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
                  from: AGENT_1,
                  from_kind: 'agent',
                  body: 'First thread reply',
                  thread_root_id: rootId,
                  created_at: '2026-11-22T10:32:00.000Z',
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
                  from: USER_2,
                  from_kind: 'user',
                  body: 'Second thread reply',
                  thread_root_id: rootId,
                  created_at: '2026-11-22T10:33:00.000Z',
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
                  from: AGENT_1,
                  from_kind: 'agent',
                  kind: 'ask',
                  body: 'Should we cut the branch now?',
                  created_at: '2026-11-23T09:00:00.000Z',
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
                  from: AGENT_1,
                  from_kind: 'agent',
                  kind: 'note',
                  about: 'review_check:pr-482',
                  body: 'Review PR #482 at a41c9e2',
                  created_at: '2026-11-23T09:10:00.000Z',
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd6',
                  from: AGENT_1,
                  from_kind: 'agent',
                  kind: 'ask',
                  about: `todo:${todoUuid}`,
                  body: 'Update deployment checklist',
                  created_at: '2026-11-23T09:20:00.000Z',
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd7',
                  from: USER_UNKNOWN,
                  from_kind: 'user',
                  kind: 'note',
                  body: '[redacted by workspace policy]',
                  created_at: '2026-11-23T09:30:00.000Z',
                }),
              ],
              has_more: false,
              next_before: null,
              next_after: null,
            });
          }
          if (body.conversation_id === CONV_DM) {
            return jsonResponse({
              conversation: dmConv,
              messages: [
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd10',
                  from: AGENT_1,
                  from_kind: 'agent',
                  body: 'Direct message hello',
                  created_at: '2026-11-23T11:00:00.000Z',
                  channel_id: null,
                }),
              ],
              has_more: false,
              next_before: null,
              next_after: null,
            });
          }
          if (body.conversation_id === CONV_EMPTY) {
            return jsonResponse({
              conversation: emptyConv,
              messages: [],
              has_more: false,
              next_before: null,
              next_after: null,
            });
          }
        }
        return jsonResponse({ error: 'unexpected' }, 404);
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

    // Start on an unlisted conversation id -> uniform unavailable, ZERO conversation_history calls.
    render(
      <MemoryRouter initialEntries={[`/channels/${CONV_UNKNOWN}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('conversation-unavailable')).toHaveTextContent(
        CONVERSATION_UNAVAILABLE_TEXT,
      );
    });
    expect(historyRequests).toHaveLength(0);
    expect(screen.queryByTestId('sample-data-marker')).not.toBeInTheDocument();

    // Click #launch in sidebar -> loads real conversation_history with mentions included.
    await user.click(screen.getByRole('link', { name: /launch/ }));

    await waitFor(() => {
      expect(screen.getByText(/ship the release notes/)).toBeInTheDocument();
    });

    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0]).toEqual({
      resource: 'conversation_history',
      workspace_id: WS_1,
      conversation_id: CONV_LAUNCH,
      limit: 50,
      include_mentions: true,
      include_reactions: false,
    });

    // No Sample data marker on a real conversation.
    expect(screen.queryByTestId('sample-data-marker')).not.toBeInTheDocument();

    // Header has `# launch` and real member counts.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('# launch');
    expect(screen.getByText('2 people · 1 agent')).toBeInTheDocument();

    // Day separators exist for the 2 distinct days.
    expect(screen.getAllByTestId('day-separator').length).toBeGreaterThanOrEqual(2);

    // Messages render oldest-to-newest, replies collapsed into "2 replies".
    const rows = screen.getAllByTestId('message-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]!).toHaveTextContent('Alice');
    expect(rows[0]!).toHaveTextContent('@Builder');
    expect(within(rows[0]!).getByTestId('thread-reply-count')).toHaveTextContent(
      '2 replies',
    );

    // Quiet labelled rows for Ask, Review, To-do with ZERO action buttons inside them.
    const cards = screen.getAllByTestId('message-card-row');
    expect(cards).toHaveLength(3);
    expect(cards[0]!).toHaveTextContent('Asked');
    expect(cards[0]!).toHaveTextContent('Should we cut the branch now?');
    expect(within(cards[0]!).queryAllByRole('button')).toHaveLength(0);

    expect(cards[1]!).toHaveTextContent('Review requested');
    expect(cards[1]!).toHaveTextContent('Review PR #482 at a41c9e2');
    expect(within(cards[1]!).queryAllByRole('button')).toHaveLength(0);

    expect(cards[2]!).toHaveTextContent('To-do');
    expect(cards[2]!).toHaveTextContent('Update deployment checklist');
    expect(within(cards[2]!).queryAllByRole('button')).toHaveLength(0);

    // Unknown author shown as "Unknown" (never raw UUID), server redaction text shown verbatim.
    expect(rows[4]!).toHaveTextContent('Unknown');
    expect(rows[4]!).not.toHaveTextContent(USER_UNKNOWN);
    expect(rows[4]!).toHaveTextContent('[redacted by workspace policy]');

    // Composer is visible and disabled, with no helper text.
    const composerInput = screen.getByRole('combobox', {
      name: 'Message # launch',
    });
    expect(composerInput).toBeDisabled();
    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();

    // Click DM in sidebar -> header shows partner name WITHOUT `#`.
    const dmLink = screen
      .getAllByRole('link', { name: 'Builder' })
      .find((el) => el.getAttribute('href')?.includes(CONV_DM));
    expect(dmLink).toBeDefined();
    await user.click(dmLink!);

    await waitFor(() => {
      expect(screen.getByText('Direct message hello')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Builder');
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('#');
    expect(screen.getByRole('combobox', { name: 'Message Builder' })).toBeDisabled();

    // Click empty channel -> header + disabled composer only, zero message rows.
    await user.click(screen.getByRole('link', { name: /quiet/ }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('# quiet');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('conversation-loading')).not.toBeInTheDocument();
    });
    expect(screen.queryAllByTestId('message-row')).toHaveLength(0);
    expect(screen.getByTestId('message-list').textContent).toBe('');

    allWireCalls.push(...harness.wireCalls);
    controller.dispose();
    gate.dispose();
  });

  it('shows an error state (never partial render) when conversation_history fails to decode and recovers on Retry', async () => {
    const user = userEvent.setup();
    const nowIso = '2026-11-23T12:00:00.000Z';
    const session = makeFakeSession({ userId: USER_1, sessionId: 'sid-1' });
    const launchConv = makeConversationRow();
    let corrupt = true;

    const harness = createFakeSessionHarness(session, {
      ...makeStandardFromAndRpc(nowIso),
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [launchConv] });
        }
        if (body.resource === 'conversation_history') {
          if (corrupt) {
            // One valid message + one malformed message -> MUST fail closed, never partial render!
            return jsonResponse({
              conversation: launchConv,
              messages: [
                makeMessageRow({ body: 'Should not partial paint' }),
                { id: 'bad-row', body: 123 },
              ],
              has_more: false,
              next_before: null,
              next_after: null,
            });
          }
          return jsonResponse({
            conversation: launchConv,
            messages: [makeMessageRow({ body: 'Recovered clean message' })],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
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
      <MemoryRouter initialEntries={[`/channels/${CONV_LAUNCH}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('conversation-error')).toBeInTheDocument();
    });
    expect(screen.queryByText('Should not partial paint')).not.toBeInTheDocument();

    corrupt = false;
    await user.click(
      within(screen.getByTestId('conversation-error')).getByRole('button', {
        name: 'Retry',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('Recovered clean message')).toBeInTheDocument();
    });

    allWireCalls.push(...harness.wireCalls);
    controller.dispose();
    gate.dispose();
  });

  it('loads older pages automatically on scroll-up and prepends without moving the reading position', async () => {
    const nowIso = '2026-11-23T12:00:00.000Z';
    const session = makeFakeSession({ userId: USER_1, sessionId: 'sid-1' });
    const launchConv = makeConversationRow();
    const olderPageDeferred = createDeferred<Response>();
    const historyBodies: Array<Record<string, unknown>> = [];

    const harness = createFakeSessionHarness(session, {
      ...makeStandardFromAndRpc(nowIso),
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [launchConv] });
        }
        if (body.resource === 'conversation_history') {
          historyBodies.push(body);
          if (!body.before_id) {
            return jsonResponse({
              conversation: launchConv,
              messages: [
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd20',
                  body: 'Newer message 1',
                  created_at: '2026-11-23T10:00:00.000Z',
                }),
                makeMessageRow({
                  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd21',
                  body: 'Newer message 2',
                  created_at: '2026-11-23T10:05:00.000Z',
                }),
              ],
              has_more: true,
              next_before: {
                created_at: '2026-11-23T10:00:00.000Z',
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd20',
              },
              next_after: null,
            });
          }
          return olderPageDeferred.promise;
        }
        return jsonResponse({}, 404);
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
      <MemoryRouter initialEntries={[`/channels/${CONV_LAUNCH}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Newer message 2')).toBeInTheDocument();
    });

    const listEl = screen.getByTestId('message-list');
    let currentScrollHeight = 1000;
    Object.defineProperty(listEl, 'scrollHeight', {
      configurable: true,
      get: () => currentScrollHeight,
    });
    Object.defineProperty(listEl, 'clientHeight', {
      configurable: true,
      value: 400,
    });

    // Simulate user scrolling near the top (scrollTop = 30 <= 80).
    listEl.scrollTop = 30;
    fireEvent.scroll(listEl);

    await waitFor(() => {
      expect(historyBodies).toHaveLength(2);
    });
    expect(historyBodies[1]).toMatchObject({
      resource: 'conversation_history',
      conversation_id: CONV_LAUNCH,
      before_created_at: '2026-11-23T10:00:00.000Z',
      before_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd20',
      include_mentions: true,
    });
    expect(screen.getByTestId('loading-older')).toBeInTheDocument();

    // Prepend grows scrollHeight by 600px (1000 -> 1600).
    currentScrollHeight = 1600;
    await act(async () => {
      olderPageDeferred.resolve(
        jsonResponse({
          conversation: launchConv,
          messages: [
            makeMessageRow({
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd10',
              body: 'Older message 1',
              created_at: '2026-11-23T09:00:00.000Z',
            }),
            makeMessageRow({
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd11',
              body: 'Older message 2',
              created_at: '2026-11-23T09:10:00.000Z',
            }),
          ],
          has_more: false,
          next_before: null,
          next_after: null,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Older message 1')).toBeInTheDocument();
    });

    // Reading position adjusted by the exact prepended delta: 30 + (1600 - 1000) = 630!
    expect(listEl.scrollTop).toBe(630);

    // Chronological order preserved (older above newer).
    const rows = screen.getAllByTestId('message-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Older message 1'),
      expect.stringContaining('Older message 2'),
      expect.stringContaining('Newer message 1'),
      expect.stringContaining('Newer message 2'),
    ]);

    allWireCalls.push(...harness.wireCalls);
    controller.dispose();
    gate.dispose();
  });

  it('realtime hint triggers exactly one re-read of the open conversation and the list, coalesces bursts, ignores retired generations, and falls back to polling with backoff on channel error', async () => {
    const nowIso = '2026-11-23T12:00:00.000Z';
    const token1 = makeFakeJwt({ sub: USER_1, session_id: 'sid-1', jti: 'live-1' });
    const session1 = makeFakeSession({
      userId: USER_1,
      sessionId: 'sid-1',
      accessToken: token1,
    });
    let unreadCount = 0;
    let messageVersion = 1;
    let convListCalls = 0;
    let historyCalls = 0;
    let heldHistoryRefresh: ReturnType<typeof createDeferred<Response>> | null = null;

    const harness = createFakeSessionHarness(session1, {
      ...makeStandardFromAndRpc(nowIso),
      enableRealtime: true,
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          convListCalls += 1;
          return jsonResponse({
            conversations: [
              makeConversationRow({ unread_count: unreadCount }),
              makeConversationRow({
                conversation_id: CONV_DM,
                kind: 'dm',
                channel_id: null,
                slug: null,
                unread_count: unreadCount,
                members: [
                  { kind: 'user', id: USER_1, name: 'Alice', left_at: null },
                  { kind: 'agent', id: AGENT_1, name: 'Builder', left_at: null },
                ],
              }),
            ],
          });
        }
        if (body.resource === 'conversation_history') {
          historyCalls += 1;
          if (heldHistoryRefresh) {
            const d = heldHistoryRefresh;
            heldHistoryRefresh = null;
            return d.promise;
          }
          const messages = [
            makeMessageRow({
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd30',
              body: 'Initial message',
              created_at: '2026-11-23T10:00:00.000Z',
            }),
          ];
          if (messageVersion >= 2) {
            messages.push(
              makeMessageRow({
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd31',
                body: 'Live arrived message',
                created_at: '2026-11-23T10:02:00.000Z',
              }),
            );
          }
          return jsonResponse({
            conversation: makeConversationRow({ unread_count: unreadCount }),
            messages,
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
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
      <MemoryRouter initialEntries={[`/channels/${CONV_LAUNCH}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Initial message')).toBeInTheDocument();
      expect(harness.realtime!.activeChannels()).toHaveLength(2);
    });

    // Subscribed ONLY to the two private topics (never cswarm-activity).
    const topics = harness.realtime!.activeChannels().map((c) => c.topic).sort();
    expect(topics).toEqual([
      `cswarm-member:${WS_1}:${USER_1}`,
      `cswarm-signals:${WS_1}`,
    ]);
    expect(harness.realtime!.setAuthCalls).toContain(token1);
    for (const ch of harness.realtime!.activeChannels()) {
      expect(ch.opts).toEqual({
        config: { private: true, broadcast: { ack: false, self: false } },
      });
    }

    // Mark both channels SUBSCRIBED.
    act(() => {
      harness.realtime!.emitStatus('SUBSCRIBED');
    });

    const convBeforeHint = convListCalls;
    const histBeforeHint = historyCalls;

    // 1. Single hint (payload ignored) -> triggers EXACTLY ONE re-read of open conversation + list.
    unreadCount = 3;
    messageVersion = 2;
    await act(async () => {
      harness.realtime!.emitHint(
        { v: 1, spoofed_body: 'MUST NEVER PAINT' },
        'cswarm-member:',
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Live arrived message')).toBeInTheDocument();
      expect(screen.getAllByTestId('unread-count')[0]).toHaveTextContent('3');
    });
    expect(screen.queryByText('MUST NEVER PAINT')).not.toBeInTheDocument();
    expect(historyCalls - histBeforeHint).toBe(1);
    expect(convListCalls - convBeforeHint).toBe(1);

    // 2. Burst of 5 hints while 1 refresh is in flight -> coalesces to 1 in-flight + 1 queued = 2 total!
    const convBeforeBurst = convListCalls;
    const histBeforeBurst = historyCalls;
    const burstDeferred = createDeferred<Response>();
    heldHistoryRefresh = burstDeferred;

    act(() => {
      for (let i = 0; i < 5; i += 1) {
        harness.realtime!.emitHint({ v: 1 }, 'cswarm-member:');
      }
    });

    await waitFor(() => {
      expect(historyCalls - histBeforeBurst).toBe(1);
    });

    await act(async () => {
      burstDeferred.resolve(
        jsonResponse({
          conversation: makeConversationRow({ unread_count: 3 }),
          messages: [
            makeMessageRow({
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd30',
              body: 'Initial message',
              created_at: '2026-11-23T10:00:00.000Z',
            }),
            makeMessageRow({
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd31',
              body: 'Live arrived message',
              created_at: '2026-11-23T10:02:00.000Z',
            }),
          ],
          has_more: false,
          next_before: null,
          next_after: null,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(historyCalls - histBeforeBurst).toBe(2);
      expect(convListCalls - convBeforeBurst).toBe(2);
    });

    // 3. Retired generation: capture old channel record, sign out, emit late hint -> ZERO reads!
    const retiredMemberChannel = harness.realtime!.channels.find((c) =>
      c.topic.startsWith('cswarm-member:'),
    )!;
    const wireCountAtSignOut = harness.wireCalls.length;
    act(() => {
      harness.emitAuthChange('SIGNED_OUT', null);
    });
    expect(harness.realtime!.activeChannels()).toHaveLength(0);

    await act(async () => {
      retiredMemberChannel.emitBroadcast({ v: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.wireCalls.length).toBe(wireCountAtSignOut);

    allWireCalls.push(...harness.wireCalls);
    controller.dispose();
    gate.dispose();

    // 4. Direct unit proof of fallback polling (2s) + backoff ([1s, 2s, 5s, 10s]) + 30s reconcile + origin check.
    const intervalCalls: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
    const timeoutCalls: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
    const fakeTimers = {
      setInterval(fn: () => void, ms: number) {
        intervalCalls.push({ ms, fn, cleared: false });
        return intervalCalls.length;
      },
      clearInterval(id: number | undefined) {
        if (id && intervalCalls[id - 1]) intervalCalls[id - 1]!.cleared = true;
      },
      setTimeout(fn: () => void, ms: number) {
        timeoutCalls.push({ ms, fn, cleared: false });
        return timeoutCalls.length;
      },
      clearTimeout(id: number | undefined) {
        if (id && timeoutCalls[id - 1]) timeoutCalls[id - 1]!.cleared = true;
      },
    };

    const rtHarness = createFakeSessionHarness(session1, {
      enableRealtime: true,
    });
    const rtGate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => rtHarness.browserSession,
      fetchImpl: rtHarness.fetchImpl,
    });
    await waitFor(() => expect(rtGate.state).toEqual({ status: 'authenticated' }));
    rtGate.fenceTracker.setActiveWorkspace(WS_1);

    // Confirm origin validator matches CSP wss://api.commonswarm.com only.
    expect(
      realtimeEndpointMatchesApiOrigin(
        rtHarness.browserSession.client as unknown as Parameters<
          typeof realtimeEndpointMatchesApiOrigin
        >[0],
        DEPLOY_URL,
      ),
    ).toBe(true);
    expect(
      realtimeEndpointMatchesApiOrigin(
        {
          channel: () => ({ on: () => {}, subscribe: () => {} }),
          removeChannel: () => {},
          realtime: {
            setAuth: () => {},
            endpointURL: () => 'wss://evil.example/realtime/v1/websocket',
          },
        },
        DEPLOY_URL,
      ),
    ).toBe(false);

    let pollRefreshes = 0;
    const manager = createWorkspaceLiveManager({
      sessionGate: rtGate,
      workspaceId: WS_1,
      onRefresh: () => {
        pollRefreshes += 1;
      },
      timers: fakeTimers,
    });

    await waitFor(() => expect(rtHarness.realtime!.activeChannels()).toHaveLength(2));
    // Before SUBSCRIBED: polling at FEED_POLL_MS (2000ms).
    expect(intervalCalls.at(-1)?.ms).toBe(FEED_POLL_MS);

    // Both channels join -> switches to FEED_RECONCILE_MS (30000ms).
    rtHarness.realtime!.emitStatus('SUBSCRIBED');
    expect(manager.subscribed).toBe(true);
    expect(intervalCalls.at(-1)?.ms).toBe(FEED_RECONCILE_MS);

    // Channel error -> immediately drops back to 2000ms poll + schedules 1000ms backoff resubscribe!
    rtHarness.realtime!.emitStatus('CHANNEL_ERROR', 'cswarm-member:');
    expect(manager.subscribed).toBe(false);
    expect(intervalCalls.at(-1)?.ms).toBe(FEED_POLL_MS);
    expect(timeoutCalls.at(-1)?.ms).toBe(FEED_PUSH_BACKOFF_MS[0]);

    // Poll tick invokes refresh.
    intervalCalls.at(-1)!.fn();
    expect(pollRefreshes).toBe(1);

    // Fire first backoff -> resubscribes; second error uses 2000ms backoff.
    timeoutCalls.at(-1)!.fn();
    await waitFor(() => expect(rtHarness.realtime!.channels.length).toBeGreaterThanOrEqual(4));
    rtHarness.realtime!.emitStatus('TIMED_OUT', 'cswarm-member:');
    expect(timeoutCalls.at(-1)?.ms).toBe(FEED_PUSH_BACKOFF_MS[1]);

    manager.dispose();
    rtGate.dispose();
  });

  it('held history read across same-person new sign-in, sign-out, and conversation loss paints nothing and writes no cache; current-login control paints', async () => {
    const nowIso = '2026-11-23T12:00:00.000Z';
    const token1 = makeFakeJwt({ sub: USER_1, session_id: 'sid-1', jti: 'h-1' });
    const token2 = makeFakeJwt({ sub: USER_1, session_id: 'sid-2', jti: 'h-2' });
    const session1 = makeFakeSession({ userId: USER_1, sessionId: 'sid-1', accessToken: token1 });
    const session2 = makeFakeSession({ userId: USER_1, sessionId: 'sid-2', accessToken: token2 });

    const heldSid1History = createDeferred<Response>();
    const launchConv = makeConversationRow();
    let activeToken = token1;

    const harness = createFakeSessionHarness(session1, {
      ...makeStandardFromAndRpc(nowIso),
      onFetch(_input, init) {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [launchConv] });
        }
        if (body.resource === 'conversation_history') {
          if (headers.get('authorization') === `Bearer ${token1}`) {
            return heldSid1History.promise;
          }
          return jsonResponse({
            conversation: launchConv,
            messages: [
              makeMessageRow({
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd42',
                body: 'Fresh sid-2 message',
              }),
            ],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
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
      <MemoryRouter initialEntries={[`/channels/${CONV_LAUNCH}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    // Wait until sid-1's conversation_history request is in flight.
    await waitFor(() => {
      expect(
        harness.fetchCalls.some(
          (c) =>
            (c.body as { resource?: string })?.resource === 'conversation_history' &&
            c.authHeader === `Bearer ${token1}`,
        ),
      ).toBe(true);
    });

    // Same-person new sign-in (same userId, new session_id sid-2) while history read is held!
    activeToken = token2;
    void activeToken;
    act(() => {
      harness.emitAuthChange('SIGNED_IN', session2);
    });

    // Current-login (sid-2) control loads and paints cleanly.
    await waitFor(() => {
      expect(screen.getByText('Fresh sid-2 message')).toBeInTheDocument();
    });

    // Now resolve sid-1's held history read with old private message -> discarded!
    await act(async () => {
      heldSid1History.resolve(
        jsonResponse({
          conversation: launchConv,
          messages: [
            makeMessageRow({
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd41',
              body: 'STALE SID-1 SECRET',
            }),
          ],
          has_more: false,
          next_before: null,
          next_after: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('STALE SID-1 SECRET')).not.toBeInTheDocument();
    expect(screen.getByText('Fresh sid-2 message')).toBeInTheDocument();
    const cachedText = JSON.stringify(
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cachedText).not.toContain('STALE SID-1 SECRET');

    // Now test held history read across sign-out -> writes zero cache, paints nothing.
    const heldBeforeSignOut = createDeferred<Response>();
    const signOutHarness = createFakeSessionHarness(session1, {
      ...makeStandardFromAndRpc(nowIso),
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [launchConv] });
        }
        if (body.resource === 'conversation_history') {
          return heldBeforeSignOut.promise;
        }
        return jsonResponse({}, 404);
      },
    });
    const qc2 = createAppQueryClient();
    const gate2 = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => signOutHarness.browserSession,
      fetchImpl: signOutHarness.fetchImpl,
    });
    const ctrl2 = createDataController(gate2, qc2);

    const view2 = render(
      <MemoryRouter initialEntries={[`/channels/${CONV_LAUNCH}`]}>
        <AppRoutes controller={ctrl2} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        signOutHarness.fetchCalls.some(
          (c) => (c.body as { resource?: string })?.resource === 'conversation_history',
        ),
      ).toBe(true);
    });

    act(() => {
      signOutHarness.emitAuthChange('SIGNED_OUT', null);
    });
    expect(qc2.getQueryCache().getAll()).toHaveLength(0);

    await act(async () => {
      heldBeforeSignOut.resolve(
        jsonResponse({
          conversation: launchConv,
          messages: [makeMessageRow({ body: 'POST-SIGNOUT LEAK' })],
          has_more: false,
          next_before: null,
          next_after: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(qc2.getQueryCache().getAll()).toHaveLength(0);
    expect(view2.container.textContent).not.toContain('POST-SIGNOUT LEAK');

    // Held history read across conversation loss -> writes zero cache, paints nothing.
    const heldBeforeLoss = createDeferred<Response>();
    const privConv = makeConversationRow({
      conversation_id: CONV_PRIVATE,
      kind: 'private_channel',
      channel_id: CONV_PRIVATE,
      slug: 'secret',
    });
    let includePrivate = true;
    const lossHarness = createFakeSessionHarness(session1, {
      ...makeStandardFromAndRpc(nowIso),
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: includePrivate ? [privConv] : [] });
        }
        if (body.resource === 'conversation_history') {
          return heldBeforeLoss.promise;
        }
        return jsonResponse({}, 404);
      },
    });
    const qc3 = createAppQueryClient();
    const gate3 = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => lossHarness.browserSession,
      fetchImpl: lossHarness.fetchImpl,
    });
    const ctrl3 = createDataController(gate3, qc3);

    const view3 = render(
      <MemoryRouter initialEntries={[`/channels/${CONV_PRIVATE}`]}>
        <AppRoutes controller={ctrl3} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        lossHarness.fetchCalls.some(
          (c) => (c.body as { resource?: string })?.resource === 'conversation_history',
        ),
      ).toBe(true);
    });

    // Fresh conversations list omits private channel -> retires synchronously!
    includePrivate = false;
    const lg = gate3.loginGeneration;
    const wg = gate3.fenceTracker.getWorkspaceGeneration(WS_1);
    await act(async () => {
      await qc3.refetchQueries({
        queryKey: queryKeys.workspaceConversations(lg, WS_1, wg),
      });
    });

    expect(within(view3.container).getByTestId('conversation-unavailable')).toHaveTextContent(
      CONVERSATION_UNAVAILABLE_TEXT,
    );

    await act(async () => {
      heldBeforeLoss.resolve(
        jsonResponse({
          conversation: privConv,
          messages: [makeMessageRow({ body: 'REVOKED CHANNEL LEAK' })],
          has_more: false,
          next_before: null,
          next_after: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view3.container.textContent).not.toContain('REVOKED CHANNEL LEAK');
    const cached3 = JSON.stringify(
      qc3.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cached3).not.toContain('REVOKED CHANNEL LEAK');

    allWireCalls.push(
      ...harness.wireCalls,
      ...signOutHarness.wireCalls,
      ...lossHarness.wireCalls,
    );
    controller.dispose();
    gate.dispose();
    ctrl2.dispose();
    gate2.dispose();
    ctrl3.dispose();
    gate3.dispose();
  });

  it('access loss (404 conversation_not_found) while conversation is open retires messages, cursors, and scroll state synchronously and shows uniform unavailable', async () => {
    const nowIso = '2026-11-23T12:00:00.000Z';
    const session = makeFakeSession({ userId: USER_1, sessionId: 'sid-1' });
    const privConv = makeConversationRow({
      conversation_id: CONV_PRIVATE,
      kind: 'private_channel',
      channel_id: CONV_PRIVATE,
      slug: 'vault',
    });
    let lostAccess = false;

    const harness = createFakeSessionHarness(session, {
      ...makeStandardFromAndRpc(nowIso),
      enableRealtime: true,
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [privConv] });
        }
        if (body.resource === 'conversation_history') {
          if (lostAccess) {
            return jsonResponse(
              {
                error: 'conversation_not_found',
                message: CONVERSATION_UNAVAILABLE_TEXT,
              },
              404,
            );
          }
          return jsonResponse({
            conversation: privConv,
            messages: [
              makeMessageRow({
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd50',
                body: 'Confidential vault message',
              }),
            ],
            has_more: true,
            next_before: {
              created_at: '2026-11-23T10:31:00.000Z',
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd50',
            },
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
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
      <MemoryRouter initialEntries={[`/channels/${CONV_PRIVATE}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Confidential vault message')).toBeInTheDocument();
    });

    // Now the server revokes access: scrolling up triggers older-page read -> 404 conversation_not_found!
    lostAccess = true;
    const listEl = screen.getByTestId('message-list');
    listEl.scrollTop = 0;
    fireEvent.scroll(listEl);

    await waitFor(() => {
      expect(screen.getByTestId('conversation-unavailable')).toHaveTextContent(
        CONVERSATION_UNAVAILABLE_TEXT,
      );
    });
    expect(screen.queryByText('Confidential vault message')).not.toBeInTheDocument();
    const cached = JSON.stringify(
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cached).not.toContain('Confidential vault message');

    allWireCalls.push(...harness.wireCalls);
    controller.dispose();
    gate.dispose();
  });

  it('pagehide tears down subscriptions synchronously and nothing resubscribes or fetches before pageshow; quiesce holds no socket', async () => {
    const nowIso = '2026-11-23T12:00:00.000Z';
    const session = makeFakeSession({ userId: USER_1, sessionId: 'sid-1' });
    const launchConv = makeConversationRow();

    const harness = createFakeSessionHarness(session, {
      ...makeStandardFromAndRpc(nowIso),
      enableRealtime: true,
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [launchConv] });
        }
        if (body.resource === 'conversation_history') {
          return jsonResponse({
            conversation: launchConv,
            messages: [makeMessageRow({ body: 'Visible before pagehide' })],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
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
      <MemoryRouter initialEntries={[`/channels/${CONV_LAUNCH}`]}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Visible before pagehide')).toBeInTheDocument();
      expect(harness.realtime!.activeChannels()).toHaveLength(2);
    });
    expect(harness.realtime!.connected).toBe(true);

    const oldChannels = [...harness.realtime!.activeChannels()];
    const channelsTotalBeforeHide = harness.realtime!.channels.length;

    // Dispatch pagehide synchronously (without act) -> subscriptions torn down & socket disconnected BEFORE return!
    window.dispatchEvent(new Event('pagehide'));
    expect(harness.realtime!.activeChannels()).toHaveLength(0);
    expect(harness.realtime!.connected).toBe(false);
    expect(screen.queryByText('Visible before pagehide')).not.toBeInTheDocument();

    const wireCountAtHide = harness.wireCalls.length;

    // Between pagehide and pageshow: late hints, visibilitychange, and auth notifications MUST NOT resubscribe or fetch.
    await act(async () => {
      for (const ch of oldChannels) {
        ch.emitBroadcast({ v: 1 });
      }
      document.dispatchEvent(new Event('visibilitychange'));
      harness.emitAuthChange('SIGNED_IN', session);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.realtime!.activeChannels()).toHaveLength(0);
    expect(harness.realtime!.channels.length).toBe(channelsTotalBeforeHide);
    expect(harness.wireCalls.length).toBe(wireCountAtHide);

    // Now dispatch persisted pageshow -> re-verifies, re-fetches, and re-subscribes cleanly.
    const pageshowEvent = new Event('pageshow');
    Object.defineProperty(pageshowEvent, 'persisted', { value: true });
    act(() => {
      window.dispatchEvent(pageshowEvent);
    });

    await waitFor(() => {
      expect(screen.getByText('Visible before pagehide')).toBeInTheDocument();
      expect(harness.realtime!.activeChannels()).toHaveLength(2);
    });

    allWireCalls.push(...harness.wireCalls);
    controller.dispose();
    gate.dispose();

    // Real pinned SDK quiesce() teardown proof: opening a channel on client.realtime then calling quiesce() removes channels and disconnects socket.
    const originalFetch = globalThis.fetch;
    const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    try {
      Object.defineProperty(globalThis.navigator, 'locks', {
        configurable: true,
        value: {
          async request(name: string, _opts: unknown, cb: (l: { name: string }) => unknown) {
            return cb({ name });
          },
        },
      });
      const storageKey = sessionStorageKeyForDeployment(DEPLOY_URL);
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          ...session,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      );
      globalThis.fetch = (async () =>
        jsonResponse({ id: USER_1, aud: 'authenticated' })) as typeof fetch;

      const realSession = createBrowserSession({
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
      expect(realSession.ok).toBe(true);
      if (realSession.ok) {
        // Confirm real SDK's Realtime endpoint matches wss://api.commonswarm.com!
        expect(
          realtimeEndpointMatchesApiOrigin(
            realSession.client as unknown as Parameters<
              typeof realtimeEndpointMatchesApiOrigin
            >[0],
            DEPLOY_URL,
          ),
        ).toBe(true);

        const removeAllSpy = vi
          .spyOn(realSession.client, 'removeAllChannels')
          .mockResolvedValue([]);
        vi.spyOn(realSession.client, 'getChannels').mockReturnValue([
          {} as ReturnType<typeof realSession.client.getChannels>[number],
        ]);
        await realSession.quiesce();
        expect(removeAllSpy).toHaveBeenCalled();
      }
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.clear();
      if (originalLocks) {
        Object.defineProperty(globalThis.navigator, 'locks', originalLocks);
      } else {
        delete (globalThis.navigator as { locks?: unknown }).locks;
      }
    }
  });

  it('C1: current 404 with a held body or malformed body on realtime refresh retires a populated conversation immediately; late old-login 404 leaves successor alone', async () => {
    const nowIso = '2026-11-23T12:00:00.000Z';
    const privConv = makeConversationRow({
      conversation_id: CONV_PRIVATE,
      kind: 'private_channel',
      channel_id: CONV_PRIVATE,
      slug: 'vault-c1',
    });

    // --- Part A: 404 with HELD body (never-resolving stream / .json()) retires immediately ---
    const sessionA = makeFakeSession({ userId: USER_1, sessionId: 'sid-c1-a' });
    let phaseA: 'initial' | 'held_404' = 'initial';
    let heldBodyJsonCalls = 0;

    const harnessA = createFakeSessionHarness(sessionA, {
      ...makeStandardFromAndRpc(nowIso),
      enableRealtime: true,
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [privConv] });
        }
        if (body.resource === 'conversation_history') {
          if (phaseA === 'held_404') {
            const heldStream = new ReadableStream<Uint8Array>({
              start() {
                // Intentionally never enqueue or close: simulates a stalled 404 body.
              },
            });
            const resp = new Response(heldStream, {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
            const origJson = resp.json.bind(resp);
            resp.json = () => {
              heldBodyJsonCalls += 1;
              return origJson();
            };
            return resp;
          }
          return jsonResponse({
            conversation: privConv,
            messages: [
              makeMessageRow({
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd60',
                body: 'Populated message before held 404',
              }),
            ],
            has_more: true,
            next_before: {
              created_at: '2026-11-23T10:31:00.000Z',
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd60',
            },
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
      },
    });

    const qcA = createAppQueryClient();
    const gateA = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harnessA.browserSession,
      fetchImpl: harnessA.fetchImpl,
    });
    const ctrlA = createDataController(gateA, qcA);

    const viewA = render(
      <MemoryRouter initialEntries={[`/channels/${CONV_PRIVATE}`]}>
        <AppRoutes controller={ctrlA} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        within(viewA.container).getByText('Populated message before held 404'),
      ).toBeInTheDocument();
      expect(harnessA.realtime!.activeChannels()).toHaveLength(2);
    });
    act(() => {
      harnessA.realtime!.emitStatus('SUBSCRIBED');
    });

    // Realtime refresh hits HTTP 404 with a held body -> retires immediately WITHOUT reading JSON!
    phaseA = 'held_404';
    act(() => {
      harnessA.realtime!.emitHint({ v: 1 }, 'cswarm-member:');
    });

    await waitFor(() => {
      expect(
        within(viewA.container).getByTestId('conversation-unavailable'),
      ).toHaveTextContent(CONVERSATION_UNAVAILABLE_TEXT);
    });
    expect(heldBodyJsonCalls).toBe(0);
    expect(
      within(viewA.container).queryByText('Populated message before held 404'),
    ).not.toBeInTheDocument();
    const cachedA = JSON.stringify(
      qcA.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cachedA).not.toContain('Populated message before held 404');
    expect(cachedA).not.toContain('dddddddd-dddd-4ddd-8ddd-dddddddddd60');

    allWireCalls.push(...harnessA.wireCalls);
    viewA.unmount();
    ctrlA.dispose();
    gateA.dispose();
    resetAppStore();

    // --- Part B: 404 with MALFORMED body retires immediately ---
    const sessionB = makeFakeSession({ userId: USER_1, sessionId: 'sid-c1-b' });
    let phaseB: 'initial' | 'malformed_404' = 'initial';

    const harnessB = createFakeSessionHarness(sessionB, {
      ...makeStandardFromAndRpc(nowIso),
      enableRealtime: true,
      onFetch(_input, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [privConv] });
        }
        if (body.resource === 'conversation_history') {
          if (phaseB === 'malformed_404') {
            return new Response('<html>not valid json {{{', {
              status: 404,
              headers: { 'content-type': 'text/html' },
            });
          }
          return jsonResponse({
            conversation: privConv,
            messages: [
              makeMessageRow({
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd61',
                body: 'Populated message before malformed 404',
              }),
            ],
            has_more: true,
            next_before: {
              created_at: '2026-11-23T10:31:00.000Z',
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd61',
            },
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
      },
    });

    const qcB = createAppQueryClient();
    const gateB = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harnessB.browserSession,
      fetchImpl: harnessB.fetchImpl,
    });
    const ctrlB = createDataController(gateB, qcB);

    const viewB = render(
      <MemoryRouter initialEntries={[`/channels/${CONV_PRIVATE}`]}>
        <AppRoutes controller={ctrlB} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        within(viewB.container).getByText('Populated message before malformed 404'),
      ).toBeInTheDocument();
      expect(harnessB.realtime!.activeChannels()).toHaveLength(2);
    });
    act(() => {
      harnessB.realtime!.emitStatus('SUBSCRIBED');
    });

    phaseB = 'malformed_404';
    act(() => {
      harnessB.realtime!.emitHint({ v: 1 }, 'cswarm-member:');
    });

    await waitFor(() => {
      expect(
        within(viewB.container).getByTestId('conversation-unavailable'),
      ).toHaveTextContent(CONVERSATION_UNAVAILABLE_TEXT);
    });
    expect(
      within(viewB.container).queryByText('Populated message before malformed 404'),
    ).not.toBeInTheDocument();
    const cachedB = JSON.stringify(
      qcB.getQueryCache().getAll().map((q) => q.state.data),
    );
    expect(cachedB).not.toContain('Populated message before malformed 404');
    expect(cachedB).not.toContain('dddddddd-dddd-4ddd-8ddd-dddddddddd61');

    allWireCalls.push(...harnessB.wireCalls);
    viewB.unmount();
    ctrlB.dispose();
    gateB.dispose();
    resetAppStore();

    // --- Part C: Late 404 from an old login leaves successor alone + current-login control ---
    const tokenOld = makeFakeJwt({ sub: USER_1, session_id: 'sid-c1-old', jti: 'c1-1' });
    const tokenNew = makeFakeJwt({ sub: USER_1, session_id: 'sid-c1-new', jti: 'c1-2' });
    const sessionOld = makeFakeSession({
      userId: USER_1,
      sessionId: 'sid-c1-old',
      accessToken: tokenOld,
    });
    const sessionNew = makeFakeSession({
      userId: USER_1,
      sessionId: 'sid-c1-new',
      accessToken: tokenNew,
    });

    const heldOldLogin404 = createDeferred<Response>();
    let sid2RefreshVersion = 1;
    let sid2FailWith404 = false;

    const harnessC = createFakeSessionHarness(sessionOld, {
      ...makeStandardFromAndRpc(nowIso),
      enableRealtime: true,
      onFetch(_input, init) {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [privConv] });
        }
        if (body.resource === 'conversation_history') {
          if (headers.get('authorization') === `Bearer ${tokenOld}`) {
            return heldOldLogin404.promise;
          }
          if (sid2FailWith404) {
            return new Response('corrupt 404 body', { status: 404 });
          }
          return jsonResponse({
            conversation: privConv,
            messages: [
              makeMessageRow({
                id: `dddddddd-dddd-4ddd-8ddd-dddddddddd7${sid2RefreshVersion}`,
                body:
                  sid2RefreshVersion === 1
                    ? 'Successor sid-2 initial message'
                    : 'Successor sid-2 live refreshed message',
              }),
            ],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
      },
    });

    const qcC = createAppQueryClient();
    const gateC = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => harnessC.browserSession,
      fetchImpl: harnessC.fetchImpl,
    });
    const ctrlC = createDataController(gateC, qcC);

    const viewC = render(
      <MemoryRouter initialEntries={[`/channels/${CONV_PRIVATE}`]}>
        <AppRoutes controller={ctrlC} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        harnessC.fetchCalls.some(
          (c) =>
            (c.body as { resource?: string })?.resource === 'conversation_history' &&
            c.authHeader === `Bearer ${tokenOld}`,
        ),
      ).toBe(true);
    });

    // Switch to new login (sid-c1-new) while old login's history request is held.
    act(() => {
      harnessC.emitAuthChange('SIGNED_IN', sessionNew);
    });

    await waitFor(() => {
      expect(
        within(viewC.container).getByText('Successor sid-2 initial message'),
      ).toBeInTheDocument();
      expect(harnessC.realtime!.activeChannels()).toHaveLength(2);
    });
    act(() => {
      harnessC.realtime!.emitStatus('SUBSCRIBED');
    });

    // Now settle old login's held request with a malformed HTTP 404 -> MUST leave successor alone!
    await act(async () => {
      heldOldLogin404.resolve(new Response('not json 404', { status: 404 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      within(viewC.container).queryByTestId('conversation-unavailable'),
    ).not.toBeInTheDocument();
    expect(
      within(viewC.container).getByText('Successor sid-2 initial message'),
    ).toBeInTheDocument();

    // Current-login control: successor still receives live updates and then retires on its OWN 404.
    sid2RefreshVersion = 2;
    act(() => {
      harnessC.realtime!.emitHint({ v: 1 }, 'cswarm-member:');
    });
    await waitFor(() => {
      expect(
        within(viewC.container).getByText('Successor sid-2 live refreshed message'),
      ).toBeInTheDocument();
    });

    sid2FailWith404 = true;
    act(() => {
      harnessC.realtime!.emitHint({ v: 1 }, 'cswarm-member:');
    });
    await waitFor(() => {
      expect(
        within(viewC.container).getByTestId('conversation-unavailable'),
      ).toHaveTextContent(CONVERSATION_UNAVAILABLE_TEXT);
    });

    allWireCalls.push(...harnessC.wireCalls);
    viewC.unmount();
    ctrlC.dispose();
    gateC.dispose();
  });

  it('C2: per-generation RealtimeClient retires queued outbound frames while CONNECTING, delivers successor hints & token refreshes, handles same-workspace quick return with held leave/close, and cleans up second-attach failures', async () => {
    interface SentFrame {
      joinRef: string | null;
      ref: string | null;
      topic: string;
      event: string;
      payload: Record<string, unknown>;
    }

    const sockets: MockPhoenixSocket[] = [];
    let holdSocketOpen = false;
    let holdSocketClose = false;
    const heldCloses: Array<() => void> = [];

    class MockPhoenixSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;

      readyState = MockPhoenixSocket.CONNECTING;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      readonly sent: SentFrame[] = [];
      closeCalls = 0;

      constructor(public readonly url: string | URL) {
        sockets.push(this);
        if (!holdSocketOpen) {
          queueMicrotask(() => this.open());
        }
      }

      open(): void {
        if (this.readyState !== MockPhoenixSocket.CONNECTING) return;
        this.readyState = MockPhoenixSocket.OPEN;
        this.onopen?.(new Event('open'));
      }

      send(data: string | ArrayBuffer): void {
        if (typeof data !== 'string') return;
        const [joinRef, ref, topic, event, payload] = JSON.parse(data) as [
          string | null,
          string | null,
          string,
          string,
          Record<string, unknown>,
        ];
        const frame: SentFrame = { joinRef, ref, topic, event, payload };
        this.sent.push(frame);

        if (event === 'phx_join' || event === 'phx_leave') {
          queueMicrotask(() => {
            this.deliverFromServer([
              joinRef,
              ref,
              topic,
              'phx_reply',
              { status: 'ok', response: {} },
            ]);
          });
        }
      }

      deliverFromServer(tuple: unknown[]): void {
        if (this.readyState !== MockPhoenixSocket.OPEN) return;
        this.onmessage?.({ data: JSON.stringify(tuple) } as MessageEvent);
      }

      close(code = 1000, reason = ''): void {
        this.closeCalls += 1;
        if (this.readyState === MockPhoenixSocket.CLOSED) return;
        if (holdSocketClose) {
          this.readyState = MockPhoenixSocket.CLOSING;
          heldCloses.push(() => {
            if (this.readyState === MockPhoenixSocket.CLOSED) return;
            this.readyState = MockPhoenixSocket.CLOSED;
            this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
          });
          return;
        }
        this.readyState = MockPhoenixSocket.CLOSED;
        this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
      }
    }

    const tokenA = makeFakeJwt({ sub: USER_1, session_id: 'sid-c2-a', jti: 'c2-a' });
    const sessionA = makeFakeSession({
      userId: USER_1,
      sessionId: 'sid-c2-a',
      accessToken: tokenA,
    });
    const tokenB = makeFakeJwt({ sub: USER_2, session_id: 'sid-c2-b', jti: 'c2-b' });
    const sessionB = makeFakeSession({
      userId: USER_2,
      sessionId: 'sid-c2-b',
      accessToken: tokenB,
    });
    const tokenBRefreshed = makeFakeJwt({
      sub: USER_2,
      session_id: 'sid-c2-b',
      jti: 'c2-b-refreshed',
    });
    const sessionBRefreshed = makeFakeSession({
      userId: USER_2,
      sessionId: 'sid-c2-b',
      accessToken: tokenBRefreshed,
    });

    let activeSession = sessionA;
    const authListeners = new Set<
      (
        event: 'SIGNED_IN' | 'TOKEN_REFRESHED' | 'SIGNED_OUT',
        session: typeof sessionA | null,
      ) => void
    >();

    // Real pinned @supabase/supabase-js (2.111.0) + @supabase/realtime-js (2.111.0) client!
    const realClient = createClient(DEPLOY_URL, ANON_KEY, {
      auth: {
        storageKey: 'sb-c2-real-test',
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        transport: MockPhoenixSocket as unknown as NonNullable<
          Parameters<typeof createClient>[2]
        >['realtime'] extends { transport?: infer T }
          ? T
          : never,
        heartbeatIntervalMs: 60_000,
      },
    });
    vi.spyOn(realClient.auth, 'getSession').mockImplementation(async () => ({
      data: { session: activeSession },
      error: null,
    }));
    vi.spyOn(realClient.auth, 'onAuthStateChange').mockImplementation((cb) => {
      const listener = cb as unknown as (
        event: 'SIGNED_IN' | 'TOKEN_REFRESHED' | 'SIGNED_OUT',
        session: typeof sessionA | null,
      ) => void;
      authListeners.add(listener);
      return {
        data: {
          subscription: {
            id: 'test-sub',
            callback: cb,
            unsubscribe() {
              authListeners.delete(listener);
            },
          },
        },
      };
    });

    const realBrowserSession = {
      ok: true as const,
      client: realClient,
      storageKey: 'sb-c2-real-test',
      async currentSession() {
        return activeSession;
      },
      async verifiedSession() {
        return activeSession;
      },
      async boundedAuth<T>(op: Promise<T>) {
        return op;
      },
      async signOut() {
        return { signedOutLocally: true, serverRevoked: true, replaced: false, retry: false };
      },
      async quiesce() {
        await realClient.removeAllChannels();
      },
    };

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => realBrowserSession,
    });
    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    gate.fenceTracker.setActiveWorkspace(WS_1);

    // Track every generation's dedicated RealtimeClient instance via the pinned prototype.
    const generationClients: RealtimeClient[] = [];
    const origProtoChannel = RealtimeClient.prototype.channel;
    const trackClientSpy = vi
      .spyOn(RealtimeClient.prototype, 'channel')
      .mockImplementation(function (
        this: RealtimeClient,
        name: string,
        opts?: Parameters<RealtimeClient['channel']>[1],
      ) {
        if (!generationClients.includes(this)) {
          generationClients.push(this);
        }
        return origProtoChannel.call(this, name, opts);
      });

    // --- Witness 1 & 2: Retire while CONNECTING (replacement login), then open all sockets ---
    holdSocketOpen = true;
    let loginARefreshes = 0;
    const loginAManager = createWorkspaceLiveManager({
      sessionGate: gate,
      workspaceId: WS_1,
      onRefresh: () => {
        loginARefreshes += 1;
      },
    });
    const unsubPurgeA = gate.onLoginPurge(() => {
      loginAManager.dispose();
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
      expect(generationClients).toHaveLength(1);
    });
    const rtLoginA = generationClients[0]!;
    const socketLoginA = sockets[0]!;
    expect(rtLoginA).not.toBe(realClient.realtime);
    expect(realClient.getChannels()).toHaveLength(0);
    expect(socketLoginA.readyState).toBe(MockPhoenixSocket.CONNECTING);
    expect(socketLoginA.sent).toHaveLength(0);
    // Confirm generation 1 actually queued its 2 private join frames while CONNECTING!
    expect(rtLoginA.sendBuffer.length).toBeGreaterThanOrEqual(2);

    // Retire generation 1 via a replacement login (login B) BEFORE socketLoginA opens.
    activeSession = sessionB;
    for (const listener of [...authListeners]) {
      listener('SIGNED_IN', sessionB);
    }
    unsubPurgeA();

    // Synchronously on retirement: gen 1's sendBuffer is cleared and its connecting socket closed.
    expect(rtLoginA.sendBuffer).toHaveLength(0);
    expect(socketLoginA.readyState).toBe(MockPhoenixSocket.CLOSED);

    await waitFor(() => {
      expect(gate.state).toEqual({ status: 'authenticated' });
      expect(gate.userId).toBe(USER_2);
    });
    gate.fenceTracker.setActiveWorkspace(WS_1);

    // Generation 2 starts for login B in the same workspace W (socket also starts CONNECTING).
    let loginBRefreshes = 0;
    const loginBManager = createWorkspaceLiveManager({
      sessionGate: gate,
      workspaceId: WS_1,
      onRefresh: () => {
        loginBRefreshes += 1;
      },
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
      expect(generationClients).toHaveLength(2);
    });
    const rtLoginB = generationClients[1]!;
    const socketLoginB = sockets[1]!;
    expect(rtLoginB).not.toBe(rtLoginA);
    expect(rtLoginB).not.toBe(realClient.realtime);
    expect(socketLoginB.readyState).toBe(MockPhoenixSocket.CONNECTING);

    // Now let ALL sockets open.
    holdSocketOpen = false;
    for (const s of [...sockets]) {
      s.open();
    }

    await waitFor(() => {
      expect(loginBManager.subscribed).toBe(true);
    });

    // Assert over EVERY frame sent on EVERY socket so far:
    // ZERO frames carry generation 1's topic or login A's bearer;
    // generation 2's joins carry ONLY generation 2's topics and login B's bearer!
    const allWitness1Frames = sockets.flatMap((s) => s.sent);
    expect(allWitness1Frames.filter((f) => f.topic.includes(USER_1))).toEqual([]);
    expect(
      allWitness1Frames.filter((f) => JSON.stringify(f.payload).includes(tokenA)),
    ).toEqual([]);
    const witness1Joins = allWitness1Frames.filter((f) => f.event === 'phx_join');
    expect(witness1Joins.map((f) => f.topic).sort()).toEqual([
      `realtime:cswarm-member:${WS_1}:${USER_2}`,
      `realtime:cswarm-signals:${WS_1}`,
    ]);
    for (const f of witness1Joins) {
      expect(f.payload.access_token).toBe(tokenB);
    }

    // Witness 2: generation 2 receives its own broadcast hint and triggers its refresh.
    socketLoginB.deliverFromServer([
      null,
      null,
      `realtime:cswarm-member:${WS_1}:${USER_2}`,
      'broadcast',
      { type: 'broadcast', event: 'signal', payload: { v: 1 } },
    ]);
    await waitFor(() => {
      expect(loginBRefreshes).toBe(1);
    });
    expect(loginARefreshes).toBe(0);

    // In-generation token refresh: rotating login B's bearer updates rtLoginB in place via fenced acquisition.
    activeSession = sessionBRefreshed;
    for (const listener of [...authListeners]) {
      listener('TOKEN_REFRESHED', sessionBRefreshed);
    }
    await waitFor(() => {
      const authFrames = socketLoginB.sent.filter((f) => f.event === 'access_token');
      expect(authFrames.length).toBeGreaterThanOrEqual(2);
      for (const f of authFrames) {
        expect(f.payload.access_token).toBe(tokenBRefreshed);
      }
    });
    expect(
      sockets.flatMap((s) => s.sent).filter((f) => JSON.stringify(f.payload).includes(tokenA)),
    ).toEqual([]);

    // Hint still works after in-generation token refresh.
    socketLoginB.deliverFromServer([
      null,
      null,
      `realtime:cswarm-member:${WS_1}:${USER_2}`,
      'broadcast',
      { type: 'broadcast', event: 'signal', payload: { v: 1 } },
    ]);
    await waitFor(() => {
      expect(loginBRefreshes).toBe(2);
    });

    loginBManager.dispose();
    await waitFor(() => {
      expect(rtLoginB.getChannels()).toHaveLength(0);
      expect(socketLoginB.readyState).toBe(MockPhoenixSocket.CLOSED);
    });

    // --- Witness 3: Held leave + held socket close with immediate return to the SAME workspace ---
    const socketsBeforeW3 = sockets.length;
    const clientsBeforeW3 = generationClients.length;
    let gen1Refreshes = 0;
    const gen1 = createWorkspaceLiveManager({
      sessionGate: gate,
      workspaceId: WS_1,
      onRefresh: () => {
        gen1Refreshes += 1;
      },
    });

    await waitFor(() => {
      expect(gen1.subscribed).toBe(true);
      expect(generationClients.length).toBe(clientsBeforeW3 + 1);
      expect(sockets.length).toBe(socketsBeforeW3 + 1);
    });
    const rt1 = generationClients[clientsBeforeW3]!;
    const oldChannels = [...rt1.getChannels()];
    expect(oldChannels).toHaveLength(2);
    const socket1 = sockets[socketsBeforeW3]!;
    expect(socket1.readyState).toBe(MockPhoenixSocket.OPEN);

    // Hold both channels' unsubscribe() AND hold socket1.close() in WebSocket.CLOSING.
    const leaveGates = oldChannels.map((ch) => {
      const gateDeferred = createDeferred<void>();
      const origUnsubscribe = ch.unsubscribe.bind(ch);
      vi.spyOn(ch, 'unsubscribe').mockImplementation(async (timeout?: number) => {
        await gateDeferred.promise;
        return origUnsubscribe(timeout);
      });
      return gateDeferred;
    });
    holdSocketClose = true;

    gen1.dispose();

    // Callbacks are ALREADY retired synchronously: a broadcast on the retiring socket does nothing.
    socket1.deliverFromServer([
      null,
      null,
      `realtime:cswarm-member:${WS_1}:${USER_2}`,
      'broadcast',
      { type: 'broadcast', event: 'signal', payload: { v: 1 } },
    ]);
    await Promise.resolve();
    expect(gen1Refreshes).toBe(0);

    // Immediately return to the SAME workspace while gen1's leave & close are STILL held!
    let gen2Refreshes = 0;
    const gen2 = createWorkspaceLiveManager({
      sessionGate: gate,
      workspaceId: WS_1,
      onRefresh: () => {
        gen2Refreshes += 1;
      },
    });

    // Gen2 attaches BRAND NEW channels on its own fresh RealtimeClient & socket immediately!
    await waitFor(() => {
      expect(gen2.subscribed).toBe(true);
      expect(generationClients.length).toBe(clientsBeforeW3 + 2);
      expect(sockets.length).toBe(socketsBeforeW3 + 2);
    });

    const rt2 = generationClients[clientsBeforeW3 + 1]!;
    const newChannels = [...rt2.getChannels()];
    expect(rt2).not.toBe(rt1);
    expect(newChannels).toHaveLength(2);
    expect(newChannels[0]).not.toBe(oldChannels[0]);
    expect(newChannels[1]).not.toBe(oldChannels[1]);
    const socket2 = sockets[socketsBeforeW3 + 1]!;
    expect(socket2).not.toBe(socket1);
    expect(socket2.readyState).toBe(MockPhoenixSocket.OPEN);

    // Release gen1's held channel unsubscribes while socket1.close() stays in CLOSING.
    for (const d of leaveGates) {
      d.resolve();
    }
    await waitFor(() => {
      expect(rt1.getChannels()).toHaveLength(0);
      expect(socket1.sent.filter((f) => f.event === 'phx_leave')).toHaveLength(2);
      expect(socket1.readyState).toBe(MockPhoenixSocket.CLOSING);
    });

    // Complete socket1's close handshake; gen2's socket and channels remain completely untouched!
    holdSocketClose = false;
    for (const finishClose of heldCloses.splice(0)) {
      finishClose();
    }
    await waitFor(() => {
      expect(socket1.readyState).toBe(MockPhoenixSocket.CLOSED);
    });

    // Stale teardown safety: calling teardown/dispose again on retired gen1 cannot touch gen2.
    gen1.teardown({ disconnectSocket: true });
    gen1.dispose();
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }
    expect(rt2.getChannels()).toEqual(newChannels);
    expect(socket2.readyState).toBe(MockPhoenixSocket.OPEN);

    // Delivering a real broadcast hint on socket2 wakes gen2 (and NEVER gen1).
    socket2.deliverFromServer([
      null,
      null,
      `realtime:cswarm-member:${WS_1}:${USER_2}`,
      'broadcast',
      { type: 'broadcast', event: 'signal', payload: { v: 1 } },
    ]);
    await waitFor(() => {
      expect(gen2Refreshes).toBe(1);
    });
    expect(gen1Refreshes).toBe(0);
    expect(socket2.readyState).toBe(MockPhoenixSocket.OPEN);

    // Pagehide while socket2 close is held in CLOSING -> pageshow MUST NOT revive retired rt1 or rt2!
    const unsubPurgeGen2 = gate.onLoginPurge(() => {
      gen2.dispose();
    });
    holdSocketClose = true;
    const socketsBeforePageTransition = sockets.length;
    window.dispatchEvent(new Event('pagehide'));
    unsubPurgeGen2();
    holdSocketClose = false;
    for (const finishClose of heldCloses.splice(0)) {
      finishClose();
    }
    await waitFor(() => {
      expect(rt2.getChannels()).toHaveLength(0);
      expect(socket2.readyState).toBe(MockPhoenixSocket.CLOSED);
    });
    window.dispatchEvent(new Event('pageshow'));
    expect(sockets.length).toBe(socketsBeforePageTransition);

    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    gate.fenceTracker.setActiveWorkspace(WS_1);
    trackClientSpy.mockRestore();

    // --- Witness 4: Second-attach failure (both channel() throw and subscribe() throw) cleans up partial channels immediately before retry ---
    const w4Clients: RealtimeClient[] = [];
    let attachAttempt = 0;
    const partialSpy = vi
      .spyOn(RealtimeClient.prototype, 'channel')
      .mockImplementation(function (
        this: RealtimeClient,
        name: string,
        opts?: Parameters<RealtimeClient['channel']>[1],
      ) {
        if (!w4Clients.includes(this)) {
          w4Clients.push(this);
        }
        attachAttempt += 1;
        // Attempt 1 (channel 1 succeeds), attempt 2 (channel 2 throws on channel()).
        if (attachAttempt === 2) {
          throw new Error('simulated_second_channel_create_failure');
        }
        const ch = origProtoChannel.call(this, name, opts);
        // Attempt 3 (retry channel 1 succeeds), attempt 4 (retry channel 2 created, then throws on subscribe()).
        if (attachAttempt === 4) {
          vi.spyOn(ch, 'subscribe').mockImplementationOnce(() => {
            throw new Error('simulated_second_channel_subscribe_failure');
          });
        }
        return ch;
      });

    const backoffTimeouts: Array<() => void> = [];
    const deterministicTimers = {
      setInterval(_fn: () => void, _ms: number) {
        return 1;
      },
      clearInterval() {},
      setTimeout(fn: () => void, _ms: number) {
        backoffTimeouts.push(fn);
        return backoffTimeouts.length;
      },
      clearTimeout() {},
    };

    let gen3Refreshes = 0;
    const gen3 = createWorkspaceLiveManager({
      sessionGate: gate,
      workspaceId: WS_1,
      onRefresh: () => {
        gen3Refreshes += 1;
      },
      timers: deterministicTimers,
    });

    // Failure A: channel 1 created, channel 2 channel() throws -> channel 1 removed immediately, sendBuffer empty, retry scheduled!
    await waitFor(() => {
      expect(backoffTimeouts).toHaveLength(1);
      expect(w4Clients).toHaveLength(1);
      expect(w4Clients[0]!.getChannels()).toHaveLength(0);
      expect(w4Clients[0]!.sendBuffer).toHaveLength(0);
    });
    expect(gen3.subscribed).toBe(false);

    // Failure B: retry #1 creates channel 1 & channel 2, then channel 2 subscribe() throws -> BOTH channels removed immediately, sendBuffer empty!
    backoffTimeouts[0]!();
    await waitFor(() => {
      expect(backoffTimeouts).toHaveLength(2);
      expect(w4Clients).toHaveLength(2);
      expect(w4Clients[1]!.getChannels()).toHaveLength(0);
      expect(w4Clients[1]!.sendBuffer).toHaveLength(0);
    });
    expect(gen3.subscribed).toBe(false);

    // Retry #2: attaches cleanly on a fresh RealtimeClient and delivers hints!
    backoffTimeouts[1]!();
    await waitFor(() => {
      expect(gen3.subscribed).toBe(true);
      expect(w4Clients).toHaveLength(3);
      expect(w4Clients[2]!.getChannels()).toHaveLength(2);
    });

    const socket3 = sockets.at(-1)!;
    socket3.deliverFromServer([
      null,
      null,
      `realtime:cswarm-member:${WS_1}:${USER_2}`,
      'broadcast',
      { type: 'broadcast', event: 'signal', payload: { v: 1 } },
    ]);
    await waitFor(() => {
      expect(gen3Refreshes).toBe(1);
    });

    partialSpy.mockRestore();
    gen3.dispose();
    await waitFor(() => {
      expect(w4Clients[2]!.getChannels()).toHaveLength(0);
      expect(socket3.readyState).toBe(MockPhoenixSocket.CLOSED);
    });
    expect(realClient.getChannels()).toHaveLength(0);
    gate.dispose();
  });

  it('C2 listener disposal witness: every retired realtime generation removes its pinned Phoenix window listeners, clears stored bearer, and restores window.addEventListener identically', async () => {
    const TRACKED_EVENTS = ['pagehide', 'pageshow', 'visibilitychange'] as const;
    type TrackedEvent = (typeof TRACKED_EVENTS)[number];
    const isTrackedEvent = (type: string): type is TrackedEvent =>
      (TRACKED_EVENTS as readonly string[]).includes(type);

    // Pinned @supabase/phoenix@0.4.5 Socket constructor registers 3 anonymous window listeners:
    // pagehide (socket.js:102), pageshow (socket.js:108), visibilitychange (socket.js:114).
    const EXPECTED_LISTENERS_PER_SOCKET = 3;

    let holdSocketOpen = false;
    const sockets: MockPhoenixSocket[] = [];
    class MockPhoenixSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = MockPhoenixSocket.CONNECTING;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      readonly sent: Array<{ topic: string; event: string; payload: Record<string, unknown> }> = [];

      constructor(public readonly url: string | URL) {
        sockets.push(this);
        if (!holdSocketOpen) {
          queueMicrotask(() => this.open());
        }
      }

      open(): void {
        if (this.readyState !== MockPhoenixSocket.CONNECTING) return;
        this.readyState = MockPhoenixSocket.OPEN;
        this.onopen?.(new Event('open'));
      }

      send(data: string | ArrayBuffer): void {
        if (typeof data !== 'string') return;
        const [joinRef, ref, topic, event, payload] = JSON.parse(data) as [
          string | null,
          string | null,
          string,
          string,
          Record<string, unknown>,
        ];
        this.sent.push({ topic, event, payload });
        if (event === 'phx_join' || event === 'phx_leave') {
          queueMicrotask(() => {
            if (this.readyState !== MockPhoenixSocket.OPEN) return;
            this.onmessage?.({
              data: JSON.stringify([
                joinRef,
                ref,
                topic,
                'phx_reply',
                { status: 'ok', response: {} },
              ]),
            } as MessageEvent);
          });
        }
      }

      close(code = 1000, reason = ''): void {
        if (this.readyState === MockPhoenixSocket.CLOSED) return;
        this.readyState = MockPhoenixSocket.CLOSED;
        this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
      }
    }

    const token = makeFakeJwt({ sub: USER_1, session_id: 'sid-c2-listeners', jti: 'c2-l1' });
    const session = makeFakeSession({
      userId: USER_1,
      sessionId: 'sid-c2-listeners',
      accessToken: token,
    });

    const realClient = createClient(DEPLOY_URL, ANON_KEY, {
      auth: {
        storageKey: 'sb-c2-listener-witness',
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        transport: MockPhoenixSocket as unknown as NonNullable<
          Parameters<typeof createClient>[2]
        >['realtime'] extends { transport?: infer T }
          ? T
          : never,
        heartbeatIntervalMs: 60_000,
      },
    });
    vi.spyOn(realClient.auth, 'getSession').mockImplementation(async () => ({
      data: { session },
      error: null,
    }));
    vi.spyOn(realClient.auth, 'onAuthStateChange').mockImplementation((cb) => ({
      data: {
        subscription: {
          id: 'test-sub-listeners',
          callback: cb,
          unsubscribe() {},
        },
      },
    }));

    const realBrowserSession = {
      ok: true as const,
      client: realClient,
      storageKey: 'sb-c2-listener-witness',
      async currentSession() {
        return session;
      },
      async verifiedSession() {
        return session;
      },
      async boundedAuth<T>(op: Promise<T>) {
        return op;
      },
      async signOut() {
        return { signedOutLocally: true, serverRevoked: true, replaced: false, retry: false };
      },
      async quiesce() {
        await realClient.removeAllChannels();
      },
    };

    const gate = createSessionGate({
      runtimeConfig: { status: 'configured', url: DEPLOY_URL, anonKey: ANON_KEY },
      multiAccountEnabled: false,
      hasWebLocks: () => true,
      storage: createFakeStorage(),
      createSession: () => realBrowserSession,
    });
    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    gate.fenceTracker.setActiveWorkspace(WS_1);

    // Track every generation's RealtimeClient instance via setAuth (runs even if channel attach fails).
    const generationClients: RealtimeClient[] = [];
    const origProtoSetAuth = RealtimeClient.prototype.setAuth;
    const setAuthTrackSpy = vi
      .spyOn(RealtimeClient.prototype, 'setAuth')
      .mockImplementation(function (this: RealtimeClient, t?: string | null) {
        if (!generationClients.includes(this)) {
          generationClients.push(this);
        }
        return origProtoSetAuth.call(this, t);
      });

    // Establish baseline AFTER realClient + gate initialization.
    const activeByType: Record<TrackedEvent, Set<EventListenerOrEventListenerObject>> = {
      pagehide: new Set(),
      pageshow: new Set(),
      visibilitychange: new Set(),
    };
    const totalActiveCount = (): number =>
      activeByType.pagehide.size +
      activeByType.pageshow.size +
      activeByType.visibilitychange.size;

    let addedThisGen: Array<{ type: TrackedEvent; listener: EventListenerOrEventListenerObject }> = [];
    let removedThisGen: Array<{ type: TrackedEvent; listener: EventListenerOrEventListenerObject }> = [];
    let throwOnPageshowOnce = false;

    const origAddBound = window.addEventListener.bind(window);
    const origRemoveBound = window.removeEventListener.bind(window);

    const addSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (throwOnPageshowOnce && type === 'pageshow') {
          throwOnPageshowOnce = false;
          throw new Error('simulated_pageshow_add_failure');
        }
        if (isTrackedEvent(type) && listener) {
          activeByType[type].add(listener);
          addedThisGen.push({ type, listener });
        }
        return origAddBound(type, listener, options);
      });

    const removeSpy = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation((type, listener, options) => {
        if (isTrackedEvent(type) && listener) {
          activeByType[type].delete(listener);
          removedThisGen.push({ type, listener });
        }
        return origRemoveBound(type, listener, options);
      });

    const spiedWindowAdd = window.addEventListener;
    expect(totalActiveCount()).toBe(0);

    const assertExactAddedRemovedMatch = (
      added: ReadonlyArray<{ type: TrackedEvent; listener: EventListenerOrEventListenerObject }>,
      removed: ReadonlyArray<{ type: TrackedEvent; listener: EventListenerOrEventListenerObject }>,
    ) => {
      expect(added).toHaveLength(EXPECTED_LISTENERS_PER_SOCKET);
      expect(removed).toHaveLength(EXPECTED_LISTENERS_PER_SOCKET);
      for (const entry of added) {
        const matched = removed.some(
          (r) => r.type === entry.type && r.listener === entry.listener,
        );
        expect(matched).toBe(true);
      }
      expect(totalActiveCount()).toBe(0);
      expect(activeByType.pagehide.size).toBe(0);
      expect(activeByType.pageshow.size).toBe(0);
      expect(activeByType.visibilitychange.size).toBe(0);
      expect(window.addEventListener).toBe(spiedWindowAdd);
    };

    const deterministicTimers = () => {
      const timeouts: Array<() => void> = [];
      return {
        timeouts,
        timers: {
          setInterval(_fn: () => void, _ms: number) {
            return 1;
          },
          clearInterval() {},
          setTimeout(fn: () => void, _ms: number) {
            timeouts.push(fn);
            return timeouts.length;
          },
          clearTimeout() {},
        },
      };
    };

    // Cycle 10 generations in a row:
    // - Gen 1: normal subscribed -> retire
    // - Gen 2: retired while still CONNECTING
    // - Gen 3: second attach fails (partial channel attach throws) -> automatic retirement
    // - Gens 4..10: seven more full generations back to back
    const origProtoChannel = RealtimeClient.prototype.channel;
    for (let genIdx = 1; genIdx <= 10; genIdx += 1) {
      addedThisGen = [];
      removedThisGen = [];
      const clientsBefore = generationClients.length;
      const socketsBefore = sockets.length;

      if (genIdx === 2) {
        // Generation retired while still CONNECTING.
        holdSocketOpen = true;
        const manager = createWorkspaceLiveManager({
          sessionGate: gate,
          workspaceId: WS_1,
          onRefresh: () => {},
        });

        await waitFor(() => {
          expect(generationClients.length).toBe(clientsBefore + 1);
          expect(sockets.length).toBe(socketsBefore + 1);
        });
        expect(sockets.at(-1)!.readyState).toBe(MockPhoenixSocket.CONNECTING);
        expect(totalActiveCount()).toBe(EXPECTED_LISTENERS_PER_SOCKET);
        expect(activeByType.pagehide.size).toBe(1);
        expect(activeByType.pageshow.size).toBe(1);
        expect(activeByType.visibilitychange.size).toBe(1);
        expect(window.addEventListener).toBe(spiedWindowAdd);

        const rtClient = generationClients[clientsBefore]!;
        expect(rtClient.accessTokenValue).toBe(token);

        manager.dispose();
        await waitFor(() => {
          expect(sockets.at(-1)!.readyState).toBe(MockPhoenixSocket.CLOSED);
          expect(totalActiveCount()).toBe(0);
        });
        assertExactAddedRemovedMatch(addedThisGen, removedThisGen);
        expect(rtClient.accessTokenValue).toBeNull();
        expect(sockets.at(-1)!.sent).toEqual([]);

        holdSocketOpen = false;
        sockets.at(-1)!.open();
        expect(sockets.at(-1)!.sent).toEqual([]);
        continue;
      }

      if (genIdx === 3) {
        // Generation whose second attach fails.
        const dt = deterministicTimers();
        let callsInGen3 = 0;
        const failSecondSpy = vi
          .spyOn(RealtimeClient.prototype, 'channel')
          .mockImplementation(function (
            this: RealtimeClient,
            name: string,
            opts?: Parameters<RealtimeClient['channel']>[1],
          ) {
            callsInGen3 += 1;
            if (callsInGen3 === 2) {
              throw new Error('simulated_second_attach_failure_c2_witness');
            }
            return origProtoChannel.call(this, name, opts);
          });

        const manager = createWorkspaceLiveManager({
          sessionGate: gate,
          workspaceId: WS_1,
          onRefresh: () => {},
          timers: dt.timers,
        });

        await waitFor(() => {
          expect(dt.timeouts).toHaveLength(1);
          expect(generationClients.length).toBe(clientsBefore + 1);
        });
        const rtClient = generationClients[clientsBefore]!;
        assertExactAddedRemovedMatch(addedThisGen, removedThisGen);
        expect(rtClient.getChannels()).toHaveLength(0);
        expect(rtClient.accessTokenValue).toBeNull();

        failSecondSpy.mockRestore();
        manager.dispose();
        expect(totalActiveCount()).toBe(0);
        expect(window.addEventListener).toBe(spiedWindowAdd);
        continue;
      }

      // Normal subscribed generation -> retire.
      const manager = createWorkspaceLiveManager({
        sessionGate: gate,
        workspaceId: WS_1,
        onRefresh: () => {},
      });

      await waitFor(() => {
        expect(manager.subscribed).toBe(true);
        expect(generationClients.length).toBe(clientsBefore + 1);
      });
      expect(totalActiveCount()).toBe(EXPECTED_LISTENERS_PER_SOCKET);
      expect(activeByType.pagehide.size).toBe(1);
      expect(activeByType.pageshow.size).toBe(1);
      expect(activeByType.visibilitychange.size).toBe(1);
      expect(window.addEventListener).toBe(spiedWindowAdd);

      const rtClient = generationClients[clientsBefore]!;
      expect(rtClient.accessTokenValue).toBe(token);
      const sock = sockets.at(-1)!;
      const sentBeforeRetire = sock.sent.length;

      manager.dispose();
      await waitFor(() => {
        expect(rtClient.getChannels()).toHaveLength(0);
        expect(sock.readyState).toBe(MockPhoenixSocket.CLOSED);
        expect(totalActiveCount()).toBe(0);
      });

      assertExactAddedRemovedMatch(addedThisGen, removedThisGen);
      expect(rtClient.accessTokenValue).toBeNull();
      // Clearing auth on retirement must not send any access_token frame.
      expect(
        sock.sent.slice(sentBeforeRetire).filter((f) => f.event === 'access_token'),
      ).toEqual([]);
    }

    expect(generationClients).toHaveLength(10);

    // After retirement of all 10 generations, dispatching pagehide, pageshow, and visibilitychange
    // must open NO socket and touch NO retired client or its underlying Phoenix Socket.
    const retiredClientSpies = generationClients.flatMap((rtClient) => {
      const phoenixSocket = (
        rtClient as unknown as {
          socketAdapter: {
            getSocket(): {
              connect: () => void;
              disconnect: () => void;
              teardown: () => void;
            };
          };
        }
      ).socketAdapter.getSocket();
      return [
        vi.spyOn(rtClient, 'connect'),
        vi.spyOn(rtClient, 'disconnect'),
        vi.spyOn(phoenixSocket, 'connect'),
        vi.spyOn(phoenixSocket, 'disconnect'),
        vi.spyOn(phoenixSocket, 'teardown'),
      ];
    });

    const socketsBeforeEvents = sockets.length;
    const origVisDesc = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pageshow'));
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      window.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      window.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if (origVisDesc) {
        Object.defineProperty(document, 'visibilityState', origVisDesc);
      } else {
        delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
      }
    }

    expect(sockets.length).toBe(socketsBeforeEvents);
    for (const spy of retiredClientSpies) {
      expect(spy).not.toHaveBeenCalled();
    }

    // Re-settle SessionGate after the pagehide/pageshow transition before the throw-path checks.
    await waitFor(() => expect(gate.state).toEqual({ status: 'authenticated' }));
    gate.fenceTracker.setActiveWorkspace(WS_1);

    // Throwing construction case A: RealtimeClient constructor throws synchronously (missing apikey).
    {
      const dt = deterministicTimers();
      const origAcquire = gate.acquireAccessToken.bind(gate);
      const acquireSpy = vi
        .spyOn(gate, 'acquireAccessToken')
        .mockImplementationOnce(async () => {
          const auth = await origAcquire();
          return auth ? { ...auth, anonKey: '' } : null;
        });

      const manager = createWorkspaceLiveManager({
        sessionGate: gate,
        workspaceId: WS_1,
        onRefresh: () => {},
        timers: dt.timers,
      });

      await waitFor(() => {
        expect(dt.timeouts).toHaveLength(1);
      });
      expect(window.addEventListener).toBe(spiedWindowAdd);
      expect(totalActiveCount()).toBe(0);

      acquireSpy.mockRestore();
      manager.dispose();
    }

    // Throwing construction case B: throw mid-registration AFTER pagehide was registered -> rolls back pagehide and restores window.addEventListener === original.
    {
      addedThisGen = [];
      removedThisGen = [];
      throwOnPageshowOnce = true;
      const dt = deterministicTimers();

      const manager = createWorkspaceLiveManager({
        sessionGate: gate,
        workspaceId: WS_1,
        onRefresh: () => {},
        timers: dt.timers,
      });

      await waitFor(() => {
        expect(dt.timeouts).toHaveLength(1);
      });
      expect(window.addEventListener).toBe(spiedWindowAdd);
      expect(totalActiveCount()).toBe(0);
      expect(addedThisGen).toHaveLength(1);
      expect(addedThisGen[0]!.type).toBe('pagehide');
      expect(removedThisGen).toHaveLength(1);
      expect(removedThisGen[0]!.type).toBe('pagehide');
      expect(removedThisGen[0]!.listener).toBe(addedThisGen[0]!.listener);

      manager.dispose();
    }

    // Verify native (unspied) window.addEventListener identity and property descriptor as well.
    addSpy.mockRestore();
    removeSpy.mockRestore();
    setAuthTrackSpy.mockRestore();

    const nativeWindowAdd = window.addEventListener;
    const nativeWindowAddDesc = Object.getOwnPropertyDescriptor(
      window,
      'addEventListener',
    );

    const finalManager = createWorkspaceLiveManager({
      sessionGate: gate,
      workspaceId: WS_1,
      onRefresh: () => {},
    });
    await waitFor(() => expect(finalManager.subscribed).toBe(true));
    expect(window.addEventListener).toBe(nativeWindowAdd);
    expect(Object.getOwnPropertyDescriptor(window, 'addEventListener')).toEqual(
      nativeWindowAddDesc,
    );

    finalManager.dispose();
    await waitFor(() => expect(sockets.at(-1)!.readyState).toBe(MockPhoenixSocket.CLOSED));
    expect(window.addEventListener).toBe(nativeWindowAdd);
    expect(Object.getOwnPropertyDescriptor(window, 'addEventListener')).toEqual(
      nativeWindowAddDesc,
    );

    gate.dispose();
  });
});
