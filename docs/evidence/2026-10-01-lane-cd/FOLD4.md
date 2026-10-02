# Lane C+D fold 4 — 2026-10-01

Base: `2ccb6640`, branch `lane/cd-admin-integ`. Main `8434492c` is an
ancestor. The initial worktree was clean. Changes are uncommitted; no push,
Actions dispatch, server suite, browser, GUI, keychain, secret retrieval,
migration application, or production operation occurred. HezLead owns the
independent check and any authorized CI execution.

| Test | Cause with file:line | Fix / evidence |
|---|---|---|
| p1-cli #565, file client citations | `src/cloud/files.ts:26` cited `read/index.ts:40`, which is now a comment; the warning declaration is at `supabase/functions/read/index.ts:41`. | Update the citation without shifting client lines. The named regression failed before and passed after; the full file passed all 41 tests. |
| p1-cli #1055, command build ownership | `src/cloud/admin-delegations.ts:39` constructed the revoke envelope without the build helper. | Wrap the envelope with `withClientBuild`; retain the exact constructor inventory and add its new member in `tests/p1-cli/presence-client.test.ts:97`. The regression failed before and passed after. Add a wire assertion for the canonical build to the existing admin recovery case. |
| p1-cli #1334 / #1335, HEAD and main timeout inventories | `scripts/timeout-table/mapping.json:3395` lacked the site read timeout and the CLI read/revoke timeouts. `main` aliases HEAD. | Enumerate actual sources with the existing enumerator and add exactly those three rows, with actual source-line citations. Both named regressions failed before and passed after. Historical `v0.1.71` bytes remain unchanged. |
| p1-cli #1360, origin writes / unacknowledged rows | `scripts/timeout-table/run.mjs:291` validates the same incomplete map before the loopback test can measure anything. | The three new rows are `not-run`: the probe has a worker profile, not a human account session, and cannot safely read private recovery metadata or revoke a grant. Pure checks prove each stays NOT RUN even with timing samples, with a same-invocation positive control that becomes NOT MEASURED. The full runTable case was not run because its measurement children change HOME. |
| p1-cli #1363, KNOWN_FLAGS | `src/cli.ts:652` lacked `before` and `grant-id`, now advertised by the admin commands. | Register both, update the exact historical-exception inventory, and require both bare admin flags to report a missing value. No assertion was dropped without replacement coverage. The named flag test passes. |
| site #72, inert labels / uncertain revoke | `site/src/lib/admin-delegations.ts:33` threw a generic error on 5xx instead of the shared uncertain-outcome class; the old next line also required `ok: true`, absent from the real accepted receipt at `supabase/functions/command/admin-delegation.ts:403`. Labels already passed through `textContent` at `site/src/components/app/AdminDelegations.astro:55`; no HTML insertion was found. | Use `CommandOutcomeUnknown` for 5xx, missing/unreadable accepted receipts, and the existing shared network-failure path. Accept the backend's `status: accepted` receipt without a fabricated `ok` field. Tighten the browser fixture to that receipt; retain every hostile-label and same-request assertion. The UI retains request IDs unless refusal is definite (`AdminDelegations.astro:74,85`). Source inspection and the bundled module smoke pass; the browser observer is deferred, so the original r2 browser failure's exact trigger and final browser result are not claimed. |

Every executed gate ran inside the supplied workspace sandbox, with HOME
unchanged. The user's explicit prohibition overrides base-cd.txt's `env HOME`
commands. No live secret was staged, so no secret directory required cleanup.
The installed guarded rm handled the build's prebuild deletion without refusal.

| Gate | Exit | Measured result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build and executable CLI. |
| `npm run check:edge` | 0 | All seven configured entry points. |
| `npm run check:tests` | 0 | Passed, including the final flag-test edit. |
| Direct `file-create-rate-limit.test.ts` | 0 | 41 tests. |
| Direct `presence-client.test.ts` | 0 | 6 tests. |
| Direct `admin-recovery.test.ts` | 0 | 5 tests. |
| Direct `citation-drift.test.ts` | 0 | 5 tests. |
| Direct `unknown-flag-message.test.ts`, full file | 1 | 7 passed; two identity tests failed on sandbox `listen EPERM 127.0.0.1`. |
| Direct `unknown-flag-message.test.ts`, three flag regressions | 0 | Unknown flag, missing real value, and KNOWN_FLAGS cases passed; final KNOWN_FLAGS-only rerun also passed. |
| Direct `timeout-table.test.ts`, selected safe cases | 0 | 8 cases: release citation, HEAD operation citations, exact inventories, main alias, MCP timer citation, historical bytes, HEAD mapped lines, and runStatus acknowledgement controls. |
| Pure admin timeout classification control | 0 | HEAD/main reconciliation; exactly three admin bounds; NOT RUN and NOT MEASURED controls. |
| Site module smoke, in-memory esbuild bundle and mocked fetch | 0 | Typed 502/network/null/unreadable uncertainty; real accepted receipt; definite 403 refusal; unchanged account request ID; no workspace substitution. Component script separately bundled; text-only label path inspected. |
| `git diff --check` | 0 | Passed. |
| `npm test` | Not run | Includes child-process HOME overrides (`tests/p1-cli/release-bundle.test.ts:42`, `tests/box-dry-run.test.ts:2167`). |
| Full timeout file / runTable case | Not run | Measurement and cleanup fixtures change child HOME (`tests/p1-cli/timeout-table.test.ts:816`; `scripts/timeout-table/run.mjs` measurement environment). |
| Site browser observer | Not run | Requires bundled Chromium; task says to reason from code when a browser is needed. |
| Server suites | Not run | Explicitly deferred to authorized CI/server execution. |

The timeout selection was:

```text
timeout inventory and mapping|main alias validates|HEAD timeout|wake lease release citation|MCP register abort-timer citation|shipped timeout mapping|rowSummary|summarize|runStatus
```

`node --import tsx --test` ran each named file directly; whole-file CLI
invocations also supplied `--test-timeout=30000`. No required gate was piped.

Files changed:

- `src/cloud/files.ts`
- `src/cloud/admin-delegations.ts`
- `src/cli.ts`
- `scripts/timeout-table/mapping.json`
- `site/src/lib/admin-delegations.ts`
- `site/src/components/app/AdminDelegations.astro`
- `site/src/components/app/admin-delegations.observer.test.ts`
- `tests/p1-cli/admin-recovery.test.ts`
- `tests/p1-cli/presence-client.test.ts`
- `tests/p1-cli/unknown-flag-message.test.ts`
- `docs/evidence/2026-10-01-lane-cd/FOLD4.md`

Excluding this report: production/tooling +60/-8 lines; tests +10/-4 lines.

No new server cases or grant-contract departures. Existing server verification
remains pending: `admin-recovery.test.ts` account isolation, workspace history,
effective expiry and pagination; all nine `admin-routine.test.ts` scenarios
(workspace, invites, renewal, history, expiry, concurrency, parent, rollback,
rights); and the lane-B admin authority/boundary scenarios previously deferred.
The full local gate is not green. The site browser observer, runTable case, and
two socket-dependent flag-file tests still need an authorized environment.
