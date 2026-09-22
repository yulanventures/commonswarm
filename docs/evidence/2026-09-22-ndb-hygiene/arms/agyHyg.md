### Production Safety Review

#### 1. Live Backup, Weekly Drill, and Migration Tools
- **Concurrency & Locking (`run-backup.sh:7-8`, `restore-drill.py:23`):** Both `run-backup.sh` and `restore-drill.py` share `/var/lock/commonswarm-postgres-maintenance.lock`. Both processes use non-blocking lock acquisitions (`flock -n 9` in Bash and `fcntl.flock(..., LOCK_EX | LOCK_NB)` in Python). Neither process will block indefinitely. If a backup is active, the restore drill exits with status 75; if a drill is active, the backup exits with status 75. Because both systemd units run as `root`, the `umask 077` in `run-backup.sh` (which creates the lock file with mode `0600`) does not prevent `restore-drill.py` from opening or locking the file. Unfinished or crashed runs release the advisory kernel flock upon process termination; status files retain `ok: false` and are never falsely reported as successful.
- **Directory Bounds & Cleanup Safety (`restore-drill.py:364-402`):** `prune_drill_workdirs` and `remove_drill_directory` strictly guard against path traversal and accidental deletion. Candidates must reside directly under `base_abs` (`child_abs.parent == base_abs`), must be directories, and must match `^[0-9a-f]{32}$`. Symlinks within `WORKDIR_BASE` are skipped during candidate discovery; symlinks encountered inside a drill directory are unlinked directly without traversing or deleting their target files/directories.
- **Unit Configuration & Timers (`RUNBOOK.md:453-468`, `backup/README.md:113-140`):** Adding `Requires=docker.service` to `commonswarm-postgres-backup.service` enforces that Docker is active when a backup executes. Adding `Unit=commonswarm-postgres-restore.service` to `commonswarm-postgres-restore.timer` explicitly links the timer to its service. Applying updates via `systemctl daemon-reload` and `systemctl try-restart ...` safely reloads active timers without triggering unintended immediate executions.
- **Target Identity Marker Gate (`lib.sh:94-101`, `make-pg-service.mjs:54-58`):** `assert_target_identity` no longer relies on `current_setting('commonswarm.stack_identity', true)`, which was vulnerable to session spoofing via URL/connection options (`-ccommonswarm.stack_identity=...`). It now queries `pg_db_role_setting` for `setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0 AND item = 'commonswarm.stack_identity=n-db-target-v1'`. This strictly inspects the persistent database-level configuration established by `ALTER DATABASE postgres SET "commonswarm.stack_identity" TO 'n-db-target-v1';`. Unmarked databases are rejected even if session options are supplied, and `make-pg-service.mjs` rejects URLs containing an `options` query parameter case-insensitively without leaking credentials.

---

### Completeness of the Five Items

1. **Target-identity gate & `options` URL rejection:** Complete. Database-level settings in `pg_db_role_setting` (`setrole = 0`) are queried via unnested `item = 'commonswarm.stack_identity=n-db-target-v1'`. `make-pg-service.mjs` case-insensitively rejects `options` in database URLs and omits URL secrets from error output.
2. **Truthful log in `prepare-target.sh`:** Complete. Line 97 logs `GRANT swarm_command, swarm_read, swarm_capability TO commonswarm_edge; other memberships were not revoked`, accurately reflecting that memberships are additive and existing source memberships remain intact.
3. **Restore drill temporary credential scope test:** Complete. `TempCredentialTests.test_minted_scope_is_object_read_only` decodes the minted session token and validates `scope == 'object-read-only'`, prefix paths, and bucket name.
4. **Unit dependencies, shared lock, and bounded work directories:** Complete. `backup.service` gains `Requires=docker.service`, `restore.timer` names its service unit, both units share `/var/lock/commonswarm-postgres-maintenance.lock`, and `prune_drill_workdirs` retains only the `DRILL_WORKDIR_KEEP = 2` newest 32-hex work directories.
5. **Row-security preflight in `activity-publish-grants.sql`:** Complete. Preflight block verifies `relrowsecurity` on `realtime.messages` is `true`. If `false` or missing, it raises SQLSTATE `55000`, aborting the transaction before granting privileges or creating policies.

