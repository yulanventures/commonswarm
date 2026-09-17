# Local N-db rehearsal — RUN AND PRODUCTION-PIN RERUN 2026-09-16

The box and production were not contacted. The source was the already-running local Supabase stack on `127.0.0.1:54321–54329`. The target used Compose project `n-db-rehearsal`, external network `commonswarm-net`, fixed database address `172.31.0.10`, loopback ports `18000–18005`, generated test secrets, and a generated two-day internal CA. The final run used the production pins supplied by the lead: PostgreSQL `17.6.1.147`, GoTrue `v2.197.0`, and Storage API `v1.77.5`. PostgREST `v14.5` and Realtime `v2.86.3` remain the local CLI pins because their production endpoints publish no version.

## Results

| Step | Result |
|---|---|
| Images | Pulled and ran PostgreSQL `17.6.1.147`, GoTrue `v2.197.0`, PostgREST `v14.5`, Realtime `v2.86.3`, and Storage API `v1.77.5`. |
| Source fixture | Created one confirmed local Auth user, completed password sign-in, and uploaded one text object. The fixtures were removed after the run. |
| Dump | Exit 0. Custom dump size 7,055,733 bytes. Selected 7 schemas, 84 table counts, and 273 `swarm-files` object rows. `realtime.messages` data was excluded. |
| Roles | Generated password-free application role SQL. The target image created its own Supabase roles; the role artifact supplied CommonSwarm roles and `supabase_realtime_admin`. |
| Restore | Exit 0 in one transaction after the role artifact. |
| Target role preparation | Exit 0. All login passwords were checked as SCRAM verifiers. `backup_ro` and `commonswarm_edge` received only their planned memberships. |
| Row counts | Exit 0. All 84 source and target table counts matched: 2,470 Auth users, 2,179 agent-token rows, and 273 Storage object rows. This check ran before target-only rehearsal writes. |
| Realtime control state | The pinned Realtime application seeded the encrypted tenant and extension. The setup script enabled database TLS, kept `supabase_realtime` empty, and found all three CommonSwarm Broadcast policies. Health returned 200. |
| Storage copy | Exit 0. Copied and SHA-256 checked 273 objects, 6,882 bytes total. A second run also passed, proving idempotent upsert behavior. |
| Migrated human session | The old source access token was rejected by target GoTrue. The migrated refresh token returned 200 and issued a target HS256 session. A fresh target password sign-in also returned 200. |
| Edge command | `create_workspace` through `/functions/v1/command` returned 200 and `accepted`. This used the pinned edge image with a temporary copy of the edge owned functions that passed the internal CA explicitly to `postgres(...)`; the committed CommonSwarm function files were not edited. |
| Authenticated REST | A `swarm_read.workspaces` read through `/rest/v1/workspaces` returned the new workspace, HTTP 200. |
| CLI pointed at target | Built `dist/cli.js` used `SWARM_CLOUD_URL=http://127.0.0.1:18000`, the unchanged target anon JWT, and an imported refresh session. `cswarm status --json` exited 0 and returned JSON. |
| Storage upload/download | An upsert through `/storage/v1/object/swarm-files/...` returned success; an authenticated download returned bytes with the same SHA-256. |
| Realtime wake | A private `cswarm-wake:{wake_id}` channel reached `SUBSCRIBED`. A database `realtime.send` wake arrived through Caddy: `{"subscribed":true,"received":true,"detail":"wake"}`. |
| Health | PostgreSQL, GoTrue, PostgREST, Realtime, Storage API, edge runtime, and the local Caddy gateway were healthy or returned their planned health response. |

The service results did not change after the production pin update. Every Auth, REST, CLI, Storage, Realtime, edge, count, and health control passed again. The local source continued to change between runs, so the compressed dump changed from 7,077,101 to 7,055,733 bytes and copied object bytes changed from 6,873 to 6,882. The table count, object count, and named row counts stayed the same.

## Problems found and fixed in preparation

