### 1. Ceiling Arithmetic End-to-End & Lock Timeout

#### Finding 1.1: Host Kills Hook Silently on a Loaded Host Before `check_timeout` Can Be Reported
* **Label**: PRODUCTION
* **File & Line**: `src/cloud/agent-check-budget.ts:10-25`, `src/cloud/agent-receive.ts:147-149`
* **Concrete Sequence**:
  1. Claude Code / Codex triggers the `UserPromptSubmit` command hook (`cswarm check`). The host hook supervisor starts its timer of $5{,}000\text{ ms}$ (`HOST_HOOK_TIMEOUT_SECONDS = 5`) at OS `spawn()`.
  2. Node 22 boots, initializes V8, loads and parses the CLI bundle, parses arguments, reads `profile.json`, reads credentials, and binds session proof.
  3. Commit `f5b17672` explicitly documents that under agent load on the operator's machine, execution ran $1.15\text{--}1.4\text{ s}$ longer than idle (where idle startup p95 was $90\text{ ms}$). This puts loaded startup wall clock at $1{,}240\text{--}1{,}490\text{ ms}$.
  4. Despite this measurement, `AGENT_CHECK_STARTUP_ALLOWANCE_MS` was set to only $1{,}000\text{ ms}$, leaving `AGENT_CHECK_TIMEOUT_MS = 3{,}900\text{ ms}`.
  5. `checkAgentMessages` begins and arms its internal `AbortController` timeout at $T = 1{,}250\text{ ms}$. Its deadline is scheduled for $T = 1{,}250 + 3{,}900 = 5{,}150\text{ ms}$.
  6. At $T = 5{,}000\text{ ms}$, the host hook supervisor hits its $5\text{ s}$ ceiling and sends `SIGKILL`/`SIGTERM` to the `cswarm` process.
  7. The internal $3{,}900\text{ ms}$ timer never fires; the `check_timeout` error is never caught or printed.
* **What a User or Agent Sees**: The host hook is terminated abruptly and silently by Claude Code/Codex with an exit code indicating signal termination (or empty stderr). The user/agent never receives the structured `check_timeout` diagnostic message or recovery instructions, defeating the explicit goal of the commit.

---

#### Finding 1.2: File Lock Timeout Consumes the Entire Check Budget Before Network Dispatch
* **Label**: PRODUCTION
* **File & Line**: `src/cloud/agent-check.ts:12-15`, `src/cloud/storage.ts` (`withFileLock`)
* **Concrete Sequence**:
  1. `checkAgentMessages` accepts `options.timeoutMs`, defaulting to `AGENT_CHECK_TIMEOUT_MS` ($3{,}900\text{ ms}$).
  2. To read/write `check.json` and synchronize cursor state, `checkAgentMessages` invokes `withFileLock(..., { timeoutMs: Math.min(timeoutMs, 30_000) })`.
  3. `Math.min(3_900, 30_000)` evaluates to $3{,}900\text{ ms}$—$100\%$ of the whole-operation budget.
  4. If another local process or concurrent hook holds the lock (e.g., for $3.2\text{ s}$), `withFileLock` blocks waiting on the lock.
  5. The lock is acquired at $T_{\text{lock}} = 3.2\text{ s}$, leaving only $700\text{ ms}$ of remaining budget.
  6. The Supabase network span p95 is $1.10\text{ s}$ ($1{,}100\text{ ms}$). The network fetch is aborted mid-flight by the overall deadline, or if the lock wait exceeds $3{,}900\text{ ms}$, the operation throws a lock error before a single network byte is dispatched.
  7. Unlike `src/listener/hook.ts:66` (which caps lock contention at `HOOK_LOCK_TIMEOUT_MS = 250`), `agent-check` lacks a small dedicated lock budget.
* **What a User or Agent Sees**: Spurious `check_timeout` or lock acquisition failures whenever local cursor lock contention occurs, without allowing sufficient time for the Supabase network span.

---

### 2. Consumer Audit and Hard-Coded 3s Claims

#### Finding 2.1: Residual 3s Claims and Undocumented Budget Drift
* **Label**: RIGOUR
* **File & Line**: `docs/design/2026-09-06-PUSH-DELIVERY.md:33`, `AGENTS.md`, `site/src/components/app/LiveDashboard.astro`
* **Concrete Sequence**:
  1. `docs/design/2026-09-06-PUSH-DELIVERY.md:36` updated the table row for Claude hook timeout, but Line 33 immediately above retains `Measured production wall clock per tick ≈ 3.6 s (ledger, docs/org/2026-08-29-...)`. A $3.6\text{ s}$ tick was previously failing a $3.0\text{ s}$ budget; under the new $3.9\text{ s}$ budget, a $3.6\text{ s}$ tick now falls inside the budget. The design doc fails to clarify how the new $3.9\text{ s}$ ceiling interacts with the $3.6\text{ s}$ measured tick.
  2. User-facing documentation in `AGENTS.md` and public documentation in `site/` describing prompt-time checks and turn latency still state or imply a 3-second check guarantee.
