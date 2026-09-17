### Review of `lane/timeout-table` (SHA `d970c3544d6440d5cadcac7cfa7b38dfbb5996af`) — Part T1a

#### External Dependencies (Unchecked in Part T1a)
The following dependencies belong to subsequent parts and could not be evaluated directly within this part:
1. `scripts/timeout-table/writes.cjs`: Required by `preload.cjs` (`originWriteKind`).
2. `scripts/timeout-table/run.mjs`: Implementation of `run.d.mts` (cut off at line boundary, provided in Part T1b).
3. `scripts/timeout-table/mapping.json`: Mapping table entries for `HEAD` and `v0.1.71`.
4. Test suites: `scripts/timeout-table/__tests__/*`.

---

### Detailed Findings & Analysis

#### 1. Timeout Measurement & Gate Calculations (PRODUCTION)
- **Percentile Calculation** ([`core.mjs:7-11`](file:///scripts/timeout-table/core.mjs#L7-L11)):
  `percentile(values, 0.95)` uses nearest-rank indexing `sorted[Math.ceil(quantile * sorted.length) - 1]`. For $N = 20$, $0.95 \times 20 = 19$, selecting index 18 (the 19th sample, 2nd highest). For $N = 20$ at $q = 0.50$, it selects index 9 (10th sample). This matches standard gate definitions.
- **Gate Evaluation** ([`core.mjs:13-34`](file:///scripts/timeout-table/core.mjs#L13-L34)):
  - Gate precedence correctly handles terminal states: `notNetwork` ("NOT NETWORK") $\to$ `notRun` ("NOT RUN") $\to$ `realTimeouts > 0` ("FAIL") $\to$ `headroom < 2` ("FAIL") $\to$ `notMeasured` ("NOT MEASURED") $\to$ `headroom === null` ("NOT RUN") $\to$ "PASS".
  - If a measured partial lower bound already exceeds half the budget ($headroom < 2$), it decisively fails even if flagged as `notMeasured`.
  - A proxy `notRun` row returns `"NOT RUN"` before evaluating `realTimeouts`, preventing unintended FAIL inheritance.
- **Unit Normalization & Ingestion** ([`enumerate.mjs:129-150`](file:///scripts/timeout-table/enumerate.mjs#L129-L150)):
  - Timeouts ending in `_SECONDS`, `_SECS`, `_SEC`, `_S` (with underscore boundary) and `connect_timeout` are multiplied by 1,000 to normalize to milliseconds.
  - Millisecond identifiers (`_MS`, `timeoutMs`) preserve raw values.
  - Special cloud overrides (`src/cloud/agent-receive.ts`, `src/cloud/seed.ts`) convert second budgets to milliseconds. Non-time budgets (`_BYTES`, `_CHARS`, `_PER_MINUTE_BUDGET`, etc.) are retained with descriptive unit notes.
  - Object property timeouts `{ timeout: N }` retain the explicit unit note `"numeric timeout property; milliseconds unless the cited API defines another unit"`.
- **AST Constant & Import Resolution** ([`enumerate.mjs:206-258, 333-380`](file:///scripts/timeout-table/enumerate.mjs#L206-L258)):
  - Re-exports and imports (default, named, namespace, and renamed imports) are resolved over 5 fixed-point iterations across client source files.
  - `export * from` explicitly excludes `"default"` export ([`enumerate.mjs:365-366`](file:///scripts/timeout-table/enumerate.mjs#L365-L366)), correctly matching ES module re-export semantics.

#### 2. Credentials & Isolation (PRODUCTION)
- **Profile & Credential Copying** ([`core.mjs:36-93`](file:///scripts/timeout-table/core.mjs#L36-L93)):
  - Mode `0700` is strictly enforced on `root` and `copyDirectory`. Mode `0600` is enforced on copied profile and credential files via `chmod` and exclusive creation (`flag: "wx"`).
  - Symlinks for profile and credential sources are rejected via `lstat().isSymbolicLink()`.
  - Durable credential renewal suppression: `expires_at` is safely stripped from JSON credentials ([`core.mjs:73-76`](file:///scripts/timeout-table/core.mjs#L73-L76)), preventing token renewal from superseding the operator's live credential.
  - Cleanup guaranteed: `makePrivateProfileCopy` cleans up on failure in `catch`, and `withPrivateProfile` executes cleanup in `finally`.
- **Preload Interception & Leak Prevention** ([`preload.cjs:18-58`](file:///scripts/timeout-table/preload.cjs#L18-L58)):
  - Origin rewrite: Any request targeting an origin other than the configured profile origin or base URL is blocked and throws immediately.
  - Safe audit log: `record()` logs only `{ method, path, status, duration_ms }` with file mode `0600`. Request/response headers, auth tokens, bodies, query parameters, and original origins are excluded from logs.
  - Process arguments: `probe.mjs` and child invocations pass only file paths to the copy directory, never embedding credentials in `process.argv` (hidden from `ps`).

#### 3. Test Alignment & Id Invariance (RIGOUR)
- **Id Generation** ([`enumerate.mjs:268-275`](file:///scripts/timeout-table/enumerate.mjs#L268-L275)):
  - IDs are constructed as `${file}:${name}` or `${file}:${name}#${occurrence}` based on AST occurrence order without embedding line numbers. Line shifts do not alter IDs or invalidate mapping entries.
- **Mapping Verification** ([`mapping.mjs:25-57`](file:///scripts/timeout-table/mapping.mjs#L25-L57)):
  - `validateMapping` checks bidirectional mapping parity against the exact ref inventory (`missing` and `stale` sets). Measuring a ref against another ref's mapping section immediately fails validation.

---

### Findings

- **[RIGOUR] `enumerate.mjs:393`**: Direct CLI execution guard comparison
  - **File:Line**: [`scripts/timeout-table/enumerate.mjs:393`](file:///scripts/timeout-table/enumerate.mjs#L393)
  - **Sequence**: `if (import.meta.url === \`file://${process.argv[1]}\`)` compares `import.meta.url` (which is a file URL with URL encoding, e.g. `%20` for spaces) directly against `file://${process.argv[1]}` (which contains unencoded raw paths, and on Windows could lack leading slashes).
  - **Impact**: In environments where paths contain special characters or spaces, running `node scripts/timeout-table/enumerate.mjs` directly via CLI would not trigger the execution block. When invoked as a module (as in `run.mjs` and the test suite via `enumerateRepository`), this block is bypassed and does not affect production gate execution.

---

VERDICT: PASS Part T1a tool code satisfies all production safety, credential isolation, AST resolution, and gate math requirements.
