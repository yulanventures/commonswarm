import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppFrame } from './components/AppFrame';
import { EmptyWorkspaceState } from './components/EmptyWorkspaceState';
import {
  ClosedScreen,
  SessionCheckingScreen,
  SessionRecoveryScreen,
  SignedOutScreen,
} from './components/SessionGateScreens';
import {
  AppDataProvider,
  WORKSPACE_UNAVAILABLE_TEXT,
  useDataController,
  useRealSidebarData,
  useSessionSnapshot,
  useWorkspaceLiveUpdates,
  type DataController,
} from './data/queries';
import { AgentSessionScreen } from './screens/AgentSessionScreen';
import { ChannelScreen } from './screens/ChannelScreen';
import { PhoneHomeScreen } from './screens/PhoneHomeScreen';
import { WaitingScreen } from './screens/WaitingScreen';
import { appActions, useAppStore } from './store/appStore';

function AuthenticatedLiveBridge() {
  const { sessionGate } = useDataController();
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const activeWorkspaceId =
    selectedWorkspaceId ?? sessionGate.fenceTracker.activeWorkspaceId;
  useWorkspaceLiveUpdates(activeWorkspaceId);
  return null;
}

function DefaultRealRoute() {
  const data = useRealSidebarData();

  if (data.workspaceUnavailable) {
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

  if (data.workspacesLoading || data.sidebarLoading) {
    return (
      <AppFrame>
        <div
          data-testid="default-route-loading"
          aria-busy="true"
          className="flex flex-1 items-center justify-center px-6"
        >
          <div className="flex w-44 flex-col gap-2.5" aria-label="Loading">
            <div className="h-3 w-3/4 animate-pulse rounded-sm bg-elevated" />
            <div className="h-3 w-1/2 animate-pulse rounded-sm bg-elevated" />
          </div>
        </div>
      </AppFrame>
    );
  }

  if (data.sidebarError) {
    return (
      <AppFrame>
        <div
          data-testid="default-route-error"
          className="flex flex-1 items-center justify-center gap-3 px-6 text-sm text-ink-secondary"
        >
          <span>Couldn&apos;t load workspace.</span>
          <button
            type="button"
            onClick={data.retrySidebar}
            className="shrink-0 rounded-control border border-border bg-raised px-2.5 py-1 text-xs font-medium text-ink transition-quiet hover:border-border-strong hover:bg-active"
          >
            Retry
          </button>
        </div>
      </AppFrame>
    );
  }

  if (data.workspaces.length === 0) {
    return (
      <AppFrame>
        <EmptyWorkspaceState />
      </AppFrame>
    );
  }

  if (data.channels.length > 0) {
    const firstChannel = data.channels[0]!;
    const target = firstChannel.id ?? firstChannel.name;
    return <Navigate to={`/channels/${encodeURIComponent(target)}`} replace />;
  }

  if (data.directMessages.length > 0) {
    return (
      <Navigate
        to={`/channels/${encodeURIComponent(data.directMessages[0]!.id)}`}
        replace
      />
    );
  }

  return <Navigate to="/waiting" replace />;
}

function GatedRoutes() {
  const { sessionGate } = useDataController();
  const snapshot = useSessionSnapshot();
  const location = useLocation();
  const routeKey = `${location.pathname}${location.search}${location.hash}`;
  const prevRouteKeyRef = useRef(routeKey);
  const privateViewRef = useRef<HTMLDivElement | null>(null);
  const [, setRetireTick] = useState(0);

  useEffect(() => {
    if (prevRouteKeyRef.current !== routeKey) {
      prevRouteKeyRef.current = routeKey;
      appActions.closeAddAgentDialog();
    }
  }, [routeKey]);

  useEffect(() => {
    return sessionGate.onSynchronousViewRetire(() => {
      // Immediately conceal the mounted private subtree in case React cannot flush re-entrantly,
      // then synchronously commit the retirement so private DOM is unmounted before pagehide returns.
      const el = privateViewRef.current;
      if (el) {
        el.hidden = true;
        el.setAttribute('aria-hidden', 'true');
      }
      try {
        flushSync(() => {
          setRetireTick((tick) => tick + 1);
        });
      } catch {
        // Fallback when already inside a React render: the subtree is already concealed above.
      }
    });
  }, [sessionGate]);

  if (snapshot.state.status === 'closed') {
    return <ClosedScreen reason={snapshot.state.reason} />;
  }
  if (snapshot.state.status === 'signed_out') {
    return <SignedOutScreen />;
  }
  if (snapshot.state.status === 'checking') {
    return <SessionCheckingScreen />;
  }
  if (snapshot.state.status === 'recovery') {
    return (
      <SessionRecoveryScreen
        onRetry={() => {
          void sessionGate.reverify();
        }}
      />
    );
  }

  const defaultRouteElement =
    snapshot.state.status === 'authenticated' ? (
      <DefaultRealRoute />
    ) : (
      <Navigate to="/agents/atlas" replace />
    );

  const routes = (
    <Routes>
      <Route path="/" element={defaultRouteElement} />
      <Route path="/home" element={<PhoneHomeScreen />} />
      <Route path="/agents/:id" element={<AgentSessionScreen />} />
      <Route path="/channels/:name" element={<ChannelScreen />} />
      <Route path="/waiting" element={<WaitingScreen />} />
      <Route path="*" element={defaultRouteElement} />
    </Routes>
  );

  if (snapshot.state.status === 'authenticated') {
    return (
      <div
        ref={privateViewRef}
        data-testid="private-view-root"
        className="h-full w-full"
      >
        <AuthenticatedLiveBridge />
        {routes}
      </div>
    );
  }

  return routes;
}

export interface AppRoutesProps {
  controller?: DataController;
}

export function AppRoutes({ controller }: AppRoutesProps = {}) {
  return (
    <AppDataProvider controller={controller}>
      <GatedRoutes />
    </AppDataProvider>
  );
}

export function App({ controller }: AppRoutesProps = {}) {
  return (
    <HashRouter>
      <AppRoutes controller={controller} />
    </HashRouter>
  );
}
