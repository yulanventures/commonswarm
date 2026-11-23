import { COMPUTERS, HARNESSES, PEOPLE } from '../data/fixtures';
import type { Agent } from '../data/types';

interface SessionDetailsPanelProps {
  agent: Agent;
}

export function SessionDetailsPanel({ agent }: SessionDetailsPanelProps) {
  const computer = COMPUTERS.find((c) => c.id === agent.computerId);
  const harness = HARNESSES.find((h) => h.id === agent.harnessId);
  const watchers = agent.sessionMeta.watcherIds
    .map((id) => PEOPLE.find((person) => person.id === id))
    .filter((person) => person !== undefined);

  return (
    <div className="flex h-full flex-col gap-5.5">
      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-semibold tracking-label text-ink-muted">
          SESSION
        </h2>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Device</span>
          <span>{computer?.shortName ?? agent.computerId}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Harness</span>
          <span>{harness?.name ?? agent.harnessId}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Branch</span>
          <span className="truncate font-mono text-xs">
            {agent.sessionMeta.branch}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Context</span>
          <span>{agent.sessionMeta.contextUsedPercent}% used</span>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex justify-between text-xs font-semibold tracking-label text-ink-muted">
          <h2>CHANGES</h2>
          <span className="tracking-normal">
            <span className="text-working-ink">
              +{agent.sessionMeta.totalAdded}
            </span>{' '}
            {agent.sessionMeta.totalRemoved > 0 ? (
              <span className="text-needs-you-ink">
                −{agent.sessionMeta.totalRemoved}
              </span>
            ) : null}
          </span>
        </div>
        {agent.sessionMeta.files.map((file) => (
          <div
            key={file.path}
            className="flex justify-between gap-2 font-mono text-xs text-ink-strong"
          >
            <span className="truncate">{file.path}</span>
            <span className="shrink-0">
              <span className="text-working-ink">+{file.added}</span>
              {file.removed > 0 ? (
                <>
                  {' '}
                  <span className="text-needs-you-ink">−{file.removed}</span>
                </>
              ) : null}
            </span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-semibold tracking-label text-ink-muted">
          WATCHING
        </h2>
        {watchers.map((watcher, index) => (
          <div
            key={watcher.id}
            className={`flex items-center gap-2 ${
              index === 0 ? 'text-ink' : 'text-ink-secondary'
            }`}
          >
            <span
              aria-hidden="true"
              className="size-dot-md rounded-full bg-working"
            />
            <span>{watcher.name}</span>
          </div>
        ))}
      </section>

      <div className="flex-1" />

      <a
        href={`#/agents/${agent.id}`}
        onClick={(event) => event.preventDefault()}
        className="text-sm text-link no-underline transition-quiet hover:text-link-hover"
      >
        Open this session on your phone
      </a>
    </div>
  );
}
