# Database and file backups

`run-backup.sh` exports the container database through the host bridge as
`backup_ro`, with certificate verification and read-only transactions. The
custom dump, table counts, cron jobs, and physical object versions share one
exported snapshot. Restore tools still require the separate admin identity.

`upload-snapshot.py` copies the exact physical R2 object versions named by that
snapshot. Missing versions, a failed byte comparison, or a partial database
upload fail the run. It writes the remote `COMPLETE.json` marker only after the
objects and database files pass download-based comparison. Failed sets can
remain in the bucket without a completion marker; do not restore those sets.

Local sets are private directories under `/var/backups/commonswarm-postgres`.
Offsite sets use `r2:yulan-vps-1-backups/000-commonswarm-postgres/<unique-id>`.
The `000-` prefix sorts before the host's dated backups. Before and after upload,
the runner checks that the existing host restore job still selects a dated root
folder. It never edits or deletes existing host backups. No local or remote
pruning is included here.

The bucket has an operator-verified 35-day deletion rule and public access is
disabled. Store the dashboard observation at
`/etc/commonswarm-backup/retention-evidence.json`, readable by root only. Each set
keeps that observation and its original date. This is not a bucket lock and does
not prevent an administrator from deleting data early. Recheck the rule before
cutover and after any bucket-policy change. R2 versioning is not a prerequisite.

## Install after review and a live restore proof

Keep `/home/commonswarm/.env` private. The database exporter reads only
`BACKUP_RO_PASSWORD`; the file copier uses the existing Storage API AWS
credentials in its child process environment. It does not change rclone config.
Host PostgreSQL 17 clients, Node, Python 3, rclone, and flock must be installed.

Place the reviewed stack release at `/home/commonswarm/stack/current`, including
this directory. Copy the service and timer to `/etc/systemd/system`, reload
systemd, then start `commonswarm-postgres-backup.service` once. Check its exit
status, the private local status file, and the remote completion marker. Enable
`commonswarm-postgres-backup.timer` only after that run and a restore pass. The
timer runs at 03:45 UTC with up to five minutes of jitter. Existing host cron jobs
remain unchanged.

The status file starts each run with `ok: false` and `state: running`. Success is
published only after offsite verification. A killed run cannot leave the prior
run's successful status looking current. The backup and the restore drill take
one lock, `/var/lock/commonswarm-postgres-maintenance.lock`. If either holds
that lock, the other exits 75 and does not start.

## Restore verification

1. Select a set with a valid remote `COMPLETE.json`. Download its `database/`
   directory into a new private directory. Run `sha256sum --check SHA256SUMS`.
2. Create a fresh isolated database using the pinned image from `VERSIONS.md`.
   Give it a new internal network and data directory, no host ports, and set
   `cron.launch_active_jobs=off`. Never use the production address or data volume.
3. Use the existing local-rehearsal identity settings, then run `restore-target.sh`,
   `prepare-target.sh`, `restore-cron-jobs.sh`, and `verify-counts.sh` in that order.
   All selected table counts and all cron definitions must match the artifact.
4. Check the offsite `objects/` keys against `physical-object-keys.txt`, including
   cardinality. Restore those exact physical keys into a separate test bucket,
   preserve database object versions, and prove a Storage API download against
   the restored database. Do not copy from the old hosted Supabase source.
5. Keep the production restore blocked until the isolated database and file
   recovery tests pass. A database-only restore is not a full backup proof.

For an approved real recovery, restore object bytes to their original physical
keys before admitting writes. Keep cron jobs disabled until the stack is ready.
Do not use the migration's source-to-target storage copy for nightly recovery:
its source is the old hosted system, not this backup set.

## Local gates

Run `python3 deploy/supabase-stack/backup/test_upload_snapshot.py`, shell syntax
checks for the backup scripts, the repository tests, and the real isolated
restore. The Python tests inject missing objects, corrupt bytes, incomplete
uploads, and a bad completion marker; they do not access any cloud service.


## Weekly offsite restore and alerts