---

### Verification of Test Failure Modes

- **`tests/p1-cli/n-db-target-marker.test.ts`:** Injects session connection option `-ccommonswarm.stack_identity=n-db-target-v1` against an unmarked database and verifies rejection (`status !== 0`). On the previous code where `current_setting()` was used, this check would fail. It also verifies that setting a conflicting session option against an appropriately marked database still succeeds.
- **`tests/p1-cli/supabase-stack.test.ts`:** Mutating `pg_db_role_setting` to `pg_settings` or reverting to `current_setting()` fails the structural checks. Passing `options=` and `Options=` to `make-pg-service.mjs` triggers non-zero exits while confirming passwords and URLs are not printed to standard streams.
- **`deploy/supabase-stack/migrate/activity-publish-grants.test.sh`:** Disables RLS on `realtime.messages` and executes `activity-publish-grants.sql`. Confirms exit is non-zero, logs SQLSTATE `55000`, and verifies via catalog queries that neither `USAGE`, `INSERT`, nor `commonswarm_edge_activity_insert` policy were created.
- **`deploy/supabase-stack/backup/test_restore_drill.py`:** Tests bounded directory cleanup with mock directories, symlinks, and files; tests that minted R2 credentials assert `object-read-only`; and validates unit file contents and shared lock definitions.

---

### Operator Steps in RUNBOOK and README

The instructions in [RUNBOOK.md](file:///deploy/supabase-stack/RUNBOOK.md#L453-L468) and [backup/README.md](file:///deploy/supabase-stack/backup/README.md#L113-L140) accurately detail copying all 4 unit files to `/etc/systemd/system/`, issuing `systemctl daemon-reload`, and using `systemctl try-restart` on the timer units. This ensures systemd recognizes the service changes on subsequent runs without triggering unintended immediate backup or restore drill execution.

---

### Findings

- **Finding 1 (RIGOUR): Retention count evaluation includes active workdir**
  - **Location:** [deploy/supabase-stack/backup/restore-drill.py:425-426](file:///deploy/supabase-stack/backup/restore-drill.py#L425-L426)
  - **Sequence:** `workdir.mkdir(parents=True, mode=0o700)` creates the current 32-hex run directory immediately before calling `prune_drill_workdirs(Path(WORKDIR_BASE), DRILL_WORKDIR_KEEP)`.
  - **Impact:** `workdir` is discovered by `prune_drill_workdirs` and sorted at index 0 of `candidates`. With `DRILL_WORKDIR_KEEP = 2`, `candidates[2:]` are removed, retaining the active run directory and exactly 1 prior completed drill directory on disk (total of 2). Operators inspecting `/var/backups/commonswarm-postgres/restore-drill` after a drill will see the run that just finished and the one immediately preceding it.
- **Finding 2 (RIGOUR): Explicit log matching for additive role grants**
  - **Location:** [deploy/supabase-stack/migrate/prepare-target.sh:96-97](file:///deploy/supabase-stack/migrate/prepare-target.sh#L96-L97), [deploy/supabase-stack/migrate/activity-publish-grants.test.sh:61-64](file:///deploy/supabase-stack/migrate/activity-publish-grants.test.sh#L61-L64)
  - **Sequence:** The logged statement `GRANT swarm_command, swarm_read, swarm_capability TO commonswarm_edge; other memberships were not revoked` is explicitly pinned in `activity-publish-grants.test.sh` via `grep -qx`.
  - **Impact:** Prevents regression to misleading log entries regarding role membership revocation while ensuring operator logs match the additive behavior of `prepare-target.sh`.

---

VERDICT: PASS — All five items are correctly and defensively implemented, all new tests fail under their targeted mutations, mutual exclusion between backup and restore is non-blocking and safe, directory pruning is strictly bounded, and operator migration instructions are verified.
