# Household integration security fold — 2026-10-04

Base HEAD: `92a215374fa0b742c96218514e48d105534cae5f`.
Branch: `lane/hh-int-packet`. No commit, push, workflow dispatch or deployment.

| Finding | Fix | Test |
| --- | --- | --- |
| A boundary row redirects `FILE_COMMAND_KINDS` into the incomplete adapter. | `SWARM_HOUSEHOLD_LEGACY_FILE_REDIRECT` must be exactly `1` before the redirect is considered; a boundary is still required. OFF retains ordinary file handling. | Real command HTTP entry with valid human/membership/boundary: OFF/unset/`0`/`true` and client flags never reach the adapter; a valid download reaches the ordinary handler. Exact ON reaches an adapter-entry spy; ON without a boundary does not. |
| `household_legacy` is available from boundary creation alone. | Separate `SWARM_HOUSEHOLD_LEGACY_COMMAND` gate; OFF returns HTTP 403 `household_legacy_disabled` before adapter dispatch. | Authenticated HTTP request with a boundary is refused when OFF, including when only the redirect gate is ON. Its own exact ON reaches the adapter-entry spy; no boundary still refuses. |
| Hosted `file_upload_begin`, `file_upload_commit`, `file_read` are admitted before protected transport is complete. | Separate `SWARM_HOUSEHOLD_HOSTED_FILE_TRANSPORT` gate filters file-only registry rows out of the hosted table. Argument validation also rejects unavailable tools. OFF advertises 13 tools. | Real MCP `tools/list` excludes each tool and `tools/call` refuses each before execution with OFF/unset/`0`/`true` or only legacy gates ON. A completed object tool executes in the same handler. Exact ON admits all three to an inert executor in tests only. |

All three regressions failed on the base code for their intended reachability
reason (`fold-regression-baseline.txt`, exit 1). The repaired regression run passed
5/5 (`fold-regression-current.txt`, exit 0); final focused coverage passed 80/80.
Fixtures replace auth/database transports and downstream executors; they prove
admission and routing, not working file transport, PostgreSQL authorization or
legacy parity. The gates are server-owned, frozen at worker startup and OFF unless
their exact environment value is `1`. Requests and consent rows cannot enable them.

## Changed files

| File | Why |
| --- | --- |
| `supabase/functions/_shared/household-feature-gates.ts` (new) | Three independent default-OFF server gate definitions. |
| `supabase/functions/command/index.ts` | Gate the legacy redirect and explicit legacy command separately. |
| `supabase/functions/mcp/tools.ts` | Exclude unfinished hosted file tools from discovery/admission and reject unavailable validation. |
| `tests/household-feature-gates.test.ts` (new) | Three owner-boundary regressions with OFF/ON, client-input, independent-gate and boundary controls. |
| `tests/household-integration.test.ts` | Remove an assertion requiring an unfinished tool to be admitted by default. |
| `tests/hosted-mcp-protocol.test.ts` | Correct default discovery count from 16 to 13. |
| `tests/lists/test.txt` | Add only the new `tests/household-feature-gates.test.ts`; no other list edits. |
| `LEAD-CHECKLIST.md`, `FILES.md`, `WORKER-REPORT.md` in this directory | Record each gate's prerequisites, updated inventory and this superseding report. |
| `FOLD-REPORT.md` and `fold-*.txt` in this directory (new) | Retain fold report and measured verification output. |

Production: 30 added / 2 removed lines (including the new server module).
Tests/test routing: 179 added / 3 removed lines (including the new test file).
Protocol generation was rerun; generated artifacts have no diff.
OAuth/scope changes: none. No migration, permission grants, site or CLI code changed.

## Gate exit codes

Each required command ran directly under `env HOME="$T"` after
`T=$(mktemp -d /private/tmp/lane-home.XXXXXX)`. The shell HOME was not assigned.

| Gate | Final exit | Evidence |
| --- | ---: | --- |
| `npm run build:command-core` | 0 | `fold-build-command-core.txt` |
| `npm run build` | 0 | `fold-build.txt` |
| `npm run check:edge` | 0 | `fold-check-edge.txt` |
| `npm run check:tests` | 2 | `fold-check-tests.txt`: exactly the same eight diagnostic lines as both recorded baseline/current packet outputs. |
| Focused Node tests below | 0 | `fold-focused-tests.txt`: 80 passed, zero failures/skips. |
| `git diff --check` | 0 | Local whitespace check. |

```sh
env HOME="$T" node --import tsx --test \
  tests/household-feature-gates.test.ts tests/household-integration.test.ts \
  tests/hosted-mcp-protocol.test.ts tests/admin-command-entry.test.ts \
  tests/household-tool-registry.test.ts tests/household-legacy-adapter.test.ts \
  tests/p1-cli/household-integration.test.ts site/src/lib/household-dashboard.test.mjs
```

## Remaining work for the Lead

Keep all three gates unset or `0`. Complete legacy adoption/parity and protected
file delivery before activation; `LEAD-CHECKLIST.md` names each prerequisite.
Default-OFF file redirects retain the existing ordinary file policy, so these
fixes do not prove household permissions across legacy routes. Close C1 conflicts,
arrange the independent security check, and run server/site suites and SQL proofs
in CI later. No cross-family review or full suites were run by this worker.
The existing eight test type-check diagnostics remain outside this fold's scope.
