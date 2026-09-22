### Scope & Unchecked Dependencies (PART Q1x)

**Reviewed in this call:**
- `deploy/supabase-stack/backup/README.md`
- `deploy/supabase-stack/backup/commonswarm-postgres-backup.service`
- `deploy/supabase-stack/backup/commonswarm-postgres-backup.timer`
- `deploy/supabase-stack/backup/commonswarm-postgres-restore.service`
- `deploy/supabase-stack/backup/commonswarm-postgres-restore.timer`
- `deploy/supabase-stack/compose.yaml`

**Dependencies in other parts (not checked in Q1x):**
- Implementation scripts: `run-backup.sh`, `upload-snapshot.py`, `restore-drill.py`, `notify-healthcheck.py`.
- Test suites: `test_upload_snapshot.py`, `test_restore_drill.py`, `test_notify_healthcheck.py`.
- H0 upgrade sequence and target-identity guard scripts (#20).
- Activity publish grant migrations and RLS policies (#21).
- Read edge (`read-agent-run`) and CLI schema field changes (#22).

---

### Findings

#### [PRODUCTION] PostgREST healthcheck uses non-existent `--ready` CLI flag, marking container permanently unhealthy
- **File & Line:** `deploy/supabase-stack/compose.yaml:137`
- **Concrete sequence:** 
  1. PR #17 replaced the working `/dev/tcp` HTTP socket check with `test: ["CMD", "/bin/postgrest", "--ready"]` and added `PGRST_SERVER_HOST: "0.0.0.0"` under the assumption that PostgREST provides a native `--ready` CLI flag.
  2. Upstream PostgREST is an HTTP server compiled in Haskell; its CLI accepts only `[-v|--version]`, `[-e|--example]`, `[-d|--dump-config]`, `[-s|--dump-schema]`, and `[FILENAME]`. It does not have a `--ready` command-line option.
  3. Every 10 seconds, Docker runs `/bin/postgrest --ready` inside the container. PostgREST rejects the option (`Invalid option '--ready'`) and exits with status code 1.
  4. After 12 retries (120 seconds), Docker marks the `rest` service container `unhealthy`.
- **What production or an operator sees:**
  `docker compose ps` shows `rest` in `(unhealthy)` state continuously on the live box. Any orchestrator or deployment step asserting container health (or dependent containers with `condition: service_healthy`) fails or blocks. Furthermore, true application readiness (verifying that the PostgREST schema cache has loaded against PostgreSQL) is never tested.

---

#### [RIGOUR] Backup service omits `docker.service` dependency in `Wants`/`Requires`
- **File & Line:** `deploy/supabase-stack/backup/commonswarm-postgres-backup.service:3-4`
- **Concrete sequence:**
  1. `commonswarm-postgres-backup.service` sets `After=network-online.target docker.service` and `Wants=network-online.target`, but does not include `docker.service` in `Wants=` or `Requires=`. (In contrast, `commonswarm-postgres-restore.service:5` specifies `Requires=docker.service`).
  2. If `docker.service` is stopped, crashed, or inactive when the backup timer elapses at 03:45 UTC, systemd will not attempt to start `docker.service`.
  3. `run-backup.sh` starts, fails to reach the PostgreSQL container over the host bridge, and fails immediately.
- **What production or an operator sees:**
  An unneeded backup failure alert is sent to Healthchecks if Docker was down or pending restart, rather than having systemd properly demand the Docker daemon dependency.

---

#### [RIGOUR] Inconsistent explicit unit assignment in restore timer
- **File & Line:** `deploy/supabase-stack/backup/commonswarm-postgres-restore.timer:4-7`
- **Concrete sequence:**
  1. `commonswarm-postgres-backup.timer` explicitly specifies `Unit=commonswarm-postgres-backup.service`.
  2. `commonswarm-postgres-restore.timer` omits `Unit=`. While systemd defaults to a service matching the timer prefix (`commonswarm-postgres-restore.service`), omitting the directive creates an unnecessary discrepancy between the two paired timers and risks silent failure if units are renamed or reorganized.
- **What production or an operator sees:**
  Functionally identical behavior on default systemd, but inconsistent unit configuration across the stack.

---

#### [RIGOUR] Lack of sequencing between backup and restore units on reboot catchup
- **File & Line:** `deploy/supabase-stack/backup/commonswarm-postgres-restore.service:3`
- **Concrete sequence:**
  1. Both `commonswarm-postgres-backup.timer` and `commonswarm-postgres-restore.timer` configure `Persistent=true`.
  2. If the VPS is powered off or rebooting across Sunday 03:45–04:45 UTC, both units catch up and are triggered by systemd simultaneously upon startup.
  3. Neither service unit defines `After=commonswarm-postgres-backup.service` or resource coordination.
  4. Both units run concurrently at `Nice=10` and `IOSchedulingPriority=7`, competing heavily for host CPU, disk I/O, and R2 network bandwidth during an already critical recovery/reboot window.
- **What production or an operator sees:**
  Host I/O and network saturation after a Sunday boot event, and the restore drill cannot test the newly executed backup because both started at the same moment.

---

VERDICT: FAIL - `deploy/supabase-stack/compose.yaml:137` uses non-existent `/bin/postgrest --ready`, causing the PostgREST container to continuously fail healthchecks and remain permanently unhealthy on the production box.
