import type { ClearedItem } from '../data/types';

interface ClearedListProps {
  items: ClearedItem[];
}

export function ClearedList({ items }: ClearedListProps) {
  if (items.length === 0) return null;

  return (
    <section aria-label="Cleared for you today" className="mt-3.5">
      <h2 className="mb-1 text-xs font-semibold tracking-label text-ink-muted">
        CLEARED FOR YOU TODAY
      </h2>
      <div className="flex flex-col text-md text-ink-secondary">
        {items.map((item, index) => (
          <div
            key={item.id}
            className={`flex min-h-row-lg items-center gap-2.5 py-1.5 ${
              index < items.length - 1 ? 'border-b border-hairline' : ''
            }`}
          >
            <span className="flex-1 text-ink-strong">{item.title}</span>
            <span className="text-ink-muted">{item.reason}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
