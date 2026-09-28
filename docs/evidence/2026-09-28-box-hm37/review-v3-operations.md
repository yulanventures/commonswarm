# Operations Review: CommonSwarm HM Lanes 3 and 7 (DARK) Box Window Plan (v3)

**Target Release SHA:** `e7bb7a46b24e7bc794234416d43605bca52b55d4`
**Governing Runbook:** [`deploy/RELEASE-TO-BOX.md`](local path)
**Document Reviewed:** [`BOX-WINDOW.md` (v3)](local path)

---

## 1. Scope & Audit Summary

This read-only operations review audits the v3 release plan for HM lanes 3 and 7 (DARK) against the repository tree at release SHA `e7bb7a46b24e7bc794234416d43605bca52b55d4`. The audit evaluates:
1. Measured source identity, tree comparisons, changed function entry points, environment variables, and file hashes.
2. Migration and catalog proof safety (catalog false without error prior to apply, structural checks without text-matching schema-qualified names, individual privilege assertions, and verbatim SQL inverse).
3. Read-only baseline prerequisites (lane 2 migration 02 applied; lane 6 live from `ad964ed158181ba1692dd05895f36fa7a1f87d3f`, migration 03 applied, discovery/JWKS served, public authorization disabled).
4. Control harness coverage (concurrent open, ACK, repeated ACK, upper-case UUID, local `check.json`, and stdio MCP).
5. Runnable block structure (`# step: <id>`) and macOS `/bin/bash` 3.2 compatibility.
6. Execution safety rules (saved container log step preceding any edge/stack recreate, principal name derivation from `WINDOW_PRINCIPAL_SUFFIX`, and strict isolation from Caddy edits).

---

## 2. Detailed Findings & Audit Breakdown

### 2.1 Measured Source Identity & Tree Comparisons
* **Edge & Migration Tree Comparison (18 Paths):**
  * Checked [`prompt.md#L84-L106`](local path) and [`prompt.md#L149-L166`](local path). The comparison restricted to `supabase/` and `deploy/edge-runtime/` between live edge `72c57e0d` and release SHA `e7bb7a46` accurately enumerates all 18 modified or added files.
* **Changed Functions & Environment Inventory:**
  * Checked [`prompt.md#L107`](local path) and [`deploy/edge-runtime/main/router.ts#L1-L40`](local path). Direct function entry points are `command` and `mcp` (`ROUTER_CHANGED=yes`).
  * Checked [`deploy/edge-runtime/env.example#L26`](local path) and [`prompt.md#L205-L207`](local path). Relative to the previous edge, `SWARM_MCP_PUBLIC_ENABLED` is added as an optional environment variable. No new required edge environment names are introduced (`ADDITIONAL_REQUIRED_ENV_NAMES=''`).
* **Proof Inputs & Hashes:**
  * Checked [`prompt.md#L260-L272`](local path) against [`deploy/release-proofs/item-hm/`](local path). All 8 proof files exist in the tree and match their SHA-256 signatures.

### 2.2 Schema & Catalog Proof Verification
* **Catalog Proof Pre-apply Safety:**
  * Checked [`deploy/release-proofs/item-hm/20260928000004-catalog.sql#L1-L219`](local path). Table lookups use `to_regclass` and `LEFT JOIN pg_class`, returning `false` without SQL error prior to applying migration `20260928000004_hm_hosted_check.sql`.
* **Structural Catalog Checks:**
  * Checked [`deploy/release-proofs/item-hm/20260928000004-catalog.sql#L125-L154`](local path). `hosted_mcp_check_visible_signals` return signature is validated using structural catalog columns (`prolang`, `prorettype`, `proretset`, `proargnames`, `proallargtypes`, and `pg_depend` checks), avoiding fragile source text matching.
* **Granular Privilege Testing:**
  * Checked [`deploy/release-proofs/item-hm/20260928000004-catalog.sql#L13-L25`](local path). Privileges (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) are asserted individually per role rather than grouped in comma-separated strings.
