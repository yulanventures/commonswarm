# Item G lane 2a — client watcher liveness

Branch: `lane/item-g-lane2a`. Base named by the brief: `origin/main` at `b3e9eab3`. This record measures the lane worktree on 2026-09-24. All integration targets were loopback, with a temporary HOME and state directory. No real workspace or production host was contacted.

## Decisions, changes, tests, and measured reversions

| Brief decision | Change | Control | Measured mutation |
|---|---|---|---|
| Idle closed reader | `src/stdout-consumer.ts` holds the shared `lsof` parser and a bounded, abortable child. `runArrivalWatch` checks fd 1 while idle, serially, on a 60 s maximum cadence. Only proven `orphaned` raises `NotifyStdoutClosedError`, which exits 74. The CLI's shorter check interval is enabled only for a loopback target with `NODE_ENV=test`. | `tests/p1-cli/resume.test.ts`: a real `inbox --notify` child reads an empty loopback inbox, its stdout reader alone is destroyed, then it exits 74 with no output or signal. `tests/support/arrival-watch.test.ts`: live, non-pipe, unknown, and throwing inspectors remain silent and continue. | Disable the poll-path idle inspection: exit 1, 0/1 pass. Change each non-orphan result into an orphan: live 0/1, non-pipe 0/1, unknown 0/1, throwing inspector 0/1. Add a per-check stderr write: 0/1. Each mutation was restored after its bounded run. |
| Push-mode idle check | A wake wait is split at the next reader inspection deadline, before the five-minute reconcile. A past deadline yields to cancellation. | `tests/support/arrival-watch.test.ts`: a fake subscribed wake topic stays in push mode while the third inspection proves an orphan before its 3 s reconcile. | Disable the push-path inspection: exit 1, 0/1 pass. |
| Signal health exit | One code table maps SIGINT to 130 and SIGTERM to 143. The watcher writes one stderr sentence naming the signal, unwatched inbox, and restart command. A programmatic abort without a signal still leaves exit 0. The restart command is composed from the notify flag read by CLI dispatch. | `tests/p1-cli/resume.test.ts`: real idle CLI children receive each signal; the test verifies the OS-derived code and exact sentence. Existing `arrival-notify` controls now expect 143. A separate test ties the sentence's command to the parsed flag. | Change both table codes to 0: exit 1, 0/2 pass. Change the restart command: exit 1, 0/1 pass. |
| Parent orphan evidence (superseded by Fold 1 F3) | `resume` reads each matched watcher's ppid via `ps`, marks ppid 1 or a missing parent as orphaned, retains stdout evidence separately, and reports why. Unreadable parent evidence remains `cannot_determine`. Human output says `kill <pid>` and restart under the session Monitor. | `tests/p1-cli/resume.test.ts`: injected parent adapter covers init, missing, live, and unreadable; checks human output and JSON states with stdout still live. | Force every parent to `parent_alive`: exit 1, 0/1 pass. |
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

- On Linux, `lsof` without `+E` prints no peer for fd 1, so the idle check cannot prove an orphan; a watcher with an empty inbox never exits 74 from that check. The write-time EPIPE path is unchanged. This was inferred from the parser and the review, not measured on Linux.
- The lead's live Monitor control on the mini is not run by this lane. The push wait is covered with a fake subscribed wake adapter, not a real Realtime socket in a child CLI process.
- Full `npm test` and `test:p1-cli` are not green in this sandbox. The host-stderr timing failures have no isolated follow-up here; the `ps` failures are explicit `EPERM`. These gate results do not establish those unrelated behaviors.
- This lane does not establish a production release, server wake lease, listener change, or hosted behavior. The site build with a blank backend does not confirm hosted sign-in providers.
- `pgrep` returned `sysmond service not found` / `Cannot get process list` in this sandbox. Test wrappers killed process groups on timeout and child tests kill their own children, but the requested final process-list check cannot establish a host-wide absence here.

## Fold 1

Reviewed failures: `itemG2a/opus-r1.md` and `itemG2a/grok-r1.md`, read in full. This fold was measured in the lane worktree with temporary HOME and state directories and loopback read services.

