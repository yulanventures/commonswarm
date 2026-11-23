import { NavLink } from 'react-router';
import { readRuntimeConfig } from '../data/config';
import { COMPUTERS, HARNESSES, PEOPLE, WORKSPACES } from '../data/fixtures';
import type { Agent, AgentState } from '../data/types';
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

export function Sidebar({ fullWidth = false }: SidebarProps) {
  const agents = useAppStore((state) => state.agents);
  const channels = useAppStore((state) => state.channels);
  const openWaitingCount = useAppStore(getOpenWaitingCount);
  const activeWorkspace = WORKSPACES.find((w) => w.active) ?? WORKSPACES[0];
  const workspaceName = activeWorkspace?.name ?? 'Northwind';
  const runtimeConfig = readRuntimeConfig();

  const knownComputerIds = new Set(COMPUTERS.map((computer) => computer.id));
  const computerGroups = COMPUTERS.map((computer) => ({
    computer,
    agents: agents.filter((agent) => agent.computerId === computer.id),
  })).filter((group) => group.agents.length > 0);
  const workspaceAgents = agents.filter(
    (agent) => !agent.computerId || !knownComputerIds.has(agent.computerId),
  );

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
          <span className="truncate text-lg font-bold tracking-tight">
            {workspaceName}
          </span>
          {runtimeConfig.status === 'not_configured' ? (
            <span
              data-testid="sample-data-marker"
              className="shrink-0 rounded-tag border border-border bg-elevated px-1.5 py-0.5 text-2xs font-medium text-ink-muted"
            >
              Sample data
            </span>
          ) : null}
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
            {openWaitingCount > 0 ? (
              <span
                data-testid="sidebar-waiting-count"
                className="flex h-badge min-w-badge-min items-center justify-center rounded-md bg-needs-you px-1.5 text-xs font-bold text-on-needs-you"
              >
                {openWaitingCount}
              </span>
            ) : null}
          </NavLink>
        </div>

        <div className="px-4.5 pt-4.5 pb-1.5 text-xs font-semibold tracking-label text-ink-muted">
          CHANNELS
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {channels.map((channel) => (
            <NavLink
              key={channel.name}
              to={`/channels/${channel.name}`}
              className={({ isActive }) =>
                `flex min-h-touch items-center justify-between rounded-control px-2.5 no-underline transition-quiet desktop:h-row-md desktop:min-h-0 ${
                  isActive
                    ? 'bg-active font-semibold text-ink'
                    : channel.unread
                      ? 'font-semibold text-ink hover:bg-elevated'
                      : 'text-ink-secondary hover:bg-elevated hover:text-ink'
                }`
              }
            >
              <span className="flex items-center">
                <span className="inline-block w-hash-col text-ink-muted">#</span>
                {channel.name}
              </span>
              {channel.unread ? (
                <span
                  aria-label="Unread"
                  className="size-dot-md rounded-full bg-accent"
                />
              ) : null}
            </NavLink>
          ))}
        </div>

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
        <div className="flex flex-col gap-0.5 px-2">
          {PEOPLE.map((person) => (
            <div
              key={person.id}
              className={`flex min-h-touch items-center gap-2.5 px-2.5 desktop:h-row-md desktop:min-h-0 ${
                person.presence === 'online'
                  ? 'text-ink-strong'
                  : 'text-ink-secondary'
              }`}
            >
              <span
                aria-label={person.presence === 'online' ? 'Online' : 'Away'}
                className={
                  person.presence === 'online'
                    ? 'size-dot-md rounded-full bg-working'
                    : 'size-dot-md rounded-full border-selected border-offline'
                }
              />
              <span>{person.name}</span>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}
