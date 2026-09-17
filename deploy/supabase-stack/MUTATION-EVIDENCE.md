# Contract mutation evidence

`tests/p1-cli/supabase-stack.test.ts` reads the committed files. It applies each mutation below and requires the shown failure line.

| Named mutation | Required failure line |
|---|---|
| Put `exit 1` back into the `wait_healthy` helper in `RUNBOOK.md` | `bounded health helper calls exit` |
| Put `exit 1` back into a pasted one-line check in `RUNBOOK.md` | `runbook command calls exit` |
| Remove `-p commonswarm-edge` from an edge `docker compose` command in `RUNBOOK.md` | `edge compose command missing -p commonswarm-edge` |
| Remove the first PostgreSQL health wait before `restore-target.sh` in `RUNBOOK.md` | `PostgreSQL start 1 missing bounded health wait before restore-target.sh` |
| Remove the first Storage API health wait before `copy-storage.sh` in `RUNBOOK.md` | `Storage copy 1 missing bounded storage-api health wait` |
| Disable Google sign-in | `auth provider GOOGLE not enabled` |
| Remove the Google client secret name | `auth provider GOOGLE SECRET name missing` |
| Change the GitHub callback to the hosted project | `auth provider GITHUB callback` |
| Remove `POSTGRES_PASSWORD` from `env.example` | `env missing POSTGRES_PASSWORD` |
| Publish PostgreSQL on loopback | `postgres port published` |
| Change GoTrue memory from 300 MB to 700 MB | `memory gotrue` |
| Change the pinned GoTrue image | `image gotrue` |
| Change the PostgreSQL health address | `postgres bridge health path` |
| Add a mapping-form Compose secret | `secret-like compose value` |
| Add a list-form `- SERVICE_KEY=value` Compose secret | `secret-like compose value` |
| Change PostgreSQL shared memory | `postgres shm size` |
| Change PostgreSQL `shared_buffers` | `postgres shared buffers` |
| Change the GoTrue Caddy upstream | `route handle /auth/v1/*` |
| Shorten the edge function timeout | `function timeout` |
| Remove Storage API CA trust | `storage CA trust` |
| Remove Realtime HTTP/1.1 transport | `realtime no-buffer http1` |
| Remove backup `BYPASSRLS` | `backup BYPASSRLS` |
| Remove the exported snapshot from `pg_dump` | `one dump snapshot` |
| Remove the exact Realtime update count | `Realtime update count` |
| Rename the freeze trigger | `freeze trigger or undo` |
| Remove the prepare target identity check | `target identity guard prepare` |
| Remove the Realtime setup target identity check | `target identity guard setup` |
| Remove the database restore target identity check | `target identity guard restore` |
| Remove the Storage metadata target identity check | `target identity guard restoreStorage` |
| Remove the count verification target identity check | `target identity guard verify` |
| Remove the cron restore target identity check | `target identity guard restoreCron` |
| Read a Storage service key from `process.env` | `storage key in process env` |
| Allow reverse Storage copy | `storage reverse direction` |
| Put `/storage/v1` back in front of `/object/` in `copy-storage.mjs` | `storage base url paths` |
| Change the allowed box Storage target from `127.0.0.1` to `127.0.0.2` | `storage target allow-list` |
| Remove target `pg_net` creation | `required source extensions` |
| Remove the source standby refusal | `source standby guard` |
| Remove only the cron export block's `SET TRANSACTION SNAPSHOT` line | `cron snapshot export` |
| Replace the cron verification query | `cron verify query` |
| Replace the cron restore listing query | `cron restore query` |
| Rename the shared cron listing comparator | `cron listing comparator` |
| Stop calling the comparator from `verify-counts.sh` | `cron verify comparator` |
| Stop calling the comparator from `restore-cron-jobs.sh` | `cron restore comparator` |
| Restore a bytewise `diff` of cron listings in `verify-counts.sh` | `cron verify bytewise diff` |
| Restore a bytewise `diff` of cron listings in `restore-cron-jobs.sh` | `cron restore bytewise diff` |
| Remove the seed script's default service environment path | `seed environment path defaults` |
| Stop checking that the seed migration environment path is absolute | `seed absolute paths` |
| Stop checking that the seed migration environment file exists | `seed existing paths` |
| Remove `pg_read_all_data` from `backup_ro` | `backup read grant` |
| Widen the `backup_ro` HBA address | `backup hba address` |
| Remove the quoted database environment check | `quoted database env value` |

The same test passes a quoted `TARGET_DATABASE_URL` to `make-pg-service.mjs`. It requires a nonzero exit. Standard error must name `TARGET_DATABASE_URL` and must not contain the value.

`tests/p1-cli/n-db-freeze-hosted-shape.test.ts` also detects this mutation against its empty-list step:

| Named mutation | Required failure line |
|---|---|
| Replace the set check for `FREEZE_UNPROBED_ROLES` with `${FREEZE_UNPROBED_ROLES:-}` | `an unset empty acknowledgement was accepted` |

`npm test` names `supabase-stack.test.ts`, and `npm run test:p1-cli` globs both test files.
