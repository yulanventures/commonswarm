### Review of PART T4a (Tests, Fixtures, and Commit Messages — Piece 1 of 2)

#### Dependencies Not in This Part
Because this piece cuts at line 630 of `tests/p1-cli/timeout-table.test.ts`, the following items could not be evaluated here and are deferred to Piece 2 or other review parts:
1. **Piece 2 of PART T4a**: The completion of `test("runTable does not write to the origin and will not PASS unacknowledged NOT MEASURED rows")` from line 631 onward, any subsequent tests/fixtures, and full commit messages.
2. **Implementation Modules**: `scripts/timeout-table/` modules (`enumerate.mjs`, `mapping.mjs`, `run.mjs`, `core.mjs`, `preload.cjs`, `writes.cjs`), which are under review in separate review parts (T1–T3).

---

### Analysis by Area

#### 1. Production Timeout vs. Pass Gate
- **Conclusive Lower Bounds ([`tests/p1-cli/timeout-table.test.ts#L254-L267`](file:///tests/p1-cli/timeout-table.test.ts#L254-L267))**: Validates the Round 3 fix. When an operation is mapped with `measures_guarded_path: false` (an incomplete path) and acknowledged in `acked`, but its measured duration (70 ms on a 100 ms budget) yields headroom $< 2$ ($100 / 70 = 1.43 < 2$), `runStatus` reports `fails: [id]` and `gate: "FAIL"`. An acknowledged incomplete path can never mask a budget overrun that already fails the $2\times$ headroom rule.
- **Zero-duration Headroom ([`tests/p1-cli/timeout-table.test.ts#L268-L270`](file:///tests/p1-cli/timeout-table.test.ts#L268-L270))**: Validates that zero-duration sample sets result in `gate: "PASS"` and `headroom: Infinity`.
- **Enumeration & Import Tracking ([`tests/p1-cli/timeout-table.test.ts#L80-L128`](file:///tests/p1-cli/timeout-table.test.ts#L80-L128), [`L148-L240`](file:///tests/p1-cli/timeout-table.test.ts#L148-L240))**: Validates that timeout defaults, nullish coalescing literals, `as const`, identifier AbortSignals, import aliases, namespace imports, per-block local constants (`turnBudgetMs` and `deliveryHoldBudgetMs`), directory index imports (`./config`), and barrel re-exports (`export * from`) are correctly enumerated and assigned accurate millisecond values without shadowing contamination.
- **Bi-directional Mapping Validation ([`tests/p1-cli/timeout-table.test.ts#L53-L78`](file:///tests/p1-cli/timeout-table.test.ts#L53-L78))**: Exact match validation ensures no timeout site in `v0.1.71`, `HEAD`, or `main` is missing or stale in `mapping.json`, preventing unmapped production timeouts.

#### 2. Credentials and Origin Writes
- **Profile & Credential Permissions ([`tests/p1-cli/timeout-table.test.ts#L456-L485`](file:///tests/p1-cli/timeout-table.test.ts#L456-L485))**: `withPrivateProfile` creates copies in a `0700` temporary directory with file mode `0600`, ensures sibling directory secrets are never copied, strips `expires_at`, handles input profile files named `credential.json` by copying to `profile.json` without collision, and completely unlinks the copy tree on both success and injected failure.
- **Preload Network Redaction ([`tests/p1-cli/timeout-table.test.ts#L356-L454`](file:///tests/p1-cli/timeout-table.test.ts#L356-L454))**: `preload.cjs` rewrites only the target origin. Authorization headers, bodies, tokens, and query strings are never logged to `fetch.jsonl`. Blocked relative `fetch` calls and relative WebSocket URLs (`CONNECT`) strip all query parameters before recording `BLOCKED`.
- **Write Blocking ([`tests/p1-cli/timeout-table.test.ts#L383-L428`](file:///tests/p1-cli/timeout-table.test.ts#L383-L428))**: Mutating requests such as `POST /functions/v1/command` and external origin accesses are blocked by `preload.cjs`, causing the child to fail before reaching the origin.

#### 3. Test Failure & Exit Cleanup Rigour
- **Exit Path Cleanup Fixture ([`tests/p1-cli/timeout-table-exit-fixture.mjs#L1-L44`](file:///tests/p1-cli/timeout-table-exit-fixture.mjs#L1-L44))**: Spawns an isolated process creating a worktree and private profile copy.
  - **Exit 13 ([`tests/p1-cli/timeout-table.test.ts#L560-L571`](file:///tests/p1-cli/timeout-table.test.ts#L560-L571))**: The fixture waits for `${marker}.go`, creates an unreferenced timer (`timer.unref()`), and awaits an unsettled promise. The Node.js event loop drains with an unfinished top-level await, producing exit code 13 as documented by Node.js. Synchronous `process.on('exit')` cleanup removes both the git worktree and temp directory.
  - **Signals ([`tests/p1-cli/timeout-table.test.ts#L573-L622`](file:///tests/p1-cli/timeout-table.test.ts#L573-L622))**: `SIGTERM` (code 143), `SIGHUP` (code 129), and `SIGINT` (code 130) cleanly remove the temporary root and git worktree.
  - **Cleanup Ordering ([`tests/p1-cli/timeout-table.test.ts#L599-L609`](file:///tests/p1-cli/timeout-table.test.ts#L599-L609))**: `finalizeRunResources` explicitly asserts the temp directory is deleted before signal handlers are uninstalled.
- **Line-shift Stability ([`tests/p1-cli/timeout-table.test.ts#L130-L146`](file:///tests/p1-cli/timeout-table.test.ts#L130-L146))**: Pure line-number shifts retain identical inventory IDs (`file:name#ordinal`), verifying the mapping is immune to line drifts.

---

VERDICT: PASS - Tests and fixture in piece 1 provide rigorous coverage of timeout enumeration, mapping validation, headroom failure gates, credential isolation, and exit cleanup without leaking credentials or writes.
