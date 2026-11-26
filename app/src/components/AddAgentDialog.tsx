import { Dialog } from 'radix-ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { COMPUTERS, HARNESSES, PERMISSION_MODES } from '../data/fixtures';
import { appActions, useAppStore } from '../store/appStore';

interface FieldErrors {
  name?: string;
  folder?: string;
}

export function AddAgentDialog() {
  const navigate = useNavigate();
  const location = useLocation();
  const open = useAppStore((state) => state.addAgentDialogOpen);
  const draft = useAppStore((state) => state.addAgentDraft);
  const agents = useAppStore((state) => state.agents);
  const [errors, setErrors] = useState<FieldErrors>({});
  const nameErrorId = useId();
  const folderErrorId = useId();
  const routeKey = `${location.pathname}${location.search}${location.hash}`;
  const prevRouteKeyRef = useRef(routeKey);

  useEffect(() => {
    if (prevRouteKeyRef.current !== routeKey) {
      prevRouteKeyRef.current = routeKey;
      if (open) {
        appActions.closeAddAgentDialog();
      }
    }
  }, [routeKey, open]);

  useEffect(() => {
    if (!open) {
      setErrors({});
    }
  }, [open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    if (!draft.name.trim()) {
      nextErrors.name = 'Enter a name';
    }
    if (!draft.folder.trim()) {
      nextErrors.folder = 'Enter a folder';
    }
    if (nextErrors.name || nextErrors.folder) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    const newId = appActions.submitAddAgent();
    if (newId) {
      navigate(`/agents/${newId}`);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setErrors({});
          appActions.closeAddAgentDialog();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="animate-overlay-in fixed inset-0 z-40 bg-backdrop/85" />
        <Dialog.Content className="animate-dialog-in fixed top-1/2 left-1/2 z-50 max-h-full w-full max-w-dialog -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-modal border border-border bg-elevated px-pad-dialog-x py-pad-dialog-y text-ink shadow-modal focus:outline-none">
          <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-dialog-title font-bold tracking-tighter text-ink">
                Add an agent
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="flex size-touch shrink-0 items-center justify-center rounded-control text-dialog-title leading-none text-ink-secondary transition-quiet hover:bg-active hover:text-ink desktop:size-btn-sm"
                >
                  ×
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              Choose a computer, harness, name, folder, and permissions for the
              new agent.
            </Dialog.Description>

            <div className="flex flex-col gap-2.5">
              <div className="text-xs font-semibold tracking-label text-ink-muted">
                RUNS ON
              </div>
              <div
                role="group"
                aria-label="Runs on"
                className="grid grid-cols-1 gap-2.5 desktop:grid-cols-3"
              >
                {COMPUTERS.map((computer) => {
                  const count = agents.filter(
                    (agent) => agent.computerId === computer.id,
                  ).length;
                  const selected = draft.computerId === computer.id;
                  return (
                    <button
                      key={computer.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        appActions.updateAddAgentDraft({
                          computerId: computer.id,
                        })
                      }
                      className={`flex h-tile flex-col justify-center gap-0.5 rounded-card px-3.5 text-left transition-quiet ${
                        selected
                          ? 'border-selected border-accent bg-accent-surface text-ink'
                          : 'border border-border bg-raised text-ink hover:border-border-strong'
                      }`}
                    >
                      <span className="font-semibold">{computer.name}</span>
                      <span className="text-xs text-working-ink">
                        Online · {count} {count === 1 ? 'agent' : 'agents'}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={draft.computerId === 'another'}
                  onClick={() =>
                    appActions.updateAddAgentDraft({ computerId: 'another' })
                  }
                  className={`flex h-tile flex-col justify-center gap-0.5 rounded-card px-3.5 text-left transition-quiet ${
                    draft.computerId === 'another'
                      ? 'border-selected border-accent bg-accent-surface text-ink'
                      : 'border border-dashed border-border-strong bg-transparent text-ink-secondary hover:border-ink-muted hover:text-ink'
                  }`}
                >
                  <span className="font-semibold">Another computer</span>
                  <span className="text-xs text-ink-muted">
                    Install CommonSwarm there
                  </span>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="text-xs font-semibold tracking-label text-ink-muted">
                HARNESS
              </div>
              <div
                role="group"
                aria-label="Harness"
                className="grid grid-cols-2 gap-2.5 desktop:grid-cols-4"
              >
                {HARNESSES.map((harness) => {
                  const selected = draft.harnessId === harness.id;
                  return (
                    <button
                      key={harness.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        appActions.updateAddAgentDraft({
                          harnessId: harness.id,
                        })
                      }
                      className={`flex h-tile flex-col justify-center gap-0.5 rounded-card px-3.5 text-left transition-quiet ${
                        selected
                          ? 'border-selected border-accent bg-accent-surface text-ink'
                          : harness.installed
                            ? 'border border-border bg-raised text-ink hover:border-border-strong'
                            : 'border border-border bg-raised text-ink-secondary hover:border-border-strong'
                      }`}
                    >
                      <span className="font-semibold">{harness.name}</span>
                      <span
                        className={`text-xs ${
                          harness.installed
                            ? 'text-working-ink'
                            : 'text-ink-muted'
                        }`}
                      >
                        {harness.status}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 desktop:grid-cols-2">
              <label className="flex flex-col gap-2">
                <span className="text-xs font-semibold tracking-label text-ink-muted">
                  NAME
                </span>
                <input
                  type="text"
                  required
                  value={draft.name}
                  aria-invalid={errors.name ? 'true' : undefined}
                  aria-describedby={errors.name ? nameErrorId : undefined}
                  onChange={(event) => {
                    appActions.updateAddAgentDraft({
                      name: event.target.value,
                    });
                    if (errors.name) {
                      setErrors((prev) => ({ ...prev, name: undefined }));
                    }
                  }}
                  className={`h-input rounded-md border bg-ground px-3 text-base text-ink transition-quiet focus:border-accent focus:outline-none ${
                    errors.name ? 'border-needs-you' : 'border-border'
                  }`}
                />
                {errors.name ? (
                  <span
                    id={nameErrorId}
                    role="alert"
                    className="text-xs text-needs-you-ink"
                  >
                    {errors.name}
                  </span>
                ) : null}
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-xs font-semibold tracking-label text-ink-muted">
                  FOLDER
                </span>
                <input
                  type="text"
                  required
                  value={draft.folder}
                  aria-invalid={errors.folder ? 'true' : undefined}
                  aria-describedby={errors.folder ? folderErrorId : undefined}
                  onChange={(event) => {
                    appActions.updateAddAgentDraft({
                      folder: event.target.value,
                    });
                    if (errors.folder) {
                      setErrors((prev) => ({ ...prev, folder: undefined }));
                    }
                  }}
                  className={`h-input rounded-md border bg-ground px-3 font-mono text-md text-ink transition-quiet focus:border-accent focus:outline-none ${
                    errors.folder ? 'border-needs-you' : 'border-border'
                  }`}
                />
                {errors.folder ? (
                  <span
                    id={folderErrorId}
                    role="alert"
                    className="text-xs text-needs-you-ink"
                  >
                    {errors.folder}
                  </span>
                ) : null}
              </label>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="text-xs font-semibold tracking-label text-ink-muted">
                MAY
              </div>
              <div
                role="group"
                aria-label="Permissions"
                className="flex flex-wrap gap-2"
              >
                {PERMISSION_MODES.map((mode) => {
                  const selected = draft.mode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => appActions.updateAddAgentDraft({ mode })}
                      className={`h-touch rounded-md px-3.5 text-md transition-quiet desktop:h-mode-btn ${
                        selected
                          ? 'border-selected border-accent bg-accent-surface font-semibold text-ink'
                          : 'border border-border bg-raised text-ink-strong hover:border-border-strong hover:text-ink'
                      }`}
                    >
                      {mode}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2.5">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="flex h-btn-lg items-center rounded-md border border-border-strong bg-transparent px-4.5 font-medium text-ink transition-quiet hover:bg-active"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className="flex h-btn-lg items-center rounded-md border-0 bg-accent px-5.5 font-bold text-on-accent transition-quiet hover:opacity-90"
              >
                Start agent
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
