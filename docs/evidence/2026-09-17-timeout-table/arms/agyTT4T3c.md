### Review of PART T3c: `mapping.json` (piece 3 of 4)

#### External Dependencies (outside this slice)
1. **Preceding site entry** (lines 1–6): The head of the entry ending in `"reason": "Use of HOST_HOOK_TIMEOUT_SECONDS."` is cut off in piece 2.
2. **Succeeding site entry** (lines 512–516): `"src/listener/grok-model.ts:budget"` is cut off before its inner `operation` object, which continues in piece 4.
3. **Operations definition block**: The runnable operations referenced here (`channel-ls`, `file-ls`, `signal-read`, and proxy target `check`) are configured in the top-level `operations` dictionary located in another part of `mapping.json`.

---

### Audit Findings

#### 1. Production Timeout Guarding & Measurement Coverage (Review Item 1)
- **Safe-read paths**: The only operations marked `class: "safe-read"` in this slice are:
  - `src/cloud/channels.ts:timeoutMs` (`channel-ls`): Accurately exercises `listChannelsAsAgent` against `/functions/v1/read`.
  - `src/cloud/files.ts:REQUEST_TIMEOUT_MS` (`file-ls`): Explicitly specifies `"measures_guarded_path": false` because `REQUEST_TIMEOUT_MS` also bounds storage transfers and file command POSTs not exercised by `file-ls`. Under Round 4 rules, this prevents an incomplete path from claiming full measurement unless conclusively failing.
  - `src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS` (`signal-read`): Explicitly specifies `"measures_guarded_path": false` because the constant also bounds member directory reads, human PostgREST queries, and retries.
- **Mutating & Non-API sites**: All state-modifying API commands (`command-client.ts`, `delivery.ts`, `feedback.ts`, `renewal.ts`, `signals-seen`), local file locks (`agent-receive.ts`, `storage.ts`, `brain-digest.ts`), local control sockets (`control.ts`), and external ACP process timeouts (`bounds.ts`, `claude.ts`, `codex.ts`, `grok.ts`, `opencode.ts`) are correctly designated `class: "not-run"`.

#### 2. Workspace Safety & Credential Protection (Review Item 2)
- All runnable operations (`channel-ls`, `file-ls`, `signal-read`) specify `"writes": []` and `"removes": []`.
- Operations that mutate durable workspace state, credentials, or session records (`agent-setup`, `credential-renewal`, `session-command`, `delivery-command`) are marked `not-run` with clear justifications.

#### 3. ID Structure & Ordinals (Review Item 3)
- Site IDs strictly conform to the format `file:name#ordinal` without line numbers (satisfying commit `dcb041c0`).
- Ordinals are sequentially consistent with source code occurrences:
  - `src/cloud/agent-receive.ts:timeoutMs` and `#2`
  - `src/cloud/channels.ts:timeoutMs` and `#2`
  - `src/cloud/command-client.ts:setTimeout` through `#6`
  - `src/cloud/session-client.ts:setTimeout` and `#2`
  - `src/cloud/signals.ts:timeoutMs` and `#2`
  - `src/host/grok.ts:requestTimeoutMs` and `#2`
  - `src/host/opencode.ts:timeout` and `#2`

#### 4. Rigour & Round 4 Fix Verification (Review Item 4)
- Every mapped operation includes an explicit `"name"` field.
- Scopes (`per-request` vs `whole-operation`) and classifications (`local`, `external`, `network-api`) correctly reflect the call semantics and underlying transport.

---

VERDICT: PASS Part T3c correctly maps all timeout sites with unique line-shift-independent IDs, names every operation, isolates mutating and external endpoints as not-run, and flags partial guarded paths with measures_guarded_path: false.
