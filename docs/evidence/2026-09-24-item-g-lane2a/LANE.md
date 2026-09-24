# Item G lane 2a — client watcher liveness

Branch: `lane/item-g-lane2a`. Base named by the brief: `origin/main` at `b3e9eab3`. This record measures the lane worktree on 2026-09-24. All integration targets were loopback, with a temporary HOME and state directory. No real workspace or production host was contacted.

## Decisions, changes, tests, and measured reversions

| Brief decision | Change | Control | Measured mutation |
|---|---|---|---|
| Idle closed reader | `src/stdout-consumer.ts` holds the shared `lsof` parser and a bounded, abortable child. `runArrivalWatch` checks fd 1 while idle, serially, on a 60 s maximum cadence. Only proven `orphaned` raises `NotifyStdoutClosedError`, which exits 74. The CLI's shorter check interval is enabled only for a loopback target with `NODE_ENV=test`. | `tests/p1-cli/resume.test.ts`: a real `inbox --notify` child reads an empty loopback inbox, its stdout reader alone is destroyed, then it exits 74 with no output or signal. `tests/support/arrival-watch.test.ts`: live, non-pipe, unknown, and throwing inspectors remain silent and continue. | Disable the poll-path idle inspection: exit 1, 0/1 pass. Change each non-orphan result into an orphan: live 0/1, non-pipe 0/1, unknown 0/1, throwing inspector 0/1. Add a per-check stderr write: 0/1. Each mutation was restored after its bounded run. |
| Push-mode idle check | A wake wait is split at the next reader inspection deadline, before the five-minute reconcile. A past deadline yields to cancellation. | `tests/support/arrival-watch.test.ts`: a fake subscribed wake topic stays in push mode while the third inspection proves an orphan before its 3 s reconcile. | Disable the push-path inspection: exit 1, 0/1 pass. |
| Signal health exit | One code table maps SIGINT to 130 and SIGTERM to 143. The watcher writes one stderr sentence naming the signal, unwatched inbox, and restart command. A programmatic abort without a signal still leaves exit 0. The restart command is composed from the notify flag read by CLI dispatch. | `tests/p1-cli/resume.test.ts`: real idle CLI children receive each signal; the test verifies the OS-derived code and exact sentence. Existing `arrival-notify` controls now expect 143. A separate test ties the sentence's command to the parsed flag. | Change both table codes to 0: exit 1, 0/2 pass. Change the restart command: exit 1, 0/1 pass. |
| Parent orphan evidence | `resume` reads each matched watcher's ppid via `ps`, marks ppid 1 or a missing parent as orphaned, retains stdout evidence separately, and reports why. Unreadable parent evidence remains `cannot_determine`. Human output says `kill <pid>` and restart under the session Monitor. | `tests/p1-cli/resume.test.ts`: injected parent adapter covers init, missing, live, and unreadable; checks human output and JSON states with stdout still live. | Force every parent to `parent_alive`: exit 1, 0/1 pass. |
| No server or listener change | Only CLI source, tests, timeout inventory test data, and this record changed. | Diff review and protocol bundle gate. | No server/listener mutation applies. |

The ten mutation variants above were run with a 12 s process-group timeout; all returned exit 1 with the named test failing. The polling child test uses a 300 ms test-only inspection interval and a 3 s child deadline. New tests have explicit test timeouts.

## Gates

| Gate | Exit | Counts / observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript compiler errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 977 tests; 966 pass, 11 fail, 0 cancelled. Nine host-stderr timing controls missed deadlines under the full concurrent suite. Two real `ps` controls failed with sandbox `spawn EPERM`. The lane's controls passed. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 944 tests; 941 pass, 3 fail, 0 cancelled. The three failures require host `ps` and report sandbox `spawn EPERM`. The lane's controls passed. A first run was killed by its 180 s wrapper before TAP totals; the measured final run used a 360 s wrapper and completed. |
| `npm run check:tests` | 0 | Test TypeScript compiler errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core` then `git diff --exit-code supabase/functions/_shared/protocol.js` | 0, 0 | Generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | One single-file CLI artifact built and execute-checked with a loopback `--url`. |
| `npm --prefix site run build` | 0 | 12 static pages built with both public backend variables blank. The original `site/node_modules` was a symlink outside the writable worktree; a temporary local copy was used for the gate and removed afterward. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0. The lane record also passed `git diff --cached --check` before commit. |

## Not established

- The lead's live Monitor control on the mini is not run by this lane. The push wait is covered with a fake subscribed wake adapter, not a real Realtime socket in a child CLI process.
- Full `npm test` and `test:p1-cli` are not green in this sandbox. The host-stderr timing failures have no isolated follow-up here; the `ps` failures are explicit `EPERM`. These gate results do not establish those unrelated behaviors.
- This lane does not establish a production release, server wake lease, listener change, or hosted behavior. The site build with a blank backend does not confirm hosted sign-in providers.
- `pgrep` returned `sysmond service not found` / `Cannot get process list` in this sandbox. Test wrappers killed process groups on timeout and child tests kill their own children, but the requested final process-list check cannot establish a host-wide absence here.
