# AGENTS.md — CommonSwarm

This is the canonical repository instruction file for all coding agents.

Read the workspace root `AGENTS.md` first (`Ridge.io/AGENTS.md`; on the Mac mini that is
`/Users/yulanbot/Developer/Ridge.io/AGENTS.md`). It defines the Yulan Ventures
workspace rules, agent process, security rules, and CI fleet. For production operations,
read `hetzner-handoff/HETZNER-OPERATIONS.md` from the workspace root. Do not copy either
file into this repository.

## Scope and product

CommonSwarm is a coordination service for people and AI agents. It includes the `cswarm`
CLI, a Supabase-compatible backend, and the static site at `https://commonswarm.com`.
Agents post short, immutable signals of intent so collaborators can avoid overlapping
work. A signal never claims, blocks, or closes a task.

Status: P3-1, open free tier. `SWARM_SELF_SERVE=1` is live. `/app` owns sign-up and the
workspace. `/start` is a compatibility handoff. Node 22 or newer is required; `site/`
requires Node 22.12 or newer.

The product was renamed from `coswarm` to CommonSwarm and `cswarm` in 2026. Prose says
CommonSwarm. Text that a user types says `cswarm`. Keep these unrelated names unchanged:

- `__COSWARM_VERSION__` in `scripts/build-release.sh` and `src/cli.ts`;
- the PostgreSQL schema `swarm` and `SWARM_*` environment variables;
- the separate local `swarm` CLI.

The GitHub repository is `yulanventures/commonswarm`. Old `Ridge-io` URLs can redirect,
but new URLs and documentation use `yulanventures`.

## Product and code invariants

- `docs/design/SWARM-CLOUD.md` is the canonical product specification. On conflict, it
  wins.
- The authority core is a deterministic reducer. Every backend state change goes through
  the transactional command path. Clients do not write authority state directly.
- Signals are append-only. Corrections are new signals.
- Durable operator or system state belongs in PostgreSQL. Process memory is only a cache
  or a home for state that can be derived again.
- A wake event is a latency hint. `swarm.signal_deliveries` is delivery truth. A status
  may say push only while its Realtime socket is subscribed.
- The optional local listener wakes its own seat. It does not start a model or create a
  worker. Agent-based monitoring is not an active workspace practice; agents must not run
  `cswarm listen` for repository coordination.
- User-facing output says what happened, what is now true, and what the user must do next.
  A success-shaped response must not hide work that is still in progress.
- Product language is plain and calm. Describe coordination and unblocking, not control,
  authority, or enforcement.
- Claims about CommonSwarm behavior must hold for the hosted workspace and the optional
  local listener unless the copy names one of them.
- Onboarding asks for the minimum. Detect context instead of asking when detection is
  reliable; return no value instead of guessing. Inherited runtime markers such as
  `CLAUDE_CODE_ENTRYPOINT` are not reliable agent identity.
- Brain-link parsing uses `BRAIN_SLUG_SEPARATORS` in `site/src/lib/brain-links.ts`. Do not
  retype that separator set. See `docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md`.

## Repository layout

| Path | Purpose |
|---|---|
| `src/protocol/` | Pure authority core: commands, events, and reducer; no I/O. |
| `src/cloud/` | Client auth, signals, workspaces, and transport. |
| `src/cli.ts` | `cswarm` CLI entry point. |
| `supabase/` | Migrations and Deno functions: `command`, `read`, `capability`, `activity`, and `h0`. |
| `deploy/supabase-stack/` | Self-hosted PostgreSQL, GoTrue, PostgREST, Realtime, and Storage definitions. |
| `deploy/edge-runtime/` | Self-hosted Deno edge runtime and router. |
| `deploy/site/` | Static-site build, validation, release, and Caddy files. |
| `tests/` | Pure, CLI, local-stack, server-stack, and UX suites. |
| `site/` | Astro 7 site; see `site/AGENTS.md`. |
| `docs/design/` | Product and technical design. |
| `docs/evidence/` | Committed evidence for completion claims. |

`scratchpad/` is ignored. Put durable evidence in `docs/evidence/` or `docs/org/`.

## Local development and tests

