# Edge-runtime box runbook

Every action in this file is **NOT RUN**. This preparation lane deployed nothing.

## NOT ESTABLISHED

1. **NOT ESTABLISHED — whether Supabase auth callbacks and custom-domain TLS keep
   working when `api.commonswarm.com` terminates at Caddy and non-function paths
   proxy to the Supabase project origin.** Before DNS moves, test OAuth start and
   callback, OTP, refresh, logout, REST, Storage, and a Realtime websocket through
   the box with the public host name. Confirm in the Supabase dashboard that the
   custom domain stays verified. Do not cut over if any check fails.
2. **NOT ESTABLISHED — the three 1Password items named below exist or contain the
   current material.** An operator must confirm them without printing values.
3. **NOT ESTABLISHED — the target box has the required capacity, firewall rules,
   Docker 28, Caddy, repository revision, or outbound package access.**
4. **NOT ESTABLISHED — any production request, deployment, DNS change, Caddy
   reload, function invocation decrease, or rollback.**

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
  `SWARM_ENV` to the production value used by CommonSwarm.
- [ ] **NOT RUN** — set ownership and mode without reading the file:

  ```sh
  chown commonswarm:commonswarm /home/commonswarm/.env
  chmod 0600 /home/commonswarm/.env
  ```

- [ ] **NOT RUN** — place the certificate and key at
  `/etc/caddy/certs/commonswarm.com.pem` and
  `/etc/caddy/certs/commonswarm.com.key`. Make the key readable only by Caddy.
- [ ] **NOT RUN** — copy `commonswarm.caddy` to
  `/etc/caddy/sites/commonswarm.caddy` and import that directory from the main
  Caddyfile.

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
- [ ] **NOT RUN** — capability: send a non-GET request to
  `/functions/v1/capability/smoke`. Expect 405 when capability URLs are enabled,
  or the configured feature-off response when they are disabled. Confirm the
  container log names no boot or module error.
- [ ] **NOT RUN** — request `/functions/v1/not-a-function`. Expect the main
  service's 404 body `{"error":"function_not_found"}`.

Remove `/run/commonswarm-smoke.curl` after the checks.

## 5. Check Caddy before DNS moves

- [ ] **NOT RUN** — validate the full Caddy configuration:

  ```sh
  caddy validate --config /etc/caddy/Caddyfile
  ```

- [ ] **NOT RUN** — reload Caddy, then use `curl --resolve` from a permitted test
  host to send `api.commonswarm.com` to the box IP. Trust the installed Origin CA
  certificate only for this pre-cutover check.
- [ ] **NOT RUN** — repeat all five function smokes through that resolved host.
- [ ] **NOT RUN** — check `/auth/v1/settings`, one membership REST read, one signed
  Storage request, and one Realtime websocket through the resolved host.
- [ ] **NOT RUN** — finish an OAuth login and callback, OTP login, token refresh,
  and logout through the resolved host. Check the custom-domain status in the
  Supabase dashboard. This closes NOT ESTABLISHED item 1.

## 6. DNS cutover with a 48-hour fallback

- [ ] **NOT RUN** — record the current DNS record type, target, proxy state, TTL,
  and Supabase custom-domain status. Save this outside the repository as the
  rollback record.
- [ ] **NOT RUN** — lower TTL only after the existing record's old TTL has elapsed.
- [ ] **NOT RUN** — change only `api.commonswarm.com` to the box path approved by
  the DNS operator. Keep the old record data and the Supabase custom domain for at
  least 48 hours. Do not remove the fallback during that window.
- [ ] **NOT RUN** — repeat auth, REST, Storage, Realtime, and all function smokes
  through normal DNS from two networks.

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

## 8. Roll back

- [ ] **NOT RUN** — restore the exact DNS record from the rollback record.
- [ ] **NOT RUN** — wait for the saved TTL, then verify all five Supabase-hosted
  functions plus Auth, REST, Storage, and Realtime through the public host.
- [ ] **NOT RUN** — stop the box service only after the public host is back on the
  Supabase custom domain:

  ```sh
  cd /opt/commonswarm/current
  docker compose -f deploy/edge-runtime/compose.yaml down
  ```

- [ ] **NOT RUN** — keep the box files for 48 hours after rollback. Then remove
  them only under a separate approved cleanup plan.
