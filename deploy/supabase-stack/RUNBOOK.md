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
- Service secrets: vault item `CommonSwarm self-hosted Supabase env` rendered to `/home/commonswarm/.env`, mode `0600`.
- Migration-only secrets: a separate vault item rendered to `/home/commonswarm/migration.env`, mode `0600`. Compose never mounts it.
- TLS: the internal CA at `/etc/ssl/yulan-internal-ca.pem`; database certificate SANs are `db.commonswarm.internal` and `172.31.0.10`; key and data directory owned by uid 100, gid 101 (the `postgres` user in `supabase/postgres:17.6.1.147`).
- Source identity: `SOURCE_SYSTEM_IDENTIFIER` in the migration env file, read once by the lead with `SELECT system_identifier FROM pg_control_system()`. Every source-side script refuses a database whose identifier differs. Hosted Supabase does not set `app.settings.jwt_secret` and does not let its non-superuser `postgres` set custom database parameters (measured 2026-09-17), so neither can identify the source.

The edge runtime stays at 512 MB and loopback port `9000`. Set `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net` so its Compose file reaches the unpublished database through `db.commonswarm.internal`. The router passes `SWARM_DATABASE_TLS_CA_B64` (base64 of the public internal CA certificate) to `command`, `read`, `capability`, and `activity`; `supabase/functions/_shared/database-options.ts` adds `ssl.ca` with `rejectUnauthorized: true` when it is set, and returns the original options object unchanged when it is not (the hosted functions and today's pooler path). Keep `sslmode=verify-full` in the box edge database URL and omit `sslrootcert` there: `postgres` 3.4.9 would send that query key to PostgreSQL as a startup parameter. The memory total is PostgreSQL 1536 MB, Realtime 512 MB, GoTrue 300 MB, PostgREST 300 MB, Storage API 300 MB, edge runtime 512 MB, and 600 MB reserved headroom: 4060 MB.

Every database URL used by GoTrue, PostgREST, Storage API, and edge-runtime must name `db.commonswarm.internal` and include `sslmode=verify-full`. GoTrue, PostgREST, and Storage API use `sslrootcert=/etc/ssl/yulan-internal-ca.pem`. The edge runtime's `postgres` 3.4.9 URLs omit `sslrootcert`; that client sends an unrecognized `sslrootcert` query key to PostgreSQL as a startup parameter. The edge function supplies the CA in the `ssl.ca` option described below. Realtime uses `DB_SSL=true` and `DB_SSL_CA_CERT=/etc/ssl/yulan-internal-ca.pem`. Never use the IP in a service database URL.

The edge URLs authenticate as `commonswarm_edge` with `COMMONSWARM_EDGE_DB_PASSWORD`. They do not use the shared PostgreSQL service password. GoTrue uses `supabase_auth_admin`, PostgREST uses `authenticator`, Storage API uses `supabase_storage_admin`, and Realtime uses `supabase_admin`.

## What moves in the dump

`dump-source.sh` selects these schemas:

- `auth`: users, identities, sessions, refresh tokens, MFA, and OAuth state.
- `storage`: the `swarm-files` bucket and object metadata. Object bytes are copied separately.
- `swarm`: all CommonSwarm durable data, including hashed `swm_agt_` rows.
- `swarm_read`: PostgREST views and functions.
- `public`: source public objects and grants.
- `supabase_migrations`: applied migration history.
- `realtime`: the broadcast table functions and CommonSwarm RLS policies. Ephemeral `realtime.messages` rows are excluded.

The target image creates `_realtime`, `extensions`, `graphql`, `graphql_public`, `net`, `pgbouncer`, `supabase_functions`, and `vault`. It installs `pg_cron`, `pg_graphql`, `pg_net`, `pg_stat_statements`, `pgcrypto`, `supabase_vault`, `uuid-ossp`, and `plpgsql`. A local dependency query found one selected-schema dependency on that set: `swarm.agent_principals.wake_id` and `swarm.rotate_wake_id` use `pgcrypto` through `extensions.gen_random_bytes`. No selected object depended on `uuid-ossp`, `pg_net`, `vault`, `graphql`, or `pg_stat_statements`. These image-owned schemas stay outside the dump. `prepare-target.sh` checks the image extensions, and `seed-realtime-tenant.sh` uses the pinned application to create the encrypted self-host tenant.

The pinned service code does not issue `BEGIN READ WRITE`, `SET TRANSACTION READ WRITE`, or turn `default_transaction_read_only` off. GoTrue and Storage API use ordinary write transactions. Realtime uses ordinary Postgrex transactions. PostgREST adds `target_session_attrs=read-write` only to its listener connection, so the database default rejects that connection during the freeze. Each edge function sets its role and search path in every transaction; the one command failure insert is an autocommit statement with a fully qualified `swarm.command_failures` target.

The role artifact contains `swarm_*` and `commonswarm_*` role definitions and memberships. It also carries the no-login `supabase_realtime_admin` owner because the PostgreSQL image does not create that role. It excludes image-created roles such as `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_admin`, `supabase_auth_admin`, and `supabase_storage_admin`. It contains no password verifier. `prepare-target.sh` assigns fresh SCRAM verifiers from the vault.

## Box rehearsal from a fresh production dump

Use a new protected artifact directory for each attempt. Never reuse a dump after the source changes.

1. Confirm the target is the container and the source is the us-east-1 project. Confirm the PostgreSQL source reports 17.6. Do not use the host cluster's `commonswarm` database.
2. Read production versions from the public health endpoints. Record them. Update the named `image:` line in `compose.yaml` if needed. A changed pin requires a new rehearsal from step 1.
3. Install the internal CA and server certificate. Check certificate SANs and mode `0600` on the private key.
4. Render `/home/commonswarm/.env` from the service vault item and `/home/commonswarm/migration.env` from the migration vault item. Check mode `0600` on both. The migration file contains the source and target database URLs, source and target Storage URLs and service keys, and `CUTOVER_CONFIRM`; no long-running service receives it. Use the legacy HS256 JWT secret for `JWT_SECRET`, `GOTRUE_JWT_SECRET`, `PGRST_JWT_SECRET`, `API_JWT_SECRET`, and `AUTH_JWT_SECRET`. Use the existing anon and service-role JWTs. `DB_ENC_KEY` is exactly 16 high-entropy ASCII characters. `API_JWT_JWKS` is valid production JWKS JSON. Keep `SEED_SELF_HOST=false`; the seed script turns it on only for its one-shot process.
5. Start PostgreSQL only:

   ```sh
   cd /home/commonswarm/current/deploy/supabase-stack
   docker compose -p commonswarm-supabase-stack up -d postgres
   docker compose -p commonswarm-supabase-stack ps
   ```

6. Choose a new absolute artifact directory. With the production source URL present only in the environment, run the dump. This creates a custom dump, password-free role SQL, per-table source counts, and the Storage object manifest. Logs and artifacts are mode `0600` under the protected directory.

   ```sh
   export ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-rehearsal
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env \
     COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     deploy/supabase-stack/migrate/run-db-tool.sh dump-source.sh "$ARTIFACT_DIR" source
   ```

7. Stop every target service except PostgreSQL. Run, in order:

   ```sh
   export ARTIFACT_DIR=/home/commonswarm/migration-artifacts/n-db-rehearsal
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     deploy/supabase-stack/migrate/run-db-tool.sh restore-target.sh "$ARTIFACT_DIR" target
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     deploy/supabase-stack/migrate/run-db-tool.sh prepare-target.sh "$ARTIFACT_DIR"
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env \
     COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" \
     deploy/supabase-stack/migrate/seed-realtime-tenant.sh
   # Run the seed command a second time; it must also exit 0.
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" deploy/supabase-stack/migrate/seed-realtime-tenant.sh
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     deploy/supabase-stack/migrate/run-db-tool.sh setup-realtime.sh "$ARTIFACT_DIR"
   docker compose -p commonswarm-supabase-stack restart realtime
   COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env \
     deploy/supabase-stack/migrate/run-db-tool.sh verify-counts.sh "$ARTIFACT_DIR" target
   ```

8. Start GoTrue, PostgREST, and Storage API. Run `COMMONSWARM_MIGRATION_ENV_FILE=/home/commonswarm/migration.env MIGRATION_ARTIFACT_DIR="$ARTIFACT_DIR" migrate/copy-storage.sh forward`. Then run `run-db-tool.sh restore-storage-metadata.sh "$ARTIFACT_DIR" target`. The first command verifies bytes; the second restores ownership, timestamps, metadata, and user metadata while keeping the target backend's object ID and version. Both refuse the hosted project as a destination.
9. Start the 512 MB edge runtime with its database URLs changed to the container. Run the five local health checks.
10. On a staging hostname, prove all of these through Caddy:
    - GitHub sign-in reaches `/auth/v1/callback`, returns to `https://commonswarm.com/app`, and loads a workspace.
    - A CLI refresh or fresh login succeeds with the unchanged legacy anon key.
    - An authenticated `swarm_read` REST query returns the expected workspace.
    - An agent subscribes to its private wake Broadcast and receives a directed-signal wake.
    - A file upload, commit, signed download, and digest comparison succeed through Storage API and R2.
    - One command and one read succeed through the edge runtime.
    - Source and target table counts still match, including `auth.users`, `storage.objects`, and `swarm.agent_tokens`.
11. Run the full production control suite against staging, including `cswarm check` and a listener wake round trip, and the client timeout table (scripts/timeout-table) through `edge-staging.commonswarm.com` with the gate the Strategist set: every client timeout constant at least 2x its p95 over 20 runs. Record status codes, versions, row counts, object totals, and Caddy validation. Do not record tokens, object names, emails, or URLs containing credentials.
12. Freeze preflight on production, read-only: run `run-db-tool.sh source-read-only.sh "$ARTIFACT_DIR" enable source` WITHOUT `FREEZE_UNGUARDED_TABLES`. It checks the source identity, prints the tables the source role cannot guard with a trigger, and exits 65 before any change. Record the list. Measured 2026-09-17: `auth.schema_migrations,storage.buckets_vectors,storage.migrations,storage.vector_indexes`. The roles the probe cannot assume on hosted Supabase were measured the same day as `postgres` is not a member of `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`; the probe also lists `postgres` itself only if it cannot assume it. Recompute both at window time; never copy them from this file.
13. Rehearse the freeze on the restored BOX database (target), never on production: `enable target`, `probe-database-freeze.sh frozen target`, `disable target`, `probe-database-freeze.sh writable target`, each with the acknowledgement variables the scripts print. `tests/p1-cli/n-db-freeze-hosted-shape.test.ts` proves the same scripts against the hosted permission shape on every test run.

The box rehearsal is a gate. A failed control means fix the preparation and repeat from a fresh dump.

## Cutover window

Ruling 9084e3e1: data rollback exists only at the decision point, while public writes are still behind the maintenance
block. After the box accepts writes it is the system of record and failures are fixed forward. The hosted project stays
read-only for 48 hours as a reference copy; nothing is restored into it.

Every `run-db-tool.sh` call below uses the protected `ARTIFACT_DIR` of this window, `COMMONSWARM_ENV_FILE` and
`COMMONSWARM_MIGRATION_ENV_FILE` as in the rehearsal, and `CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW` in the migration env file.

0. Before the window: the box rehearsal passed from a fresh dump within 24 hours; the stack images are pulled; the edge
   runtime is healthy on the pooler path; `SOURCE_SYSTEM_IDENTIFIER` is in the migration env file; the R2 backup prefix for
   the final dumps exists; the decision-point checklist below is printed with an owner for each row.
1. Install `commonswarm-api-maintenance.caddy` as the api site file: copy it over `/etc/caddy/sites/10-commonswarm-api.caddy`
   (keep the previous file as `.prev`), run `caddy validate` and read its exit code, then reload. Nothing public changes
   yet: `api.commonswarm.com` still points at Supabase.
2. Move `api.commonswarm.com` to the box (A 178.105.29.28, proxied) through the DNS holder. Path proof: a POST to
   `https://api.commonswarm.com/functions/v1/read` answers 503 with `{"error":"maintenance"}` (only the box sends that
   body), judged through `1.1.1.1` or a flushed resolver. From here every public write and every `/auth/v1` call is 503
   with `Retry-After: 300`; reads come from the Supabase origin. Announce the write pause.
   - ABORT-A (path proof fails): restore the Supabase CNAME (not proxied) and the previous site file.
3. Freeze the source. Export the list the preflight prints as `FREEZE_UNGUARDED_TABLES`, then run
   `run-db-tool.sh source-read-only.sh "$ARTIFACT_DIR" enable source`. It checks the source identity, refuses unless the
   acknowledgement matches, and applies the triggers and the read-only default in ONE transaction. Then export the role list
   it prints as `FREEZE_UNPROBED_ROLES` and run `run-db-tool.sh probe-database-freeze.sh "$ARTIFACT_DIR" frozen source`. It
   proves each role it can assume refused under `SET default_transaction_read_only = off` and `BEGIN READ WRITE`, by
   SQLSTATE 25006 only; any other error fails the probe.
   - What the freeze cannot stop: writes to the four tables the source role cannot trigger (service migration and vector
     tables) by a session that overrides the default, and any client that calls `ukezjcnxjvkpkeezxaew.supabase.co`
     directly instead of `api.commonswarm.com`. Before the window, read the Supabase API logs for requests whose host is the
     supabase.co name; if any product client still uses it, fix that client first.
   - ABORT-B (enable or probe fails): if enable failed, nothing changed. If the probe failed after enable, run
     `run-db-tool.sh source-read-only.sh "$ARTIFACT_DIR" disable source` and `probe-database-freeze.sh writable source`.
     Then ABORT-A.
4. Take the final dump into a NEW artifact directory with `dump-source.sh ... source`. Restore it to the box
   (`restore-target.sh`, `prepare-target.sh`, `seed-realtime-tenant.sh` twice, `setup-realtime.sh`, `verify-counts.sh`), start
   the stack and the edge runtime on the box database, then `copy-storage.sh forward` and `restore-storage-metadata.sh`.
   - ABORT-C (any step fails): disable the source freeze and probe writable as in ABORT-B, then ABORT-A. The box database is
     discarded.
5. Decision point, at most 30 minutes, through `edge-staging.commonswarm.com` only (the maintenance file routes it to the
   box). Every row must be green to leave:
   - `verify-counts.sh target` exact; object totals and digests match the manifest.
   - A migrated CLI human session refreshes; an authenticated REST read returns the expected workspace.
   - `cswarm check` on the shipped client succeeds within its budget; a listener wake round trip arrives.
   - One command and one read through the box edge runtime; one Realtime private Broadcast wake.
   - One file upload, commit, signed download, digest match through Storage API and R2.
   - The client timeout table through the staging name meets the 2x gate.
   - ABORT-D (not all green in 30 minutes): ABORT-C.
6. Take a dump of the BOX database (`dump-source.sh ... target`) and store it in R2 next to the nightly job. This is the
   recovery point before the box accepts writes.
7. Open writes: install `commonswarm-api.caddy` as the api site file (validate, read the exit code, reload). The box is now
   the system of record. Production controls on `api.commonswarm.com`: GitHub sign-in end to end (run in the operator's
   browser), `cswarm check` and a listener wake, one command, one upload, the install page, and the site. A failure now is
   fixed forward on the box.
8. Tell humans to sign in once more. Leave the hosted project frozen for 48 hours as a read-only reference copy; do not run
   `disable source`. Removing it is the separate retirement item.

## After the decision point: fix forward, and the recovery drill

There is no reverse restore to Supabase: hosted `postgres` cannot drop or recreate the service-owned `auth` and `storage`
tables, and the scripts refuse the hosted project as a destination. If the box database is lost or corrupted, restore the
latest dump (the step-6 dump, or a nightly `pg_dump -Fc`) onto a FRESH box database with `restore-target.sh`,
`prepare-target.sh`, `seed-realtime-tenant.sh`, `setup-realtime.sh`, and `verify-counts.sh`, behind the maintenance file.
Rehearse that drill once on a second local database before the window and record the result in LOCAL-REHEARSAL.md.

## Human sessions

The browser calls `getSession()` and then `getUser()` with its current access token. Production may have issued that token with an asymmetric key whose private half cannot be exported. This stack issues HS256 tokens with the measured legacy secret. An old asymmetric access token therefore fails `getUser`; the site clears its local session and shows the sign-in flow. A human signs in with GitHub once and then continues normally.

The CLI stores a refresh token and calls `refreshSession()` before each human operation. The restored `auth` schema carries that refresh token, so a CLI refresh is expected to exchange it for a new HS256 access token. The box rehearsal must prove this with a migrated session. The public release instruction still says to sign in once because browser sessions cannot depend on that path.

## Backups for HezLead

The backup target is container `commonswarm-postgres`, fixed IP `172.31.0.10`, database list `postgres` only. The database has no host-published port. Run the existing host backup process from bridge address `172.31.0.1` with role `backup_ro`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT=/etc/ssl/yulan-internal-ca.pem`, and the password supplied through `PGPASSWORD` in the process environment.

Each nightly set contains:

- `pg_dumpall --globals-only --no-role-passwords`
- `pg_dump --format=custom --dbname postgres`
- the R2 bucket's independent retention or versioning evidence

`backup_ro` has `pg_read_all_data` and `BYPASSRLS` (without it, `pg_dump` cannot read tables with row-level security) and no write grant. `pg_dumpall --globals-only --no-role-passwords` reads `pg_roles`, not `pg_authid`, so it runs as this role. `pg_hba.conf` rejects this role from every address except `172.31.0.1`.

## Not established

- Browser CORS and the `apikey` header without Kong: only the CLI and curl paths were rehearsed. The box rehearsal's GitHub
  sign-in and app load are the control.
- GitHub OAuth through the box: the callback is `api.commonswarm.com`, which is in maintenance until step 7, so sign-in is
  first proved after writes open (fix forward if it fails), unless the operator adds the staging callback to the OAuth app.
- The three hosted service roles the probe cannot assume, and the four tables the source role cannot trigger: covered by the
  front door and the database default only.
- Round-2 local forward and reverse rehearsal: run by the Maker before its credit ran out; its output was not saved and the
  lead did not re-run it. The reverse path is removed by ruling 9084e3e1. The box rehearsal is the gate.
