# Preparation verification — 2026-09-16

No production host, project, custom domain, DNS service, or deployment API was
contacted. No deployment was performed.

## NOT ESTABLISHED

1. **Whether Supabase auth callbacks and custom-domain TLS keep working when
   `api.commonswarm.com` terminates at Caddy and non-function paths proxy to the
   Supabase project origin.** This must be checked live before DNS moves: OAuth
   start and callback, OTP, refresh, logout, REST, Storage, Realtime websocket,
   and the Supabase custom-domain verification state.
2. The Hetzner box, Caddy configuration, certificate files, 1Password items,
   firewall, DNS, and rollback were not inspected or changed.
3. Production function behavior, production database access, and hosted edge
   invocation counts were not measured.
4. Caddy syntax was not checked with the Caddy binary because it is not installed
   in this worktree environment. The runbook requires `caddy validate` on the box.

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
