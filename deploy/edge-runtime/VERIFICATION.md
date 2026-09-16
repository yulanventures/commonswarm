# Preparation verification — 2026-09-16

The original preparation lane contacted no production service and deployed
nothing. The lead later deployed `76487b81` to the box. Before fix round 1, the
lead measured a healthy container, both Caddy names through Cloudflare, 36 MiB
idle and 155 MiB after 50 requests, 2–56 ms service time for sequential and
mixed requests, and a healthy `docker restart` with zero restarts.

## NOT ESTABLISHED

1. **Auth callbacks and custom-domain TLS after proxy cutover.** Staging
   proxying works. Production DNS, Management API custom-domain deactivation,
   production controls, and rollback have not run. Only a controlled live
   cutover can establish that callback and TLS sequence.
2. Fix round 1 did not inspect box certificate files, 1Password items, firewall,
   DNS, or operator access.
3. Production function behavior, production database access, and hosted edge
   invocation counts were not measured.
4. The repository Caddy fragment validates with `caddy:2.11` and dummy
   certificates. The box's full Caddyfile was not read or validated by this lane.

The lead measured that installing `47c33aad` as
`/etc/caddy/sites/10-commonswarm-api.caddy` made the box reject its complete
configuration. The site fragment carried a global options block, but imported
site files cannot define that block. The lead restored the prior file and the
box remained healthy. Fix round 3 separates those settings and validates the
same main-file-plus-site-import shape used by the box.

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

Fix round 2 added these applied-and-restored mutations:

| Control | Applied mutation | Exit |
|---|---|---:|
| request forwarding | cleared the rewritten request query | 1 |
| Kong preflight methods | removed `CONNECT` | 1 |
| unknown preflight | answered unknown `OPTIONS` before function lookup | 1 |
| required boot environment | removed `SWARM_SELF_SERVE` | 1 |
| retired worker retry | changed the stable error name | 1 |
| hosted worker-limit status | changed 504 to 503 | 1 |
| Supabase forwarded host | changed `X-Forwarded-Host` to the public host | 1 |
| Cloudflare trust boundary | removed one pinned proxy range | 1 |
| runtime response idle | changed 150 seconds back to 65 seconds | 1 |

Fix round 3 added this applied-and-restored mutation:

| Control | Applied mutation | Pure test exit | Box-shaped validation exit |
|---|---|---:|---:|
| imported site boundary | put the global options block back in `commonswarm.caddy` | 1 | 1 |

Fix round 4 added these applied-and-restored mutations:

| Control | Applied mutation | Adapted-JSON proof exit |
|---|---|---:|
| Supabase Cloudflare header removal | removed the `CF-Connecting-IP` delete | 1 |
| Supabase forwarded chain | restored the project-route `X-Forwarded-For` override | 1 |

Fix round 5 added these applied-and-restored mutations:

| Control | Applied mutation | Pure test exit | Adapted-JSON proof exit |
|---|---|---:|---:|
| main-service CORS | removed wildcard origin from main JSON responses | 1 | — |
| bare Realtime routes | removed bare `/realtime/v1` from its matcher | 1 | 1 |
| self-serve boot value | allowed `SWARM_SELF_SERVE=0` | 1 | — |

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

## Fix round 2 controls

- Local Kong 2.8.1 answered a known function `OPTIONS` with HTTP 200, wildcard
  origin, the requested header list echoed, the method list
  `GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT`, and an empty body.
  Unknown GET and `OPTIONS` both returned HTTP 404, text `Function not found`,
  and wildcard origin. The router now matches these cases.
- Inspection of the pinned local runtime source found the stable
  `WORKER_LIMIT` JSON body. The lead supplied hosted HTTP 504 as the required
  status. `WorkerRequestIdleTimeout` and `WorkerRequestCancelled` now map to
  that pair. An actual exhausted-pool response was not forced in this lane.
- One `WorkerAlreadyRetired` during worker creation retries once. A second
  retirement escapes the bounded helper.
- The runtime response-idle limit and worker wall clock are 150 seconds. Caddy
  waits 165 seconds for headers.