1. The PostgreSQL image bootstrap user is `supabase_admin`. Setting `POSTGRES_USER=postgres` skipped the image's role setup. The example now preserves `supabase_admin`.
2. The CommonSwarm init hook sorted before the image's `migrate.sh`. Its mount name now starts with `zz-`.
3. The image does not create the no-login `supabase_realtime_admin` owner. The password-free role dump now carries it.
4. Realtime needs `_realtime` before its repository migrations. Target preparation creates that image-owned schema.
5. A self-signed leaf is not an internal CA. The successful run used a CA certificate with `CA:TRUE` and a separately signed leaf containing both ruled SANs.
6. A shared env file gave Storage API Realtime's `PORT=4000`. `SERVER_PORT=5000` and `SERVER_ADMIN_PORT=5001` now make Storage's bind explicit.
7. Realtime stores its tenant JWT and database password encrypted. Direct SQL insertion was unreadable. The pinned Realtime seeder now creates those rows; SQL only enables TLS and verifies policy state.
8. `DB_ENC_KEY` must be 16 ASCII characters for the pinned Realtime AES-128 implementation.
9. Edge Runtime workers do not inherit arbitrary main-service variables. The router must pass the database CA variable.
10. `postgres` 3.4.9 ignored a CA file URL parameter and the process CA settings in this Edge Runtime. The successful temporary function copy passed the decoded public CA as `ssl.ca` with certificate verification enabled and kept `sslmode=verify-full`. Its URL omitted `sslrootcert`, which this client otherwise sent to PostgreSQL as an invalid startup parameter.
11. The edge database URL uses the dedicated `commonswarm_edge` password, not the shared service password.
12. The original PostgreSQL health check used its Unix socket. It could pass before a separate migration container could connect on the bridge. The committed health check now connects to `172.31.0.10` with `sslmode=verify-full` and the internal CA.
13. A fresh Realtime tenant reports `SUBSCRIBED` while it can still be creating its Broadcast publication and replication slot. The final control allowed that initialization to finish and then received the database wake.

## Signed-in human after cutover

The site loads its stored access token, then calls GoTrue `getUser`. An old asymmetric production token cannot be checked by this HS256-only GoTrue instance. The call fails, `currentSession()` clears the local browser session, and the app shows its sign-in path. The human signs in with GitHub once.

The imported Auth rows preserve refresh tokens. The local migrated refresh returned 200 and produced a new HS256 token. The CLI calls `refreshSession()` before each human operation, so its refresh path can continue without an interactive login when the migrated token is still valid. The release instruction still tells every human to sign in once because the browser path does not proactively replace an otherwise unexpired access token after an API rejection.

## Not established

- No box rehearsal from a production dump was run.
- No production endpoint, Supabase project, SSH host, DNS record, Cloudflare API, Tailscale node, or vault was contacted.
- GitHub OAuth was not run because this lane did not read the production client secret.
- R2 was not contacted. The local Storage API used its file backend; the same API copy path is configured for R2 in production.
- This lane did not independently read production service versions. It used the lead's 2026-09-16 21:20Z results. Production PostgREST and Realtime versions remain unknown because their endpoints publish no version; those two pins come from the local Supabase CLI stack.
- The edge owned repository files gained the explicit `ssl.ca` change in `41dd7ef8`. The box rehearsal still must prove it with the installed CA.
- A production asymmetric access token and production refresh token were not read. Human behavior above combines the locally measured key-change control with the site and CLI code paths.
- The production Caddy block was adapted for syntax but was not installed or reloaded.

## Round 2 (2026-09-17): hosted permission shape

The round-1 rehearsal connected to the local Supabase stack as a superuser. Read-only queries on production (lead, project
ref confirmed first, timestamps and booleans only) showed a different permission shape:

| production fact (2026-09-17) | effect on the round-1 scripts |
|---|---|
| `postgres` is not a superuser; it owns the database; `pg_monitor` and `pg_signal_backend` member; `BYPASSRLS` | identity by `pg_control_system().system_identifier` is readable; ending other sessions is allowed but counted per session |
| `app.settings.jwt_secret` is not set | the source identity check could never pass |
| no TRIGGER right on `auth.schema_migrations`, `storage.migrations`, `storage.buckets_vectors`, `storage.vector_indexes` | the freeze stopped partway |
| not a member of `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin` | the probe counted SET ROLE refusals as "frozen" |

Measured on a throwaway PostgreSQL 17.11 with a non-superuser database owner: `ALTER DATABASE ... SET` of a custom
`commonswarm.*` parameter is refused; `default_transaction_read_only` is allowed; a trigger on another role's table without
TRIGGER is refused; `DROP TRIGGER` on a table the role does not own is refused, while `DROP FUNCTION ... CASCADE` of the
guard function it owns removes those triggers. Also found: psql's `\quit` takes no exit status, so the round-1 source
identity check exited 0 on a mismatch.

