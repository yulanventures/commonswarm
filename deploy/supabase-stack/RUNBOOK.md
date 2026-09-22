# N-db cutover runbook — NOT RUN

This lane deployed nothing. HezLead runs every command in this file.

## Fixed design

- Compose project: `commonswarm-supabase-stack`.
- Network: existing external `commonswarm-net`, `172.31.0.0/24`.
- PostgreSQL: `commonswarm-postgres`, `172.31.0.10`, no published port.
- Loopback services: GoTrue `18001`, PostgREST `18002`, Realtime `18003`, Storage API `18004`.
- Edge functions: the existing edge lane on `127.0.0.1:9000`.
- Database: `postgres`. The host cluster's `commonswarm` database stays empty.
- Object bytes: R2 bucket `commonswarm-files` through Storage API.
- Service secrets: `/home/commonswarm/.env`, mode `0600`.
- Migration secrets: `/home/commonswarm/migration.env`, mode `0600`. Compose never mounts this file.
- TLS files: `/etc/commonswarm/pg-tls/server.crt`, `/etc/commonswarm/pg-tls/server.key`, and `/etc/commonswarm/pg-tls/ca.crt`. The CA is also `/etc/ssl/yulan-internal-ca.pem`.
- Source identity: `SOURCE_SYSTEM_IDENTIFIER` is read before the window with `SELECT system_identifier FROM pg_control_system()`.

The landed stack release is unpacked at `/home/commonswarm/stack/releases/<sha>` and `current` is a symlink to it. This lane's edge release, which carries the TLS helper, is unpacked at `/home/commonswarm/edge/releases/<sha>` and its `current` symlink is switched to it. This is the live edge release layout.

Define the release paths once in the operator shell. Use them for every command below:

```sh
STACK_DIR=/home/commonswarm/stack/current/deploy/supabase-stack
EDGE_DIR=/home/commonswarm/edge/current/deploy/edge-runtime
MIGRATE="$STACK_DIR/migrate"
```

Run the rehearsal, the cutover window, and the recovery drill from one root shell started with `sudo -i`. `run-db-tool.sh` runs its tool container as root and writes protected artifacts with root ownership and mode `0600`; changing between an unprivileged shell and `sudo` can make a later command unable to read an earlier log or artifact.

