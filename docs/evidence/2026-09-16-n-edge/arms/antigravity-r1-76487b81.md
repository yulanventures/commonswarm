### PRODUCTION FINDINGS

#### 1. Container enters infinite CrashLoopBackOff on restart due to recursive read-only permissions
- **File:Line**: `deploy/edge-runtime/bootstrap.sh:4-7`
- **Concrete Request / Sequence**:
  1. On first container boot, `bootstrap.sh` stages functions into `/var/tmp/commonswarm-functions` and executes `chmod -R a-w "$staged_functions"`, stripping write permissions from all files and directories.
  2. On any subsequent container restart (e.g. host reboot, Docker daemon restart, `docker restart edge-runtime`, or failure recovery under `restart: unless-stopped`), Docker retains the container's writable layer containing the now read-only `/var/tmp/commonswarm-functions`.
  3. `bootstrap.sh` runs lines 4–6: `mkdir -p "$staged_functions"` followed by `cp -R /home/deno/functions-source/. "$staged_functions/"`.
  4. `cp` fails with `Permission denied` when attempting to write into the read-only directory.
  5. Because `set -euo pipefail` is enabled, `bootstrap.sh` terminates immediately with exit code 1 before `exec /usr/local/bin/edge-runtime` is reached. Docker restarts the container continuously in a crash loop.
- **What a User Sees**:
  The edge runtime is completely down. Any client sending a request to `https://api.commonswarm.com/functions/v1/*` receives **HTTP 502 Bad Gateway** from Caddy.

---

#### 2. Worker starvation & 504 DoS caused by `--user-worker-request-idle-timeout 65000` combined with per-request `userWorkers.create`
- **File:Line**: `deploy/edge-runtime/compose.yaml:15-21` and `deploy/edge-runtime/main/index.ts:83-89`
- **Concrete Request / Sequence**:
  1. `main/index.ts` creates a fresh user worker on every single request via `EdgeRuntime.userWorkers.create(...)` instead of reusing worker instances across requests.
  2. In `compose.yaml`, `--user-worker-request-idle-timeout` is configured to `65000` (65 seconds) and `--max-parallelism` is capped at `6`.
  3. When 6 requests arrive in any 65-second window (for example, 6 quick calls to `POST /functions/v1/read`), each creates an isolate that remains alive and occupying a pool slot for 65 seconds after finishing.
  4. When a 7th request arrives (e.g. `POST /functions/v1/command`), all 6 parallelism slots are occupied by idling workers.
  5. The runtime queues the 7th request. However, `--request-wait-timeout` is set to `10000` (10 seconds).
  6. The queue wait timeout expires long before the 65-second idle timeout releases any worker slot.
- **What a User Sees**:
  After just 6 requests within a minute, subsequent user or CLI requests hang for 10 seconds and fail with **HTTP 504 Gateway Timeout**.

---

#### 3. Complete outage of commands and reads during H0 50-second long-polls
- **File:Line**: `deploy/edge-runtime/compose.yaml:15-19` and `deploy/edge-runtime/README.md:11-15`
- **Concrete Request / Sequence**:
  1. H0 clients initiate long-polls to `/functions/v1/h0/...`, holding workers open for 50 seconds.
  2. If 6 concurrent H0 long-polls are active, all 6 worker slots (`--max-parallelism "6"`) are saturated.
  3. While these 50-second polls are running, a user or CLI submits a mutation to `POST /functions/v1/command` or a read to `POST /functions/v1/read`.
  4. The incoming request is queued in edge runtime. Because `--request-wait-timeout` is `10000` (10 seconds), the queue times out 40 seconds before any H0 poll finishes and frees a worker slot.
- **What a User Sees**:
  Any user mutation (`command`) or query (`read`) fails with **HTTP 504 Gateway Timeout** whenever H0 agents are long-polling.

---

#### 4. Caddy `response_header_timeout 65s` prematurely aborts functions under 150-second hosted limit
- **File:Line**: `deploy/edge-runtime/commonswarm.caddy:21` and `deploy/edge-runtime/main/index.ts:29`
- **Concrete Request / Sequence**:
  1. Hosted Supabase Edge Functions allow up to a 150-second wall-clock execution limit, mirrored in `main/index.ts` by `USER_WORKER_TIMEOUT_MS = 150_000`.
  2. A legitimate long-running operation in `command` (such as a multi-step workspace migration or large batch update) takes 75 seconds to complete.
  3. In `commonswarm.caddy`, `response_header_timeout` is hardcoded to `65s` based only on the H0 poll margin.
  4. At 65 seconds, Caddy aborts the upstream reverse-proxy connection to `127.0.0.1:9000`.
- **What a User Sees**:
  The client receives an **HTTP 504 Gateway Timeout** from Caddy after 65 seconds, truncating legitimate operations that are well within the 150-second hosted parity budget.

---

#### 5. H0 worker receives empty environment (`h0: []`), breaking Postgres connection initialization
- **File:Line**: `deploy/edge-runtime/main/router.ts:68` and `deploy/edge-runtime/README.md:17-18`
- **Concrete Request / Sequence**:
  1. `README.md` states: "`h0-deno.json` supplies the bare `postgres` import mapping that H0 reaches through shared command types."
  2. However, in `router.ts`, `FUNCTION_ENV_NAMES.h0` is defined as empty array `[]`.
  3. When an H0 request reaches `main/index.ts`, `environmentFor("h0")` passes an empty list of environment variables to `EdgeRuntime.userWorkers.create`.
  4. When H0 or its shared command types attempt to read `SWARM_DATABASE_URL` or `SUPABASE_DB_URL`, `Deno.env.get(...)` returns `undefined`.
