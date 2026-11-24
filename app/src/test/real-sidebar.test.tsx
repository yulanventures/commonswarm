import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { adaptAgents, adaptPeople } from '../data/adapter';
import { createAppQueryClient, createDataController } from '../data/queries';
import { createSessionGate } from '../data/session';
import {
  createFakeSessionHarness,
  createFakeStorage,
  makeFakeSession,
} from './fake-session';

const DEPLOY_URL = 'https://api.commonswarm.com';
const ANON_KEY = 'anon-public-key';
const WS_1 = '11111111-1111-4111-8111-111111111111';
const WS_2 = '22222222-2222-4222-8222-222222222222';
const AGENT_FAULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const AGENT_WORKING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

describe('Adapter and real-data sidebar rendering', () => {
  it('maps a fault agent to needs-you with its real status line and omits computer, harness, and people presence', () => {
    const now = Date.parse('2026-11-23T12:00:00.000Z');
    const agents = adaptAgents({
      workspaceId: WS_1,
      now,
      principals: [
        {
          principalId: AGENT_FAULT,
          name: 'BrokenBot',
          model: 'claude-opus',
          transport: 'local',
          turnOnly: false,
          ownerUserId: 'user-1',
          workspaceId: WS_1,
          createdAt: '2026-11-20T00:00:00.000Z',
        },
      ],
      presence: new Map(),
      wakePath: new Map(),
      overview: {
        viewer_user_id: 'user-1',
        generated_at: '2026-11-23T12:00:00.000Z',
        workspaces: [
          {
            workspace_id: WS_1,
            name: 'Ops',
            role: 'owner',
            last_seen_at: null,
            new_messages: 0,
            content: null,
            people: [
              {
                user_id: 'user-1',
                display_name: 'Alice',
                role: 'owner',
                is_viewer: true,
                agents: [
                  {
                    principal_id: AGENT_FAULT,
                    name: 'BrokenBot',
                    queue: null,
                    status: {
                      work: 'disconnected',
                      facts: {
                        transport: 'local',
                        turn_only: false,
                        connection: 'key_ended',
                        last_activity_at: '2026-11-23T11:50:00.000Z',
                        messages_waiting_since: null,
                        doing: null,
                        working_on: null,
                      },
                    },
                  },
                ],
              },
            ],
            needs_you: { asks: [], assigned: [], waiting: [] },
          },
        ],
      },
    });

    expect(agents).toHaveLength(1);
    const bot = agents[0]!;
    expect(bot.state).toBe('waiting');
    expect(bot.sidebarStateLabel).toBe('Key ended');
    expect(bot.computerId).toBeUndefined();
    expect(bot.harnessId).toBeUndefined();
    expect(bot.folder).toBeUndefined();
    expect(bot.mode).toBeUndefined();
    expect(bot.sessionMeta).toBeUndefined();

    const people = adaptPeople([
      { userId: 'user-1', name: 'Alice', role: 'owner' },
    ]);
    expect(people).toHaveLength(1);
    expect(people[0]!.presence).toBeUndefined();
  });

  it('renders real sidebar (workspaces, Waiting count, channels, DMs, fault/working agents, people without dots, markup as text) and switches workspaces', async () => {
    const user = userEvent.setup();
    const session = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const nowIso = new Date().toISOString();

    const harness = createFakeSessionHarness(session, {
      onFrom(call) {
        if (call.target === 'workspaces') {
          return {
            data: [
              { workspace_id: WS_1, name: '<b>Alpha</b>' },
              { workspace_id: WS_2, name: 'Beta' },
            ],
            error: null,
            status: 200,
          };
        }
        const ws = call.filters.workspace_id;
        if (call.target === 'agent_principals') {
          if (ws === WS_2) {
            return { data: [], error: null, status: 200 };
          }
          return {
            data: [
              {
                principal_id: AGENT_FAULT,
                name: '<img src=x onerror=alert(1)>',
                model: 'claude-opus',
                transport: 'local',
                turn_only: false,
                owner_user_id: 'user-1',
                revoked_at: null,
                workspace_id: WS_1,
                created_at: nowIso,
              },
              {
                principal_id: AGENT_WORKING,
                name: 'Builder',
                model: 'codex',
                transport: 'local',
                turn_only: false,
                owner_user_id: 'user-1',
                revoked_at: null,
                workspace_id: WS_1,
                created_at: nowIso,
              },
            ],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'agent_presence') {
          return {
            data:
              ws === WS_1
                ? [
                    {
                      principal_id: AGENT_WORKING,
                      last_command_at: nowIso,
                      client_build: '0.1.71',
                      watcher_at: nowIso,
                      channel_at: null,
                      listener_at: null,
                      turn_at: null,
                      last_ack_via: null,
                      last_ack_at: null,
                      current_client_build: '0.1.71',
                    },
                  ]
                : [],
            error: null,
            status: 200,
          };
        }
        if (call.target === 'agent_wake_path') {
          return { data: [], error: null, status: 200 };
        }
        if (call.target === 'member_profiles') {
          return {
            data:
              ws === WS_1
                ? [
                    {
                      user_id: 'user-1',
                      display_name: '<script>evil()</script>',
                      role: 'owner',
                    },
                  ]
                : [{ user_id: 'user-1', display_name: 'Beta Owner', role: 'owner' }],
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
              generated_at: nowIso,
              workspaces: [
                {
                  workspace_id: WS_1,
                  name: '<b>Alpha</b>',
                  role: 'owner',
                  last_seen_at: null,
                  new_messages: 0,
                  content: null,
                  people: [
                    {
                      user_id: 'user-1',
                      display_name: '<script>evil()</script>',
                      role: 'owner',
                      is_viewer: true,
                      agents: [
                        {
                          principal_id: AGENT_FAULT,
                          name: '<img src=x onerror=alert(1)>',
                          queue: null,
                          status: {
                            work: 'disconnected',
                            facts: {
                              transport: 'local',
                              turn_only: false,
                              connection: 'key_ended',
                              last_activity_at: nowIso,
                              messages_waiting_since: null,
                              doing: null,
                              working_on: null,
                            },
                          },
                        },
                        {
                          principal_id: AGENT_WORKING,
                          name: 'Builder',
                          queue: null,
                          status: {
                            work: 'working',
                            facts: {
                              transport: 'local',
                              turn_only: false,
                              connection: 'live',
                              last_activity_at: nowIso,
                              messages_waiting_since: null,
                              doing: {
                                todo_id: 't1',
                                title: 'Ship sidebar',
                                since: nowIso,
                              },
                              working_on: null,
                            },
                          },
                        },
                      ],
                    },
                  ],
                  needs_you: { asks: [], assigned: [], waiting: [] },
                },
              ],
            },
            error: null,
            status: 200,
          };
        }
        const ws = String(call.params?.p_workspace_id ?? '');
        if (call.target === 'decision_queue') {
          return {
            data: {
              workspace_id: ws,
              generated_at: nowIso,
              total: ws === WS_1 ? 2 : 0,
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
              total: ws === WS_1 ? 3 : 0,
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
        const parsed = JSON.parse(String(init?.body ?? '{}')) as {
          workspace_id?: string;
        };
        if (parsed.workspace_id === WS_2) {
          return new Response(
            JSON.stringify({
              conversations: [
                {
                  conversation_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
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
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            conversations: [
              {
                conversation_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
                kind: 'public_channel',
                channel_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
                slug: '<svg onload=alert(1)>',
                description: null,
                archived_at: null,
                joined: true,
                members: [],
                notify_level: 'everything',
                starred: false,
                star_rank: null,
                unread_count: 4,
                mention_count: 2,
                last_message_at: nowIso,
                last_message_id: null,
              },
              {
                conversation_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
                kind: 'dm',
                channel_id: null,
                slug: null,
                description: null,
                archived_at: null,
                joined: true,
                members: [
                  { kind: 'user', id: 'user-1', name: '<script>evil()</script>' },
                  { kind: 'agent', id: AGENT_WORKING, name: 'Builder' },
                ],
                notify_level: 'everything',
                starred: false,
                star_rank: null,
                unread_count: 1,
                mention_count: 0,
                last_message_at: nowIso,
                last_message_id: null,
              },
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

    const { container } = render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-waiting-count')).toHaveTextContent('5');
    });

    // Markup names render strictly as text nodes, never injected as HTML elements.
    expect(screen.getByText('<svg onload=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('<script>evil()</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    // Mention count & DM unread render.
    expect(screen.getByTestId('mention-count')).toHaveTextContent('2');
    expect(screen.getByTestId('unread-count')).toHaveTextContent('1');

    // Agents live in one workspace-named group with no computer line and no harness tag.
    const agentGroup = screen.getByTestId('workspace-agent-group');
    expect(agentGroup).toHaveAttribute('aria-label', '<b>Alpha</b>');
    expect(within(agentGroup).getByText('Key ended')).toBeInTheDocument();
    expect(within(agentGroup).getByText(/Working/)).toBeInTheDocument();
    expect(agentGroup).not.toHaveTextContent(/claude|codex|agy|grok/i);
    expect(agentGroup.querySelector('.bg-working')).toBeNull();
    expect(agentGroup.querySelector('.bg-offline')).toBeNull();

    // People have NO online/away presence dot in real-data mode.
    const peopleList = screen.getByTestId('sidebar-people');
    expect(within(peopleList).queryByLabelText('Online')).not.toBeInTheDocument();
    expect(within(peopleList).queryByLabelText('Away')).not.toBeInTheDocument();
    expect(peopleList.querySelector('.bg-working')).toBeNull();
    expect(peopleList.querySelector('.border-offline')).toBeNull();

    // In real-data mode, "Sample data" is gone from the channel view, and an unknown
    // route id ('launch') renders the uniform unavailable state without probing the server.
    expect(screen.queryByTestId('sample-data-marker')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-unavailable')).toBeInTheDocument();

    // Switching workspace switches scope and fence.
    await user.click(screen.getByRole('button', { name: 'Beta workspace' }));
    await waitFor(() => {
      expect(screen.getByText('Beta Owner')).toBeInTheDocument();
    });
    expect(gate.fenceTracker.activeWorkspaceId).toBe(WS_2);

    controller.dispose();
    gate.dispose();
  });

  it('renders a quiet error line with Retry when a response fails to decode and recovers on Retry', async () => {
    const user = userEvent.setup();
    const session = makeFakeSession({ userId: 'user-1', sessionId: 'sid-1' });
    const nowIso = new Date().toISOString();
    let corruptConversations = true;

    const harness = createFakeSessionHarness(session, {
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
              generated_at: nowIso,
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
              workspace_id: WS_1,
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
      onFetch() {
        if (corruptConversations) {
          return new Response(
            JSON.stringify({
              conversations: [{ conversation_id: 123, kind: 'bogus' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            conversations: [
              {
                conversation_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9',
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
              },
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
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-error')).toBeInTheDocument();
    });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();

    corruptConversations = false;
    await user.click(
      within(screen.getByTestId('sidebar-error')).getByRole('button', {
        name: 'Retry',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('general')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    controller.dispose();
    gate.dispose();
  });

  it('closes an open Add an agent dialog on route change', async () => {
    const user = userEvent.setup();
    let navigateFn: ReturnType<typeof useNavigate> | null = null;

    function NavCapture() {
      navigateFn = useNavigate();
      return null;
    }

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <NavCapture />
        <AppRoutes />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '+ Add' }));
    expect(
      screen.getByRole('dialog', { name: 'Add an agent' }),
    ).toBeInTheDocument();

    act(() => {
      navigateFn!('/waiting');
    });

    expect(
      screen.queryByRole('dialog', { name: 'Add an agent' }),
    ).not.toBeInTheDocument();
  });
});
