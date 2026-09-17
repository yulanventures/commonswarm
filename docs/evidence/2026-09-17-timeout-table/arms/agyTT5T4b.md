### Review of PART T4b: Tests, Fixtures, and Commit Messages (Piece 2 of 2)

#### 1. Production Gate & Timeout Measurement Verification
- **Rejection of Unacknowledged NOT MEASURED Rows**: In `test("runTable does not write to the origin and will not PASS unacknowledged NOT MEASURED rows")`, calling `runTable` with unmeasured rows (`checkId`, `signalId`) and an empty `acknowledgeNotMeasured: []` rejects with `/NOT MEASURED without --acknowledge-not-measured/`. It cannot silently report `PASS`.
- **Client Timeout Detection**: The `timeoutClient` test verifies that when the client emits `check_timeout` (exit 1), `runTable` rejects with `/FAIL rows: .*AGENT_CHECK_TIMEOUT_MS/` while correctly not failing unrelated rows (`assert.doesNotMatch(message, /HOOK_CHECK_TIMEOUT_MS/)`).
- **Silent Client Handling**: When `silentClient` exits without executing network operations, unexercised rows (`channelId`, `REQUEST_TIMEOUT_MS`) transition to `NOT MEASURED` rather than `PASS`, and reject unless explicitly acknowledged.
- **No Writes to Origin**: The mock server records any `POST /functions/v1/command` and `POST /functions/v1/activity` into `writes`. Across all measurement runs, `assert.equal(writes.length, 0)` verifies that measured operations perform read-only operations against the target origin.

---

#### 2. Credentials & Isolation Verification
- **Exit Path Artifact Deletion**:
  - `SIGHUP` test: Spawns the exit fixture, asserts artifacts present, sends `SIGHUP`, checks that the child handled the signal cleanly (`signal === null`, `code === 129`), verifies artifacts are gone via `assertArtifactsGone`, and verifies the source credential remains unmodified.
  - `SIGINT` test: Mirrors the `SIGHUP` test for `SIGINT` (`code === 130`).
  - `finalizeRunResources` test: Verifies that `finalizeRunResources` deletes `tempRoot` *before* executing the signal uninstallation callback (`existsSync(tempRoot) === false` inside the callback), preventing a race condition where a signal arriving during cleanup could leave private credentials on disk.
- **Sentinel State Directory Isolation**:
  - `test("measurement children do not create or change parent state directories")` redirects all 9 `ISOLATED_STATE_ENV` variables (`CLAUDE_CONFIG_DIR`, `GROK_HOME`, `HOME`, `SWARM_AGENT_STATE_DIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`) to a sentinel directory containing only `MARKER`.
  - Spawns a child executing `agentCredentialStore` with locking, `defaultListenerStateDirectory`, and `ensureSecureStateDirectory`.
  - Verifies that all reported paths reside in `copyRoot` and that `find sentinel` reveals no created files or directories besides `MARKER`.
  - `test("runTable does not write to the origin...")` repeats this sentinel check across all `runTable` invocations, proving that measurement runs never pollute or write to the operator's real configuration or credential stores.
- **File Modes**: Private profile source directory is created with `0o700` and credential/profile files with `0o600`.

---

#### 3. Test Failure Fidelity (Can Tests Fail for the Reason They Claim?)
- **Signal tests (`SIGHUP`, `SIGINT`)**: If the exit handlers do not invoke cleanup or fail to terminate with standard signal exit codes (129, 130), `assert.equal(code, ...)` or `assertArtifactsGone` will fail.
- **`finalizeRunResources`**: If cleanup order is inverted (uninstalling signal handlers before deleting files), `assert.equal(existsSync(tempRoot), false)` fails with `"temp root still present at uninstall"`.
- **Sentinel tests**: If any internal CLI path references an unisolated environment variable or falls back to parent state, files created in `sentinel` cause `assert.deepEqual(listed, [sentinel, join(sentinel, "MARKER")])` to fail.
- **`runTable` error propagation**: If a child emits stderr and non-zero exit (`noisyClient`), `runTable` properly rejects with `/channel boom/`.

---

#### 4. Commits vs Code
- Commit `d970c354` accurately documents the round 4 folds:
  - Enforcing isolation across `HOME`, `XDG_*`, `SWARM_AGENT_STATE_DIR`, `CLAUDE_CONFIG_DIR`, and `GROK_HOME`.
  - Requiring `--ref`.
  - Skipping `default` on `export *`.
  - Preserving unit notes on `{ timeout: N }` nodes.
- Earlier commits (`9860904b`, `90bec239`, `18241582`, `dcb041c0`, `5758a351`, `a2c60c62`) accurately correspond to the evolutionary requirements established across rounds 1–4.

---

#### Dependencies Not Checked in this Part (Part T4a / Piece 1)
As this hunk is Piece 2 of 2 (tests and commit messages), the following external symbols defined in Piece 1 or imported helpers are assumed present and verified by their respective parts:
- `spawnExitFixture`, `waitForFile`, `assertArtifactsPresent`, `assertArtifactsGone`, `ExitPaths`
- `finalizeRunResources` implementation details
- `ISOLATED_STATE_ENV`, `isolatedStateEnv`, `environment`, `runChild`
- `AGENT_CREDENTIAL_MESSAGE_D088`
- `runTable` implementation and line-shift/per-ref inventory tests

---

#### Findings
- **RIGOUR**: In `test("runTable does not write to the origin and will not PASS unacknowledged NOT MEASURED rows")`, the mock origin server asserts zero POST writes to `/functions/v1/command` and `/functions/v1/activity`. Other endpoints return `{}`. This matches the production requirement that timeout benchmarking does not issue state-modifying command/activity mutations against the target workspace.

No blocking production or rigour defects found in this chunk.

VERDICT: PASS Part T4b tests, fixtures, and commit history correctly enforce state directory isolation, verified signal exit cleanup, origin write prevention, and failure gating on unacknowledged or timed-out rows.