- **What a User Sees**:
  Clients calling H0 endpoints receive **HTTP 500 Internal Server Error** (`{"error":"internal_error"}`) because database client connection setup fails with an undefined connection string.

---

#### 6. Transatlantic uploads terminated prematurely by `--request-read-timeout 15000` (15 s)
- **File:Line**: `deploy/edge-runtime/compose.yaml:17-18`
- **Concrete Request / Sequence**:
  1. An agent or client across an ocean (high latency, packet loss, or constrained bandwidth) posts a large command payload or signature batch to `POST /functions/v1/command`.
  2. Transmission of the request body across the network takes 16 seconds.
  3. Edge runtime enforces `--request-read-timeout "15000"` (15 seconds) from connection start to the end of body reading.
  4. The runtime cuts the connection before the entire request body is received.
- **What a User Sees**:
  The upload fails mid-flight. The user sees a connection reset, broken pipe, or **HTTP 408 Request Timeout**.

---

#### 7. RUNBOOK directly violates operator's binding cutover order on custom domain deactivation & OAuth URLs
- **File:Line**: `deploy/edge-runtime/RUNBOOK.md:11-13, 143-146`
- **Concrete Request / Sequence**:
  1. The operator's binding cutover order mandates: *"inside the window, deactivate Supabase's custom domain deliberately, move the GitHub OAuth callback and GoTrue URLs to the project URL, verify one GitHub sign-in"*.
  2. `RUNBOOK.md` step 1 & step 6 instruct the exact opposite: *"Confirm in the Supabase dashboard that the custom domain stays verified. Do not cut over if any check fails."* and *"Keep the old record data and the Supabase custom domain for at least 48 hours. Do not remove the fallback during that window."*
  3. If an operator follows the runbook, Supabase's custom domain is kept active, leaving Cloudflare for SaaS custom hostname routing in conflict with the box IP DNS.
  4. Furthermore, the runbook omits updating GoTrue URLs and GitHub OAuth callback URLs to the project URL. When users attempt OAuth login via Caddy's rewritten host, GitHub redirects fail with `redirect_uri_mismatch`.
- **What a User Sees**:
  User authentication breaks entirely on GitHub OAuth callback (`redirect_uri_mismatch`), or Cloudflare routing conflicts reject traffic, stalling the cutover.

---

### RIGOUR FINDINGS

#### 8. Cutover rehearsal on `edge-staging.commonswarm.com` omitted from RUNBOOK
- **File:Line**: `deploy/edge-runtime/RUNBOOK.md:117-134` (Commit `76487b81`)
- **Concrete Request / Sequence**:
  1. Commit `76487b81` configured `edge-staging.commonswarm.com` in Caddy specifically to rehearse Host rewriting before switching `api.commonswarm.com`.
  2. The binding cutover order requires: *"Caddy proxy with Host rewrite rehearsed on edge-staging.commonswarm.com"*.
  3. `RUNBOOK.md` section 5 skips staging completely and instructs the operator to test `api.commonswarm.com` via `curl --resolve` directly against the box IP.
- **What a User Sees**:
  Staging rehearsal is bypassed in practice. Staging DNS, TLS, and proxy behaviors are not verified prior to production cutover.

---

#### 9. Request to `/functions/v1` without trailing slash bypasses edge runtime to Supabase origin
- **File:Line**: `deploy/edge-runtime/commonswarm.caddy:17, 48-50`
- **Concrete Request / Sequence**:
  1. In Caddy, path matcher `/functions/v1/*` matches only paths prefixed with `/functions/v1/`. It does not match `/functions/v1`.
  2. A client or probe requests `GET https://api.commonswarm.com/functions/v1`.
  3. The request misses `handle /functions/v1/*` and falls through to the catch-all `handle { import supabase_origin }`.
  4. Caddy proxies the request upstream to `ukezjcnxjvkpkeezxaew.supabase.co/functions/v1`.
- **What a User Sees**:
  Requests to `/functions/v1` hit hosted Supabase Kong instead of being handled locally by edge runtime.

---

#### 10. RUNBOOK rollback procedure is broken if operator executes binding order
- **File:Line**: `deploy/edge-runtime/RUNBOOK.md:158-169`
- **Concrete Request / Sequence**:
  1. When cutting over per the binding order, the operator deliberately deactivates Supabase's custom domain and updates OAuth callback URLs to the project origin.
  2. In the event of an outage, RUNBOOK section 8 ("Roll back") only instructs restoring DNS and waiting for TTL.
  3. It contains no instructions to reactivate Supabase's custom domain, re-verify domain ownership, or revert OAuth/GoTrue redirect URLs.
- **What a User Sees**:
  After DNS rollback, traffic returning to Supabase fails certificate/domain verification, and GitHub OAuth logins remain non-functional.

---

VERDICT: FAIL - Container crashloops on restart due to read-only staging, worker pool exhausts after 6 requests causing 504 timeouts, H0 long-polls starve command traffic, and the runbook directly violates the binding cutover order.
