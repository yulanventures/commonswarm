import { useEffect, useRef } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import {
  ClosedScreen,
  SessionCheckingScreen,
  SignedOutScreen,
} from './components/SessionGateScreens';
import {
  AppDataProvider,
  useSessionSnapshot,
  type DataController,
} from './data/queries';
import { AgentSessionScreen } from './screens/AgentSessionScreen';
import { ChannelScreen } from './screens/ChannelScreen';
import { PhoneHomeScreen } from './screens/PhoneHomeScreen';
import { WaitingScreen } from './screens/WaitingScreen';
import { appActions } from './store/appStore';

function GatedRoutes() {
  const snapshot = useSessionSnapshot();
  const location = useLocation();
  const routeKey = `${location.pathname}${location.search}${location.hash}`;
  const prevRouteKeyRef = useRef(routeKey);

  useEffect(() => {
    if (prevRouteKeyRef.current !== routeKey) {
      prevRouteKeyRef.current = routeKey;
      appActions.closeAddAgentDialog();
    }
  }, [routeKey]);

  if (snapshot.state.status === 'closed') {
    return <ClosedScreen reason={snapshot.state.reason} />;
  }
  if (snapshot.state.status === 'signed_out') {
    return <SignedOutScreen />;
  }
  if (snapshot.state.status === 'checking') {
    return <SessionCheckingScreen />;
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/agents/atlas" replace />} />
      <Route path="/home" element={<PhoneHomeScreen />} />
      <Route path="/agents/:id" element={<AgentSessionScreen />} />
      <Route path="/channels/:name" element={<ChannelScreen />} />
      <Route path="/waiting" element={<WaitingScreen />} />
      <Route path="*" element={<Navigate to="/agents/atlas" replace />} />
    </Routes>
  );
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
