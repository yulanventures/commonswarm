### Dependencies Not Checked in Part T4a
The following files and objects are part of separate review chunks and could not be checked directly in this piece:
1. `tests/p1-cli/timeout-table.test.ts` (lines 483–957, piece 2, including the sentinel tests for `ISOLATED_STATE_ENV` / `isolatedStateEnv` and remaining signal/run tests).
2. Git commit objects and messages (`75f2c8d6`, `502ac8cf`, `8bfbfd3d`, `a2c60c62`, `5758a351`, `dcb041c0`, `9860904b`, `d970c354`).
3. Implementation files under [`scripts/timeout-table/`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/scripts/timeout-table): `core.mjs`, `run.mjs`, `enumerate.mjs`, `mapping.mjs`, `preload.cjs`, `writes.cjs`, and `mapping.json`.

---

### Review Findings

#### 1. Timeout Coverage, Unit Integrity, and Budget Accounting
- **PASS vs. Client Timeout:**
  - In [`tests/p1-cli/timeout-table.test.ts#L86-L126`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L86-L126), timeout inventories and mappings are checked against both `v0.1.71` and `HEAD`/`main`. Derived constants, second-to-millisecond units (`HOST_HOOK_TIMEOUT_SECONDS`), parameter defaults (`timeoutMs = 30_000`), nullish coalescing literals (`options.timeoutMs ?? 15_000`), `as const` definitions, and import/re-export aliases are all verified against actual values.
  - The AST test verifies that `export * from` does not re-export default exports ([`timeout-table.test.ts#L208-L224`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L208-L224)), preventing unresolved default fallback values from polluting timeout inventories.
  - In [`tests/p1-cli/timeout-table.test.ts#L268-L300`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L268-L300), duration measurement includes body streaming (`duration_ms >= 100` when body completes at 120 ms), ensuring the gate measures the full end-to-end request rather than just TTFB.
  - Percentile and gating math correctly fails rows exceeding half the budget (`p95 * 2 > budget`) and rows with any real timeout (`realTimeouts > 0`), while allowing 0-duration runs with infinite headroom (`headroom: Infinity`).
  - Unacknowledged operations marked with `measures_guarded_path: false` correctly fail the gate (`gate: FAIL` / `missing: [id]`).

#### 2. Credentials and Isolation
- **Profile and Credential Protections:**
  - In [`tests/p1-cli/timeout-table.test.ts#L328-L365`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L328-L365), private profile copies enforce directory mode `0o700` and file mode `0o600`.
  - Credentials stripped of `expires_at` prevent automatic refresh writes. Sibling secrets in profile directories are excluded.
  - Origin writes (`POST /functions/v1/command`) and foreign origin requests are strictly intercepted and blocked by `preload.cjs` ([`timeout-table.test.ts#L292-L305`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L292-L305)).
  - Preload logs redact tokens, headers, queries, and bodies across HTTP and WebSocket paths ([`timeout-table.test.ts#L254-L265`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L254-L265), [`#L307-L325`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L307-L325)).

#### 3. Test Failure Modes and Assertions
- **Exit Path Cleanup Tests:**
  - [`tests/p1-cli/timeout-table.test.ts#L446-L482`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L446-L482) tests both unexpected `exit 13` (unsettled top-level await) and `SIGTERM`. In both cases, the fixture verifies that artifacts and git worktrees are present prior to exit (`assertArtifactsPresent`), and that after process exit, the worktree is unregistered and temp directories are cleanly removed (`assertArtifactsGone`). If cleanup hooks fail on either path, the test fails.
- **Line-Shift Invariance:**
  - [`tests/p1-cli/timeout-table.test.ts#L128-L146`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L128-L146) verifies that shifting file contents downward changes line numbers but leaves ordinal IDs (`file:name#ordinal`) identical.
- **Exact Per-Ref Mapping:**
  - [`tests/p1-cli/timeout-table.test.ts#L54-L85`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table.test.ts#L54-L85) asserts bijection between enumerated timeouts and mappings for each ref (`v0.1.71`, `HEAD`, `main`), proving that adding a stale row or omitting an existing row throws `/stale=/` or `/missing=/`.

#### 4. Observations

[RIGOUR] [`tests/p1-cli/timeout-table-exit-fixture.mjs:33-41`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/timeout-table-exit-fixture.mjs#L33-L41)
- **Concrete sequence:** In `exit13` mode, the fixture enters an infinite polling loop `while (true) { try { await stat(go); break; } catch { await new Promise(r => setTimeout(r, 15)); } }` waiting for `${marker}.go`.
- **Operator/Production visibility:** If the parent process crashes before creating `${marker}.go`, the fixture child process relies entirely on the parent's outer 20-second watchdog timer (`killTimer`) for termination rather than an internal timeout. Because this fixture is only spawned by test harnesses that install this watchdog timer and clean up child processes on exit, this does not affect production or leak test resources.

---

VERDICT: PASS Part T4a tests and fixtures robustly validate timeout enumeration, mapping bijection, signal and unhandled-exit cleanups, credential isolation, and duration measurements without security regressions.
