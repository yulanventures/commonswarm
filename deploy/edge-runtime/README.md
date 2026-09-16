# CommonSwarm edge runtime

This package runs the five existing Supabase Edge Functions in
`public.ecr.aws/supabase/edge-runtime:v1.73.13`. It does not change their source.

The main service accepts only `/functions/v1/<name>/...`, maps `command`, `read`,
`capability`, `activity`, and `h0` to separate user workers, and gives each worker
the path Supabase Kong gives it: `/<name>/...`. An unknown name returns 404 before
a worker starts.

Each worker has a 256 MiB memory limit and a 150-second wall-clock limit. These
match the Supabase hosted reference limits. The wall-clock limit also leaves 100
seconds of margin above the planned 50-second H0 long poll. The runtime request
idle timeout is 65 seconds, so it does not end that poll first. Compose limits the
container to 2 GiB and six workers at once to bound the box-wide cost.

The wrappers in `workers/` supply the bare `postgres` import mapping that the
Supabase CLI gets from `command/deno.json`. They import the mounted function files
without editing them.

## Image check

Measured on 2026-09-16 with this read-only command:

```sh
docker manifest inspect public.ecr.aws/supabase/edge-runtime:v1.73.13
```

The image index included `linux/amd64` at digest
`sha256:e8ddc7b0f4888818159d4b665e922de667948e2864c895ed62acdfd29e7c6c80`.
It also included `linux/arm64`. The target box can use the pinned tag on Docker 28.

## Client path inventory

All rows below come from `src/cloud`, `src/listener`, `site/src/lib`, or the
Supabase client calls in those files.

| Public path | Caller | Caddy destination |
|---|---|---|
| `/functions/v1/command` | CLI and site mutations | loopback edge runtime |
| `/functions/v1/read` | CLI and site agent reads | loopback edge runtime |
| `/functions/v1/activity` | listener activity publisher | loopback edge runtime |
| `/functions/v1/capability/...` | capability links | loopback edge runtime |
| `/functions/v1/h0/...` | H0 agent document and later H0 calls | loopback edge runtime |
| `/auth/v1/authorize`, `/auth/v1/token`, `/auth/v1/user`, `/auth/v1/logout`, `/auth/v1/otp`, `/auth/v1/settings` | CLI and site through supabase-js, plus the site build provider check | Supabase project origin |
| `/rest/v1/memberships`, `/workspaces`, `/member_profiles`, `/agent_principals`, `/tasks`, `/channels`, `/signals`, `/files`, `/my_devices`, `/pending_invitations` | CLI and site, directly or through supabase-js | Supabase project origin |
| `/storage/v1/object/upload/sign/...`, `/object/info/authenticated/...`, `/object/sign/...`, `/object/...` | command function and site file upload/download | Supabase project origin |
| `/realtime/v1/websocket` | supabase-js wake, feed, and activity channels | Supabase project origin; Caddy keeps the websocket upgrade |
| every other path | compatibility fallback | Supabase project origin |

The reverse proxy sends the project origin as both HTTP `Host` and TLS SNI. This
avoids sending the custom-domain host back to itself.
