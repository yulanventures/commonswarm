import { useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { AppFrame } from '../components/AppFrame';
import { ClearedList } from '../components/ClearedList';
import { EmptyWorkspaceState } from '../components/EmptyWorkspaceState';
import { WaitingItemCard } from '../components/WaitingItemCard';
import {
  WORKSPACE_UNAVAILABLE_TEXT,
  useRealSidebarData,
  useSessionSnapshot,
} from '../data/queries';
import {
  appActions,
  getOpenWaitingCount,
  useAppStore,
} from '../store/appStore';

function WaitingScreenBody() {
  const agents = useAppStore((state) => state.agents);
  const waitingItems = useAppStore((state) => state.waitingItems);
  const clearedItems = useAppStore((state) => state.clearedItems);
  const filter = useAppStore((state) => state.waitingFilter);
  const openCount = useAppStore(getOpenWaitingCount);
  const openTabRef = useRef<HTMLButtonElement>(null);
  const archivedTabRef = useRef<HTMLButtonElement>(null);

  const visibleItems = waitingItems.filter(
    (item) => item.status === 'open' || item.status === 'dismissed',
  );

  const selectTab = (next: 'open' | 'archived'): void => {
    appActions.setWaitingFilter(next);
    if (next === 'open') {
      openTabRef.current?.focus();
    } else {
      archivedTabRef.current?.focus();
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      selectTab(filter === 'open' ? 'archived' : 'open');
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      selectTab('open');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      selectTab('archived');
    }
  };

  return (
    <AppFrame>
      <header className="flex h-header shrink-0 items-center gap-4 border-b border-hairline px-4.5 desktop:px-pad-page">
        <Link
          to="/home"
          aria-label="Back"
          className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink desktop:hidden"
        >
          ‹
        </Link>

        <h1 className="text-lg font-bold tracking-tight text-ink">
          Waiting on you
        </h1>
        <span
          data-testid="sample-data-marker"
          className="shrink-0 rounded-tag border border-border bg-elevated px-1.5 py-0.5 text-2xs font-medium text-ink-muted"
        >
          Sample data
        </span>

        <div
          role="tablist"
          aria-label="Filter items"
          onKeyDown={handleTabKeyDown}
          className="flex items-center gap-3"
        >
          <button
            ref={openTabRef}
            id="waiting-tab-open"
            type="button"
            role="tab"
            aria-selected={filter === 'open'}
            aria-controls="waiting-panel-open"
            tabIndex={filter === 'open' ? 0 : -1}
            onClick={() => appActions.setWaitingFilter('open')}
            className={`flex h-touch items-center rounded-control px-3 text-sm transition-quiet desktop:h-row-sm ${
              filter === 'open'
                ? 'bg-active font-semibold text-ink'
                : 'bg-transparent text-ink-muted hover:text-ink'
            }`}
          >
            Open · {openCount}
          </button>
          <button
            ref={archivedTabRef}
            id="waiting-tab-archived"
            type="button"
            role="tab"
            aria-selected={filter === 'archived'}
            aria-controls="waiting-panel-archived"
            tabIndex={filter === 'archived' ? 0 : -1}
            onClick={() => appActions.setWaitingFilter('archived')}
            className={`flex h-touch items-center rounded-control px-3 text-sm transition-quiet desktop:h-row-sm ${
              filter === 'archived'
                ? 'bg-active font-semibold text-ink'
                : 'bg-transparent text-ink-muted hover:text-ink'
            }`}
          >
            Archived
          </button>
        </div>
      </header>

      <div
        role="tabpanel"
        id={filter === 'open' ? 'waiting-panel-open' : 'waiting-panel-archived'}
        aria-labelledby={
          filter === 'open' ? 'waiting-tab-open' : 'waiting-tab-archived'
        }
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4.5 py-5 desktop:max-w-waiting-max desktop:px-pad-page desktop:py-pad-section"
      >
        {filter === 'open' ? (
          <>
            {visibleItems.length === 0 ? (
              <div
                data-testid="waiting-empty"
                className="py-8 text-center text-sm text-ink-muted"
              >
                All caught up
              </div>
            ) : (
              visibleItems.map((item) => (
                <WaitingItemCard
                  key={item.id}
                  item={item}
                  agent={
                    item.status === 'dismissed'
                      ? undefined
                      : agents.find((agent) => agent.id === item.agentId)
                  }
                />
              ))
            )}
            <ClearedList items={clearedItems} />
          </>
        ) : clearedItems.length === 0 ? (
          <div
            data-testid="archived-empty"
            className="py-8 text-center text-sm text-ink-muted"
          >
            Nothing archived
          </div>
        ) : (
          <ClearedList items={clearedItems} />
        )}
      </div>
    </AppFrame>
  );
}

function RealWaitingScreen() {
  const sidebar = useRealSidebarData();

  if (sidebar.workspaceUnavailable) {
    return (
      <AppFrame>
        <div
          data-testid="workspace-unavailable-pane"
          className="flex flex-1 items-center justify-center px-6 text-md text-ink-secondary"
        >
          {WORKSPACE_UNAVAILABLE_TEXT}
        </div>
      </AppFrame>
    );
  }

  if (
    !sidebar.workspacesLoading &&
    !sidebar.workspacesError &&
    sidebar.workspaces.length === 0
  ) {
    return (
      <AppFrame>
        <EmptyWorkspaceState />
      </AppFrame>
    );
  }

  return <WaitingScreenBody />;
}

export function WaitingScreen() {
  const snapshot = useSessionSnapshot();

  if (snapshot.state.status === 'authenticated') {
    return <RealWaitingScreen />;
  }

  return <WaitingScreenBody />;
}
