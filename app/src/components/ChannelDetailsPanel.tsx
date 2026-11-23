import { Link } from 'react-router';
import type { Agent, AgentState } from '../data/types';

interface ChannelDetailsPanelProps {
  agents: Agent[];
}

const ACTIVITY_COLOR: Record<AgentState, string> = {
  waiting: 'text-needs-you',
  working: 'text-working',
  idle: 'text-ink-muted',
};

export function ChannelDetailsPanel({ agents }: ChannelDetailsPanelProps) {
  return (
    <div className="flex flex-col gap-3.5">
      <h2 className="text-xs font-semibold tracking-label text-ink-muted">
        IN THIS CHANNEL
      </h2>
      {agents.map((agent) => (
        <Link
          key={agent.id}
          to={`/agents/${agent.id}`}
          className="flex flex-col gap-1 rounded-card border border-card-border p-3 text-ink no-underline transition-quiet hover:border-border hover:bg-raised"
        >
          <span className="font-semibold">{agent.name}</span>
          <span className={`text-sm ${ACTIVITY_COLOR[agent.state]}`}>
            {agent.channelActivity}
          </span>
        </Link>
      ))}
    </div>
  );
}
