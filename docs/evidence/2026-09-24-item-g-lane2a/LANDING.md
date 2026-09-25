# Item G lane 2a landing: an idle watcher notices its reader is gone (2026-09-25)

Branch `lane/item-g-lane2a` from main `b3e9eab3`, tip `700f2927`, merged with `git merge --no-ff` (merge `8245a43e`, on
main `89e88845`). Spec: `docs/design/2026-09-24-ITEM-G-LANE-2A-BRIEF.md`. The Maker's record, fold by fold, is
`LANE.md` here. Review outputs and prompts: `arms/`. Live control: `live-control/`.

## What it does

- `cswarm inbox --notify` checks its own stdout (fd 1) with the same lsof inspector `resume` uses
  (`src/stdout-consumer.ts`), at most once per 60 s and at least once per 60 s while it has nothing to write: during
  the idle poll wait, while blocked on a wake subscription, and during retry backoff after failed reads. Only a proven
  orphan (a unix socket whose peer is `->(none)`) exits 74 (`EXIT_NOTIFY_ORPHANED`). It never writes to stdout to
  probe. Live readers, pipes, unknown shapes and inspector errors never exit and never log per check.
- SIGINT exits 130 and SIGTERM exits 143 (from one table), with one stderr sentence that ends in a runnable restart
  command. The command replays the watcher's own parsed flags, with file paths made absolute; a
  `--agent-token-stdin` watcher's sentence says to pipe the same credential. No agent token is printed. A
  programmatic cancel that is not a signal still exits 0.
- `resume` reports parent evidence (`ps -o ppid=`; `EPERM` means alive) beside the stdout evidence. Proven stdout
  evidence wins; parent evidence decides only when stdout is unproven.

## Release

Client only: no migration, no edge change, no box release. It reaches users with the next npm release built from
main. That release also carries item G lane 1's client, so it waits for G lane 1's box release (see the resume file).

## Review (D-036)

Maker: Codex gpt-6-sol (direct `codex exec` lane), with two folds. Checker: Claude Opus 5.5. Second arm: Grok 4.7.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | 3d09d409 | FAIL (restart command could not restart; parser tests; real `ps` in a test; evidence order; retry gap) | FAIL (no check during retry backoff; `EPERM` parent) |
| 2 | 5071a703 | PASS (typed flag list; relative paths; lsof cancel untested; LANE markers) | FAIL (stdin restart command not runnable) |
| 3 | 700f2927 | PASS (three low RIGOUR, below) | PASS (the `~/` profile path, below) |

## Live control (lead, shipped bundle copied outside the repo)

`live-control/live-control.mjs` runs `cswarm inbox --notify` against a loopback fake read service with an empty inbox
and a synthetic credential. The positive control is the pre-lane bundle (main `4d4cb3f7` built in the 0.1.77 release worktree,
sha256 `725636bf...`), against the lane bundle at fold 1 (`5071a703`, sha256 `35ffde07...`; `bundles.sha256`). fd 1 was a
unix socket in every run (`tunix n->0x...`).

| Run | Pre-lane bundle | Lane bundle |
|---|---|---|
| reader closed right after the first read | never exited; SIGKILL by the harness at 149.9 s | exit 74 at 0.0 s |
| reader closed 5 s into the idle wait | never exited; SIGKILL at 144.9 s | exit 74 at 55.0 s (inside the 60 s cadence) |
| SIGTERM | exit 0, no message | exit 143, one sentence ending in the restart command |

stdout stayed empty (0 bytes) in every run. Fold 2 changed only the restart-command text and tests; the live control
was not rerun at `700f2927` (the fold-2 tests run the printed command against a loopback service).

## Gates

Lead, lane tip `700f2927`: build 0; npm test 990/990; test:p1-cli 957/957; check:tests 0; check:edge 0;
`npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` 0;
`scripts/build-release.sh` 0; site build 0; `git diff --check origin/main...HEAD` 0. Earlier runs at 3d09d409 and
5071a703 failed only the `host-acp-*` timing tests that also fail on main under load (filed as a separate task).
Merged tree: see "Merged-tree gates" below.

### Merged-tree gates

Merge `8245a43e` on main `89e88845` (after the 0.1.77 release merge): build 0; npm test 990/990; test:p1-cli 957/957;
check:tests 0; check:edge 0; command-core + protocol diff 0; `scripts/build-release.sh` 0; site build 0; site test
575 pass, 1 skipped on the rerun (the first run had one headless-Chrome SEGV in the markdown screenshot test
`RESULTS.md and the screenshots are written from the measured rows`, the known flake; it rewrote two tracked PNGs,
which were restored).

## Follow-ups (low RIGOUR from round 3; not blocking)

- A watcher started with a literal quoted `--profile '~/...'` prints `<cwd>/~/...` in its restart command; that
  restart fails with "The agent profile is missing" (Opus and Grok, measured). An unquoted `~` is expanded by the
  shell and is not affected.
- `resume`'s orphan line puts the restart command mid-sentence; the stop sentence's "command last" rule does not
  apply there yet (Opus).
- LANE.md's Fold 2 H3 row says the parser test covers profile and session-context path resolution; the CLI refuses
  those relative inputs at start, so the test covers only token rewriting (Opus).

## Not established

- Linux: lsof without `+E` prints no peer, so the idle check cannot prove an orphan there (it never exits 74 from the
  idle check; nothing else changes).
- A real session Monitor and a real Realtime wake socket (the push-mode check is tested with a fake subscriber).
- The default-target restart (no `--url`) was checked by reading the code only.
