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
});
