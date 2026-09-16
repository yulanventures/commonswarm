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
- Secrets: vault item `CommonSwarm self-hosted Supabase env` rendered to `/home/commonswarm/.env`, mode `0600`.
- TLS: the internal CA at `/etc/ssl/yulan-internal-ca.pem`; database certificate SANs are `db.commonswarm.internal` and `172.31.0.10`.

Before this stack starts, change the edge lane's `mem_limit` from `2g` to `512m`. Keep its loopback port `9000`. The total is then PostgreSQL 1536 MB, Realtime 512 MB, GoTrue 300 MB, PostgREST 300 MB, Storage API 300 MB, edge runtime 512 MB, and 600 MB reserved headroom: 4060 MB.

Every database URL used by GoTrue, PostgREST, Storage API, and edge-runtime must name `db.commonswarm.internal` and include `sslmode=verify-full` plus the CA path. Realtime uses `DB_SSL=true` and `DB_SSL_CA_CERT=/etc/ssl/yulan-internal-ca.pem`. Never use the IP in a service database URL.

## What moves in the dump

`dump-source.sh` selects these schemas:

- `auth`: users, identities, sessions, refresh tokens, MFA, and OAuth state.
- `storage`: the `swarm-files` bucket and object metadata. Object bytes are copied separately.
- `swarm`: all CommonSwarm durable data, including hashed `swm_agt_` rows.
- `swarm_read`: PostgREST views and functions.
- `public`: source public objects and grants.
- `supabase_migrations`: applied migration history.
- `realtime`: the broadcast table functions and CommonSwarm RLS policies. Ephemeral `realtime.messages` rows are excluded.

The target image creates `_realtime`, `extensions`, `graphql_public`, `net`, `pgbouncer`, `supabase_functions`, and `vault`. They are excluded so the image and pinned services own their internal migrations. `setup-realtime.sh` creates the self-host tenant and empty `supabase_realtime` publication after restore. The product uses Broadcast only, so no table belongs in that publication.

The role artifact contains only `swarm_*` and `commonswarm_*` role definitions and memberships. It excludes image roles such as `anon`, `authenticated`, `service_role`, `authenticator`, and `supabase_*`. It contains no password verifier. `prepare-target.sh` assigns fresh SCRAM verifiers from the vault.

## Box rehearsal from a fresh production dump

Use a new protected artifact directory for each attempt. Never reuse a dump after the source changes.

1. Confirm the target is the container and the source is the us-east-1 project. Confirm the PostgreSQL source reports 17.6. Do not use the host cluster's `commonswarm` database.
2. Read production versions from the public health endpoints. Record them. Update the named `image:` line in `compose.yaml` if needed. A changed pin requires a new rehearsal from step 1.
3. Install the internal CA and server certificate. Check certificate SANs and mode `0600` on the private key.
4. Render `/home/commonswarm/.env` from the one vault item and check mode `0600`. Use the legacy HS256 JWT secret for `JWT_SECRET`, `GOTRUE_JWT_SECRET`, `PGRST_JWT_SECRET`, `API_JWT_SECRET`, and `AUTH_JWT_SECRET`. Use the existing anon and service-role JWTs.
5. Start PostgreSQL only:

   ```sh
   cd /home/commonswarm/current/deploy/supabase-stack
   docker compose -p commonswarm-supabase-stack up -d postgres
   docker compose -p commonswarm-supabase-stack ps
   ```

6. With the production source URL present only in the environment, run `migrate/run-db-tool.sh dump-source.sh <absolute-artifact-dir>`. This creates a custom dump, password-free role SQL, per-table source counts, and the Storage object manifest. Logs and artifacts are mode `0600` under the protected directory.
7. Stop every target service except PostgreSQL. Run, in order:

   ```sh
   deploy/supabase-stack/migrate/run-db-tool.sh restore-target.sh <absolute-artifact-dir>
   deploy/supabase-stack/migrate/run-db-tool.sh prepare-target.sh <absolute-artifact-dir>
   docker compose -p commonswarm-supabase-stack up -d realtime
   deploy/supabase-stack/migrate/run-db-tool.sh setup-realtime.sh <absolute-artifact-dir>
   docker compose -p commonswarm-supabase-stack restart realtime
   deploy/supabase-stack/migrate/run-db-tool.sh verify-counts.sh <absolute-artifact-dir>
   ```

