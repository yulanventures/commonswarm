export function EmptyWorkspaceState() {
  return (
    <div
      data-testid="empty-workspace-state"
      className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <h1 className="text-lg font-bold tracking-tight text-ink">
        No workspaces yet
      </h1>
      <a
        href="/app"
        className="inline-flex h-btn-lg items-center rounded-md bg-accent px-5 text-md font-bold text-on-accent no-underline transition-quiet hover:opacity-90"
      >
        Create workspace
      </a>
    </div>
  );
}
