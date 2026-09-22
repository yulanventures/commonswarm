### 1. Backups and the Restore Drill

* **Visible in Part Q6:**
  * Commits `b9dfb409`, `de697107`, `96ffe552`, `14bd3662`, `ae900959`, and `d634897d` establish recoverable database/file backups, weekly offsite restore drills, binding of alerts to systemd invocation IDs, failure alerting on partial or failed runs, and isolation of drill egress.
  * `deploy/supabase-stack/RUNBOOK.md` establishes that `commonswarm-postgres` is reached only via internal network (`172.31.0.10:5432`) without host-published ports, requires `backup_ro` connecting with `PGSSLMODE=verify-full`, `pg_hba.conf` restricted to `172.31.0.1/32`, and explicitly references `backup/README.md` requiring exact object-version copies and offsite byte verification.
* **External Dependencies (Not Checkable in Q6):**
  * The unit files, backup scripts (`backup-db.sh`, `backup-files.sh`), restore drill scripts, systemd timer definitions, and alert hooks reside in Parts Q1–Q4. In this part, we confirm that RUNBOOK specifications and commit invariants require isolated read-only privileges (`backup_ro`), egress isolation, and invocation-bound failure alerts.

---

### 2. H0 Upgrade and Verification

* **Visible in Part Q6:**
  * Commits `55a26933`, `2b346544`, and `9b064733` enforce verifying pristine source baseline counts before running the atomic H0 upgrade and starting the edge runtime.
  * `deploy/supabase-stack/RUNBOOK.md` lines 67–81 define the H0 schema boundary:
    * Requires `supabase/migrations/20260916000001_agent_join_credentials.sql` and `supabase/migrations/20260916000002_agent_join_attempts.sql` with fixed pinned SHA-256 hashes mounted read-only.
    * Enforces running `verify-counts.sh "$ARTIFACT_DIR" target` against unmodified source baseline counts first, followed by `apply-h0-upgrade.sh "$ARTIFACT_DIR" target`, followed by `verify-post-upgrade-counts.sh "$ARTIFACT_DIR" target`, all before starting `edge-runtime`.
    * Specifies target-identity guards: single transaction apply when both H0 tables are absent, catalog verification and skip replay when both are present, and immediate hard failure on any partial or malformed catalog state.
    * Rehearsal (step 8), cutover (step 4), and recovery procedures consistently follow this exact ordering.
* **External Dependencies (Not Checkable in Q6):**
  * The actual shell implementation and SQL in `apply-h0-upgrade.sh`, `verify-post-upgrade-counts.sh`, and the migration files are evaluated in Parts Q4 and Q5.

---

### 3. Activity Publish Grant

* **Visible in Part Q6:**
  * Commits `90e84f0e`, `d237fe7c`, `0859d9d7`, and `ccbc093d` document the restoration of scoped private activity publishing for `commonswarm_edge`.
  * Commit `d237fe7c` specifically enforces catalog verification of the exact effective column set permitted for `INSERT` (rejecting table-level `INSERT` or unauthorized extra columns) under non-superuser conditions.
* **External Dependencies (Not Checkable in Q6):**
  * The SQL migration applying `GRANT INSERT` on specific columns and the catalog assertion scripts reside in Parts Q4 and Q5.

---

### 4. Read Edge and CLI Change (#22)

* **Code Changes Analyzed:**
  * `supabase/functions/read/index.ts`:
    * Adds `p.model` and `s.generation::text AS generation` to the `agents` projection query.
    * Maps `generation` safely: `row.generation === null ? null : Number(row.generation)`. It enforces `generation === null || (Number.isSafeInteger(generation) && generation >= 1)`, throwing `"invalid session generation projection"` on negative, float, non-numeric, or numbers exceeding `Number.MAX_SAFE_INTEGER` (`2^53 - 1`). This prevents IEEE 754 precision loss from rounding fencing generation counters.
    * Projects caller run ID in identity: `run_id: agent.run_id`. `agent` is derived strictly from the authenticated bearer token context (`agent_delivery_read_context`).
  * `src/cloud/signals.ts`:
    * Adds optional fields to `SignalAgent` (`model?: string | null`, `generation?: number | null`) and `SignalAgentIdentity` (`run_id?: string`).
    * In `parseAgentMemberRow`: strictly validates that present non-null `model` is a `string`, and present non-null `generation` is a safe integer `>= 1`.
    * In `parseAgentIdentity`: strictly validates `run_id` via `checkedUuid`.
* **Security, Secret Exposure, and Privacy Analysis:**
  * **Secrets & Tokens:** Neither `model`, `generation`, nor `run_id` contain tokens, session secrets, wake IDs, or private keys.
  * **Isolation Between Agents:** `s.generation` originates from the sessions view, which exposes active session information only for the calling agent principal (`selfRow.generation`). For all other workspace agents (siblings), `s.generation` is SQL `NULL` (projected as `generation: null`), preventing cross-agent session status leakage.
  * **Workspace Isolation:** Cross-workspace reads return an empty directory (`{ members: [], agents: [] }`) and completely omit the `identity` block (`Object.hasOwn(cross.body, "identity") === false`).
  * **Backward and Forward Compatibility:**
    * Existing clients reading from the new read edge safely ignore the additive fields (`model`, `generation`, `run_id`).
    * New CLI reading from an older edge preserves absence (`model === undefined ? {} : ...`), correctly differentiating legacy field absence (`Object.hasOwn(...) === false`) from explicitly cleared models (`model: null`) or empty sessions (`generation: null`).

---

### 5. Tests and Documentation vs. Code

* `tests/p1-cli/d076-read-retry.test.ts`:
  * Verifies parsing preservation of authenticated `run_id`, stored `model`, and `generation` (including `null` values).
  * Verifies legacy field absence does not invent default/null values.
  * Verifies fail-closed rejection on invalid types (`model` as non-string, `run_id` as non-UUID or null, `generation` as `< 1`, float, string, or exceeding `MAX_SAFE_INTEGER`).
  * Every test will fail if any parsing or type invariant is violated.
* `tests/p1-server/agent-execution-sessions.test.ts`:
  * Verifies caller receives its own safe integer `generation`, while sibling agents have `generation: null` and `session_id: null`.
  * Verifies `identity.run_id` matches the caller's active run in `swarm.agent_runs`.
  * Verifies model transitions between `'synthetic'` and `null`.
  * Verifies cross-workspace access returns no identity, human callers receive `401`, revoked agents receive `403`, and expired tokens receive `401`.
* `deploy/supabase-stack/MUTATION-EVIDENCE.md`:
  * Accurately catalogues mutation coverage for PR #16 (cron listing comparator fail-closed behavior, handling of `mktemp`, `sort`, `chmod`, and `grep` exit codes).
* `deploy/supabase-stack/RUNBOOK.md`:
  * Corrects the cutover sequencing defect: moving storage sync, metadata restore, unmodified count checks, H0 upgrade, and post-upgrade count checks to run *prior* to starting `edge-runtime`, preventing race conditions where edge traffic could alter baseline counts.

---

### Findings Summary

No **PRODUCTION** or **RIGOUR** findings were identified in Part Q6.

VERDICT: PASS - Read edge and CLI changes (#22) are backward-compatible, protect agent isolation and session secrets, handle bigint fencing tokens without precision loss, and are supported by fail-closed tests and consistent runbook procedures.
