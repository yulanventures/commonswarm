# Edge-runtime box runbook

Every action below is **NOT RUN by this fix lane**. The lead deployed `76487b81`
to the box before this round. The container is healthy and Caddy serves both
`api.commonswarm.com` and `edge-staging.commonswarm.com`; staging was measured
through Cloudflare.

## NOT ESTABLISHED

1. **NOT ESTABLISHED — auth callbacks and custom-domain TLS after proxy
   cutover.** Staging proxying works, but the deliberate custom-domain
   deactivation, OAuth and GoTrue changes, production DNS move, production
   controls, and rollback have not run. Only a controlled live cutover can
   establish that callback and TLS sequence.
2. **NOT ESTABLISHED — the three 1Password items named below exist or contain the
   current material.** An operator must confirm them without printing values.
3. **NOT ESTABLISHED — this lane did not inspect the box firewall, certificate
   files, secret source, or current operator access.**
4. **NOT ESTABLISHED — production DNS, hosted invocation decrease, and rollback.**

## 1. Install and stage

- [ ] **NOT RUN** — install Docker Engine 28 and the Compose plugin from Docker's
  package repository. Install Caddy from Caddy's package repository.
- [ ] **NOT RUN** — create the `commonswarm` system user and `/opt/commonswarm`.
  Give that user read access to the checked-out release and access to Docker.
- [ ] **NOT RUN** — place one reviewed CommonSwarm release at
  `/opt/commonswarm/current`. Confirm that these paths exist:

  ```sh
  test -f /opt/commonswarm/current/deploy/edge-runtime/compose.yaml
  test -f /opt/commonswarm/current/supabase/functions/command/index.ts
  test -f /opt/commonswarm/current/src/h0/verbs.ts
  ```

- [ ] **NOT RUN** — confirm the host is `linux/amd64` and Docker is version 28.
- [ ] **NOT RUN** — inspect the pinned image before the first pull:

  ```sh
  docker manifest inspect public.ecr.aws/supabase/edge-runtime:v1.73.13
  ```

  Confirm that the index still includes `linux/amd64`.

## 2. Put secrets on the box

Use the 1Password vault **Yulan Ventures Infra**. Refer to items by these names:

- `CommonSwarm — edge-runtime production env`
- `CommonSwarm — Cloudflare Origin CA certificate`
- `CommonSwarm — Cloudflare Origin CA key`

- [ ] **NOT RUN** — confirm the item names and their revision dates in 1Password.
  Do not print, export to shell history, or paste values into a command line.
- [ ] **NOT RUN** — write the environment item to `/home/commonswarm/.env` by a
  protected editor or approved 1Password file workflow. It must contain only the
  needed names from `env.example`. Do not set either `SWARM_CMD_TEST_*` name. Set
  `SWARM_ENV` to the production value used by CommonSwarm. `SWARM_SELF_SERVE`
  is a required boot value; confirm its name is present without printing it.
- [ ] **NOT RUN** — set ownership and mode without reading the file:

  ```sh
  chown commonswarm:commonswarm /home/commonswarm/.env
  chmod 0600 /home/commonswarm/.env
  ```

- [ ] **NOT RUN** — place the certificate and key at
  `/etc/caddy/certs/commonswarm.com.pem` and
  `/etc/caddy/certs/commonswarm.com.key`. Make the key readable only by Caddy.
- [ ] **NOT RUN — box-operator prerequisite before cutover** — paste the
  `servers { ... }` lines from `caddy-global-servers.caddy` inside the main
  `/etc/caddy/Caddyfile` global options block. Do not put that fragment under
  `sites/`. Without these settings, the site remains valid and routes traffic,
  but Caddy sees the Cloudflare peer instead of the visitor. Capability rate
  limits then use the wrong shared client key. No other route behavior depends
  on these settings.
- [ ] **NOT RUN** — compare the Cloudflare proxy ranges in
  `caddy-global-servers.caddy`, pinned 2026-09-16, with Cloudflare's current
  published list. Review and update the fragment before the operator pastes it
  if that list changed.
