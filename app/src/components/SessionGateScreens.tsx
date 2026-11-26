import type { SessionClosedReason } from '../data/session';

const CLOSED_REASON_COPY: Record<SessionClosedReason, string> = {
  invalid_config: 'Deployment configuration is incomplete.',
  locks_unavailable: 'Web Locks are required in this browser.',
  unsupported_sdk: 'Sign-in could not be checked in this build.',
  multi_account_flag: 'Multi-account mode is active for this deployment.',
  multi_account_in_use: 'Multi-account sign-in is active in this browser.',
  multi_account_unknown: 'Browser storage could not be checked.',
};

export function SignedOutScreen() {
  return (
    <main
      data-testid="signed-out-screen"
      className="flex h-full w-full items-center justify-center bg-ground px-6 text-ink"
    >
      <div className="flex w-full max-w-sm flex-col items-start gap-4 rounded-modal border border-border bg-raised p-6">
        <h1 className="text-lg font-bold tracking-tight text-ink">
          Sign in to CommonSwarm
        </h1>
        <a
          href="/app"
          className="inline-flex h-btn-lg items-center rounded-md bg-accent px-5 text-md font-bold text-on-accent no-underline transition-quiet hover:opacity-90"
        >
          Open CommonSwarm
        </a>
      </div>
    </main>
  );
}

export function ClosedScreen({ reason }: { reason: SessionClosedReason }) {
  return (
    <main
      data-testid="closed-screen"
      data-closed-reason={reason}
      className="flex h-full w-full items-center justify-center bg-ground px-6 text-ink"
    >
      <div className="flex w-full max-w-sm flex-col items-start gap-4 rounded-modal border border-border bg-raised p-6">
        <h1 className="text-lg font-bold tracking-tight text-ink">
          Preview unavailable
        </h1>
        <p className="text-md text-ink-secondary">
          {CLOSED_REASON_COPY[reason]}
        </p>
        <a
          href="/app"
          className="inline-flex h-btn-lg items-center rounded-md bg-accent px-5 text-md font-bold text-on-accent no-underline transition-quiet hover:opacity-90"
        >
          Open CommonSwarm
        </a>
      </div>
    </main>
  );
}

export function SessionCheckingScreen() {
  return (
    <main
      data-testid="session-checking-screen"
      aria-busy="true"
      className="flex h-full w-full items-center justify-center bg-ground px-6 text-ink"
    >
      <div className="flex w-44 flex-col gap-2.5" aria-label="Loading">
        <div className="h-3 w-3/4 animate-pulse rounded-sm bg-elevated" />
        <div className="h-3 w-1/2 animate-pulse rounded-sm bg-elevated" />
      </div>
    </main>
  );
}

export function SessionRecoveryScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main
      data-testid="session-recovery-screen"
      className="flex h-full w-full items-center justify-center bg-ground px-6 text-ink"
    >
      <div className="flex w-full max-w-sm flex-col items-start gap-4 rounded-modal border border-border bg-raised p-6">
        <h1 className="text-lg font-bold tracking-tight text-ink">
          Couldn&apos;t check your sign-in.
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-btn-lg cursor-pointer items-center rounded-md bg-accent px-5 text-md font-bold text-on-accent transition-quiet hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/app"
            className="inline-flex h-btn-lg items-center rounded-md border border-border-strong bg-transparent px-4 text-md font-medium text-ink-strong no-underline transition-quiet hover:bg-active hover:text-ink"
          >
            Open CommonSwarm
          </a>
        </div>
      </div>
    </main>
  );
}
