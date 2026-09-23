# Edge-runtime box runbook

The API cutover is done. `api.commonswarm.com` is Caddy on `yulan-vps-1`. The steps below are the record of the edge-runtime lane. The pre-cutover site file was removed. It proxied to a deleted host. The live routes are `deploy/supabase-stack/commonswarm-api.caddy`. There is no fallback to another host. A pause uses `deploy/supabase-stack/commonswarm-api-maintenance.caddy`. Its public site answers 503 and has no upstream.

## NOT ESTABLISHED

1. The API cutover is done. Do not deactivate a Supabase custom domain.
   Future edge-function releases use `deploy/RELEASE-TO-BOX.md`.
2. **NOT ESTABLISHED — the three 1Password items named below exist or contain the
   current material.** An operator must confirm them without printing values.
3. **NOT ESTABLISHED — this lane did not inspect the box firewall, certificate
   files, secret source, or current operator access.**
4. Production DNS for the API already points at the server. Do not measure a Supabase Edge Functions dashboard, and do not roll DNS back to a supabase.co name.

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
- [ ] Copy `deploy/supabase-stack/commonswarm-api.caddy` to `/etc/caddy/sites/10-commonswarm-api.caddy`. The pre-cutover site file was removed. Do not point this route at a supabase.co host. There is no fallback to another host.

## 3. Start the edge runtime

- [ ] **NOT RUN** — validate Compose from the release root:

  ```sh
  cd /opt/commonswarm/current
  docker compose -p commonswarm-edge -f deploy/edge-runtime/compose.yaml config -q
  ```

- [ ] **NOT RUN** — start only the edge runtime:

  ```sh
  COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge -f deploy/edge-runtime/compose.yaml up -d edge-runtime
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
- [ ] Check Auth, REST, Storage, and Realtime on the server containers. Do not rewrite Host to the deleted supabase.co name. The live routes are in `deploy/supabase-stack/commonswarm-api.caddy`.
## 6. After the cutover

The API cutover is done. Caddy sends Auth, REST, Storage, and Realtime to the local containers in `deploy/supabase-stack/commonswarm-api.caddy`.

Future edge-function releases use `deploy/RELEASE-TO-BOX.md`.

## Worker observation after a reviewed edge release

The main service emits one-line JSON records with events `edge_worker_started`
and `edge_worker_ended`. `functionName` names one of the five functions;
`workerKey` is the isolate UUID printed by the runtime's wall-clock and
early-termination messages. `ageMs` measures from the first create result seen
by the main service to the five-second inventory poll that noticed the key was
gone. `reason` is `null` because this runtime does not pass its shutdown reason
to the main worker. An end record is an observed disappearance, not proof of the
specific retirement cause. Read records without exposing function request data:

```sh
docker logs commonswarm-edge-edge-runtime-1 2>&1 |
  jq -R 'fromjson? | select(.event == "edge_worker_started" or .event == "edge_worker_ended") | {event, functionName, workerKey, reason, ageMs}'
```

The route below accepts only a loopback socket peer **inside** the container.
Caddy has no matching public route, and the main service rejects a non-loopback
peer even if its Host header says localhost. If `curl` is installed in the
container, read the runtime counters and heap statistics with:

```sh
docker exec commonswarm-edge-edge-runtime-1 \
  curl --fail --silent --show-error http://127.0.0.1:9000/_internal/metric
```

The pinned upstream image's Dockerfile does not install `curl`. On that image,
use its installed Bash and loopback TCP socket instead:

```sh
docker exec commonswarm-edge-edge-runtime-1 bash -c \
  'exec 3<>/dev/tcp/127.0.0.1/9000; printf "GET /_internal/metric HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n" >&3; cat <&3'
```

Compare `retiredUserWorkersCount` and `activeUserWorkersCount` with the worker
records and container RSS over time. No such comparison has been made on the box
for this change yet.
