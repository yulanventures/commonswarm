# Edge-runtime box runbook

Every action below is **NOT RUN by this fix lane**. The lead deployed `76487b81`
to the box before this round. The container is healthy and Caddy serves both
`api.commonswarm.com` and `edge-staging.commonswarm.com`; staging was measured
through Cloudflare.

## NOT ESTABLISHED

1. **NOT ESTABLISHED — auth callbacks and custom-domain TLS after proxy
   cutover.** Staging proxying works, but production DNS, the Management API
   custom-domain deactivation, production controls, and rollback have not run.
   Only a controlled live cutover can establish that callback and TLS sequence.
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
  is a required boot value and must equal `1`, or the runtime refuses to start
  because production workspace creation requires self-serve mode. Confirm it
  without printing the environment file:

  ```sh
  grep -qx 'SWARM_SELF_SERVE=1' /home/commonswarm/.env
  ```
- [ ] **NOT RUN** — set ownership and mode without reading the file:

  ```sh
  chown commonswarm:commonswarm /home/commonswarm/.env
  chmod 0600 /home/commonswarm/.env
  ```

- [ ] **NOT RUN** — place the certificate and key at
  `/etc/caddy/certs/commonswarm.com.pem` and
  `/etc/caddy/certs/commonswarm.com.key`. Make the key readable only by Caddy.
- [ ] **NOT RUN — verify the box-operator prerequisite before cutover** —
  HezLead added the dated 22-range trusted-proxy block to the main
  `/etc/caddy/Caddyfile`. Confirm the adapted full configuration still has one
  static 22-range source, strict parsing, and both client-IP headers:

  ```sh
  caddy adapt --config /etc/caddy/Caddyfile --pretty > /run/commonswarm-caddy-adapted.json
  jq -e 'any(.apps.http.servers[]; .trusted_proxies.source == "static" and (.trusted_proxies.ranges | length) == 22 and .trusted_proxies_strict == 1 and .client_ip_headers == ["CF-Connecting-IP", "X-Forwarded-For"])' /run/commonswarm-caddy-adapted.json
  rm /run/commonswarm-caddy-adapted.json
  ```

  If this check fails, stop before cutover and ask the box operator to restore
  the global settings. Without them, routing still works, but capability rate
  limits use a shared Cloudflare-peer key instead of the visitor.
- [ ] **NOT RUN** — compare the Cloudflare proxy ranges in
  `caddy-global-servers.caddy`, pinned 2026-09-16, with Cloudflare's current
  published list. If it changed, ask the box operator to update the main global
  block and repeat the adapted-config check.
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
  `X-Forwarded-Proto` set to `https`. Confirm Supabase-origin requests do not
  carry `CF-Connecting-IP`, `CF-Ray`, `CF-Visitor`, `CF-IPCountry`, `CDN-Loop`,
  or `True-Client-IP`, and return no Supabase Cloudflare 403. Confirm the
  capability function still sees the visitor address, not the Cloudflare edge
  address.
- [ ] **NOT RUN** — do not open the production window until every staging check
  passes. Record failures; do not compensate by raising timeouts.

## 6. Production cutover with a 48-hour project-URL fallback

The Strategist ruling dated 2026-09-16 21:07Z defines this binding order. Do not
deactivate the custom domain before DNS moves.

- [ ] **NOT RUN — (1) land** — land the reviewed release, install that exact
  release on the box, validate the full Caddyfile, and record the passing
  `edge-staging.commonswarm.com` rehearsal. Confirm Caddy sends functions to
  loopback and sends Auth, REST, Storage, and Realtime to the project host with
  the ruled header changes.
- [ ] **NOT RUN — (2) switch DNS** — record the old row for rollback, then change
  `api.commonswarm.com` from the DNS-only CNAME
  `ukezjcnxjvkpkeezxaew.supabase.co` to `A 178.105.29.28`, **PROXIED**, with a
  low TTL. Leave the Supabase custom domain active. The box already proxies all
  non-function project paths back to the project host, so they continue to work
  while DNS propagates.
- [ ] **NOT RUN — (3) prove the new path and run controls** — first GET
  `https://api.commonswarm.com/functions/v1/h0/agent-doc/cutover`. H0 exists only
  on the box, so this is the required proof that the public name reaches the
  box; a normal Supabase path cannot prove that while Cloudflare-for-SaaS still
  owns the custom hostname. Only after H0 passes, run all five function smokes,
  an Auth settings read, a membership REST read, a Realtime subscribe, one file
  upload, one seat wake round trip, and the acceptable-use and install-page
  checks from two networks.
- [ ] **NOT RUN — (4) last reversible-state check, then the one-way door** — do
  this only when every step-(3) control is green and the operator has added
  `https://ukezjcnxjvkpkeezxaew.supabase.co/auth/v1/callback` as the Google
  redirect URI. Deactivate the Supabase custom domain through the Supabase
  Management API and record its response and time. Do not deactivate it in the
  dashboard and do not let it lapse.
- [ ] **NOT RUN — (5) sign in** — complete one GitHub sign-in end to end through
  the public app. The GitHub OAuth app already lists both the project-URL and
  `api.commonswarm.com` callbacks; make no GitHub console change. GoTrue's Site
  URL and URI allow-list already contain the app's real URLs; make no GoTrue
  change.
- [ ] **NOT RUN** — keep
  `https://ukezjcnxjvkpkeezxaew.supabase.co` and its hosted functions available
  as the fallback for at least 48 hours.
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

- [ ] **NOT RUN — before cutover step (4)** — rollback is only restoring the
  DNS-only CNAME `ukezjcnxjvkpkeezxaew.supabase.co`. Do not change GitHub or
  GoTrue. Wait the low TTL plus resolver cache time, then confirm H0 no longer
  answers and Supabase project paths do.
- [ ] **NOT RUN — after cutover step (4)** — keep the A record pointed at the
  working box while the operator re-adds `api.commonswarm.com` as the Supabase
  custom domain through the Management API. Publish the new Supabase DNS
  verification record, wait for verification and custom-domain TLS to become
  active, and only then restore the DNS-only CNAME
  `ukezjcnxjvkpkeezxaew.supabase.co`.
- [ ] **NOT RUN** — budget from minutes up to 48 hours for DNS propagation,
  Supabase verification, and certificate activation after re-adding the custom
  domain. This is not an immediate rollback. That delay is why deactivation is
  the last step before final sign-in.
- [ ] **NOT RUN** — make no GitHub console or GoTrue rollback changes; cutover
  changed neither. Complete one GitHub sign-in through `api.commonswarm.com`
  after the restored custom domain and CNAME are active.
- [ ] **NOT RUN** — verify the Realtime subscribe, file upload, seat wake round
  trip, acceptable-use page, install page, and all five Supabase-hosted functions.
- [ ] **NOT RUN** — stop the box service only after the public host, custom
  domain, DNS row, and production controls are all restored:

  ```sh
  cd /opt/commonswarm/current
  docker compose -f deploy/edge-runtime/compose.yaml down
  ```

- [ ] **NOT RUN** — keep the box files for 48 hours after rollback. Then remove
  them only under a separate approved cleanup plan.
