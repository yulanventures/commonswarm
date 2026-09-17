I'll review the exact SHA against main, then attack the budget and lock-fix paths in the code.Worktree is at the exact SHA. Next I’ll read the full range diff and the lock/deadline code.The range diff is truncated. I’ll read the changed source files and hunt every 3s / timeout claim.Budget and lock code is in view. Next I’ll trace every consumer and every leftover 3s claim.I’ll read the receive-hook path, listener check, and tests next — those are the places a budget bug would actually show.I have the deadline math. Next I’ll check the host default timeout, signal deadlines, and whether the lock finally-path can delete someone else’s lock.Reviewed `0e307c2eaeadc47396dfc6106afc2abf4ca120df` against `4cb8c5fe6d5a92ba5391b616404f1fae9c8734d6`. Worktree is that SHA. No production HTTP. No other model.

## 1. Ceiling arithmetic (PRODUCTION)

The written host ceiling is `timeout: 5` in `src/cloud/agent-receive.ts:148` (`HOST_HOOK_TIMEOUT_SECONDS`). Claude Code / Codex start that timer when they **spawn** the hook. Our timers start later.

| Clock | When it starts | Value |
|---|---|---|
| Host | spawn | 5_000 ms |
| Hard exit | handler, but delay is `4_900 - process.uptime()` | process age 4_900 ms (`src/onboarding-cli.ts:102-105`, `src/cli.ts:7868-7870`) |
| Check abort (receive) | `checkAgentMessages` | `min(start+3_900, processStart+4_750)` (`src/cloud/agent-check.ts:149-154`, `src/onboarding-cli.ts:110`) |
| Manual `cswarm check` | `checkAgentMessages` | 3_900 ms only. No host timer. |

Work **before** the 3_900 ms budget: Node boot, `cli.ts` load, argv parse, stdin (`hookInput` cap 1 s at `src/onboarding-cli.ts:82`), `receiveHookEvent` (local bind write, lock wait up to 2 s at `src/cloud/agent-receive.ts:92`). Work **inside** the budget: profile read (`src/cloud/agent-check.ts:151`, after `startedAt`), lock wait, session context, credential open/renewal, two HTTP reads, `present()`, cursor write.

**Can the host kill before `check_timeout` is printed?** On the idle p95 (90 ms start-up) no: abort at ~4.0 s process age, hard exit at 4.9 s, host at 5.0 s. On a loaded host with start-up at the 1_000 ms allowance: abort at 4.75 s, 150 ms for the catch path (`src/onboarding-cli.ts:117-128` writes the diagnostic, then stdout). That is the point of the 1_000/100/150 split: a host kill is silent; our `check_timeout` is reported.

If start-up is **past** 1 s, remaining check time shrinks (`4_750 - age`). A healthy Supabase check (p95 1.03 s) still fits at ~1.4 s start-up. A 3.1–3.6 s box check would not. The box path is rolled back. Not established: start-up > ~2 s on a loaded mini with `dist/cli.js`.

**Lock wait can consume the whole budget.** Yes. `src/cloud/agent-check.ts:227` passes remaining time into `withFileLock`, cap 30 s never binds (remaining ≤ 3.9 s). Sequence: another live `cswarm check` holds `check.lock` → this check waits until `deadlineMs` → `FileLockTimeoutError` → `check_timeout` (`:228-230`). **No HTTP.** User/agent sees: `The message check timed out. Try cswarm check again; the inbox was not proved empty.` Cursor unchanged. Next turn runs if the holder released. That is the whole-operation contract, not a leak of the 30 s cap.

A **dead** holder no longer burns that budget: `lockOwnerIsDead` + unlink at `src/cloud/storage.ts:395-397`.

## 2. Consumers and leftover 3 s claims (PRODUCTION)