| Command | What it does |
|---|---|
| `npm install` | Install dependencies; `prepare` builds the package. |
| `npm run build` | Clean `dist/`, run `tsc`, and make `dist/cli.js` executable. |
| `npm test` | Run the service-free files named in the literal `test` script. |
| `npm run test:p1-cli` | Build the CLI if needed, then run `tests/p1-cli/**/*.test.ts`. |
| `npm run check:tests` | Type-check `tests/` as well as `src/`. |
| `npm run check:edge` | Run `deno check` on all five edge-function entry points. |
| `npm run test:site` | Run the site test suite. |
| `npm run test:p1-local` | Run the ten named local integration files serially; needs Docker and an exclusive database slot. |
| `npm run test:p1-server` | Regenerate the protocol bundle, then run the server suite serially; needs Docker and an exclusive database slot. |
| `npm run test:uxtest` | Run the cross-machine UX harness. |
| `npm run db:start` / `db:stop` / `db:reset` / `db:status` | Control the local Supabase CLI stack. |
| `npm run db:diff` / `db:migrate` | Inspect or apply local migrations only. |
| `npm run build:command-core` | Regenerate `supabase/functions/_shared/protocol.js`. |
| `npm run test:h0-upgrade:local` / `test:h0-counts` | Test the H0 migration and count artifacts locally. |
| `bash scripts/build-release.sh` | Build and execute-check `dist-release/cswarm`, then write its checksum. |

The local Supabase CLI stack is development-only and listens at `127.0.0.1:54321`.
Local Supabase commands do not target production.

The site is a separate package:

```sh
npm --prefix site install
npm --prefix site run build
npm --prefix site test
```

## Test and verification guardrails

- A test runs only when a package script names or globs it. `npm test` and
  `test:p1-local` use literal file lists. Check the relevant gate whenever a test is
  added.
- `tsconfig.json` includes only `src/**/*.ts`. Edge functions are outside normal `tsc`.
  Run `npm run check:edge`; when adding a function, add its entry point to that script.
- `supabase/functions/_shared/protocol.js` is generated. Edit `src/protocol/index.ts`,
  then run `npm run build:command-core`. Never hand-edit the bundle.
- `supabase functions serve` receives only values in its `--env-file`. Parent-shell
  variables do not reach it. Add test-gated values to the suite's temporary env file.
- Source tests run TypeScript through `tsx`; they do not prove the shipped single-file
  bundle works. Changes to loading, entry points, or packaging must run
  `bash scripts/build-release.sh` and check its exit code.
- Do not pipe a required gate into `grep`; that can hide the gate's exit code.
- Resolve the path, URL, ref, symlink, or artifact before measuring it.
- Enumerate a set and reconcile its count. Do not infer completeness from a pattern.
- Run a positive control in the same invocation as a negative probe. A negative result
  must reach the code path it claims to test.
- Distinguish pushed, landed, applied, and live. State only the condition measured.
- If a test pins user-readable copy, verify the claim against system behavior. A stable
  false claim is still false.
- Generate user-facing lists of required fields, accepted commands, options, or providers
  from the same constant enforcement reads. Do not type a second list.
- Never branch on `error.message`. Use a named error class, stable code, caller
  `AbortSignal`, or owned state. Normalize raw stream failures at the boundary.
- Only when the assignment changes listener code: prove the behavior change with a detached
  listener on a temporary `--state-dir` and retain its status JSON as evidence, then stop it.
  This is a product test of the listener feature; agents never run `cswarm listen` for
  coordination or monitoring.
- Read `docs/org/2026-07-26-simplification-state.md` before a nontrivial product change.
  Read the newest `docs/org/*RESUME-HERE.md` before re-deriving release or production
  state.

In zsh, brace every revision with a path: use `${rev}:path`, never `$rev:path`.

## Git, review, and commits

Follow the workspace process: Codex makes, Claude judges, one cross-family review round,
and CI decides. The current model assignments are in the workspace `AGENTS.md`; do not
duplicate them here.

- Do not expand the assignment. Respect dirty worktrees and other agents' changes.
- Before committing, run `git rev-parse --abbrev-ref HEAD` and inspect
  `git worktree list`. Use one writer per branch and worktree. Never push a branch you do
  not own.