- The round-2 loopback parity run passed eight probes: all five functions,
  known-function preflight, unknown GET, and unknown `OPTIONS`. Start, health,
  parity, and stop all returned exit 0; the `--rm` container was removed.
- Caddy's adapted JSON check requires five Supabase-origin proxies to set
  `Host` and `X-Forwarded-Host` to the project host, set `X-Forwarded-Proto` to
  `https`, remove the ruled Cloudflare headers, and leave `X-Forwarded-For` to
  Caddy's default chain. It also checks all 22 Cloudflare ranges pinned on
  2026-09-16 and the HTTP/1.1 unbuffered Realtime proxy.

## Fix round 3 controls

- `commonswarm.caddy` contains site snippets and the named site block only. The
  Cloudflare `servers { ... }` settings are in
  `caddy-global-servers.caddy`, which is written for insertion inside the box
  operator's existing global options block.
- A box-shaped main Caddyfile with those settings and `import sites/*.caddy`
  validates. The same shape without the settings also validates. In the second
  state only visitor-IP derivation and capability rate-limit keying are wrong.

## Fix round 4 controls

The lead measured this production-path defect on the box at 2026-09-16 20:41Z.
The box was restored after the measurement.

| Throwaway Caddy form | Plain request | Cloudflare-shaped request |
|---|---:|---:|
| `76487b81`, Host rewrite only | Storage 200 | Storage 403 with `CF-Connecting-IP` |
| `8f38a55e`, Host/XFH/XFP plus derived XFF override | Storage 403 | Storage 403 |
| `8f38a55e` without the XFF override | Storage 200 | Storage 403 with `CF-Connecting-IP` |
| delete `CF-Connecting-IP` and XFF | Storage 200 | Storage 200 |
| delete `CF-Connecting-IP`, `CF-Ray`, `CF-Visitor`, `CF-IPCountry`, and `CDN-Loop`; keep default XFF and rewritten XFH/XFP | — | Storage 200; Auth health 401 without an API key, as expected |
| same deletion set, but set XFF from `CF-Connecting-IP` | — | Storage 200; Auth health 401 without an API key, as expected |

Direct box requests to the Supabase project Storage status were HTTP 200 with
no added header and with each tested forwarding or Cloudflare header alone,
except `CF-Connecting-IP`, which produced the Supabase Cloudflare HTTP 403.
Through staging, Auth health, Auth settings, and Storage status had returned
that 403 page, while Realtime still subscribed.

Every Supabase-origin route now deletes `CF-Connecting-IP`, `CF-Ray`,
`CF-Visitor`, `CF-IPCountry`, `CDN-Loop`, and `True-Client-IP`. It rewrites
`X-Forwarded-Host` and `X-Forwarded-Proto` but leaves `X-Forwarded-For` to
Caddy's default chain. The local `/functions/v1` route deletes none of those
headers and continues to set its visitor-derived `X-Forwarded-For`.

## Fix round 5 controls

- The Strategist ruling dated 2026-09-16 21:07Z replaces the earlier cutover
  order. DNS moves to the proxied box first. The H0 document is the first public
  control because only the box serves it. Custom-domain deactivation through
  the Management API is the last one-way step, after all other controls pass
  and the project-host Google redirect URI is present. GitHub and GoTrue need no
  setting change.
- Rollback before deactivation restores only the DNS-only project-host CNAME.
  Rollback after deactivation must re-add and verify the Supabase custom domain,
  wait for its TLS state, then restore that CNAME. The runbook budgets minutes
  to 48 hours for that non-immediate path.
- Main-service JSON responses and both gateway 404 forms carry
  `Access-Control-Allow-Origin: *`. User-worker responses remain unchanged.
- `/realtime/v1`, `/realtime/v1/`, and deeper Realtime paths use the same
  HTTP/1.1 unbuffered upstream in the adapted Caddy configuration.
- Boot accepts only the production value `SWARM_SELF_SERVE=1`. The stable error
  says workspace creation requires self-serve mode without reflecting the
  supplied value.
- HezLead measured the 22-range trusted-proxy block in the box main Caddyfile.
  The runbook now verifies its adapted form instead of telling the operator to
  paste a second copy.
