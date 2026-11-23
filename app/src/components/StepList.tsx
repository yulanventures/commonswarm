import type { AgentStep, StepResult } from '../data/types';
import { useIsPhone } from '../hooks/useIsPhone';
import { appActions, useAppStore } from '../store/appStore';

interface StepListProps {
  steps: AgentStep[];
}

function StepResultView({ result }: { result: StepResult }) {
  switch (result.kind) {
    case 'info':
      return <span className="text-ink-muted">{result.text}</span>;
    case 'error':
      return <span className="text-needs-you-ink">{result.text}</span>;
    case 'success':
      return <span className="text-working-ink">{result.text}</span>;
    case 'diff':
      return (
        <span className="flex items-center gap-2">
          <span className="text-working-ink">+{result.added}</span>
          <span className="text-needs-you-ink">−{result.removed}</span>
        </span>
      );
  }
}

export function StepList({ steps }: StepListProps) {
  const isPhone = useIsPhone();
  const expandedSteps = useAppStore((state) => state.expandedSteps);
  const visibleSteps = isPhone
    ? steps.filter((step) => step.showOnPhone !== false)
    : steps;

  return (
    <div className="rounded-card border border-card-border bg-raised py-1 font-mono text-sm desktop:py-1.5">
      {visibleSteps.map((step) => {
        const hasOutput = Boolean(step.output);
        const isExpanded = Boolean(expandedSteps[step.id]);
        const glyph = step.state === 'error' ? '!' : '✓';
        const glyphColor =
          step.state === 'error' ? 'text-needs-you' : 'text-working';
        const targetText =
          isPhone && step.phoneTarget ? step.phoneTarget : step.target;

        const rowInner = (
          <>
            <span
              aria-hidden="true"
              className={`shrink-0 desktop:w-step-icon ${glyphColor}`}
            >
              {glyph}
            </span>
            {!isPhone ? (
              <span className="w-step-kind shrink-0 text-ink-muted">
                {step.kind}
              </span>
            ) : null}
            <span className="truncate text-ink-strong">{targetText}</span>
            {step.result ? <StepResultView result={step.result} /> : null}
          </>
        );

        return (
          <div key={step.id}>
            {hasOutput ? (
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => appActions.toggleStep(step.id)}
                className="flex min-h-touch w-full items-center gap-2 px-3 text-left font-mono text-sm text-ink-secondary transition-quiet hover:bg-elevated desktop:h-row-sm desktop:min-h-0 desktop:gap-2.5 desktop:px-3.5"
              >
                {rowInner}
                <span
                  aria-hidden="true"
                  className="ml-auto text-xs text-ink-muted"
                >
                  {isExpanded ? '▾' : '▸'}
                </span>
              </button>
            ) : (
              <div className="flex h-row-md items-center gap-2 px-3 text-ink-secondary desktop:h-row-sm desktop:gap-2.5 desktop:px-3.5">
                {rowInner}
              </div>
            )}

            {hasOutput && isExpanded && step.output ? (
              <div className="mx-3 mt-1 mb-1.5 rounded-sm bg-sidebar px-3 py-2.5 text-xs leading-relaxed text-ink-secondary desktop:mr-3.5 desktop:ml-step-indent">
                <div>
                  {step.output.headlineParts.map((part, index) => (
                    <span
                      key={index}
                      className={
                        part.tone === 'added'
                          ? 'text-working-ink'
                          : part.tone === 'removed'
                            ? 'text-needs-you-ink'
                            : undefined
                      }
                    >
                      {part.text}
                    </span>
                  ))}
                </div>
                <div className="text-ink-muted">{step.output.detail}</div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
