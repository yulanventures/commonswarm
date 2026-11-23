import { Link, useParams } from 'react-router';
import { AppFrame } from '../components/AppFrame';
import { ChannelDetailsPanel } from '../components/ChannelDetailsPanel';
import { Composer } from '../components/Composer';
import { MessageRow } from '../components/MessageRow';
import { ReviewCard } from '../components/ReviewCard';
import { WorkingCard } from '../components/WorkingCard';
import { PEOPLE } from '../data/fixtures';
import { appActions, useAppStore } from '../store/appStore';

export function ChannelScreen() {
  const { name } = useParams<{ name: string }>();
  const channels = useAppStore((state) => state.channels);
  const agents = useAppStore((state) => state.agents);

  const channel =
    channels.find((item) => item.name === name) ??
    channels.find((item) => item.name === 'launch') ??
    channels[0];

  if (!channel) return null;

  const channelAgents = channel.agentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent) => agent !== undefined);

  const workingCount = channelAgents.filter(
    (agent) => agent.state === 'working' || agent.state === 'waiting',
  ).length;

  return (
    <AppFrame
      detailsPanel={<ChannelDetailsPanel agents={channelAgents} />}
      detailsLabel="Channel details"
    >
      <header className="flex h-header shrink-0 items-center gap-3 border-b border-hairline px-4.5 desktop:px-pad-header">
        <Link
          to="/home"
          aria-label="Back"
          className="-ml-2.5 flex size-touch shrink-0 items-center justify-center text-dialog-title text-ink-strong no-underline transition-quiet hover:text-ink desktop:hidden"
        >
          ‹
        </Link>

        <h1 className="text-lg font-bold tracking-tight text-ink">
          # {channel.name}
        </h1>
        <span className="hidden text-sm text-ink-muted desktop:inline">
          {channel.peopleCount} people · {channelAgents.length}{' '}
          {channelAgents.length === 1 ? 'agent' : 'agents'}
        </span>

        <div className="flex-1" />

        {workingCount > 0 ? (
          <span className="inline-flex h-pill shrink-0 items-center gap-1.5 rounded-card bg-working-surface px-2.5 text-xs font-semibold text-working-ink">
            <span
              aria-hidden="true"
              className="size-dot-xs rounded-full bg-working"
            />
            {workingCount} working
          </span>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4.5 pt-5 pb-4 desktop:px-pad-page desktop:pt-6.5">
        {channel.messages.map((message) => {
          if (message.authorType === 'person') {
            const person = PEOPLE.find((p) => p.id === message.authorId);
            return (
              <MessageRow
                key={message.id}
                authorName={person?.name ?? message.authorId}
                avatarLabel={person?.initials ?? '??'}
                avatarTone={person?.tone ?? 'maya'}
                authorType="person"
                timestamp={message.timestamp}
                segments={message.segments}
              />
            );
          }

          const agent = agents.find((a) => a.id === message.authorId);
          return (
            <MessageRow
              key={message.id}
              authorName={agent?.name ?? message.authorId}
              avatarLabel={agent?.initial ?? '?'}
              avatarTone={agent?.tone ?? 'purple'}
              authorType="agent"
              timestamp={message.timestamp}
              segments={message.segments}
            >
              {message.workingCard ? (
                <WorkingCard data={message.workingCard} />
              ) : null}
              {message.reviewCard ? (
                <ReviewCard data={message.reviewCard} />
              ) : null}
            </MessageRow>
          );
        })}
      </div>

      <div className="shrink-0 desktop:px-pad-page desktop:pb-6">
        <Composer
          targetKey={`channel:${channel.name}`}
          placeholder={`Message # ${channel.name}. @ people, # channels, / commands`}
          phonePlaceholder={`Message # ${channel.name}`}
          inputLabel={`Message # ${channel.name}`}
          onSend={() => appActions.sendChannelMessage(channel.name)}
          channelChipLabel={`To: # ${channel.name}`}
        />
      </div>
    </AppFrame>
  );
}
