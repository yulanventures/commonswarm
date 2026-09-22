# CommonSwarm edge runtime

This package runs the five existing Supabase Edge Functions in
`public.ecr.aws/supabase/edge-runtime:v1.73.13`. It does not change their source.

The main service accepts only `/functions/v1/<name>/...`, maps `command`, `read`,
`capability`, `activity`, and `h0` to separate user workers, and gives each worker
the path Supabase Kong gives it: `/<name>/...`. An unknown name returns 404 before
a worker starts. A known function's `OPTIONS` request gets the hosted gateway's
wildcard preflight before a worker starts. Other requests still use each
function's CORS policy. Query strings, methods, headers, and bodies are kept.

Boot requires `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, and one supported database URL name.
`SWARM_SELF_SERVE` must equal `1`; another non-empty value would let the service
start while production workspace creation remains disabled. A
`WorkerAlreadyRetired` from either worker creation or fetch retries the complete
create-and-fetch operation once, with a cloned request for the second fetch. A
pool-wait `InvalidWorkerCreation`, full worker pool cancellation, or idle worker
timeout returns the hosted HTTP 504 status with the runtime's `WORKER_LIMIT`
body.

Each worker has a 96 MiB memory limit and a 150-second wall-clock limit. Four
workers can use at most 384 MiB, leaving 128 MiB of the container's 512 MiB hard
limit for the main runtime, module cache, and process overhead. The hosted
256 MiB per-worker reference does not fit this box budget, so the box uses the
measured lower cap while keeping the hosted wall-clock reference. Caddy waits 165
seconds for response headers: the hosted 150-second worker limit plus 15 seconds
of proxy margin. The runtime response-idle limit is also 150 seconds, so it does
not end a valid worker before that reference. Function request bodies are capped
at 128 KiB; the 60-second
read timeout permits that body at about 2.2 KiB/s. File bytes up to 25 MiB go
straight to Storage and do not pass through a function request body.
Compose gives shutdown 80 seconds before SIGKILL. This leaves 10 seconds beyond
the runtime's configured 70-second graceful worker-drain window.

The later H0 poll may hold a worker for 50 seconds. The poll lane must not enable
that path until it prevents H0 polls from occupying all four slots and starving
`command`, `read`, `activity`, or `capability`. This lane does not choose the
isolation or admission design. The poll lane must also add every environment name
H0 starts reading to `FUNCTION_ENV_NAMES.h0`.

`h0-deno.json` supplies the bare `postgres` import mapping that H0 reaches through
shared command types. `bootstrap.sh` copies the read-only mounted functions to an
ephemeral container directory, adds that map, and makes the staged tree read-only
before the runtime starts. The repository function source stays unchanged and its
mount is read-only.

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
| `/auth/v1/authorize`, `/auth/v1/token`, `/auth/v1/user`, `/auth/v1/logout`, `/auth/v1/otp`, `/auth/v1/settings` | CLI and site through supabase-js, plus the site build provider check | GoTrue on the server, `127.0.0.1:18001` |
| `/rest/v1/memberships`, `/workspaces`, `/member_profiles`, `/agent_principals`, `/tasks`, `/channels`, `/signals`, `/files`, `/my_devices`, `/pending_invitations` | CLI and site, directly or through supabase-js | PostgREST on the server, `127.0.0.1:18002` |
| `/storage/v1/object/upload/sign/...`, `/object/info/authenticated/...`, `/object/sign/...`, `/object/...` | command function and site file upload/download | Storage API on the server, `127.0.0.1:18004` |
| `/realtime/v1`, `/realtime/v1/`, `/realtime/v1/websocket` | supabase-js wake, feed, and activity channels | Realtime on the server, `127.0.0.1:18003`, HTTP/1.1 |
| every other path | no upstream | `404` JSON from the live API file |

The live routes are in `deploy/supabase-stack/commonswarm-api.caddy`. The pre-cutover site file was removed. It proxied to a deleted host. There is no fallback to another host. A pause uses `deploy/supabase-stack/commonswarm-api-maintenance.caddy`: the public site answers 503 and has no upstream, and staging keeps the box routes. The Caddy global options must include the `servers { ... }` fragment from `caddy-global-servers.caddy`. It trusts only Cloudflare's ranges pinned on 2026-09-16. The functions route replaces `X-Forwarded-For` with Caddy's derived visitor address, so capability rate limiting does not use a Cloudflare edge or spoofed header.

## Caddy validation shape

Validate `deploy/supabase-stack/commonswarm-api.caddy`. Do not install a file that names a supabase.co host. The local validation fixture builds a main Caddyfile around that live file, or around the maintenance file when you pass its path. The site file has no global options block. Build both local fixtures
with `build-caddy-validation-fixture.mjs`: mode `with-trusted-proxies` pastes the
server fragment inside that block; mode `without-trusted-proxies` models the
valid state before the box operator applies it. Validate each generated
`Caddyfile` with `caddy:2.11` and dummy certificate mounts. The adapted-JSON
checker takes `live` or `maintenance`, then the same trust mode.

## Known box state

The lead measured the deployed `76487b81` staging build on 2026-09-16. The
container was healthy at 36 MiB idle and 155 MiB after 50 requests across all
five functions. Twelve sequential and twelve mixed requests returned in 2–56 ms.
A `docker restart` returned healthy with zero restarts.

The server is production. N-db has landed. The 2026-09-16 latency note is `docs/evidence/2026-09-16-n-edge/LATENCY-2026-09-16.md`. Do not roll DNS back to supabase.co.
