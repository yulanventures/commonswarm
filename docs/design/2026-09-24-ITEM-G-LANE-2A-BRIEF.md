# Item G lane 2a brief: an idle watcher notices its reader is gone (2026-09-24)

Written by CSwarmDevLead. Design: `docs/evidence/2026-09-24-item-g-design/wake-liveness-design-v1.md`, "Lane 2", item 1,
plus the ppid orphan flag that lane 1 deferred (`docs/design/2026-09-24-ITEM-G-LANE-1-BRIEF.md`, decision 5). Lane 2
is split: **2a (this brief) is client-only and needs no box release**; 2b (the server wake lease) gets its own brief.
Base: origin/main b3e9eab3.

## What is true today (mapped read-only at b3e9eab3)

- `cswarm inbox --notify` exits `EXIT_NOTIFY_ORPHANED` (74, `src/cloud/arrival-watch.ts:43`) only when a stdout WRITE
  gets EPIPE (`notifyWriteError`, `arrival-watch.ts:458-493`; mapped in `src/cli.ts` `exitCodeFor`). With an empty
  inbox it never writes, so an orphaned watcher lives forever. The idle wait is `waitForTrigger` -> `idleWait` ->
  `wait(ms)` (`arrival-watch.ts:549-626`), backing off to `IDLE_POLL_MAX_MS` (60 s); with a wake topic it blocks on
  `wake.next` with a cap (reconcile 5 min in push mode).
- SIGTERM and SIGINT abort the controller (`src/cli.ts` `runInboxNotifyCommand`, ~4759-4761); the watch returns
  `{ reason: "cancelled" }` and the process exits **0**. Exit codes carry no health.
- `src/resume.ts` `lsofStdoutConsumer` (`:242-267`) runs `lsof -nP -a -p <pid> -d 1 -F pftan`: on Darwin a Monitor's
  stdout is a unix socket; peer `->(none)` is `orphaned`, a named peer is `live_reader`, PIPE/FIFO and unknown shapes
  are `cannot_determine`. `resume` does not look at the watcher's parent process.
- `tests/p1-cli/resume.test.ts:476-481` destroys only a child's stdout and expects exit 74 on the next write.

## Decisions

1. **Idle closed-reader check.** While `inbox --notify` waits with nothing to write, it checks its own fd 1 with the
   same inspector `resume` uses (share the code; do not copy the parser). Check at most once per `IDLE_POLL_MAX_MS`
   and at least once per `IDLE_POLL_MAX_MS` while idle, including while blocked on `wake.next` (a push-mode wait must
   not hide an orphan for the 5-minute reconcile). Only a proven `orphaned` result exits: 74, with the existing
   `NotifyStdoutClosedError` path and its stderr sentence. `live_reader`, `not_pipe` and `cannot_determine` never exit
   and never log per check. An inspector failure is `cannot_determine`.
   - **Never write to stdout to probe.** Every stdout line wakes the attended session; a keepalive line is a bug.
   - Cost: one `lsof` child per check, bounded by a timeout shorter than the wait, and never two at once. The child is
     killed if the watch is cancelled.
2. **Signals exit non-zero with one sentence.** SIGTERM exits 143 and SIGINT exits 130 (128 + signal). stderr gets
   one sentence that says the watcher stopped because of the signal and that nothing is watching this inbox now, with
   the command that restarts it. Generate the codes from one constant table; tests read that table. The existing
   `cancelled` path for a programmatic abort that is not a signal keeps its current code; say which in the code.
3. **ppid orphan flag in `resume`.** `resume` reports a watcher as `orphaned` also when its parent pid is 1 or its
   parent process no longer exists (read via `ps -o ppid= -p <pid>` or an equivalent that is tested with an injected
   adapter). Keep the lsof result as separate evidence; the report says which evidence proved it. A watcher whose
   parent cannot be read stays `cannot_determine` for that check. The human line gives the next step: stop the
   orphan (`kill <pid>`) and restart `inbox --notify` under the session's Monitor.
4. **No new verb, no server change, no listener.** This lane changes only the CLI (`src/`), its tests and docs. It
   does not start a model or a listener.

## Tests (each must fail when its fix is reverted; record the mutation result)

- Idle orphan: a child `inbox --notify` against a fake read service that returns an empty inbox forever; destroy only
  its stdout; it exits 74 within `IDLE_POLL_MAX_MS` + a margin, with no new signal. Use an injected clock or a short
  test-only poll interval so the test takes seconds, not minutes, and never depends on wall-clock sleeps longer than
  needed. Mutation: disable the idle check -> the child is still alive at the deadline.
- Push-mode wait: the same with a wake topic subscribed (fake), proving the check runs while blocked on `wake.next`.
- `live_reader` / `cannot_determine` / inspector error: no exit, no stdout write, no per-check stderr line.
- SIGTERM -> 143 and SIGINT -> 130 with the sentence; mutation: exit 0.
- `resume` ppid: an injected process table with ppid 1, a dead parent, a live parent, and an unreadable parent.
- A test that the sentence's restart command is built from the same constant the CLI parses (AGENTS.md: an
  enumeration inside a message must be generated).
- Name every new test file's gate: `npm test` is a literal list, `test:p1-cli` globs `tests/p1-cli/**`.

## Gates

`npm run build`; `env -u FORCE_COLOR npm test`; `env -u FORCE_COLOR npm run test:p1-cli`; `npm run check:tests`;
`npm run check:edge`; `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js`;
`bash scripts/build-release.sh` (check its EXIT CODE; never pipe it into grep); `npm --prefix site run build`;
`git diff --check origin/main...HEAD`. The lead runs the live control.

## Live control (lead, after review)

On the mini, start `cswarm inbox --notify` for a test seat under a Monitor-like parent with a temporary state dir,
kill only the reader, and confirm exit 74 within 60 s with no new signal; then SIGTERM a second one and read 143 and
the sentence. Paste both into the landing record.

## Deferred (not this lane)

The server wake lease, `notify_held_elsewhere`, stealing and generations (lane 2b); the rebind token revoke; the
attended canary (lane 3); the commit-order and PostgREST cursor skips (`docs/design/2026-09-25-CHECK-CURSOR-MILLISECOND-TASK.md`).
