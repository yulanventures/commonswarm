### D-036 Review — Part T5: Round-4 Fold Commit `d970c354` Alone

**Commit under review**: `d970c3544d6440d5cadcac7cfa7b38dfbb5996af`  
**Author**: Grok (`grok-4.6`)  
**Scope**: Changes in `scripts/timeout-table/enumerate.mjs`, `scripts/timeout-table/run.d.mts`, `scripts/timeout-table/run.mjs`, and `tests/p1-cli/timeout-table.test.ts`. (Documentation/README changes are reviewed in Part T2).

---

### 1. Measurement Fidelity & False PASS Prevention

- **Property Assignment Unit Notes ([`enumerate.mjs:308`](file:///scripts/timeout-table/enumerate.mjs#L308))**:
  - `add(node, name, value)` replaces `add(node.name, name, value)`. Passing the `ts.PropertyAssignment` node rather than the identifier node allows `add` to correctly identify the node type and attach the appropriate unit note (`"numeric timeout property; milliseconds unless the cited API defines another unit"`). This ensures timeout units are not misinterpreted or left ambiguous.
- **Export Star Semantics ([`enumerate.mjs:356-360`](file:///scripts/timeout-table/enumerate.mjs#L356-L360))**:
  - `export * from` now explicitly skips `exportedName === "default"`. Under ECMAScript specifications, star re-exports do not re-export default exports. Previously, default exports could leak through star barrels into consumer imports, causing spurious timeout values to be resolved or mapped.
- **Enforced `--ref` Argument ([`run.mjs:41-43`](file:///scripts/timeout-table/run.mjs#L41-L43))**:
  - `argsOf` now throws `--ref is required` if `ref` is omitted, not a string, empty, or starts with `-`. This eliminates the ambiguity where a run intended for the released client (`v0.1.71`) could silently default to working tree / HEAD budgets.

---

### 2. Credentials, Isolation, and Real Workspace Protection

- **State Directory Isolation ([`run.mjs:58-75`](file:///scripts/timeout-table/run.mjs#L58-L75), [`run.mjs:159-172`](file:///scripts/timeout-table/run.mjs#L159-L172))**:
  - `ISOLATED_STATE_ENV` and `isolatedStateEnv` redirect `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `SWARM_AGENT_STATE_DIR`, `CLAUDE_CONFIG_DIR`, and `GROK_HOME` into subdirectories strictly inside `copy.root`.
  - In `environment(base, copy, log)`, `...isolatedStateEnv(copy.root)` is spread over `process.env`.
  - Because `copy.root` is created inside `tempRoot` with mode `0o700` and cleaned up on all exit paths by `finalizeRunResources`, measurement child processes cannot touch, pollute, or leak secrets into the operator's real agent credential stores or state directories.

---

### 3. Test Validity & Failure Verification

- **Sentinel Verification ([`timeout-table.test.ts:729-792`](file:///tests/p1-cli/timeout-table.test.ts#L729-L792), [`timeout-table.test.ts:855-957`](file:///tests/p1-cli/timeout-table.test.ts#L855-L957))**:
  - Sets parent environment state variables to a dedicated `sentinel` directory containing a marker file.
  - Spawns child operations that initialize `agentCredentialStore` and secure state directories.
  - Asserts that all returned state paths reside inside `copyRoot`, and verifies via `find` that the sentinel directory remains completely untouched (`[sentinel, sentinel/MARKER]`).
  - Re-verifies sentinel cleanliness around full multi-client `runTable` executions.
- **Star Re-Export Test ([`timeout-table.test.ts:239-258`](file:///tests/p1-cli/timeout-table.test.ts#L239-L258))**:
  - Tests a barrel with `export *` from a module having both a named constant and a default export. Confirms that only the named export resolves and default export does not bleed through.
- **Property Unit Note Test ([`timeout-table.test.ts:260-267`](file:///tests/p1-cli/timeout-table.test.ts#L260-L267))**:
  - Tests `{ timeout: 1500 }` to verify presence of value and expected unit note text.
- **`--ref` Argument Parsing ([`timeout-table.test.ts:270-285`](file:///tests/p1-cli/timeout-table.test.ts#L270-L285))**:
  - Verifies throws on missing and empty `--ref`, and verifies correct behavior of `sourceRefForRun`.

---

### 4. Code & Commit Consistency; Dependencies

- **[RIGOUR] External Dependency — `--ref main` Mapping Section**:
  - **File:Line**: [`scripts/timeout-table/run.mjs:50-55`](file:///scripts/timeout-table/run.mjs#L50-L55), [`scripts/timeout-table/run.mjs:289-291`](file:///scripts/timeout-table/run.mjs#L289-L291)
  - **Concrete Sequence**: In `run.mjs`, `sourceRefForRun("main")` returns `null` so `sourceRef` refers to the working tree. However, `runTable` passes `options.ref` directly to `validateMapping(inventory, mappingFile, options.ref)` and `mappingForRef(mappingFile, options.ref)`. The docstring at line 50 states: `"HEAD and main are the working tree plus the HEAD mapping section."`
  - **Observation**: For `--ref main` to succeed, `mappingForRef` in `scripts/timeout-table/mapping.mjs` must alias `"main"` to `"HEAD"` (or `mapping.json` must provide a `"main"` key). Because `mapping.mjs` is outside commit `d970c354`, this dependency cannot be verified within this part call. Programmatic and CLI runs passing `--ref HEAD` or `--ref v0.1.71` are unaffected.

---

VERDICT: PASS Commit d970c354 successfully isolates all client credential and state directories to the private copy root, enforces `--ref`, fixes `export *` default re-export leakage, preserves property assignment unit notes, and adds rigorous sentinel regression tests.