All container health waits use this one bounded pattern. `N` is 180 seconds for PostgreSQL, Storage API, and the edge. The helper checks for a non-empty container ID before inspection. On timeout it prints the container status and returns 1 (it never calls `exit`, so an operator's SSH shell stays open); read that exit code, stop, and apply the step's ABORT.

```sh
wait_healthy() {
  container_id="$1"
  label="$2"
  timeout_seconds="$3"
  if [ -z "$container_id" ]; then
    printf '%s\n' "$label container id is empty" >&2
    return 1
  fi
  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    [ "$health" = healthy ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '%s\n' "$label did not become healthy within $timeout_seconds seconds" >&2
      docker inspect --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" >&2 || true
      return 1
    fi
    sleep 2
  done
}
```

Every database URL names `db.commonswarm.internal` and uses `sslmode=verify-full`. GoTrue, PostgREST, and Storage API also use `sslrootcert=/etc/ssl/yulan-internal-ca.pem`. Realtime uses `DB_SSL=true` and `DB_SSL_CA_CERT=/etc/ssl/yulan-internal-ca.pem`. The edge URLs omit `sslrootcert`; the edge functions pass the CA as `ssl.ca` with certificate checks enabled.

The edge URLs use `commonswarm_edge`. GoTrue uses `supabase_auth_admin`. PostgREST uses `authenticator`. Storage API uses `supabase_storage_admin`. Realtime uses `supabase_admin`.

The memory total is 4060 MB. It includes PostgreSQL 1536 MB, Realtime 512 MB, GoTrue 300 MB, PostgREST 300 MB, Storage API 300 MB, edge runtime 512 MB, and 600 MB of headroom.

## What moves

`dump-source.sh` moves `auth`, `public`, `realtime`, `storage`, `supabase_migrations`, `swarm`, and `swarm_read`. It excludes transient `realtime.messages` data. It writes one snapshot-consistent custom dump, role SQL without passwords, table counts, a Storage object manifest, and `cron-jobs.ndjson`.

The target image owns `_realtime`, `extensions`, `graphql`, `graphql_public`, `net`, `pgbouncer`, `supabase_functions`, and `vault`. `prepare-target.sh` creates `pg_net` and `pg_graphql` even though production does not have them. `restore-cron-jobs.sh` creates `pg_cron` in `pg_catalog` and restores each visible source job as its source role.

Object bytes move forward through the Storage APIs. The copy is idempotent. The hosted project is never a destination.

### H0 schema boundary

The stack release must include `supabase/migrations/20260916000001_agent_join_credentials.sql` and `supabase/migrations/20260916000002_agent_join_attempts.sql` at its repository root, beside `deploy/`. A deploy-only archive is insufficient. The wrapper refuses missing files and mounts that migration directory read-only; the helper checks the two pinned hashes before applying SQL.

Local gates: `npm run test:h0-counts` checks artifact transport; `npm run test:h0-upgrade:local` requires Docker and tests the pinned image against synthetic dependencies only. It checks apply, skip, partial state, catalog faults and rollback. Neither command uses production credentials or a source dump.

The hosted source snapshot can predate H0. Keep `source-counts.tsv` and `cron-jobs.ndjson` unchanged. First run the ordinary baseline verifier after restore and Storage metadata repair. Only then run `apply-h0-upgrade.sh target`, followed by `verify-post-upgrade-counts.sh target`, while the edge is stopped. Never apply H0 to `source`.

The upgrade checks the two fixed migration hashes and the target identity. With both H0 tables absent, it applies both migrations and checks their catalog in one transaction. With both present, it checks the full catalog and skips SQL migration replay. A partial or malformed catalog fails; do not retry by deleting tables or editing checksums. The post-upgrade verifier preserves every original table count and cron record. It adds only the two H0 tables at zero when the source baseline lacked both; it retains their original counts when a recovery snapshot already contained both. An extra or missing table fails. There is no fixed total-table count.

Recovery snapshots taken after H0 therefore follow the same sequence: baseline verification, catalog verification/skip, post-upgrade counts, then edge startup. Never run the raw migrations directly against an already-H0 recovery snapshot; their trigger creation is not idempotent. After edge traffic starts, writes can change counts, so these baseline checks belong before that start.

## Box rehearsal from a fresh production dump

Use a new protected artifact directory for each attempt. Never reuse a dump after the source changes.

1. HezLead confirms that the landed stack release is unpacked under `/home/commonswarm/stack/releases/<sha>` with `/home/commonswarm/stack/current` pointing to it, and that this lane's edge release is unpacked under `/home/commonswarm/edge/releases/<sha>` with `/home/commonswarm/edge/current` switched to it. The edge release must be installed before the edge starts on the box database because it carries the TLS helper. Confirm that the source URL is the production pooler and the target is `commonswarm-postgres` at `172.31.0.10`. Confirm PostgreSQL 17.6. Do not use the host cluster's `commonswarm` database. Require the shared network inspection to exit 0.

   ```sh
   readlink -f /home/commonswarm/stack/current
   readlink -f /home/commonswarm/edge/current
   docker network inspect commonswarm-net
   ```

2. Read production versions from the public health endpoints. Record them. Update a changed image pin before this rehearsal.

3. Check the certificates already installed by HezLead. Do not install or replace them in this rehearsal.

   ```sh
   stat -c '%u:%g %a %n' /etc/commonswarm/pg-tls \
     /etc/commonswarm/pg-tls/server.crt \
     /etc/commonswarm/pg-tls/server.key \
     /etc/commonswarm/pg-tls/ca.crt \
     /etc/ssl/yulan-internal-ca.pem
   openssl x509 -in /etc/commonswarm/pg-tls/server.crt -noout -checkhost db.commonswarm.internal
   openssl x509 -in /etc/commonswarm/pg-tls/server.crt -noout -checkip 172.31.0.10
   cmp /etc/commonswarm/pg-tls/ca.crt /etc/ssl/yulan-internal-ca.pem
   ```

   The directory is `0750`. All three files in it are owned by `100:101`. The certificate and CA are `0644`. The private key is owned by `100:101` and is `0600`.

4. Render the two environment files. Values are never quoted. Keep `CUTOVER_CONFIRM=` empty in the migration file. For both the rehearsal and window, set `SOURCE_STORAGE_URL=https://ukezjcnxjvkpkeezxaew.supabase.co/storage/v1` and `TARGET_STORAGE_URL=http://127.0.0.1:18004`. Both are Storage API base URLs and `copy-storage.mjs` appends `/object/...`: hosted Supabase serves the Storage API under `/storage/v1`, and the box Storage API on loopback serves it at the root (Caddy strips `/storage/v1` in front of it). The target and does not use the public host whose POST requests return 503 during the window.

   Compare the SHA-256 digests of the five JWT secret names without printing a value or digest. This command must print `JWT secret digests match: 1 distinct digest` and exit 0:

   ```sh
   python3 - <<'PY'
   import hashlib
   from pathlib import Path

   names = ["JWT_SECRET", "GOTRUE_JWT_SECRET", "PGRST_JWT_SECRET", "API_JWT_SECRET", "AUTH_JWT_SECRET"]
   values = {}
   for raw_line in Path("/home/commonswarm/.env").read_text().splitlines():
       if not raw_line or raw_line.startswith("#") or "=" not in raw_line:
           continue
       name, value = raw_line.split("=", 1)
       if name in names:
           if name in values:
               raise SystemExit(f"duplicate JWT secret name: {name}")
           values[name] = value
   missing = [name for name in names if not values.get(name)]
   if missing:
       raise SystemExit("missing JWT secret names: " + ", ".join(missing))
   digest_count = len({hashlib.sha256(values[name].encode()).digest() for name in names})
   if digest_count != 1:
       raise SystemExit(f"JWT secret digests differ: {digest_count} distinct digests")
   print("JWT secret digests match: 1 distinct digest")
   PY
   ```

5. Start PostgreSQL. Choose a new artifact directory. Take the source dump.

   ```sh
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d postgres
   postgres_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q postgres)"
   wait_healthy "$postgres_container" postgres 180
   ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-rehearsal
   export ARTIFACT_DIR
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env \
     COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     "$MIGRATE/run-db-tool.sh" dump-source.sh "$ARTIFACT_DIR" source
   ```

6. Practice the fresh database procedure. Stop every stack service and the edge runtime. Move the rehearsal data directory aside. Keep it until step 8. Create an empty data directory with mode `0700` and owner `100:101`. Start only PostgreSQL.

   ```sh
   COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
     COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
     docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" down
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" down
   saved_rehearsal_data_dir="/var/lib/commonswarm/postgres.rehearsal-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
   if [ -e "$saved_rehearsal_data_dir" ]; then printf '%s\n' "rehearsal directory already exists: $saved_rehearsal_data_dir" >&2; false; fi
   mv /var/lib/commonswarm/postgres "$saved_rehearsal_data_dir"
   install -d -m 0700 -o 100 -g 101 /var/lib/commonswarm/postgres
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d postgres
   postgres_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q postgres)"
   wait_healthy "$postgres_container" postgres 180
   ```

7. Restore and prepare in this order. Restore cron jobs immediately after target preparation.

   ```sh
   "$MIGRATE/run-db-tool.sh" restore-target.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" prepare-target.sh "$ARTIFACT_DIR"
   "$MIGRATE/run-db-tool.sh" restore-cron-jobs.sh "$ARTIFACT_DIR" target
   MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
   MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
   "$MIGRATE/run-db-tool.sh" setup-realtime.sh "$ARTIFACT_DIR"
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   ```

   Run the seed command twice. The second run must also exit 0; this proves that seeding is idempotent.

8. Start the database services. Copy Storage forward. Restore Storage metadata. Verify the unmodified source baseline, then apply and verify H0 before starting the edge. Keep or remove the saved rehearsal directory only after all controls pass.

   ```sh
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" restart realtime
   storage_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q storage-api)"
   wait_healthy "$storage_container" storage-api 180
   COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/copy-storage.sh" forward
   "$MIGRATE/run-db-tool.sh" restore-storage-metadata.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" apply-h0-upgrade.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" verify-post-upgrade-counts.sh "$ARTIFACT_DIR" target
   ```

9. Start the 512 MB edge runtime on the box database. Before it starts, confirm in a protected editor that `/home/commonswarm/.env` has all of these box values:

   - `SWARM_DATABASE_URL` and `SUPABASE_DB_URL` name `db.commonswarm.internal` and use `sslmode=verify-full`.
   - Neither database URL has `sslrootcert`; the edge client receives the CA separately.
   - `SWARM_DATABASE_TLS_CA_B64` is set.

   Start the runtime with both Compose inputs set inline. Wait for the container to be healthy, then run the runtime's H0 health request on loopback:

   ```sh
   COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
     COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
     docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" up -d
   edge_container="$(COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
     COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
     docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" ps -q edge-runtime)"
   wait_healthy "$edge_container" edge-runtime 180
   curl --fail --silent --show-error http://127.0.0.1:9000/health
   ```

   Run all other local health checks.

10. Through the staging host, prove a migrated CLI refresh, an authenticated REST read, a Realtime wake, Storage upload and download, one edge command, one edge read, table counts, cron jobs, and object digests. GitHub and Google sign-in cannot be proved here: both callbacks are `https://api.commonswarm.com/auth/v1/callback`, which still points at Supabase; window step 7 proves them.

11. Run `cswarm check`, a listener wake, and the client timeout table. Each client timeout must be at least twice its p95 over 20 runs.

12. Run the source freeze preflight on production. `preflight` only reads and needs no confirmation: it checks the source identity, prints the tables the source role cannot trigger, and exits 0 without changing anything. Record the list. Recompute it, and the probe's unprobed roles, at window time; never copy them from this file. `enable` refuses with exit 65 unless `FREEZE_UNGUARDED_TABLES` is SET to exactly that list (set to empty when the list is empty; unset never acknowledges).

   ```sh
   "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" preflight source
   ```

13. Complete the freeze drill on the restored box. The hosted-shape Docker test is a separate control. Run `preflight target` now and copy `FREEZE_UNGUARDED_TABLES` from this target output. Run the first frozen target probe without `FREEZE_UNPROBED_ROLES`; it must print the target list and exit 65. Copy that list, set it, and rerun the probe.

   ```sh
   unset FREEZE_UNGUARDED_TABLES FREEZE_UNPROBED_ROLES
   "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" preflight target
   FREEZE_UNGUARDED_TABLES='<copy the exact target list printed by preflight; use an empty value when it prints none>'
   export FREEZE_UNGUARDED_TABLES
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW FREEZE_UNGUARDED_TABLES="$FREEZE_UNGUARDED_TABLES" \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" enable target
   "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" frozen target
   # Expected exit code: 65. Read it before the next command.
   FREEZE_UNPROBED_ROLES='<copy the exact target list printed by the exit-65 probe; use an empty value when it prints none>'
   export FREEZE_UNPROBED_ROLES
   FREEZE_UNPROBED_ROLES="$FREEZE_UNPROBED_ROLES" \
     "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" frozen target
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" disable target
   FREEZE_UNPROBED_ROLES="$FREEZE_UNPROBED_ROLES" \
     "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" writable target
   ```

   A second `enable target` while frozen is safe. It must exit 0, add no trigger, and leave the freeze in force.

A failed control means repeat the rehearsal from a fresh dump.

## Cutover window

Ruling 9084e3e1 applies. Rollback exists only before the box accepts writes. After step 7, fix forward on the box. Never install `commonswarm-api-fallback.caddy` after step 7.

Use the protected environment files for every call. Their values are unquoted. `CUTOVER_CONFIRM=` stays empty in the migration file. Set `CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW` inline only on freeze and unfreeze commands.

Run every window block one command at a time and read each exit code. Never run a block under `set -e`: the first frozen probe in step 3 and a discovery probe in ABORT-B intentionally exit 65.

0. Confirm that the rehearsal passed from a fresh dump within 24 hours. Confirm the images, source identifier, R2 backup prefix, release symlinks, and decision checklist. Require the shared network inspection to exit 0. Set the final artifact directory for the whole window:

   ```sh
   readlink -f /home/commonswarm/stack/current
   readlink -f /home/commonswarm/edge/current
   docker network inspect commonswarm-net
   ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-window
   export ARTIFACT_DIR
   ```

1. Install `commonswarm-api-maintenance.caddy` over `/etc/caddy/sites/10-commonswarm-api.caddy`, keeping the previous file as `.prev`. Validate Caddy and read the exit code. Reload it. The public DNS still points to Supabase.

2. Move `api.commonswarm.com` to the box (A 178.105.29.28, proxied) through the DNS holder. Judge DNS through `1.1.1.1` or a flushed resolver, never a local cache. From here the maintenance behaviour is:

   - Every `POST`, `PUT`, `PATCH`, and `DELETE` returns 503. This includes the POST-only edge functions.
   - Every `/auth/v1` call returns 503.
   - `GET` and `HEAD` reads go to the Supabase origin.
   - The Realtime websocket goes to the Supabase origin. Its frames are wake hints and are not migrated data.
   - `cswarm check` exits 1 in about 3.2 seconds.
   - `cswarm inbox` exits 1.
   - `cswarm note` exits 1 in about 6.2 seconds with the maintenance sentence.
   - The hook form was not measured.

   - `capability` counts a GET in its rate buckets before its 405. Before the step-3 freeze those rows are in the final dump; after it the write fails with SQLSTATE 25006.

   Path proof: a POST to `https://api.commonswarm.com/functions/v1/read` answers 503 with `{"error":"maintenance"}` (only the box sends that body) and `Retry-After: 300`. Then announce the write pause.

   ABORT-A (path proof fails): restore the Supabase CNAME (not proxied) and the `.prev` Caddy file.

3. Compute both acknowledgements during this window, freeze the source, and prove it. Run these commands in order. Copy each list from this run's output, never from the rehearsal. The first frozen probe intentionally omits `FREEZE_UNPROBED_ROLES`; it must exit 65 after printing the roles this connection cannot assume. If `enable` has to run again after a later failure is fixed, a second run while frozen is safe: it exits 0, adds no trigger, and the freeze stays.

   ```sh
   unset FREEZE_UNGUARDED_TABLES FREEZE_UNPROBED_ROLES
   "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" preflight source
   FREEZE_UNGUARDED_TABLES='<copy the exact list printed by preflight; use an empty value when it prints none>'
   export FREEZE_UNGUARDED_TABLES
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" enable source
   enable_summary="$(awk 'match($0, /older sessions ended: [0-9]+, refused: [0-9]+/) { value = substr($0, RSTART, RLENGTH) } END { print value }' "$ARTIFACT_DIR/logs/read-only-source-enable.log")"
   printf '%s\n' "$enable_summary"
   refused_sessions="${enable_summary##*refused: }"
   if [ -z "$enable_summary" ] || [ -z "$refused_sessions" ]; then printf '%s\n' 'enable session count is missing' >&2; false; fi
   if [ "$refused_sessions" -gt 0 ]; then "$MIGRATE/run-db-tool.sh" list-client-sessions.sh "$ARTIFACT_DIR" source; fi
   # If refused_sessions is greater than zero, read pid, usename, application_name, backend_start, and state, then decide whether to continue before step 4.
   "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" frozen source
   # Expected exit code: 65. Read it before the next command.
   FREEZE_UNPROBED_ROLES='<copy the exact list printed by the exit-65 probe; use an empty value when it prints none>'
   export FREEZE_UNPROBED_ROLES
   "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" frozen source
   ```

   What the freeze cannot stop: a session that refused termination keeps its older writable default and can write an unguarded table without `BEGIN READ WRITE`; other sessions can write to the tables the source role cannot trigger (the preflight list) if they override the database default; and any client that calls `ukezjcnxjvkpkeezxaew.supabase.co` directly instead of `api.commonswarm.com` bypasses maintenance. Before the window, read the Supabase API logs for requests whose host is the supabase.co name; if a product client still uses it, fix that client first.

   ABORT-B: if the probe fails after enable, unfreeze inline, then run the writable probe. The writable probe creates and drops `commonswarm_cutover_probe` to prove DDL and writes work. Then restore DNS and Caddy.

   ```sh
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" disable source
   if [ "${FREEZE_UNPROBED_ROLES+x}" != x ]; then "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" writable source; fi
   # The discovery probe above must exit 65 after printing the exact list. Read the exit code, set the list, then continue.
   if [ "${FREEZE_UNPROBED_ROLES+x}" != x ]; then FREEZE_UNPROBED_ROLES='<copy the exact list printed by the exit-65 writable probe; use an empty value when it prints none>'; export FREEZE_UNPROBED_ROLES; fi
   FREEZE_UNPROBED_ROLES="$FREEZE_UNPROBED_ROLES" \
     "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" writable source
   ```

4. Take the final source dump in the directory set in step 0. If this dump of the frozen source through the hosted pooler fails, run ABORT-B; do not continue with an older dump. Restore onto a fresh box database. Stop every stack service and the edge runtime. Move the rehearsal data directory aside under a unique timestamped name and keep it through step 8. Create an empty `0700` directory owned by `100:101`. Start only PostgreSQL. Restore in the shown order. After the stack is up and before copying Storage, confirm in a protected editor that `/home/commonswarm/.env` has `SWARM_DATABASE_URL` and `SUPABASE_DB_URL` naming `db.commonswarm.internal` with `sslmode=verify-full` and no `sslrootcert`, and that `SWARM_DATABASE_TLS_CA_B64` is set. Then start the edge runtime, wait for `healthy`, and run its `/health` request on `127.0.0.1:9000`.

   ```sh
   "$MIGRATE/run-db-tool.sh" dump-source.sh "$ARTIFACT_DIR" source
   COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
     COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
     docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" down
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" down
   saved_window_data_dir="/var/lib/commonswarm/postgres.window-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
   if [ -e "$saved_window_data_dir" ]; then printf '%s\n' "window directory already exists: $saved_window_data_dir" >&2; false; fi
   mv /var/lib/commonswarm/postgres "$saved_window_data_dir"
   install -d -m 0700 -o 100 -g 101 /var/lib/commonswarm/postgres
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d postgres
   postgres_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q postgres)"
   wait_healthy "$postgres_container" postgres 180
   "$MIGRATE/run-db-tool.sh" restore-target.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" prepare-target.sh "$ARTIFACT_DIR"
   "$MIGRATE/run-db-tool.sh" restore-cron-jobs.sh "$ARTIFACT_DIR" target
   MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
   MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
   "$MIGRATE/run-db-tool.sh" setup-realtime.sh "$ARTIFACT_DIR"
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d
   docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" restart realtime
   storage_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q storage-api)"
   wait_healthy "$storage_container" storage-api 180
   COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/copy-storage.sh" forward
   "$MIGRATE/run-db-tool.sh" restore-storage-metadata.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" apply-h0-upgrade.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" verify-post-upgrade-counts.sh "$ARTIFACT_DIR" target
   COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
     COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
     docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" up -d
   edge_container="$(COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
     COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
     docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" ps -q edge-runtime)"
   wait_healthy "$edge_container" edge-runtime 180
   curl --fail --silent --show-error http://127.0.0.1:9000/health
   ```

   Run the seed command twice. The second run must also exit 0; this proves that seeding is idempotent.

   ABORT-C: if a step fails, use the ABORT-B unfreeze and writable probe. Restore DNS and Caddy. Discard the new box database. Any step-5 staging upload can leave R2 bytes with no restored `storage.objects` row. The orphan names are `swarm-files/<the upload names recorded in step 5>`. Find them from the recorded step-5 upload names, check those exact bucket/name pairs against `storage.objects`, and remove the orphan bytes before another attempt. No hosted bytes are removed.

5. Complete the decision checklist within 30 minutes through the staging host. Use the recorded pre-start baseline and post-upgrade count gates from step 4. They compare every selected table count and `cron-jobs.ndjson` as a multiset of jobs (every field, duplicate rows included), so a different database collation cannot fail a match. Do not compare a live, writing database to a stale source snapshot with the unmodified baseline verifier. Also prove object totals and digests, a migrated human refresh, REST, `cswarm check` within its budget, a listener wake, an edge command and read, a Realtime private Broadcast wake, one Storage upload and signed download with a digest match, and the timeout table at every client timeout at least twice its p95. Record the exact bucket and object name for every staging upload so ABORT-C can find any R2 orphan. If one control fails, run ABORT-C.

   ABORT-D (not all green within 30 minutes): ABORT-C.

6. Take a full migration artifact set from the box. Store it with the nightly backup. This is the recovery artifact before the box accepts writes.

   ```sh
   RECOVERY_ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-step-6
   "$MIGRATE/run-db-tool.sh" dump-source.sh "$RECOVERY_ARTIFACT_DIR" target
   ```

7. Install `commonswarm-api.caddy`. Validate, read the exit code, and reload. The box now accepts writes and is the system of record. Never install the fallback Caddy file after this point. Fix later failures forward. Production controls on `api.commonswarm.com`: GitHub sign-in and Google sign-in end to end in the operator's browser (both callbacks are `https://api.commonswarm.com/auth/v1/callback`, so this is their first proof on the box), `cswarm check` and a listener wake, one command, one upload, the install page, and the site.

8. Tell humans to sign in once. Keep the hosted project frozen for 48 hours. Keep the moved rehearsal data directory through this step. Do not unfreeze the hosted project.

## Recovery drill after the decision point

Use the artifact directory created by `dump-source.sh` in window step 6. A plain nightly `pg_dump -Fc` is not accepted by these restore scripts.

Stop every service and the edge runtime. Move the broken data directory to a unique timestamped name, create a fresh box data directory, and start only PostgreSQL. Wait at most 180 seconds for PostgreSQL before any restore. Restore in this order behind the maintenance Caddy file. Then start the full stack, restart Realtime, wait for Storage API, copy Storage, restore its metadata, start the edge with both inline variables, and wait at most 180 seconds for the edge:

```sh
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
  COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
  docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" down
docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" down
broken_data_dir="/var/lib/commonswarm/postgres.recovery-broken-$(date -u +%Y%m%dT%H%M%SZ)"
if [ -e "$broken_data_dir" ]; then printf '%s\n' "recovery directory already exists: $broken_data_dir" >&2; false; fi
mv /var/lib/commonswarm/postgres "$broken_data_dir"
install -d -m 0700 -o 100 -g 101 /var/lib/commonswarm/postgres
docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d postgres
postgres_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q postgres)"
wait_healthy "$postgres_container" postgres 180
"$MIGRATE/run-db-tool.sh" restore-target.sh "$RECOVERY_ARTIFACT_DIR" target
"$MIGRATE/run-db-tool.sh" prepare-target.sh "$RECOVERY_ARTIFACT_DIR"
"$MIGRATE/run-db-tool.sh" restore-cron-jobs.sh "$RECOVERY_ARTIFACT_DIR" target
MIGRATION_ARTIFACT_DIR="$RECOVERY_ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
MIGRATION_ARTIFACT_DIR="$RECOVERY_ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
"$MIGRATE/run-db-tool.sh" setup-realtime.sh "$RECOVERY_ARTIFACT_DIR"
"$MIGRATE/run-db-tool.sh" verify-counts.sh "$RECOVERY_ARTIFACT_DIR" target
docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" up -d
postgres_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q postgres)"
wait_healthy "$postgres_container" postgres 180
docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" restart realtime
storage_container="$(docker compose -p commonswarm-supabase-stack --project-directory "$STACK_DIR" ps -q storage-api)"
wait_healthy "$storage_container" storage-api 180
COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
  MIGRATION_ARTIFACT_DIR="$RECOVERY_ARTIFACT_DIR" "$MIGRATE/copy-storage.sh" forward
"$MIGRATE/run-db-tool.sh" restore-storage-metadata.sh "$RECOVERY_ARTIFACT_DIR" target
"$MIGRATE/run-db-tool.sh" verify-counts.sh "$RECOVERY_ARTIFACT_DIR" target
"$MIGRATE/run-db-tool.sh" apply-h0-upgrade.sh "$RECOVERY_ARTIFACT_DIR" target
"$MIGRATE/run-db-tool.sh" verify-post-upgrade-counts.sh "$RECOVERY_ARTIFACT_DIR" target
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
  COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
  docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" up -d
edge_container="$(COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
  COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
  docker compose -p commonswarm-edge --project-directory "$EDGE_DIR" ps -q edge-runtime)"
wait_healthy "$edge_container" edge-runtime 180
curl --fail --silent --show-error http://127.0.0.1:9000/health
```

Run the seed command twice. The second run must also exit 0; this proves that seeding is idempotent.

Rehearse this drill on a second local database before the window.

## Human sessions

An old asymmetric browser access token can fail against the HS256 box. The site clears it and shows sign-in. The human signs in once, with GitHub, Google, or email (production enables all three: read-only `/auth/v1/settings`, 2026-09-17).

Before the window: a GitHub OAuth app owned by the yulanventures organization with callback `https://api.commonswarm.com/auth/v1/callback` (HezLead creates it; the client secret goes to the vault), and that same URI added to the authorized redirect URIs of the existing Google client in project `commonswarm` (the operator; the console needs the operator's password). Adding a redirect URI does not change hosted auth.

The migrated Auth rows preserve refresh tokens. The CLI refresh path can exchange a valid migrated token for a new HS256 session. The rehearsal must prove this.

## Backups for HezLead

The backup target is container `commonswarm-postgres` at `172.31.0.10`. The database is `postgres`. There is no host-published port. Connect from `172.31.0.1` as `backup_ro` with `PGSSLMODE=verify-full` and `PGSSLROOTCERT=/etc/ssl/yulan-internal-ca.pem`.

Each nightly set contains globals without role passwords, a custom dump of `postgres`, and R2 retention evidence. The complete database-and-file backup workflow is in [backup/README.md](backup/README.md). A database-only export is not a complete backup; require exact object-version copies and offsite byte checks. `backup_ro` has `pg_read_all_data` and `BYPASSRLS`. `pg_hba.conf` allows it only from `172.31.0.1/32`.

The backup and restore unit files in this release add a `docker.service` dependency, name the restore timer's unit, and the scripts share one lock. On a box that already runs these units, stop both timers first. An old backup and a new drill must not run at the same time.

```sh
systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
systemctl is-active commonswarm-postgres-backup.service commonswarm-postgres-restore.service
```

`systemctl is-active` prints one line per service. Wait until both services are inactive. Do not proceed while either line is `active` or `activating`. Both lines must be `inactive` or `failed`. Exit code 0 from this command means at least one service is active.

Switch the release and copy the four unit files from the new `$STACK_DIR/backup/` to `/etc/systemd/system/` (same file names). `$STACK_DIR` is `/home/commonswarm/stack/current/deploy/supabase-stack`, so run the copy after the symlink switch. Then reload systemd, start both timers, and check that both are scheduled:

```sh
ln -sfn /home/commonswarm/stack/releases/<sha> /home/commonswarm/stack/current
cp "$STACK_DIR/backup/commonswarm-postgres-backup.service" /etc/systemd/system/
cp "$STACK_DIR/backup/commonswarm-postgres-backup.timer" /etc/systemd/system/
cp "$STACK_DIR/backup/commonswarm-postgres-restore.service" /etc/systemd/system/
cp "$STACK_DIR/backup/commonswarm-postgres-restore.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
systemctl list-timers commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
```

`systemctl list-timers` must show both timers. Do not start `commonswarm-postgres-backup.service` or `commonswarm-postgres-restore.service`. A start runs a backup or a drill.

## Not established

- Browser CORS and the `apikey` header without Kong need the box rehearsal.
- GitHub and Google OAuth through the box: first proved at window step 7, because their callback host is in maintenance until then.
- The roles and tables that the source role cannot probe or trigger must be measured again at the window.
- `postgres` has BYPASSRLS on hosted and on the box image, so the cron export sees every job regardless of owner.
- `prepare-target.sh` creates `pg_net` and `pg_graphql`; production does not have them.
- Bare `/rest/v1`, `/auth/v1`, and `/storage/v1` paths answer 404 on the box.
- A plain nightly `pg_dump -Fc` has no role SQL, counts, Storage manifest, or cron manifest and is not restorable by these scripts.
- The hook form of the CLI maintenance failure was not measured.
- A dump of the frozen source through the hosted pooler has only been proved against local PostgreSQL. A failure at window step 4 fails closed into ABORT-B.
