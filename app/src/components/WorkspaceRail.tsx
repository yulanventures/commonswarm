import { DropdownMenu } from 'radix-ui';
import { CURRENT_USER_ID, PEOPLE, WORKSPACES } from '../data/fixtures';
import { useRealSidebarData, useSessionSnapshot } from '../data/queries';
import type { Person, Workspace } from '../data/types';
import { Avatar } from './Avatar';

interface WorkspaceRailViewProps {
  workspaces: readonly Workspace[];
  currentUser: Person | null;
  loading?: boolean;
  addWorkspaceHref?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
}

function WorkspaceRailView({
  workspaces,
  currentUser,
  loading = false,
  addWorkspaceHref,
  onSelectWorkspace,
}: WorkspaceRailViewProps) {
  return (
    <nav
      aria-label="Workspaces"
      className="flex w-rail shrink-0 flex-col items-center gap-2.5 border-r border-hairline bg-sidebar py-3.5"
    >
      {loading ? (
        <div
          data-testid="workspace-rail-loading"
          aria-busy="true"
          className="flex flex-col items-center gap-2.5"
        >
          <div className="size-avatar-lg animate-pulse rounded-md bg-elevated" />
          <div className="size-avatar-lg animate-pulse rounded-md bg-elevated" />
        </div>
      ) : (
        workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            aria-label={`${workspace.name} workspace`}
            aria-current={workspace.active ? 'true' : undefined}
            onClick={
              onSelectWorkspace
                ? () => onSelectWorkspace(workspace.id)
                : undefined
            }
            className={`flex size-avatar-lg items-center justify-center rounded-md text-md transition-quiet ${
              workspace.active
                ? 'bg-accent font-bold text-on-accent'
                : 'bg-subtle font-semibold text-ink-secondary hover:bg-active hover:text-ink'
            }`}
          >
            {workspace.initial}
          </button>
        ))
      )}
      {addWorkspaceHref ? (
        <a
          href={addWorkspaceHref}
          aria-label="Add workspace"
          className="flex size-avatar-lg items-center justify-center rounded-md border border-dashed border-border-strong bg-transparent text-icon text-ink-muted no-underline transition-quiet hover:border-ink-muted hover:text-ink"
        >
          +
        </a>
      ) : null}
      <div className="flex-1" />
      {currentUser ? (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={currentUser.name}
              className="rounded-full transition-quiet hover:opacity-90"
            >
              <Avatar
                label={currentUser.initials}
                tone={currentUser.tone}
                shape="person"
                size="md"
              />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="right"
              align="end"
              sideOffset={8}
              className="animate-menu-in z-50 min-w-48 rounded-card border border-border bg-popover p-1.5 text-sm text-ink shadow-popover"
            >
              <DropdownMenu.Label className="truncate px-2.5 py-1.5 text-xs font-semibold text-ink-muted">
                {currentUser.name}
              </DropdownMenu.Label>
              <DropdownMenu.Item asChild>
                <a
                  href="/app"
                  className="flex h-row-md cursor-pointer items-center rounded-sm px-2.5 text-ink-strong no-underline outline-none transition-quiet data-[highlighted]:bg-menu-active data-[highlighted]:text-ink"
                >
                  Open CommonSwarm
                </a>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </nav>
  );
}

function RealWorkspaceRail() {
  const data = useRealSidebarData();
  return (
    <WorkspaceRailView
      workspaces={data.workspaces}
      currentUser={data.currentUser}
      loading={data.workspacesLoading}
      addWorkspaceHref="/app"
      onSelectWorkspace={data.selectWorkspace}
    />
  );
}

function SampleWorkspaceRail() {
  const currentUser =
    PEOPLE.find((person) => person.id === CURRENT_USER_ID) ?? PEOPLE[0] ?? null;
  return (
    <WorkspaceRailView workspaces={WORKSPACES} currentUser={currentUser} />
  );
}

export function WorkspaceRail() {
  const snapshot = useSessionSnapshot();
  if (snapshot.state.status === 'authenticated') {
    return <RealWorkspaceRail />;
  }
  return <SampleWorkspaceRail />;
}
