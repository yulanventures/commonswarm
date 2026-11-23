import { useEffect, useState } from 'react';

const PHONE_MEDIA_QUERY = '(max-width: 719px)';

function getMatches(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(PHONE_MEDIA_QUERY).matches;
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState<boolean>(getMatches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(PHONE_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setIsPhone(event.matches);
    };
    setIsPhone(media.matches);
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  return isPhone;
}
