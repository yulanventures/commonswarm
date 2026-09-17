### D-036 Review: Part T3c — `mapping.json` (Piece 3 of 4)

#### Scope & Content
This piece covers mapping definitions for timeout sites across:
- `src/cloud/` (`agent-receive.ts`, `agent-setup.ts`, `agent-signal-receipts.ts`, `auth.ts`, `channels.ts`, `command-client.ts`, `current-target.ts`, `delivery.ts`, `feedback.ts`, `files.ts`, `renewal-grants.ts`, `renewal.ts`, `seed.ts`, `session-client.ts`, `signals.ts`, `storage.ts`)
- `src/host/` (`bounds.ts`, `claude.ts`, `codex.ts`, `grok.ts`, `opencode.ts`, `stderr-tail.ts`)
- `src/listener/` (`activity.ts`, `brain-digest.ts`, `control.ts`, `grok-model.ts`)

---

### Review Findings

#### 1. Production Safety & False-PASS Analysis
- **Guarded Path Coverage (`measures_guarded_path: false`)**:
  - `src/cloud/files.ts:REQUEST_TIMEOUT_MS`: Correctly notes that `file-ls` metadata read is only one path guarded by `REQUEST_TIMEOUT_MS` (which also guards command POSTs and storage transfers). It explicitly marks `"measures_guarded_path": false`, ensuring the table evaluates to `NOT MEASURED` rather than an unacknowledged false `PASS`.
  - `src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS`: Correctly marks `"measures_guarded_path": false` because `readAgentSignalPage` does not cover members directory, PostgREST queries, or delivery-receipt reads.
- **Read-Only vs. Mutation Exclusions**:
  - Only truly safe operations are designated `class: "safe-read"` (`channel-ls`, `file-ls`, `signal-read`), all with `"writes": []` and `"removes": []`.
  - All mutating endpoints (commands, receipts, model declarations, signals, delivery claims, feedback, renewal, session mutation, activity frame publishing) are classified as `operation.class: "not-run"`, accompanied by explicit descriptions of what they write and why no safe cleanup exists.
  - Proxy operations associated with `not-run` items report `NOT RUN` (consistent with the Round 4 ruling).
- **External & Local Exclusions**:
  - Direct PostgreSQL queries (`seed.ts`), external ACP subprocess management (`claude.ts`, `codex.ts`, `grok.ts`, `opencode.ts`, `bounds.ts`), and local IPC/file locks (`storage.ts`, `brain-digest.ts`, `control.ts`, `agent-receive.ts`, `stderr-tail.ts`) are correctly categorized as `class: "external"` or `class: "local"` with `operation.class: "not-run"`.

#### 2. Credentials and Workspace Leakage
- `mapping.json` in this piece contains solely declarative configuration and classification metadata; no credentials, tokens, or private paths are exposed.
- None of the executed operations (`safe-read`) perform file or state writes to a workspace.

#### 3. Rigour & Identification Stability
- All timeout site identifiers follow the line-independent format: `<filepath>:<identifier>` or `<filepath>:<identifier>#<ordinal>` (e.g., `src/cloud/command-client.ts:setTimeout#6`, `src/host/grok.ts:requestTimeoutMs#2`).
- Scope classifications (`per-request` vs. `whole-operation`) properly reflect whether the timer guards an individual request abort or an overarching operation deadline.

---

### Dependencies (External to Part T3c)
1. **Piece 2 Predecessor**: Lines 1–6 complete the trailing entry from piece 2 (`"reason": "Use of HOST_HOOK_TIMEOUT_SECONDS."`).
2. **Piece 4 Successor**: Lines 862–866 begin the object for `"src/listener/grok-model.ts:budget"`, which continues into piece 4.
3. **AST Enumerator (`enumerate.mjs`)**: IDs mapped in this piece must match the identifiers emitted by `enumerate.mjs`.
4. **Runner & Preload Harness (`run.mjs`, `preload.cjs`)**: Correct execution of the three `safe-read` operations (`channel-ls`, `file-ls`, `signal-read`) without triggering state modifications.

---

VERDICT: PASS (mapping.json piece 3 correctly classifies all timeout sites, cleanly marks non-guarded safe reads with measures_guarded_path: false to prevent false passes, and isolates all mutating operations as not-run)
