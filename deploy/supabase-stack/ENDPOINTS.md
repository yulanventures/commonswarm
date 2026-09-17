# Client and edge endpoint inventory

This inventory comes from `src/cloud/*`, `src/listener/wake.ts`, `site/src/lib/*`, and `supabase/functions/*` at the N-db preparation SHA.

## Auth

| Caller | Paths and operations |
|---|---|
| CLI | `GET /auth/v1/authorize?provider=github` or `GET /auth/v1/authorize?provider=google` for PKCE; Auth JS exchanges the code and refresh token at `/auth/v1/token`; reads `/auth/v1/user`; revokes refresh tokens at `/auth/v1/logout`. The CLI refreshes its saved token before every human operation. |
| Site | `GET /auth/v1/settings`; GitHub and Google OAuth through `/auth/v1/authorize?provider=github` and `/auth/v1/authorize?provider=google`; email OTP through `/auth/v1/otp`; Auth JS session, user, token refresh, and logout endpoints. |
| Edge | `command` calls Auth JS `getUser` and `getClaims`; `read` calls `getUser`. Agent credentials are checked in PostgreSQL and do not go through GoTrue. |

## REST

The CLI uses `/rest/v1/memberships`, `/rest/v1/workspaces`, `/rest/v1/pending_invitations`, `/rest/v1/signals`, `/rest/v1/channels`, and `/rest/v1/files`.

The site uses the same tables plus `/rest/v1/agent_principals`, `/rest/v1/my_devices`, and `/rest/v1/rpc/signal_delivery_receipts`. Every exposed CommonSwarm read uses the `swarm_read` profile where required. PostgREST exposes `public`, `storage`, `graphql_public`, and `swarm_read`, matching `supabase/config.toml`.

## Storage

The command edge uses these Storage API paths for the private `swarm-files` bucket:

- `POST /storage/v1/object/upload/sign/swarm-files/{object}`
- `GET /storage/v1/object/info/authenticated/swarm-files/{object}`
- `DELETE /storage/v1/object/swarm-files`
- `POST /storage/v1/object/sign/swarm-files/{object}`

The site and CLI PUT bytes to the returned signed `/storage/v1/...` path and GET from the returned signed download path. No client has direct bucket-list permission.

## Realtime

All live CommonSwarm channels use private **Broadcast**. There are no `postgres_changes` subscriptions and no Realtime Presence channel in the CLI or site.

| Topic | Event | Credential | Producer |
|---|---|---|---|
| `cswarm-wake:{wake_id}` | `wake` | Legacy anon JWT; database policy checks the topic capability. | PostgreSQL `realtime.send` trigger after an agent delivery. |
| `cswarm-signals:{workspace_id}` | `signal` | Human access JWT; database policy checks membership. | PostgreSQL `realtime.send` trigger after a signal insert. |
| `cswarm-activity:{workspace_id}` | `activity` | Human access JWT; database policy checks membership. | The `activity` edge after agent authentication. |

Supabase JS connects at `/realtime/v1/websocket`. Caddy rewrites it to Realtime's `/socket/websocket` and sets tenant host `realtime-dev`.

The site CSS class named `presence` is a visual activity dot. It does not use the Realtime Presence protocol.

## Functions

The CLI and site call `/functions/v1/command` and `/functions/v1/read`. Other product paths call `/functions/v1/activity`, `/functions/v1/capability`, and `/functions/v1/h0`. The edge lane owns those files and remains on `127.0.0.1:9000`.

The command edge also calls GoTrue for human JWTs and Storage API for signed object operations. `command`, `read`, `activity`, and `capability` connect directly to PostgreSQL. None reads the `auth` schema directly; human identity enters through GoTrue. File metadata lives in `swarm` and `storage`, while bytes live behind Storage API.