* **What a User or Agent Sees**: Inconsistent system specifications where design documents, agent guides, and code disagree on whether `cswarm check` bounds turns to 3 seconds or 3.9 seconds.

---

### 3. Listener Hook Process Hard Exit vs. Host Ceiling

#### Finding 3.1: Premature Hard Exit in `runHook` Truncates Execution Before `runListenerHookCheck` Timeout
* **Label**: PRODUCTION
* **File & Line**: `src/cli.ts:7867-7871`, `src/listener/hook.ts:71-76`
* **Concrete Sequence**:
  1. In `src/cli.ts:7867`, `runHook` starts a hard exit timer:
     ```typescript
     const hardExit = setTimeout(() => {
       process.exit(0);
     }, HOOK_PROCESS_TIMEOUT_MS);
     ```
  2. `HOOK_PROCESS_TIMEOUT_MS` is defined as `HOOK_CHECK_TIMEOUT_MS + AGENT_CHECK_OUTPUT_ALLOWANCE_MS` ($3{,}900 + 100 = 4{,}000\text{ ms}$). The comment claims it *"starts after process start-up"*, but it is actually instantiated right at the start of `runHook`.
  3. Following `hardExit.unref()`, `runHook` executes asynchronous setup: `await hookHostSessionIdFromStdin()`, reads listener credentials (`readListenerCredentialState()`), and configures the HTTP client before calling `runListenerHookCheck()`.
  4. If reading stdin and credential files takes $>100\text{ ms}$ (common under I/O load or stdin buffering), the remaining time until `hardExit` fires ($4{,}000\text{ ms} - 120\text{ ms} = 3{,}880\text{ ms}$) is strictly less than `HOOK_CHECK_TIMEOUT_MS` ($3{,}900\text{ ms}$).
  5. If the network check hangs, `hardExit` triggers `process.exit(0)` at $4{,}000\text{ ms}$ *before* `runListenerHookCheck` reaches its internal $3{,}900\text{ ms}$ abort deadline.
* **What a User or Agent Sees**: The process exits silently with code `0` and empty stdout. Any fallback text or partial diagnostics that `runListenerHookCheck` was designed to emit on timeout are truncated and lost.

---

#### Finding 3.2: Architecture Inconsistency: Listener Hook Installer Omits Host Timeout
* **Label**: RIGOUR
* **File & Line**: `src/listener/hook.ts:68-73`
* **Concrete Sequence**:
  1. `mergeReceiveHooks` in `src/cloud/agent-receive.ts` writes `{ type: "command", command, timeout: HOST_HOOK_TIMEOUT_SECONDS }` ($5\text{ s}$) into Claude Code/Codex settings.
  2. In contrast, `cswarm hook install claude` writes no `timeout` attribute.
  3. When `timeout` is omitted, the host defaults apply (Claude Code hook timeout defaults to 30–60 seconds, not 5 seconds).
  4. `src/listener/hook.ts` comments that it binds `HOOK_CHECK_TIMEOUT_MS` to `AGENT_CHECK_TIMEOUT_MS` to share an internal bound, but then enforces a self-imposed $4\text{ s}$ hard kill (`HOOK_PROCESS_TIMEOUT_MS`) on a command whose host ceiling is 30+ seconds.
* **What a User or Agent Sees**: Asymmetric hook behavior: receive hooks are bounded by the host at 5s, while listener hooks run with an unconstrained host timeout but are internally killed by `cswarm` after 4s without reporting an error.

---

### 4. Hook Version Compatibility

#### Finding 4.1: Old Hooks with New Client Under Load Face Host Kills
* **Label**: PRODUCTION
* **File & Line**: `src/cloud/agent-receive.ts:147`, `src/cloud/agent-check-budget.ts:22-25`
* **Concrete Sequence**:
  1. **New hooks with old client**: The new client wrote `timeout: 5` (which was also what the old client wrote). The old client runs with `AGENT_CHECK_TIMEOUT_MS = 3_000`. $3\text{ s} + \text{startup}$ comfortably finishes within the $5\text{ s}$ host ceiling. This path is backwards compatible.
  2. **Old hooks with new client**: The host settings have `timeout: 5`. The new client runs with `AGENT_CHECK_TIMEOUT_MS = 3_900`.
  3. Because the startup allowance in `agent-check-budget.ts` ($1{,}000\text{ ms}$) is narrower than loaded startup latency ($1{,}150\text{--}1{,}400\text{ ms}$), the new client on existing installations with `timeout: 5` will breach the host ceiling under load and get killed.