`restore-drill.py` selects the newest completed offsite set verified within 36
hours. It validates the complete checksum inventory, restores a new isolated
PostgreSQL container, and runs the existing table-count and cron comparisons.
Every file is then read through Storage API and compared with the offsite bytes.
Only temporary read-only credentials scoped to that snapshot reach Storage API.

The test database has no public ports and cron execution is disabled. Storage
uses a separate run-owned network for R2 access, not the shared Docker bridge. Each run
labels its own containers and network. Success requires their removal, including
the database volume, and deletion of temporary credential files. A failed check,
interrupt, deadline, or cleanup returns nonzero and keeps `restore-status.json`
false. Logs and the newest drill directories remain private on the host. The
drill keeps the current run's directory plus one earlier run under
`/var/backups/commonswarm-postgres/restore-drill`. `DRILL_WORKDIR_KEEP = 2`
counts the current run. It deletes only older child directories whose names
are 32 hexadecimal characters. It does not delete other names in that
directory, and it does not delete offsite backups.

The timer runs Sunday at 04:45 UTC, with up to five minutes of jitter. Work has a
three-hour deadline; the systemd service allows four hours including cleanup.
The existing host PostgreSQL backup and restore timers are separate.

Install both new restore units and the updated backup service from the reviewed
release. Store `HC_BACKUP_URL` and `HC_RESTORE_URL` in the root-only mode-0600 file
`/etc/commonswarm-backup/healthchecks.env`. Both units ping at start and on exit;
exit pings require a successful status file with the same systemd invocation ID
as the start hook and finish hook, plus a successful systemd result. File times
are not used to infer which run wrote a status. Missing config or failed delivery is an error. A failed start ping does not
prevent the backup or restore from running; a failed finish ping fails the unit. Never print these URLs.
Run a first full restore service successfully before enabling its weekly timer.
Confirm a controlled failure and recovery in the alert service's event and
email delivery records before claiming alert readiness.

## Apply unit file changes on a box that already runs them

The unit file names do not change. systemd reads the copies in
`/etc/systemd/system/`. A new `current` symlink does not reload those copies.

Stop both timers first. An old backup and a new drill must not run at the
same time.

```sh
systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
systemctl is-active commonswarm-postgres-backup.service commonswarm-postgres-restore.service
```

`systemctl is-active` prints one line per service. Wait until both services are
inactive. Do not proceed while either line is `active` or `activating`. Both
lines must be `inactive` or `failed`. Exit code 0 from this command means at
least one service is active.

Switch the release and copy the four unit files over the same names. Then
reload systemd, start both timers, and check that both are scheduled:

```sh
ln -sfn /home/commonswarm/stack/releases/<sha> /home/commonswarm/stack/current
cp /home/commonswarm/stack/current/deploy/supabase-stack/backup/commonswarm-postgres-backup.service /etc/systemd/system/
cp /home/commonswarm/stack/current/deploy/supabase-stack/backup/commonswarm-postgres-backup.timer /etc/systemd/system/
cp /home/commonswarm/stack/current/deploy/supabase-stack/backup/commonswarm-postgres-restore.service /etc/systemd/system/
cp /home/commonswarm/stack/current/deploy/supabase-stack/backup/commonswarm-postgres-restore.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
systemctl list-timers commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
```

`systemctl list-timers` must show both timers. Do not start
`commonswarm-postgres-backup.service` or
`commonswarm-postgres-restore.service`. A start runs a backup or a drill.

Run `python3 deploy/supabase-stack/backup/test_restore_drill.py` and
`python3 deploy/supabase-stack/backup/test_notify_healthcheck.py`. The controls
inject failed restore steps, corrupt/missing files, wrong targets, signals,
cleanup errors, unowned resources, stale snapshots and false-success alert
conditions. Pure controls do not replace the first live offsite restore.

A hard kill can prevent cleanup. The private run directory retains
`ownership.json` with its exact random label. Inspect only resources carrying
that label before manual recovery; never prune other runs or the Docker host.
That manual recovery is separate from the directory bound above. The bound
deletes only old drill directories under the drill base.
