I'll review the exact SHA against main: first git log and the full diff, then the timeout arithmetic, every consumer, and the tests.I have the lane diff. Next I’ll read the budget, check, hook, and lock paths in source so the timer arithmetic is measured, not assumed.Found a live “3s ceiling” string in the CLI. I’ll enumerate every remaining 3-second claim and then trace the lock, Codex timeout units, and CLI check path.I’ve got the timer seams. Next I’ll pin Codex/Claude timeout units, the lock vs remaining budget, and whether the new tests can actually go red.I’ll run the new budget tests and the two changed hook tests, then write the verdict.Reviewed SHA `f5b17672c61e7127239010681ce4af2244d75486` vs main `4cb8c5fe`. Two commits: derive the budget from the host hook ceiling, then widen idle 100/10 ms allowances to 1,000/100 ms for a loaded host.

**Formula:** 5,000 − 1,000 − 100 = 3,900 ms. That is correct as written. Uncontended check on the Supabase path (p95 1.03 s / 1.10 s) and the rolled-back 3.14–3.57 s cases fit inside 3,900 ms.

**Timers (receive vs listener):**

| Path | Host timer start | Host ceiling | Our timer start | Our bound |
|---|---|---|---|---|
| `cswarm check --hook` (receive) | Host spawns the command | `timeout: 5` seconds written by `mergeReceiveHooks` | `startedAt` in `checkAgentMessages` after stdin + binding I/O; `withAgentDeadline` after profile + lock | 3,900 ms remaining |
| `cswarm hook check` (listener) | Host spawns the command | Installer writes **no** `timeout`. Claude Code `UserPromptSubmit` default is 30 s; Codex default is 600 s | `HOOK_PROCESS_TIMEOUT_MS` (4,000 ms) at `runHook` after CLI boot; check 3,900 ms in `runListenerHookCheck` | `process.exit(0)` at 4 s after `runHook` |

Claude Code and Codex both treat `timeout` as seconds. Local hard-deadline test: spawn → exit **4,443 ms** (boot ≈ 443 ms). Under the 1,000 ms start-up allowance. Under a 5 s receive ceiling. I did not run this under the operator’s loaded mini.

---

### PRODUCTION

**P1. File lock can spend the whole 3,900 ms with no HTTP.**  
`src/cloud/agent-check.ts:139-211` — lock wait is `{ timeoutMs: Math.min(timeoutMs, 30_000) }` = **full** `AGENT_CHECK_TIMEOUT_MS`, not remaining after start-up. Sequence: `startedAt` → `readAgentProfile` → wait on `check.lock` up to 3,900 ms → only then `withAgentDeadline(remaining)`. A second `cswarm check` (SessionStart + UserPromptSubmit share this lock) can hold it for the whole network window.

What the user/agent sees: lock timeout throws `Error("timed out waiting for the credential refresh lock")` (`src/cloud/storage.ts:349`), **not** `check_timeout`. `--hook` maps that to `check_failed` (`src/onboarding-cli.ts:98-104`): `CommonSwarm check failed (check_failed); the inbox was not proved empty.` Manual `cswarm check` prints a raw lock error. Inbox not proved empty. Pre-existing shape; this lane scaled it 3,000 → 3,900 ms, so a waiter is closer to the 5 s host kill.

**P2. Receive hook has no process hard-exit; listener does.**  
`src/cli.ts:7868-7871` `process.exit(0)` is only on `cswarm hook check`. Receive is `cswarm check --hook` (`src/onboarding-cli.ts:82-107`): abort + `check_timeout` text only. Claude Code **discards hook stdout** if the process is still alive at 5 s. Sequence: hanging fetch ignores abort → `withAgentDeadline` rejects at ~3.9 s and writes `check_timeout` → sockets keep the event loop up → host kills at 5 s and drops the text. User/agent sees a silent skip, not `check_timeout`. Listener `process.exit(0)` avoids that; receive does not. Pre-existing. This lane does not add a receive hard-exit.

**P3. Fetch `deadlineMs` is the full 3,900 ms from fetch start, not remaining.**  
`src/cloud/agent-check.ts:149-154`: `deadlineMs: Date.now() + timeoutMs` after the lock. After a 2 s lock wait, abort remaining is ~1.9 s but the read’s own timer is 3.9 s from now. Abort is the real bound **if** the fetcher honours `signal`. If it does not, combine with P2: host 5 s can win. Pre-existing.