| Ruling | Change and control | Measured reverted behavior (targeted test, 20 s outer limit) |
|---|---|---|
| F1 | The signal sentence composes the actual `--agent-token-file` path, explicit workspace/target flags, or `--agent-token-stdin` instruction. Shell quoting covers spaces and apostrophes. `resume` uses the same command builder. `resume.test.ts` extracts the printed command, lets `/bin/sh` parse it, and proves the restarted child reads the loopback service. | Return the constant command alone: exit 1, 0 pass / 1 fail. |
| F2 | Retry backoff uses the same bounded stdout-check wait as idle polling. A 5xx loopback service and a destroyed stdout reader cause exit 74 within the 300 ms test cadence plus margin. | Restore the unchecked backoff wait: exit 1, 0/1 pass. |
| F3 | Proven `live_reader` or `orphaned` stdout determines the watcher state; parent evidence decides only for `cannot_determine` or `not_pipe`. `EPERM` from `kill(pid, 0)` means the parent exists. The JSON retains both fields and the Next line names the unknown evidence. `resume.test.ts` covers all nine stdout/parent combinations. | Restore parent-first state: exit 1, 0/1 pass. Reclassify `EPERM` as missing: exit 1, 0/1 pass. |
| F4 | The shared lsof parser has recorded unix, PIPE, FIFO, REG, CHR, empty, and second-name fixtures. The parent parser and injected `ps`/`kill` adapter cover init, live, missing, unreadable, and `EPERM`. | PIPE/FIFO as orphan: exit 1, 0/1 pass; unix path as orphan: exit 1, 0/1; adapter always init: exit 1, 0/1; `EPERM` as missing: exit 1, 0/1. |
| F5 | The older resume test injects `parentProcess` and asserts that the fake watcher's parent is live. The large fake process-table test also injects a parent adapter. | Remove the older test's adapter: exit 1, 0/1 pass. |
| F6 | The timeout-table citation now spans the `timeout: timeoutMs` option, and its test resolves the range. The signal message is one sentence; the CLI tests check exact output. | Restore the old citation: exit 1, 0/1 pass; split the sentence: exit 1, 0/1 pass. |
| F7 | The Not established section records the Linux `lsof` peer limit and the consequence for idle exit 74. A test pins that statement. | Remove the statement: exit 1, 0/1 pass. |

The test controls live in `tests/p1-cli/resume.test.ts`, `tests/p1-cli/arrival-notify.test.ts`, `tests/p1-cli/citation-drift.test.ts`, and the pre-existing `resume-process-table.test.ts`. All are reached by `test:p1-cli`; all except `arrival-notify.test.ts` are also in the literal `npm test` list. Each new test has its own timeout. The table lists 12 reverted behaviours; the `EPERM` → missing probe appears in both F3 and F4, so there were 11 unique probes. Each ran its positive control and reverted mutation in the same bounded invocation: positive exit 0 with 1/1 pass, reverted exit 1 with 0/1 pass. The reverted source was restored after each probe.

### Fold 1 gates

| Gate | Exit | Measured count or result |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 984 tests: 973 pass, 11 fail, 0 cancelled. Nine host-stderr timing failures and two sandbox `spawn EPERM` process-table failures. Final-tree rerun. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 951 tests: 948 pass, 3 fail, 0 cancelled. All three report sandbox `spawn EPERM` from `ps` (`spawnSync` in one). Final-tree rerun. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked, errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Bundle diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | One single-file bundle built and execute-checked with a loopback URL. |
| `npm --prefix site run build` | 0 | 12 pages built with the public backend variables blank. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0, measured after fold commits. |

### Fold 1 not established

- The host-stderr timing tests and `ps` tests are not established by the failed full gates; the fold's targeted controls passed. The sandbox's `spawn EPERM` is separate from the measured watcher behavior.
- Linux lsof peer output was not measured on Linux. The idle check cannot prove closure there under the known output shape, so the watcher does not exit 74 from that check while its inbox is empty; the write-time EPIPE path remains.
- No live Monitor, Realtime child socket, production release, or hosted service was tested by this fold.
- The final `pgrep` check returned exit 3 (`sysmond service not found` / `Cannot get process list`), so host-wide process absence is not established by that command. Each test killed its child on its own deadline or in `finally`.