- Run `scripts/branch-audit.sh` before pruning branches. Do not delete a branch that still
  contains work absent from `main`.
- Every new non-merge commit covered by the repository rule needs the agent-authorship
  fields defined by `scripts/lib/agent-trailer-vocab.sh`. Install the optional helper with
  `npm run hooks:install`; CI is the guard.
- Author and committer email addresses must pass `scripts/check-commit-identity.sh`.
  The measured allowlist lives in that script. Do not reconstruct it from memory.
- Do not backfill guessed agent trailers into old commits.

## Where this runs now

Production is one Hetzner server, `yulan-vps-1`, in Falkenstein. Its Tailscale address is
`100.115.66.74`; its public address is `178.105.29.28`. Cloudflare provides DNS, proxying,
TLS, and R2 object storage. Caddy uses Cloudflare Origin CA certificates on the box.

| Surface | Production shape |
|---|---|
| API | Caddy on `api.commonswarm.com`. |
| Core stack | Compose project `commonswarm-supabase-stack`: `commonswarm-postgres` (PostgreSQL 17), GoTrue, PostgREST, Realtime, and Storage API on `commonswarm-net`. |
| Object storage | Storage API backed by Cloudflare R2 bucket `commonswarm-files`. |
| Functions | Compose project `commonswarm-edge`, Deno edge runtime on loopback port `9000`, behind Caddy. |
| Site | Static files at `/srv/commonswarm/site/current`, served by Caddy on `commonswarm.com`. |
| CLI | Production clients use `https://api.commonswarm.com`. |

Stack releases are under `/home/commonswarm/stack/releases/<sha>` and edge releases are
under `/home/commonswarm/edge/releases/<sha>`. Each has a `current` symlink. Runtime values
are in `/home/commonswarm/.env`.

The box has a `compose.override.yaml` that raises the edge-runtime memory limit to 2 GiB.
A six-hourly timer restarts that container (docker restart) because the runtime leaks memory. The timer is
mitigation; the leak still needs a repository fix. When the edge container is recreated,
`COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net` is required.

The hosted Supabase project `ukezjcnxjvkpkeezxaew` was deleted on 2026-09-20. Production
does not use hosted Supabase, Railway, or Vercel.

## How it is released

Only Anvil, the Hermes operations agent on the Mac mini, releases to the box or restarts
box services. HezLead, the Claude infrastructure seat, directs the work. Other agents may
prepare and verify release inputs, but must not deploy, restart, change Caddy, or change
production symlinks.

Every release input must be an exact reviewed SHA that has landed on `main`.
The operational procedure is [deploy/RELEASE-TO-BOX.md](deploy/RELEASE-TO-BOX.md).

| Surface | Release input and method | Automatic? |
|---|---|---|
| Stack | Reviewed repository archive for an exact SHA on `main`, unpacked at `/home/commonswarm/stack/releases/<sha>`, then released through `deploy/RELEASE-TO-BOX.md`. | No. |
| Edge | Reviewed repository archive for an exact SHA on `main`, unpacked at `/home/commonswarm/edge/releases/<sha>`, then recreated on `commonswarm-net` through `deploy/RELEASE-TO-BOX.md`. | No. The six-hour recycle timer only mitigates the live leak. |
| Site | `deploy/site/deploy.sh` builds `site/` from a clean archive of the checked-out `HEAD`, validates it, uploads a release, and atomically changes `/srv/commonswarm/site/current`. HezLead and Anvil own execution. | No. |
| CLI | `scripts/build-release.sh` creates the checked single-file CLI and checksum. `scripts/build-npm.sh` creates the npm package from that same bundle. | No publish workflow exists in this repo. |
| Schema | A schema change is a production operation performed once through `deploy/RELEASE-TO-BOX.md`. It is not applied by CI or by merging `main`. | No. |

CI never deploys production. A merge to `main` does not release the stack, edge runtime,
site, CLI, or a migration.

The root `package.json` version feeds the CLI and `/download`. Bump it with
`npm version --no-git-tag-version <version>` so `package-lock.json` stays in sync; the site
tests reject version drift.

