### Scope & External Dependencies (Part Q4b of 7)

This part covers changes to migration tooling scripts in `deploy/supabase-stack/migrate/`:
- `dump-source.sh`
- `lib.sh`
- `prepare-target.sh`
- `restore-cron-jobs.sh`
- `run-db-tool.sh`
- `verify-counts.sh`

#### Dependencies Not Present in This Part
- `activity-publish-grants.sql` (referenced in `prepare-target.sh:97`): applied to configure `commonswarm_edge` grants.
- `apply-h0-upgrade.sh` and `verify-post-upgrade-counts.sh` (allowed in `run-db-tool.sh:18`): migration runner scripts reviewed in other parts.
- Pinned migrations `20260916000001_agent_join_credentials.sql` and `20260916000002_agent_join_attempts.sql` (checked in `run-db-tool.sh:94`).
- Backup service unit (`commonswarm-backup.service`) and host runner: responsible for provisioning the `[backup]` section in `PGSERVICEFILE` and orchestrating execution.

---

### Detailed Review

#### 1. Backups and Restore Drill
- **Read-Only Invariants**: `assert_backup_ro_identity` in [lib.sh:109-127](file:///deploy/supabase-stack/migrate/lib.sh#L109-L127) enforces 10 separate guards against the target connection before any dump proceeds:
  - Database is `postgres` on server `172.31.0.10` from host client `172.31.0.1`.
  - Stack identity is pinned to `'n-db-target-v1'`.
  - Server is not in recovery (`NOT pg_is_in_recovery()`).
  - Session is explicitly read-only (`current_setting('transaction_read_only') = 'on'`).
  - Transport must be SSL encrypted (`EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl)`).
  - Role must be strictly `backup_ro`, non-superuser (`NOT rolsuper`), with `rolbypassrls` (avoiding silent omission of RLS-protected rows), and holding `USAGE` on `pg_read_all_data`.
  Because `backup_ro` lacks write privileges and `transaction_read_only` is enforced, `dump-source.sh backup` cannot drop, write to, or corrupt the production database.
- **Consistent Storage Snapshot**: [dump-source.sh:176-191](file:///deploy/supabase-stack/migrate/dump-source.sh#L176-L191) dumps physical object metadata (`bucket, name, version`) from `storage.objects` inside the identical synchronized PostgreSQL snapshot (`SET TRANSACTION SNAPSHOT :'snapshot_id'` in `ISOLATION LEVEL REPEATABLE READ READ ONLY`), ensuring storage object inventory matches the database dump.
- **Credential Hygiene**: Credentials are never passed on argv or logged. Both `psql` and `pg_dump` read `PGSERVICEFILE` and `PGPASSFILE`. Exported metadata artifacts (`storage-objects.ndjson`, `storage-backend-objects.ndjson`) are explicitly set to `0600`.

#### 2. H0 Upgrade and Verification
- **Target Guards**: In [run-db-tool.sh:18-21](file:///deploy/supabase-stack/migrate/run-db-tool.sh#L18-L21), `apply-h0-upgrade.sh` and `verify-post-upgrade-counts.sh` are constrained to only accept `target`. Running either against `source` is rejected with exit status 64.
- **Pre-flight Migration Check**: [run-db-tool.sh:93-103](file:///deploy/supabase-stack/migrate/run-db-tool.sh#L93-L103) verifies the existence of pinned migrations (`20260916000001_agent_join_credentials.sql`, `20260916000002_agent_join_attempts.sql`) in the repository before launching Docker, mounting them read-only (`:ro`) to `/migrations`.

#### 3. Activity Publish Grant
- In [prepare-target.sh:97-103](file:///deploy/supabase-stack/migrate/prepare-target.sh#L97-L103), `activity-publish-grants.sql` is verified to exist, `assert_target_identity` is executed before applying changes, and execution is handled via `target_psql`. Any failure under `set -euo pipefail` halts execution immediately.

#### 4. Read Edge and CLI Changes (#22)
- No read edge or CLI code exists within this part.

#### 5. Test Verification & Docs vs. Code
- **Cron Listing Multiset Comparison**: [lib.sh:220-284](file:///deploy/supabase-stack/migrate/lib.sh#L220-L284) replaces strict `diff -u` with `compare_cron_job_listings` in [restore-cron-jobs.sh:69](file:///deploy/supabase-stack/migrate/restore-cron-jobs.sh#L69) and [verify-counts.sh:60](file:///deploy/supabase-stack/migrate/verify-counts.sh#L60).
  - Normalizes collation variance (e.g. `_` vs. `-` ordering between glibc versions on hosted Supabase and Hetzner) using `LC_ALL=C sort` in temporary files.
  - Verifies exact line counts (`grep -c .`) before diffing to preserve multiplicity without altering the original files.
  - Safely handles empty listings (grep status 1) and creates temporary sort files with mode `0600`, cleaning them up via an `EXIT` trap.

---

### Findings

#### [RIGOUR] `run-db-tool.sh` rejects `dump-source.sh backup`
- **Location**: [deploy/supabase-stack/migrate/run-db-tool.sh:16](file:///deploy/supabase-stack/migrate/run-db-tool.sh#L16) (compare with [deploy/supabase-stack/migrate/dump-source.sh:7,12](file:///deploy/supabase-stack/migrate/dump-source.sh#L7-L12))
- **Concrete Sequence**:
  1. An operator or test runner executes `./deploy/supabase-stack/migrate/run-db-tool.sh dump-source.sh backup` as documented in `dump-source.sh:7` (`usage: dump-source.sh source|target|backup`) and guided by `dump-source.sh:12` (`run through run-db-tool.sh so database credentials stay in protected files`).
  2. `run-db-tool.sh:16` evaluates `[[ $# -le 1 && ( $# -eq 0 || "$1" == source || "$1" == target ) ]]`.
- **What Operator Sees**: `run-db-tool.sh` prints usage instructions to stderr and exits with status 64.
- **Impact**: Non-blocking for automated production backups because the scheduled backup service provisions its own isolated `backup_ro` service file and container directly (not via `run-db-tool.sh`, which is intended for admin connections). However, operator manual testing or tool scripts invoking `dump-source.sh backup` through `run-db-tool.sh` will fail.

---

VERDICT: PASS (Migration tooling changes maintain database security, strict read-only backup identity, and robust multiset comparison; minor CLI parameter inconsistency in run-db-tool.sh is non-blocking in production and can be fixed forward)
