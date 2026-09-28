I have completed the review of the diagnostic SQL script `deploy/release-proofs/item-hm/20260928000002-diagnostic.sql` against the four criteria specified in `prompt.md`.

---

### Analysis & Review Findings

#### 1. SAFETY
- **Check**: Starts with `BEGIN`, ends with `ROLLBACK`, never `COMMIT`s or `END`s, has no statements escaping the transaction (`VACUUM`, `CREATE DATABASE`, `DROP/ALTER SYSTEM`, `\!`, `\copy`, `dblink`, etc.), and leaves nothing behind.
- **Evidence**:
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L8](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L8)`: `BEGIN;` opens the transaction block after the header comments.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L343](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L343)`: `ROLLBACK;` closes the transaction block as the final SQL statement.
  - No `COMMIT` or `END` statements are present.
  - No DDL/DCL/utility commands escaping transaction boundaries exist in the file.
- **Result**: **PASS**

---

#### 2. Migration Inclusion and Box Path Resolution
- **Check**: Included exactly as runbook section 5 applies it (`deploy/RELEASE-TO-BOX.md`), with valid path resolution on the server.
- **Evidence**:
  - `[deploy/RELEASE-TO-BOX.md#L757-L759](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/RELEASE-TO-BOX.md#L757-L759)`: `release_psql` mounts `$STACK_RELEASE/supabase/migrations` at `/migrations:ro` and `$PROOF_DIR` at `/proof:ro`.
  - `[deploy/RELEASE-TO-BOX.md#L1173](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/RELEASE-TO-BOX.md#L1173)`: Section 5 applies migrations via `\i /migrations/$MIGRATION_FILE`.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L11](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L11)`: `\ir ../migrations/20260928000002_hm_hosted_authority.sql`. When executed as `/proof/20260928000002-diagnostic.sql`, `psql` evaluates `\ir` relative to `/proof`, resolving to `/migrations/20260928000002_hm_hosted_authority.sql`, matching line 1173 of the runbook exactly.
  - `[supabase/migrations/20260928000002_hm_hosted_authority.sql#L1](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/supabase/migrations/20260928000002_hm_hosted_authority.sql#L1)`: Target migration file exists in the repository.
- **Result**: **PASS**

---

#### 3. Predicate Parity with Catalog Proof
- **Check**: Every AND-ed predicate of `20260928000002-catalog.sql` appears as its own named boolean column with identical SQL, plus the overall result; none is missing or altered.
- **Evidence**:
  - `[deploy/release-proofs/item-hm/20260928000002-catalog.sql#L16-L85](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-catalog.sql#L16-L85)` vs `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L28-L212](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L28-L212)`:
    - `table_predicates` (lines 43-56) breaks out all 11 conditions of `table_checks` with identical SQL expressions (`authority_table_count_is_4`, `authority_tables_exist`, `authority_tables_are_tables`, `authority_table_owners_are_swarm_admin`, `authority_table_rls_enabled`, `swarm_command_table_select`, `swarm_command_table_insert`, `swarm_command_table_update`, `swarm_read_table_select_denied`, `authenticated_table_select_denied`, `anon_table_select_denied`).
    - `policy_predicates` (lines 81-90) breaks out all 4 conditions of `policy_checks` with identical SQL (`swarm_command_policy_count_is_4`, `policy_names_are_swarm_command_all`, `policies_apply_to_all_commands`, `policy_roles_are_swarm_command`).
    - `function_predicates` (lines 116-133) breaks out all 10 conditions of `function_checks` with identical SQL (`hosted_function_count_is_3`, `hosted_functions_exist`, `hosted_functions_are_security_definer`, `hosted_functions_are_stable`, `hosted_function_owners_are_swarm_admin`, `hosted_function_search_path_is_fixed`, `authenticated_function_execute_denied`, `anon_function_execute_denied`, `allowed_role_function_execute`, `denied_role_function_execute_denied`).
    - `view_predicates` (lines 160-172) breaks out all 9 conditions of `view_checks` with identical SQL (`hosted_view_count_is_2`, `hosted_views_exist`, `hosted_views_are_views`, `hosted_views_have_security_barrier`, `hosted_view_owners_are_swarm_admin`, `authenticated_view_select`, `swarm_read_view_select`, `anon_view_select_denied`, `hosted_view_definitions_use_auth_uid`).
    - `composite_predicates` (lines 199-212) breaks out both FK checks (`hosted_mcp_seats_composite_fk_exists`, `hosted_mcp_seat_handles_composite_fk_exists`).
    - `idempotency_check` (lines 227-233) captures `idempotency_principal_kinds_include_hosted_values`.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L348-L359](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L348-L359)`: Computes overall `catalog_ok` using identical AND-ed checks to `[deploy/release-proofs/item-hm/20260928000002-catalog.sql#L87-L98](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-catalog.sql#L87-L98)`.
- **Result**: **PASS**

---

#### 4. Error-Safety of Added "Actual Value" Columns
- **Check**: Added actual value text columns cannot error on production (e.g. missing objects, NULL OIDs, missing roles/constraints).
- **Evidence**:
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L58-L71](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L58-L71)` (`table_actuals`): Uses `COALESCE` with default fallback text (`'<missing>'`, `'<null>'`) for all `c.relkind`, `c.relowner`, `c.relrowsecurity`, `has_table_privilege`, and `c.relacl`.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L90-L97](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L90-L97)` (`policy_actuals`): Uses `COALESCE` for `p.polname`, `p.polcmd`, and `p.polroles::text`.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L134-L146](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L134-L146)` (`function_actuals`): Uses `COALESCE` around `has_function_privilege`, `p.prosecdef`, `p.provolatile`, `pg_get_userbyid`, `p.proconfig`, and `p.proacl`.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L173-L184](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L173-L184)` (`view_actuals`): Uses `COALESCE` on `pg_get_viewdef(c.oid)`, `reloptions`, `relowner`, and privileges.
  - `[deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L213-L240](file:///Users/yulanbot/.local/state/alloy/execution/worktrees/3e95010b2b134ac3/deploy/release-proofs/item-hm/20260928000002-diagnostic.sql#L213-L240)` (`composite_actuals` & `idempotency_actual`): Uses subqueries wrapped in `COALESCE(..., '<none>')` and `COALESCE(..., '<missing>')` so missing relations or constraints return clean text indicators rather than SQL errors.
- **Result**: **PASS**

---

### NITS
- None.

---

VERDICT: PASS (no KEEP)