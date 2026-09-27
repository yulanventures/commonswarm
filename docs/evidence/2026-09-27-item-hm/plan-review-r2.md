I'll verify the revised HM plan against the landed tree and each round-1 finding, starting with the review rules and the files the plan cites.The workspace is the CommonSwarm tree. I’ll check the plan’s citations against the command path, auth ladder, migrations, and deploy files.Round-1 findings are fixed against `ff293022`. The revised plan’s citations match the tree, and the authority, schema, and box holes from round 1 are closed in the text.

## Security

1. **Hosted tool call falls through to a human GoTrue session — FIXED.** Public `handle` still admits only a bearer and sends every non-agent token through GoTrue `getUser` (`supabase/functions/read/index.ts:412`, `supabase/functions/read/index.ts:440`, `supabase/functions/read/index.ts:447`). Command still ends in `getUser` plus `getClaims` and `verifiedHuman` (`supabase/functions/command/index.ts:11897-11934`). The plan does not send hosted calls down that ladder: `handleHostedCommand` takes no `Request` or bearer (`hm-plan-v2.md:62`), and `claim_hosted_seat`, `open_hosted_mcp_check_batch`, and `ack_hosted_mcp_check_batch` are rejected before the bearer ladder (`hm-plan-v2.md:87`). `HUMAN_ONLY_COMMANDS` remains today’s set (`src/protocol/workspace-commands.ts:406-423`); the plan adds a two-way kind fence on the join pattern at `src/protocol/workspace-commands.ts:647-657`.

2. **Seat names are not serialized against existing principals — FIXED.** The unique constraint is the dropped one at `supabase/migrations/20260723000001_p1_schema.sql:181` and `supabase/migrations/20260906000020_agent_execution_sessions.sql:4-5`. The live rule is the ceiling lock (`supabase/functions/command/index.ts:5735-5740`), then advisory lock `1936142698` and an exact-name check that includes revoked rows (`supabase/functions/command/index.ts:8152-8164`), mirrored in the reducer (`src/protocol/workspace-commands.ts:960-965`). The plan uses those locks, rejects any collision, and requires ordinary `allow_duplicate_name` and H0 registration (`src/protocol/workspace-commands.ts:738-745`, direct insert at `supabase/functions/command/index.ts:6559-6568`) to take the same locks (`hm-plan-v2.md:181`).