Live constants: `AGENT_CHECK_TIMEOUT_MS` / `HOOK_CHECK_TIMEOUT_MS` (same 3_900), `HOST_HOOK_TIMEOUT_SECONDS` (5), hard-exit helpers. Consumers: `src/cloud/agent-check.ts`, `src/onboarding-cli.ts` (receive hook), `src/listener/hook.ts:74-78` + `:1167-1182`, `src/cli.ts:932` (usage interpolates the constant → `3.9s`), `src/cli.ts:7870`, `src/cloud/agent-receive.ts:148`.

Swept: `src/`, `site/src`, `site/public`, `docs/design`, `AGENTS.md`. Live design text is `docs/design/2026-09-06-PUSH-DELIVERY.md:36`. Historical 3 s in `docs/org` / `docs/evidence` is the 0.1.71 rollback, not this client. `hook-routing.test.ts` still passes `deadlineMs: Date.now() + 3_000` as a **test** deadline into `checkListenerHooks`; that is not a production claim.

No missed live “three-second” claim for these checks.

## 3. Listener hook vs host default (PRODUCTION)

`cswarm hook install claude` writes **no** `timeout` (`src/cli.ts:7589-7603`). The host default applies (Claude Code documents 60 s when omitted). Internal bound is still the receive-hook 5 s math (`src/listener/hook.ts:72-74`). Check timer: `Date.now() + 3_900` from **handler** start (`:1170-1182`). Hard exit: process age 4_900 ms.

If load is small, the 3.9 s check abort wins; stdout is empty (listener timeout is silent by design). If load is large (~2 s), hard exit can win first: `process.exit(0)` at `src/cli.ts:7868-7870`, empty stdout, no `check_timeout` sentence. Same shape as today’s silent listener timeout. Host default 60 s will not kill first. Safe, conservative: we do not use the extra host time.

## 4. Old/new mix (PRODUCTION)

| Mix | What happens |
|---|---|
| Old hook `timeout: 5` + new client | Host still 5 s. New client aborts at 3.9 s / 4.75 s and hard-exits at 4.9 s. Safe. |
| New hook `timeout: 5` + old client | Host 5 s. Old client still 3 s internal. Safe. Tight 3.1 s checks still fail until the client is upgraded. |
| Old listener install (no timeout) + new client | Host default. New client self-limits to 3.9/4.9 s. Safe. |

`timeout: 5` is the same number as before this lane; only the name changed.

## 5. Tests (RIGOUR)

`tests/p1-cli/check-budget.test.ts` is in `test:p1-cli` (glob). Not in the literal `npm test` list. That matches the gate rule.

Independent of the budget constant: `DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS = 5` (`:30`) vs written hook timeout (`:117-121`) and vs `budget + 1_000 + 100` (`:109-114`). A typed `3_000` constant fails **that** row.

The receive-hook lower bound (`:335-337`) is **not** independent: it is `elapsed >= AGENT_CHECK_TIMEOUT_MS - 300`. Comment says a shorter typed budget fails here. If the **constant** is set to 3_000, the floor becomes 2_700 and a 3 s hang still passes; the arithmetic row is the one that fails. If the hook path hard-codes 3_000 while the constant stays 3_900, this row only fails when start-up is ≲ 600 ms. This test loads `src/cli.ts` through tsx; start-up is often larger. K10’s real discriminators are the diagnostic file (`check_timeout` from the catch path, not the hard exit) and `check.lock` absent (`:339-341`).

Hung write-back in `hook-routing.test.ts:850-852` compares to `HOOK_CHECK_TIMEOUT_MS` itself. It proves the listener respects its constant, not that the constant is derived from 5 s.

---

## Attack on K6–K8 / K10