- [ ] **NOT RUN** — copy `commonswarm.caddy` to
  `/etc/caddy/sites/10-commonswarm-api.caddy`. The box main Caddyfile already
  imports `sites/*.caddy`. The site file must not contain a global options block.

## 3. Start the edge runtime

- [ ] **NOT RUN** — validate Compose from the release root:

  ```sh
  cd /opt/commonswarm/current
  docker compose -f deploy/edge-runtime/compose.yaml config -q
  ```

- [ ] **NOT RUN** — start only the edge runtime:

  ```sh
  docker compose -f deploy/edge-runtime/compose.yaml up -d edge-runtime
  ```

- [ ] **NOT RUN** — wait for `healthy`. Confirm the published socket is only
  `127.0.0.1:9000`.

## 4. Smoke every function on loopback

Use a dedicated live smoke agent credential. Put its Authorization header in a
root-owned 0600 curl config file. Do not put the credential in argv, logs, or this
repository. The examples below call that file `/run/commonswarm-smoke.curl`.

- [ ] **NOT RUN** — H0 agent document: GET
  `/functions/v1/h0/agent-doc/smoke`. Expect 200 and a JSON agent document.
- [ ] **NOT RUN** — command: POST `{}` to `/functions/v1/command`. Expect the
  stable 400 body `{"error":"invalid_request"}`.
- [ ] **NOT RUN** — read: POST an allowed authenticated read request to
  `/functions/v1/read` with `curl --config /run/commonswarm-smoke.curl`. Expect
  200 and JSON. This is the required database and agent-auth control.
- [ ] **NOT RUN** — activity: POST `{}` to `/functions/v1/activity` without an
  Authorization header. Expect the stable 401 body `{"error":"unauthenticated"}`.
- [ ] **NOT RUN** — capability: send a GET request to
  `/functions/v1/capability/smoke`. Expect 405 when capability URLs are enabled,
  or the configured feature-off response when they are disabled. Confirm the
  container log names no boot or module error.
- [ ] **NOT RUN** — request `/functions/v1/not-a-function`. Expect the main
  service's 404 text body `Function not found` and
  `Access-Control-Allow-Origin: *`.
- [ ] **NOT RUN** — send `OPTIONS` to `/functions/v1/command` with an
  `Access-Control-Request-Headers` value. Expect HTTP 200, wildcard origin, the
  same requested header list, Kong's method list, and an empty body. Repeat for
  an unknown function and expect its normal 404, not a preflight success.

Remove `/run/commonswarm-smoke.curl` after the checks.

## 5. Rehearse on staging before the production window

- [ ] **NOT RUN** — validate the full Caddy configuration:

  ```sh
  caddy validate --config /etc/caddy/Caddyfile
  ```

- [ ] **NOT RUN** — reload Caddy, then confirm
  `edge-staging.commonswarm.com` reaches the box through Cloudflare.
- [ ] **NOT RUN** — through `edge-staging.commonswarm.com`, repeat all five
  function smokes and the bare `/functions/v1` 404 control.
- [ ] **NOT RUN** — through staging, check `/auth/v1/settings`, one membership
  REST read, one signed Storage request, and a Realtime subscription. Confirm
  Auth, REST, Storage, and Realtime reach the project URL with the upstream Host
  and `X-Forwarded-Host` rewritten to `ukezjcnxjvkpkeezxaew.supabase.co`, and
  `X-Forwarded-Proto` set to `https`. Confirm the capability function sees the
  visitor address, not the Cloudflare edge address.
- [ ] **NOT RUN** — do not open the production window until every staging check
  passes. Record failures; do not compensate by raising timeouts.

## 6. Production cutover with a 48-hour project-URL fallback

The order in this section is binding.

- [ ] **NOT RUN — (a)** — confirm Caddy on the box routes `/functions/v1` to the
  local runtime and proxies `/auth/v1/*`, `/rest/v1/*`, `/storage/v1/*`, and
  `/realtime/v1/*` to the project URL with its Host and `X-Forwarded-Host`
  rewritten and its forwarded scheme set to `https`. Confirm the complete
  rehearsal on `edge-staging.commonswarm.com` is recorded as passing.
