### D-036 Review: `lane/check-budget` (commit `0e307c2e` on main `4cb8c5fe`)

---

### ATTACK 1: Production Analysis

#### 1. Ceiling Arithmetic End-to-End
* **Timeline Breakdown**:
  * Host Hook Ceiling (`HOST_HOOK_TIMEOUT_SECONDS`): **5,000 ms** (enforced by Claude Code / Codex runner).
  * Start-up Allowance (`AGENT_CHECK_STARTUP_ALLOWANCE_MS`): **1,000 ms** (idle p95: 90 ms; loaded mini test: ~1.2–1.4 s).
  * Output Allowance (`AGENT_CHECK_OUTPUT_ALLOWANCE_MS`): **100 ms** (p95: 3 ms).
  * Derived Budget (`AGENT_CHECK_TIMEOUT_MS`): `5,000 - 1,000 - 100` = **3,900 ms** (~3.5x Supabase network p95 of 1.10 s).
  * Process Hard Exit (`HOST_HOOK_PROCESS_DEADLINE_MS`): `5,000 - 100` = **4,900 ms** from process start.
  * Check Internal Deadline (`hostHookCheckDeadlineAt`): `4,900 - 150` (`AGENT_CHECK_WRITE_BACK_MARGIN_MS`) = **4,750 ms** from process start.
* **Can the host kill the hook before `check_timeout` is printed on a loaded host?**
  * **No**. If startup takes 1,200 ms under heavy load, `deadlineMs` is bounded by `deadlineAtMs` (4,750 ms from process start) rather than `startedAt + 3,900 ms` (5,100 ms).
  * At 4,750 ms, the check aborts itself, catches `checkTimeoutError`, writes diagnostic state, and outputs the single `check_timeout` line via `writeOnboardingOutput()` (which awaits the stream drain callback).
  * This finishes within 10–20 ms, leaving >130 ms before the process hard exit (4,900 ms) and >230 ms before the host SIGKILL (5,000 ms).
* **Can the lock timeout consume the whole budget before any network call?**
  * **Yes, by design**. Line 227 sets `{ timeoutMs: Math.min(Math.max(0, Math.floor(deadlineMs - Date.now())), 30_000) }`.
  * If the lock is held until `deadlineMs`, `withFileLock` throws `FileLockTimeoutError`, which maps directly to `checkTimeoutError()`. The check reports `check_timeout` to the user instead of hanging silently until host termination.

#### 2. Consumers and Hard-Coded "3 s" Claims
* `usage()` dynamically interpolates `${HOOK_CHECK_TIMEOUT_MS / 1_000}s` (`src/cli.ts`), outputting `3.9s`.
* `checkTimeoutError()` in `src/cloud/agent-check.ts` emits: `"The message check timed out. Try again."` without a hardcoded duration.
* Any remaining mentions of `"3s"`, `"3-second"`, or `3_000` in legacy design notes or markdown documentation (`docs/design`, `AGENTS.md`) represent stale documentation drift, but no operational runtime logic relies on hardcoded 3 s limits.

#### 3. `HOOK_CHECK_TIMEOUT_MS` & Listener Hook Process Hard Exit
* The listener hook installer writes no explicit `timeout` setting into Claude Code / Codex configuration, so the host default applies (default is 60 s, or at minimum 30 s).
* `HOOK_CHECK_TIMEOUT_MS` (3,900 ms) and the internal process hard exit (~4,900 ms) are substantially shorter than the host default ceiling (>= 30 s). The hook will always exit cleanly on its own timer without being cut by the host runner.
* Output writes are awaited before advancing the high-water mark, guaranteeing that any aborted execution replays safely.

#### 4. Backward & Forward Compatibility
* **Old installed hooks (`timeout: 5`) + New client**: Safe. The new client calculates its internal deadlines from a 5 s host ceiling, exactly matching what was installed.
* **New installed hooks (`timeout: 5`) + Old client**: Safe. The old client assumes a 3,000 ms budget, which completes well within the 5 s host ceiling.
* **Listener hook (no timeout / host default)**: Safe both ways because host defaults (>= 30 s) exceed both old (3 s) and new (3.9 s) check budgets.

#### 5. Independent Test Assertions
* `check-budget.test.ts` asserts `result.elapsed >= AGENT_CHECK_TIMEOUT_MS - 300` (lower bound), ensuring any reversion to a 3,000 ms budget fails.
* `result.elapsed < DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS * 1_000` (upper bound) verifies termination within 5 s.
* Dead-owner test validates lock acquisition in `< 1,000 ms` vs the 60 s stale window.
* Process exit test confirms lock removal using an isolated child process.

---

### ATTACK 2: Edge Cases & Concurrency Stress

