import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import {
  ClosedScreen,
  SessionCheckingScreen,
  SessionRecoveryScreen,
  SignedOutScreen,
} from './components/SessionGateScreens';
import {
  AppDataProvider,
  useDataController,
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

  const routes = (
    <Routes>
      <Route path="/" element={<Navigate to="/agents/atlas" replace />} />
      <Route path="/home" element={<PhoneHomeScreen />} />
      <Route path="/agents/:id" element={<AgentSessionScreen />} />
      <Route path="/channels/:name" element={<ChannelScreen />} />
      <Route path="/waiting" element={<WaitingScreen />} />
      <Route path="*" element={<Navigate to="/agents/atlas" replace />} />
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
