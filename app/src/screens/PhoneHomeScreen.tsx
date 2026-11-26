import { Navigate } from 'react-router';
import { AppFrame } from '../components/AppFrame';
import { useIsPhone } from '../hooks/useIsPhone';

export function PhoneHomeScreen() {
  const isPhone = useIsPhone();

  if (!isPhone) {
    return <Navigate to="/" replace />;
  }

  return <AppFrame isPhoneHome>{null}</AppFrame>;
}
