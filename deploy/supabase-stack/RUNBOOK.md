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

Use this absolute path for every migration script call below. Define it once in the operator shell:

```sh
MIGRATE=/home/commonswarm/current/deploy/supabase-stack/migrate
```

Every database URL names `db.commonswarm.internal` and uses `sslmode=verify-full`. GoTrue, PostgREST, and Storage API also use `sslrootcert=/etc/ssl/yulan-internal-ca.pem`. Realtime uses `DB_SSL=true` and `DB_SSL_CA_CERT=/etc/ssl/yulan-internal-ca.pem`. The edge URLs omit `sslrootcert`; the edge functions pass the CA as `ssl.ca` with certificate checks enabled.

The edge URLs use `commonswarm_edge`. GoTrue uses `supabase_auth_admin`. PostgREST uses `authenticator`. Storage API uses `supabase_storage_admin`. Realtime uses `supabase_admin`.

The memory total is 4060 MB. It includes PostgreSQL 1536 MB, Realtime 512 MB, GoTrue 300 MB, PostgREST 300 MB, Storage API 300 MB, edge runtime 512 MB, and 600 MB of headroom.

## What moves

`dump-source.sh` moves `auth`, `public`, `realtime`, `storage`, `supabase_migrations`, `swarm`, and `swarm_read`. It excludes transient `realtime.messages` data. It writes one snapshot-consistent custom dump, role SQL without passwords, table counts, a Storage object manifest, and `cron-jobs.ndjson`.

The target image owns `_realtime`, `extensions`, `graphql`, `graphql_public`, `net`, `pgbouncer`, `supabase_functions`, and `vault`. `prepare-target.sh` creates `pg_net` and `pg_graphql` even though production does not have them. `restore-cron-jobs.sh` creates `pg_cron` in `pg_catalog` and restores each visible source job as its source role.

Object bytes move forward through the Storage APIs. The copy is idempotent. The hosted project is never a destination.

## Box rehearsal from a fresh production dump

Use a new protected artifact directory for each attempt. Never reuse a dump after the source changes.

1. Confirm that the source URL is the production pooler and the target is `commonswarm-postgres` at `172.31.0.10`. Confirm PostgreSQL 17.6. Do not use the host cluster's `commonswarm` database.

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

4. Render the two environment files. Values are never quoted. Keep `CUTOVER_CONFIRM=` empty in the migration file. Rehearse freeze and unfreeze on the restored box with the confirmation set inline:

   ```sh
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" enable target
   "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" frozen target
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" disable target
   "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" writable target
   ```

   Run this after step 7 on the restored box. A second `enable target` while frozen is safe. It must exit 0, add no trigger, and leave the freeze in force.

5. Start PostgreSQL. Choose a new artifact directory. Take the source dump.

   ```sh
   cd /home/commonswarm/current/deploy/supabase-stack
   docker compose -p commonswarm-supabase-stack up -d postgres
   ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-rehearsal
   export ARTIFACT_DIR
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env \
     COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     "$MIGRATE/run-db-tool.sh" dump-source.sh "$ARTIFACT_DIR" source
   ```

