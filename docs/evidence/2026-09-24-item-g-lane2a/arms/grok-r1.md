I'll review lane 2a as a read-only check against the brief and the diff from `b3e9eab3` to `3d09d409`. First I'll read the spec, the lane record, and the change set.The diff is in. Next I’ll read the idle-check path, signal exits, and the tests the lane claims as controls.The idle-check and signal paths are in view. Next I’ll measure real `lsof` output and run the lane’s pure tests under a temporary `HOME`.The idle check misses the retry backoff, so a closed reader can sit past the 60-second bound while reads keep failing. That is a production miss. The other checks hold.

## Findings

**PRODUCTION** — `src/cloud/arrival-watch.ts:775`. A retryable read failure waits with nothing written to stdout and does not inspect fd 1. `SIGNAL_FOLLOW_BACKOFF_MAX_MS` is 30 seconds (`src/cloud/signals.ts:169`), and the loop repeats that wait with no inspection between attempts. After the last successful idle check, one timed-out read (30 seconds) plus one backoff already passes 60 seconds, and a sustained 429, 5xx, or transport failure never checks again. The arrival lock stays held, so a replacement watcher is refused for the whole outage.

The idle poll and the push wait do inspect:

```599:613:src/cloud/arrival-watch.ts
  const idleWait = async (hadDelivery: boolean): Promise<void> => {
    // ...
    while (!cancelled()) {
      await inspectStdout();
      const remaining = until - now();
      if (remaining <= 0) return;
      await wait(Math.min(remaining, Math.max(1, nextStdoutCheckAt - now())));
    }
  };
```

```647:660:src/cloud/arrival-watch.ts
    } else {
      while (true) {
        await inspectStdout();
        if (cancelled()) return;
        reason = await wake.next({
          until: Math.min(until, nextStdoutCheckAt),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (cancelled() || reason !== "deadline" || now() >= until) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
```

The failure path does not:

```761:775:src/cloud/arrival-watch.ts
      if (!retryable) {
        return { reason: "error", error: error instanceof Error ? error : new Error(String(error)) };
      }
      attempt += 1;
      const delayMs = nextFollowBackoffMs(attempt, http?.retryAfterMs ?? null, random);
      const typed = error instanceof Error ? error : new Error(String(error));
      options.onRetry?.(typed, delayMs);
      await wait(delayMs);
```

`wait` still returns on abort, so SIGTERM and SIGINT still stop the process. The reader check does not run during that wait. The brief requires a check at least once per `IDLE_POLL_MAX_MS` (60 seconds) while the watcher waits with nothing to write, including the `wake.next` block. The push split meets that. The retry sleep does not.

**RIGOUR** — `src/resume.ts:254-259`. `ps` can return a live parent pid, and `process.kill(parent, 0)` then throws `EPERM` when that parent exists but is not signalable. On this host, `kill(0)` of pid 1 returns `EPERM`. ppid 1 is classified earlier, so launchd is `parent_is_init`. Any other unsignalable live parent becomes `cannot_determine`. `watcherState` then reports the watcher as `cannot_determine` even when `stdout` is `live_reader` (`src/resume.ts:425-431`), and the next step becomes the unknown-reader line. It does not call that watcher an orphan. A same-user parent measured as `parent_alive`.

## Checklist

**1. Idle reader check.** On the success path it runs while idle and while the push wait is split out of `wake.next`, at `stdoutCheckIntervalMs`, which the CLI sets to 60 seconds (`src/cli.ts:4768-4773`, `4795-4796`). The default in `runArrivalWatch` is `IDLE_POLL_MAX_MS`. One `inspect` is awaited, and `nextStdoutCheckAt` moves forward before the await (`src/cloud/arrival-watch.ts:565-571`), so the notify loop does not start a second `lsof`. The child gets `timeout` and `signal` (`src/stdout-consumer.ts:16-18`). The same Node `execFile` options killed a `sleep 30`: timeout ended it with `SIGTERM`, and aborting the signal ended it with `SIGTERM`. Only `state === "orphaned"` throws `NotifyStdoutClosedError` (`arrival-watch.ts:575`); `exitCodeFor` maps that to 74 (`src/cli.ts:9822`). `live_reader`, `not_pipe`, `cannot_determine`, and a thrown inspector stay in the loop and write no per-check line. `execFile` captures `lsof` output on pipes, so the check does not write the watcher's stdout.

The parser is one function. `src/resume.ts:2-3` imports and re-exports `lsofStdoutConsumer` from `src/stdout-consumer.ts`. The old copy in `resume.ts` is gone.

A live watcher is not exited by a differently printed peer or by a pipe. Orphaned is only `type === "unix"` and a name line exactly `->(none)`:

```27:33:src/stdout-consumer.ts
      if (type === "unix") {
        if (names.some((name) => name === "->(none)")) return "orphaned";
        if (names.some((name) => name.startsWith("->") && name !== "->(none)")) return "live_reader";
        return "cannot_determine";
      }
      if (type === "PIPE" || type === "FIFO") return "cannot_determine";
```

Measured with this host's `lsof -nP -a -p <pid> -d 1 -F pftan`:

- Node `spawn` stdout, reader alive: `tunix` / `n->0x9e7a0a3a2537e15b` → `live_reader`.
- Same fd after the reader was destroyed: `tunix` / `n->(none)` → `orphaned`.
- A POSIX pipe (Python `stdout=PIPE`), alive: `tPIPE` / `n->0x…` → `cannot_determine`.
- That pipe after the reader was closed: `tPIPE` / `n` (empty name) → `cannot_determine`.
- `-d 1` returned fd 1 only while fds 10 and above were open, including a listening unix socket.

