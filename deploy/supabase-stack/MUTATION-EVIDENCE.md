# Contract mutation evidence

`tests/p1-cli/supabase-stack.test.ts` reads the committed files. It applies each mutation below and requires the shown failure line.

| Named mutation | Required failure line |
|---|---|
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
| Remove target `pg_net` creation | `required source extensions` |
| Remove the source standby refusal | `source standby guard` |
| Replace the cron snapshot query | `cron snapshot export` |
| Replace the cron verification query | `cron verify query` |
| Replace the cron restore listing query | `cron restore query` |
| Remove `pg_read_all_data` from `backup_ro` | `backup read grant` |
| Widen the `backup_ro` HBA address | `backup hba address` |
| Remove the quoted database environment check | `quoted database env value` |

The same test passes a quoted `TARGET_DATABASE_URL` to `make-pg-service.mjs`. It requires a nonzero exit. Standard error must name `TARGET_DATABASE_URL` and must not contain the value.

Both `npm test` and `npm run test:p1-cli` name or glob this test file.
