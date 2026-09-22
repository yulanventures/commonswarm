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
12. The original PostgreSQL health check used its Unix socket. It could pass before a separate migration container could connect on the bridge. The committed health check runs `pg_isready` against `172.31.0.10` without TLS options; it proves bridge TCP reachability, while the service connection controls prove TLS separately.
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
| 14 | Fallback routes are a separate file, not commented in the live file (grok, antigravity P4) | CONFIRMED as text, RIGOUR | The separate file was byte-identical to the landed N-edge file. 2026-09-22: that fallback file and the pre-cutover edge file were removed. There is no fallback to another host. Recovery and a later pause use `commonswarm-api-maintenance.caddy`. Its public site answers 503 and has no upstream. |
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

Found by the lead while checking the fold (not raised by either arm):

| # | Finding | Ruling | Evidence and fix |
|---|---|---|---|
| 26 | The box GoTrue had no Google settings, but production enables Google sign-in | CONFIRMED, PRODUCTION | Read-only `GET /auth/v1/settings` 2026-09-17: github, google and email enabled. Added the four `GOTRUE_EXTERNAL_GOOGLE_*` names to `env.example` and the GoTrue required-env list; `supabase-stack.test.ts` requires every production provider and the box callback, with mutations. The Google client needs the box callback added before the window (operator); GitHub gets a yulanventures-owned app with that callback (HezLead). |
| 27 | The production "preflight" in the rehearsal was `enable` without the acknowledgement; with an empty unguarded list it would have frozen production | CONFIRMED, PRODUCTION hazard | `"${FREEZE_UNGUARDED_TABLES:-}" != ""` was false for an empty list. Added a read-only `preflight` mode (exit 0, no confirmation needed), and `enable` now refuses unless the acknowledgement is SET. The hosted-shape test proves both, with an empty list. |
| 28 | The Maker's runbook rewrite dropped ABORT-A, ABORT-D, the 1.1.1.1 DNS judgement, the write-pause announcement, the `.prev` file, what the freeze cannot stop, and the step-7 production controls; it also made a second production `enable` routine | CONFIRMED, RIGOUR | Restored by the lead; the second `enable` is only a safe retry. |

Production state outside the dump, read-only 2026-09-17: extensions pg_cron 1.6.4, plpgsql, pgcrypto, uuid-ossp,
pg_stat_statements, supabase_vault; zero vault secrets; no `supabase_functions.hooks` table; five cron jobs (above);
role settings equal to the box image except database-level `app.settings.jwt_exp=3600` (no CommonSwarm code reads it),
`supabase_realtime_admin` search_path (a NOLOGIN role, so a role setting never applies) and `swarm_command` search_path
(carried by `roles.sql`).

## Review round 3 (2026-09-17): rulings

Pair on `0e3ecc1d`: grok FAIL; antigravity PASS on parts P1, P2, P4, P5a and P5b, FAIL on P3 and P6. The lead checked each
claim on the tree or with Docker before ruling. Both arms found that the window, as written, could not finish; that is
ruled PRODUCTION and buys round 4.

