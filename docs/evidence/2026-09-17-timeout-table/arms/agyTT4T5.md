### Scope & Dependencies
This review covers **PART T5**: commit `9860904bf800334ea4654666cbe31e12b1c9faee` alone.
- **Dependencies not checked here**:
  - `scripts/timeout-table/mapping.json` (reviewed in Part T2)
  - `scripts/timeout-table/README.md` (reviewed in Part T3)

---

### Production & Rigour Review

#### 1. Table Gate & Measurement Integrity
- **Conclusive lower bound for incomplete paths** ([`core.mjs:26-32`](file:///scripts/timeout-table/core.mjs#L26-L32), [`run.mjs:209-214`](file:///scripts/timeout-table/run.mjs#L209-L214)):
  - Previously, an acknowledged `NOT MEASURED` row could have a measured partial p95 that already consumed more than half the timeout budget (`headroom < 2`), yet exit 0 because the acknowledgement masked it.
  - In `9860904b`, `headroom !== null && headroom < 2` evaluates before `options.notMeasured`. If the measured lower bound already violates the 2× headroom requirement, the row unconditionally receives `gate = "FAIL"`.
  - In [`runStatus`](file:///scripts/timeout-table/run.mjs#L209-L214), `fails` records the row, and `extra` filters out rows present in `fails` (`!fails.includes(id)`), ensuring the run fails explicitly with the failed timeout row rather than an acknowledgement error.
- **Per-scope constant bindings** ([`enumerate.mjs:164-180`](file:///scripts/timeout-table/enumerate.mjs#L164-L180), [`264-319`](file:///scripts/timeout-table/enumerate.mjs#L264-L319)):
  - Module-level constants are isolated from function blocks. Each `Block`, `ModuleBlock`, or `SourceFile` constructs its own scoped lexical map (`bindingsFromStatements(child.statements, constants)`). Multiple functions declaring their own local `const TIMEOUT_MS` now resolve independently without cross-function shadowing or contamination.
- **Barrel and index imports** ([`enumerate.mjs:206-214`](file:///scripts/timeout-table/enumerate.mjs#L206-L214), [`348-360`](file:///scripts/timeout-table/enumerate.mjs#L348-L360)):
  - `resolveImportedFile` now inspects directory index candidates (`index.ts`, `index.tsx`, `index.astro`).
  - `enumerateRepository` handles wildcard exports (`export * from ...` where `!stmt.exportClause`). It iterates through numeric constants matching `${fromFile}:` and exports them under `${file.path}:<name>`, allowing re-exported constants like `src/cli.ts:turnBudgetMs` and `deliveryHoldBudgetMs` (via `LISTENER_PROMPT_TIMEOUT_MS`) to be resolved.
- **Zero-duration measurements** ([`core.mjs:17-18`](file:///scripts/timeout-table/core.mjs#L17-L18), [`run.mjs:176-180`](file:///scripts/timeout-table/run.mjs#L176-L180)):
  - `p95 === 0` is recognized as a completed run with `headroom = Infinity` rather than `null`. It gates as `PASS` and formats as `∞` instead of falsely reporting `NOT RUN`.
- **Operation validation** ([`mapping.mjs:44-45`](file:///scripts/timeout-table/mapping.mjs#L44-L45)):
  - `validateMapping` now requires `entry.operation.name` to be a non-empty string, preventing anonymous operations.

#### 2. Credential Protection & Exit Cleanup
- **Profile naming collision fix** ([`core.mjs:57-61`](file:///scripts/timeout-table/core.mjs#L57-L61)):
  - When the source profile path is named `credential.json`, the destination file in the 0700 temporary directory is copied as `profile.json`. This avoids clobbering `copyDirectory/credential.json` where the agent credential file is staged.
- **URL query parameter redaction** ([`preload.cjs:35-47`](file:///scripts/timeout-table/preload.cjs#L35-L47), [`65-68`](file:///scripts/timeout-table/preload.cjs#L65-L68), [`103-106`](file:///scripts/timeout-table/preload.cjs#L103-L106)):
  - `pathOnly(raw)` parses input against a dummy base (`http://timeout-table.invalid`) to safely extract `url.pathname`. If parsing fails, it strips query (`?`) and hash (`#`) delimiters. Blocked requests (relative fetch or WebSocket) log only the sanitized pathname, preventing credentials or tokens in query strings from entering disk logs.
- **Cleanup sequencing** ([`run.mjs:81-87`](file:///scripts/timeout-table/run.mjs#L81-L87), [`367-371`](file:///scripts/timeout-table/run.mjs#L367-L371)):
  - `finalizeRunResources(resources, uninstallSignals)` invokes `cleanupRunResourcesSync(resources)` inside `try` and uninstalls signal handlers in `finally`. Temporary directories and credentials are deleted before signal handlers are deregistered.
- **Child process stdio** ([`core.mjs:106`](file:///scripts/timeout-table/core.mjs#L106)):
  - Stdio is set to `["ignore", "pipe", "pipe"]`, capturing child process output in memory rather than leaking raw output to terminal streams.

#### 3. Test Coverage & Failure Fidelity
- All 12 targeted scenarios in [`tests/p1-cli/timeout-table.test.ts`](file:///tests/p1-cli/timeout-table.test.ts) fail predictably if their corresponding fixes are reverted:
  - Line-level validation for `cli.ts:turnBudgetMs` and `deliveryHoldBudgetMs`.
  - Block-scoped resolution for distinct local constants across functions.
  - Directory index and `export * from` resolution.
  - Rejection of insufficient headroom (`headroom < 2`) on acknowledged rows.
  - Zero-duration measurements passing with infinite headroom.
  - Operation name requirement in mapping validation.
  - Query parameter redaction for blocked relative fetch and WebSocket calls.
  - Prevention of profile overwrite when named `credential.json`.
  - Deterministic temp root removal before signal uninstallation.

---

### Findings

#### [RIGOUR] `scripts/timeout-table/enumerate.mjs:351-356`: `export * from` re-exports `default`
- **File & Line**: [`scripts/timeout-table/enumerate.mjs:351-356`](file:///scripts/timeout-table/enumerate.mjs#L351-L356)
- **Concrete Sequence**:
  In `enumerateRepository`, wildcard export processing matches all entries beginning with `${fromFile}:`:
  ```javascript
  const prefix = `${fromFile}:`;
  for (const [key, value] of exportValues) {
    if (typeof value === "number" && key.startsWith(prefix)) {
      nextExports.set(`${file.path}:${key.slice(prefix.length)}`, value);
    }
  }
  ```
  If a module exports a default numeric timeout constant (`nextExports.set(`${file.path}:default`, value)`), a barrel with `export * from "./mod"` will match `${fromFile}:default` and set `${barrel.path}:default`. In ES module specification semantics, `export * from` does not re-export the `default` export.
- **Operator/Production Impact**:
  Harmless in practice: CommonSwarm timeout constants are named exports (e.g. `LISTENER_PROMPT_TIMEOUT_MS`), and the TypeScript compiler rejects `import default` from an `export *` barrel at build time.

---

VERDICT: PASS Commit 9860904b correctly closes the Round 3 gate bypass by enforcing conclusive lower-bound failure on incomplete paths, protects query credentials in blocked requests, prevents profile copy collisions, scopes AST constants per block, and ensures cleanup precedes signal deregistration.