- [ ] **NOT RUN — (b)** — inside the approved window, deliberately deactivate
  the Supabase custom domain in the Supabase dashboard. Do not wait for it to
  lapse or fail on its own. Record the dashboard state and time.
- [ ] **NOT RUN — (c)** — change the GitHub OAuth app callback to
  `https://ukezjcnxjvkpkeezxaew.supabase.co/auth/v1/callback`. Set GoTrue's Site
  URL to `https://commonswarm.com/app`. Set its redirect allow-list to the app's
  real return URLs, including `https://commonswarm.com/app` and
  `https://coswarm-site.vercel.app/app`; preserve the CLI loopback callback.
- [ ] **NOT RUN — (d)** — complete one GitHub sign-in end to end through the
  project URL. Do not lift, remove, or change anything else until it succeeds.
- [ ] **NOT RUN** — record the current DNS type, target, proxy state, and TTL as
  the rollback record. Change only `api.commonswarm.com` to the approved box
  target. Keep `https://ukezjcnxjvkpkeezxaew.supabase.co` and its hosted
  functions available as the fallback for at least 48 hours.
- [ ] **NOT RUN** — run these production controls through normal DNS from two
  networks: a GitHub sign-in callback, a Realtime subscribe, one file upload,
  one seat's wake round trip, `https://commonswarm.com/acceptable-use`, and
  `https://commonswarm.com/install.sh`. Repeat all five function smokes.
- [ ] **NOT RUN** — treat any production client timeout after cutover as a DNS
  rollback signal. Do not tune Caddy, worker, queue, or client timeouts in place.

## 7. Measure the hosted edge decrease

- [ ] **NOT RUN** — before cutover, record 5-minute and 60-minute invocation counts
  for `command`, `read`, `capability`, `activity`, and `h0` in the Supabase Edge
  Functions dashboard or Log Explorer.
- [ ] **NOT RUN** — after cutover, record the same windows. Function invocations at
  Supabase should fall to zero after DNS caches drain, while Auth, REST, Storage,
  and Realtime traffic continues at the project origin.
- [ ] **NOT RUN** — investigate any hosted function invocation before declaring the
  move complete. A nonzero count means a client bypasses the custom host or DNS has
  not drained.
- [ ] **NOT RUN** — compare end-to-end latency with the recorded 2026-09-16
  baseline: box p50/p95 read members 2.77/3.32 s, read feed 2.07/2.93 s, command
  receipt 1.68/2.11 s; production 0.85/1.16 s, 0.73/1.09 s, and 0.70/0.90 s.
  The remedy is N-db, not timeout tuning.

## 8. Roll back

- [ ] **NOT RUN** — on any production client timeout, restore the exact DNS
  record from the rollback record immediately. Do not change timeouts.
- [ ] **NOT RUN** — keep GitHub OAuth and GoTrue on the project URL while the DNS
  rollback propagates. Verify the project-URL GitHub sign-in still works.
- [ ] **NOT RUN** — after DNS points at the prior Supabase target, deliberately
  reactivate the Supabase custom domain in the dashboard. Wait until its domain
  and TLS state are verified; do not treat a pending state as restored.
- [ ] **NOT RUN** — restore the GitHub OAuth callback and every GoTrue Site URL
  and redirect allow-list value from the pre-cutover record. Complete one GitHub
  sign-in through `api.commonswarm.com`.
- [ ] **NOT RUN** — verify the Realtime subscribe, file upload, seat wake round
  trip, acceptable-use page, install page, and all five Supabase-hosted functions.
- [ ] **NOT RUN** — stop the box service only after the public host, custom
  domain, GitHub callback, and GoTrue settings are all restored:

  ```sh
  cd /opt/commonswarm/current
  docker compose -f deploy/edge-runtime/compose.yaml down
  ```

- [ ] **NOT RUN** — keep the box files for 48 hours after rollback. Then remove
  them only under a separate approved cleanup plan.
