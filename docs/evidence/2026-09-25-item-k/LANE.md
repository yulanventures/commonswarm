# Item K lane evidence — 2026-09-25

Base: `origin/main` at `d437c29158d97c85f463ec6209160f5293e8944b`. This lane did not contact a production host or workspace. All direct CLI invocations in this lane used a loopback `--url`. The local server test was written for the lead; it was not run here and no migration was applied.

| Ruling | Change and test | Measured mutation | Not established |
|---|---|---|---|
| Help comes from the command table — **superseded by Fold 2** | `usage()` and scoped `--help` render each visible table entry, variant synopsis, description, and table flags. The earlier `receive configure` sentence did not disclose that `session` help wrongly used the receive constants. The earlier test compared generated output to the table and missed that error. | Replaced rendered `--since` with `--missing`: command-table gate exit 1, 11/12 passed, 1 failed in the earlier lane run. | The earlier drift and enum claims are superseded below. |
| Profile inventory is local and credential-free — **superseded by Fold 2** | The original walk found profiles under `agentProfileRoot()` and did not open credentials. The earlier parse-error claim was false when `--url` filtered that row out. | Disabled the directory walk: profile test exit 1, 0/1 passed. | The old walk missed explicit paths outside the shared root. Fold 2 records the writer's paths. |
| Invalid path gives a usable remedy — **superseded by Fold 2** | `privatePath()` had the generated example and `cswarm profile ls`, but the MCP error map replaced it with fixed text. | Removed the `profile ls` remedy: profile test exit 1, 0/1 passed in the earlier lane run. | Fold 2 checks the MCP-visible text. |
| `inbox --since` drains matching agent pages — **superseded by Fold 2** | The old pure 101-row test covered one pagination path. The earlier local-edge test used only 51 rows and was not run. | Changed the page-end condition to stop at 100: pure test exit 1, 0/1 passed in the earlier lane run. | The old claim about the original mismatch was an unmeasured inference. Fold 2 adds a local-edge comparison; the lead still needs to run it. |

## Verification

| Gate | Exit | Count / observation |
|---|---:|---|
| `npm run build` | 0 | Resumed changes compile. |
| `npm run check:tests` | 0 | Resumed test TypeScript check completed. |
| Five focused P1 CLI lane files, serial with temporary `HOME` | 0 | 24/24 passed, including all generated help, profile, inbox pagination, citation, and permissions checks. |
| Dispatcher baseline file, focused name pattern with temporary `HOME` | 0 | 2/2 passed; the full 1,330-row behavior baseline is left for the lead's gate. |
| Combined parallel P1 CLI lane run | 130 | Interrupted after contention caused the per-command help subprocess to time out. The same help gate passed alone and in the later serial run. |
| Local-edge `inbox-since-check.test.ts` | not run | Prepared for the lead on an exclusive local stack; no migration was applied here. |
| Full suites, edge check, release bundle, site build | not run | Reserved for the lead per this lane's rules. |
| `pgrep -fl 'supabase functions serve|dist/cli.js|tests/p1-cli|tests/p1-server'` | 3 | The sandbox's sysmon service is unavailable, so process enumeration could not establish liveness. Focused test commands returned and their temporary HOME directories were removed. |

The original worktree Git metadata path disappeared during verification, along with the parent checkout. To retain this lane's files and commits, I cloned `yulanventures/commonswarm` at the same `d437c291` base into `/tmp/item-k-recovery`, then used that Git directory with this worktree as its work tree. A task-local `git` wrapper points Git calls from this lane at the recovered repository; other directories still use system Git. This is a local recovery, not a push or merge. The original brief commit was re-created in the recovered history.

## Fold 2 — round 1 review repairs

The review inputs were `scratchpad/itemK/codex-r1.md` and `scratchpad/itemK/opus-r1.md`, read in full. Each mutation below changed one source or fixture anchor, ran only the named lane test under a fresh `/tmp/lane-home.*` HOME, observed exit 1 with one failed focused test, and restored the file. The unmutated focused CLI run passed 23/23 before the final time-cap boundary adjustment. No production host or real workspace was contacted.

