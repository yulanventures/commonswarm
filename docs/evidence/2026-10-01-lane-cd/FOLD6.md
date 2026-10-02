# Lane C+D fold 6 — 2026-10-01

HEAD: `430e9574`, branch `lane/cd-admin-integ`. The eight pre-existing dirty
paths from fold 5 remain in place and were not edited by this fold. No commit,
push, Actions dispatch, browser test, GUI, Docker, keychain, secret retrieval,
database operation, or production contact occurred. HezLead owns the independent
check and subsequent authorized CI runs.

| Test | Cause with file:line | Fix / not-this-lane |
|---|---|---|
| Site #72/#73, reported admin account view import failures | The previous `site/src/components/app/admin-delegations.observer.test.ts:14-15` queried `npm root -g` and imported `playwright/index.mjs` from it. The site CI step at `.github/workflows/server-suite.yml:209` installs the site package, which declares no Playwright dependency. No sibling observer imports Playwright: they use the shared `site/tests/chrome.ts` launcher. | Converted this observer to the same `findChrome`/`launchChrome` import at `admin-delegations.observer.test.ts:11`. Retained real component/auth/client code, hostile-label assertions, uncertain-revoke retry-ID assertions, accepted revoke assertions, and private-row clearing after cross-document sign-out. A fresh profile and `--password-store=basic` remain explicit at line 99; guarded cleanup remains at line 120. Static compilation passed; browser execution is deferred. |
| Site #80, member Remove / agent geometry | The failing read is the Chrome stdout geometry decode, formerly `site/src/components/app/agent-row-geometry.observer.test.ts:122`, now line 126. This path does not read an admin fixture or command receipt. Its former unanchored attribute match accepted arbitrary nonempty attribute values; Node's permissive base64 decoder can turn them into an empty buffer. A whitespace-valued attribute reproduces the exact `Unexpected end of JSON input` error without a browser. The actual CI stdout/stack was not supplied, so the cause of CI's malformed payload remains unresolved. | Hardened extraction at lines 121–126: require the rendered `<html>` attribute, base64 characters, canonical complete encoding, and nonempty bytes before JSON parsing. Valid-payload and malformed-payload controls passed. This repairs acceptance of corrupt measurement input and gives a specific failure; it does **not** prove the original CI producer problem is fixed. HezLead needs to provide the #80 stack/stdout or inspect the next authorized site run. |
| p1-cli #1355, SIGTERM profile/worktree cleanup | `tests/p1-cli/timeout-table.test.ts:882` launches `timeout-table-exit-fixture.mjs`, whose cleanup handler comes from `scripts/timeout-table/run.mjs:119` and whose worktree comes from `run.mjs:136`. The test, fixture, executable imports and cleanup implementation have empty diffs from `8434492c`. | **Not this lane**, by code reading. C+D added three JSON timeout-map rows, but this exit fixture never loads that JSON or runs the measurement loop. No cleanup source or test was changed. The SIGTERM case itself was not run: its child HOME override at test line 816 violates this assignment's HOME instruction, and it needs git worktree writes unavailable in the sandbox. No runtime cause is claimed. |

The import wording in the task file does not match the checkout: there is no
other observer's Playwright import to copy. The replacement follows the actual
sibling browser-launch mechanism and the existing CI installation. The reported
two admin test numbers were grouped by their common import symptom; this checkout
contains one test in `admin-delegations.observer.test.ts`.

## Gates