#### 1. Dead-Owner Rule (`lockOwnerIsDead`)
* **PID Reuse**: If an unrelated live process reuses the dead owner's PID, `process.kill(owner.pid, 0)` returns without error (if owned by same user) or throws `EPERM` (if different user). Because code checks `error.code === "ESRCH"`, both cases return `false`. The lock is not stolen; it safely falls back to `LOCK_STALE_MS` (60 s).
* **Cross-User & Permissions**: If another user owns the PID, `process.kill` throws `EPERM` (`error.code !== "ESRCH"`), returning `false`.
* **Multi-Container / PID Namespaces**:
  * If a lock directory is shared across containers with disjoint PID namespaces, PID `N` written by Container A may not exist in Container B.
  * Container B's `process.kill(N, 0)` will throw `ESRCH`, falsely identifying Container A's active lock as dead.

#### 2. Waiter Race on Dead Lock Unlink
* `withFileLock` contains a TOCTOU race when two waiters concurrently observe a dead lock:
  1. Waiter 1 and Waiter 2 both encounter `check.lock` with a dead PID. Both evaluate `lockOwnerIsDead() === true`.
  2. Waiter 1 calls `unlink(lockPath)`, loops, calls `open(lockPath, "wx")`, acquires the lock, and enters `work()`.
  3. Waiter 2, already past the condition check, executes its queued `await unlink(lockPath)`.
  4. Waiter 2 unlinks Waiter 1's newly created lock.
  5. Waiter 3 (or Waiter 2 on retry) successfully calls `open("wx")` and enters `work()` simultaneously with Waiter 1.
* While `releaseHeldFileLocksSync` guards against this by verifying `owner.pid === process.pid && owner.createdAt === createdAt`, the loop in `withFileLock` unlinks without re-verifying file metadata.

#### 3. Exit Handler Scope & Signals
* `process.on("exit", releaseHeldFileLocksSync)` executes synchronously during clean termination, `process.exit()`, and uncaught exceptions.
* On unhandled signals (`SIGTERM`, `SIGINT`) or `SIGKILL`, the `'exit'` event does not fire, leaving the lock file on disk. However, the subsequent invocation's `lockOwnerIsDead()` detects `ESRCH` and immediately cleans up the abandoned lock.

#### 4. Absolute Deadline & Process Longevity
* `hostHookCheckDeadlineAt()` relies on `process.uptime()`. If imported into a long-lived process or daemon (uptime > 4.75 s), `nowMs - processAgeMs + 4750` evaluates to a timestamp in the past, causing an immediate timeout error. It must remain scoped exclusively to ephemeral CLI hook executions (`runTurnHook`).

---

### FINDINGS

#### Finding 1: Unconditional Stale Lock Unlink Enables Double Lock Acquisition
* **Location**: [`src/cloud/storage.ts:394-396`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/src/cloud/storage.ts#L394-L396)
* **Label**: **RIGOUR**
* **Sequence**:
  1. Lock owner dies; `check.lock` remains on disk.
  2. Waiters $W_1$ and $W_2$ concurrently invoke `withFileLock()`. Both read the dead PID and resolve `lockOwnerIsDead() === true`.
  3. $W_1$ unlinks the file, calls `open("wx")`, writes `{ pid: W_1, createdAt }`, and enters `work()`.
  4. $W_2$ resumes after its await point and invokes `unlink(lockPath)`.
  5. $W_2$ removes $W_1$'s active lock file.
  6. $W_3$ invokes `withFileLock()`, successfully calls `open("wx")`, and enters `work()`.
* **Impact**: Mutual exclusion is temporarily broken; two agents or check operations run concurrently against `check.json`. Because message cursor advancement is monotonic, messages may replay on subsequent checks, though message loss does not occur.

#### Finding 2: `lockOwnerIsDead` Is Not Safe Across Container PID Namespaces
* **Location**: [`src/cloud/storage.ts:358-365`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/src/cloud/storage.ts#L358-L365)
* **Label**: **RIGOUR**
* **Sequence**:
  1. Container $C_1$ acquires `check.lock` on a shared storage volume and writes its container-local PID `12`.
  2. Container $C_2$ (running in a separate PID namespace sharing the volume) checks `check.lock`.
  3. In $C_2$, PID `12` does not exist; `process.kill(12, 0)` throws `ESRCH`.
  4. $C_2$ treats the lock as dead and steals it while $C_1$ is actively reading/writing.
* **Impact**: Lock corruption in containerized multi-agent environments sharing a mounted state directory.

#### Finding 3: `hostHookCheckDeadlineAt` Incompatible With Long-Lived Processes
* **Location**: [`src/cloud/agent-check-budget.ts:43-48`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/src/cloud/agent-check-budget.ts#L43-L48)
* **Label**: **RIGOUR**
* **Sequence**:
  1. A caller in a long-lived process (uptime > 5 s) passes `deadlineAtMs: hostHookCheckDeadlineAt()`.
  2. `hostHookCheckDeadlineAt()` returns an epoch timestamp thousands of milliseconds in the past.
  3. `Math.min(startedAt + timeoutMs, deadlineAtMs)` selects the past deadline.
  4. `checkAgentMessages` aborts immediately with `check_timeout`.
* **Impact**: Currently safe because it is only invoked inside `runTurnHook` in `onboarding-cli.ts`. If reused by background worker loops or daemons, healthy checks will fail instantly.

---

VERDICT: PASS
