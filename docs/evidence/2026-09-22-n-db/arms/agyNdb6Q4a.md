### Part Q4a: H0 Upgrade and Verification Review

#### 1. Scope & Unchecked Dependencies
This review covers the H0 database upgrade sequence, its schema contract catalog verification, post-upgrade count verification, and the corresponding integration/unit tests introduced in PRs #20 and #21:
- `deploy/supabase-stack/migrate/apply-h0-upgrade.sh`
- `deploy/supabase-stack/migrate/verify-h0-catalog.sql`
- `deploy/supabase-stack/migrate/verify-post-upgrade-counts.sh`
- `deploy/supabase-stack/migrate/test-h0-upgrade.py`
- `deploy/supabase-stack/migrate/test-post-upgrade-counts.py`

**Dependencies outside this diff that cannot be checked directly:**
1. `deploy/supabase-stack/migrate/lib.sh`: Provides implementations of `assert_target_identity`, `target_psql`, `require_commands`, `require_vars`, `start_log`, `log`, and `make_temp_sql`.
2. `deploy/supabase-stack/migrate/verify-counts.sh`: Invoked by `verify-post-upgrade-counts.sh` to perform table-by-table row count comparisons against the derived TSV snapshot.
3. Migration SQL files (`/migrations/20260916000001_agent_join_credentials.sql` and `/migrations/20260916000002_agent_join_attempts.sql`): Pinned by literal SHA-256 digests in `apply-h0-upgrade.sh` and replayed in `test-h0-upgrade.py`.

---

#### 2. Target Identity, Database Guarding & Safety Against Wrong Database
- **Argument Guarding:** Both `apply-h0-upgrade.sh` (lines 7–10) and `verify-post-upgrade-counts.sh` (lines 4–7) explicitly restrict positional arguments before touching any database, checking environment variables, or sourcing `lib.sh`:
  ```bash
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != target ) ]]; then
    echo "usage: ... [target]" >&2
    exit 64
  fi
  ```
  Passing `source` or any unexpected argument exits immediately with code 64. This prevents accidental execution against source backups or replication sources.
- **Target-Identity Assertion:** Both scripts execute `assert_target_identity` before executing any target SQL. This verifies that `commonswarm.stack_identity` on the connected database matches `'n-db-target-v1'`. If the database marker does not match or is absent, execution terminates before any migration or count inspection occurs.
- **Verification of Guards:** Tested in `test-h0-upgrade.py` (which mutates `stack_identity` to `'wrong-target'` and confirms rejection across both apply and skip branches) and in `test-post-upgrade-counts.py` (`test_bad_target_identity_stops_before_queries`).

---

#### 3. Atomicity, Partial Application & False Success Reporting
- **Atomic Single-Transaction Wrapper:** In `apply-h0-upgrade.sh`, migrations `$file1` and `$file2`, followed immediately by the full catalog verifier script (`verify-h0-catalog.sql`), are assembled into a single SQL script executed within one explicit transaction:
  ```sql
  BEGIN;
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '30s';
  \i /migrations/20260916000001_agent_join_credentials.sql
  \i /migrations/20260916000002_agent_join_attempts.sql
  \i <verify_sql>
  COMMIT;
  ```
  Executed with `target_psql -v ON_ERROR_STOP=1`. If any statement or verification assertion fails, `psql` aborts immediately, rolling back the entire transaction.
- **Atomic Rollback Verification:** Tested in `test-h0-upgrade.py` by deliberately mutating `verify-h0-catalog.sql` to raise an exception, confirming that upon failure, exactly 0 H0 tables remain created in PostgreSQL.
- **Guard Against Mixed/Damaged Predecessor States:** In `apply-h0-upgrade.sh` (lines 41–50, 63–71), table count is inspected prior to migration:
  - If `table_count == 0`, it checks for orphan H0 trigger guard functions (`agent_join_credentials_guard`, `agent_join_attempts_guard`). If guards exist without tables, it detects a damaged partial state and aborts with `exit 1` instead of attempting `CREATE OR REPLACE`.
  - If `table_count == 1`, it detects an inconsistent catalog and aborts with `exit 1`.
  - If `table_count == 2`, it skips re-running migration DDL and proceeds to catalog verification for an idempotent skip check.