| # | Claim (arm) | Ruling | Evidence and fix |
|---|---|---|---|
| 29 | Window step 4 stops the edge runtime and nothing starts it again (grok, antigravity P6) | CONFIRMED, PRODUCTION | `RUNBOOK.md` had `docker compose ... edge-runtime ... down` and no `up`; step 5 edge checks and step 7 `/functions/v1` would hit a dead port. The rehearsal and the window now start it on the box database with `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net` and the box URLs, and check its health. |
| 30 | Window step 3 has no preflight and no `ARTIFACT_DIR` (antigravity P6) | CONFIRMED, PRODUCTION | `ARTIFACT_DIR` was first set in step 4, and nothing produced `FREEZE_UNGUARDED_TABLES` or `FREEZE_UNPROBED_ROLES` at window time, so the freeze would stop. Step 0 sets the window directories; step 3 runs `preflight`, sets the list, runs the frozen probe once to print the unprobed roles, then again with them. |
| 31 | `seed-realtime-tenant.sh` needs `COMMONSWARM_ENV_FILE` and `COMMONSWARM_MIGRATION_ENV_FILE`, which the documented commands do not pass (grok) | CONFIRMED, PRODUCTION | The script now uses the same defaults as `run-db-tool.sh` and requires every path to be absolute (antigravity P3). |
| 32 | `prepare-target.sh` grants `swarm_*` roles before they exist (antigravity P3) | REFUTED (second time) | Rehearsal, window and drill all run `restore-target.sh` (which applies `roles.sql`) before `prepare-target.sh`. |
| 33 | `prepare-target.sh` requires `MIGRATION_ARTIFACT_DIR` and never uses it (antigravity P3) | REFUTED | `start_log` writes the protected log under it. |
| 34 | The cron export does not hide other owners' jobs: `postgres` has BYPASSRLS (grok) | CONFIRMED, RIGOUR | Measured on the box image; hosted `postgres` has BYPASSRLS too (2026-09-17). The comment and the runbook no longer say row security limits the export. The cron test now adds a job owned by `supabase_admin` and proves it is exported and restored under that owner. |
| 35 | The "cron snapshot" contract matched the counts query's snapshot line (grok) | CONFIRMED, RIGOUR | The check now reads only the cron export block; a mutation removes only that block's snapshot line. |
| 36 | An unset `FREEZE_UNPROBED_ROLES` acknowledges an empty list (grok) | CONFIRMED, RIGOUR | The probe now requires the acknowledgement SET, as `enable` does; the hosted-shape test proves it with an empty list. |
| 37 | `LOCAL-REHEARSAL.md` says the health check uses verify-full and the CA (grok) | CONFIRMED, RIGOUR | It is `pg_isready` to 172.31.0.10 without TLS options; corrected. |
| 38 | Rehearsal step 4 lists the freeze drill before the box database exists (antigravity P6) | CONFIRMED, RIGOUR | The commands moved to step 13. |
| 39 | The seed command appears twice with no reason (antigravity P6) | CONFIRMED, RIGOUR | The note is back: the second run must also exit 0 (idempotency). |
| 40 | `ENDPOINTS.md` omits Google sign-in (antigravity P6) | CONFIRMED, RIGOUR | Added. |
| 41 | `postgres:17.11` does not exist (antigravity P5b) | REFUTED | `docker image inspect postgres:17.11`: created 2026-08-25. |
| 42 | The foreign cron entry sorts first, so the test does not prove rollback after earlier jobs were scheduled (antigravity P5b) | CONFIRMED, RIGOUR | The foreign entry now sorts last. |
| 43 | Unused `readFile` import in the cron test (antigravity P5b) | CONFIRMED, RIGOUR | Removed. |
| 44 | The edge Compose network mode comes from shell interpolation and defaults to bridge (antigravity P1, grok) | CONFIRMED, RIGOUR | Every documented edge start passes `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`. |

## Review round 4 (2026-09-17): rulings

Pair on `c8e1396f`: antigravity PASS on all eight parts (P3 and P4 re-run after a network error; one RIGOUR note repeats
ruling 14); grok FAIL. The lead checked grok's claims against the live-box record in
`docs/org/2026-09-16-N-EDGE-RESUME-HERE.md` and the tree.