`tests/p1-cli/n-db-freeze-hosted-shape.test.ts` builds that shape and runs the real `source-read-only.sh` and
`probe-database-freeze.sh` in a tool container. It passes, and each of these mutations fails it: enable without one
transaction (a failure left the probe schema behind); the probe counting any error as frozen; the identity check using
`\quit 1`; enable without the acknowledgement preflight. The test proves: a wrong system identifier and a missing
acknowledgement change nothing; a failure inside enable leaves nothing; both session bypasses are refused with 25006 on an
owned and on a granted service table; the probe refuses unacknowledged unprobed roles and fails on a non-freeze error;
disable removes every freeze object and writes work again.

NOT re-run by the lead: the Maker's round-2 forward and reverse local rehearsal (it reported forward restore, reverse
restore, metadata repair, wrong-CA refusal for GoTrue, Storage API and Realtime, and backups passing before its credit ran
out; its output was not saved). The reverse direction was then removed by ruling 9084e3e1. The box rehearsal from a fresh
production dump is the gate for the full forward path.

## Review round 2 (2026-09-17): rulings

Pair on `5ba69436`: grok (worktree, FAIL) and antigravity (six inline parts; part 2 was blocked by a Gemini content filter
and re-run with the word "attack" replaced; P1 PASS, P2-P6 FAIL). The lead checked every claim on the tree, in Docker, or
with a read-only query on production before ruling. PRODUCTION = changes what production or the window does; RIGOUR =
claim, test, or operator-text defect.