A `PIPE` or `FIFO` result, which is what Linux Node stdio and a shell pipe are, stays `cannot_determine` even when the name looks like a peer. That shape does not exit 74. A unix name that is a path or `->0x…` does not exit 74 either. Each measured fd had one `n` line. The orphan test returns as soon as any name equals `->(none)`, so a second line of `->(none)` beside a live peer would exit 74. This `lsof` did not print that for fd 1.

**2. Signals.** `NOTIFY_SIGNAL_EXIT_CODES` is `{ SIGINT: 130, SIGTERM: 143 }` (`src/cloud/arrival-watch.ts:47`). The handlers set `stopSignal` and abort (`src/cli.ts:4763-4767`). On a cancelled watch the CLI writes one stderr line and sets that code (`src/cli.ts:4857-4860`). The sentence is `notifySignalStopSentence`, and the restart command is `cswarm inbox --${NOTIFY_FLAG}` (`arrival-watch.ts:45-50`). Dispatch uses `args.has(NOTIFY_FLAG)` (`src/cli.ts:4549`, `9617`). An abort with `stopSignal === null` leaves the exit code alone. The comment at `src/cli.ts:4857` says that programmatic abort stays 0.

No remaining caller depends on notify exiting 0 on SIGTERM:

- `tests/p1-cli/arrival-notify.test.ts:183` and `:339` used to expect 0. Both now expect `NOTIFY_SIGNAL_EXIT_CODES.SIGTERM`.
- `src/listener/supervisor.ts` does not spawn or wait on `inbox --notify`. `src/listener/main-routing.ts:130` is a remedy sentence.
- `src/listener/hook.ts` and `src/mcp/` do not spawn notify or read its status.
- `tests/p1-cli/hook-routing.test.ts:2218` matches the command string in rendered text.
- `tests/p1-cli/follow-backoff-e2e.test.ts` sends SIGTERM to `inbox --follow`, which still uses its own handler.
- `tests/p1-cli/fixtures/command-dispatch-baseline.json` records `inbox.notify` as exit 1 with `signal read failed (HTTP 400)`, a failed read, not a signal stop.
- `docs/evidence/2026-09-24-item-g-design/wake-liveness-design-v1.md:12` describes the old exit 0; line 26 requires the non-zero exit. No brain-topic copy in the repo branches on that status.

**3. Parent evidence.** `systemParentProcess` (`src/resume.ts:241-262`) uses `ps -o ppid= -p <pid>`. ppid 1 is `parent_is_init` (measured: a reparented `sleep` had ppid 1 and classified `parent_is_init`). A signalable parent is `parent_alive` (measured on a live child). `ps` failure is `cannot_determine` (measured on a missing pid). `process.kill(parent, 0)` with `ESRCH` is `parent_missing`; a dead pid on this host returns `ESRCH`. JSON keeps `stdout`, `parent`, and `state` separate (`src/resume.ts:581-586`). The human line names which evidence, and the next step is `kill <pid>` plus restart under the session Monitor (`src/resume.ts:446-450`, `515-518`).

**4. Controls.** Pure tests under a temporary `HOME`, with `FORCE_COLOR` unset: `arrival-watch.test.ts`, `resume.test.ts`, `citation-drift.test.ts`, and `arrival-notify.test.ts` — 41 passed, 0 failed. Revert is from the assertions (the tree was not edited):

- Idle orphan (`tests/p1-cli/resume.test.ts:503-538`) expects exit 74 within 3 seconds after only stdout is destroyed. Removing the idle inspect leaves the child alive until that deadline rejects the test.
- Non-orphan and throwing inspectors (`tests/support/arrival-watch.test.ts:1054-1086`) expect `cancelled`, three checks, and empty stderr. Turning those results into `orphaned`, or writing stderr per check, fails the assertion.
- Push wait (`tests/support/arrival-watch.test.ts:1020-1051`) expects three checks and `NotifyStdoutClosedError` before a 3-second reconcile. It passed in 205 ms. Skipping the push-loop inspect leaves `checks` at 0 and `reason` `cancelled`.
- Signal tests (`resume.test.ts:551-587`) require the table value to equal `128 + osConstants.signals[name]` and the child exit to equal the table. Table codes 0 fail the first assertion; a CLI that still exits 0 fails the second. Both `arrival-notify` cases expect 143.
- Restart text (`resume.test.ts:546-548`) requires `NOTIFY_RESTART_COMMAND === cswarm inbox --${NOTIFY_FLAG}` and the sentence to contain that command. Changing the command fails it. The test does not open `cli.ts`; the CLI and the sentence already share `NOTIFY_FLAG`.
- Parent report (`resume.test.ts:590-620`) expects init and missing parents to render as orphans while `stdout` stays `live_reader`. Forcing `parent_alive` in `watcherState` fails that test. The injected adapter does not call `systemParentProcess`, so a change only inside `ps` parsing would not fail it. The real classifier was measured separately above.

**5. Lane record.** Maker commits after `ab21ad91` touch only `src/`, tests, `scripts/timeout-table/mapping.json`, and `docs/evidence/2026-09-24-item-g-lane2a/LANE.md`. No new test file. `tests/support/arrival-watch.test.ts` and `tests/p1-cli/resume.test.ts` are in the literal `npm test` list. `tests/p1-cli/arrival-notify.test.ts` is under the `test:p1-cli` glob. `check:edge` lists six entry points. The code claims in `LANE.md` match the tree. The full-suite counts in that record (977, 944, site build, release bundle) were not re-run here.

VERDICT: FAIL
