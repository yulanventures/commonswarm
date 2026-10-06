# Household packet — Fold 2

Branch `lane/hh-int-packet`; base HEAD `92a215374fa0b742c96218514e48d105534cae5f`.
Fold 1 is retained. No commit, push, workflow dispatch, deployment, OAuth scope,
migration or privilege-allowlist change. HezLead owns the independent check.

| Group | Cause | Fix |
| --- | --- | --- |
| Dispatcher baselines (80 repeated CI failures include this group) | Recorded fixtures predate household command help, policies and selectors. | Extend the existing fixture generator and run `UPDATE_DISPATCH_BASELINE=help`. Add 65 household rows; all 1,403 existing rows retain argv, exit code, handler trace and output after removing only household help/guidance. All eight shards pass. |
| Citation drift | Household imports/dispatch and the credential guidance moved CLI and edge lines. | Refresh citation table, actual citing comments, cap frontmatter, wake-release slice and HEAD timeout mapping. Citation/cap/timeout tests pass; release-ref mapping stays unchanged. |
| Tool/command/flag inventories | Eight household CLI routes and five default-on hosted tools were missing from the relevant inventories. The help AST enumerator ignored a registry spread. | Add source-owned household kinds and routes, reconcile 47 profile rows, recognize `input-file`, document object credential forms, and account for registry-generated help. Default hosted discovery remains 13 tools; the three gated file tools remain unavailable. |
| DCR tool exercise | The script demanded the old eight-tool catalog and did not understand structured object schemas. | Extend its closed inventory/schema validator and exercise create/list/read/update/history against synthetic dependencies. Use `revision.revision` as the update base. Twenty calls cover every default-on hosted tool; all four fail-closed scenarios pass. This proves the exercise transport and arguments, not PostgreSQL household permissions. |
| Client build inventory | New household HTTP envelopes omitted `client_build` and incorrectly used package `0.1.80` as the protocol version. | Wrap mutations with `withClientBuild` and use protocol `0.1.0`. Extend the existing wire test; it fails on the old transport for the wrong version and passes on the fix. |
| Server: issuer ACL | CI reported ZX001: the old negative INSERT probe now succeeds under M5. Its role-column and single-column lock probes also assumed pre-M5 privileges. | Positive INSERT/allowed consent UPDATE controls; deny protected identity/purpose columns; revoke all allowed UPDATE columns for the lock negative; use DELETE and broader/unapproved ACL mutations as widening probes. No grants were widened by this fold. Real database validation remains required. |
| Server: CIMD | CI log measured 16 tools before Fold 1 against expected 8. | Pin the exact reviewed default-on 13-name set after Fold 1. |
| Server: DCR | Same stale discovery count as CIMD. | Use the same exact name assertion, including exclusion of unfinished file transport. |
| Server: hosted OAuth parent | Parent failure records its two failed CIMD/DCR subtests. | The two discovery assertions above address that parent failure; there is no separate OAuth-flow failure in the recorded run. |

Server causes were checked in existing CI run `37179749082` for this exact SHA.
No CI run was started or re-run.

## Gate exits

Every required invocation used `T=$(mktemp -d /private/tmp/lane-home.XXXXXX)`
and ran directly through `env HOME="$T"`; the shell HOME was never assigned.

| Gate | Exit | Evidence / limit |
| --- | ---: | --- |
| `npm run build:command-core` | 0 | `fold2-build-command-core.txt`; generated artifacts have no diff. |
| `npm run build` | 0 | `fold2-build.txt` |
| `npm run check:edge` | 0 | `fold2-check-edge.txt` |
| `npm run check:tests` | 2 | `fold2-check-tests.txt`; exactly the same eight diagnostic lines as Fold 1, zero added. |
| Named focused files | 0 | `fold2-focused-tests.txt`: 273/273 pass. |
| Dispatcher main and all seven shard wrappers | 0 | `fold2-dispatch-tests.txt`: 88/88 pass. |
| `unknown-flag-message.test.ts` | 0 | Eight runnable tests pass. The ninth, `whoami trusts ... keeps the token out of ps`, was first attempted and failed with `spawnSync ps EPERM`; excluded only from the subsequent passing run. Host policy forbids `ps`; it remains CI work. |
| Focused site observers | 0 | `fold2-site-focused.txt`: 8/8 pass. No browser or full site suite. |
| Final touched-file recheck | 0 | `fold2-final-touched-tests.txt`: 44/44 pass after the nested-revision correction and mapping formatting cleanup. |
| `bash scripts/build-release.sh` | 0 | `fold2-build-release.txt`: standalone CLI executes and reports 0.1.80. |
| Baseline generator / semantic audit | 0 / 0 | `fold2-generate-baseline.txt`, `fold2-baseline-audit.txt`; no fixture hand edits. |
| Pre-fix wire regression control | 1 (expected) | `fold2-wire-regression-baseline.txt`; original source restored byte-for-byte before current checks. |
| Named issuer server file | 1 (blocked) | `fold2-admin-server.txt`: installed Docker guard says Docker is disabled on this Mac. |
| Named OAuth server file | 1 (blocked) | `fold2-oauth-server.txt`: local `pg` dependency absent; a real migrated CI stack is also required and Docker is disabled. Syntax check passes. |
| `git diff --check` | 0 | Whitespace check. |