- **No False Success Reporting:** Because `set -euo pipefail` is active, any non-zero exit from `target_psql` halts the script immediately; the log line `"Catalog verified successfully."` is unreachable unless the entire migration and verification transaction committed.

---

#### 4. Structural Contract & Catalog Verification (`verify-h0-catalog.sql`)
- **Strict Structural Enforcement:** Checks exact relation properties (`relkind`, `relowner`, `relrowsecurity`, `relforcerowsecurity`, `reloptions`, `relacl`), exact column schema (names, types, nullability, defaults, identity, generated columns), constraints, indexes, triggers, and RLS policies.
- **Client Privilege Isolation:** Enforces that client roles `anon` and `authenticated` have zero effective permissions on `swarm.agent_join_credentials` and `swarm.agent_join_attempts` (across `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`). Verifies that `swarm_command` is granted only `SELECT`, `INSERT`, `UPDATE`, and explicitly forbids `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`.
- **Guards & Views:** Verifies trigger functions have `config = ["search_path=pg_catalog"]`, strict ACLs (`{swarm_admin=X/swarm_admin}`), and matching SHA-256 function body digests. Views (`swarm_read.agent_principals`, `swarm_read.agent_runs`, `swarm_read.my_devices`) have `security_barrier=true` and verified SHA-256 view definitions.
- **Dependency & Idempotency Checks:** Validates dependency indexes (`agent_principals_principal_workspace_owner`, `agent_tokens_token_principal_run`) and the idempotency constraint `idempotency_keys_principal_kind_check`.

---

#### 5. Post-Upgrade Row Count Verification (`verify-post-upgrade-counts.sh`)
- **Baseline Immutability:** Keeps `$MIGRATION_ARTIFACT_DIR/source-counts.tsv` read-only. Operates within an isolated private directory (`$derived`, mode `0700`).
- **Exact Catalog Set Comparison:** Queries `pg_tables` for target tables across all stack schemas (`auth`, `public`, `realtime`, `storage`, `supabase_migrations`, `swarm`, `swarm_read`). The `awk` verifier asserts:
  - Exact set match: any extra table not in baseline (or missing from baseline) fails immediately (`found != total`).
  - For a fresh upgrade, dynamically injects `swarm.agent_join_credentials` and `swarm.agent_join_attempts` with expected count `0`.
  - For recovery runs where H0 tables are already present in baseline, preserves their existing non-zero counts.
  - Passes the derived count file and copied cron jobs to `verify-counts.sh target`.

---

#### 6. Test Suite Validity (Docs vs. Code)
- `deploy/supabase-stack/migrate/test-post-upgrade-counts.py`:
  - 12 unit tests exercising `verify-post-upgrade-counts.sh` against mocked transports.
  - Confirms baseline immutability, recovery counts preservation, rejection of row changes in baseline/new tables, cron drift detection, extra/missing/duplicate tables, and rejection of `source` arguments before database access.
  - Tests fail for the exact reasons claimed.
- `deploy/supabase-stack/migrate/test-h0-upgrade.py`:
  - Executes against an isolated, official PostgreSQL 17 Docker container (`public.ecr.aws/supabase/postgres:17.6.1.147`) using synthetic credentials.
  - Exercises full migration apply, idempotent skip with OID verification, post-upgrade count verification, `stack_identity` guard mutations, orphan guard detection, and atomic rollback on verification failure.
  - Tests 10 separate catalog mutations (column nullability, constraint, index, trigger, RLS, ACL, guard body, view predicate, dependency index, idempotency constraint), verifying that every mutation is detected and rejected.

---

#### 7. Findings
No `PRODUCTION` or `RIGOUR` findings identified in this component. The implementation guarantees strict target identity isolation, transaction atomicity, exhaustive catalog contract enforcement, and reliable post-upgrade count verification.

VERDICT: PASS - H0 upgrade and verification enforce atomic migration, strict target-identity guards, comprehensive catalog and count validation, and robust rollback under failure.
