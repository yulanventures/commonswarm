import type { QueuedMessageEvent } from '../data/types';

interface QueueLineProps {
  items: QueuedMessageEvent[];
}

export function QueueLine({ items }: QueueLineProps) {
  if (items.length === 0) return null;
  const first = items[0];
  if (!first) return null;

  return (
    <div className="hidden h-row-sm items-center gap-2 text-sm text-ink-muted desktop:flex">
      <span className="font-medium text-ink-secondary">
        Queued · {items.length}
      </span>
      <span className="truncate">
        {first.authorName}: “{first.text}”
      </span>
    </div>
  );
}
