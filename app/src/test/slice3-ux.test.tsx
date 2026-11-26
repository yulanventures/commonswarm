import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRecoveryRequired } from '../../../shared/browser-session/index.js';
import { AppRoutes } from '../App';
import { SessionHeader } from '../components/SessionHeader';
import * as fixtures from '../data/fixtures';
import { createAppQueryClient, createDataController } from '../data/queries';
import { createSessionGate } from '../data/session';
import { resetAppStore } from '../store/appStore';
import {
  createFakeSessionHarness,
  createFakeStorage,
  makeFakeSession,
} from './fake-session';

const DEPLOY_URL = 'https://api.commonswarm.com';
const ANON_KEY = 'anon-public-key';
const WS_1 = '11111111-1111-4111-8111-111111111111';
const USER_1 = '22222222-2222-4222-8222-222222222222';
const AGENT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CONV_GEN = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const NOW_ISO = '2026-11-25T12:00:00.000Z';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRealController(
  options: Parameters<typeof createFakeSessionHarness>[1] = {},
) {
  const session = makeFakeSession({ userId: USER_1, sessionId: 'sid-1' });
  const harness = createFakeSessionHarness(session, options);
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
  return { harness, gate, controller };
}

describe('Slice 3: real-mode routing, empty states, dead controls, dialogs, and a11y', () => {
  beforeEach(() => {
    resetAppStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAppStore();
  });

  it('routes real-mode / to the first channel, resolves phone Agents tab to real agent, and hides dead Search/+ controls', async () => {
    const { gate, controller } = makeRealController({
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
                name: 'Builder',
                model: 'claude',
                transport: 'local',
                turn_only: false,
                owner_user_id: USER_1,
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
            data: [{ user_id: USER_1, display_name: 'Alice', role: 'owner' }],
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
              viewer_user_id: USER_1,
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
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          resource?: string;
        };
        const conv = {
          conversation_id: CONV_GEN,
          kind: 'public_channel',
          channel_id: CONV_GEN,
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
        };
        if (body.resource === 'conversations') {
          return jsonResponse({ conversations: [conv] });
        }
        if (body.resource === 'conversation_history') {
          return jsonResponse({
            conversation: conv,
            messages: [],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return jsonResponse({}, 404);
      },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <AppRoutes controller={controller} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent(
        `/channels/${CONV_GEN}`,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('conversation-empty')).toHaveTextContent(
        'No messages yet',
      );
    });

    // Phone bottom bar Agents tab targets real agent, never /agents/atlas.
    const bottomNav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(bottomNav).getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      `/agents/${AGENT_1}`,
    );

    // Dead Search button and real-mode + / + Add agent buttons are omitted.
    expect(
      screen.queryByRole('button', { name: 'Search workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add an agent' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '+ Add' }),
    ).not.toBeInTheDocument();

    // WorkspaceRail Add workspace is a real /app link, not a dead button.
    const addWorkspaceLink = screen.getByRole('link', {
      name: 'Add workspace',
    });
    expect(addWorkspaceLink).toHaveAttribute('href', '/app');

    // WorkspaceRail user avatar opens a real menu with Open CommonSwarm -> /app.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Alice' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Alice')).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'Open CommonSwarm' }),
    ).toHaveAttribute('href', '/app');

    controller.dispose();
    gate.dispose();
  });

  it('shows zero-workspace empty state on /, /channels/:id, /waiting, and /agents/:id, plus empty sidebar sections and phone Agents fallback', async () => {
    const emptyHandlers = {
      onFrom(call: { target: string }) {
        if (call.target === 'workspaces') {
          return { data: [], error: null, status: 200 };
        }
        return { data: [], error: null, status: 200 };
      },
      onRpc(call: { target: string }) {
        if (call.target === 'home_overview') {
          return {
            data: {
              viewer_user_id: USER_1,
              generated_at: NOW_ISO,
              workspaces: [],
            },
            error: null,
            status: 200,
          };
        }
        return { data: null, error: null, status: 200 };
      },
    };

    for (const initialPath of ['/', '/channels/missing', '/waiting', '/agents/any']) {
      const { gate, controller } = makeRealController(emptyHandlers);
      const { unmount } = render(
        <MemoryRouter initialEntries={[initialPath]}>
          <AppRoutes controller={controller} />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('empty-workspace-state')).toBeInTheDocument();
      });

      const empty = screen.getByTestId('empty-workspace-state');
      expect(within(empty).getByRole('heading', { name: 'No workspaces yet' })).toBeInTheDocument();
      expect(within(empty).getByRole('link', { name: 'Create workspace' })).toHaveAttribute(
        'href',
        '/app',
      );
      expect(screen.queryByTestId('conversation-unavailable')).not.toBeInTheDocument();

      // Empty sidebar section placeholders appear when lists are empty.
      expect(screen.getByText('No channels')).toBeInTheDocument();
      expect(screen.getByText('No agents')).toBeInTheDocument();
      expect(screen.getByText('No people')).toBeInTheDocument();

      // Phone bottom bar Agents tab falls back to /home when no agents exist.
      const bottomNav = screen.getByRole('navigation', { name: 'Sections' });
      expect(within(bottomNav).getByRole('link', { name: 'Agents' })).toHaveAttribute(
        'href',
        '/home',
      );

      unmount();
      controller.dispose();
      gate.dispose();
    }
  });

  it('supports WaitingScreen keyboard tablist navigation (ArrowRight/ArrowLeft/Home/End) and renders waiting-empty and archived-empty states', async () => {
    const user = userEvent.setup();
    vi.spyOn(fixtures, 'createInitialWaitingItems').mockReturnValue([]);
    vi.spyOn(fixtures, 'createInitialClearedItems').mockReturnValue([]);
    resetAppStore();

    render(
      <MemoryRouter initialEntries={['/waiting']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    const openTab = screen.getByRole('tab', { name: /Open/ });
    const archivedTab = screen.getByRole('tab', { name: 'Archived' });

    expect(openTab).toHaveAttribute('aria-selected', 'true');
    expect(openTab).toHaveAttribute('tabindex', '0');
    expect(archivedTab).toHaveAttribute('aria-selected', 'false');
    expect(archivedTab).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      openTab.id,
    );
    expect(screen.getByTestId('waiting-empty')).toHaveTextContent(
      'All caught up',
    );

    openTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(archivedTab).toHaveAttribute('aria-selected', 'true');
    expect(archivedTab).toHaveAttribute('tabindex', '0');
    expect(archivedTab).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      archivedTab.id,
    );
    expect(screen.getByTestId('archived-empty')).toHaveTextContent(
      'Nothing archived',
    );

    await user.keyboard('{ArrowLeft}');
    expect(openTab).toHaveAttribute('aria-selected', 'true');
    expect(openTab).toHaveFocus();
    expect(screen.getByTestId('waiting-empty')).toHaveTextContent(
      'All caught up',
    );

    await user.keyboard('{End}');
    expect(archivedTab).toHaveAttribute('aria-selected', 'true');
    expect(archivedTab).toHaveFocus();

    await user.keyboard('{Home}');
    expect(openTab).toHaveAttribute('aria-selected', 'true');
    expect(openTab).toHaveFocus();
  });

  it('validates blank NAME and FOLDER inline in AddAgentDialog and closes via the × button', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '+ Add' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an agent' });

    const nameInput = within(dialog).getByLabelText('NAME');
    const folderInput = within(dialog).getByLabelText('FOLDER');
    await user.clear(nameInput);
    await user.clear(folderInput);

    await user.click(within(dialog).getByRole('button', { name: 'Start agent' }));

    // Dialog stays open with inline alerts and aria-invalid.
    expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(folderInput).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Enter a name')).toHaveAttribute('role', 'alert');
    expect(within(dialog).getByText('Enter a folder')).toHaveAttribute('role', 'alert');

    // Typing clears each field error immediately.
    await user.type(nameInput, 'Runner');
    expect(within(dialog).queryByText('Enter a name')).not.toBeInTheDocument();
    expect(nameInput).not.toHaveAttribute('aria-invalid');
    expect(within(dialog).getByText('Enter a folder')).toBeInTheDocument();

    await user.type(folderInput, '~/repo');
    expect(within(dialog).queryByText('Enter a folder')).not.toBeInTheDocument();
    expect(folderInput).not.toHaveAttribute('aria-invalid');

    // Top-right close button dismisses the dialog.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByRole('dialog', { name: 'Add an agent' }),
    ).not.toBeInTheDocument();
  });

  it('shows Open CommonSwarm escape link beside Try again on SessionRecoveryScreen', async () => {
    vi.useFakeTimers();
    const harness = createFakeSessionHarness(null);
    harness.setCurrentSessionHandler(async () => {
      throw new AuthRecoveryRequired(Date.now() + 60_000);
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
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes controller={controller} />
        </MemoryRouter>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const recovery = screen.getByTestId('session-recovery-screen');
      expect(within(recovery).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(
        within(recovery).getByRole('link', { name: 'Open CommonSwarm' }),
      ).toHaveAttribute('href', '/app');
    } finally {
      controller.dispose();
      gate.dispose();
      vi.useRealTimers();
    }
  });

  it('omits dead Stop, Search, and Open-on-phone controls and disables Send when empty on AgentSessionScreen', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Search workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open this session on your phone' }),
    ).not.toBeInTheDocument();

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();

    const input = screen.getByRole('combobox', { name: 'Message Atlas' });
    await user.type(input, 'Hello Atlas');
    expect(sendButton).toBeEnabled();

    // SessionHeader still renders Stop when onStop handler is explicitly provided.
    const onStop = vi.fn();
    const atlas = fixtures.createInitialAgents()[0]!;
    const { unmount } = render(
      <MemoryRouter>
        <SessionHeader agent={atlas} onStop={onStop} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
    unmount();
  });
});
