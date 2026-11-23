import type { WorkingCardData } from '../data/types';

interface WorkingCardProps {
  data: WorkingCardData;
}

export function WorkingCard({ data }: WorkingCardProps) {
  return (
    <div className="flex max-w-channel-card-max flex-wrap items-center gap-3 rounded-card border border-card-border bg-raised px-3.5 py-3">
      <span
        aria-hidden="true"
        className="size-dot-md shrink-0 rounded-full bg-working"
      />
      <span className="font-medium text-ink">{data.statusLabel}</span>
      <span className="font-mono text-sm text-ink-secondary">
        {data.activity}
      </span>
      <div className="flex-1" />
      <span className="text-sm text-ink-muted">{data.meta}</span>
    </div>
  );
}
