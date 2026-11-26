import { Link, useLocation } from 'react-router';
import { useRealSidebarData, useSessionSnapshot } from '../data/queries';
import { getOpenWaitingCount, useAppStore } from '../store/appStore';

function PhoneBottomBarView({
  openWaitingCount,
  agentsHref,
}: {
  openWaitingCount: number | null;
  agentsHref: string;
}) {
  const location = useLocation();

  const isHome =
    location.pathname === '/home' || location.pathname.startsWith('/channels');
  const isWaiting = location.pathname.startsWith('/waiting');
  const isAgents = location.pathname.startsWith('/agents');
  const isYou = location.pathname === '/home' && location.hash === '#people';

  return (
    <nav
      aria-label="Sections"
      className="grid h-phone-nav shrink-0 grid-cols-4 border-t border-hairline bg-ground px-2.5 pt-2 pb-5.5 text-center text-xs font-medium desktop:hidden"
    >
      <Link
        to="/home"
        aria-current={isHome && !isYou ? 'page' : undefined}
        className={`flex min-h-touch flex-col items-center justify-center no-underline transition-quiet ${
          isHome && !isYou
            ? 'font-semibold text-accent'
            : 'text-ink-muted hover:text-ink'
        }`}
      >
        Home
      </Link>
      <Link
        to="/waiting"
        aria-current={isWaiting ? 'page' : undefined}
        className={`flex min-h-touch flex-col items-center justify-center gap-0.5 no-underline transition-quiet ${
          isWaiting
            ? 'font-semibold text-accent'
            : 'text-ink-muted hover:text-ink'
        }`}
      >
        {openWaitingCount !== null && openWaitingCount > 0 ? (
          <span
            data-testid="phone-waiting-count"
            className="flex h-badge-sm min-w-badge items-center justify-center rounded-control bg-needs-you px-1 text-badge font-bold text-on-needs-you"
          >
            {openWaitingCount > 99 ? '99+' : openWaitingCount}
          </span>
        ) : null}
        <span>Waiting</span>
      </Link>
      <Link
        to={agentsHref}
        aria-current={isAgents ? 'page' : undefined}
        className={`flex min-h-touch flex-col items-center justify-center no-underline transition-quiet ${
          isAgents
            ? 'font-semibold text-accent'
            : 'text-ink-muted hover:text-ink'
        }`}
      >
        Agents
      </Link>
      <Link
        to="/home#people"
        aria-current={isYou ? 'page' : undefined}
        className={`flex min-h-touch flex-col items-center justify-center no-underline transition-quiet ${
          isYou ? 'font-semibold text-accent' : 'text-ink-muted hover:text-ink'
        }`}
      >
        You
      </Link>
    </nav>
  );
}

function RealPhoneBottomBar() {
  const { waitingCount, agents } = useRealSidebarData();
  const agentsHref =
    agents.length > 0 ? `/agents/${encodeURIComponent(agents[0]!.id)}` : '/home';
  return (
    <PhoneBottomBarView
      openWaitingCount={waitingCount}
      agentsHref={agentsHref}
    />
  );
}

function SamplePhoneBottomBar() {
  const openWaitingCount = useAppStore(getOpenWaitingCount);
  return (
    <PhoneBottomBarView
      openWaitingCount={openWaitingCount}
      agentsHref="/agents/atlas"
    />
  );
}

export function PhoneBottomBar() {
  const snapshot = useSessionSnapshot();
  if (snapshot.state.status === 'authenticated') {
    return <RealPhoneBottomBar />;
  }
  return <SamplePhoneBottomBar />;
}
