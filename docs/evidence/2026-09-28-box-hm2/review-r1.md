An analysis of the production release plan for CommonSwarm HM lane 2 (**`boxplan-hm2-v1.md`**) at release SHA `72c57e0d76d0aa86fe4f811a2cf51499919fed20` against the governing runbook `deploy/RELEASE-TO-BOX.md` and repository state has been completed.

---

### Key Verification & Findings

#### 1. Release Identity & Measured Shape Recomputation
* **Diff & Inventory Verification**:
  * [boxplan-hm2-v1.md:80-88](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L80-L88): Verified that the 6 modified paths under `supabase/` match repository changes between baseline `9b085c82` and target SHA `72c57e0d`.
  * [boxplan-hm2-v1.md:91-99](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L91-L99) & [deploy/RELEASE-TO-BOX.md:275](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/RELEASE-TO-BOX.md#L275): Recomputed runbook parameters:
    * `KIND_LIST` = `edge stack` (migrations present + edge functions changed).
    * `CHANGED_FUNCTIONS` = `command read` (direct entry points) / `command read capability activity h0 mcp` (effective inventory selection because `ROUTER_CHANGED` = `yes`).
    * `ROUTER_CHANGED` = `yes` (`deploy/edge-runtime/main/router.ts` modified).
    * `ADDITIONAL_REQUIRED_ENV_NAMES` = Empty (no new mandatory environment variables required).

#### 2. Verification Proofs & Database Operations
* **Pre-Apply Catalog False Without Error**:
  * [deploy/release-proofs/item-hm/20260928000002-catalog.sql:1-98](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000002-catalog.sql#L1-L98): Catalog checks wrap missing objects via `to_regclass` and `to_regprocedure` inside `LEFT JOIN` queries with `COALESCE(..., false)`. Pre-apply evaluation correctly evaluates to `catalog_ok = false` without raising SQL errors.
  * Array comparisons (`oid[]`, `text[]`) and role privileges (`SELECT`, `INSERT`, `UPDATE` checked independently per table) are strictly type-safe.
* **Functional Proof Timing**:
  * [deploy/RELEASE-TO-BOX.md:1177-1179](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/RELEASE-TO-BOX.md#L1177-L1179) & [boxplan-hm2-v1.md:225-240](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L225-L240): Migration `20260928000002` is intentionally omitted from the Section 5 skip list and automatically executes during Section 5 database apply. Step `# step: hm2-functional-section5` accurately validates `20260928000002-functional.txt = t`.
* **Rollback & Order**:
  * [boxplan-hm2-v1.md:706-794](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L706-L794): Rollback order strictly restores `PREVIOUS_EDGE` first and verifies health before executing schema rollback. Schema rollback is guarded in a single transaction that checks for existing hosted state before running inverse DDL ([20260928000002-rollback.sql:1-19](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000002-rollback.sql#L1-L19)) and catalog verification ([20260928000002-rollback-catalog.sql:1-20](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000002-rollback-catalog.sql#L1-L20)).

#### 3. CLI Commands, Boundary Controls & Safety
* **CLI Commands**:
  * [boxplan-hm2-v1.md:153,374,482,505,529,537,601,663](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L153) & [src/cli.ts:1-150](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/src/cli.ts#L1-L150): No hosted seeds are created. All referenced CLI commands (`principal create`, `token mint`, `setup`, `note`, `check`, `principal revoke`) exist in `cswarm`.
* **Public Boundary Integrity**:
  * [boxplan-hm2-v1.md:125,272-318](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L125): Public grant issuance is disabled. `# step: hm2-public-boundaries` validates that `claim_hosted_seat` and `activate_hosted_mcp_grant` return `403 Forbidden` without bearer tokens.
* **Safety & Formatting**:
  * All 10 runnable code blocks in `boxplan-hm2-v1.md` ([lines 56, 230, 263, 355, 408, 465, 521, 593, 648, 721](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L56)) are isolated ```sh blocks formatted with `# step: <id>`.
  * No `HOME` re-assignments, `rm -rf` of variables, secrets in command line arguments, or Docker calls on the Mac mini exist.
  * Every control step enforces `set -euo pipefail` and explicit assertions that fail closed.

---

### Categorized Findings

#### KEEP (Production-Blocking Defects)
* None.

#### NITS (Informational / Style Notes)
1. **Repository Branch Note**: [boxplan-hm2-v1.md:41](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L41) notes local branch `main` at commit `ff27acf...` while `HEAD` is detached at target SHA `72c57e0d...`. This is an informational observation recorded during measurement.
2. **Changed Functions Notation**: [boxplan-hm2-v1.md:95](file:///Users/yulanbot/.local/state/alloy/runs/20260928T033013Z-85b43c/antigravity/prompt_in/prompt.md#L95) notes `CHANGED_FUNCTIONS` directly from entry-point diff as `command read`, which is immediately reconciled on line 97 with the effective inventory selection `command read capability activity h0 mcp` triggered by `ROUTER_CHANGED=yes`.

---

VERDICT: PASS (no KEEP)