## Fold 2

The round-2 Grok and Opus reviews were read in full. Tests used loopback read services, temporary HOME and state directories, bounded child lifetimes, and no real workspace. The final-tree targeted restart, cancellation, and lane-record controls passed 7/7. Each revert below ran its positive control and mutation in one bounded invocation; the source was restored after every probe.

| Ruling | Change and test | Measured revert |
|---|---|---|
| H1 | The stdin credential instruction precedes the restart command, so the command is the last part of the sentence. `resume.test.ts` starts a stdin watcher, stops it with SIGTERM, extracts the same final command as the token-file test, pipes the credential into `/bin/sh`, and observes a second loopback read. The sentence and command contain no agent token. | Restore the suffix after the command: positive exit 0, 1/1 pass; revert exit 1, 0/1 pass. |
| H2 | `Arguments` retains parsed options and values in order before profile expansion. The notify restart builder uses those captured tokens; paths and public values are shell-quoted, and a profile remains `--profile <path>`. A test enumerates `NOTIFY_ACCEPTED_FLAGS` from the CLI shape and checks each flag, ordered flags, paths, and token absence. Real loopback CLI starts cover `--json`, `--force-file-store`, `--agent-token-stdin`, `--session-context`, and `--profile`, along with the target and credential-file flags. | Restore the hand-typed subset: positive exit 0, 2/2 pass; revert exit 1, 0/2 pass. Drop only `--session-context`: positive exit 0, 1/1 pass; revert exit 1, 0/1 pass. |
| H3 | The command resolves file-path options against the watcher's cwd. The token-file test starts with a relative path containing a space and apostrophe, runs the extracted command from another cwd, and sees a second loopback read. The parser test also covers profile and session-context path resolution. | Print relative paths unchanged: positive exit 0, 1/1 pass; revert exit 1, 0/1 pass. |
| H4 | The stdout inspector accepts a fixture executable for a real child-process abort test. The test waits for its in-flight child, aborts inspection, checks prompt `cannot_determine`, and verifies that pid exits; cleanup sends SIGKILL if needed. | Remove the `execFile` abort signal: positive exit 0, 1/1 pass; revert exit 1, 0/1 pass. |
| H5 | The old parent-evidence row is marked superseded by Fold 1 F3. Fold 1 now says 12 listed reverted behaviours, 11 unique probes because F3/F4 share EPERM. `citation-drift.test.ts` derives the listed count from the table. | Remove the superseded marker: positive exit 0, 1/1 pass; revert exit 1, 0/1 pass. Change 12 back to 11: positive exit 0, 1/1 pass; revert exit 1, 0/1 pass. |

### Fold 2 gates

| Gate | Exit | Count or result |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 990 tests: 988 pass, 2 fail, 0 cancelled. Both failures are host `ps` sandbox `spawn EPERM`; the lane controls passed. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 957 tests: 954 pass, 3 fail, 0 cancelled, with a temporary HOME and state directory. All three failures are host `ps` sandbox `spawn EPERM` (one `spawnSync`). A shorter 240 s outer run stopped during the baseline test before TAP totals; the complete run used a 720 s outer limit. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Both commands exited 0; generated bundle diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | One single-file CLI artifact built and execute-checked with a loopback `--url`. |
| `npm --prefix site run build` | 0 | 12 static pages built with public backend variables blank. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0, checked after Fold 2 commits. |

### Fold 2 not established

- The full test gates do not establish the three host `ps` controls in this sandbox; each failed with `spawn EPERM`. All targeted Fold 2 tests passed.
- The lead's live Monitor check, Linux `lsof` peer behavior, a real Realtime child socket, and hosted or released behavior were not exercised here.
- A final host-wide process absence check depends on `pgrep`; this sandbox reports `sysmond service not found` / `Cannot get process list`. Test children use bounded waits and `finally` cleanup, and the gate runner killed its timed-out process group.
