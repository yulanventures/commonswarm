### Part T3d Review: `mapping.json` (Piece 4 of 4)

#### Scope and Context
This review covers the final piece (piece 4 of 4) of `scripts/timeout-table/mapping.json`, concluding at the file-level closing brackets. This hunk completes the site inventory mappings for the listener (`src/listener/*`), onboarding (`src/onboarding-cli.ts`), and CLI listener options (`src/cli.ts`).

#### Uncheckable Dependencies (External to Part T3d)
- Pieces 1–3 of `mapping.json` (root schema definitions, operation catalog, earlier client ref inventory for `v0.1.71` and `HEAD`).
- `enumerate.mjs`, `run.mjs`, `preload.cjs`, and `render.mjs` implementation scripts.
- Test suites verifying inventory parity against AST extraction.

---

### Review Findings by Dimension

#### 1. Production Timeout Guarding & PASS Semantics
- **All entries in this piece are `class: "not-run"`**: Every mapped entry in this piece represents an operation classified as `not-run`. As established in Round 4 rulings, rows marked `not-run` (including those referencing a `proxy_operation` such as `hook-check` and `hook-check-timer`) report `NOT RUN` and never `PASS`. Consequently, none of these entries can cause the gate to report a false `PASS`.
- **Non-Timeout Discard Handling**: Non-wait bounds matched by regex/AST scanners (`budgetBytes`, `HOOK_RENDER_BUDGET_BYTES`, `TAIL_SERIALIZED_BUDGET_BYTES`, `WAKE_CLAIMS_PER_MINUTE_BUDGET`) are correctly cataloged with explicit reasons (`"Size bound, not a wait."` and `"Count bound, not a wait."`). This satisfies inventory accounting in `enumerate.mjs` without polluting wait measurements.
- **External & Local Boundaries**: External LLM turns (`grok-model.ts:timeoutMs`, `types.ts:LISTENER_PROMPT_TIMEOUT_MS`, `cli.ts:turnBudgetMs`, `cli.ts:deliveryHoldBudgetMs`), local process timeouts (`HOOK_PROCESS_DEADLINE_MS`), idle socket sweeps (`LISTENER_HTTP_IDLE_TIMEOUT_MS`), and local file locks (`HOOK_LOCK_TIMEOUT_MS`, `timeoutMs#1..4`) are accurately segregated from network API wait times.

#### 2. Credential Security and Workspace Isolation
- **Explicit Ambient Profile Protection**: `src/listener/hook.ts:HOOK_CHECK_TIMEOUT_MS` explicitly sets `class: "not-run"` because *"The hook scans ambient profiles, which the lane must not read."* This respects credential isolation rules and prevents any leakage of operator credentials.
- **Workspace Writes**: All operations have empty `writes: []` and `removes: []` (with `hook-check-timer` documenting isolated cursor writes but remaining `not-run`). No operation in this piece executes or writes to any workspace.

#### 3. Test Resilience and ID Format
- **Stable Identifiers**: Entries with multiple occurrences in the same file use the stable `file:identifier#ordinal` format introduced in commit `dcb041c0` (e.g., `src/listener/hook.ts:timeoutMs`, `src/listener/hook.ts:timeoutMs#2` through `#4`) rather than raw line numbers, with file lines referenced only in `citation`. This ensures inventory checks remain robust against line shifts.
- **No Collision or Overlaps**: All 22 site keys in this section are unique and properly scoped.

#### 4. Tree Integrity and Syntax
- JSON syntax is clean and well-formed; closing braces cleanly close the sites object, ref block, and root JSON object with no trailing commas.

---

VERDICT: PASS - All mapped sites are correctly categorized as not-run (non-time bounds, local locks, external model prompts, and ambient-profile scanners), preserving credential isolation and ensuring no false PASS can occur.
