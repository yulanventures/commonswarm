import { useParams } from 'react-router';
import { AppFrame } from '../components/AppFrame';
import { ApprovalCard } from '../components/ApprovalCard';
import { Avatar } from '../components/Avatar';
import { Composer } from '../components/Composer';
import { QueueLine } from '../components/QueueLine';
import { SessionDetailsPanel } from '../components/SessionDetailsPanel';
import { SessionHeader } from '../components/SessionHeader';
import { StepList } from '../components/StepList';
import { PEOPLE } from '../data/fixtures';
import type {
  AgentStepsEvent,
  AgentTextEvent,
  ApprovalRequestEvent,
  PersonMessageEvent,
  QueuedMessageEvent,
  SessionEvent,
} from '../data/types';
import { useIsPhone } from '../hooks/useIsPhone';
import { appActions, useAppStore } from '../store/appStore';

type AgentBlockEvent =
  | AgentStepsEvent
  | AgentTextEvent
  | ApprovalRequestEvent;

type GroupedEntry =
  | { kind: 'person'; event: PersonMessageEvent }
  | { kind: 'agent_turn'; id: string; durationLabel?: string; items: AgentBlockEvent[] };

function groupSessionEvents(events: SessionEvent[]): {
  entries: GroupedEntry[];
  queued: QueuedMessageEvent[];
} {
  const entries: GroupedEntry[] = [];
  const queued: QueuedMessageEvent[] = [];

  for (const event of events) {
    if (event.type === 'queued_message') {
      queued.push(event);
      continue;
    }
    if (event.type === 'person_message') {
      entries.push({ kind: 'person', event });
      continue;
    }

    const last = entries[entries.length - 1];
    if (last && last.kind === 'agent_turn') {
      last.items.push(event);
      if (event.type === 'agent_steps' && !last.durationLabel) {
        last.durationLabel = event.durationLabel;
      }
    } else {
      entries.push({
        kind: 'agent_turn',
        id: event.id,
        durationLabel:
          event.type === 'agent_steps' ? event.durationLabel : undefined,
        items: [event],
      });
    }
  }

  return { entries, queued };
}

export function AgentSessionScreen() {
  const { id } = useParams<{ id: string }>();
  const isPhone = useIsPhone();
  const agents = useAppStore((state) => state.agents);
  const agent = agents.find((item) => item.id === id) ?? agents[0];

  if (!agent) return null;

  const { entries, queued } = groupSessionEvents(agent.events);

  return (
    <AppFrame
      detailsPanel={<SessionDetailsPanel agent={agent} />}
      detailsLabel="Session details"
    >
      <SessionHeader agent={agent} />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4.5 pt-4.5 pb-4 desktop:gap-5.5 desktop:px-pad-page desktop:pt-pad-section">
        {entries.map((entry) => {
          if (entry.kind === 'person') {
            const person = PEOPLE.find((p) => p.id === entry.event.authorId);
            const authorName = person?.name ?? entry.event.authorId;
            const initials = person?.initials ?? authorName.slice(0, 2).toUpperCase();
            const tone = person?.tone ?? 'maya';

            if (isPhone) {
              return (
                <div
                  key={entry.event.id}
                  className="max-w-phone-bubble-max self-end rounded-modal bg-active px-3.5 py-2.5 text-ink"
                >
                  {entry.event.phoneText ?? entry.event.text}
                </div>
              );
            }

            return (
              <div key={entry.event.id} className="flex gap-3.5">
                <Avatar
                  label={initials}
                  tone={tone}
                  shape="person"
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-ink">{authorName}</span>
                    <span className="text-xs text-ink-muted">
                      {entry.event.timestamp}
                    </span>
                  </div>
                  <div className="text-ink-body">{entry.event.text}</div>
                </div>
              </div>
            );
          }

          if (isPhone) {
            return (
              <div key={entry.id} className="flex flex-col gap-4">
                {entry.items.map((item) => {
                  if (item.type === 'agent_steps') {
                    return (
                      <div key={item.id} className="flex flex-col gap-3">
                        <div className="text-sm text-ink-muted">
                          {item.durationLabel} · {item.steps.length} steps
                        </div>
                        <StepList steps={item.steps} />
                      </div>
                    );
                  }
                  if (item.type === 'agent_text') {
                    return (
                      <div key={item.id} className="text-ink-body">
                        {item.phoneText ?? item.text}
                      </div>
                    );
                  }
                  return (
                    <ApprovalCard
                      key={item.id}
                      title={item.title}
                      command={item.command}
                      options={item.options}
                      settledLabel={item.settledLabel}
                      onSelect={(optionId) =>
                        appActions.answerApproval(item.approvalId, optionId)
                      }
                      compactWidth={false}
                    />
                  );
                })}
              </div>
            );
          }

          return (
            <div key={entry.id} className="flex gap-3.5">
              <Avatar
                label={agent.initial}
                tone={agent.tone}
                shape="agent"
                size="lg"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-ink">{agent.name}</span>
                  {entry.durationLabel ? (
                    <span className="text-xs text-ink-muted">
                      {entry.durationLabel}
                    </span>
                  ) : null}
                </div>

                {entry.items.map((item) => {
                  if (item.type === 'agent_steps') {
                    return <StepList key={item.id} steps={item.steps} />;
                  }
                  if (item.type === 'agent_text') {
                    return (
                      <div
                        key={item.id}
                        className="max-w-message-max text-ink-body"
                      >
                        {item.text}
                      </div>
                    );
                  }
                  return (
                    <ApprovalCard
                      key={item.id}
                      title={item.title}
                      command={item.command}
                      options={item.options}
                      settledLabel={item.settledLabel}
                      onSelect={(optionId) =>
                        appActions.answerApproval(item.approvalId, optionId)
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 desktop:px-pad-page desktop:pb-6">
        <QueueLine items={queued} />
        <Composer
          targetKey={`agent:${agent.id}`}
          placeholder={`Message ${agent.name}. @ people, # channels, / commands`}
          phonePlaceholder={`Message ${agent.name}`}
          inputLabel={`Message ${agent.name}`}
          sendActiveWhenEmpty
          onSend={() => appActions.sendAgentMessage(agent.id)}
          agentControls={{
            agentId: agent.id,
            model: agent.model,
            mode: agent.mode,
          }}
        />
      </div>
    </AppFrame>
  );
}
