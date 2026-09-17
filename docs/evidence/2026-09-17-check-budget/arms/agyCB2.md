### 1. Attack Analysis (Hardest Vectors)

#### A. Pipe Truncation on Early Exit
- **File & Line:** `src/onboarding-cli.ts:68-71`, `src/onboarding-cli.ts:124-126`
- **Concrete Sequence:**
  1. `runTurnHook` calls `const result = await receiveHookEvent(profile, host, event);`.
  2. On a successful check with messages, `options.present(result)` formats and writes up to `AGENT_CHECK_BODY_BUDGET` (4,000 bytes) plus envelope and retrieval commands to `process.stdout`.
  3. In Node.js, when `process.stdout` is connected to a pipe (as spawned by Claude Code or Codex), `process.stdout.write()` is asynchronous and queues chunks in the stream/pipe buffer.
  4. `receiveHookEvent` resolves. In `runTurnHook`, `failureText` remains `undefined`.
  5. The `finally` block executes `await exitTurnHookProcess(failureText)`.
  6. In `exitTurnHookProcess`, `if (text)` evaluates to false. It does **not** call `writeOnboardingOutput`, does **not** await `process.stdout.on('drain')`, and does **not** use `process.stdout.write('', () => process.exit(0))`.
  7. It immediately executes `process.exit(0)`.
  8. The OS terminates the process immediately, discarding any unflushed bytes pending in Node's stream buffer.
- **Impact (PRODUCTION):** Large check results piped to the host are truncated at EOF. The agent or host parser receives incomplete JSON or cut-off message text.

---

#### B. Hard Exit Firing on Successful Checks & Skipping Cursor Write-Back
- **File & Line:** `src/cloud/agent-check.ts:149-152`, `src/cloud/agent-check.ts:219-225`, `src/onboarding-cli.ts:99-105`
- **Concrete Sequence:**
  1. Under system load, process startup (Node VM init, module graph resolution, profile read, hook stdin ingestion) takes ~1,000–1,200 ms.
  2. `checkAgentMessages` begins at `t = 1,150 ms`. It establishes an independent deadline: `deadlineMs = startedAt + timeoutMs = 1,150 + 3,900 = 5,050 ms`.
  3. Meanwhile, `hardExit` in `runTurnHook` was scheduled from process start to fire at `HOST_HOOK_PROCESS_DEADLINE_MS = 4,900 ms`.
  4. The network fetch completes at `t = 4,820 ms`.
  5. Line 222: `await writeSecureJsonFile(path, JSON.stringify(cached))` writes message bodies to disk with the *old* cursor.
  6. Line 223: `signal.throwIfAborted()` passes because `Date.now() < 5,050 ms`.
  7. Line 224: `await options.present(result)` presents messages to `stdout`.
  8. At `t = 4,900 ms`, before line 225 (`await writeSecureJsonFile(path, JSON.stringify({ ...cached, cursor }))`) executes or while `present` is finishing, `hardExit` fires.
  9. `hardExit` executes `void exitTurnHookProcess(turnHookFailureText(profile, "check_timeout"))`, appending failure text to `stdout` and abruptly calling `process.exit(0)`.
- **Impact (PRODUCTION):**
  - Messages are presented to the agent, but the cursor write-back is skipped.
  - The agent sees valid messages immediately followed by:
    `CommonSwarm check failed (check_timeout); the inbox was not proved empty.`
  - On the next turn, because the cursor was never updated, the exact same messages are fetched and presented again (message duplication/replay).

---

#### C. Abandoned Locks on Process Exit
- **File & Line:** `src/cloud/agent-check.ts:153-157`, `src/cloud/storage.ts:333-359`, `src/onboarding-cli.ts:68-71`
- **Concrete Sequence:**
  1. `checkAgentMessages` enters `withFileLock(dirname(path), "check", ...)`.
  2. The lock file `check.lock` is created on disk.
  3. If `hardExit` fires (at 4,900 ms process uptime), it invokes `process.exit(0)` directly.
  4. In Node.js, `process.exit()` terminates execution immediately without unwinding the call stack or running the `finally` block of `withFileLock`.
  5. `check.lock` is left on the filesystem.
  6. When the subsequent check invocation runs, it attempts to acquire `check.lock`.
  7. With the new lock timeout in `agent-check.ts:229`:
     `{ timeoutMs: Math.min(Math.max(0, deadlineMs - Date.now()), 30_000) }`
     the subsequent process waits its entire remaining budget (~3,900 ms) against the abandoned lock file.
  8. The lock wait expires, throwing `FileLockTimeoutError`, which maps to `check_timeout`.
- **Impact (PRODUCTION):** A hard exit leaves a stale lock file that causes the subsequent turn check to spend its entire budget blocked on lock contention, creating cascading `check_timeout` failures.

---

#### D. Typed Lock Error Leakage
- **File & Line:** `src/cloud/storage.ts:319-325`, `src/cloud/agent-check.ts:230-235`
- **Concrete Sequence:**
  1. `FileLockTimeoutError` is defined as a typed subclass extending `Error` with `name = "FileLockTimeoutError"` and `code = "file_lock_timeout"`.
  2. In `checkAgentMessages`, the outer `try/catch` catches `error instanceof FileLockTimeoutError` and maps it to `checkTimeoutError()`.
  3. Other callers across `src/` (credential refresh, hook surface locks) catch generic `Error`, which `FileLockTimeoutError` satisfies.
- **Impact (RIGOUR):** Cleanly handled. `FileLockTimeoutError` does not leak outside `checkAgentMessages`.

---

### 2. Attack: Production & Design Verification

