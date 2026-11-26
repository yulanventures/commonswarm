import { COMPUTERS, HARNESSES, PEOPLE } from '../data/fixtures';
import type { Agent } from '../data/types';

interface SessionDetailsPanelProps {
  agent: Agent;
}

export function SessionDetailsPanel({ agent }: SessionDetailsPanelProps) {
  const computer = agent.computerId
    ? COMPUTERS.find((c) => c.id === agent.computerId)
    : undefined;
  const harness = agent.harnessId
    ? HARNESSES.find((h) => h.id === agent.harnessId)
    : undefined;
  const computerName = computer?.shortName ?? agent.computerId;
  const harnessName = harness?.name ?? agent.harnessId;
  const meta = agent.sessionMeta;
  const watchers = (meta?.watcherIds ?? [])
    .map((id) => PEOPLE.find((person) => person.id === id))
    .filter((person) => person !== undefined);

  const hasSessionRows = Boolean(computerName || harnessName || meta);

  return (
    <div className="flex h-full flex-col gap-5.5">
      {hasSessionRows ? (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-xs font-semibold tracking-label text-ink-muted">
            SESSION
          </h2>
          {computerName ? (
            <div className="flex justify-between gap-2">
              <span className="text-ink-muted">Device</span>
              <span>{computerName}</span>
            </div>
          ) : null}
          {harnessName ? (
            <div className="flex justify-between gap-2">
              <span className="text-ink-muted">Harness</span>
              <span>{harnessName}</span>
            </div>
          ) : null}
          {meta ? (
            <>
              <div className="flex justify-between gap-2">
                <span className="text-ink-muted">Branch</span>
                <span className="truncate font-mono text-xs">
                  {meta.branch}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-ink-muted">Context</span>
                <span>{meta.contextUsedPercent}% used</span>
              </div>
            </>
          ) : null}
        </section>
      ) : (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-xs font-semibold tracking-label text-ink-muted">
            AGENT
          </h2>
          {agent.model ? (
            <div className="flex justify-between gap-2">
              <span className="text-ink-muted">Model</span>
              <span className="truncate">{agent.model}</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Status</span>
            <span className="truncate">{agent.sidebarStateLabel}</span>
          </div>
        </section>
      )}

      {meta ? (
        <section className="flex flex-col gap-2.5">
          <div className="flex justify-between text-xs font-semibold tracking-label text-ink-muted">
            <h2>CHANGES</h2>
            <span className="tracking-normal">
              <span className="text-working-ink">+{meta.totalAdded}</span>{' '}
              {meta.totalRemoved > 0 ? (
                <span className="text-needs-you-ink">−{meta.totalRemoved}</span>
              ) : null}
            </span>
          </div>
          {meta.files.map((file) => (
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
      ) : null}

      {watchers.length > 0 ? (
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
      ) : null}
    </div>
  );
}