**PID reuse / EPERM / other namespace (RIGOUR, not a regression).** `src/cloud/storage.ts:357-365`: `kill(pid, 0)` → live; `ESRCH` → dead; anything else (including `EPERM`) → not dead. Directories are 0700, so cross-user is out. A live unrelated process with the dead owner’s pid: we wait, then `check_timeout` each turn until 60 s mtime (`LOCK_STALE_MS`). User sees the same timeout sentence; messages wait. That was the **old** path for every dead pid. K7 only improves true `ESRCH`. False `ESRCH` (shared dir, other container/host/PID namespace): we unlink a live owner’s lock. Same-uid Docker/NFS home sharing. Not the one-Mac seat this CLI is built for. Credential renewal uses the same helper (`src/cloud/agent-credential.ts:210`, no extra timeout). False steal there is two renewals. Same residual as the old 60 s mtime steal, now immediate.

**Stale-unlink vs new owner (RIGOUR).** `src/cloud/storage.ts:395-397`: observe dead → `unlink` with no pid/createdAt match → `wx`. Two waiters after one crash can both unlink; the second can delete the first’s new lock. Both run `work()`. For `check.json`: both present the same page; a late first-write can rewind the cursor (`src/cloud/agent-check.ts:218-224`); next turn **replays** messages. Needs two overlapping waiters (e.g. SessionStart + UserPromptSubmit, or hook + manual `cswarm check`) after a dead lock. The common SIGKILL recovery is **one** next hook: take at once, no 60 s wait. The 60 s mtime path already had this unlink race.

**Exit handler vs other owner (PRODUCTION: handler is safe).** `src/cloud/storage.ts:337-341` re-reads pid **and** `createdAt` before `unlinkSync`. It will not remove a lock another process now owns. `finally` at `:413-416` still unlinks the path with no re-read. That can delete a thief’s lock if a steal happened while we were alive (false `ESRCH` or 60 s mtime). Check work is < 4 s, so mtime steal does not apply on this path.

**`exit` paths (PRODUCTION for the bug they fixed).** `process.on("exit")` runs on `process.exit`, normal empty-loop exit, default SIGINT/SIGTERM, and uncaughtException shutdown. It does **not** run on SIGKILL. SIGKILL: lock remains, pid is dead, next waiter takes it at once. That is K7. User no longer burns 60 s / 3.9 s waits after a host kill.

**Absolute deadline vs healthy check (RIGOUR).** `hostHookCheckDeadlineAt` remaining is `4_750 - uptime` (wall clock cancels). A one-shot hook with uptime > 4.75 s at check start aborts in 1 ms: correct, the host is about to kill. Manual `cswarm check` does not pass `deadlineAtMs`. A later daemon that passed this option would fail healthy checks; nothing does that now. `Date.now()` vs `uptime` drift during the two adjacent calls is not a real NTP window. Wall-clock jump **during** lock wait (`storage.ts:380,399`) can early-timeout; `setTimeout` in `withAgentDeadline` is monotonic.

**Write-back margin vs comment (RIGOUR).** Comment at `src/cloud/agent-check-budget.ts:31-35` says the 150 ms is for `present()` + cursor **after** the network. The code shortens the **whole** deadline (`agent-check.ts:154,158`). If HTTP uses all time until 4_750 ms, `present()` starts as the abort fires. `Promise.race` in `withAgentDeadline` (`:102`) does not stop `run()`. In-flight stdout + cursor write can still race the hard exit. The 150 ms is grace for the **catch** path before `process.exit`, which is what K6 needed. Narrow window; not the round-2 “cut during present with no catch”.

**K8:** one sentence at `src/cloud/agent-check.ts:69-73`. Lock and signal timeouts map to it (`:228-230`). Hook wrapper text is a different surface (`onboarding-cli.ts:69-70`).

---

No PRODUCTION blocker. Residual races need two waiters or a shared PID namespace. Tests have one weak lower bound; arithmetic + diagnostic file still gate the budget and the catch path.

VERDICT: PASS — derived 3.9 s budget and process-start abort sit inside the written 5 s host kill; SIGKILL no longer leaves a 60 s lock; mix of old/new hooks is safe.