No full suite ran. The eight existing type diagnostics, real server/SQL proof,
`ps` boundary test and HezLead's cross-family check remain open. Keep all three
Fold 1 activation gates unset or `0` until its documented prerequisites close.
This fold adds no test files and no test-list entries.

## Files changed in Fold 2

The following 24 code, tooling and existing-test paths are incremental to the
working tree received after Fold 1:

| File | Reason |
| --- | --- |
| `scripts/dcr-roundtrip.mjs` | Extend the reviewed live-tool inventory and exercise structured object tools; validate oneOf, const and numeric schemas; read the real nested revision reference. |
| `scripts/timeout-table/mapping.json` | Refresh eight HEAD CLI citations; preserve release-ref values and formatting. |
| `services/mcp-auth/test-postgres/oauth-mcp-contract.test.js` | Pin all 13 default-on tool names for CIMD and DCR; exclude gated file transport. |
| `site/src/components/connect/agent-connect-mint.observer.test.ts` | Refresh command-edge citations in comments and assertion descriptions. |
| `site/src/lib/agent-connect.ts` | Refresh mint/device/replay citations; no browser behavior change. |
| `site/src/pages/acceptable-use.astro` | Refresh enforcement pointers in frontmatter; no legal prose change. |
| `src/cli.ts` | Recognize input-file, export the household accepted-flag constant in the existing pattern, document object credential forms. |
| `src/cloud/files.ts` | Refresh the read-edge warning citation. |
| `src/cloud/household-http.ts` | Send CLIENT_PROTOCOL_VERSION and withClientBuild metadata separately. |
| `supabase/functions/command/index.ts` | Refresh one resume-preflight citation; preserve Fold 1 routing gates. |
| `tests/hosted-mcp-errors.test.ts` | Update the safe unknown-tool correction to include five default-on object tools. |
| `tests/p1-cli/citation-drift.test.ts` | Refresh 18 checked source ranges. |
| `tests/p1-cli/command-dispatch-baseline.test.ts` | Register household command policies/refusals/profile variants and canonical fixtures; extend the existing help generator. |
| `tests/p1-cli/command-table-gates.test.ts` | Include registry-generated household help rows in the handler-constant inventory. |
| `tests/p1-cli/dcr-exercise-tools.test.ts` | Reconcile 20 calls, check the nested read revision becomes the update base, and exclude gated file calls. |
| `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json` | Generated totals: 1468 rows. |
| `tests/p1-cli/fixtures/command-dispatch-baseline.json` | Generated household help and 65 new household rows; existing behavior retained. |
| `tests/p1-cli/household-integration.test.ts` | Check protocol/build metadata at the HTTP request boundary. |
| `tests/p1-cli/item-i-profile-binding.test.ts` | Reconcile 47 accepting rows, including eight household routes. |
| `tests/p1-cli/presence-client.test.ts` | Include the new household command-envelope producer. |
| `tests/p1-cli/timeout-table.test.ts` | Refresh wake release citation and checked slice. |
| `tests/p1-server/admin-issuer-privileges.test.ts` | Reflect M5 INSERT and consent-column UPDATE permissions; retain protected-column, lock-revocation and ACL-widening controls. |
| `tests/protocol-workspace.test.ts` | Include HOUSEHOLD_SURFACE_KINDS from its dispatch source; retain the synthetic unfenced-kind mutation control. |
| `tests/support/dcr-exercise-fixture.ts` | Add synthetic structured object responses with the server read projection shape. |

Report indexes updated: `FILES.md`, `LEAD-CHECKLIST.md`, `WORKER-REPORT.md` in this
directory. New report: `FOLD2-REPORT.md`. New verification artifacts: all 15
`fold2-*.txt` files in this directory (the 14 captured logs above plus the baseline
audit). Fold 1-only edits and evidence remain in place; this list does not claim
that Fold 1 files were created by Fold 2.
