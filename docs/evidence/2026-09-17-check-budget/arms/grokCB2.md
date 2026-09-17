I'll review the exact SHA against main, read the budget/timeout path, and attack the hard-exit, lock, and constant-claim surfaces first.The lane is four commits. Next I’ll read the timeout, lock, and hook-exit code path by path.I have the budget math. Next I’ll trace hard-exit, stdout flush, lock release, and every remaining 3s claim.I’ll run the new budget tests next so the verdict is based on what this SHA actually does.Reviewed `8c4dca40` against `4cb8c5fe`. Arithmetic and K1–K5 hold for the 3.1–3.6 s incident. Residual holes sit at the 1 s start-up edge, not on the idle path.

## 1. Ceiling arithmetic

Host timer starts at spawn. Our check timer starts later, at `Date.now()` in `checkAgentMessages` (`src/cloud/agent-check.ts:147-152`), after Node boot, CLI load, profile read setup, then lock.

Budget: `5_000 - 1_000 - 100 = 3_900` (`src/cloud/agent-check-budget.ts:22-25`). Hard exit is `process.uptime()` based at 4_900 ms (`:28-36`, `src/onboarding-cli.ts:101-104`, `src/cli.ts:7868-7870`).

Idle start-up p95 90 ms: a 3.6 s check finishes near 3.7 s process age. That is inside 3.9 s and 4.9 s. The box samples that caused rollback would now succeed.

**Lock can eat the whole budget before any network call.** `withFileLock` gets `min(remaining, 30_000)` (`src/cloud/agent-check.ts:225`). A waiter burns the rest, then `FileLockTimeoutError` → `check_timeout`. No fetch. That is K2, and it is correct. Old code used the 30 s default lock wait, then still started the network after the host was already dead.

**Host kill before `check_timeout` is printed:** receive hook writes the existing `check_timeout` text at 4.9 s, then `process.exit(0)`. Host kill is 5.0 s. 100 ms is enough for that short line. Listener hook hard-exits with **empty** stdout (`src/cli.ts:7868-7870`). That matches “exits 0 on every outcome.”

**Hard exit vs a successful check still writing:** only if process age at `startedAt` is ~1 s, so `startedAt + 3_900` meets the 4.9 s hard exit. Then `process.exit` can run during `present()` or cursor write-back. Idle 90 ms does not hit this. `hookInput` can wait 1 s (`src/onboarding-cli.ts:81`) **before** `startedAt`; a slow stdin close eats the start-up allowance.

## 2. Consumers and 3 s claims

Live surfaces in the asked set were updated or never had a 3 s check claim:

| Surface | State |
|---|---|
| `AGENT_CHECK_TIMEOUT_MS` / `HOOK_CHECK_TIMEOUT_MS` | derived 3_900 |
| `mergeReceiveHooks` timeout | `HOST_HOOK_TIMEOUT_SECONDS` (5) |
| `cswarm --help` hook ceiling | interpolates `HOOK_CHECK_TIMEOUT_MS / 1_000` → `3.9s` |
| `docs/design/2026-09-06-PUSH-DELIVERY.md:36` | points at the derived budget |
| `AGENTS.md`, `site/src`, `site/public` | no live 3 s check claim |

`tests/p1-cli/hook-routing.test.ts` still passes `deadlineMs: Date.now() + 3_000` into `checkListenerHooks`. Those are injected test deadlines, not production claims.

Historical `docs/evidence/**` and `docs/org/**` still say 3 s. That is old record, not shipping copy.

## 3. Listener hook vs host default

