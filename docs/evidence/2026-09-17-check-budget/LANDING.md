# Check budget landing: turn-check budgets derived from the host hook ceiling (2026-09-17)

Lane `lane/check-budget`, tip **3c18da42**, landed with `git merge --no-ff`. Ruling c05b6dda: "raise AGENT_CHECK_TIMEOUT_MS
to a derived value with headroom in the next CLI release, because 3 s was tight even on Supabase". NOT RELEASED: this lands
on main only; it ships with the next npm release.

## What changed

- `src/cloud/agent-check-budget.ts`: host hook ceiling 5 s (the `timeout` the client writes into Claude Code / Codex hook
  settings) - start-up allowance 1,000 ms - output allowance 100 ms = `AGENT_CHECK_TIMEOUT_MS` 3,900 ms (was 3,000). The
  listener hook check uses the same value. Measured: idle start-up p95 90 ms, output p95 3 ms; the allowances are sized for a
  loaded host because a host kill is silent and our check_timeout is reported. Supabase whole check p95 1.03 s: 3.8x.
- Receive hook and listener hook: a hard exit measured from PROCESS START at 4,900 ms, and the receive hook exits as soon as
  its output is written (a socket that ignores abort can no longer keep it alive into the host kill).
- The receive hook passes the check an absolute deadline (process start + 4,900 ms - 150 ms), so the check aborts itself
  with the cursor unchanged before the hard exit.
- `withFileLock`: a typed `FileLockTimeoutError` (mapped to check_timeout inside check); the lock wait and the reads get only
  the remaining budget; a lock whose recorded pid is gone on this host is taken at once; a process 'exit' handler and the
  normal release remove only this process's own record (pid, host, createdAt).
- Usage text generates the listener hook ceiling from the constant; one check_timeout sentence.

## Commits

fee2a841 (Codex: derivation, hook writer constant, tests), f5b17672 (lead: allowances for a loaded host), b54e3766 (lead:
boundary-test margin), 8c4dca40 (Codex round 1: hard exit, typed lock timeout, remaining-budget deadlines, generated usage,
independent host contract in tests), 0e307c2e (lead round 2: absolute hook deadline, dead-owner lock, exit-time release),
ce54c3bd and 3c18da42 (lead: round-3 RIGOUR folds). The lead wrote the last four after Codex hit its usage limit (Strategist
cc69e6aa: "Write the check-budget fold yourself with grok + antigravity as its arms").

## Review (arms/)

| round | SHA | antigravity | grok |
|---|---|---|---|
| 1 | f5b17672 | FAIL | PASS |
| 2 | 8c4dca40 | FAIL | PASS |
| 3 | 0e307c2e | PASS (3 RIGOUR, folded in ce54c3bd) | PASS (RIGOUR, folded in 3c18da42) |

Rulings on the splits, verified on the code: round 1 — the 1.15-1.4 s "loaded start-up" figure was whole-test time, not
start-up (refuted); the missing receive-hook hard exit and the false "3s ceiling" help text were real (fixed). Round 2 —
stdout truncation refuted (writes await their callback); the hard exit cutting present()/cursor write and leaving check.lock
for the 60 s stale window were real, introduced by round 1 (fixed in 0e307c2e).

## Gates at 3c18da42

build 0; `npm test` 0 (878); `test:p1-cli` 0 (769); `check:tests` 0; `scripts/build-release.sh` 0 (artifact runs);
`git diff --check` 0. Mutations recorded in the commit messages, each failing its test: removed receive-hook exit; lock
timeout unmapped; hard-coded 3s usage; hook timeout 6; listener deadline from handler start; absolute deadline ignored; hook
passes no deadline; dead-owner rule removed; exit release removed; host check removed; unconditional unlink.

## Not established

- A live Claude Code or Codex hook on a loaded host (the process-age behaviour is proven with a preload that burns 1,200 ms).
- Start-up above about 2 s: the remaining check time is 4,750 ms minus the process age.
- Two overlapping waiters after a crash can still race between the owner re-read and the unlink (window: one read).
