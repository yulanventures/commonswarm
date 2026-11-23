import { CURRENT_USER_ID, PEOPLE, WORKSPACES } from '../data/fixtures';
import { useRealSidebarData, useSessionSnapshot } from '../data/queries';
import type { Person, Workspace } from '../data/types';
import { Avatar } from './Avatar';

interface WorkspaceRailViewProps {
  workspaces: readonly Workspace[];
  currentUser: Person | null;
  loading?: boolean;
  onSelectWorkspace?: (workspaceId: string) => void;
}

function WorkspaceRailView({
  workspaces,
  currentUser,
  loading = false,
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
          <div className="size-avatar-lg rounded-md bg-elevated" />
          <div className="size-avatar-lg rounded-md bg-elevated" />
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
      <button
        type="button"
        aria-label="Add workspace"
        className="flex size-avatar-lg items-center justify-center rounded-md border border-dashed border-border-strong bg-transparent text-icon text-ink-muted transition-quiet hover:border-ink-muted hover:text-ink"
      >
        +
      </button>
      <div className="flex-1" />
      {currentUser ? (
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
