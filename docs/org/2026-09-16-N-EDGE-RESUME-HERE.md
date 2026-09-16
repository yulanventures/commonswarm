# Resume here — item N-edge: the edge functions onto yulan-vps-1 (2026-09-16)

Written for a cold successor. The H0 lanes have their own file:
`docs/org/2026-09-16-H0-LINK-JOIN-RESUME-HERE.md`.

## Rulings (CSwarmStrategist, operator-confirmed)

- 28830ab6 (19:04Z): the edge functions run on yulan-vps-1, off Supabase, by **2026-09-18**. This is the top
  item; H0 and H come after it. Compute only: Postgres, Auth, Realtime and Storage stay on Supabase. Five
  functions: command, read, capability, activity, h0. Prove a staging hostname before DNS moves (GitHub
  sign-in callback, a Realtime subscribe, a file upload, one seat's wake round trip, the acceptable-use and
  install-page controls). Cut over by DNS with a low TTL; the Supabase URL stays the fallback for 48 h; then move
  seats one at a time.
- 33ead53b (19:27Z): option B. Keep the Falkenstein box and accept the latency until Postgres moves.
- fca44026 (19:28Z): the latency measurement is RECORDED, not a gate. Only a client timeout that the staging run
  shows actually breaking blocks the cutover, and it is fixed in the same release. Next item after N-edge is
  N-db (Postgres onto the box), then storage to R2, then sign-in. In-flight lanes 3b and H lane 1 land when their
  pairs are clean. New H0 and H lanes wait until after N-db.

## The whole move and the N-db ruling (19:34Z-19:51Z)

- Standing order 87d053dd: CommonSwarm fully off Supabase and Vercel onto yulan-vps-1, as fast as possible, no
  Strategist ask between items: N-edge (by 2026-09-18) → N-db → N-storage (R2) → N-auth-realtime (OAuth and
  sessions in Postgres, WebSocket wake) → N-retire (operator confirms deletion); N-site (off Vercel) in parallel
  any time. H0 and H resume after N-db.