6. Practice the fresh database procedure. Stop every stack service and the edge runtime. Move the rehearsal data directory aside. Keep it until step 8. Create an empty data directory with mode `0700` and owner `100:101`. Start only PostgreSQL.

   ```sh
   docker compose -f /home/commonswarm/current/deploy/edge-runtime/compose.yaml down
   docker compose -p commonswarm-supabase-stack down
   mv /var/lib/commonswarm/postgres /var/lib/commonswarm/postgres.rehearsal-before-restore
   install -d -m 0700 -o 100 -g 101 /var/lib/commonswarm/postgres
   docker compose -p commonswarm-supabase-stack up -d postgres
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

8. Start the stack. Copy Storage forward. Restore Storage metadata. Verify counts again. Keep or remove the saved rehearsal directory only after all controls pass.

   ```sh
   docker compose -p commonswarm-supabase-stack up -d
   COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/copy-storage.sh" forward
   "$MIGRATE/run-db-tool.sh" restore-storage-metadata.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   ```

9. Start the 512 MB edge runtime on the box database. Run all local health checks.

10. Through the staging host, prove GitHub sign-in, a migrated CLI refresh, an authenticated REST read, a Realtime wake, Storage upload and download, one edge command, one edge read, table counts, cron jobs, and object digests.

11. Run `cswarm check`, a listener wake, and the client timeout table. Each client timeout must be at least twice its p95 over 20 runs.

12. Run the source freeze preflight without `FREEZE_UNGUARDED_TABLES`. It must exit 65 before a change. Record the tables and roles that it prints. Recompute them at window time.

13. Complete the step-4 freeze drill on the restored box. The hosted-shape Docker test is a separate control.

A failed control means repeat the rehearsal from a fresh dump.

## Cutover window

Ruling 9084e3e1 applies. Rollback exists only before the box accepts writes. After step 7, fix forward on the box. Never install `commonswarm-api-fallback.caddy` after step 7.

Use the protected environment files for every call. Their values are unquoted. `CUTOVER_CONFIRM=` stays empty in the migration file. Set `CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW` inline only on freeze and unfreeze commands.

0. Confirm that the rehearsal passed from a fresh dump within 24 hours. Confirm the images, source identifier, R2 backup prefix, and decision checklist.

1. Install `commonswarm-api-maintenance.caddy`. Validate Caddy and read the exit code. Reload it. The public DNS still points to Supabase.

2. Move `api.commonswarm.com` to the box. Measure the maintenance behavior:

   - Every `POST`, `PUT`, `PATCH`, and `DELETE` returns 503. This includes the POST-only edge functions.
   - Every `/auth/v1` call returns 503.
   - `GET` and `HEAD` reads go to the Supabase origin.
   - The Realtime websocket goes to the Supabase origin. Its frames are wake hints and are not migrated data.
   - `cswarm check` exits 1 in about 3.2 seconds.
   - `cswarm inbox` exits 1.
   - `cswarm note` exits 1 in about 6.2 seconds with the maintenance sentence.
   - The hook form was not measured.

   A POST to `/functions/v1/read` must show the box's 503 body. If this path proof fails, restore the Supabase CNAME and the previous Caddy file.

3. Freeze the source with the confirmation inline. Run `enable` a second time while frozen. It is safe and must leave the same freeze objects. Then run the frozen probe.

   ```sh
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW FREEZE_UNGUARDED_TABLES="$FREEZE_UNGUARDED_TABLES" \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" enable source
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW FREEZE_UNGUARDED_TABLES="$FREEZE_UNGUARDED_TABLES" \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" enable source
   FREEZE_UNPROBED_ROLES="$FREEZE_UNPROBED_ROLES" \
     "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" frozen source
   ```

   ABORT-B: if the probe fails after enable, unfreeze inline, then run the writable probe. The writable probe creates and drops `commonswarm_cutover_probe` to prove DDL and writes work. Then restore DNS and Caddy.

   ```sh
   CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW \
     "$MIGRATE/run-db-tool.sh" source-read-only.sh "$ARTIFACT_DIR" disable source
   "$MIGRATE/run-db-tool.sh" probe-database-freeze.sh "$ARTIFACT_DIR" writable source
   ```

4. Create a new artifact directory and take the final source dump. Restore onto a fresh box database. Stop every stack service and the edge runtime. Move the rehearsal data directory aside and keep it through step 8. Create an empty `0700` directory owned by `100:101`. Start only PostgreSQL. Then restore in the shown order.

   ```sh
   ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-window
   export ARTIFACT_DIR
   "$MIGRATE/run-db-tool.sh" dump-source.sh "$ARTIFACT_DIR" source
   docker compose -f /home/commonswarm/current/deploy/edge-runtime/compose.yaml down
   cd /home/commonswarm/current/deploy/supabase-stack
   docker compose -p commonswarm-supabase-stack down
   mv /var/lib/commonswarm/postgres /var/lib/commonswarm/postgres.rehearsal-kept-through-step-8
   install -d -m 0700 -o 100 -g 101 /var/lib/commonswarm/postgres
   docker compose -p commonswarm-supabase-stack up -d postgres
   "$MIGRATE/run-db-tool.sh" restore-target.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" prepare-target.sh "$ARTIFACT_DIR"
   "$MIGRATE/run-db-tool.sh" restore-cron-jobs.sh "$ARTIFACT_DIR" target
   MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
   MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
   "$MIGRATE/run-db-tool.sh" setup-realtime.sh "$ARTIFACT_DIR"
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   docker compose -p commonswarm-supabase-stack up -d
   COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" "$MIGRATE/copy-storage.sh" forward
   "$MIGRATE/run-db-tool.sh" restore-storage-metadata.sh "$ARTIFACT_DIR" target
   "$MIGRATE/run-db-tool.sh" verify-counts.sh "$ARTIFACT_DIR" target
   ```

   ABORT-C: if a step fails, use the ABORT-B unfreeze and writable probe. Restore DNS and Caddy. Discard the new box database.

5. Complete the decision checklist within 30 minutes through the staging host. `verify-counts.sh` compares every selected table count and `cron-jobs.ndjson`. Also prove object totals and digests, a migrated human refresh, REST, `cswarm check`, a listener wake, an edge command and read, Realtime, Storage, and the timeout table. If one control fails, run ABORT-C.

6. Take a full migration artifact set from the box. Store it with the nightly backup. This is the recovery artifact before the box accepts writes.

   ```sh
   RECOVERY_ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-step-6
   "$MIGRATE/run-db-tool.sh" dump-source.sh "$RECOVERY_ARTIFACT_DIR" target
   ```

7. Install `commonswarm-api.caddy`. Validate, read the exit code, and reload. The box now accepts writes and is the system of record. Never install the fallback Caddy file after this point. Fix later failures forward.

8. Tell humans to sign in once. Keep the hosted project frozen for 48 hours. Keep the moved rehearsal data directory through this step. Do not unfreeze the hosted project.

## Recovery drill after the decision point

Use the artifact directory created by `dump-source.sh` in window step 6. A plain nightly `pg_dump -Fc` is not accepted by these restore scripts.

Stop every service and the edge runtime. Create a fresh box data directory as in window step 4. Restore in this order behind the maintenance Caddy file:

```sh
"$MIGRATE/run-db-tool.sh" restore-target.sh "$RECOVERY_ARTIFACT_DIR" target
"$MIGRATE/run-db-tool.sh" prepare-target.sh "$RECOVERY_ARTIFACT_DIR"
"$MIGRATE/run-db-tool.sh" restore-cron-jobs.sh "$RECOVERY_ARTIFACT_DIR" target
MIGRATION_ARTIFACT_DIR="$RECOVERY_ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
MIGRATION_ARTIFACT_DIR="$RECOVERY_ARTIFACT_DIR" "$MIGRATE/seed-realtime-tenant.sh"
"$MIGRATE/run-db-tool.sh" setup-realtime.sh "$RECOVERY_ARTIFACT_DIR"
"$MIGRATE/run-db-tool.sh" verify-counts.sh "$RECOVERY_ARTIFACT_DIR" target
```

Rehearse this drill on a second local database before the window.

## Human sessions

An old asymmetric browser access token can fail against the HS256 box. The site clears it and shows sign-in. The human signs in with GitHub once.

The migrated Auth rows preserve refresh tokens. The CLI refresh path can exchange a valid migrated token for a new HS256 session. The rehearsal must prove this.

## Backups for HezLead

The backup target is container `commonswarm-postgres` at `172.31.0.10`. The database is `postgres`. There is no host-published port. Connect from `172.31.0.1` as `backup_ro` with `PGSSLMODE=verify-full` and `PGSSLROOTCERT=/etc/ssl/yulan-internal-ca.pem`.

Each nightly set contains globals without role passwords, a custom dump of `postgres`, and R2 retention evidence. `backup_ro` has `pg_read_all_data` and `BYPASSRLS`. `pg_hba.conf` allows it only from `172.31.0.1/32`.

## Not established

- Browser CORS and the `apikey` header without Kong need the box rehearsal.
- GitHub OAuth through the box needs the box rehearsal.
- The roles and tables that the source role cannot probe or trigger must be measured again at the window.
- Cron export sees only jobs visible to the dump role. Production's five measured jobs are owned by that role.
- `prepare-target.sh` creates `pg_net` and `pg_graphql`; production does not have them.
- Bare `/rest/v1`, `/auth/v1`, and `/storage/v1` paths answer 404 on the box.
- A plain nightly `pg_dump -Fc` has no role SQL, counts, Storage manifest, or cron manifest and is not restorable by these scripts.
- The hook form of the CLI maintenance failure was not measured.
