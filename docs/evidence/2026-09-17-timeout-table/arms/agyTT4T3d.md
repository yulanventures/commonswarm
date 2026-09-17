### PART T3d Review: `mapping.json` (piece 4 of 4)

#### Dependencies Not Checked in This Piece
- Preceding parts of `mapping.json` (T3a, T3b, T3c), including the top-level keys, `refs` structure (`v0.1.71` vs `HEAD`/`main`), and earlier site definitions.
- Corresponding implementation files (`scripts/timeout-table/enumerate.mjs`, `run.mjs`, `preload.cjs`) handled in separate review parts.

---

### Review Findings

#### 1. Production Timeout Guarding & Accuracy
- **Classification & Mapping**:
  - The sites mapped in this piece cover external process budgets (`src/listener/grok-model.ts:timeoutMs`, `src/listener/runtime.ts:deliveryHoldBudgetMs`, `src/listener/runtime.ts:LISTENER_DELIVERY_HOLD_BUDGET_MS`, `src/listener/types.ts:LISTENER_PROMPT_TIMEOUT_MS`, `src/cli.ts:turnBudgetMs`, `src/cli.ts:deliveryHoldBudgetMs`), local resource locks/bounds (`src/listener/hook.ts:budgetBytes`, `HOOK_LOCK_TIMEOUT_MS`, `HOOK_PROCESS_DEADLINE_MS`, `HOOK_RENDER_BUDGET_BYTES`, `timeoutMs#1..#4`, `src/listener/http-client.ts:idleTimeoutMs`, `LISTENER_HTTP_IDLE_TIMEOUT_MS`, `src/listener/supervisor.ts:TAIL_SERIALIZED_BUDGET_BYTES`, `supervisor.ts:timeoutMs`, `src/listener/wake.ts:WAKE_CLAIMS_PER_MINUTE_BUDGET`, and `src/onboarding-cli.ts:setTimeout`).
  - All non-network sites are correctly categorized as `local` or `external` with operation class `not-run` and explicit justifications.
  - The newly enumerated local constants in `src/cli.ts` (`turnBudgetMs` at line 6517 and `deliveryHoldBudgetMs` at line 6714) are mapped to named operations (`listener-prompt-site`) and classified as `external` (guarding external model turns rather than cloud API requests), avoiding false passes on network timeouts.
- **Hook Check Proxying**:
  - `src/listener/hook.ts:HOOK_CHECK_TIMEOUT_MS` and `src/listener/hook.ts:setTimeout` are correctly marked `network-api`. Because running hook check directly would inspect ambient machine profiles (which the test lane must not access), they proxy via `proxy_operation: "check"`. This exercises the underlying credential and read endpoints via the private profile sandbox without bypassing timeout measurement.

#### 2. Credentials & Workspace Safety
- Every operation in this segment is `not-run`.
- All `writes` and `removes` arrays are empty (`[]`), with the exception of `hook-check-timer` declaring `"private-copy check.json cursor/cache only"`. No operation in this piece writes to or modifies a real workspace.

#### 3. Schema, Naming, & Structural Integrity
- **Key Formatting**: All site identifiers adhere to the line-number-independent format `file:name` or `file:name#ordinal` (e.g. `src/listener/hook.ts:timeoutMs#2` through `#4`).
- **Named Operations**: All operations satisfy the Round 4 requirement that operations must be explicitly named (e.g. `provider-canary-site`, `hook-check`, `tail-size`, `listener-prompt-site`).
- **JSON Structure**: Object closures cleanly terminate the sites mapping, ref definition, and the root object (`}}}`).

---

VERDICT: PASS
