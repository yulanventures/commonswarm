# Diagnostic SQL Review Panel Analysis

This consult review evaluates the diagnostic query in [`deploy/release-proofs/item-hm/20260928000003-diagnostic.sql`](local path) for execution against the production database following a catalog proof failure during migration `20260928000003_hm_oauth_store.sql`.

---

### 1. Safety Audit

- **Transaction Boundary**: The script opens with `BEGIN;` at [`20260928000003-diagnostic.sql:8`](local path), sets local lock and statement timeouts at [`20260928000003-diagnostic.sql:9-10`](local path), and terminates with `ROLLBACK;` at [`20260928000003-diagnostic.sql:756`](local path).
- **No Statements Escaping Transaction**: The script contains no `COMMIT`, `END`, `VACUUM`, `CREATE DATABASE`, `ALTER SYSTEM`, `DROP SYSTEM`, `\!`, `\copy`, or `dblink` commands.
- **Side Effects**: Because the transaction rolls back, all DDL/DML state changes applied by the migration inclusion are reverted completely. No temporary tables or permanent state escape the script.

---

### 2. Migration Inclusion & Path Resolution

- **Runbook Helper & Mount Paths**: In [`deploy/RELEASE-TO-BOX.md:747-784`](local path), `release_psql` mounts `$STACK_RELEASE/supabase/migrations` to `/migrations:ro` and `$PROOF_DIR` to `/proof:ro`.
- **Runbook Execution Pattern**: Runbook section 5 ([`deploy/RELEASE-TO-BOX.md:1199`](local path)) executes staged diagnostic files via `release_psql --file /proof/20260928000003-diagnostic.sql`.
- **Relative Path Resolution (`\ir`)**: The script includes the target migration at [`20260928000003-diagnostic.sql:11`](local path) using `\ir ../migrations/20260928000003_hm_oauth_store.sql`. Because `\ir` resolves relative to the executing script's directory (`/proof`), `../migrations/...` resolves to `/migrations/20260928000003_hm_oauth_store.sql`, which matches the container mount path exactly.

---

### 3. Predicate Alignment with Catalog Proof

- **Catalog Proof Structure**: The authoritative proof [`deploy/release-proofs/item-hm/20260928000003-catalog.sql:4-194`](local path) evaluates 36 AND-ed conditions.
- **Individual Boolean Predicate Columns**: In [`20260928000003-diagnostic.sql:50-211`](local path) (`predicates` CTE), all 36 predicates from the catalog proof appear as explicitly named boolean columns. Each expression matches the SQL expression in `20260928000003-catalog.sql` byte-for-byte.
- **Overall Result**: In [`20260928000003-diagnostic.sql:583-752`](local path) (`overall_result` CTE), the exact 36-predicate conjunction is evaluated as `catalog_ok`, guaranteeing fidelity with the catalog proof result.

---

### 4. Actual Value Columns & Production Safety

- **Missing Object Safety**: Object lookups in [`20260928000003-diagnostic.sql:30-49`](local path) use safe reg-functions (`to_regclass`, `to_regnamespace`, `to_regprocedure`, `to_regrole`).
- **Privilege Call Safety**: Privilege function calls in `actuals` ([`20260928000003-diagnostic.sql:421-582`](local path)) take OIDs that gracefully return `NULL` when objects are absent, wrapped with `COALESCE(..., '<missing>')` or `CASE WHEN`.
- **Casting Safety**: Casts such as `c.oid::regclass::text` at [`20260928000003-diagnostic.sql:448`](local path) execute inside `FROM pg_class AS c WHERE c.oid IN (...)`, guaranteeing `c.oid` is a valid OID when evaluated.
- **No Secrets Selected**: In `runtime_role_attributes_actual` ([`20260928000003-diagnostic.sql:426-434`](local path)), `rolpassword` is excluded. Only non-sensitive boolean flags (`rolsuper`, `rolcreaterole`, `rolcanlogin`, `rolinherit`, `rolbypassrls`, `rolcreatedb`, `rolreplication`) are queried.
- **Bounded Output**: All CTEs join on single-row lookups or aggregates, returning exactly 1 row in total.

---

### NITS

- The `predicate_details` CTE ([`20260928000003-diagnostic.sql:212-420`](local path)) breaks down multi-clause checks into individual boolean sub-predicates, making pinpointing of individual privilege failures trivial when executing `psql -x`.

---

VERDICT: PASS