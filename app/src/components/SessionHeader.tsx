import { Link } from 'react-router';
import { COMPUTERS, HARNESSES } from '../data/fixtures';
import type { Agent, AgentState } from '../data/types';
import { useIsPhone } from '../hooks/useIsPhone';
import { Avatar } from './Avatar';

interface SessionHeaderProps {
  agent: Agent;
}

const PILL_STYLES: Record<
  AgentState,
  { container: string; dot: string; label: (elapsed: string) => string }
> = {
  waiting: {
    container: 'bg-needs-you-surface text-needs-you-ink',
    dot: 'bg-needs-you',
    label: (elapsed) =>
      elapsed ? `Waiting on you · ${elapsed}` : 'Waiting on you',
  },
  working: {
    container: 'bg-working-surface text-working-ink',
    dot: 'bg-working',
    label: (elapsed) =>
      elapsed && elapsed !== 'now' ? `Working · ${elapsed}` : 'Working',
  },
  idle: {
    container: 'bg-active text-ink-secondary',
    dot: 'bg-offline',
    label: (elapsed) => (elapsed ? `Idle · ${elapsed}` : 'Idle'),
  },
};

const PHONE_SUBTITLE_COLOR: Record<AgentState, string> = {
  waiting: 'text-needs-you-ink',
  working: 'text-working-ink',
  idle: 'text-ink-muted',
};

const PHONE_STATE_TEXT: Record<AgentState, string> = {
  waiting: 'Waiting on you',
  working: 'Working',
  idle: 'Idle',
};

export function SessionHeader({ agent }: SessionHeaderProps) {
  const isPhone = useIsPhone();
  const computer = COMPUTERS.find((c) => c.id === agent.computerId);
  const harness = HARNESSES.find((h) => h.id === agent.harnessId);
  const pill = PILL_STYLES[agent.state];
  const computerName = computer?.shortName ?? agent.computerId;
  const harnessName = harness?.name ?? agent.harnessId;

  if (isPhone) {
    return (
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4.5 pt-phone-header-top pb-3">
        <Link
          to="/home"
          aria-label="Back"
          className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink"
        >
          ‹
        </Link>
        <Avatar
          label={agent.initial}
          tone={agent.tone}
          shape="agent"
          size="lg"
        />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-phone-title font-bold">
            {agent.name}
          </span>
          <span
            data-testid="session-state-pill"
            className={`truncate text-sm ${PHONE_SUBTITLE_COLOR[agent.state]}`}
          >
            {PHONE_STATE_TEXT[agent.state]} · {computerName}
          </span>
        </div>
      </header>
    );
  }

  return (
    <header className="flex h-header shrink-0 items-center gap-3 border-b border-hairline px-pad-header">
      <Avatar label={agent.initial} tone={agent.tone} shape="agent" size="md" />

      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-lg font-bold tracking-tight">
          {agent.name}
        </span>
        <span className="truncate text-xs text-ink-muted">
          {harnessName} · {computerName} · {agent.folder}
        </span>
      </div>

      <span
        data-testid="session-state-pill"
        className={`ml-2 inline-flex h-pill shrink-0 items-center gap-1.5 rounded-card px-2.5 text-xs font-semibold transition-quiet ${pill.container}`}
      >
        <span
          aria-hidden="true"
          className={`size-dot-xs rounded-full ${pill.dot}`}
        />
        {pill.label(agent.stateElapsed)}
      </span>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => undefined}
        className="inline-flex h-btn-sm shrink-0 items-center rounded-control border border-border bg-transparent px-3.5 text-sm font-medium text-ink-strong transition-quiet hover:border-border-strong hover:bg-raised hover:text-ink"
      >
        Stop
      </button>
    </header>
  );
}
