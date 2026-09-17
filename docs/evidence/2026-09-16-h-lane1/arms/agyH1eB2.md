### Independent INVERSION Review — Lane 1 (Part B2 of 6: Baseline Test)

#### External Dependencies Not Inlined
Per instructions for Part B2, the following external files are referenced by `tests/p1-cli/command-dispatch-baseline.test.ts` and are handled in separate review parts:
1. `src/cli.ts` / `src/cli.js` (the converted dispatcher under test).
2. `tests/fixtures/dispatch-trace-preload.mjs` (the IPC handler tracer preload module).
3. `tests/p1-cli/fixtures/command-dispatch-baseline.json` (the 704 baseline rows snapshot).
4. `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json` (baseline count summary snapshot).

---

### Analysis & Verification

1. **Prototype Pollution & Property Shadowing (Round 4 Regressions Resolved)**:
   - **Harness replacement lookup**: `prepareRow` now uses `Object.hasOwn(replacements, value)` (`tests/p1-cli/command-dispatch-baseline.test.ts` line 419). Inherited members of `Object.prototype` (e.g. `toString`, `valueOf`) are no longer replaced with prototype functions during fixture generation.
   - **Prototype verb coverage**: `prototypeVerbFixtures()` explicitly enumerates `Object.getOwnPropertyNames(Object.prototype)` across 3 axes (`plain`, `json`, `profile-valid`), producing 36 dedicated fixtures ensuring prototype-named commands behave identically to main (returning unknown command or supported-by lists without throwing).

2. **Flag-Before-Verb Class Coverage per (Entry, Variant)**:
   - In `selectedErrorFixtures()`, fixtures are generated via `entry.variants.flatMap((variant, variantIndex) => ...)` across all 8 `SELECTED_ERROR_AXES`.
   - All multi-variant entries are comprehensively covered for flags preceding the verb (e.g., `setup` import, version, guide; `check` messages, message, hook; `inbox` read, notify, follow), resolving the rigour gap flagged in Round 4.

3. **Table & Inventory Drift Gates**:
   - `commandEntryCoverage()` parses `AGENT_COMMANDS` when present and asserts `assert.deepEqual(actual, ordered(LEGACY_COMMAND_ENTRY_COVERAGE))`. Any modification to command keys, subcommands, refusal handlers, variants, profile handling, hostSessionId policy, or error modes will fail the suite.
   - Exact counts and row outputs (`exitCode`, `stdout`, `stderr`, and IPC-traced `handlers`) are verified against `expected` and `expectedCounts`.

4. **Normalization & Environment Isolation**:
   - Dynamic origins, temp directories, timestamps, and credential store paths are normalized deterministically.
   - Mock server covers `/auth/v1/token`, `/rest/v1/memberships`, and `/rest/v1/workspaces`, ensuring deterministic network boundaries.

No PRODUCTION or RIGOUR defects were found in this test specification.

VERDICT: PASS
The baseline harness and matrix comprehensively cover all 84 command entries, all variants, prototype verbs, and policy axes without masking dispatcher behavior.
