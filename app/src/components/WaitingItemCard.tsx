import { Link } from 'react-router';
import type { Agent, WaitingItem } from '../data/types';
import { appActions } from '../store/appStore';
import { Avatar } from './Avatar';

interface WaitingItemCardProps {
  item: WaitingItem;
  agent: Agent | undefined;
}

export function WaitingItemCard({ item, agent }: WaitingItemCardProps) {
  const initial = agent?.initial ?? item.agentId.charAt(0).toUpperCase();
  const tone = agent?.tone ?? 'purple';

  if (item.status === 'dismissed') {
    return (
      <div
        data-testid={`dismissed-row-${item.id}`}
        className="flex min-h-row-xl items-center gap-2.5 rounded-card border border-dashed border-border px-pad-card-x text-md text-ink-muted transition-quiet"
      >
        <span className="truncate">Dismissed “{item.title}”</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => appActions.undoDismissWaitingItem(item.id)}
          className="h-touch shrink-0 rounded-sm border-0 bg-transparent px-3 text-sm font-semibold text-accent transition-quiet hover:bg-elevated desktop:h-row-sm"
        >
          Undo
        </button>
      </div>
    );
  }

  if (item.status === 'resolved') {
    return null;
  }

  if (item.kind === 'approval') {
    return (
      <article
        aria-label={item.title}
        className="flex flex-col gap-3 rounded-surface border border-approval-border bg-approval-surface px-pad-card-x py-pad-card-y"
      >
        <div className="flex items-center gap-2.5">
          <Avatar label={initial} tone={tone} shape="agent" size="sm" />
          <span className="font-semibold text-ink">{item.title}</span>
          <span className="text-sm text-ink-muted">{item.meta}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => appActions.dismissWaitingItem(item.id)}
            className="h-touch rounded-sm border-0 bg-transparent px-3 text-sm text-ink-secondary transition-quiet hover:bg-active hover:text-ink desktop:h-row-sm"
          >
            Dismiss
          </button>
        </div>

        <div className="overflow-x-auto rounded-sm bg-sidebar px-3 py-2.5 font-mono text-sm text-ink-body">
          {item.command}
        </div>

        <div className="flex flex-wrap gap-2">
          {item.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => appActions.answerApproval(item.id, option.id)}
              className={
                option.primary
                  ? 'h-touch rounded-control border-0 bg-accent px-4 text-md font-semibold text-on-accent transition-quiet hover:opacity-90 desktop:h-btn-md'
                  : 'h-touch rounded-control border border-border-strong bg-transparent px-4 text-md font-medium text-ink transition-quiet hover:bg-active desktop:h-btn-md'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </article>
    );
  }

  if (item.kind === 'choice') {
    return (
      <article
        aria-label={item.title}
        className="flex flex-col gap-3 rounded-surface border border-card-border bg-raised px-pad-card-x py-pad-card-y"
      >
        <div className="flex items-center gap-2.5">
          <Avatar label={initial} tone={tone} shape="agent" size="sm" />
          <span className="font-semibold text-ink">{item.title}</span>
          <span className="text-sm text-ink-muted">{item.meta}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => appActions.dismissWaitingItem(item.id)}
            className="h-touch rounded-sm border-0 bg-transparent px-3 text-sm text-ink-secondary transition-quiet hover:bg-active hover:text-ink desktop:h-row-sm"
          >
            Dismiss
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {item.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => appActions.answerChoice(item.id, option.id)}
              className={
                option.recommended
                  ? 'h-touch rounded-control border border-accent-border bg-accent-tint px-4 text-md font-semibold text-accent-ink transition-quiet hover:opacity-90 desktop:h-btn-md'
                  : 'h-touch rounded-control border border-border-strong bg-transparent px-4 text-md font-medium text-ink transition-quiet hover:bg-active desktop:h-btn-md'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </article>
    );
  }

  return (
    <article
      aria-label={item.title}
      className="flex flex-wrap items-center gap-2.5 rounded-surface border border-card-border bg-raised px-pad-card-x py-3.5"
    >
      <Avatar label={initial} tone={tone} shape="agent" size="sm" />
      <span className="font-semibold text-ink">{item.title}</span>
      <span className="text-sm text-ink-muted">{item.meta}</span>
      <div className="flex-1" />
      <Link
        to={item.targetRoute}
        className="flex h-touch items-center rounded-control border border-border-strong bg-transparent px-3.5 text-sm font-medium text-ink no-underline transition-quiet hover:bg-active desktop:h-btn-sm"
      >
        Open
      </Link>
      <button
        type="button"
        onClick={() => appActions.dismissWaitingItem(item.id)}
        className="h-touch rounded-sm border-0 bg-transparent px-3 text-sm text-ink-secondary transition-quiet hover:bg-active hover:text-ink desktop:h-row-sm"
      >
        Dismiss
      </button>
    </article>
  );
}
