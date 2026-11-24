import type { ReactNode } from 'react';
import { useAppStore } from '../store/appStore';
import { AddAgentDialog } from './AddAgentDialog';
import { PhoneBottomBar } from './PhoneBottomBar';
import { Sidebar } from './Sidebar';
import { WorkspaceRail } from './WorkspaceRail';

interface AppFrameProps {
  children: ReactNode;
  detailsPanel?: ReactNode;
  detailsLabel?: string;
  isPhoneHome?: boolean;
}

export function AppFrame({
  children,
  detailsPanel,
  detailsLabel = 'Details',
  isPhoneHome = false,
}: AppFrameProps) {
  const announcement = useAppStore((state) => state.announcement);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-ink desktop:flex-row">
      <div className="hidden w-sidebar shrink-0 bg-sidebar desktop:flex">
        <WorkspaceRail />
        <Sidebar />
      </div>

      {isPhoneHome ? (
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden desktop:hidden">
          <div className="flex min-h-0 flex-1">
            <WorkspaceRail />
            <Sidebar fullWidth />
          </div>
        </main>
      ) : (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      )}

      {detailsPanel ? (
        <aside
          aria-label={detailsLabel}
          className="hidden w-details shrink-0 flex-col border-l border-hairline p-pad-panel text-md wide:flex"
        >
          {detailsPanel}
        </aside>
      ) : null}

      <PhoneBottomBar />
      <AddAgentDialog />

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
    </div>
  );
}