3. **Consent CSRF is only a test name — FIXED.** `docs/design/SWARM-CLOUD.md:463` still requires CSRF on web mutations. The plan binds `__Host-cswarm-oauth` (`Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, no `Domain`), OAuth `state`, a separate GoTrue state and PKCE verifier, and a one-use synchronizer token with an exact `Origin` check (`hm-plan-v2.md:652`).

4. **Refresh rotation is not one transaction — FIXED.** Acceptance is gated on one pinned connection from `BEGIN` through consume, insert, and family revocation, with the denial committed before `invalid_grant` (`hm-plan-v2.md:474`, `hm-plan-v2.md:709`). `oidc-provider` stays unapproved until that proof exists.

5. **CIMD wrapper leaves the library fetch — FIXED.** The spike must replace the library transport, not wrap it, and must show that refresh and errors cannot fall back to the built-in fetch (`hm-plan-v2.md:461-468`). `pg_hba.conf` still allows the service network to reach `172.31.0.0/24` (`deploy/supabase-stack/postgres/pg_hba.conf:12`).

## Invariants

- **One command, one workspace — FIXED.** `resolveRoute` still takes one `workspace_id` (`supabase/functions/command/index.ts:3003-3042`). Consent is `begin` on the home stream, one `consent_hosted_mcp_workspace` per workspace, then `activate` on the home stream. Idempotency stays `(principal_kind, principal_id, command_id)` with the live check `user|agent|join` (`supabase/migrations/20260916000002_agent_join_attempts.sql:118-122`), and the plan adds `hosted_grant` and `hosted_seat` instead of anchoring every workspace on one key.
- **Authority time — FIXED.** Registration and ordinary commands both take `statement_timestamp()` (`supabase/functions/command/index.ts:5865`, `supabase/functions/command/index.ts:11043`). Principal events use `ctx.now` (`src/protocol/workspace-commands.ts:973`). The plan forbids `clock_timestamp()` defaults for those projections (`hm-plan-v2.md:228`).
- **OAuth as a second writer in `swarm` — FIXED.** Credential rows go to schema `commonswarm_oauth` under `commonswarm_oauth_runtime`, with `search_path = commonswarm_oauth, pg_catalog`, no `USAGE` on `swarm`, and no authority writes (`hm-plan-v2.md:238-256`). `REVOKE ALL ON SCHEMA swarm FROM PUBLIC` remains (`supabase/migrations/20260723000001_p1_schema.sql:107`).
- **Wake-view replacement — FIXED.** The live view is still the four-column `security_barrier` view at `supabase/migrations/20260925000001_unclaimed_observed_ack.sql:75-116`, revoked from `swarm_read` and `swarm_command` at line 118. The plan keeps that text and adds only `p.turn_only = false` (`hm-plan-v2.md:322`). No later migration replaces it.

## Code facts

| Round-1 row | Verdict | Evidence |
|---|---|---|
| Name unique at `p1_schema.sql:173` | **FIXED** | Constraint was line 181; dropped at `20260906000020_agent_execution_sessions.sql:4-5`. Plan cites both. |
| Wake columns at line 93 | **FIXED** | Projection is `workspace_id, signal_id, principal_id, enqueued_at` (`20260925000001_unclaimed_observed_ack.sql:76-77`). `ack_outcome` is inside the observed-ack `EXISTS` at line 96. |
| `agent_principals` selects `p.status` at `20260916000001:126` | **FIXED** | Line 126 is a comment. The view at lines 130-150 selects `model` and `managed_at`, uses `swarm.is_member`, and excludes registrars. Archival is inside `is_member` (`20260820000002_archive_revokes_access.sql:4-20`). |
| `npm test` at `package.json:22`, `check:edge` at line 20 | **FIXED** | Line 19 is `build:command-core`, line 22 is `check:edge`, line 23 is the literal `test` list. Plan cites `package.json:23` (`hm-plan-v2.md:272`, `hm-plan-v2.md:762`). |
| Read serves at `read/index.ts:979` as `handle(request)` | **FIXED** | `handle` is three arguments at line 403. `handleRequest` is at line 988 and keeps OPTIONS, request id, phase, and CORS. `import.meta.main` guards `Deno.serve` at line 1000. |
| GoTrue at `command/index.ts:11898` and `read/index.ts:440` | **FIXED** | Join gate is 11857, `swm_agt_` is 11886, GoTrue `getUser`/`getClaims` is 11897-11904, `verifiedHuman` is 11927. Read line 440 is `AGENT_TOKEN_RE`; `getUser` is 447. |
| 96 MiB and the 10s queue at `index.ts:31` and `compose.yaml:15` | **FIXED** | `FUNCTIONS_ROOT` is line 31. `USER_WORKER_MEMORY_MB = 96` is line 35. `--max-parallelism 4` and `--request-wait-timeout 10000` are `deploy/edge-runtime/compose.yaml:17-24`. |
| Proofs named `0.1.81-hosted-mcp-authority-catalog.sql` | **FIXED** | Section 5 requires a 14-digit version and `$PROOF_DIR/${VERSION}-catalog.sql` plus `-functional.sql` (`deploy/RELEASE-TO-BOX.md:1015`, `deploy/RELEASE-TO-BOX.md:1023-1024`). Plan uses `deploy/release-proofs/item-hm/<14-digit>-{catalog,functional,rollback,rollback-catalog}.sql`. |
| Raw microsecond `(timestamptz, uuid)` cursor | **FIXED** | Read compares and orders `date_trunc('milliseconds', created_at), id` (`supabase/functions/read/index.ts:948-963`). Plan stores that same truncated key. `compareSignalCursor` is still `Date.parse` (`src/cloud/signals.ts:628-632`), cited as the TypeScript comparator, not the hosted key. |

`FUNCTION_NAMES` is the five names at `deploy/edge-runtime/main/router.ts:1-7`. Command `handleRequest` is `supabase/functions/command/index.ts:12019`. H0’s one-active index starts at `supabase/migrations/20260922000001_h0_poll_lock_and_batch.sql:103`. Package version `0.1.80` is `package.json:3`. Suite choices are `.github/workflows/server-suite.yml:30-33`; the site build step is line 77. The plan cites 30 and 77.

Nits match the tree: `register_agent_seat` at `src/protocol/workspace-commands.ts:161`, `check.json` at `src/cloud/agent-check.ts:138-141`, deferred cursor write at lines 377-389, stdio `check` at `src/mcp/server.ts:127`, `file_put` at `src/mcp/tools.ts:38`, `agentCredentialRevoked` at `supabase/functions/_shared/agent-auth.ts:131` with the token/run/device join at lines 120-123.

## Box constraints

1. **Service shape — FIXED.** Project `commonswarm-oauth`, `/home/commonswarm/oauth/releases/<sha>`, `current`, `commonswarm-net`, publish only `127.0.0.1:<port>` in `3490-3499` after `ss -ltnp` (`hm-plan-v2.md:788`). No port is reserved in the plan.
2. **Memory — FIXED.** `mem_limit: 512m`, at most 1 CPU, healthcheck, `restart: unless-stopped`, `json-file` rotation `max-size: 10m`, `max-file: "3"`.
3. **Secrets and database — FIXED.** Key generated on the box, vault `Yulan Ventures Infra`, files under `/etc/commonswarm-oauth/` as `root:<service gid>` mode `0640`, read through `*_FILE`. `kid` overlap is an operational procedure. Role is `LOGIN NOINHERIT` with SCRAM and TLS (`deploy/supabase-stack/postgres/pg_hba.conf:3`, `deploy/supabase-stack/postgres/pg_hba.conf:12`). Proof names match section 5, and the new schema is in the nightly backup.
4. **Cloudflare — FIXED.** Proxied DNS, hostname-scoped skip of Browser Integrity Check and bot challenges, and a non-browser User-Agent probe of discovery, token, JWKS, and MCP. Error 1010 is recorded at `deploy/RELEASE-TO-BOX.md:1429` (the plan’s pointer is 1426; the sentence is three lines later, and the requirement does not depend on that pointer).
5. **Process — FIXED.** Each green lane is released on its own with a rollback window (`hm-plan-v2.md` §7.6). The GoTrue change names `GOTRUE_URI_ALLOW_LIST` and appends `https://mcp.commonswarm.com/oauth/callback/gotrue` to the three live entries at `deploy/supabase-stack/env.example:23` (`hm-plan-v2.md:861`). Extra live entries are kept.

## Lanes and order

- **Lane 1 snippet — FIXED.** Landed wrapper stays `handleRequest` at `supabase/functions/read/index.ts:988-1000`. Hosted context is a separate internal interface in lane 2.
- **`test:site` on the mini — FIXED.** Browser tests are the manual Actions `site` suite. The workflow states that headless Chrome raises a Keychain dialog (`.github/workflows/server-suite.yml:6-8`).
- **PostgreSQL adapter tests on root `npm test` — FIXED.** Root `npm test` stays the service-free list (`package.json:23`, `hm-plan-v2.md:762`). Adapter tests are wired into Actions `server`.
- **Docker-skip treated as mini-safe — FIXED.** `tests/p1-cli/n-db-cron-jobs.test.ts:36` probes `docker version`. The plan keeps the full `p1-cli` suite on Actions and forbids that probe on the mini.
- **Consent and Connected apps not a lane — FIXED.** Lane 8 names `services/mcp-auth/src/interaction-page.ts`, `consent.ts`, `connections.ts`, `site/src/lib/connected-apps.ts`, and `site/src/components/app/LiveDashboard.astro`, with Actions `site` coverage (`hm-plan-v2.md:602`). Nothing in `site/src` implements that surface today; the lane is the work.
- **Order — FIXED.** Lane 4 lands and releases `transport` / `turn_only` before lane 2 creates seats. The event fold insert that must learn the new columns is `supabase/functions/command/index.ts:4441-4452`. Lane S does not need the grant schema. The grid has two slots; lane 5 and lane 8 are slot B, not a third lead stream (`hm-plan-v2.md:951`).

## Schedule

**FIXED for this pass.** Two slots, review occupying a slot, per-lane release, and a critical path are specified. Length was not scored.

## New production-blocking defects

None. The hosted credential kind, the signal `from_kind` check (`supabase/migrations/20260724000003_signals.sql:7`), and the reply split on `auth.agent !== null` (`supabase/functions/command/index.ts:8727-8746`) need a seat-principal branch at implementation time. The plan already requires seat attribution and forbids turning those calls into human operations, and it does not tell the lane to stamp `hosted_seat` into `from_kind`.

VERDICT: PASS