| Ruling | Change and focused test | Measured reverted behavior |
|---|---|---|
| JJ1 | `helpFlag` chooses `SESSION_MODES`/`SESSION_PROVIDERS` for session entries and receive constants for `receive.configure`; session synopsis again names required flags. `each enumerated help flag uses its command's enforcement parser` parses rendered values and an unrendered value in process. | Disabled the session-key enumeration: 0/1 passed. |
| JJ2 | `saveAgentProfile` records each written absolute path in a 0600 registry under the shared root. `profile ls finds walked and registered paths without opening credentials` covers an explicit path, a missing registered file, and absent credential file. | Ignored registry paths: 0/1 passed. |
| JJ3 | `rendered flags exactly match in-process command parser acceptance` enumerates visible verbs/actions and candidate flags from every entry, then checks exact rendered flag tokens against `parseCommandOptions`; no subprocess sweep. The other table test checks exact flag tokens too. | Refused the parser's entry flags: 0/1 passed. |
| JJ4 | Listen route and channel purpose help interpolate `listenerRouteUsage()` and `CHANNEL_PURPOSE_MAX`; `route and purpose guidance reads enforcement constants` checks both source linkage and output. | Replaced route interpolation with `main`: 0/1 passed. |
| JJ5 | Inbox `--since` and `--limit` guidance has its own heading before credential selection. `inbox guidance has its own heading before credential selection` checks placement. | Removed the heading: 0/1 passed. |
| JJ6 | `profile ls --url` validates the URL but does not filter damaged profiles. Directory walk reports unreadable paths and continues. MCP `profile_path_invalid` uses `profilePathRemedy()`. The profile test checks the damaged row, typed bad URL, unreadable directory, continued walk, and generated MCP example. | Restored URL filtering, accepted a bad URL, skipped an unreadable directory, and restored fixed MCP text in separate probes: each 0/1 passed. |
| JJ7 | `checkedSince` refuses timestamps without an offset with a typed error and one example constant; agent inbox validates the selected workspace identity with a typed error. The local-edge test now creates 101 directed asks and compares the former newest-50 read with the paged CLI result, plus naive timestamp and wrong workspace refusals. Pure tests cover both refusals. | Allowed a naive timestamp: 0/1 passed. Reversed the workspace comparison: 0/1 passed. The local-edge comparison remains unrun by this lane. |
| JJ8 | `readDirectedInboxSince` uses typed paging errors, ten-page and 20-second caps, and a generated `--since <last>` continuation notice. Pure tests cover cap, time boundary, and typed refusal. | Read an eleventh page, removed the time cap, and threw a generic paging error in separate probes: each 0/1 passed. |
| JJ9 | The profile verb joins the dispatcher baseline coverage, including missing action, unknown action, and `--profile` refusal. `profile dispatcher baseline covers listing and refusal routes` passed 4 paths. | Changed missing-action refusal into listing: 0/1 passed. |
| JJ10 | The lane tests share `createLaneTempHome`/`removeLaneTempHome`; deletion accepts only a path created by that helper under `/tmp`, and refuses `/`, the real home, and paths outside the temporary root. `temporary home cleanup refuses outside paths` is the control. | Returned a path the helper had not created: 0/1 passed. |

The server test has **not** measured the mismatch yet. Its expected comparison is an assertion for the lead to verify on an exclusive local stack: after 101 directed asks, the former newest-50 path omits the oldest ask while paged `inbox --since` returns it. Until that run succeeds, the cause is an inference from the client and read-edge code, not a measured local-edge result. The field report's original conditions are also not established. The full dispatcher baseline, released bundle, edge check, site build, and full suites remain with the lead.

Fold 2 clean verification: `npm run build` exit 0; `npm run check:tests` exit 0; the three focused P1 CLI files passed 23/23 with `env HOME="$T"`; the focused dispatcher baseline passed 3/3 in the same form. Sixteen mutation probes exited 1 with the intended focused test failing (JJ6 and JJ8 each had additional probes). `git diff --check` passed before commits. Process enumeration via `pgrep` returned `sysmon request failed ... sysmond service not found`, so this sandbox did not establish a process-list control; the focused test commands returned, and their temporary homes were removed.
