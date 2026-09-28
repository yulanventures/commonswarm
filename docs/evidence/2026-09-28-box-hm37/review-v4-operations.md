# Operations Review: CommonSwarm HM Lanes 3 & 7 (DARK) Production Release Plan v4

**Target Release SHA:** `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`
**Previous Live Edge:** `72c57e0d76d0aa86fe4f811a2cf51499919fed20`
**Required HM6 Preconditions:** Stack `ad964ed158181ba1692dd05895f36fa7a1f87d3f` & OAuth `826db6a34f235064a3a03c57377d8e32a35d2f05`

---

## 1. Executive Summary & Review Scope

This is a read-only operations consult evaluating **`BOX-WINDOW.md (v4)`** (release SHA `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`) against the production release requirements defined in [`deploy/RELEASE-TO-BOX.md`](local path) and repository standards.

The plan covers the DARK deployment of HM lanes 3 and 7:
1. Application of database migration [`supabase/migrations/20260928000004_hm_hosted_check.sql`](local path).
2. Recreation of the edge runtime service at SHA `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922` behind dark routes (`SWARM_MCP_PUBLIC_ENABLED` remains unassigned/disabled).

No files have been created, modified, or deleted during this review.

---

## 2. Verification of Plan & Repository Invariants

### 2.1 Measured Source Identity & Diff Comparisons
- **File Diff Inventory:** Recomputed `git diff --name-only 72c57e0d76d0aa86fe4f811a2cf51499919fed20 eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922 -- supabase/ deploy/edge-runtime/`. The diff contains exactly the **18 paths** listed in Section 2 of `BOX-WINDOW.md (v4)` ([lines 89–111](local path)).
- **Changed Function Entry Points:** Only `command` and `mcp` entry points have direct changes. `ROUTER_CHANGED=yes` is set, and the archived router inventory remains `command read capability activity h0 mcp` ([lines 112–114](local path)).
- **Edge Environment Names:** Checking [`deploy/edge-runtime/env.example`](local path), the only new optional assignment name is `SWARM_MCP_PUBLIC_ENABLED`. No new required environment names are added (`ADDITIONAL_REQUIRED_ENV_NAMES=''` is correctly specified, [lines 220–221](local path)).

### 2.2 Proof Format & Database Invariants
- **Catalog Proof Safe Rejection:** Inspection of [`deploy/release-proofs/item-hm/20260928000004-catalog.sql`](local path) confirms that `to_regclass` returns `NULL` when target tables do not exist before apply. The `LEFT JOIN pg_class` evaluates `count(c.oid) = 2` to `false` without raising SQL errors ([lines 4–28](local path)).
- **Structural Integrity & Privilege Checks:** The catalog proof relies on OID, type, argument, and dependency checks rather than deparsed source string matching (`pg_get_functiondef` / `prosrc`) ([lines 125–154](local path)). All table and function privileges are asserted individually per role ([lines 13–25](local path)). Format ends with `AS catalog_ok` followed by a standalone `\gset` line ([lines 217–218](local path)).
- **Rollback Order & Inverse:** Edge rollback is explicitly executed first before considering SQL inverse ([lines 1060–1075](local path)). The SQL inverse in `hm37-reserve-schema-rollback` ([lines 1096–1148](local path)) matches [`deploy/release-proofs/item-hm/20260928000004-rollback.sql`](local path) verbatim.

### 2.3 Read-Only Preconditions & Ancestry Checks
- **Two-Part HM6 Precondition:** Section 4 ([lines 321–486](local path)) correctly splits the HM6 precondition into Part A (schema migration 03 & helpers live from stack SHA `ad964ed158181ba1692dd05895f36fa7a1f87d3f`) and Part B (OAuth service & ingress live from SHA `826db6a34f235064a3a03c57377d8e32a35d2f05`). Both parts perform read-only verification of live state, image identity, discovery, JWKS, and disabled public authorization (`MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED !== "1"`).
- **Ancestry Verification:** Step `hm37-source-identity` ([lines 149–152](local path)) enforces that both `ad964ed1` and `826db6a3` are local ancestors of `eb2a87ac`.
- **HM2 Baseline:** Migration 02 precondition is verified read-only ([line 492](local path)).

### 2.4 Container Recreation & Log Preservation
- **Saved Container Logs:** Both forward edge switch (`runbook-32`, Section 7, [line 712](local path)) and edge rollback (`runbook-42`, Section 11, [line 1060](local path)) enforce runbook outgoing-container log capture (`save_outgoing_container_logs`) prior to changing symlinks or recreating containers.
- **Caddy Isolation:** The plan explicitly sets `API_CADDY_PAIR=no` and `MCP_CADDY_RELEASE=no` ([line 513–514](local path)) and performs zero Caddy configuration edits, rollouts, or reloads ([lines 62–68](local path)).

### 2.5 Script Validity & macOS /bin/bash 3.2 Compatibility
- **Step Identifier Rule:** Every runnable code block is enclosed in a standalone ```sh block beginning with `# step: <id>`.
- **Bash 3.2 Compatibility:** All Mac mini steps (`hm37-source-identity`, `hm37-read-window-suffix`, `hm37-public-boundaries`, `hm37-validate-local-credential`) parse cleanly without syntax errors under `/bin/bash` 3.2. Constructs such as heredocs inside `$()`, associative arrays, `${var,,}`, `mapfile`, `|&`, `&>>`, and `wait -n` are completely avoided.
- **Principal Suffix Derivation:** All principal names in Section 5 (`hm37-hosted-${WINDOW_PRINCIPAL_SUFFIX}`, `hm37-local-${WINDOW_PRINCIPAL_SUFFIX}`, `hm37-sender-${WINDOW_PRINCIPAL_SUFFIX}`) derive strictly from `WINDOW_PRINCIPAL_SUFFIX` ([lines 556–563](local path)).

---

## 3. NITS

1. **Supporting Test Hashes in Inventory:** Section 3 lists SHA-256 digests for supporting documentation and test suite files (e.g. `tests/box-window-plans.test.ts`). These provide helpful repository integrity baseline records, though production runtime artifacts are governed by archive manifests.
2. **Caddy Maintenance Config Presence:** Caddy configuration files are included in the repository release archive for manifest completeness, but the plan correctly flags both `API_CADDY_PAIR=no` and `MCP_CADDY_RELEASE=no` to ensure no live Caddy actions take place during this window.

---

VERDICT: PASS (no KEEP)