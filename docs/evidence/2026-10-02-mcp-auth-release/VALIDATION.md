# HM37 preparation validation

Base: origin/main `68a0d2a6715bfb4c874655cda6a4c490eea5baae`.
No commit on that ref composes the production bindings. Its
`services/mcp-auth/src/server.js:218` still calls `startServer()` without
bindings (introduced by `cc4644834`, unchanged through the base ref).

The existing `services/mcp-auth/package.json` test script globs
`test/*.test.js`; it covers the new `test/entrypoint.test.js`. The new
service `pretest` builds the shared command bundle. Root `npm test` does
not invoke the service test script. Root and service dependencies were
read through ignored symlinks to the already-installed local repository;
no dependency install, network request or source edit in that repository.

Commands and results:

- `node services/mcp-auth/build-management.mjs`: PASS; bundles the real
  lane-2 handler, imported successfully by the focused test.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test services/mcp-auth/test/entrypoint.test.js`:
  exit 0, 3 passed, 2 skipped, 0 failed. Node 24.20.0 is a supported LTS.
  Both actual `node src/server.js` children cleared configuration/binding
  gates and reached `listen`, which this sandbox rejects with EPERM.
  Discovery/authorization HTTP assertions therefore remain unmeasured.
  No PostgreSQL, GoTrue, Docker or browser is needed by this file.
- Regression mutation: changed only the real entrypoint call back to
  `startServer()`. Enabled entrypoint exited with `configuration_error`
  before listen; the new regression failed as intended (exit 1).
  Restored the composition call and reran the same file to the result above.
- Missing protected management input, absent binding functions, unverified
  reader/command identities, and non-management command refusal passed.
  Disabled mode does not load the management bundle or require its credential.
- All 12 fenced sh blocks (11 in RELEASE.md, 1 in RUNBOOK.md) passed
  extracted `bash -n` and `/bin/bash -n`; `/bin/bash` is 3.2.57.
  All 6 embedded Python blocks compiled, and the shell-unquoted Node
  readiness script passed `node --input-type=module --check`.
- New build/binding/runtime JavaScript passed `node --check`.
- `git diff --check`: PASS before commit.

The initial plain `node` run used Node 26.7.0, which oidc-provider warns is
unsupported; final verification used Node 24. The installed Node 22 binary
cannot start because `libsimdutf.34.dylib` is missing. No host repair was
attempted. The deployed Dockerfile remains pinned to Node 22.23.3.

Live read-only SSH failed with `Operation not permitted` at
`100.115.66.74:22`; no sudo was attempted. No live image, container labels,
Compose paths, env names, health, port or Caddy state was measured by this
worker. RELEASE.md distinguishes repo/handoff baselines from future gates.
No Docker image build, live DB transaction/consent flow, public route probe,
release, switch-on or done-test was executed. HezLead owns the independent
cross-family check and must reconcile the live preflight and box rm guard
before running the prepared procedure.

All synthetic credential/JWK files used fresh mode-0700
`/private/tmp/anvil-secret.*` directories, mode-0600 files, removed through
the guarded rm after each test. HOME was inherited unchanged. No secrets
were printed, no op/keychain/GUI/Chrome/Alloy calls, no push or Actions run.

## TASK-2 Composer corrections (supersedes initial validation counts)

The base Compose is byte-identical to origin/main. Its management env/mount
are now only in `compose.management.yaml`, selected only by switch-on. Step
(c)/(d) neither stages nor installs a management credential. Role/workspace
readiness moved to step (f). Both OFF rollback paths recreate with base only
and remove `/etc/commonswarm-oauth/management-database-credentials` using the
verified guard and a literal path. Switch-on refuses snapshot drift before
mutation; failed enable/readiness/memory rolls back to the new release OFF.

The shared command source already set `max: 2`; the build adapter preserves
and checks that cap and wraps pool creation lazily. `postgres` 3.4.9 is now
a pinned service dependency external to the generated bundle. That preserves
the normal dependency boundary for a database stub without replacing the
bundled management handler or adding a test-only production export.

- Node 24.20.0 focused file: 8 tests, 6 passed, 2 skipped for socket EPERM,
  0 failed. The new fresh-process checks do not listen: they call the real
  production composition root with only the HTTP listening boundary stubbed.
  The enabled check observes the callback passed to the real consent
  orchestrator, invokes the real bundled revoke handler with a postgres stub,
  and asserts its missing-grant refusal, transaction, verified-user write,
  grant lookup, first-use pool creation, max 2, and pool close. OFF observes
  zero bundle loads, pool constructors or management SQL.
- Mutation controls: allocating eagerly fails startup's zero-pool assertion;
  returning the same refusal without calling the handler fails the pool/SQL
  observations. Both owners restored byte-for-byte, focused check passed.
- All 13 sh blocks (12 RELEASE, 1 RUNBOOK): `bash -n` and `/bin/bash -n`
  PASS. All 7 Python heredocs compile; both embedded Node readiness scripts
  pass syntax after shell unquoting.
- Memory-gate Python exercised with public synthetic metrics and a 10 MiB
  inspected-limit fixture: exactly 8 MiB passes; 8.01 MiB and 9 MiB fail;
  decimal `kB` units also pass below threshold. No Docker call was executed.
- Recreated the management-build stage from exactly the Dockerfile COPY
  inputs and read-only links to existing dependencies: bundle build and
  Node syntax PASS. No Docker image build or dependency installation ran.
- `git diff --check` PASS. Identity/trailer checks run again on the final
  two-commit range after the single TASK-2 commit.

No live memory measurement, PostgreSQL transaction, release, network probe,
CI, push, Alloy, browser, GUI, keychain or HOME mutation occurred. Synthetic
credential/key fixtures used mode-0700 `anvil-secret.*` dirs and mode-0600
files; every fixture cleanup used the installed rm guard and succeeded.
The initial report's live-measurement and production-readiness limits still
apply; HezLead arranges the independent cross-family check.
