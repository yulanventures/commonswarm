import type { ApprovalOption } from '../data/types';
import { useIsPhone } from '../hooks/useIsPhone';

interface ApprovalCardProps {
  title: string;
  command: string;
  options: ApprovalOption[];
  settledLabel?: string;
  onSelect: (optionId: string) => void;
  compactWidth?: boolean;
}

export function ApprovalCard({
  title,
  command,
  options,
  settledLabel,
  onSelect,
  compactWidth = true,
}: ApprovalCardProps) {
  const isPhone = useIsPhone();
  const isSettled = Boolean(settledLabel);

  return (
    <div
      className={`flex flex-col gap-3 rounded-composer border p-4 transition-quiet desktop:rounded-surface desktop:px-pad-card-x desktop:py-pad-card-y ${
        compactWidth ? 'max-w-message-max' : ''
      } ${
        isSettled
          ? 'border-card-border bg-raised'
          : 'border-approval-border bg-approval-surface'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-semibold text-ink">{title}</div>
        {isSettled ? (
          <span
            data-testid="approval-settled-badge"
            className="inline-flex h-pill items-center gap-1.5 rounded-card bg-working-surface px-2.5 text-xs font-semibold text-working-ink"
          >
            <span
              aria-hidden="true"
              className="size-dot-xs rounded-full bg-working"
            />
            {settledLabel}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-sm bg-sidebar px-3 py-2.5 font-mono text-sm text-ink-body">
        {command}
      </div>

      {!isSettled ? (
        <div className="grid grid-cols-2 gap-2 desktop:flex desktop:flex-wrap desktop:items-center">
          {options.map((option) => {
            const label =
              isPhone && option.phoneLabel ? option.phoneLabel : option.label;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelect(option.id)}
                className={
                  option.primary
                    ? 'col-span-2 h-btn-phone rounded-card border-0 bg-accent px-4 text-base font-bold text-on-accent transition-quiet hover:opacity-90 desktop:col-span-1 desktop:h-btn-md desktop:rounded-control desktop:text-md desktop:font-semibold'
                    : 'h-btn-phone-sm rounded-card border border-border-strong bg-transparent px-4 text-base font-medium text-ink transition-quiet hover:bg-active desktop:h-btn-md desktop:rounded-control desktop:text-md'
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
