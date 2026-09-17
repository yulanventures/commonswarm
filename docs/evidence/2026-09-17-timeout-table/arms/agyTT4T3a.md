### Findings

#### 1. [PRODUCTION] Unfair proxy assigned to `session-status` allows unmeasured session read to report PASS
- **File & Lines**: `scripts/timeout-table/mapping.json:452-475` (in `v0.1.71` rows, row `src/cloud/session-client.ts:setTimeout#2`)
- **Concrete Sequence**:
  1. `src/cloud/session-client.ts:setTimeout#2` guards the session status read abort (`getSessionStatus`, querying `/functions/v1/read` for session state with budget `default this.options.timeoutMs ?? 30_000`).
  2. In `mapping.json`, the operation `session-status` is defined with:
     ```json
     "proxy_operation": "signal-read",
     "proxy": "signal-read is an authenticated read of a different resource; not a fair statement-count proxy."
     ```
  3. Unlike other unmeasured or partially guarded reads (such as `src/cloud/agent-check.ts:AGENT_CHECK_TIMEOUT_MS`, `src/cloud/files.ts:REQUEST_TIMEOUT_MS`, and `src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS`), `session-status` does **not** set `"measures_guarded_path": false`.
  4. In every other row where no fair proxy exists (e.g. `COMMAND_TIMEOUT_MS`, `AGENT_SEEN_TIMEOUT_MS`, `declare-agent-model`, `task-command`, `delivery-command`, `feedback`, `RENEW_TIMEOUT_MS`), `proxy_operation` is deliberately omitted so that the operation is recorded as not-run/unmeasured.
  5. By specifying `proxy_operation: "signal-read"`, `run.mjs` borrows the latency of `signal-read` (~50–100 ms) and compares it against the 30,000 ms budget. Headroom calculates to ~300–600× (well above 2×).
- **What an Operator or Production Sees**:
  The timeout table renders `src/cloud/session-client.ts:setTimeout#2` as a fully verified `PASS` with high headroom. The gate passes through `edge-staging.commonswarm.com`. In production, a real client calling `getSessionStatus` against the session resource can stall or exceed its deadline, because its actual backend statements and execution path were never exercised by the table.

---

### Unchecked Dependencies
1. **`mapping.json` Pieces 2–4**: Lines 469–3146 were not present in this call (including the completion of `src/host/claude.ts:requestTimeoutMs` and the rows for `HEAD`/`main`). Verification of `src/cli.ts:turnBudgetMs` and `src/cli.ts:deliveryHoldBudgetMs` under `HEAD` depends on those subsequent parts.
2. **Execution Scripts**: `run.mjs`, `preload.cjs`, and `enumerate.mjs` are reviewed in separate calls.

VERDICT: FAIL - `src/cloud/session-client.ts:setTimeout#2` assigns `proxy_operation: "signal-read"` despite explicitly acknowledging it is not a fair proxy, allowing an unmeasured 30s session read to falsely PASS.
