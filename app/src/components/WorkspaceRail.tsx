import { CURRENT_USER_ID, PEOPLE, WORKSPACES } from '../data/fixtures';
import { Avatar } from './Avatar';

export function WorkspaceRail() {
  const currentUser =
    PEOPLE.find((person) => person.id === CURRENT_USER_ID) ?? PEOPLE[0];

  return (
    <nav
      aria-label="Workspaces"
      className="flex w-rail shrink-0 flex-col items-center gap-2.5 border-r border-hairline bg-sidebar py-3.5"
    >
      {WORKSPACES.map((workspace) => (
        <button
          key={workspace.id}
          type="button"
          aria-label={`${workspace.name} workspace`}
          aria-current={workspace.active ? 'true' : undefined}
          className={`flex size-avatar-lg items-center justify-center rounded-md text-md transition-quiet ${
            workspace.active
              ? 'bg-accent font-bold text-on-accent'
              : 'bg-subtle font-semibold text-ink-secondary hover:bg-active hover:text-ink'
          }`}
        >
          {workspace.initial}
        </button>
      ))}
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