| # | Claim (arm) | Ruling | Evidence and fix |
|---|---|---|---|
| 45 | The runbook stops and starts Compose project `edge-runtime` from `/home/commonswarm/current`, but the live edge runtime is project `commonswarm-edge` under `/home/commonswarm/edge/current`; `up -d` then fails on port 9000 and the `until healthy` loop on an empty container id never ends, with production frozen (grok) | CONFIRMED, PRODUCTION | Resume record lines 177-181: release directory `/home/commonswarm/edge/releases/<sha>`, `current` symlink, project `commonswarm-edge`, container `commonswarm-edge-edge-runtime-1`. Every edge command now uses that directory and `-p commonswarm-edge`; the rehearsal installs this lane's edge release (with the TLS helper) the same way; every wait loop is bounded and exits non-zero with a message. |
| 46 | PostgreSQL is restored right after `up -d postgres`, before it accepts connections (grok) | CONFIRMED, PRODUCTION | The health check has a 60 s start period and a fresh directory runs the image init. Rehearsal, window and drill now wait, bounded, for the container to be healthy before the restore. |
| 47 | Rehearsal step 13 reuses the source acknowledgement for the target (grok) | CONFIRMED, RIGOUR | Step 13 runs `preflight target` and sets the list from that output. |
| 48 | The ABORT-B writable probe does not pass `FREEZE_UNPROBED_ROLES` and exits 65 (grok) | CONFIRMED, RIGOUR | ABORT-B computes or reuses the list and passes it. |
| 49 | A session whose termination was refused keeps the old default and can write unguarded tables without `BEGIN READ WRITE` (grok) | CONFIRMED, RIGOUR | The runbook names it; step 3 reads the refused count in the enable log and lists such sessions read-only before continuing. |
| 50 | After ABORT-C, staging uploads leave object bytes in R2 with no rows (grok) | CONFIRMED, RIGOUR | Named in the runbook as orphans to remove; no hosted bytes are lost. |
| 51 | Nothing checks that the five JWT secret names hold the same value (grok) | CONFIRMED, RIGOUR | The rehearsal compares SHA-256 digests of the five values without printing them; one distinct digest is required. |
| 52 | Realtime is not restarted after `setup-realtime.sh` in the window and the drill (grok) | CONFIRMED, RIGOUR | Restart added where the rehearsal already has it. |
| 53 | The recovery drill's `mv` target already exists after the window, and the drill never starts the stack or the edge (grok) | CONFIRMED, RIGOUR | Unique timestamped directory name; the drill starts the stack and the edge with the same bounded waits. |
| 54 | Nothing checks that `commonswarm-net` exists (grok) | CONFIRMED, RIGOUR | Rehearsal step 1 and window step 0 run `docker network inspect commonswarm-net`. |
| 55 | `TARGET_STORAGE_URL` is not specified; `api.commonswarm.com` would answer 503 during the window (grok) | CONFIRMED, RIGOUR | `migration.env.example` and the runbook name the value the copy uses during the window, derived from `copy-storage.mjs`. |
| 56 | The first frozen probe exits 65 by design, so a pasted block under `set -e` stops (grok) | CONFIRMED, RIGOUR | The runbook says to run each command and read its exit code, and marks the expected 65. |
| 57 | The stack directory `/home/commonswarm/current` has no defined layout on the box (lead) | CONFIRMED, RIGOUR | `STACK_DIR` and `EDGE_DIR` are defined once next to `MIGRATE`, following the edge release layout; HezLead confirms them in rehearsal step 1. |
| 58 | Fallback routes are not commented in the live file (antigravity P4) | Already ruled (14) | No change. |

## Review round 5 (2026-09-17): rulings

Pair on `d8418ee2`: antigravity PASS on all eight parts; grok PASS with seven RIGOUR notes. The round is clean. RIGOUR
notes fold without another pair (pacing rule). Strategist ruling A: N-db lands when this round is clean AND the box
rehearsal passes end to end, including the recovery drill.

| # | Note (arm) | Ruling | Fix |
|---|---|---|---|
| 59 | `copy-storage.mjs` does not allow-list `TARGET_STORAGE_URL`, so a wrong value could upsert into hosted Storage (grok) | CONFIRMED, RIGOUR | The target must be `http://127.0.0.1:18004` (or a local-rehearsal host named the same way as `TARGET_DATABASE_URL`), otherwise the copy refuses before any request; contract check with a mutation. |
| 60 | Rehearsal step 8 copies Storage without waiting for `storage-api` (grok) | CONFIRMED, RIGOUR | Bounded `wait_healthy` for storage-api before the copy in the rehearsal, the window and the drill. |
| 61 | The window moves the rehearsal data directory to a fixed name, so a second attempt nests it (grok) | CONFIRMED, RIGOUR | Unique timestamped name, as in the drill (ruling 53). |
| 62 | `deploy/edge-runtime/RUNBOOK.md` starts Compose without `-p commonswarm-edge` (grok) | CONFIRMED, RIGOUR | Project name added there too. |
| 63 | No Kong CORS on auth, rest and storage (grok) | Already recorded | Under Not established; first browser proof at window step 7. |
| 64 | A dump of a FROZEN source through the hosted pooler is proven only on local PostgreSQL (grok) | CONFIRMED, RIGOUR | Named under Not established; a failure there fails closed into ABORT-B. |
| 65 | `run-db-tool.sh` runs the tool container as root, so artifacts are root-owned 0600; a mixed user and sudo session cannot read the enable log (grok) | CONFIRMED, RIGOUR | The runbook says to run the rehearsal, the window and the drill from one root shell (`sudo -i`), and says why. |