- **N-db = option A** (7806c57c): Postgres moves TOGETHER with self-hosted gotrue, postgrest, realtime and
  storage-api on the box, pointed at the box's Postgres, Caddy routing /auth/v1, /rest/v1, /realtime/v1,
  /storage/v1 to them. One cutover window; clients unchanged; humans sign in once more (say so in the release
  note; Supabase's asymmetric JWT signing keys cannot be exported); agent tokens (swm_agt_ rows) survive.
  Conditions: a full rehearsal on the box from a fresh dump (auth and storage schemas included) with the
  production controls green BEFORE the window; the us-east-1 project read-only during the window; a final dump;
  48 h fallback. N-storage and N-auth-realtime then replace those containers one at a time, no deadline.
- **Site: on the box behind Caddy** (lane/site-on-box). Cloudflare Pages is noted as the fallback only if the box
  fails a parity check.
- Box facts from HezLead (ef5d054a): user commonswarm in docker and sitesadm (Caddy validate/reload without a
  password); Docker network commonswarm-net 172.31.0.0/24, gateway 172.31.0.1; main Caddyfile is only
  `import sites/*.caddy`, placeholder at /etc/caddy/sites/00-commonswarm-placeholder.caddy (ours to overwrite);
  box Postgres database `commonswarm`, owner commonswarm_admin (non-superuser), commonswarm_app (CONNECT only), no
  passwords yet (set with `sudo -u commonswarm psql -U commonswarm_admin -d commonswarm` and `\password`, into
  the vault); host Postgres listens on 172.31.0.1 for containers with TLS and scram; nightly pg_dump already
  includes `commonswarm`. R2 bucket commonswarm-files and the DNS token are with Anvil.

## N-db feasibility, measured 2026-09-16 ~20:00Z (values never printed)

- Clients hold the LEGACY anon JWT: CLI profiles (`anon_key`), site/.env PUBLIC_SUPABASE_ANON_KEY, and the live
  `commonswarm:anon-key` meta on commonswarm.com. Not the sb_publishable key (which only hosted Supabase's gateway
  understands).
- Management API `GET /v1/projects/ukezjcnxjvkpkeezxaew/postgrest` returns `jwt_secret` (88 chars); an HMAC-SHA256
  check shows it signs the legacy anon JWT. So self-hosted gotrue/postgrest/realtime/storage-api configured with it
  accept every existing client key: "clients unchanged" is feasible. `GET .../config/auth` returns the GitHub OAuth
  client secret (`external_github_secret`) for self-hosted gotrue. The management token is the Supabase CLI's
  keychain entry "Supabase CLI" (sbp_ token).
- OPEN, asked HezLead (b4e62dfa): a dedicated `supabase/postgres` 17 CONTAINER for CommonSwarm (Supabase's
  cluster-wide roles anon, authenticated, service_role, authenticator, supabase_* admins and its extensions,
  isolated from PromptEden) versus the shared host cluster's `commonswarm` database. Lead recommends the container.

## HezLead (box operator) answers, 19:37Z — binding for the cutover

- **Cap** (60949772): if staging p95 for ONE COMMAND exceeds 2.0 s, or any CLI or listener timeout trips, STOP and
  tell HezLead. Fallback, only on that measurement: a temporary $24 DigitalOcean NYC droplet (2 vCPU / 4 GB, about
  10 ms from us-east-1) running the same container until N-db lands. Reason Ashburn is impossible: the Hetzner
  account is capped at 8 vCPUs until about 2026-09-30, and yulan-vps-1 uses all 8.
- Cheap wins inside the lane are allowed if they are pure refactors on the same SHA review: batch per-command
  statements into one function or CTE where the code already allows it. No semantic changes.
- Record in the lane report: p50/p95 per command, per read, per wake, and the statement count per command,
  measured on `edge-staging.commonswarm.com`.
- **Staging name approved:** `edge-staging.commonswarm.com`. Zone rule: `<service>-staging.commonswarm.com` for
  staging, `<service>.commonswarm.com` for production, and nothing on the box without a site block in
  /etc/caddy/sites/.
- **Cloudflare token:** HezLead cannot read secrets; Anvil (who created the item) is re-saving it with the bare API
  value in the main field. Check the item again about 20:40Z.
- **Custom-domain cutover, in THIS order, inside the window** (b056e841): (a) Caddy on the box proxies /auth/v1/*,
  /rest/v1/*, /storage/v1/*, /realtime/v1/* to the project URL with the Host header rewritten to the project host
  — REHEARSE ON STAGING NOW; (b) deactivate the custom domain in Supabase yourself, do not let it lapse; (c) change
  the GitHub OAuth app callback to the project URL's /auth/v1/callback and set GoTrue's Site URL and redirect
  allow-list to the app's real URLs; (d) verify one GitHub sign-in end to end before lifting anything. If the OAuth
  app is on Tom's GitHub account and cannot be edited, give HezLead the exact settings page and the new value.
  Without (b)-(d), Supabase deactivates the domain on its next check and GoTrue's external URL reverts, which breaks
  the GitHub OAuth callback.
- Box access: in as `ops`; every change reversible and noted in the lane report. HezLead is the box operator.

## MEASURED FACTS

- api.commonswarm.com is a DNS-only CNAME to ukezjcnxjvkpkeezxaew.supabase.co (Supabase custom domain for the
  whole project). The live site publishes `https://api.commonswarm.com`.
- The box is in Falkenstein, DE (Hetzner). The database is in AWS us-east-1. TCP connect time from the box to
  aws-0 and aws-1-us-east-1.pooler.supabase.com:6543 is 108-113 ms. Every SQL statement costs at least one
  round trip; the per-command statement count is NOT yet measured.
- Box: x86_64, Docker 29.8.1, Caddy 2.11.4 with `auto_https off`, 15 GB RAM, 286 GB free disk. Tailscale
  100.115.66.74, public 178.105.29.28.
- Production function secrets (`supabase secrets list`, names and digests only): SUPABASE_ANON_KEY,
  SUPABASE_DB_URL, SUPABASE_JWKS, SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS, SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL, SWARM_DATABASE_URL, SWARM_SELF_SERVE. Digest matches: SWARM_SELF_SERVE = "1"; SUPABASE_URL =
  the supabase.co URL; SUPABASE_ANON_KEY = the NEW publishable key.
- The Supabase postgres password recorded in 1Password ("Supabase — cloud-swarm-dev", OpenClaw vault, July 23)
  and in ~/.config/uxtest/cloud.env are STALE: the pooler answers 28P01. The anon and service_role keys in that
  item do not match production either.
- Production Postgres 17.6. `log_statement = ddl`: a plaintext ALTER ROLE ... PASSWORD would be logged, so
  passwords are set as SCRAM verifiers. `swarm_command` is a LOGIN role but a member of nothing; `postgres` is
  a member of swarm_admin, swarm_command, swarm_read and swarm_capability.

## DONE (live, reversible)

- Box, as ops: `commonswarm` added to the docker group; `/etc/caddy/sites` created; `import sites/*.caddy`
  appended to /etc/caddy/Caddyfile (backup `Caddyfile.bak-20260916-commonswarm`); validated; reloaded.
- `public.ecr.aws/supabase/edge-runtime:v1.73.13` pulled on the box: amd64, the same image id as the local stack.
- PRODUCTION DATABASE: new login role `commonswarm_edge`, INHERIT, a member of swarm_command, swarm_read and
  swarm_capability only (INHERIT and SET), password as a SCRAM verifier. Applied with
  `supabase db query --linked -f`, the ref confirmed first. Probe through the transaction pooler: login OK;
  SET LOCAL ROLE to each of the three OK. Undo: `DROP ROLE commonswarm_edge`. NOT YET in a migration: a later
  migration must create it idempotently so the schema history and N-db's dump carry it.
- 1Password vault "Yulan Ventures Infra": item `rhxyrnmxy5dw3klf6ata5nqlru`, "CommonSwarm edge DB role
  commonswarm_edge (cloud-swarm-dev)".
- Box `/home/commonswarm/.env`, 0600, names: SUPABASE_URL, SUPABASE_ANON_KEY (publishable),
  SUPABASE_SERVICE_ROLE_KEY (legacy service_role JWT; a read-only Storage bucket list returned 200),
  SWARM_DATABASE_URL and SUPABASE_DB_URL (commonswarm_edge via aws-0 pooler 6543), SWARM_SELF_SERVE=1.

## LIVE ON THE BOX, NO PUBLIC TRAFFIC YET (~20:20Z)

- lane/edge-runtime-box tip **76487b81** (Codex sol high + one lead commit adding edge-staging.commonswarm.com to
  the site block) is unpacked at /home/commonswarm/edge/releases/76487b81, `current` symlink, Compose project
  `commonswarm-edge`, container `commonswarm-edge-edge-runtime-1` HEALTHY on 127.0.0.1:9000, using
  /home/commonswarm/.env (production database via commonswarm_edge). Stop with
  `docker compose -p commonswarm-edge down` in ~/edge/current/deploy/edge-runtime.
- Box-local smoke: h0 document 200 (0.23 s); malformed command 400 (1.07 s — the command edge touches the
  production database); unknown function 404; GET /read 405 (POST only).
- Caddy: /etc/caddy/sites/10-commonswarm-api.caddy (from the lane file) serves api.commonswarm.com and
  edge-staging.commonswarm.com; `caddy validate` passed on the box; reloaded. Through Caddy with
  `--resolve edge-staging.commonswarm.com:443:127.0.0.1`: h0 document 200 (12 ms); /storage/v1/status 200 via
  supabase.co; /auth/v1/health and /rest/v1/ 401 without an apikey (expected). The placeholder
  00-commonswarm-placeholder.caddy is untouched (N-site replaces it).
- No DNS record points at the box yet: api.commonswarm.com is still the Supabase CNAME; edge-staging does not exist.
- Review pair on 76487b81 dispatched: grok (worktree arms-nedge-grok) and antigravity (inline).

## N-SITE ON THE BOX, NO PUBLIC TRAFFIC YET (~20:45Z)

- lane/site-on-box tip 97ab1455 (Codex sol high, fix round 1, plus two lead commits: rsync `--chmod` dropped
  because the operator mac's openrsync rejects it — finalize-release.sh normalizes modes on the box; and
  site-staging.commonswarm.com added to the site block). The first two real deploys FAILED CLOSED (npm --prefix from
  the worktree; then rsync --chmod); the third succeeded: /srv/commonswarm/site/current →
  releases/20260916T203700Z-8e618e37acbb-b2b8ac1e64e0bdc3, files 644, dirs 755.
- Caddy: /etc/caddy/sites/20-commonswarm-site.caddy serves commonswarm.com, www, site-staging; validated; reloaded.
  HezLead's placeholder removed (backup /root/00-commonswarm-placeholder.caddy.bak-20260916).
- DNS: NEW proxied A records edge-staging.commonswarm.com and site-staging.commonswarm.com → 178.105.29.28.
  commonswarm.com and www still A 76.76.21.21 (Vercel, DNS-only); api still CNAME to supabase (DNS-only).
- Parity through Cloudflare on site-staging (parity-check.mjs): every HTML route, install.sh, llms.txt, SKILL.md and
  404s match; the only 21 differences are Cloudflare rewriting cache-control to max-age=14400 on static-extension
  files (zone Browser Cache TTL default). Asked HezLead to set "Respect Existing Headers" (6dcb6ba0) or accept.
- The mini's system resolver cached the new names as missing; measurement scripts route only the staging names to a
  Cloudflare IP with a Node --require preload (docs/evidence/2026-09-16-n-edge/latency-dns-override.cjs).

## INCIDENT, contained (~20:41Z)

Installing lane 47c33aad's commonswarm.caddy as /etc/caddy/sites/10-commonswarm-api.caddy made Caddy reject its whole
config: the file had a GLOBAL options block (`servers { trusted_proxies ... }`), which an imported site file cannot
carry. The lead's `caddy validate | tail -1` hid the failure, so `systemctl reload caddy` ran and failed. Restored the
76487b81 file, validated with the exit checked, reloaded (exit 0, active); site and edge staging both 200 on the box.
Only the staging names point at the box, so no public user was affected. HezLead told (8070b19c). The edge container
runs 47c33aad (healthy, 21.75 MiB / 512 MiB) with the OLD Caddy file. Fix round 3 moves the servers settings into a
separate snippet for the operator's main Caddyfile and validates the box-shaped config. HezLead accepted the 4 h
Browser Cache TTL for the cutover (2f6cd159).

## IN FLIGHT

- `lane/edge-runtime-box` (Codex sol high, prompt `maker-n-edge.txt` in the session scratchpad): router with the
  Kong strip, Compose on 127.0.0.1:9000, env.example, commonswarm.caddy with /auth, /rest, /storage and
  /realtime proxied to supabase.co, a runbook, and a local parity run. The parity run waits for the local
  database (a flag file) while grok reviews H0 lane 3b.

## BLOCKED / OPEN

- The 1Password item "Cloudflare DNS token commonswarm.com" does not hold a bare token: its password field is
  three space-separated words, and Cloudflare answers "Invalid format for Authorization header". Asked HezLead
  (69fbb2db). Staging DNS waits on it.
- Staging hostname planned as edge-staging.commonswarm.com (A 178.105.29.28, proxied). Not created.

## NOT ESTABLISHED

- Whether Supabase deactivates the custom domain when the CNAME moves, and what that does to GoTrue's external
  URL and the GitHub OAuth callback.
- The statement count per command and the p50/p95 latency through the box.
- That the legacy service_role key and the publishable key behave identically to production's own injected
  values for every code path (digests differ for the service key).
