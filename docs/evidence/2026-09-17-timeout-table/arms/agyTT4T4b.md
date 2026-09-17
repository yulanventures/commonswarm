### D-036 Review: PART T4b (Tests, Fixtures, and Commit Messages — Piece 2 of 2)

#### Dependencies Not in This Chunk (Deferred to Other Parts)
- **Part T4a**: Setup and initial tests in [`test/timeout-table.test.ts`](file:///scripts/timeout-table/test/timeout-table.test.ts) (variable definitions for `repo`, `principal`, `workspace`, `writes`, the request listener initialization for `server`, and tests for worktree/temp credential cleanup on exit, line-shift IDs, and per-ref mapping).
- **Parts T1–T3**: Implementation code in [`scripts/timeout-table/enumerate.mjs`](file:///scripts/timeout-table/enumerate.mjs), [`scripts/timeout-table/mapping.json`](file:///scripts/timeout-table/mapping.json), [`scripts/timeout-table/run.mjs`](file:///scripts/timeout-table/run.mjs), and [`scripts/timeout-table/preload.cjs`](file:///scripts/timeout-table/preload.cjs).

---

### Review Findings by Category

#### 1. Production Risk: Timeout Detection & Measurement Fidelity
- **Incomplete path gate enforcement**: The test explicitly verifies that incomplete paths (`AGENT_CHECK_TIMEOUT_MS`, `SIGNAL_READ_TIMEOUT_MS`) are marked `NOT MEASURED` and reject without explicit `--acknowledge-not-measured` flags.
- **Conclusive failure on timeout**: The `timeoutClient` test validates the Round 3 fix: when a client returns `{ error: { code: "check_timeout" } }`, `AGENT_CHECK_TIMEOUT_MS` fails immediately under `FAIL rows:` even when acknowledged in `acknowledgeNotMeasured`. This ensures that a failing check cannot slip through the gate.
- **Silent execution gate**: The `silentClient` fixture verifies that a client process that exits cleanly without generating expected network traffic causes unobserved rows (`channels.ts:timeoutMs`, `files.ts:REQUEST_TIMEOUT_MS`) to be flagged as `NOT MEASURED` rather than falsely passing.
- **No findings (PRODUCTION)**: The tests guard against false passes.

#### 2. Credentials & Safe Execution
- **File & directory permissions**: Profile directory is explicitly set to `0o700` (`mkdir` and `chmod`), and credentials/profile fixtures are written with `0o600` permissions.
- **Isolated loopback origin**: The test fixture sets up a loopback mock server (`127.0.0.1`) and asserts `writes.length === 0`, confirming that measured runs do not post mutations to `/functions/v1/command` or `/functions/v1/activity`.
- **Exit cleanup**: Server resources and temporary directories are registered with `t.after` cleanup hooks.
- **No findings (PRODUCTION)**: No credential leakage or live origin writes.

#### 3. Test Validity & Failure Causality
- **Exit path & error capture**: `noisyClient` writes to `stderr` and exits `7`; the test verifies that `runTable` propagates the child error and preserves `stderr` (`/channel boom/`).
- **Selective row failure**: The `timeoutClient` assertion specifically tests that `AGENT_CHECK_TIMEOUT_MS` fails while unrelated rows like `HOOK_CHECK_TIMEOUT_MS` are not erroneously triggered (`assert.doesNotMatch(message, /HOOK_CHECK_TIMEOUT_MS/)`).
- **Sample count verification**: The test verifies that duration measurements scale with the `runs` argument (`durations.length === 2` for `runs: 2`).
- **No findings (RIGOUR)**: Tests fail for their intended reasons and do not pass vacuously.

#### 4. Commits vs Tree, Docs vs Code
- **Commit history consistency**: Commit sequence [`75f2c8d6`](file:///git/75f2c8d6) through [`9860904b`](file:///git/9860904b) correctly reflects the iterative review folds:
  - `9860904b`: Captures lower-bound check failures on incomplete paths, stdio capture in `runChild`, directory-index enumerator fixes, and listener barrel budgets.
  - `90bec239`: Captures `check_timeout` failing incomplete paths and `SIGNAL_READ_TIMEOUT_MS` unmeasured status.
  - `18241582`, `dcb041c0`, `5758a351`, `a2c60c62`: Ensure zero origin writes, line-independent IDs, exit handlers for temporary profiles/worktrees, and pause timer referencing.
- **No findings (RIGOUR)**: Commit messages align with the code changes and review requirements.

---

VERDICT: PASS (all tests in PART T4b accurately verify timeout failure enforcement, silent client rejection, stderr capture, and origin write prevention without credential leakage)