#### 1. Ceiling Arithmetic End-to-End & Lock Timeout Budget Consumption
- **File & Line:** `src/cloud/agent-check-budget.ts:10-27`, `src/cloud/agent-check.ts:149-152, 229`
- **Analysis:**
  - Claude Code / Codex starts the 5.0 s hook timer at the moment `spawn()` is initiated.
  - CommonSwarm sets `AGENT_CHECK_STARTUP_ALLOWANCE_MS = 1_000 ms`, `AGENT_CHECK_OUTPUT_ALLOWANCE_MS = 100 ms`, and `AGENT_CHECK_TIMEOUT_MS = 3_900 ms`.
  - **Defect:** `checkAgentMessages` establishes its deadline at line 150 using `deadlineMs = startedAt + timeoutMs`, where `startedAt = Date.now()` is recorded when `checkAgentMessages` is entered, **not** at process start.
  - If startup (Node load, bundle evaluation, hook input parsing, profile read) consumes > 1,000 ms under host contention, `deadlineMs` pushes beyond 5,000 ms.
  - Meanwhile, `hardExit` is pegged to `HOST_HOOK_PROCESS_DEADLINE_MS = 4,900 ms` from process start. The 100 ms output allowance is insufficient under high load for Node to write diagnostic files, flush pipes, and exit before the host SIGKILLs the process at 5,000 ms.
  - **Lock Timeout:** `withFileLock` receives `Math.min(Math.max(0, deadlineMs - Date.now()), 30_000)`. If `check.lock` is held by another process, the lock wait consumes the entire budget before any network call, throwing `FileLockTimeoutError`, which maps to `check_timeout`. This correctly satisfies K2.
- **Label:** PRODUCTION

---

#### 2. Constants Consumers & Hardcoded Claims
- **File & Line:** `docs/design/2026-09-06-PUSH-DELIVERY.md:36`, `src/cli.ts:929`, `src/listener/hook.ts:1076, 1152`
- **Analysis:**
  - `src/cli.ts:929` interpolates `${HOOK_CHECK_TIMEOUT_MS / 1_000}s ceiling`.
  - `src/listener/hook.ts:1076` and `1152` replaced "3s ceiling" with "derived ceiling".
  - `docs/design/2026-09-06-PUSH-DELIVERY.md:36` was updated to note the derived ceiling.
  - However, `cli.ts:929` renders `3.9s ceiling` in user-facing usage text.
- **Label:** RIGOUR

---

#### 3. Listener Hook Ceiling & Installer Host Ceiling
- **File & Line:** `src/listener/hook.ts:72-79`, `src/cli.ts:7867-7871`
- **Analysis:**
  - `cswarm hook install claude` writes no `timeout` attribute into Claude Code hook settings. The host default applies.
  - `src/listener/hook.ts:72-74` sets `HOOK_CHECK_TIMEOUT_MS = AGENT_CHECK_TIMEOUT_MS` (3,900 ms) and `HOOK_PROCESS_DEADLINE_MS = HOST_HOOK_PROCESS_DEADLINE_MS` (4,900 ms).
  - **Defect:** In `src/cli.ts:7867`, `runHook` implements:
    ```ts
    const hardExit = setTimeout(() => {
      process.exit(0);
    }, hookProcessDeadlineDelayMs());
    hardExit.unref();
    ```
    If the listener hook process hits 4,900 ms, it silently calls `process.exit(0)` without outputting any diagnostic text or `check_timeout` message. This violates the commit claim in 8c4dca40 ("writes the existing check_timeout text first").
- **Label:** PRODUCTION

---

#### 4. Compatibility (Old vs. New Hooks and Clients)
- **File & Line:** `src/cloud/agent-receive.ts:147-149`
- **Analysis:**
  - Old installed hooks wrote `timeout: 5` explicitly into Claude Code / Codex settings. The new client sets `HOST_HOOK_TIMEOUT_SECONDS = 5`, keeping the process ceiling at 4,900 ms and check timeout at 3,900 ms. Both operate safely within 5.0 s.
  - New hooks written by `mergeReceiveHooks` write `timeout: 5` (identical to the old literal). An old client will run with its legacy 3,000 ms budget inside the 5,000 ms host window.
  - Bidirectional compatibility is preserved.
- **Label:** RIGOUR

---

#### 5. Test Independence and Mutation Validity
- **File & Line:** `tests/p1-cli/check-budget.test.ts:107-130`, `tests/p1-cli/hook-routing.test.ts:58, 1605-1617`
- **Analysis:**
  - `check-budget.test.ts:107` and `hook-routing.test.ts:58` pin the host contract against `DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS = 5` and `DOCUMENTED_HOST_HOOK_TIMEOUT_MS = 5_000`, independent of the budget module.
  - `check-budget.test.ts:124` tests `usage()` against `new RegExp(\`hook check has its own \${HOOK_CHECK_TIMEOUT_MS / 1_000}s ceiling\`)`. This tests that `usage()` interpolates the constant, rather than asserting against an independent literal string (`3.9s`).
  - `check-budget.test.ts:133-162` validates that fetch delays at `AGENT_CHECK_TIMEOUT_MS - 600` succeed while `AGENT_CHECK_TIMEOUT_MS + 300` reject with `check_timeout` without cursor movement.
- **Label:** RIGOUR

---

VERDICT: FAIL - `exitTurnHookProcess` terminates the process asynchronously via `process.exit(0)` without draining stdout pipes, causing output truncation on successful checks; desynchronization between `checkAgentMessages` (`startedAt + budget`) and `HOST_HOOK_PROCESS_DEADLINE_MS` causes hard exits during presentation that drop cursor write-backs, replay messages on subsequent turns, and abandon unreleased lock files on disk.
