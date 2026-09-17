### Production & Rigour Review: PART T3a (`scripts/timeout-table/mapping.json`, piece 1 of 4)

#### 1. Timeout Mapping & False-PASS Prevention (PRODUCTION)
- **Safe-Read Operations**:
  - `site/src/lib/auth-providers.ts:AUTH_SETTINGS_TIMEOUT_MS` (`auth-settings`): Correctly classified as `safe-read`; performs a public GoTrue settings GET with no side effects.
  - `src/cloud/channels.ts:timeoutMs` (`channel-ls`): Properly classified as `safe-read`; queries the read edge via POST for channel list metadata without state mutations.
- **Partial Path Guarding (`measures_guarded_path: false`)**:
  - `src/cloud/agent-check.ts:AGENT_CHECK_TIMEOUT_MS` (`check`)
  - `src/cloud/files.ts:REQUEST_TIMEOUT_MS` (`file-ls`)
  - `src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS` (`signal-read`)
  All three correctly set `"measures_guarded_path": false` with explicit documentation that unmeasured sub-paths (credential renewal, storage downloads/command POSTs, and member directory/delivery receipts) prevent the gate from falsely reporting PASS ("Gate is NOT MEASURED until acknowledged").
- **Not-Run & Proxy Operations**:
  - Mutating operations (e.g., commands in `src/cloud/command-client.ts`, delivery leases in `src/cloud/delivery.ts`, signal seen receipts in `src/cloud/agent-signal-receipts.ts`, profile mutations in `src/cloud/agent-setup.ts`) are marked `not-run`.
  - Proxied operations (e.g., `src/cli.ts:setTimeout#2`, `site/src/lib/auth-providers.ts:AbortSignal.timeout`, `src/cloud/channels.ts:timeoutMs#2`) correctly designate `proxy_operation` under `not-run` class, reporting NOT RUN and never emitting a false PASS.

#### 2. Credentials & Workspace Isolation (PRODUCTION)
- No operation in this piece writes to a real workspace or production store.
- Mutating actions that affect credentials or principal states are marked `not-run`.
- The only file write declared across all runnable operations is the private copy cache in `AGENT_CHECK_TIMEOUT_MS` (`writes: ["private-copy check.json cursor/cache only"]`, `removes: ["entire private profile copy"]`), ensuring isolation within the 0700 private directory.

#### 3. Row ID Schema & Unit Precision (RIGOUR)
- **Row Identifiers**: Fully conform to commit `dcb041c0` schema (`file:name#ordinal`), eliminating line numbers while disambiguating multiple call sites (e.g., `src/cloud/command-client.ts:setTimeout` through `#6`, `src/cloud/agent-receive.ts:timeoutMs` and `#2`, `src/cloud/channels.ts:timeoutMs` and `#2`).
- **Unit Annotations**: Timeouts specified in seconds rather than milliseconds (e.g., `src/cloud/seed.ts:connect_timeout`, `src/cloud/seed.ts:timeout`, `src/cloud/agent-receive.ts:timeout`) explicitly record units in their `detail` annotations to avoid budget value reading errors.
- **Non-Timeout Bounds**: Size bounds (e.g., `src/cloud/agent-check.ts:AGENT_CHECK_BODY_BUDGET`) and external/local timers are classified as `local`/`external` and `not-run`.

#### Dependencies Not Checked in this Call
- Rows continuing from `src/host/claude.ts:requestTimeoutMs` through line 3146 across pieces 2–4 (remaining `v0.1.71` entries and the `HEAD` mapping).
- AST extraction and citation line validation in `enumerate.mjs` / `run.mjs` / `preload.cjs` (provided in other parts).

VERDICT: PASS Part T3a accurately maps row IDs, safely excludes mutating operations, annotates second units, and guards against false PASS results via measures_guarded_path: false.