* **What a User or Agent Sees**: Upgrading `cswarm` on an existing installation with unchanged Claude settings causes silent hook failures under high load.

---

### 5. Test Rigour and Independent Verification

#### Finding 5.1: Tautological Budget Test
* **Label**: RIGOUR
* **File & Line**: `tests/p1-cli/check-budget.test.ts:96-102`
* **Concrete Sequence**:
  1. `check-budget.test.ts` contains:
     ```typescript
     test("check budget plus measured allowances equals the host-hook ceiling", () => {
       assert.equal(
         AGENT_CHECK_TIMEOUT_MS + AGENT_CHECK_STARTUP_ALLOWANCE_MS + AGENT_CHECK_OUTPUT_ALLOWANCE_MS,
         HOST_HOOK_TIMEOUT_SECONDS * 1_000,
       );
     });
     ```
  2. In `src/cloud/agent-check-budget.ts`, `AGENT_CHECK_TIMEOUT_MS` is defined as:
     `HOST_HOOK_TIMEOUT_SECONDS * 1_000 - AGENT_CHECK_STARTUP_ALLOWANCE_MS - AGENT_CHECK_OUTPUT_ALLOWANCE_MS`.
  3. The test asserts $(H - S - O) + S + O == H$. This is a pure algebraic identity.
  4. If `HOST_HOOK_TIMEOUT_SECONDS` or any allowance is changed to invalid or broken numbers, this test will continue to pass. It does not compare against any independent contract or external literal.
* **What a User or Agent Sees**: False confidence in CI; regressions in budget constants cannot be detected by this test.

---

#### Finding 5.2: Sequential Delays in Test Fetcher Compound Above Budget
* **Label**: RIGOUR
* **File & Line**: `tests/p1-cli/check-budget.test.ts:75-94`, `:112-120`
* **Concrete Sequence**:
  1. `fetcher` delays every request by `waitMs`:
     `await delay(waitMs, undefined, { signal: init?.signal ?? undefined });`
  2. `checkAgentMessages` executes two separate HTTP requests for uncached profiles: first for `resource === "members"`, then for `resource === "signals"`.
  3. In the "below budget" test case:
     `fetcher([first], AGENT_CHECK_TIMEOUT_MS - 100)` sets `waitMs = 3_800 ms`.
  4. If executed sequentially, two requests take $2 \times 3{,}800 = 7{,}600\text{ ms}$, exceeding `AGENT_CHECK_TIMEOUT_MS` ($3{,}900\text{ ms}$) and causing `below` to reject with `check_timeout` instead of succeeding.
  5. The test assumes a single network span or zero-latency members fetch, which does not match real uncached client flow.
* **What a User or Agent Sees**: Flaky or failing test runs on cold cache runs.

---

#### Finding 5.3: Assertion Anchored to Tested Constant Rather Than Host Ceiling
* **Label**: RIGOUR
* **File & Line**: `tests/p1-cli/hook-routing.test.ts:847-850`, `:1609-1614`
* **Concrete Sequence**:
  1. `hook-routing.test.ts:848` asserts:
     ```typescript
     assert.ok(elapsed < HOOK_CHECK_TIMEOUT_MS + 250, ...);
     ```
  2. `hook-routing.test.ts:1612` asserts:
     ```typescript
     assert.ok(elapsed < HOOK_CHECK_TIMEOUT_MS + 1_000, ...);
     ```
  3. The test claims to verify that the hook stays inside the host hook ceiling ($5\text{ s}$).
  4. Instead of asserting `elapsed < HOST_HOOK_TIMEOUT_SECONDS * 1_000`, it asserts relative to `HOOK_CHECK_TIMEOUT_MS + 1_000` ($4{,}900\text{ ms}$).
  5. If `HOOK_CHECK_TIMEOUT_MS` were accidentally raised to $6{,}000\text{ ms}$, the test would assert `elapsed < 7_000` and pass, despite completely violating the host's $5\text{ s}$ ceiling.
* **What a User or Agent Sees**: Tests pass even when the process duration violates the host hook timeout.

---

VERDICT: FAIL - Loaded startup latency (1.15-1.4s) exceeds the 1,000ms startup allowance, causing silent host SIGKILL at 5s before check_timeout can report, and runHook's 4,000ms hardExit races check completion if startup I/O exceeds 100ms.
