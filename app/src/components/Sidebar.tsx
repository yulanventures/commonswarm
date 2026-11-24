import { NavLink } from 'react-router';
import { COMPUTERS, HARNESSES, PEOPLE, WORKSPACES } from '../data/fixtures';
import {
  WORKSPACE_UNAVAILABLE_TEXT,
  useRealSidebarData,
  useSessionSnapshot,
} from '../data/queries';
import type {
  Agent,
  AgentState,
  Channel,
  Person,
  SidebarDirectMessage,
} from '../data/types';
import {
  appActions,
  getOpenWaitingCount,
  useAppStore,
} from '../store/appStore';
import { Avatar } from './Avatar';

interface SidebarProps {
  fullWidth?: boolean;
}

const AGENT_STATE_COLOR: Record<AgentState, string> = {
  waiting: 'text-needs-you',
  working: 'text-working',
  idle: 'text-ink-muted',
};

function PrivateLockIcon() {
  return (
    <svg
      aria-label="Private"
      role="img"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="mr-1.5 inline-block size-3 shrink-0 text-ink-muted"
    >
      <path d="M5 7V5a3 3 0 1 1 6 0v2h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1Zm2-2v2h2V5a1 1 0 1 0-2 0Z" />
    </svg>
  );
}

function renderUnreadIndicator(
  unread: boolean,
  mentionCount: number | undefined,
  unreadCount: number | undefined,
) {
  if (mentionCount && mentionCount > 0) {
    return (
      <span
        data-testid="mention-count"
        aria-label={`${mentionCount} ${mentionCount === 1 ? 'mention' : 'mentions'}`}
        className="flex h-badge min-w-badge-min shrink-0 items-center justify-center rounded-md bg-needs-you px-1.5 text-xs font-bold text-on-needs-you"
      >
        {mentionCount > 99 ? '99+' : mentionCount}
      </span>
    );
  }
  if (unreadCount && unreadCount > 0) {
    return (
      <span
        data-testid="unread-count"
        aria-label={`${unreadCount} unread`}
        className="flex h-badge min-w-badge-min shrink-0 items-center justify-center rounded-md bg-active px-1.5 text-xs font-semibold text-ink"
      >
        {unreadCount > 99 ? '99+' : unreadCount}
      </span>
    );
  }
  if (unread) {
    return (
      <span
        aria-label="Unread"
        className="size-dot-md shrink-0 rounded-full bg-accent"
      />
    );
  }
  return null;
}

function SidebarSkeleton() {
  return (
    <div
      data-testid="sidebar-loading"
      aria-busy="true"
      className="flex flex-col gap-5 px-4 pt-3"
    >
      <div className="flex flex-col gap-2">
        <div className="h-3 w-16 rounded-sm bg-elevated" />
        <div className="h-7 w-full rounded-control bg-elevated" />
        <div className="h-7 w-5/6 rounded-control bg-elevated" />
        <div className="h-7 w-4/6 rounded-control bg-elevated" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-3 w-14 rounded-sm bg-elevated" />
        <div className="h-10 w-full rounded-control bg-elevated" />
        <div className="h-10 w-11/12 rounded-control bg-elevated" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-3 w-14 rounded-sm bg-elevated" />
        <div className="h-7 w-3/4 rounded-control bg-elevated" />
        <div className="h-7 w-2/3 rounded-control bg-elevated" />
      </div>
    </div>
  );
}

interface SidebarShellProps {
  fullWidth: boolean;
  workspaceName: string;
  workspaceLoading?: boolean;
  workspaceUnavailable?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  waitingCount: number | null;
  channels: readonly Channel[];
  directMessages: readonly SidebarDirectMessage[];
  agents: readonly Agent[];
  people: readonly Person[];
  useSampleComputers: boolean;
  onSelectConversation?: (conversationId: string) => void;
}

