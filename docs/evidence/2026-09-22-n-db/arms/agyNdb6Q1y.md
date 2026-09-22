# D-036 Review: Part Q1y — Backup Scripts (`lane/n-db-stack`)

This review covers the backup scripts introduced in PR #18:
- `deploy/supabase-stack/backup/dump-database.sh`
- `deploy/supabase-stack/backup/make-backup-service.mjs`
- `deploy/supabase-stack/backup/run-backup.sh`
- `deploy/supabase-stack/backup/upload-snapshot.py`
- `deploy/supabase-stack/backup/notify-healthcheck.py`

---

### External Dependencies Outside Part Q1y (Cannot Be Checked in this Call)

The following dependencies are invoked or referenced by the backup scripts but are not included in this diff and must be verified in their respective review calls:
1. **`deploy/supabase-stack/migrate/dump-source.sh`**: Executed by `dump-database.sh:27` (`bash "$stack_dir/migrate/dump-source.sh" backup`). Dependency required to confirm it strictly obeys `PGSERVICE=backup`, sets read-only transactions, respects `row_security=off` under role `backup_ro`, and outputs required files (`database.dump`, `roles.sql`, `manifest.txt`, `source-counts.tsv`, `storage-objects.ndjson`, `cron-jobs.ndjson`, `storage-backend-objects.ndjson`, and `logs/`).
2. **Systemd Service & Timer Units** (`commonswarm-backup.service`, `commonswarm-backup.timer`, `commonswarm-restore-drill.*`): Systemd unit definitions required to confirm `ExecStartPre` / `ExecStopPost` calls to `notify-healthcheck.py`, unit sandboxing, `User=`/`Group=` execution context, and systemd `INVOCATION_ID` provisioning.
3. **Restore Drill Scripts** (PR #19): Scripts managing network isolation, disposable database creation, outbound firewall rules, and verify steps for the weekly drill.
4. **H0 Upgrade Scripts & Target-Identity Guards** (PR #20): Migration and upgrade verification logic.
5. **Private Activity Publish Grant** (PR #21): SQL schema changes and RLS policies.
6. **Read Edge & CLI Model/Session Changes** (PR #22): Edge function and CLI parameter handling.
7. **Host Configuration & Static Evidence**: Pre-existing files on `yulan-vps-1` (`/etc/ssl/yulan-internal-ca.pem`, `/etc/commonswarm-backup/healthchecks.env`, `/etc/commonswarm-backup/retention-evidence.json`, `/home/commonswarm/.env`).

---

### Analysis of Backup Scripts (PART Q1y)

#### 1. Read-Only Production Access & Backup Destination Isolation
- **Database Read-Only Enforceability**:
  - `make-backup-service.mjs:14-24` defines connection `[backup]` connecting to `hostaddr=172.31.0.10` via user `backup_ro`. It explicitly injects `options=-c default_transaction_read_only=on -c row_security=off` into the connection service definition.
  - `dump-database.sh:26` unsets all libpq environment overrides (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGOPTIONS`, etc.), forcing all client tools (`dump-source.sh`, `pg_dumpall`) to route through the restricted service definition.
  - `pg_dumpall --globals-only --no-role-passwords` (`dump-database.sh:28`) and `pg_dump` only execute read queries against Postgres system catalogs.
- **File Storage Read-Only Enforceability**:
  - In `upload-snapshot.py:122-132`, production storage bucket `csfiles:commonswarm-files` is used strictly as a source:
    - `rclone copy source destination/objects --files-from-raw ... --immutable`
    - `rclone check source destination/objects --files-from-raw ... --download --one-way`
  - Neither `rclone copy` nor `rclone check` writes to, modifies, or deletes anything in `source`.
  - All writes are strictly constrained to `destination = PREFIX + '/' + snapshot` (`r2:yulan-vps-1-backups/000-commonswarm-postgres/<timestamp>-<uuid>`).
- **Host Restore Safety**:
  - Existing VPS host backups use root directories formatted as timestamp `\d{8}T\d{6}Z`.
  - `upload-snapshot.py:38-46,105,140` verifies that `000-commonswarm-postgres` lexicographically sorts *before* host backup timestamps, checks `max(names)` before and after upload, and asserts `after >= before`. This ensures the new prefix cannot hijack or alter the host restore script's `names[-1]` backup selection.

#### 2. Credential Isolation & Leakage Prevention
- **Process Argument (`argv`) & Log Safety**:
  - `make-backup-service.mjs:8` verifies `((stat(envPath)).mode & 0o077) === 0` (environment file must not be accessible to group or others).
  - Credentials are written to an ephemeral directory created via `mktemp -d` (`dump-database.sh:20`) with an immediate `trap 'rm -rf -- "$protected_dir"' EXIT`.
  - Passwords and keys never appear in process arguments (`argv`). `PGPASSFILE` and `PGSERVICEFILE` are supplied via file paths. `pg_dumpall` uses `--no-role-passwords` so password hashes do not leak into `globals.sql`.
  - Object store credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are passed to `rclone` exclusively through in-memory child process environment variables (`child_env['RCLONE_CONFIG_CSFILES_*']`, `upload-snapshot.py:82-88`).
  - `upload-snapshot.py:157-160` catches exceptions and outputs only `type(error).__name__` to `stderr`, suppressing sensitive tracebacks, command arguments, or object paths.
  - `notify-healthcheck.py:68-71` catches exceptions and logs only `type(error).__name__`, keeping healthcheck capability UUIDs out of logs and process listings.

#### 3. Failure Detection, Integrity Verification & Alerting
- **Strict Multi-Phase Integrity Verification**:
  - In `dump-database.sh:30-33`, 8 database artifact files (`database.dump`, `roles.sql`, `manifest.txt`, `source-counts.tsv`, `storage-objects.ndjson`, `cron-jobs.ndjson`, `globals.sql`, `storage-backend-objects.ndjson`) are asserted to exist and hashed into `SHA256SUMS`.
  - In `upload-snapshot.py:101-104`, `sha256sum --check SHA256SUMS` verifies pre-upload artifact integrity.
  - Physical object manifest counts from `storage-backend-objects.ndjson` are verified against database row counts in `source-counts.tsv` (`len(rows) == int(counts['storage.objects'])`, line 108).
  - All physical object paths are strictly checked against path traversal (`..`, `.`, empty segments, control characters, line breaks, duplicate keys; lines 21-34).
  - After copying objects, `upload-snapshot.py:127-131` compares destination listing against source keys and runs `rclone check --download --one-way` to verify full payload byte equality.
  - Database files are similarly copied with `--immutable` and byte-checked with `rclone check --download --one-way` (lines 137-138).
  - Remote completion marker `COMPLETE.json` is copied with `--immutable` and read back with `rclone cat` to confirm write-read consistency (lines 146-149).
- **Failure Alerting & Prevention of False Success**:
  - `run-backup.sh:17-19` writes `{"ok":false,"state":"running",...}` to `/var/backups/commonswarm-postgres/status.json` before execution begins and traps `ERR` to write `{"ok":false,...}` on failure.
  - If a backup fails at any stage (flock busy, dump failure, upload failure, verification mismatch), `status.json` reflects `ok: false`.
  - `notify-healthcheck.py:46-57` enforces that a success ping (`ping(url, '')`) is sent **only** if:
    1. Systemd `SERVICE_RESULT == 'success'`
    2. `status.get('ok') is True`
    3. `status.get('database_bytes_verified') is True`
    4. `status.get('object_bytes_verified') is True`
    5. `INVOCATION_ID` is a valid 32-character hex string matching systemd
    6. `started == invocation_id` (matches the `/start` ping recorded in `kind-ping-start.json`)
    7. `status.get('invocation_id') == invocation_id` (verifies `status.json` was generated during this exact invocation and not retained from a prior run)
  - If any condition fails or an unhandled exception occurs, `notify-healthcheck.py` immediately pings `url + '/fail'`.
  - If `notify-healthcheck.py` cannot run or fails to connect, Healthchecks.io's scheduler/grace timer triggers an alert due to the missing completion ping following `/start`.

---

### Findings

No **PRODUCTION** or **RIGOUR** findings were identified in the backup scripts (`dump-database.sh`, `make-backup-service.mjs`, `run-backup.sh`, `upload-snapshot.py`, `notify-healthcheck.py`).

---

VERDICT: PASS The backup scripts strictly enforce read-only production access, private credential isolation, comprehensive byte verification, and fail-closed alerting with invocation tracking.