**P4. `--hook` stdin can spend the whole start-up allowance after boot.**  
`src/onboarding-cli.ts:68`: `hookInput` aborts at 1,000 ms, **before** `startedAt`. The 90 ms p95 was “spawn to deadline start” with instant fake fetch (likely not this stdin path). Slow-but-complete stdin (~1 s) + 3,900 ms check + boot can pass 5 s. Typical Claude/Codex stdin is short. Residual.

**P5. Load delay vs 1,000 ms start-up.**  
Commit text: hard-deadline test ran 1.15–1.4 s longer under agent load than alone. That is whole-test elapsed (includes the 4 s `setTimeout`), not a measured start-up p95. If the extra is timer slack in **our** Node process, Claude’s 5 s timer (other process) can still fire first on receive. Listener host default 30 s: not this risk. Residual. Not measured here under that load.

Host kill before our text: **yes, possible** on receive when start-up + check + output > 5 s, or when the process does not exit after `check_timeout` (P2). Listener: 4 s hard-exit vs ~30 s host default — host should not kill first.

---

### RIGOUR

**R1. User-facing “3s ceiling” is now false.**  
`src/cli.ts:932`: `hook check has its own 3s ceiling`. Usage text. Actual: `HOOK_CHECK_TIMEOUT_MS` = 3,900, `HOOK_PROCESS_TIMEOUT_MS` = 4,000. Agent/user running `cswarm --help` still reads 3 s. No test pins this string. `site/src`, `site/public`, `AGENTS.md`, `docs/design`: no other live 3 s claim for these checks. `docs/design/2026-09-06-PUSH-DELIVERY.md:36` was updated.

**R2. Comment still says 3 s.**  
`src/listener/hook.ts:1088`: “hook's 3s ceiling”. Not user-facing.

**R3. Formula test is a tautology.**  
`tests/p1-cli/check-budget.test.ts:97-101`: `TIMEOUT + STARTUP + OUTPUT === HOST * 1000`. `AGENT_CHECK_TIMEOUT_MS` is **defined** as that difference (`src/cloud/agent-check-budget.ts:22-25`). Fails only if someone replaces the formula with a literal that does not add up. Does not check that 5 s is the host unit, or that 1,000/100 match a measurement.

**R4. Receive-hook wiring test is circular.**  
`check-budget.test.ts:104-108`: `mergeReceiveHooks` timeout === `HOST_HOOK_TIMEOUT_SECONDS`. Same constant both sides. Catches a hardcoded different number. Does not catch a wrong 5.

**R5. Hard-deadline bound is not the host 5 s.**  
`tests/p1-cli/hook-routing.test.ts:1612-1615`: `elapsed < HOOK_CHECK_TIMEOUT_MS + 1_000` = 4,900 ms. Grows with the check budget. First-commit values (check 4,890) would have allowed 5,890 ms, over the 5 s host kill, and still passed. Current 4,900 happens to sit 100 ms under 5,000. Independent delay test at `check-budget.test.ts:111-136` **does** fail for the claimed reason (real wait vs timeout; cursor stays at the first message). I ran it: 7,773 ms, pass. Hung-write-back: 3,936 ms. Hard-deadline: 4,443 ms, exit 0, empty stdout/stderr.

**R6. `npm test` does not run `tests/p1-cli/check-budget.test.ts`.**  
`test:p1-cli` globs it. That is the intended gate.

---

### Q3–Q4 (no extra defect)

Listener installer (`src/cli.ts:7589-7603`) writes no `timeout`. Internal 3.9 s / 4.0 s is **below** Claude `UserPromptSubmit` default 30 s and Codex omit-default 600 s. Same internal bound as receive by choice (`src/listener/hook.ts:71-76`). Safe.

Old hooks (`timeout: 5`) + new client (3,900 ms): host still 5 s; check gained 900 ms. Covers 3.14–3.57 s.  
New hooks (`timeout: 5`, value unchanged) + old client (3,000 ms): same as 0.1.71. Safe both ways. Listener never wrote `timeout` in either generation.

---

**Not established:** live Claude Code / Codex spawn-to-timer on this host; Codex/Claude binaries’ default when `timeout` is omitted (docs as of 2026-09-16); operator mini under agent load; production HTTP.

VERDICT: PASS The 3,900 ms derived budget covers the 3.14–3.57 s cutover and stays under the receive-hook 5 s write; remaining issues are a stale help string, pre-existing lock/hard-exit gaps, and tests that pin the formula to itself.