* **Rollback Order & Inverse Verbatim Check:**
  * Checked [`prompt.md#L883-L981`](local path) and [`deploy/release-proofs/item-hm/20260928000004-rollback.sql#L1-L17`](local path). Section 11 enforces edge rollback prior to SQL inverse execution. The embedded SQL inverse in `# step: hm37-reserve-schema-rollback` ([`prompt.md#L948-L960`](local path)) matches `20260928000004-rollback.sql` verbatim.

### 2.3 Prerequisites & Preconditions
* **HM Lane 6 Baseline Requirement:**
  * Checked [`prompt.md#L46-L47`](local path) and [`prompt.md#L307-L326`](local path). The plan explicitly mandates that HM lane 6 must be live and closed at release `ad964ed158181ba1692dd05895f36fa7a1f87d3f` with migration 03 applied, OAuth discovery and JWKS endpoints responding, and public authorization turned off.

### 2.4 Control Requirements
* **Hosted Open/ACK Observations:**
  * Checked [`prompt.md#L786-L800`](local path). Section 9 includes required controls for concurrent opens, cursor non-advancement on open, unauthenticated public rejection (403), upper-case UUID ACK parsing, repeated ACK idempotency, and batch depletion.
* **Local Check & Stdio Parity:**
  * Checked [`prompt.md#L820-L881`](local path) and [`tests/p1-cli/mcp-stdio.test.ts#L1-L50`](local path). Section 10 verifies that local `check.json` and stdio MCP code remain unchanged and prescribes end-to-end local recipient/sender controls.

### 2.5 Executable Blocks & macOS Bash 3.2 Compatibility
* **Step Structure:**
  * Checked all code blocks in [`prompt.md#L27-L1072`](local path). Every runnable block is an isolated ` ```sh ` block beginning with `# step: <id>`:
    * `hm37-source-identity` ([`prompt.md#L129`](local path))
    * `hm37-read-window-suffix` ([`prompt.md#L393`](local path))
    * `hm37-backup-gate` ([`prompt.md#L432`](local path))
    * `hm37-functional-section5` ([`prompt.md#L514`](local path))
    * `hm37-public-boundaries` ([`prompt.md#L617`](local path))
    * `hm37-validate-local-credential` ([`prompt.md#L836`](local path))
    * `hm37-reserve-schema-rollback` ([`prompt.md#L908`](local path))
* **Bash 3.2 Compatibility:**
  * Mac mini blocks ([`prompt.md#L129-L201`](local path), [`#L393-L422`](local path), [`#L617-L756`](local path), [`#L836-L866`](local path)) avoid syntax incompatible with macOS default `/bin/bash` 3.2 (no heredocs inside `$()`, no associative arrays `declare -A`, no `${var,,}`, no `mapfile`/`readarray`, no `|&`, no `&>>`, no `wait -n`).

### 2.6 Container Logging, Principal Names & Caddy Boundary
* **Container Log Preservation:**
  * Forward edge recreate ([`prompt.md#L535-L568`](local path)) and rollback edge recreate ([`prompt.md#L887-L894`](local path)) capture outgoing container stdout/stderr into bounded mode-0600 proof files before symlink changes or container recreation.
* **Principal Naming:**
  * Principal names in Section 5 ([`prompt.md#L385-L389`](local path)) derive strictly from `${WINDOW_PRINCIPAL_SUFFIX}`.
* **Caddy Isolation:**
  * Sections 1 and 12 ([`prompt.md#L57`](local path), [`#L63`](local path), [`#L1048`](local path)) explicitly exclude Caddy installation, configuration modifications, validation rollouts, or service reloads (`API_CADDY_PAIR=no`).

---

## 3. Conclusion & Verdict

No production-blocking defects (KEEP) were detected. The v3 window document correctly reflects the repository tree at release SHA `e7bb7a46b24e7bc794234416d43605bca52b55d4`.

VERDICT: PASS (no KEEP)