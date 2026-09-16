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
