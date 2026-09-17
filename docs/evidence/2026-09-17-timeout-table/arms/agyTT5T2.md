### D-036 Review: Part T2 (`scripts/timeout-table/README.md`)
**Target Commit:** `d970c3544d6440d5cadcac7cfa7b38dfbb5996af` on `main` `a6103088eb263f62fae440d404c3268c7b224194`  
**Scope:** Review of documentation, operational specifications, mutation controls, and historical review rulings in [`scripts/timeout-table/README.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/scripts/timeout-table/README.md).

---

### External Dependencies Not Checked in this Part
Per instructions, this evaluation covers Part T2 (`README.md`). The following dependencies are evaluated in separate parts and cannot be independently executed or inspected here:
- **Part T1 (`run.mjs`, `preload.cjs`):** Implementation of environment scrubbing (`HOME`, `XDG_*`, `SWARM_AGENT_STATE_DIR`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`), loopback origin rewriting, write assertions (`assertNoOriginWrites`), synchronous signal cleanup, and stream body consumption.
- **Part T3 (`mapping.json`):** Full inventory mappings, proxy operation definitions, and `measures_guarded_path` boolean flags for `v0.1.71` and `HEAD`.
- **Part T4 (`tests/p1-cli/timeout-table.test.ts`):** Execution of the 15 test suites and verification of the 20 mutation control test fixtures.
- **Part T5 (`enumerate.mjs`):** TypeScript compiler API AST traversal, lexical scoping of constants, line-independent ID ordinal generation, and unit normalization.

---

### Analysis

#### 1. Production Latency, Timing Semantics, and Gate Soundness
- **Gate Logic & Partial Paths (lines 5, 45–48, 59–60, 130):** The documentation accurately defines that any operation with `measures_guarded_path: false` defaults to `NOT MEASURED`, requiring explicit inclusion in `--acknowledge-not-measured` to exit cleanly. Furthermore, it specifies the lower-bound failure rule: if an incomplete path already exhibits a $p95 > \text{budget} / 2$ (i.e. headroom $< 2$), or if the real client invocation produces a `check_timeout` code, the gate reports `FAIL` and fails the process regardless of acknowledgement.
- **Per-Request vs Whole-Operation Scopes (lines 66–70):** Clearly specifies that per-request scopes evaluate durations inclusive of cloned response bodies and never fall back to process wall time if matching endpoints are absent from the log.
- **Sampling & Percentile Method (lines 35, 71, 128):** Explicitly states nearest-rank $p95$ of 20 samples (19th sorted value; slowest sample dropped). Explicitly warns that 20 sequential runs with a 500 ms pause constitute a warm-window measurement and do not guarantee cold-start or extreme-tail latency.
- **Ref Isolation (lines 21, 35, 88):** Mandating `--ref` (with no default) prevents cross-ref mapping or applying HEAD budgets to a shipped release client.

#### 2. Credential Security & Origin Write Prevention
- **Private Copy & Sandboxing (lines 21, 55):** Documents the `0700` temporary directory, `0600` file permissions, copying only the isolated profile and credential (excluding sibling files), rewriting `credential.json`, and stripping `expires_at`.
- **Environment Isolation (lines 55, 112, 209):** Documents pointing `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `SWARM_AGENT_STATE_DIR`, `CLAUDE_CONFIG_DIR`, and `GROK_HOME` to the private copy root, preventing side effects in the operator's real agent credential store.
- **Exit Path Guarantees (lines 21, 106):** Cleanup of the temporary worktree and profile copy is documented for success, failure, unhandled exceptions, SIGINT (130), SIGTERM (143), SIGHUP (129), and exit-13.
- **Privacy & Write Blocking (lines 3, 39, 103):** Prohibits writing to origin, blocks `POST /functions/v1/command`, `/activity`, and storage writes, rejects relative URLs, and strips query strings and tokens (`pathOnly`).

#### 3. Mutation Controls & Test Integrity
- **Mutation Matrix (lines 92–113):** Lists all 20 mutation controls proving each gate, enumerator edge case, cleanup handler, and environment variable override fails as expected.
- **Operational Non-Goals (lines 121–131):** Clearly delineates what the tool does not prove (production edge latencies, write operations, Realtime WebSocket connections, and response body correctness).

#### 4. Historical Rulings & Docs Alignment
- **Rounds 1–4 Log (lines 133–219):** Accurately captures all confirmed defects and refuted claims from Rounds 1 through 4, including the Round 4 additions (sandboxed state directories, mandatory `--ref`, ES module `export * from` default-omission, and property assignment unit retention).

---

### Findings
No `PRODUCTION` or `RIGOUR` defects identified in `scripts/timeout-table/README.md`.

VERDICT: PASS The README accurately documents the gating contracts, credential isolation, failure modes, mutation controls, and Review Rounds 1–4 rulings without defect or discrepancy.
