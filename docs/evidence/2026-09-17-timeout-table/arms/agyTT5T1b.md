### Dependencies Outside PART T1b

PART T1b contains the implementation of `scripts/timeout-table/run.mjs` and `scripts/timeout-table/source-check.ts` alongside the declarations for `run.mjs`. Dependencies defined in companion files that cannot be directly inspected in this piece include:
- `scripts/timeout-table/enumerate.mjs` (`enumerateRepository`)
- `scripts/timeout-table/mapping.mjs` (`mappingForRef`, `validateMapping`)
- `scripts/timeout-table/core.mjs` (`clientInvocation`, `makePrivateProfileCopy`, `percentile`, `readJsonLines`, `runChild`, `summarize`)
- `scripts/timeout-table/writes.cjs` (`originWriteKind`, `describeOriginWriteRules`)
- `scripts/timeout-table/probe.mjs`
- `scripts/timeout-table/preload.cjs`
- `scripts/timeout-table/source-signal-read.ts`
- `scripts/timeout-table/mapping.json`

---

### Review Findings

#### 1. Production Timing & Measurement Integrity

- **Ref Isolation & Mapping Validity**: [`run.mjs:27-43`](file:///scripts/timeout-table/run.mjs#L27-L43) enforces that `--ref` is mandatory. [`sourceRefForRun`](file:///scripts/timeout-table/run.mjs#L51-L55) returns `null` for `HEAD` or `main` (direct working-tree execution) and the git ref string for any other revision. [`sourceRootForRef`](file:///scripts/timeout-table/run.mjs#L137-L149) verifies the commit revision via `git rev-parse`, creates an isolated detached worktree under `tempRoot/source-ref`, symlinks `node_modules`, and records the realpath for cleanup. [`validateMapping`](file:///scripts/timeout-table/run.mjs#L295) and [`mappingForRef`](file:///scripts/timeout-table/run.mjs#L296) validate and select the mapping specific to the measured ref, preventing any cross-ref mapping bleed.
- **Budget Integrity & Unit Handling**: [`markdownReport`](file:///scripts/timeout-table/run.mjs#L275) renders `raw` for `non-time` units and `ms` for time-based budgets. Unmapped sites fail [`validateMapping`](file:///scripts/timeout-table/run.mjs#L295) and [`mapping lacks`](file:///scripts/timeout-table/run.mjs#L305).
- **Operation Path Guarding**: [`rowSummary`](file:///scripts/timeout-table/run.mjs#L219-L230) marks rows as `NOT MEASURED` if `measures_guarded_path === false` and samples exist, or if an operation was attempted without samples (`attemptedWithoutSample`). These require explicit `--acknowledge-not-measured` flags to avoid failing the run in [`runStatus`](file:///scripts/timeout-table/run.mjs#L244-L246).
- **Warm-Cache & Connection Reuse Bias Mitigation**: Child processes are executed individually via [`runChild`](file:///scripts/timeout-table/run.mjs#L177-L195), preventing in-memory HTTP connection reuse between iterations. For `check`, [`run.mjs:341-348`](file:///scripts/timeout-table/run.mjs#L341-L348) runs `check-uncapped` prior to the real client check to prevent connection warming from biasing the p95 sample. Real client timeouts are captured from exit output and directly fed to `summarize`.

**RIGOUR Finding**: Sample Size Dilution on Intermittent Endpoint Filter Match
- **file:line**: [`scripts/timeout-table/run.mjs:358-360`](file:///scripts/timeout-table/run.mjs#L358-L360)
- **Concrete Sequence**: For an endpoint-scoped operation (`scope !== "whole-operation"` and not `check`/`signal-read`), if `oneOperation` exits 0 but `operationEndpointRows` yields `requests.length === 0` on some (but not all) of the 20 runs, `durations.push` is omitted for those iterations. `durations.length` becomes less than `options.runs`. Because `attemptedWithoutSample` only evaluates `durations.length === 0`, `summarize` evaluates p95 over fewer than 20 samples without flagging a sample shortage.
- **Operator/Production Impact**: An operation intermittently skipping its target endpoint would calculate headroom over a reduced sample size rather than reporting an incomplete run.

---

#### 2. Credential Handling & Origin Write Protections

- **Directory Permissions**: [`run.mjs:297-300`](file:///scripts/timeout-table/run.mjs#L297-L300) creates `tempRoot` via `mkdtemp` and immediately applies `chmod 0o700`. The fetch log `fetch.jsonl` is created with mode `0o600`.
- **Exit Path Resource Cleanup**: [`cleanupRunResourcesSync`](file:///scripts/timeout-table/run.mjs#L86-L110) removes the detached git worktree via `git worktree remove --force` using the resolved `realpathSync` path, followed by `rmSync(tempRoot, { recursive: true, force: true })`. Registered via [`installRunResourceCleanup`](file:///scripts/timeout-table/run.mjs#L120-L135) across `exit`, `SIGINT` (130), `SIGTERM` (143), and `SIGHUP` (129), and invoked synchronously in [`runTable`](file:///scripts/timeout-table/run.mjs#L389) inside `finally { finalizeRunResources(...) }`.
- **Argv & Table Leakage**: In [`cliArgs`](file:///scripts/timeout-table/run.mjs#L151-L157), credentials are passed via `--agent-token-file <file>` and `--profile <file>`, passing file paths in the `0700` temporary tree rather than raw secret values in `argv`. [`markdownReport`](file:///scripts/timeout-table/run.mjs#L260-L287) renders only constant IDs, lines, budgets, scopes, endpoints, operations, run counts, timings, headroom, gates, and exit codes—no tokens or profile credentials appear in stdout or markdown files.
- **Origin Writes Protection**: [`assertNoOriginWrites`](file:///scripts/timeout-table/run.mjs#L249-L258) inspects each newly recorded request from `fetch.jsonl`. Any write method or blocked status (`row.status === "BLOCKED"`) immediately throws, preventing mutations from being committed to the origin.

**RIGOUR Finding**: Startup Benchmark Process Environment Isolation
- **file:line**: [`scripts/timeout-table/run.mjs:316`](file:///scripts/timeout-table/run.mjs#L316)
- **Concrete Sequence**: In [`runTable`](file:///scripts/timeout-table/run.mjs#L316), the client startup benchmark runs `clientInvocation(options.client, ["--version"])` with `{ env: process.env }`, passing the parent's unisolated `XDG_STATE_HOME`, `SWARM_AGENT_STATE_DIR`, and `HOME`.
- **Operator/Production Impact**: While released versions of `cswarm --version` exit before touching credential stores, executing `--version` under `process.env` rather than `{ ...process.env, ...isolatedStateEnv(copy.root) }` creates a potential surface where an unexpected client startup script could read or touch operator state directories.

---

#### 3. Test Failure & Verification Accuracy

- **Exit-Path Cleanup**: Verified by `installRunResourceCleanup` and `cleanupRunResourcesSync`. Tests asserting resource cleanup on normal completion or signal termination fail if directory handles or git worktrees remain.
- **Line-Shift Resistant IDs**: IDs use canonical `file:name#ordinal` identifiers rather than brittle source line numbers.
- **Per-Ref Mapping Enforcement**: Enforced by [`validateMapping`](file:///scripts/timeout-table/run.mjs#L295) and [`mappingForRef`](file:///scripts/timeout-table/run.mjs#L296) using the verified git ref.

---

#### 4. Tree, Commits, and Source Helpers

- [`source-check.ts:1-15`](file:///scripts/timeout-table/source-check.ts#L1-L15) correctly isolates `checkAgentMessages` with an uncapped timeout (`timeoutMs: Number(timeoutText)`), executes via `pathToFileURL` against the specified `sourceRoot`, and outputs JSON duration statistics on stdout for consumption by `run.mjs`.

---

VERDICT: PASS