function SidebarShell({
  fullWidth,
  workspaceName,
  workspaceLoading = false,
  workspaceUnavailable = false,
  loading = false,
  error = false,
  onRetry,
  waitingCount,
  channels,
  directMessages,
  agents,
  people,
  useSampleComputers,
  onSelectConversation,
}: SidebarShellProps) {
  const knownComputerIds = useSampleComputers
    ? new Set(COMPUTERS.map((computer) => computer.id))
    : new Set<string>();
  const computerGroups = useSampleComputers
    ? COMPUTERS.map((computer) => ({
        computer,
        agents: agents.filter((agent) => agent.computerId === computer.id),
      })).filter((group) => group.agents.length > 0)
    : [];
  const workspaceAgents = useSampleComputers
    ? agents.filter(
        (agent) => !agent.computerId || !knownComputerIds.has(agent.computerId),
      )
    : agents;

  const getHarnessTag = (harnessId: string): string =>
    HARNESSES.find((h) => h.id === harnessId)?.tag ?? harnessId;

  const renderAgentRow = (agent: Agent, showHarnessTag: boolean) => (
    <NavLink
      key={agent.id}
      to={`/agents/${agent.id}`}
      className={({ isActive }) =>
        `flex h-row-xl items-center gap-2.5 rounded-control px-2.5 text-ink no-underline transition-quiet ${
          isActive ? 'bg-active' : 'hover:bg-elevated'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Avatar
            label={agent.initial}
            tone={agent.tone}
            shape="agent"
            size="sm"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={`truncate leading-tight ${
                isActive
                  ? 'font-semibold text-ink'
                  : 'font-medium text-ink-strong'
              }`}
            >
              {agent.name}
            </span>
            <span
              className={`truncate text-xs leading-snug ${AGENT_STATE_COLOR[agent.state]}`}
            >
              {agent.sidebarStateLabel}
            </span>
          </span>
          {showHarnessTag && agent.harnessId ? (
            <span className="rounded-tag border border-border px-1.5 py-0.5 font-mono text-2xs text-ink-muted">
              {getHarnessTag(agent.harnessId)}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );

  return (
    <div
      className={`flex min-w-0 flex-1 flex-col bg-sidebar text-md text-ink ${
        fullWidth ? 'w-full' : 'w-nav border-r border-hairline'
      }`}
    >
      <div className="flex h-header shrink-0 items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-center gap-2">
          {workspaceLoading ? (
            <div className="h-5 w-28 rounded-sm bg-elevated" />
          ) : (
            <span className="truncate text-lg font-bold tracking-tight">
              {workspaceName}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="Add an agent"
          onClick={() => appActions.openAddAgentDialog()}
          className="flex size-touch shrink-0 items-center justify-center rounded-sm bg-subtle text-lg text-ink-secondary transition-quiet hover:bg-active hover:text-ink desktop:size-btn-xs"
        >
          +
        </button>
      </div>

      <div className="shrink-0 px-3 pb-2.5">
        <button
          type="button"
          aria-label="Search workspace"
          className="flex h-touch w-full items-center justify-between rounded-control bg-elevated px-3 text-ink-muted transition-quiet hover:bg-active hover:text-ink-secondary desktop:h-search"
        >
          <span>Search</span>
          <span className="font-mono text-badge text-ink-muted">⌘K</span>
        </button>
      </div>

      <nav
        aria-label="Workspace navigation"
        className="flex-1 overflow-y-auto pb-4"
      >
        {workspaceUnavailable ? (
          <div
            data-testid="workspace-unavailable"
            className="px-4 py-6 text-sm text-ink-secondary"
          >
            {WORKSPACE_UNAVAILABLE_TEXT}
          </div>
        ) : loading ? (
          <SidebarSkeleton />
        ) : error ? (
          <div
            data-testid="sidebar-error"
            className="flex items-center justify-between gap-2 px-4 py-3 text-sm text-ink-secondary"
          >
            <span>Couldn&apos;t load workspace.</span>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 rounded-control border border-border bg-raised px-2.5 py-1 text-xs font-medium text-ink transition-quiet hover:border-border-strong hover:bg-active"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-0.5 px-2">
              <NavLink
                to="/waiting"
                className={({ isActive }) =>
                  `flex min-h-touch items-center justify-between rounded-control px-2.5 font-semibold text-ink no-underline transition-quiet desktop:h-row-lg desktop:min-h-0 ${
                    isActive ? 'bg-active' : 'hover:bg-elevated'
                  }`
                }
              >
                <span>Waiting on you</span>
                {waitingCount !== null && waitingCount > 0 ? (
                  <span
                    data-testid="sidebar-waiting-count"
                    className="flex h-badge min-w-badge-min items-center justify-center rounded-md bg-needs-you px-1.5 text-xs font-bold text-on-needs-you"
                  >
                    {waitingCount > 99 ? '99+' : waitingCount}
                  </span>
                ) : null}
              </NavLink>
            </div>

            <div className="px-4.5 pt-4.5 pb-1.5 text-xs font-semibold tracking-label text-ink-muted">
              CHANNELS
            </div>
            <div className="flex flex-col gap-0.5 px-2">
              {channels.map((channel) => {
                const targetId = channel.id ?? channel.name;
                return (
                  <NavLink
                    key={targetId}
                    to={`/channels/${encodeURIComponent(targetId)}`}
                    onClick={
                      channel.id && onSelectConversation
                        ? () => onSelectConversation(channel.id!)
                        : undefined
                    }
                    data-private={channel.isPrivate ? 'true' : undefined}
                    className={({ isActive }) =>
                      `flex min-h-touch items-center justify-between gap-2 rounded-control px-2.5 no-underline transition-quiet desktop:h-row-md desktop:min-h-0 ${
                        isActive
                          ? 'bg-active font-semibold text-ink'
                          : channel.unread
                            ? 'font-semibold text-ink hover:bg-elevated'
                            : 'text-ink-secondary hover:bg-elevated hover:text-ink'
                      }`
                    }
                  >
                    <span className="flex min-w-0 items-center truncate">
                      {channel.isPrivate ? (
                        <PrivateLockIcon />
                      ) : (
                        <span className="inline-block w-hash-col shrink-0 text-ink-muted">
                          #
                        </span>
                      )}
                      <span className="truncate">{channel.name}</span>
                    </span>
                    {renderUnreadIndicator(
                      channel.unread,
                      channel.mentionCount,
                      channel.unreadCount,
                    )}
                  </NavLink>
                );
              })}
            </div>

            {directMessages.length > 0 ? (
              <>
                <div className="px-4.5 pt-4.5 pb-1.5 text-xs font-semibold tracking-label text-ink-muted">
                  DIRECT MESSAGES
                </div>
                <div className="flex flex-col gap-0.5 px-2">
                  {directMessages.map((dm) => (
                    <NavLink
                      key={dm.id}
                      to={`/channels/${encodeURIComponent(dm.id)}`}
                      onClick={
                        onSelectConversation
                          ? () => onSelectConversation(dm.id)
                          : undefined
                      }
                      className={({ isActive }) =>
                        `flex min-h-touch items-center justify-between gap-2 rounded-control px-2.5 no-underline transition-quiet desktop:h-row-md desktop:min-h-0 ${
                          isActive
                            ? 'bg-active font-semibold text-ink'
                            : dm.unread
                              ? 'font-semibold text-ink hover:bg-elevated'
                              : 'text-ink-secondary hover:bg-elevated hover:text-ink'
                        }`
                      }
                    >
                      <span className="truncate">{dm.title}</span>
                      {renderUnreadIndicator(
                        dm.unread,
                        dm.mentionCount,
                        dm.unreadCount,
                      )}
                    </NavLink>
                  ))}
                </div>
              </>
            ) : null}

            <div className="flex items-center justify-between px-4.5 pt-4.5 pb-1.5 text-xs font-semibold tracking-label text-ink-muted">
              <span>AGENTS</span>
              <button
                type="button"
                onClick={() => appActions.openAddAgentDialog()}
                className="min-h-touch px-1 font-semibold tracking-normal text-accent transition-quiet hover:opacity-85 desktop:min-h-0 desktop:px-0"
              >
                + Add
              </button>
            </div>

            {computerGroups.map(({ computer, agents: computerAgents }, index) => (
              <div key={computer.id} role="group" aria-label={computer.name}>
                <div
                  className={`flex items-center gap-1.5 px-4.5 pb-1 text-xs text-ink-muted ${
                    index === 0 ? 'pt-0.5' : 'pt-2.5'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-dot-sm rounded-full ${
                      computer.online ? 'bg-working' : 'bg-offline'
                    }`}
                  />
                  <span>{computer.name}</span>
                </div>
                <div className="flex flex-col gap-0.5 px-2">
                  {computerAgents.map((agent) => renderAgentRow(agent, true))}
                </div>
              </div>
            ))}

            {workspaceAgents.length > 0 ? (
              <div
                role="group"
                aria-label={workspaceName}
                data-testid="workspace-agent-group"
              >
                <div
                  className={`px-4.5 pb-1 text-xs text-ink-muted ${
                    computerGroups.length === 0 ? 'pt-0.5' : 'pt-2.5'
                  }`}
                >
                  {workspaceName}
                </div>
                <div className="flex flex-col gap-0.5 px-2">
                  {workspaceAgents.map((agent) => renderAgentRow(agent, false))}
                </div>
              </div>
            ) : null}

            <div
              id="people"
              className="px-4.5 pt-4.5 pb-1.5 text-xs font-semibold tracking-label text-ink-muted"
            >
              PEOPLE
            </div>
            <div className="flex flex-col gap-0.5 px-2" data-testid="sidebar-people">
              {people.map((person) => (
                <div
                  key={person.id}
                  className={`flex min-h-touch items-center gap-2.5 px-2.5 desktop:h-row-md desktop:min-h-0 ${
                    person.presence === 'online'
                      ? 'text-ink-strong'
                      : 'text-ink-secondary'
                  }`}
                >
                  {person.presence !== undefined ? (
                    <span
                      aria-label={person.presence === 'online' ? 'Online' : 'Away'}
                      className={
                        person.presence === 'online'
                          ? 'size-dot-md rounded-full bg-working'
                          : 'size-dot-md rounded-full border-selected border-offline'
                      }
                    />
                  ) : null}
                  <span className="truncate">{person.name}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </nav>
    </div>
  );
}

function RealSidebar({ fullWidth }: { fullWidth: boolean }) {
  const data = useRealSidebarData();
  return (
    <SidebarShell
      fullWidth={fullWidth}
      workspaceName={data.activeWorkspaceName}
      workspaceLoading={data.workspacesLoading}
      workspaceUnavailable={data.workspaceUnavailable}
      loading={data.sidebarLoading}
      error={data.sidebarError}
      onRetry={data.retrySidebar}
      waitingCount={data.waitingCount}
      channels={data.channels}
      directMessages={data.directMessages}
      agents={data.agents}
      people={data.people}
      useSampleComputers={false}
      onSelectConversation={data.selectConversation}
    />
  );
}

function SampleSidebar({ fullWidth }: { fullWidth: boolean }) {
  const agents = useAppStore((state) => state.agents);
  const channels = useAppStore((state) => state.channels);
  const openWaitingCount = useAppStore(getOpenWaitingCount);
  const activeWorkspace = WORKSPACES.find((w) => w.active) ?? WORKSPACES[0];
  const workspaceName = activeWorkspace?.name ?? 'Northwind';

  return (
    <SidebarShell
      fullWidth={fullWidth}
      workspaceName={workspaceName}
      waitingCount={openWaitingCount}
      channels={channels}
      directMessages={[]}
      agents={agents}
      people={PEOPLE}
      useSampleComputers
    />
  );
}

export function Sidebar({ fullWidth = false }: SidebarProps) {
  const snapshot = useSessionSnapshot();
  if (snapshot.state.status === 'authenticated') {
    return <RealSidebar fullWidth={fullWidth} />;
  }
  return <SampleSidebar fullWidth={fullWidth} />;
}
