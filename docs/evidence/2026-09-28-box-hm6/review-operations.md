### Operations Review: Dark OAuth Service Box Window (HM Lane 6 - v2)

**Task Context & Plan Reference:**
- **Attached Release Plan:** `BOX-WINDOW.md (v2)` located at [`/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-specs/boxplan-hm6-v2.md`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-specs/boxplan-hm6-v2.md#L24-L1465)
- **Target Release SHA:** `9fa4217da9f6447e55fb8c6d577b8fd3997f926b`
- **Governing Procedure:** [`deploy/RELEASE-TO-BOX.md`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/RELEASE-TO-BOX.md#L1-L788)

---

### Verification Matrix & Audit Findings

#### 1. Measured Values & Tree Consistency
- **Compose Project:** `commonswarm-oauth` as defined in [`deploy/mcp-auth/compose.yaml#L1`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/mcp-auth/compose.yaml#L1) and cited in `BOX-WINDOW.md (v2)` lines 377, 821, 838, 915, 918, 1315, 1325.
- **Port Range:** Ports `3490–3499` in [`deploy/mcp-auth/compose.yaml#L12`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/mcp-auth/compose.yaml#L12) and [`deploy/mcp-auth/RUNBOOK.md#L86`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/mcp-auth/RUNBOOK.md#L86), matching `BOX-WINDOW.md (v2)` lines 723 and 1015.
- **Environment Names:** `MCP_OAUTH_DATABASE_HOST` and `MCP_OAUTH_DATABASE_ADDRESS` match [`deploy/mcp-auth/compose.yaml#L18-L26`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/mcp-auth/compose.yaml#L18-L26) and [`services/mcp-auth/src/config.js#L120`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/services/mcp-auth/src/config.js#L120).
- **Caddy File:** [`deploy/supabase-stack/commonswarm-mcp.caddy`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/supabase-stack/commonswarm-mcp.caddy#L1-L175) contains exactly 5 port parameter substitutions (`{$MCP_OAUTH_HOST_PORT}`) and imports `mcp_oauth_active` (line 155) while keeping `mcp_resource_active` unimported.
- **Backup Helpers:** `run-backup.sh` at [`deploy/supabase-stack/backup/run-backup.sh#L21`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/supabase-stack/backup/run-backup.sh#L21) invokes `dump-database.sh`, which in turn executes `dump-source.sh` at [`deploy/supabase-stack/migrate/dump-source.sh#L23`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/supabase-stack/migrate/dump-source.sh#L23).
- **Proof Files & Hashes:** All 7 proof SQL files under `deploy/release-proofs/item-hm/` (`20260928000002-catalog.sql`, `20260928000003-catalog.sql`, `20260928000003-functional.sql`, `20260928000003-rollback.sql`, `20260928000003-rollback-catalog.sql`, `20260928000004-catalog.sql`, `20260928000004-functional.sql`) exist in the repository tree and match the window specification.

#### 2. Proof Validity & Structural Checks
- **Pre-apply Catalog Evaluations:** Catalog proofs (`20260928000002-catalog.sql`, `20260928000003-catalog.sql`, and `20260928000004-catalog.sql`) use guarded `to_regclass` and `to_regnamespace` checks, returning `catalog_ok = f` cleanly without throwing SQL errors prior to migration application.
- **Structural Inspections:** Metadata and privilege assertions query system catalogs (`pg_class`, `pg_proc`, `pg_roles`, `aclexplode()`, `has_table_privilege()`, `has_function_privilege()`) rather than regex-matching deparsed SQL text strings.
- **Granular Privilege Verification:** Step `hm6-check-runtime-privileges` in `BOX-WINDOW.md (v2)` lines 637–703 validates table privileges across every privilege bit (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`) individually.
- **Verbatim Rollback:** Step `hm6-run-verbatim-reviewed-rollback` in `BOX-WINDOW.md (v2)` lines 1346–1379 executes [`deploy/release-proofs/item-hm/20260928000003-rollback.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-rollback.sql#L1-L95) verbatim and checks its sibling rollback catalog `20260928000003-rollback-catalog.sql`.

#### 3. Step Ordering & Execution Lifecycle
- **HM2 Precondition:** Checked read-only first in step `hm6-prove-hm2-precondition` (`BOX-WINDOW.md (v2)` lines 240–261).
- **Helper Activation Before Migration:** The guarded stack switch step `hm6-guarded-stack-helper-switch` (`BOX-WINDOW.md (v2)` lines 501–607) points `stack/current` to `NEW_STACK` (activating `dump-source.sh` schema selection) before applying migration `20260928000003`.
- **Database Resolution & TLS Preflight:** Step `hm6-prove-runtime-database` (`BOX-WINDOW.md (v2)` lines 832–898) verifies container DNS resolution, CA certificate validity, TLS hostname verification, and runtime role authentication before step `hm6-start-dark-service` (`BOX-WINDOW.md (v2)` lines 905–935) launches HTTP endpoints.

#### 4. Post-Apply Backup Schema Coverage
- Step `hm6-prove-post-apply-backup-coverage` (`BOX-WINDOW.md (v2)` lines 1177–1278) inspects the completed backup artifact, asserting `commonswarm_oauth` schema inclusion in `manifest.txt`, verifying `SCHEMA - commonswarm_oauth` in `pg_restore --list`, and asserting all six OAuth tables and their corresponding data entries in `pg_restore --list` and `source-counts.tsv`.

#### 5. Control Fail-Closed & Execution Safety
- All shell execution blocks run with `set -euo pipefail`.
- Step `hm6-probe-public-routes` (`BOX-WINDOW.md (v2)` lines 1080–1149) targets the Mac mini and runs under `/bin/bash 3.2` without using unsupported features (no heredocs inside `$(...)`, associative arrays, `${var,,}`, `mapfile`, `|&`, `&>>`, or `wait -n`).
- All 19 runnable executable code blocks are distinct ```sh blocks starting with `# step: <id>`.
- No `cswarm` credential JSON is read, obeying field restrictions (`agent_token`, `principal_id`, `token_id`, `run_id`).

---

### Findings Summary

- **PRODUCTION-blocking defects (KEEP):** None.
- **Style / Non-blocking notes (NITS):** None.

---

VERDICT: PASS (no KEEP)