import type { ReviewCardData, ReviewChip } from '../data/types';

interface ReviewCardProps {
  data: ReviewCardData;
}

const CHIP_STYLES: Record<ReviewChip['tone'], string> = {
  working: 'bg-working-surface text-working-ink',
  neutral: 'bg-active text-ink-strong',
  'needs-you': 'bg-needs-you-surface text-needs-you-ink',
};

export function ReviewCard({ data }: ReviewCardProps) {
  return (
    <div className="flex max-w-channel-card-max flex-col gap-2.5 rounded-card border border-card-border bg-raised px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">{data.title}</span>
        <span className="font-mono text-sm text-ink-muted">{data.commit}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {data.chips.map((chip) => (
          <span
            key={chip.label}
            className={`flex h-review-chip items-center rounded-sm px-2.5 text-sm ${CHIP_STYLES[chip.tone]}`}
          >
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}