| # | Claim (arm) | Ruling | Evidence |
|---|---|---|---|
| 1 | pg_cron schedules never reach the box; five purge jobs stop (grok) | CONFIRMED, PRODUCTION | `cron` is outside `selected_schema_csv`; no script called `cron.schedule`; production has five jobs, all `postgres` in `postgres` (read-only query 2026-09-17); the box image preloads pg_cron but has no extension or jobs. Fixed: `dump-source.sh` exports `cron-jobs.ndjson` in the snapshot, `restore-cron-jobs.sh` recreates them, `verify-counts.sh` compares, `tests/p1-cli/n-db-cron-jobs.test.ts` proves it on the box image. |
| 2 | `STORAGE-BACKEND.md` describes a reverse restore into the hosted project; `copy-storage.mjs` still copies in reverse (grok, antigravity P6) | CONFIRMED, PRODUCTION (text and a reachable reverse path) | Line 15 contradicted ruling 9084e3e1; `node copy-storage.mjs reverse` wrote to the source Storage API although `copy-storage.sh` refused. Fixed: forward only in both; paragraph rewritten. |
| 3 | `run-db-tool.sh` does not pass `CUTOVER_CONFIRM`, so the logged UNDO command fails (antigravity P2) | PARTLY CONFIRMED, RIGOUR | The runbook put the value in the migration env file, which the container receives, so the runbook path worked; the inline form printed in the NEXT/UNDO log lines did not reach the container. Fixed: forwarded by name; the env file keeps it empty. |
| 4 | Postgres `-D /etc/postgresql` crashes the container (antigravity P4) | REFUTED | `docker image inspect` of `supabase/postgres:17.6.1.147`: CMD is `postgres -D /etc/postgresql`; its `postgresql.conf` sets `data_directory = '/var/lib/postgresql/data'`. |
| 5 | `prepare-target.sh` grants `swarm_*` roles before they exist (antigravity P3) | REFUTED | The runbook runs `restore-target.sh` (which applies `roles.sql`) before `prepare-target.sh`, in the rehearsal, the window, and the drill. |
| 6 | `10-runtime-roles.sh` never creates `commonswarm_edge` (antigravity P4) | REFUTED | `prepare-target.sh` creates it, sets its password, and grants exactly the three `swarm_*` roles. |
| 7 | Maintenance lets `GET /functions/v1/*` reach hosted functions that write (antigravity P4) | REFUTED as a data-loss path | `command`, `read` and `activity` answer 405 to any method but POST before any database call. `capability` counts a GET in its rate buckets (and may write an alert or audit row) before its 405: before the step-3 freeze those rows are in the final dump; after it the write fails with 25006. The runbook names this. |
| 8 | Realtime websocket frames bypass maintenance (antigravity P5, grok) | CONFIRMED as text, not a data path | Frames reach hosted Realtime until step 7; they are wake hints and `realtime.messages` is not migrated. The runbook claim "every public write is 503" is corrected. |
| 9 | Step 2 says reads come from the Supabase origin, but edge reads are POST and get 503 (antigravity P6) | CONFIRMED, RIGOUR | Measured on `4cb8c5fe` against a loopback 503 server: `cswarm check` exits 1 in about 3.2 s, `inbox` exits 1, `note` exits 1 in about 6.2 s with the maintenance sentence. The hook form was not measured. Runbook corrected. |
| 10 | `system_identifier` accepts a standby (antigravity P2, P6; grok) | CONFIRMED, RIGOUR | A standby shares the identifier. The window order freezes before it dumps, and enable fails on a standby, so no dump from a standby was reachable. Fixed: `NOT pg_is_in_recovery()`; a promoted clone on another host stays out of reach of this check (named in `lib.sh`). |
| 11 | Step 4 restores onto the rehearsal database (antigravity P6) | CONFIRMED, RIGOUR | `pg_restore --clean --single-transaction` would fail safe into ABORT-C, but running services and box-only objects make that likely. Runbook: restore onto a fresh data directory, rehearsed once. |
| 12 | Re-running enable while frozen fails (grok) | CONFIRMED, RIGOUR (fails closed) | Fixed: enable starts with `SET TRANSACTION READ WRITE`; the hosted-shape test proves a second enable succeeds and changes nothing. |
| 13 | The writable probe runs DDL on the source during ABORT-B (grok) | CONFIRMED, RIGOUR | Needed to prove writes work; the runbook names it. |
| 14 | Fallback routes are a separate file, not commented in the live file (grok, antigravity P4) | CONFIRMED as text, RIGOUR | The separate file is byte-identical to the landed N-edge file and adapts; after step 7 it must never be installed (ruling 9084e3e1). Comment and runbook say so. `MUTATION-EVIDENCE.md` listed an "uncomment the fallback" mutation the test never ran; corrected. |
| 15 | `nothingChanged()` does not check the guard function (antigravity P5) | CONFIRMED, RIGOUR | Added `to_regprocedure(...) IS NULL`; step 3 drops the planted function (no CASCADE) before the check. |
| 16 | The artifacts mount is created by the Docker daemon (antigravity P5) | CONFIRMED, RIGOUR | Created by the test with mode 0700. |
| 17 | Target identity is not gated for `restore-target.sh` (antigravity P5) | CONFIRMED as a test gap, RIGOUR | The script calls `assert_target_identity`; the contract test now requires it in every target writer. |
| 18 | Secret scan misses `- NAME=value` (antigravity P5) | CONFIRMED, RIGOUR | Pattern extended, with a mutation. |
| 19 | shm, shared_buffers, data mount, backup_ro read grant and pg_hba address are not asserted (antigravity P5) | CONFIRMED, RIGOUR | Assertions and mutations added. |
| 20 | Quoted env values differ between Node and `docker --env-file` (antigravity P2) | CONFIRMED, RIGOUR | A quoted `POSTGRES_PASSWORD` would have set a password with quotes. Both Node readers now refuse a quoted value and name only the variable. |
| 21 | `database_psql` and `pg_dump` in `dump-source.sh` do not require the service file (antigravity P2, P3) | CONFIRMED, RIGOUR | Guards added. |
| 22 | Runbook script paths do not resolve from the documented directory (antigravity P6) | CONFIRMED, RIGOUR | One absolute `MIGRATE` path. |
| 23 | `LOCAL-REHEARSAL.md` says the edge `ssl.ca` change is still owed (antigravity P6) | CONFIRMED, RIGOUR | Stale since `41dd7ef8`; corrected in place. |
| 24 | Bare `/rest/v1`, `/auth/v1`, `/storage/v1` answer 404 (antigravity P4) | DECLINED | No CommonSwarm client calls a bare path (`ENDPOINTS.md`); recorded under Not established. |
| 25 | Temporary SQL files lack a trap (antigravity P2) | DECLINED | They hold no secret and live in a `--rm` container. |

Production state outside the dump, read-only 2026-09-17: extensions pg_cron 1.6.4, plpgsql, pgcrypto, uuid-ossp,
pg_stat_statements, supabase_vault; zero vault secrets; no `supabase_functions.hooks` table; five cron jobs (above);
role settings equal to the box image except database-level `app.settings.jwt_exp=3600` (no CommonSwarm code reads it),
`supabase_realtime_admin` search_path (a NOLOGIN role, so a role setting never applies) and `swarm_command` search_path
(carried by `roles.sql`).
