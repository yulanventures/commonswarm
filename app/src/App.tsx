import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AgentSessionScreen } from './screens/AgentSessionScreen';
import { ChannelScreen } from './screens/ChannelScreen';
import { PhoneHomeScreen } from './screens/PhoneHomeScreen';
import { WaitingScreen } from './screens/WaitingScreen';

export function AppRoutes() {
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

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