`deploy/supabase-stack/RUNBOOK.md` records the completed hosted-to-box cutover. Its source
migration steps and `/home/commonswarm/migration.env` are historical. Do not reuse them as
the current release procedure. The linked repository procedure governs CommonSwarm releases;
the cross-repository operations runbook remains authoritative for host operations.

## CI

This repository has two GitHub Actions workflows. Both run on pushes and pull requests:

| Workflow | Check |
|---|---|
| `.github/workflows/agent-trailers.yml` | Self-tests the trailer checker, resolves the commit range, enforces required agent-authorship fields, and writes an informational summary. |
| `.github/workflows/commit-identity.yml` | Checks author and committer addresses with `scripts/check-commit-identity.sh`. |

Both use this runner fallback:

```yaml
runs-on: ${{ vars.CI_RUNS_ON_LIGHT || vars.CI_RUNS_ON_NODE || vars.CI_RUNS_ON || 'ubuntu-latest' }}
```

Use the workspace self-hosted fleet when the repository variables route there. Do not
change fleet labels in this repository. If none of the variables is set, the workflows
fall back to `ubuntu-latest`.

These are commit guards, not a build-and-test pipeline. No workflow in this repository
runs the TypeScript build, product tests, local database suites, site build, or a deploy.
Run the smallest relevant local gates and rely on both commit workflows before accepting a
change. Repository files do not prove whether GitHub branch protection marks either check
as required; do not equate a workflow file with enforced merge protection.

## Secrets and environment

Never print secret values or put them in repositories, shell arguments, logs, URLs, chat,
documentation, commits, or issue comments. Production secrets live in the 1Password vault
`Yulan Ventures Infra` and in root-only or service-owned files on the box.

| Scope | Variable names and location |
|---|---|
| Production stack | The authoritative name inventory is `deploy/supabase-stack/env.example`. Values live in `/home/commonswarm/.env` with mode `0600`. |
| Edge runtime | `SWARM_DATABASE_URL`, `SUPABASE_DB_URL`, `SWARM_DATABASE_TLS_CA_B64`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SWARM_ENV`, `SWARM_COMMAND_ALLOWED_ORIGINS`, `SWARM_CAPABILITY_URLS`, `SWARM_CAPABILITY_ALLOWED_ORIGINS`, and `SWARM_SELF_SERVE`; values use the same box env file. |
| Site build | `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` live in untracked `site/.env`. The URL is `https://api.commonswarm.com`; the key must be an anon JWT, never a service-role key. |
| CLI target | `SWARM_CLOUD_URL`, `SWARM_CLOUD_ANON_KEY`, and optional `SWARM_CLOUD_WORKSPACE_ID`. Refresh credentials live in the OS keychain where supported, with a protected file fallback described in `README.md`. |
| Local origin override | `CSWARM_DEV_ALLOWED_ORIGINS`; development only and ignored in non-interactive agent mode. |
| Test-only command hooks | `SWARM_CMD_TEST_SLEEP_AFTER_STEP` and `SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP`; never set them in production. |
| Historical cutover | Names are recorded in `deploy/supabase-stack/migration.env.example`. Any box `migration.env` is historical and must not be used to contact the deleted project. |

Example env files contain names and safe placeholders only. Never add live values to them.

## Do not

- Do not deploy to the box, restart its services, edit its Caddy configuration, or change
  release symlinks unless you are Anvil acting under HezLead's direction.
- Do not run `supabase db push`, `supabase functions deploy`, `supabase link`, any
  `supabase` command with `--linked`, `supabase projects api-keys`, or `vercel deploy` for
  CommonSwarm.
- Do not point code, DNS, a release, or an integration at hosted Supabase, Railway,
  Vercel, a `supabase.co` production host, or the deleted project.
- Do not rerun the completed source migration or treat a historical `migration.env` as a
  live release input.
- Do not run `cswarm listen` as an agent workflow, turn agent-based monitoring back on, or
  add a listener path that starts models.
- Do not put a service-role key under `site/`.
- Do not hand-edit generated protocol code.
- Do not rename `__COSWARM_VERSION__`, the `swarm` schema, or `SWARM_*` variables as part
  of product-name cleanup.
