### Part T2 Review: `scripts/timeout-table/README.md` (SHA `9860904bf800334ea4654666cbe31e12b1c9faee`)

#### 1. Production Latency & Gate Evaluation
- **Conclusive Lower-Bound Failures (lines 5–6, 43, 45, 47, 62, 108, 146):** The document accurately specifies the Round 4 rule: when an incomplete path (`measures_guarded_path: false`) records a p95 exceeding half the budget (`budget / p95 < 2`), or when the real client records a `check_timeout`, the gate is conclusively `FAIL` regardless of whether the ID is listed in `--acknowledge-not-measured`.
- **Measurement vs Timeout Semantics (lines 67–76):** Clearly delineates `per-request` (matching HTTP requests with response body drain, no wall-time fallback) from `whole-operation` (wall time / helper duration).
- **Warm Window vs Tail Latency (lines 75–76, 131–134):** The documentation makes explicit that 20 sequential runs with nearest-rank p95 drop the worst sample and only characterize the warm window, not cold starts or tail latency.

#### 2. Credential Handling & Origin Isolation
- **Credential Storage & Modes (lines 21, 54–57):** The runner creates an isolated `0700` directory containing the profile and credential at `0600`, strips `expires_at` to prevent renewal attempts, isolates `HOME`, and avoids copying parent directory secrets.
- **Copy Collision Handling (lines 56, 116, 154):** Accurately documents that when the source profile file is named `credential.json`, it is copied as `profile.json` so it does not collide with the copied credential file `credential.json`.
- **Log Privacy & Query Redaction (lines 40, 114, 151, 153):** Explicitly states that relative URLs and requests store pathname only without queries or fragments, preventing token leakage in logs. Origin rewrite prevents forwarding writes (`POST /functions/v1/command`, `POST /functions/v1/activity`, `POST`/`PUT` under `/storage/v1/`).

#### 3. Mutation Controls & Test Integrity
- **Mutation Matrix (lines 97–124):** All 18 controls in the mutation table align with the test suite assertions, including exit-path cleanup order (`finalizeRunResources`), incomplete-path lower-bound failures, zero-duration infinite headroom handling, stdio capture, and AST enumerator extensions (directory index imports, `export *`, and block-scoped local constants).

#### 4. Documentation vs Implementation Alignment
- **CLI Commands and Arguments (lines 24–32, 33–38):** Example flags, defaults (`--runs 20`, `--pause-ms 500`), and exact acknowledged IDs (`src/cloud/agent-check.ts:AGENT_CHECK_TIMEOUT_MS`, `src/cloud/files.ts:REQUEST_TIMEOUT_MS`, `src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS`) match the safe-read incomplete rows.
- **Review History (lines 138–206):** Rulings from Review Rounds 1–3 accurately capture confirmed issues, fixes, and refutations.

---

### Unchecked Dependencies (Separate Calls)
Because this review is strictly scoped to Part T2 without direct tool access to the underlying implementation files:
1. `scripts/timeout-table/enumerate.mjs` (Part T1a / T3)
2. `scripts/timeout-table/run.mjs` (Part T1b / T4)
3. `scripts/timeout-table/preload.cjs` (Part T1a / T3)
4. `scripts/timeout-table/mapping.json` (Part T3)
5. `tests/p1-cli/timeout-table.test.ts` (Part T4 / T5)
6. Direct test execution of `env -u FORCE_COLOR node --import tsx --test tests/p1-cli/timeout-table.test.ts`

---

VERDICT: PASS README.md accurately specifies the Round 4 gate contracts, credential isolation, lower-bound failures, enumerator rules, and mutation controls without discrepancy.