8. Start GoTrue, PostgREST, and Storage API. Run `migrate/copy-storage.sh` with source and target Storage URLs and service-role keys in the environment. It uploads every manifest object and verifies target SHA-256 and size.
9. Start the 512 MB edge runtime with its database URLs changed to the container. Run the five local health checks.
10. On a staging hostname, prove all of these through Caddy:
    - GitHub sign-in reaches `/auth/v1/callback`, returns to `https://commonswarm.com/app`, and loads a workspace.
    - A CLI refresh or fresh login succeeds with the unchanged legacy anon key.
    - An authenticated `swarm_read` REST query returns the expected workspace.
    - An agent subscribes to its private wake Broadcast and receives a directed-signal wake.
    - A file upload, commit, signed download, and digest comparison succeed through Storage API and R2.
    - One command and one read succeed through the edge runtime.
    - Source and target table counts still match, including `auth.users`, `storage.objects`, and `swarm.agent_tokens`.
11. Run the full production control suite against staging. Record status codes, versions, row counts, object totals, and Caddy validation. Do not record tokens, object names, emails, or URLs containing credentials.

The box rehearsal is a gate. A failed control means fix the preparation and repeat from a fresh dump.

## Cutover window

1. Announce the write freeze. Keep the current Supabase-origin Caddy routes available but do not enable the commented fallback block.
2. Run `source-read-only.sh enable` with `CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW`. It sets the source database default to read-only, terminates old sessions, and verifies a new session is read-only.
3. Take a final new dump and object manifest into a new artifact directory. Restore it to the container. Run target preparation, Realtime setup, exact row-count verification, and Storage copy.
4. Start all five services and the 512 MB edge runtime. Check Compose health and PostgreSQL TLS with `sslmode=verify-full`.
5. Install `commonswarm-api.caddy`, run `caddy validate`, then reload Caddy. Do not change DNS until local `--resolve` controls pass.
6. Move `api.commonswarm.com` to the box in the order recorded by the lead. Update the GitHub OAuth callback to `https://api.commonswarm.com/auth/v1/callback`.
7. Run production controls through the public URL: Auth settings, GitHub sign-in end to end, authenticated REST, command, read, Realtime wake, Storage upload/download, H0, install page, and exact database counts.
8. Tell humans to sign in once more. Keep the source project read-only and intact for 48 hours.

## Human sessions

The browser calls `getSession()` and then `getUser()` with its current access token. Production may have issued that token with an asymmetric key whose private half cannot be exported. This stack issues HS256 tokens with the measured legacy secret. An old asymmetric access token therefore fails `getUser`; the site clears its local session and shows the sign-in flow. A human signs in with GitHub once and then continues normally.

The CLI stores a refresh token and calls `refreshSession()` before each human operation. The restored `auth` schema carries that refresh token, so a CLI refresh is expected to exchange it for a new HS256 access token. The box rehearsal must prove this with a migrated session. The public release instruction still says to sign in once because browser sessions cannot depend on that path.

## Backups for HezLead

The backup target is container `commonswarm-postgres`, fixed IP `172.31.0.10`, database list `postgres` only. The database has no host-published port. Run the existing host backup process from bridge address `172.31.0.1` with role `backup_ro`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT=/etc/ssl/yulan-internal-ca.pem`, and the password supplied through `PGPASSWORD` in the process environment.

Each nightly set contains:

- `pg_dumpall --globals-only --no-role-passwords`
- `pg_dump --format=custom --dbname postgres`
- the R2 bucket's independent retention or versioning evidence

`backup_ro` has `pg_read_all_data` and no write grant. `pg_hba.conf` rejects this role from every address except `172.31.0.1`.

## Rollback during the 48-hour hold

Rollback is a data move, not only a Caddy edit.

1. Freeze public writes to the box. Keep reads available only if they cannot create Auth, Storage, or product rows.
2. Put the box database read-only and terminate old service sessions.
3. Take a final selected-schema dump and object manifest from the box.
4. With the old Supabase project still read-only, restore the final box state into its `auth`, `storage`, `swarm`, `swarm_read`, `public`, `supabase_migrations`, and `realtime` schemas. Copy every R2 object back through the old Storage API. Verify exact table counts and object digests.
5. Run the complete control set against the Supabase project URL before public traffic moves.
6. Enable the commented Supabase-origin Caddy fallback routes, validate Caddy, reload, then verify the public URL.
7. Run `source-read-only.sh disable` only after public traffic is confirmed on the fallback.

Writes accepted on the box during the hold exist only in the box database and R2 until steps 3 and 4 finish. Switching Caddy first would lose those writes from the user's view. If reverse restore or object verification fails, remain on the box and repair it; do not route to stale data.

After 48 hours and operator approval, remove the fallback only as part of the separate retirement item.
