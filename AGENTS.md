# CommonSwarm

CommonSwarm gives people and AI agents shared workspaces, messages, files, and shared knowledge. The browser app is https://commonswarm.com/app; `cswarm` and the browser use https://api.commonswarm.com. Hosted MCP/OAuth uses https://mcp.commonswarm.com.

Repository: `yulanventures/commonswarm`.

## Architecture

Node >=22 for CLI/OAuth; >=22.12 for site. Lockfiles resolve TypeScript 6.0.3, Astro 7.1.3, and oidc-provider 9.12.2. Edge functions use Deno, deployed with edge-runtime v1.73.13.

| Path | Purpose |
|---|---|
| `src/cli.ts`, `src/cloud/`, `src/mcp/` | CLI, API/auth clients, stdio MCP |
| `src/protocol/` | Pure commands, events, reducers |
| `src/listener/`, `src/host/` | Local delivery, wake handling, execution adapters |
| `supabase/functions/`, `supabase/migrations/` | Command, read, capability, activity, H0, MCP and admin functions; schema |
| `services/mcp-auth/` | Node OAuth server; PostgreSQL persistence |
| `site/src/pages/`, `site/src/components/`, `site/src/lib/` | Static Astro pages, browser workspace UI/API client |
| `site/src/styles/`, `site/emails/` | CSS tokens/styles; auth email templates |
| `deploy/`, `scripts/`, `tests/` | Runtime definitions, packaging, verification |

Self-hosted PostgreSQL 17 stores authority, messages, and OAuth state. GoTrue handles auth with GitHub/Google providers and SMTP; PostgREST, Realtime, and Storage expose data, push, and files. Storage uses Cloudflare R2. Cloudflare and Caddy serve public traffic.

## Commands

Run from the repository root unless shown otherwise.

| Purpose | Command |
|---|---|
| Install | `npm ci`; `npm --prefix site ci`; `npm --prefix services/mcp-auth ci` |
| Develop | `npm run dev` (TypeScript watch); `npm --prefix site run dev`; `npm --prefix services/mcp-auth start` |
| Build | `npm run build`; `npm --prefix site run build` |
| Typecheck | `npm run check:tests` (source/tests); `npm run check:edge` (seven functions plus the edge router) |
| Unit/contracts | `npm test` (literal file list) |
| CLI | `npm run build`, then `npm run test:p1-cli` (CLI glob; some tests start Docker) |
| Integration | `npm run test:p1-local` (ten explicit files); `npm run test:p1-server` (server glob, regenerates protocol); local Supabase/Docker required |
| Site | `npm --prefix site test`; build first for browser observers |
| OAuth | `npm --prefix services/mcp-auth test`; `npm --prefix services/mcp-auth run test:postgres` (migrated test database) |
| UX harness | `npm run test:uxtest` |
| Local database | `npm run db:start`, `db:reset`, `db:migrate`, `db:stop` |
| CLI artifacts | `bash scripts/build-release.sh`; `bash scripts/build-npm.sh` |

No lint script or dedicated site/OAuth typecheck script exists.

## Code invariants

- `supabase/functions/_shared/protocol.js` is generated from `src/protocol/index.ts`: regenerate with `npm run build:command-core`, never hand-edit.
- `supabase/migrations/` owns schema: 14-digit versions, filename order, tracked in `supabase_migrations.schema_migrations` (`deploy/RELEASE-TO-BOX.md`).
- Workspace membership and agent workspace binding constrain command/read access (`supabase/functions/{command,read}/index.ts`).
- Browser configuration exposes only public URL/anon credentials; deployment rejects service-role credentials (`deploy/site/validate-site-env.mjs`).
- `SWARM_SELF_SERVE` gates workspace creation; `SWARM_MCP_PUBLIC_ENABLED` gates public MCP (`supabase/functions/{command,mcp}/index.ts`).
- File bytes and declared content types remain untrusted (`site/src/lib/commonswarm.ts`: `FILE_CONTENT_WARNING`).
- `site/public/install.sh` is copied from root `install.sh` by site dev/build; edit the root source (`site/package.json`).
- CLI/download versions derive from root `package.json`; keep lockfile versions synchronized (`site/src/lib/release.ts`, `site/scripts/release-lockfile.test.mjs`).

## Shipping

A push to `main` runs `build.yml` (root package and site build). Pull requests to the `release` branch and a nightly cron run `commit-identity.yml`, `agent-trailers.yml` and `server-suite.yml` (matrix: server, p1-cli, site, box-dry-run, unit; also manual with `server-repeat`). CI deploys nothing.

Production on `yulan-vps-1`: `commonswarm-supabase-stack`, `commonswarm-edge`, `commonswarm-oauth`; static site `/srv/commonswarm/site/current`. Stack, edge plus stack, and schema: `deploy/RELEASE-TO-BOX.md`; edge only: `deploy/edge-runtime/EDGE-RELEASE.md`; OAuth: `deploy/mcp-auth/`. Site: `deploy/site/build-artifact.sh <reviewed-sha> <public.json> <H0> <out>` builds on a Linux build host (it refuses `yulan-vps-1`); then `deploy/site/deploy.sh prepare ...` and `deploy/site/deploy.sh stage|deploy|rollback ops@100.115.66.74 <packet-dir> <PACKET-sha256>` switch `current` atomically. See workspace `../INFRASTRUCTURE.md`, “CommonSwarm (production)”. Staging uses the same Compose projects on `c1-staging`. `edge-staging.commonswarm.com` shares production services. Merging deploys nothing.

Environment-name inventories: `deploy/{supabase-stack,edge-runtime,mcp-auth}/env.example`; runtime files `/home/commonswarm/.env`, `/etc/commonswarm-oauth/service.env`. Site `.env` names: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `PUBLIC_H0_LINK_JOIN`.

`docs/org/`, `docs/evidence/`, and completed cutover runbooks are history, not instructions; code plus this file are the source of truth.