Commands ran directly inside the supplied workspace sandbox, with HOME unchanged.
This follows the user's direct instruction rather than base-cd.txt's `env HOME`
directive. No live secret was staged, so no secret directory needed cleanup.
The build's guarded rm completed without refusal. The workspace root's
`SECURITY.md` was absent when read; the explicit secret and security rules in the
task, Anvil setup, workspace AGENTS.md and repository AGENTS.md were followed.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | Passed, including executable CLI postbuild. |
| `npm run check:tests` | 0 | Passed. This root gate does not verify site fixture runtime behavior. |
| `npm run check:edge` | 0 | All seven configured entry points passed. |
| Direct CLI gate: `admin-recovery.test.ts`, `admin-routine.test.ts`, `admin-protocol-bundle.test.ts`, `citation-drift.test.ts`, `test-gate-coverage.test.ts` | 0 | One direct Node invocation over these five files: 21 passed, none skipped. |
| Direct `timeout-table.test.ts`, selected safe cases | 0 | Six passed: release citation, HEAD operation citations, exact inventories, main alias, historical mapping bytes, and runStatus controls. No child HOME overrides or worktree creation were reached. |
| Direct `site/tests/chrome-launch-sweep.test.ts` | 0 | One source-only launcher contract test passed; it launches no browser. |
| `node scratchpad/fold-cd6/observer-smoke.mjs`, initial attempt | 1 | The smoke script evaluated an object literal without expression parentheses. No test code or browser ran; corrected the smoke script. |
| Same smoke command, final | 0 | Both observer modules, inline setup/seed/observation scripts, real component bundle and real sign-out bundle compile. Geometry decoder accepts valid root data and refuses whitespace/non-root/truncated data. The old decoder's whitespace case produces the exact reported JSON error. This is a synthetic parser probe, not a reproduction of CI's Chrome output. |
| `git diff --check` | 0 | Passed. |
| `npm test` | Not run | Contains child HOME overrides, including `tests/p1-cli/release-bundle.test.ts:42` and `tests/box-dry-run.test.ts:2167`. |
| Full p1-cli / SIGTERM test | Not run | Explicit HOME constraint and sandbox git-write boundary. |
| Site build / browser observers | Not run | No browser test is allowed on this Mac. Site dependencies are absent: esbuild reported missing `astro/tsconfigs/strict` while still successfully compiling the smoke inputs through root dependencies. No full site-build claim. |
| Server suites | Not run | Deferred to authorized CI/server execution. |

The direct CLI command was:

```sh
node --import tsx --test --test-timeout=30000 tests/p1-cli/admin-recovery.test.ts tests/p1-cli/admin-routine.test.ts tests/p1-cli/admin-protocol-bundle.test.ts tests/p1-cli/citation-drift.test.ts tests/p1-cli/test-gate-coverage.test.ts
```

The timeout selection was:

```text
wake lease release citation|HEAD timeout citations|timeout inventory and mapping|main alias validates|shipped timeout mapping|HEAD mapped lines|runStatus
```

The unchanged-path check was `git diff 8434492c..HEAD` for:

- `tests/p1-cli/timeout-table.test.ts`, `timeout-table-exit-fixture.mjs`;
- `scripts/timeout-table/run.mjs`, `core.mjs`, `enumerate.mjs`, `mapping.mjs`, `writes.cjs`;
- `src/cloud/agent-credential-input.ts`, `agent-check-budget.ts`, `src/listener/types.ts`.

The same paths have no working-tree diff. `mapping.json` was examined separately:
only the three admin timeout entries were added, and `sourceRootForRef`, profile
copying and cleanup do not read it.

## Files and handoff

Tracked files changed by this fold:

- `site/src/components/app/admin-delegations.observer.test.ts`;
- `site/src/components/app/agent-row-geometry.observer.test.ts`;
- this report.

The ignored browser-free smoke script is in `scratchpad/fold-cd6/`.
Excluding this report and ignored support: production/tooling +0/-0 lines;
tests +104/-63 lines. No product/grant-contract behavior changed and no server
case was added. Existing fold-5 source and SQL changes remain pending verification.

Still needing an authorized environment:

- Both changed site observers, including cross-document auth notification and
  dump-DOM completion under virtual time. The malformed geometry producer cause
  is still open; do not report the site run green from these static probes.
- The unchanged SIGTERM cleanup case, to establish its actual CI failure cause.
- Existing `tests/p1-server/admin-recovery.test.ts`: human account isolation,
  workspace history, effective expiry and pagination.
- All nine `tests/p1-server/admin-routine.test.ts` scenarios: workspace creation,
  invitations, delivery/renewal/replacement, history, expiry, concurrency, parent
  revocation, rollback and current rights.
- The previously deferred lane-B admin authority/boundary server cases and the
  cross-family check arranged by HezLead.

Status: import repair implemented; geometry reader hardened with producer cause
unresolved; SIGTERM excluded from this lane by source evidence. The complete
assignment and the full local gate are not claimed green.
