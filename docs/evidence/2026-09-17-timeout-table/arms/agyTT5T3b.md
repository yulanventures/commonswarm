### D-036 Review: `scripts/timeout-table/mapping.json` (Part T3b)

#### Context & Dependencies Checked
- **Part Reviewed**: Part T3b (piece 2 of 4 of [`mapping.json`](file:///scripts/timeout-table/mapping.json)), covering the transition from the end of the `v0.1.71` ref mapping to the first section of the `HEAD` ref mapping.
- **Dependencies Noted**:
  - Part T3a: The initial segment of [`mapping.json`](file:///scripts/timeout-table/mapping.json) containing the top-level schema declaration and the first section of the `v0.1.71` mapping.
  - Parts T3c and T3d: Continuation of `HEAD` rows (following [`src/cloud/agent-receive.ts:timeout`](file:///src/cloud/agent-receive.ts)) and closing JSON structures.
  - External runners: AST extraction in [`scripts/timeout-table/enumerate.mjs`](file:///scripts/timeout-table/enumerate.mjs) and test runner in [`scripts/timeout-table/run.mjs`](file:///scripts/timeout-table/run.mjs).

---

### 1. Production Review

- **Timeout Mapping & False-Pass Prevention**:
  - [`src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS`](file:///src/cloud/agent-check-budget.ts#L22): Mapped under `HEAD` as `safe-read`, but explicitly sets `"measures_guarded_path": false` with documentation noting that credential renewal is omitted from the private-copy check test. This ensures the table reports `NOT MEASURED` (or requires explicit acknowledgment) rather than issuing a false `PASS` while in-flight credential renewal remains unmeasured against edge budgets.
  - Proxy and dependent sites (such as [`site/src/lib/auth-providers.ts:AbortSignal.timeout`](file:///site/src/lib/auth-providers.ts#L199), [`src/cloud/agent-check.ts:timeoutMs`](file:///src/cloud/agent-check.ts#L153), and [`src/listener/hook.ts:setTimeout`](file:///src/listener/hook.ts#L1167)) are mapped to class `"not-run"` with `proxy_operation` pointers. Per the Round 4 ruling, proxy rows of class `"not-run"` report `NOT RUN` and cannot generate a false `PASS`.
  - Non-time limits (such as [`src/listener/hook.ts:HOOK_RENDER_BUDGET_BYTES`](file:///src/listener/hook.ts#L89), [`src/listener/supervisor.ts:TAIL_SERIALIZED_BUDGET_BYTES`](file:///src/listener/supervisor.ts#L237), [`src/listener/wake.ts:WAKE_CLAIMS_PER_MINUTE_BUDGET`](file:///src/listener/wake.ts#L16), and [`src/cloud/agent-check.ts:AGENT_CHECK_BODY_BUDGET`](file:///src/cloud/agent-check.ts#L19)) are classified as `"local"` and `"not-run"` with clear rationale distinguishing byte/count constraints from latency deadlines.
  - Units are documented explicitly in detail strings (e.g., [`src/cloud/agent-check-budget.ts:HOST_HOOK_TIMEOUT_SECONDS`](file:///src/cloud/agent-check-budget.ts#L2) and [`src/cloud/agent-receive.ts:timeout`](file:///src/cloud/agent-receive.ts#L148) record that Claude hook timeouts are in seconds).

- **Credential & Workspace Isolation**:
  - Every operation that performs writes to a workspace or alters persistent state (such as [`src/listener/activity.ts:ACTIVITY_REQUEST_TIMEOUT_MS`](file:///src/listener/activity.ts#L15), [`site/src/lib/agent-connect.ts:COMMAND_TIMEOUT_MS`](file:///site/src/lib/agent-connect.ts#L102), [`src/cloud/agent-channel.ts:deadlineMs`](file:///src/cloud/agent-channel.ts#L142), and [`src/cloud/agent-channel.ts:signalRequestTimeoutMs`](file:///src/cloud/agent-channel.ts#L143)) is designated `"class": "not-run"`.
  - The only `safe-read` operations in this slice are:
    1. [`site/src/lib/auth-providers.ts:AUTH_SETTINGS_TIMEOUT_MS`](file:///site/src/lib/auth-providers.ts#L82), which performs a GET to public `/auth/v1/settings` with empty `writes` and `removes`.
    2. [`src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS`](file:///src/cloud/agent-check-budget.ts#L22), which strictly mutates `private-copy check.json cursor/cache only` inside the isolated private directory and removes the entire copy upon cleanup.
  - No workspace mutation or profile leakage can occur through the mapped entries in this piece.

---

### 2. Rigour Review

- **Ref Mapping Partition**:
  - Clean separation is maintained between the `v0.1.71` block and the `HEAD` block, fulfilling commit `dcb041c0` requirements and preventing cross-ref inventory collisions.
- **Identifier Stability**:
  - Identifiers follow the stable `file:identifier` and `file:identifier#ordinal` format (e.g., [`src/host/grok.ts:requestTimeoutMs#2`](file:///src/host/grok.ts#L328), [`src/host/opencode.ts:timeout#2`](file:///src/host/opencode.ts#L551), [`src/listener/hook.ts:timeoutMs#2`](file:///src/listener/hook.ts#L374) through `#4`), protecting tests against line-shift flakiness.

VERDICT: PASS
