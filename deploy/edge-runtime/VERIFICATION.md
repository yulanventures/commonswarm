# Preparation verification — 2026-09-16

The original preparation lane contacted no production service and deployed
nothing. The lead later deployed `76487b81` to the box. Before fix round 1, the
lead measured a healthy container, both Caddy names through Cloudflare, 36 MiB
idle and 155 MiB after 50 requests, 2–56 ms service time for sequential and
mixed requests, and a healthy `docker restart` with zero restarts.

## NOT ESTABLISHED

1. **The production cutover.** Staging proxying works. Custom-domain
   deactivation, OAuth and GoTrue changes, production DNS, production controls,
   and rollback have not run.
2. Fix round 1 did not inspect box certificate files, 1Password items, firewall,
   DNS, or operator access.
3. Production function behavior, production database access, and hosted edge
   invocation counts were not measured.
4. The repository Caddy fragment validates with `caddy:2.11` and dummy
   certificates. The box's full Caddyfile was not read or validated by this lane.

## Image and environment

- Read-only manifest inspection confirmed that edge-runtime `v1.73.13` publishes
  `linux/amd64`. Its amd64 digest is
  `sha256:e8ddc7b0f4888818159d4b665e922de667948e2864c895ed62acdfd29e7c6c80`.
- The environment inventory test found 12 names read by `Deno.env.get` in the
  functions and matched them exactly to `env.example`.
- The command function refuses either `SWARM_CMD_TEST_*` hook when parsed outside
  `SWARM_ENV=test`. The main service also omits both names outside test.

## Mutations

Each mutation was confirmed in the changed file before its test ran, returned the
listed nonzero exit, and was restored with a patch.

| Control | Applied mutation | Exit |
|---|---|---:|
| environment inventory | removed `SUPABASE_URL` from `env.example` | 1 |
| router | changed the fifth function name from `h0` to `h0-mutated` | 1 |
| Compose boundary | changed the published address to `0.0.0.0:9000` | 1 |
| H0 environment closure | added one unpassed `Deno.env.get` to H0 | 1 |
| box memory budget | changed `mem_limit` from 512 MiB to 513 MiB | 1 |
| request body window | changed 60 seconds back to 15 seconds | 1 |
| function proxy window | changed 165 seconds to 164 seconds | 1 |
| bare function path | removed `/functions/v1` from the Caddy matcher | 1 |
| Realtime upgrade | changed its upstream from HTTP/1.1 to HTTP/2 | 1 |

## Fix round 1 controls

- Local Kong 2.8.1 answered bare `/functions/v1` with HTTP 404 and
  `{"message":"no Route matched with those values"}`. The local Compose service
  now returns the same status and body.
- `caddy:2.11` validated `commonswarm.caddy` with dummy certificate files and no
  network, exit 0.
- Four 96 MiB workers total 384 MiB. The container hard limit is 512 MiB, leaving
  128 MiB for the main runtime and overhead.
- One local six-request parity smoke under those new caps passed all five
  functions plus the unknown-function control, exit 0.
- The largest function body is 128 KiB. File bytes go directly to Storage. The
  function request read timeout is 60 seconds.
- End-to-end box latency remains slower than production. The measured p50/p95
  pairs are recorded in `README.md`; the remedy is N-db.

## Local parity

The database reservation file appeared after 26 one-minute checks. No stack or
database command ran before it appeared.

The existing stack-functions run completed first:

- `env -u FORCE_COLOR npm run test:p1-server`: 201 passed, 0 failed, exit 0.

The suite cannot be pointed at another functions base URL without changing the
forbidden `tests/p1-server/**` tree. All 12 test files start their own
`supabase functions serve`, and their requests use `local.API_URL` for both the
project services and `/functions/v1`. There is no functions-base override.

The scripted fallback then ran edge-runtime `v1.73.13` against the local project
URL and database. Local values were captured without printing and were passed to
Docker by variable name. The local runtime cache supplied npm modules. The final
run returned:

| Probe | Result |
|---|---:|
| H0 agent document | HTTP 200 |
| malformed command | HTTP 400 `invalid_request` |
| authenticated human read | HTTP 200 |
| unauthenticated activity | HTTP 401 `unauthenticated` |
| capability method control | HTTP 405 `method_not_allowed` |
| unknown function | HTTP 404 `function_not_found` |

The parity script deleted its temporary Auth user. The edge-runtime container was
removed after every run.