`cswarm hook install claude` writes **no** `timeout` (`src/cli.ts:7589-7603`). Claude Code UserPromptSubmit default for `command` hooks is **30 s**, not 5 s ([hooks reference](https://code.claude.com/docs/en/hooks)). Codex default if omitted is 600 s; receive install still writes `timeout: 5`.

`HOOK_CHECK_TIMEOUT_MS` is still the 5 s receive-hook budget (`src/listener/hook.ts:72-76`). Hard exit is still 4.9 s from process start. We exit ~25 s before Claude would kill the listener hook. Safe (we die first). Not derived from **this** hook’s host ceiling. The comment says that is on purpose.

## 4. Old/new mix

- Old hook `timeout: 5` + new client: 3.9 s work, 4.9 s hard exit, host 5 s. Intended.
- New hook `timeout: 5` + old client: old 3 s work / 3 s handler exit, host 5 s. Safe, no extra headroom until the CLI is upgraded.
- Listener hook with no timeout + either client: our 3–4.9 s exit is far under the 30 s default. Safe both ways.

## 5. Tests

Ceiling and receive-settings rows pin `5` with an independent literal (`tests/p1-cli/check-budget.test.ts:27,106-118`). A typed `3_000` budget fails that row. The below/above row (`:125-153`) proves enforcement of whatever the constant is; load margin is 600 ms as the lead said.

Gaps:

- Usage row (`:121-123`) builds the expected string from `HOOK_CHECK_TIMEOUT_MS`. It only proves interpolation.
- Process rows (`:268-270`, `tests/p1-cli/hook-routing.test.ts:1614-1617`) assert elapsed **&lt; 5 s**. A revert to a 3 s hard exit still passes.
- Hung-observation row has an upper bound only (`hook-routing.test.ts:850-852`). A hardcoded 3 s inside `runListenerHookCheck` would still pass while the export stayed 3_900.

`tests/p1-cli/check-budget.test.ts` is in `test:p1-cli` (glob). Not in the literal `npm test` list. That matches the repo rule. I ran the file: 6/6 pass.

---

### Attack results

**Pipe truncation (PRODUCTION, narrow).** `writeOnboardingOutput` waits for the write callback, then `process.exit(0)` (`src/onboarding-cli.ts:52-61,72-74`). On Unix, an **awaited** small JSON write is in the kernel pipe. Receive-hook output is bounded by `AGENT_CHECK_BODY_BUDGET` (4_000). Listener hard exit does **not** wait: `process.exit(0)` at `src/cli.ts:7868-7870` while `HOOK_RENDER_BUDGET_BYTES` is 128 KiB (`src/listener/hook.ts:101`). If that write is still in user space (pipe full, host not reading yet) at 4.9 s, the model sees a cut block or nothing. Claude then goes on with a partial or empty inject.

**Successful check still writing (PRODUCTION, allowance edge).** Sequence: start-up ~1 s → check uses ~3.9 s → `present()` at process age ~4.9 s → hard-exit callback runs (`src/onboarding-cli.ts:101-104`) → `process.exit(0)`. User/agent can see a cut JSON line, then a timeout line, or only the timeout line.

**Cursor / high-water skip (PRODUCTION, designed replay, not loss).** Receive: bodies saved, cursor only after `present()` (`src/cloud/agent-check.ts:219-222`). Hard exit in between → same messages print again next turn. Agent may answer the same ask twice. Listener: print, then `commit` (`src/listener/hook.ts:1109-1134`). Exit between them → same: shown again, not dropped. Code already says failure to present can replay.

**Other work cut by early exit (RIGOUR).** `process.exit` kills only this hook process. It does not stop a listener. In-process renewal work dies with the process. No check path starts a model. Keep-alive sockets in this process are the reason K1 exits; that part works.

**Lock release (PRODUCTION at the hang + slow-start edge).** Cooperative timeout **does** release `check.lock`: `Promise.race` throws, `withFileLock` `finally` unlinks (`src/cloud/storage.ts:364-369`). If hard exit **wins first** (start-up &gt; 1 s, hang ignores abort), `process.exit` skips `finally`. Lock file keeps a dead pid. Stale only after 60 s (`:24,353-358`). Pid is written and never checked. Next `cswarm check` / turn hook waits up to 3.9 s, then the agent sees `check_timeout` / `CommonSwarm check failed (check_timeout); the inbox was not proved empty` even if the network is fine. Repeats until the lock is stale. Their own 1_200 ms preload test is this path; it does not assert the lock is gone. Idle 90 ms start-up does not hit it: the 3.9 s timer throws first and the lock is released.

**Typed lock error (RIGOUR, does not leak from check).** `FileLockTimeoutError.code` is `file_lock_timeout` (`src/cloud/storage.ts:319-325`). `checkAgentMessages` maps it to `check_timeout` (`src/cloud/agent-check.ts:226-228`). `cswarm check` JSON still gets `check_timeout`, not `file_lock_timeout`. The class is global: every `withFileLock` timeout now throws it. Same message as before (`timed out waiting for the credential refresh lock`), including when the lock name is `check`. Other commands that time out a lock still show that sentence.

**Two timeout sentences (RIGOUR).** `checkTimeoutError()` says try again; inbox not proved empty (`src/cloud/agent-check.ts:69-73`). Line 213 still throws `The message check timed out. Try again.` Same code, weaker sentence, if abort is seen after the result is built.

---

The 3.1–3.6 s rollback path is inside 3.9 s. Mix of old/new hooks does not cause a silent host kill. Remaining risk is the 1 s start-up edge on hang, and replay if exit beats cursor write-back.

VERDICT: PASS — 3.9 s derived budget and 4.9 s process-age hard exit cover the measured 3.1–3.6 s timeout; remaining holes are the 1 s start-up edge (lock leak / replay), not the idle production path.
