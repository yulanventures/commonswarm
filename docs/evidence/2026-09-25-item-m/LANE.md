# Item M lane: crash-safe MCP connect (2026-09-25)

The original sections below record historical lane states. Fold 14 at the end is the current client rule; earlier credential deletion, mode, fresh-register escape, revocation-advice, and completed-profile rows are superseded where marked.

Branch `lane/item-m`. Client commit `df609b6a`; test commit `fa2768aa`. Base brief: `docs/design/2026-09-25-ITEM-M-CRASH-SAFE-CONNECT-BRIEF.md`. No server, migration, or production change. No production host was contacted. Every register test used an injected fetcher or a loopback HTTP server and a temporary profile directory.

## Decisions → change → test → mutation

| Decision | Change | Test | Mutation result |
|---|---|---|---|
| Keep a retry identity before POST without storing a code or token | `connect-pending.json` holds a random attempt ID, target URL, name, creation time, and HMAC-SHA256 keyed by the attempt ID. Secure storage writes it as 0600 under a 0700 directory before register. | `a committed save failure resumes one seat...` reads the pending record during the fake POST, checks its mode and absence of secret prefixes, then recovers one seat. | Replaced the POST's persisted attempt ID with `randomUUID()`: focused test exit 1, 0 pass / 1 fail. Reverted the whole client implementation to `origin/main`: this test exit 1, 0/1. |
| Retry the same seat after lost response or process death | Resume prompts for the code, verifies the HMAC, posts the stored attempt ID, then deletes pending after credential and profile are saved. | Save failure, truncated response, and killed child tests each observe two POSTs with one attempt/seat, a valid profile, and no pending record. | With the client reverted to `origin/main`, each of the three tests exited 1 with 0 pass / 1 fail. The restored client passed all three. |
| Recover both file-write crash windows — superseded by Fold 5 I1 and Fold 14 WW2 | A pending record permits an orphan `credential.json` only; `saveAgentProfile` still refuses an existing profile while allowing that orphan to be replaced. A completed profile beside pending is validated and pending is cleared without another POST. Fold 14 requires the private attempt marker to match pending. An empty directory is accepted as fresh. | `orphan credential and completed profile crash windows recover safely`; existing occupied-path test. | Reverted only the orphan exception in `agent-profile.ts`: focused test exit 1, 0/1. Reverted the whole client: focused test exit 1, 0/1. |
| Refuse another code, used token, or expired recovery — superseded by Fold 5 I2/I4 | A different code stops before POST with revoke and named `rm -- <pending path>` advice. Used-token and expired/invalid retries leave pending for the operator; elapsed one-hour pending records stop before POST. | `a different code is refused...`; `used and expired retries...` (typed codes, no profile writes, pending remains). | Disabled the code comparison: mismatch test exit 1, 0/1. Disabled the elapsed-hour check: used/expired test exit 1, 0/1. Whole-client revert: each test exit 1, 0/1. |
| Preserve fail-closed UI and bounded register — advice superseded by Fold 5 I2 | TTY gate and hidden prompt remain. The unknown-outcome sentence directs a retry with the same command and code, then revocation if recovery fails. Register is still a single no-redirect POST per invocation with a 10-second abort timer. Timeout citations moved with the source. | `mcp-connect.test.ts` 28/28; `timeout-table.test.ts` 18/18. Existing tests cover CLI argument refusal, hidden input, path-only output, and redirects. | Whole-client revert made the six new recovery tests fail individually. The real server test below has no measured mutation yet. |
| Use the existing server retry path | No server change. `registerAgentSeat` selects the existing `(join_credential_id, attempt_id)` row before the seat-cap check and calls `replaceUnusedRegistrationToken`, which revokes the unused token and returns a new one for the same principal/run. | Added `lost register response recovers one seat...` in `tests/p1-server/agent-join-credential.test.ts`: one-seat code, same attempt, fresh token, old token revoked, one attempt/seat. | **Reasoned, not measured:** removing the existing-attempt replacement would reach the one-seat cap and return 409 instead of the test's required 200. The lead must run this on the local stack and measure the mutation. |

The baseline client mutation used a temporary source replacement and restored the working tree in `finally`. Its six new-test invocations each exited 1 with one failure. The four targeted mutations likewise restored their source in `finally`. After restoration the focused MCP suite passed 28/28. No join code or token value is in this record.

## Gates

| Gate | Exit | Count / result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build completed; 0 tests. |
| `env -u FORCE_COLOR npm test` | 1 | 990 total; 988 pass, 2 fail. Both failures are existing resume tests denied `ps` spawning by sandbox `EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 124 | Bounded rerun was killed as a process group after 120 seconds; no final TAP count. The first run was interrupted after a longer stall (exit 1); output included sandbox `spawn EPERM` failures. One source-line citation failure found in that run was fixed and its 18-test suite passed. |
| `npm run check:tests` | 0 | Type-check completed; 0 tests. |
| `npm run check:edge` | 0 | Six entry points checked; 0 tests. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | One bundle regenerated; 0 generated diff. |
| `bash scripts/build-release.sh` | 0 | One single-file CLI built and executed successfully. |
| `npm --prefix site run build` | 1 | Build stopped before pages: sandbox `EPERM` unlinking `site/node_modules/.vite/deps/_metadata.json`. |
| `git diff --check origin/main...HEAD` | 0 | 0 whitespace errors after code and test commits. |
| Focused `mcp-connect.test.ts` | 0 | 28/28 pass. |
| Focused `timeout-table.test.ts` | 0 | 18/18 pass. |

## Not established

- The new real-server test, its server mutation, and the full server suite have not run; the lead owns the local-stack run. The server conclusion above comes from source inspection and existing server tests only.
- The complete CLI suite has no final count because the bounded run timed out. The full `npm test` result is not green in this sandbox. The site build is not established because Vite could not unlink its cache file here.
- No production behavior, release, or cross-host recovery was tested. Recovery after the code's one-hour expiry remains an operator revoke and fresh code.
- `pgrep` could not inspect processes in this sandbox (`sysmond service not found`, exit 3). The killed-child test awaited its child exit, loopback servers were closed, and the timed-out CLI gate's process group was killed.

## Fold 1 — Opus round 1 FAIL, Grok round 1 PASS with rigour notes

At `501927bb`, the lead measured the real local-stack `test:p1-server` gate at 262/262 (including the new retry test), `npm test` at 990/990, `test:p1-cli` at 1003/1003, and every other requested gate at exit 0. Those are **pre-fold** measurements. This fold changed only the client, CLI, tests, timeout citation, and this evidence record; no server or migration changed. No production host or real workspace was contacted.

| Ruling | Fold 1 change | Focused test and measured revert |
|---|---|---|
| V1 | A no-`--profile` connect prompts once, scans the default connect base for the same URL, and selects the pending HMAC matching the typed code. The selected path is named on resume; no other record's contents are printed. | `the printed no-profile command recovers a killed child's one seat by code` kills a child after its register POST, reruns without a profile, and checks one attempt ID, one directory, and one working seat. Replacing selection with no match: exit 1, 0/1. |
| V2 — superseded by Fold 2 X1 and Fold 3 BB1 | This was the Fold 1 behavior. Fresh no-seat refusals remove pending; resumed pre-lookup refusals and `principal_limit_reached` keep it. | The Fold 2 and Fold 3 rows below contain the current tests and mutations. |
| V3 — superseded by Fold 14 WW2 | A completed profile and credential beside pending are validated and cleaned without another POST only when the private marker carries that pending attempt ID. | `completed profile clears old pending without POST` uses a record over two hours old; disabling completed-profile recovery: exit 1, 0/1. Fold 14 tests a foreign profile and this attempt's profile. |
| V4 | Removed the local one-hour refusal. The server decides code expiry. | `a long-lived code reaches the server on retry`; restoring the local hour check: exit 1, 0/1. |
| V5 — superseded by Fold 5 I2 | A resumed `registration_seat_revoked` names the operator's revocation and the clear step. | `revoked retry names the operator action and clear removes orphan credential`; disabling this message branch: exit 1, 0/1. |
| V6 — superseded by Fold 2 X2 and Fold 3 BB4 | This was the Fold 1 behavior. Clear now preserves a credential used by a completed profile and removes only the pending record in that case. | The Fold 2 and Fold 3 rows below contain the current tests and mutations. |
| V7 | Kept the target/name, exact record-shape, and changed-record refusals. | The foreign/malformed and changed-prompt tests fail when each guard is disabled: three mutations, each exit 1, 0/1. |

The nine mutations above were applied one at a time to `src/cloud/mcp-connect.ts`; each focused test had a 30-second process bound, failed once, and the original source was restored in `finally`. The restored MCP and timeout-table files passed together, 54/54. The command-dispatch fixture changed only by replacing the old help line with its documented clear-flag form (337 occurrences). The client does not print a code or token in the killed-child test output.

### Fold 1 gates in this lane

| Gate | Exit and observed count |
|---|---|
| `npm run build` | 0; TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1; 988/990. Two existing resume tests hit sandbox `spawn EPERM` for `ps`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1; 1006/1011. Three process-table checks hit sandbox `ps EPERM`; the read/timeout probes also saw local transport or Node bad-port failures. Focused MCP and timeout tests passed 54/54; the later CLI-clear assertion passed 36/36 in the MCP file. |
| `npm run check:tests` | 0; type-check. |
| `npm run check:edge` | 0; entry-point checks. |
| `npm run build:command-core` and generated bundle diff | 0 and 0; no generated change. |
| `bash scripts/build-release.sh` | 0; single-file CLI built and executed. |
| `npm --prefix site run build` | First run 0; final repeat 1 at Vite cache unlink, sandbox `EPERM` on `site/node_modules/.vite/deps/_metadata.json` (the worktree's `node_modules` is a symlink outside its writable root). |
| `git diff --check origin/main...HEAD` | 0; no whitespace errors. |

The gate runs used a temporary HOME where they could inspect local state. Each bounded child in the new killed-process test was killed or awaited, and each loopback server was closed. `pgrep` could not inspect the sandbox process list (`sysmond service not found`, exit 3).

### Fold 1 not established

- The lead's 262/262 real-server result is from `501927bb`; the lead has not rerun the server suite after this client-only fold. No production or live release behavior was measured.
- The full pure and CLI suites were not green in this sandbox. The focused client checks and the measured mutations establish only the folded client behavior described above.

## Fold 2 — Opus round 2 FAIL rulings

The lead measured `e4022cc8` on the local stack before this fold: `test:p1-server` 262/262, `npm test` 990/990, `test:p1-cli` 1011/1011, and the other requested gates at exit 0. Those measurements are **pre-fold**. Opus's full round-2 review is in `scratchpad/itemM/opus-r2.md`; it measured two production failures. This fold changes only the client, its CLI tests, the timeout citation, and this evidence file. No production host or real workspace was contacted.

The server's `registerAgentSeat` handler can return `forbidden` for an unknown, expired, or revoked code, `invalid_request` for validation, and `upgrade_required` for the version check before its `agent_join_attempts` lookup. The h0 forwarder can return `method_not_allowed` and `payload_too_large`, and the h0 router can return `not_found`, without reaching that lookup. A refusal to the retry therefore does not prove that the earlier request with the same attempt ID created no seat. `principal_limit_reached` is also kept conservatively on a resumed attempt. On a fresh attempt, the existing no-seat handling remains.

| Ruling | Change and test | Measured single-change mutation |
|---|---|---|
| X1 | Resumed no-seat refusals keep pending, say the earlier attempt may have stranded a seat, and name revocation and clearing. `forbidden` names expiry; `upgrade_required` says update and rerun with the same code. The two prior tests that expected deletion were corrected. The test covers each of the seven generated no-seat codes, checks the retained attempt ID, and verifies that a later post-upgrade retry uses it. | Restoring resumed deletion: exit 1, targeted 0/1. |
| X2 — superseded by Fold 5 I1/I2 | Clear requires a pending file and returns `connect_pending_missing` when absent. It checks every file in the directory for a complete profile referring to `credential.json`, including extensionless and host-session-bound profiles, before deleting the credential. It reports success only after removing pending. The test checks a missing directory, a sibling working profile, and a credential left with no pending; the CLI must exit nonzero and never print `files cleared` when blocked. | Disabling the pending requirement: exit 1, 0/1. Disabling the sibling-profile guard: exit 1, 0/1. Disabling host-bound profile recognition: exit 1, 0/1. |
| X3 — superseded by Fold 5 I3/I4 | The default-path scan reports `connect_pending_invalid` with the record path and clear command when an unreadable or damaged record may match. The test covers wrong mode and malformed data and verifies no fresh POST. | Restoring silent skip of damaged pending: exit 1, 0/1. |
| X4 | The default scan test verifies target URL selection and multiple-match refusal; the clear test guards a completed sibling profile. | Removing the URL filter: exit 1, 0/1. Disabling ambiguity refusal: exit 1, 0/1. Disabling the completed-profile guard: exit 1, 0/1. |

Each mutation was applied to `src/cloud/mcp-connect.ts` alone, run with a temporary HOME and a 30-second process bound, then restored in `finally`. The focused MCP file passed 38/38 after the final source change. No test or CLI call used a production URL.

The source edit moved the register abort timer to `src/cloud/mcp-connect.ts:311`. The existing timeout-table citation test caught the old line in the full CLI suite. The mapping now cites 311; its focused test passed 1/1, and restoring the old citation failed that test 0/1.

### Fold 2 gates in this lane

| Gate | Exit and observed count |
|---|---|
| `npm run build` | 0; TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1; 988/990. The real `ps` and resume CLI tests hit sandbox `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | Final rerun: exit 1, 1010/1013; three tests hit sandbox `ps`/`spawn EPERM`. Before the citation repair it was 1009/1013, with the fourth failure catching the stale timer citation. Focused MCP passed 38/38; repaired citation passed 1/1. |
| `npm run check:tests` | 0; type-check. |
| `npm run check:edge` | 0; six edge-runtime entry points checked. |
| `npm run build:command-core` and generated bundle diff | 0 and 0; no generated change. |
| `bash scripts/build-release.sh` | 0; single-file CLI built and executed with loopback `--url`. |
| `npm --prefix site run build` | First run 0, 12 pages. Repeat run 1: sandbox `EPERM` unlinking a Vite cache file in the symlinked `site/node_modules`. |
| `git diff --check origin/main...HEAD` | 0; no whitespace errors. |

### Fold 2 not established

- The lead's 262/262 server result and green 990/990 pure and 1011/1011 CLI suites were measured at `e4022cc8`, before this fold. No server suite was run in this lane because the task forbids applying migrations to the local database and assigns local-stack server verification to the lead.
- The full pure and CLI suites are not green in this sandbox due to `ps` spawn `EPERM`. The repeated site build did not complete due to the Vite cache unlink `EPERM`. `pgrep` could not inspect the process list (`sysmond service not found`, exit 3); the bounded child tests awaited their children, and the completed CLI gate's task log was closed and removed. No production, release, or real-workspace behavior was measured.

## Fold 3 — Opus round 3 PASS with six rigour findings; Grok round 3 FAIL

At `2a387ddd`, before Fold 3, the lead measured `test:p1-server` **262/262**, `npm test` **990/990**, `test:p1-cli` **1013/1013**, and all other requested gates at exit 0 on the local stack. Those are lead measurements at the prior SHA, not Fold 3 results. The Round 3 reviews are `scratchpad/itemM/opus-r3.md` and `scratchpad/itemM/grok-r3.md`. This fold changes the client, its CLI tests, and this evidence. No server, migration, or production change was made.

| Ruling | Fold 3 change | Test | Measured single-change revert |
|---|---|---|---|
| BB1 | A resumed `principal_limit_reached` says the workspace is at its agent limit and no seat exists for this attempt. It keeps pending and directs the user to free a seat and rerun the same command and code. It gives no revocation advice. | The resumed-refusal test checks the retained attempt ID, exact advice, absence of revoke/clear wording, and successful later retry with the same ID. | Removing this message branch: baseline 1/1, revert 0/1, exit 1. |
| BB2 — superseded by Fold 5 I3/I4 | The default scan skips an entry it cannot inspect and emits one stderr notice naming the entry. A regular `mcp-*` file and an unsearchable directory no longer throw raw `ENOTDIR` or `EACCES` or block an unrelated connect. An unreadable base directory gives a typed `connect_state_unavailable` error with `--profile` advice. | `default scan skips inaccessible entries and foreign damaged records` checks both entries, one notice each, a successful fresh POST, and the typed base-directory failure. | Restoring a throw in the entry catch: baseline 1/1, revert 0/1. Restoring a raw base-directory error: baseline 1/1, revert 0/1. Both exit 1. |
| BB3 — superseded by Fold 5 I4 | A safely readable damaged record with a different target URL is excluded. A fully unreadable record permits a fresh POST; if that POST is refused as already used at the join-credential seat cap, the error names the unreadable path, its clear command, and `--profile`. A damaged record naming this target still blocks. | The scan tests cover foreign damaged URL, damaged same-target URL, unreadable JSON, fresh POST, and seat-cap recovery advice. | Removing foreign-URL exclusion: baseline 1/1, revert 0/1. Restoring the unreadable-record block: baseline 1/1, revert 0/1. Both exit 1. |
| BB4 — superseded by Fold 5 I1/I3 | Clear reports a typed `connect_directory_mode` error with `chmod 700` and the clear command for a wrong-mode directory. In a directory with a completed profile, it removes pending while retaining that profile's credential. | `clear gives a typed mode repair and succeeds after chmod`; `clear requires pending and preserves every completed profile's credential` checks function and CLI clear. | Removing the typed mode remedy: baseline 1/1, revert 0/1. Restoring the completed-profile refusal: baseline 1/1, revert 0/1. Both exit 1. |
| BB5 | The recovery sentence uses a lower-case advice fragment: “If recovery fails, ask the operator”. | The resumed `upgrade_required` assertion checks the complete clause and rejects mid-sentence `Ask`. | Restoring the capitalized fragment: baseline 1/1, revert 0/1, exit 1. |
| BB6 | Clear keeps its post-unlink success check. The clear function accepts a file-removal seam so the test can simulate a pending file vanishing between the existence check and unlink. | `clear reports success only when pending was actually removed` checks the typed failure, then checks a successful clear as its positive control. | Removing the post-unlink check: baseline 1/1, revert 0/1, exit 1. |

Each revert changed one source fragment, ran its focused test with a temporary HOME and a 30-second process bound, and restored the source in `finally`. The focused MCP suite then passed **42/42**. The tests use injected fetchers or loopback HTTP and temporary state; no production host or real workspace was contacted.

The full `npm test` and bounded full CLI attempts preceded the final typed base-directory error and shared advice-constant edit. After those edits, `npm run build`, `npm run check:tests`, and the focused MCP suite passed again at 42/42; the edge, generated-bundle, release-bundle, site, and whitespace gates were also rerun.

### Fold 3 gates in this lane

| Gate | Exit and observed count |
|---|---|
| `npm run build` | 0; TypeScript build, 0 tests. |
| `env -u FORCE_COLOR npm test` | 1; 988/990, two existing resume tests failed at sandbox `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | Timed out after 180 seconds, then again after a 300-second bounded rerun; each process group was killed, and neither run produced a final TAP count. |
| `npm run check:tests` | 0; type-check, 0 tests. |
| `npm run check:edge` | 0; six edge entry points checked, 0 tests. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0; one generated bundle, no diff. |
| `bash scripts/build-release.sh` | 0; single-file CLI built and executed with a loopback `--url`. |
| `npm --prefix site run build` | 0; 12 static pages built. |
| `git diff --check origin/main...HEAD` | 0; no whitespace errors at the Fold 3 tip. |

### Fold 3 not established

- The full server suite was not run in this lane; the lead's 262/262 local-stack result is at `2a387ddd`, before Fold 3. No migration was applied.
- The full pure and CLI suites are not green in this sandbox. The pure suite's two failures are sandbox process-spawn `EPERM`; the CLI suite gave no final count before the bounded timeout. The focused MCP suite and its mutations establish the changed client behavior.
- No production, release, or real-workspace behavior was measured.

## Fold 4 — Opus round 4 FAIL rulings

At `4dd43d00`, Opus measured two production advice/recovery defects and a red CLI gate (`scratchpad/itemM/opus-r4.md`). Fold 4 changes only the client, CLI copy, timeout citations, tests, and this evidence. All register probes use injected fetchers or loopback HTTP with temporary state. No production host or real workspace was contacted.

Fold 3 allowed a fresh register POST after finding an unreadable pending record. **That rule is reversed:** if the scan cannot exclude the entered code, it blocks before POST and names the record, repair or clear step, and `--profile <new path>` escape route. An owned, parseable record with a wrong mode is checked by keyed HMAC; a match requires the exact `chmod` repair and then the same command, while a different code is excluded.

| Ruling | Change | Test and measured single-change revert |
|---|---|---|
| CC1 — superseded by Fold 5 I3 | The default scan reads owned, bounded pending content despite a 0644 file or 0755 directory. A matching HMAC blocks with the exact file or directory chmod and same-command retry; a different HMAC is skipped. | `owned pending with a wrong file or directory mode matches by HMAC and resumes after chmod` checks zero POST before repair, a different-code POST, and the original attempt ID on recovery. Disabling the mode-match branch: exit 1, 0/1. |
| CC2 — superseded by Fold 5 I4 | Unreadable or unparseable pending content whose code cannot be excluded blocks before POST, with path, repair or clear instruction, and `--profile <new path>`. | `unparseable pending blocks a fresh connect until cleared` proves zero POST, then a fresh POST after clear. Restoring the fresh-connect `continue` path: exit 1, 0/1. The inaccessible-entry test also asserts zero POST. |
| CC3 — superseded by Fold 5 I1/I2 | Clear returns the validated completed profile path only after its credential principal is checked. The CLI says that profile and credential were kept and nothing needs revoking for that completed connect. With no valid completed profile, revocation advice is conditional on an earlier seat existing. | `clear requires pending and preserves every completed profile's credential` checks both CLI outcomes and a damaged credential. Forcing clear to report no completed profile: rebuilt CLI, exit 1, 0/1. |
| CC4 | Timeout mapping cites the actual abort-timer and stty lines. | The two citation tests each compare the mapped line with source. Restoring each old citation separately: exit 1, 0/1 each. |
| CC5 — superseded by Fold 5 I3 | A wrong-mode directory containing a completed profile but no pending record gets a directory chmod instruction; the scan does not invent an interrupted record or tell the user to clear it. | `completed profile in a wrong-mode directory reports chmod without inventing pending` checks zero POST and exact advice. Disabling the directory-mode branch: exit 1, 0/1. |

All six targeted mutations restored their source after the failed test; the CC3 mutation rebuilt the CLI before and after. The final focused MCP and timeout suites passed 63/63. Each added test has a timeout.

### Fold 4 gates

| Gate | Exit and observed count |
|---|---|
| `npm run build` | 0; TypeScript build, 0 tests. |
| `env -u FORCE_COLOR npm test` | 1; 988/990. The two failures are sandbox `spawn EPERM` in the existing `ps`/resume checks. |
| `env -u FORCE_COLOR npm run test:p1-cli` | Final solo run: exit 1, 1017/1020; three existing `ps`/process-inspection checks failed with sandbox `spawn EPERM`. An earlier run overlapping the pure suite finished 1015/1020 with the same three failures plus two hook timing failures; both timing tests passed in the solo run. |
| `npm run check:tests` | 0; type-check, 0 tests. |
| `npm run check:edge` | 0; six edge entry points checked, 0 tests. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0; generated bundle has no diff. |
| `bash scripts/build-release.sh` | 0; single-file CLI built and executed with loopback `--url`. |
| `npm --prefix site run build` | 0; 12 pages built. |
| `git diff --check origin/main...HEAD` | 0 after the implementation commit; no whitespace errors. |

### Fold 4 not established

- The real-server suite was not run in this lane; the lead owns its local-stack run. No migration was applied.
- The full pure and CLI gates are not green in this sandbox because process inspection is denied with `spawn EPERM`. The final solo CLI run completed with a reconciled TAP count; the focused MCP and timeout suites passed 63/63.
- No production, release, or real-workspace behavior was measured.
- `pgrep` could not inspect processes in this sandbox (`sysmond service not found`, exit 3). The killed-child test awaits its child exit and the loopback servers close.

## Fold 5 — Opus round 5 FAIL rulings

At `5dc5c95c`, Opus found one measured production loss: clear deleted a live credential when only its mode was wrong. Its round-5 report and probes are in `scratchpad/itemM/opus-r5.md` and `scratchpad/itemM/opus-r5-probes/`. This fold changes the client, its local profile writer, CLI copy, tests, and this evidence. No server, migration, production host, or real workspace was touched.

### Current invariants

- **I1 (amended by Fold 6):** The CLI never deletes or moves a credential.json, and replaces one only when the server has just proved its token revoked. A readable pending record, an orphan credential without `profile.json`, a successful retry of that pending attempt, and an equal principal ID in the response and saved credential are all required. The replacement is atomic and private; then the CLI writes `profile.json` and removes pending.
- **I2:** Revoke advice appears only after proof of a stranded seat: a readable pending record whose attempt reached register and no complete profile in that directory holding a seat. No current refusal proves all of those facts, so this fold gives no revoke advice. It reports the measured state and a safe same-attempt or operator-inspection step. A working profile is identified before mismatch advice.
- **I3:** A file or directory mode problem gives the exact `chmod` command and says to rerun the same command. This applies to default and explicit `--profile` paths, records, profiles, credentials, and clear. A mode problem is not called damaged.
- **I4:** A possible record of the entered code blocks a fresh register. An unreadable or damaged possible record never offers `--profile <new path>` as an escape. The default scan may exclude a readable record by its target URL or keyed code HMAC; otherwise it stops before POST.

| Ruling | Change | Focused test | Measured revert |
|---|---|---|---|
| DD1 / I1 — amended by Fold 6 FF1 | Clear unlinks only pending. An orphan credential remains and blocks a later connect at that path with a new-path instruction for a new agent. The identical-token replay assumption in this row is superseded by the server's rotating-token behavior. | `server revoked retry and clear preserve an orphan credential`; `clear keeps a live credential with a wrong mode and repairs the same command`. | Restoring credential deletion in clear: exit 1, 0/1. |
| DD2 / I3 — extended by Fold 6 FF3, FF5 | The explicit path distinguishes a wrong-mode pending file from damaged content, and an owned wrong-mode directory yields `connect_directory_mode` with `chmod 700`. | `explicit record and profile modes get exact repair without a register POST`. | Replacing the typed pending-mode code with invalid: exit 1, 0/1. |
| DD3 / I3 — extended by Fold 6 FF3 | The default scan recognizes an unsearchable directory as a directory mode problem before claiming a pending file exists. It also names wrong-mode profiles without pending as profile mode problems. | `completed profile in a wrong-mode directory reports chmod without inventing pending` checks 0755 and 0000 directories and a 0644 profile, all before POST. | Reverting both directory-mode guards to the round-4 path: exit 1, 0/1. |
| DD4 / I4 — extended by Fold 6 FF2 | Removed the new-path escape from possible-record refusals and from an unreadable default base. | `unparseable pending blocks a fresh connect until cleared` checks zero POST and absence of the escape. | Restoring the escape sentence: exit 1, 0/1. |
| DD5 / I2 | Name or code mismatch beside a complete working profile says the directory holds a working profile and to use a new path for a new agent. Other mismatches ask for the original input or operator inspection. | `working profile rejects another name or code without revocation advice` checks both mismatches and zero POST. | Restoring revoke advice in the working-profile branch: exit 1, 0/1. |

The focused MCP suite passed **47/47** after the changes; MCP plus timeout-table passed **66/66**. Each mutation changed the named source behavior only, ran the targeted test with a 30-second subprocess bound, then restored the source. The tests use injected register fetchers, loopback URLs, and temporary directories. The child-process tests have test timeouts and await their children. The timeout mapping now cites the moved register timer at line 451 and hidden-input deadline at line 93.

### Fold 5 gates

| Gate | Exit | Count / result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build; 0 tests. |
| `env -u FORCE_COLOR npm test` | 1 | 988/990; two existing `ps`/resume checks failed at sandbox `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | Completed in 376 seconds: **1020/1023**, three existing process-inspection checks failed at sandbox `spawn EPERM`. An earlier complete run was 1018/1023 and caught two stale timeout citations; those were repaired before this final run. |
| `npm run check:tests` | 0 | Type-check; 0 tests. |
| `npm run check:edge` | 0 | Six edge entry points checked; 0 tests. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0, 0 | Generated protocol bundle has no diff. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI built and executed with a loopback `--url`; 0 tests. |
| `npm --prefix site run build` | 0 | 12 static pages built; 0 tests. |
| `git diff --check origin/main...HEAD` | 0 | Zero whitespace errors after the code and test commits. |

### Fold 5 not established

- The lead owns local-stack server verification. No migration or server suite ran in this lane.
- The pure and full CLI suites completed but did not turn green in this sandbox because `ps` spawning is denied. No live, release, or production behavior was measured.
- `pgrep` could not inspect the sandbox process list (`sysmond service not found`, exit 3). The bounded mutation children and focused tests exited; the full gate runner completed and no task child was deliberately left running.

## Fold 6 — Opus and Grok round 6 rulings

At `3b26baed`, Opus and Grok independently measured that a retry after a credential-only crash receives a new token from the server but the client discards it. Opus also found three mode/advice defects; Grok found a default-scan mode defect. This fold changes the client, private file writer, CLI tests, and this evidence. It does not change the server or a migration. No production host or real workspace was contacted.

I1 above is amended by FF1. The proof for replacement is a readable pending record for this attempt, an orphan `credential.json` with no `profile.json`, a successful same-attempt server retry, and an equal principal ID in the response and the saved credential. The server's successful retry revokes the unused token. The CLI replaces only then, using a 0600 temporary file, fsync, and rename. It writes the profile and then removes pending. A private completion record lets a later default-path rerun recognize that code and refuse before another register POST. A refusal, unreadable orphan, or principal mismatch leaves the credential and pending record intact.

| Ruling | Change | Focused test | Measured single-change revert |
|---|---|---|---|
| FF1 / I1 — extended by Fold 7 HH1, HH3, HH5, HH7 | Atomic replacement after the server proof; completion record prevents a second default-path POST. | `rotating retry repairs a credential-only crash on explicit and default paths`; `a successful retry for another principal keeps the orphan bytes and pending record`. The fake revokes the old token, mints a new token, and retains one seat for the attempt. | Disabling orphan replacement: exit 1, 0/1. Disabling the completion record: exit 1, 0/1. |
| FF2 / I4 — extended by Fold 7 HH5 | A failed profile validation beside pending names `profile.json` as damaged and gives an exact `mv` of that file only to a UTC-stamped name, followed by the same command. | `a damaged profile beside this code gives a profile-only move step`. | Restoring new-path advice: exit 1, 0/1. |
| FF3 / I3 — narrowed by Fold 7 HH2 | An ancestor mode error names the actual directory, including `~/.cswarm` at 0000, with its `chmod 700` step. | `default scan names a mode-0000 ~/.cswarm directory`. | Disabling the ancestor check: exit 1, 0/1. |
| FF4 — superseded by Fold 7 HH1 | The private JSON writer and exclusive credential writer call `fchmod(0600)` on their open handles before sync. | `umask 0277 still creates mode 0600 pending, credential, profile and completion files`. | Removing exclusive credential fchmod: exit 1, 0/1. |
| FF5 / I3 — extended by Fold 7 HH4 | The default scan classifies wrong modes for a same-URL possible pending record before validating its body or excluding another code. | `default scan repairs modes before calling same-URL malformed pending damaged` covers file 0644 and directory 0755; `owned pending with a wrong file or directory mode matches by HMAC and resumes after chmod` also checks a different code. | Restoring the parse-first mode condition: exit 1, 0/1. |

DD3's unrelated wrong-mode profile behavior remains by design. The focused MCP suite passed **52/52** and the timeout-table suite passed **19/19** after these changes. Each focused test has a timeout. Each of the six final mutation probes ran its positive control in the same invocation: baseline exit 0, 1/1; revert exit 1, 0/1. Each was bounded to 30 seconds and restored the original source byte-for-byte in `finally`.

### Fold 6 gates

| Gate | Exit | Count / result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build; 0 tests. |
| `env -u FORCE_COLOR npm test` | 1 | **988/990**; two existing `ps`/resume checks hit sandbox `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | Completed: **1025/1028**; three existing process-inspection checks hit sandbox `spawn EPERM`. No other failures. |
| `npm run check:tests` | 0 | Type-check; 0 tests. |
| `npm run check:edge` | 0 | Six edge entry points checked; 0 tests. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Generated bundle had no diff; 0 tests. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI built and executed with loopback `--url`; 0 tests. |
| `npm --prefix site run build` | 1, then 0 | First run hit sandbox `EPERM` unlinking Vite cache through shared `site/node_modules`. With a worktree-local `node_modules/.vite` cache, the exact command built **12 pages**; the original dependency symlink was restored. |
| `git diff --check origin/main...HEAD` | 0 | No whitespace errors at the Fold 6 tip. |

### Fold 6 not established

- The lead owns local-stack server verification. No migration was applied in this lane.
- No production, release, or real-workspace behavior was measured.
- The full pure and CLI gates are not green in this sandbox because process inspection is denied. Their final TAP counts reconcile to the named failures. `pgrep` cannot inspect the sandbox process list (`sysmond service not found`); the bounded gate and mutation runners waited for their children and left no deliberately running process.

## Fold 7 — Opus and Grok round 7 FAIL rulings

The lane was recovered at `362de306`, carrying the content reviewed at `acbaca57`. The full reviews are `scratchpad/itemM/opus-r7.md` and `scratchpad/itemM/grok-r7.md` (Opus probes: `scratchpad/itemM/opus-r7-probes/`). The lead's **pre-fold** gates at `acbaca57` were server 262/262, pure 990/990 (one load flake rerun 60/60), and CLI 1028/1028. Fold 7 changes only client storage/connect code, its focused CLI test file, and this evidence. No server, migration, production host, or real workspace was touched.

I1 remains the Fold 6 rule: a saved credential is replaced only after a successful same-attempt retry proves its old token revoked and the principal agrees. **Superseded by Fold 8 KK6 and Fold 9 LL2:** the first credential write formerly used a private same-directory temporary file, `fchmod(0600)`, fsync, and rename while the setup lock was held. An existing final path was refused. I2 still gives no unproved revocation advice. I3 still gives exact chmod and same-command retry for mode faults. I4 still blocks a possible same-code pending record before a fresh POST; the completion-only escape below has no pending record.

| Ruling | Change | Focused test | Single-change revert |
|---|---|---|---|
| HH1 — publication method and partial-file recovery superseded by Fold 10 OO2 | Fold 7 used a synced temporary file and manual `mv` advice for a damaged credential. Fold 10's unsupported-link fallback can leave only a zero-length final claim beside this code's pending record; retry repairs it. A pre-existing nonempty damaged credential still receives the `mv` step. | Historical Fold 7 tests plus Fold 10 killed-claim test. | Historical mutation; OO2 measures the current publication path. |
| HH2 | The ancestor mode walk runs only for EACCES/EPERM. Repository and symlink path errors keep their typed refusal. | `Fold 7 typed repository and symlink refusals do not advise chmod`. | Removing the permission-code guard: baseline 1/1, revert 0/1. |
| HH3 | A retry validates the orphan as a bounded regular file with a parseable durable principal before POST. Symlink, oversized, and missing-principal examples do not cost a token. | `Fold 7 retry checks every orphan form before register`; partial-file test above. | Disabling pre-POST orphan validation: baseline 1/1, revert 0/1. |
| HH4 | Default scan preserves credential-mode errors and checks a credential without pending or a usable completion record, plus its directory, before a fresh register. | `Fold 7 default scan reports credential and directory modes before another register`. | Dropping the credential-mode rethrow: baseline 1/1, revert 0/1. |
| HH5 — superseded by Fold 8 KK1 | Completion records carry the public target key and workspace ID. The Fold 7 rebuild validated credential shape but did not compare its principal with the completed attempt. | `Fold 7 completion rebuilds a missing profile locally or gives a new path for incomplete state`. | Restoring the missing-profile damaged step in the scan: baseline 1/1, revert 0/1. |
| HH6 — narrowed and extended by Fold 8 KK3/KK5 | Damaged or unreadable completion records produce one warning and are ignored for selection when there is no pending record. Wrong-mode records get the exact chmod step in that no-pending path; Fold 7 did **not** establish it for a resume with pending. Clear can remove a completion record without pending, and pending removal must actually succeed. | `Fold 7 damaged and unreadable completion records warn once and clear removes them`; `clear reports success only when pending was actually removed`. | Restoring a throw on damaged completion: baseline 1/1, revert 0/1. Ignoring the pending-removal result when completion was removed: baseline 1/1, revert 0/1. |
| HH7 — extended by Fold 8 KK2/KK7 | Replace still unlinks its temp on any error. Fold 7 cleaned all matching credential temps under the connect lock, including a live writer's temp; Fold 8 narrows cleanup to dead PIDs under the setup lock and adds profile temps. | `Fold 7 replace failure unlinks its temp and a killed replacement temp is removed next run`. | Removing the failure unlink: baseline 1/1, revert 0/1. Removing early stale-temp cleanup: baseline 1/1, revert 0/1. |

Each mutation restored the original source bytes in `finally`. Every focused test has a timeout; the two SIGKILL tests await their children and clean their temporary directories. Tests use injected fetchers, loopback targets, and temporary HOME/state. No full suite ran in this lane.
The timeout-table mapping was updated to the moved register abort timer and `stty` deadline source lines; its separate test file is for the lead's full CLI gate.

### Fold 7 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0; TypeScript build. |
| `npm run check:tests` | Exit 0; test type-check. |
| `env HOME="$T" node --import tsx --test tests/p1-cli/mcp-connect.test.ts` | Exit 0; 61/61 after build completed. An earlier overlapping run hit missing `dist/cli.js` while build cleaned it; the solo rerun was green. |

### Fold 7 not established

- The lead owns full pure, CLI, server, edge, release-bundle, and site gates at the Fold 7 tip. The lead's counts above are from before this fold. No migration was applied.
- The tests model the server's rotating-token response with injected fetchers and inspect local files; they do not establish production or real-workspace behavior.

## Fold 8 — Codex and Opus round 8 rulings

At `47b26181`, Codex marked the missing principal proof PRODUCTION and Opus independently identified it as RIGOUR. Opus also identified the pending resume, ancestor advice, clear wording, exclusive publication, and temporary-file cases. The reviews are `scratchpad/itemM/codex-r8.md` and `scratchpad/itemM/opus-r8.md`. This fold changes client code, its focused CLI test file, and this evidence. No server, migration, production host, or real workspace was touched.

| Ruling | Change | Focused test | Measured mutation |
|---|---|---|---|
| KK1 | Completion records store `principal_id` and the register response's `run_id`. HH5 rebuild requires the recorded principal to match the credential. A mismatch names `credential.json`, `connect-complete.json`, and the new `--profile` step; an older record without a principal cannot rebuild. **Supersedes HH5's unqualified validated-credential rebuild claim.** | `Fold 8 completion binds a rebuild to its recorded principal` checks matching, other-agent, and legacy records without another POST. | Removing the principal comparison: baseline 1/1, mutation 0/1. |
| KK2 — lock proof extended by Fold 9 LL5 | Connect and clear remove a matching credential temporary file only if its PID is dead. Cleanup holds the same `setup` lock as the profile writer, nested under the connect lock. | `Fold 8 cleanup keeps live temps and removes dead credential and profile temps`. | Removing the live-PID guard: baseline 1/1, mutation 0/1. |
| KK3 — post-POST wording extended by Fold 9 LL7 | A pending resume classifies the completion record under the connect lock. Wrong mode gives `chmod 600`; symlink or foreign owner gives `connect_complete_unsafe`. A completion write error gives `connect_complete_write_failed` and keeps the working profile. **Supersedes HH6's broad wrong-mode claim; the earlier claim was established only for the no-pending scan.** | `Fold 8 pending resume classifies completion and keeps a working profile on write failure` covers mode, symlink, simulated foreign owner, and injected EIO without another POST. | Restoring the pending-path skip of `readComplete`: baseline 1/1, mutation 0/1. |
| KK4 — unowned diagnosis superseded by Fold 10 OO1 | The ancestor walk offers chmod when an owned directory lacks owner permissions. A foreign directory receives ownership advice only if its own traversal probe fails. | Fold 8 ancestor test now injects a denial for the foreign directory; Fold 9 permission test models traversable root-owned ancestors. | OO1 mutation names the traversable ancestor and fails the Fold 9 test. |
| KK5 | Clear reports the exact removal: pending, completion, both, or nothing. An absent record does not produce a cleared claim. | `Fold 8 clear reports exactly the removed records and never selects a profile temp`; older clear tests now expect `nothing`. | Returning pending for the nothing case: baseline 1/1, mutation 0/1. |
| KK6 — unsupported-link method extended by Fold 10 OO2 | The first private file write publishes a synced temp with `link()`. Where hard links are unsupported, an exclusive empty claim plus a second synced temp and rename preserves one winner. | Fold 8 exclusive-write test and Fold 10 concurrent-claim test. | Replacing `wx` with `w` fails the Fold 10 test. |
| KK7 | Dead `profile.json` temps receive the same cleanup as credential temps. Clear skips temp names while finding a working profile, including a live writer's temp. | The Fold 8 cleanup and clear tests above. | Removing the clear-loop temp exclusion: baseline 1/1, mutation 0/1. |

Each mutation changed one source fragment, ran the named lane test with a 30-second subprocess bound and a temporary HOME, then restored the original bytes in `finally`. Every new test has a timeout. The focused test file passed **67/67** after the changes. The synthetic owner stat and injected write error isolate fault paths that cannot be created with this unprivileged test user.

### Fold 8 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0; TypeScript build. |
| `npm run check:tests` | Exit 0; test type-check. |
| `env HOME="$T" node --import tsx --test tests/p1-cli/mcp-connect.test.ts` | Exit 0; 67/67, with `T` created by `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 8 not established

- The lead owns full pure, CLI, server, edge, release-bundle, and site gates at the Fold 8 tip. No migration was applied.
- The focused tests use injected register responses and local files. They do not establish production, real-workspace, or release-bundle behavior. The foreign-owner and write-failure paths were simulated; no privileged ownership change was made.

## Fold 9 — Codex and Opus round 9 FAIL rulings

The reviews are `scratchpad/itemM/codex-r9.md` and `scratchpad/itemM/opus-r9.md`. This fold changes client connect/storage code, the timeout mapping, focused CLI tests, and this evidence. It touched no server, migration, production host, or real workspace.

| Ruling | Change | Focused test | Measured single-change mutation |
|---|---|---|---|
| LL1 | One exported profile-directory name set supplies the pending, completion, credential, lock, and temporary-file names to readers and writers. An explicit `--profile` basename colliding with that set gets `profile_path_reserved` before POST, with the full reserved set in the message. This extends the earlier preprompt path check. | `Fold 9 reserved profile basenames refuse before POST and name the writer set`; Fold 8 cleanup test now checks dead pending and completion temps too. | Disabling the reserved-basename refusal: baseline 1/1, mutation 0/1. |
| LL2 — fallback method superseded by Fold 10 OO2 | Fold 9 wrote into the final `wx` path on unsupported-link filesystems; a kill could leave partial JSON. Fold 10 retains the exclusive claim but writes to a second temp before rename. | Fold 9 unsupported-link test remains; Fold 10 kills after claim and mid-temp, repairs a profile, and races claimants. | Reverting storage to Fold 9 fails the killed-fallback test. |
| LL3 — citations superseded by Fold 10 OO3 | Fold 9 tested the abort timer and `stty` citations but missed the register-budget constant. Fold 10 validates all three at their current lines. | Existing timer tests plus `Fold 10 MCP register budget citation points to its constant`. | Restoring the budget citation to line 24 fails the new test. |
| LL4 — unowned diagnosis superseded by Fold 10 OO1 | The walk still reaches the root; ownership advice now requires a failed traversal probe on the foreign directory itself. | Fold 9 permission test models root-owned traversable ancestors. | Naming a foreign ancestor without its probe denial fails the test. |
| LL5 | Stale-temp cleanup holds the profile writer's `setup` lock. **Adds the missing measurement for KK2.** | `Fold 9 stale-temp cleanup waits for the setup writer lock` holds that lock, checks the dead temp remains, releases it, then checks removal. | Removing the lock wrapper: baseline 1/1, mutation 0/1. |
| LL6 — message and probe coverage superseded by Fold 10 OO1/OO4 | Fold 9 supplied a typed fallback but could blame a traversable root-owned ancestor and could still print a raw CLI permission message. Fold 10 checks the directory cause, classifies the profile-path access probe, and gives the CLI fallback an inspection step. | Fold 9 permission test and Fold 10 profile access-probe test. | Removing the access classifier or returning the raw CLI message fails the named tests. |
| LL7 — write-order proof extended by Fold 12 SS2 | After the profile save, a failed completion-record write says the profile is saved and usable, the record was not written, and the same command finishes the connect next run. **Extends KK3's resume-path wording to the first post-POST failure.** Fold 12 makes the record-not-written claim true for a late chmod/check failure. | `Fold 9 completion write failure reports a saved usable profile and resumes without POST` checks the message, profile, and no second POST. | Restoring `register_outcome_unknown`: baseline 1/1, mutation 0/1. |

All mutations changed one source fragment, ran only the named lane test with a 25-second child bound and temporary HOME, then restored the original bytes in `finally`. The final focused test files passed **91/91**. Every new test has a timeout, and every URL used by these tests is loopback.

### Fold 9 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0; TypeScript build. |
| `npm run check:tests` | Exit 0; test type-check. |
| `env HOME="$T" node --import tsx --test tests/p1-cli/mcp-connect.test.ts tests/p1-cli/timeout-table.test.ts` | Exit 0; 91/91, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 9 not established

- The lead owns full pure, CLI, server, edge, release-bundle, and site gates at this tip. No migration was applied.
- The unsupported-link, permission, and completion-write paths used injected faults; behavior on a particular external filesystem or ACL was not measured. The tests model one rotating seat with an injected loopback register response and inspect local files. No production or real-workspace behavior was measured.

## Fold 10 — Codex and Opus round 10 FAIL rulings

The reviews are `scratchpad/itemM/codex-r10.md` and `scratchpad/itemM/opus-r10.md`. This fold changes only client connect/storage code, the timeout mapping, the two lane test files, and this evidence. The lead reported 990/990 `npm test` and 1048/1048 p1-cli at `770183c3`; those counts predate this fold.

| Ruling | Change | Focused test | Measured single-change mutation |
|---|---|---|---|
| OO1 — production | An owned directory missing owner permissions still receives the exact `chmod 700` step. A foreign directory is named only when an `access(X_OK)` probe on that directory fails. Root-owned `/`, `/Users`, or `/home` that allow traversal cannot be blamed. Otherwise `connect_state_unavailable` gives an inspection step. **Supersedes LL4 and narrows KK4/LL6.** | `Fold 9 permission diagnosis covers outside-home ancestors and unclassified denial` now models traversable root-owned ancestors and an injected traversal denial on the foreign directory; the Fold 8 ancestor test injects its denial too. | Naming a foreign ancestor without its failed probe: exit 1, targeted test 0/1. |
| OO2 — publication, default scan, and claim-identity details superseded by Fold 11 QQ2/QQ3 | On an unsupported-link filesystem, `wx` claims the final name with a zero-length file, then a second same-directory 0600 temp is written, fsynced, and renamed over that same claim. A kill leaves only the empty claim, which a pending same-code retry replaces after register; a nonempty damaged credential still requires inspection and a file-only move. A regular, owned, bounded partial or empty explicit profile with a matching completion record is rebuilt locally without another POST. **Supersedes LL2 and HH1's fallback method.** | `Fold 10 killed wx claims and fallback temps recover the same pending connect` kills after claim and mid-temp; `Fold 10 two wx claimants publish one complete credential` checks one winner/EEXIST; `Fold 10 changed wx claim preserves an intervening credential` checks an inode swap; `Fold 10 explicit profile repairs an old interrupted rebuild without POST` checks partial and zero-length files. | Reverting `storage.ts` to Fold 9: exit 1, killed-fallback test 0/1. Disabling empty-claim recognition, explicit repair, `wx` exclusivity, or the changed-inode guard independently: each exit 1, targeted test 0/1. |
| OO3 — abort-timer line 700 superseded by Fold 11 | At Fold 10 the timeout mapping cited `MCP_REGISTER_TIMEOUT_MS` at line 23, the abort timer at line 700, and `stty` at line 267. Fold 11 moves the abort timer to line 720 and updates its citation. | `Fold 10 MCP register budget citation points to its constant` and the existing timer citation tests resolve the cited source lines. | Restoring the budget citation to line 24: exit 1, targeted test 0/1. **Supersedes LL3's line numbers.** |
| OO4 | The profile-path `access(W_OK)` probe uses `classifyDirectoryFailure`. The CLI's final raw EACCES/EPERM fallback emits the typed inspection message rather than the raw error. **Supersedes LL6's incomplete fallback.** | `Fold 10 profile access probe classifies both permission codes before POST` injects each error and checks no POST; the Fold 9 permission test checks the CLI message for both codes. | Removing the access classifier or restoring the raw CLI message independently: each exit 1, targeted test 0/1. |

Each mutation changed one fragment or restored the Fold 9 storage file, ran only the named lane test with a 30-second subprocess bound and temporary HOME, then restored the original bytes in `finally`. The two kill-point tests terminate and await their child before cleanup. No test contacts a real workspace or production host.

### Fold 10 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `env HOME="$T" node --import tsx --test tests/p1-cli/mcp-connect.test.ts tests/p1-cli/timeout-table.test.ts` | Exit 0; 97/97, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 10 not established

- The lead owns the full pure, CLI, server, edge, release-bundle, and site gates at this fold's tip. No migration was applied.
- The unsupported-link and permission faults were injected. Behavior on a particular external filesystem, ACL, or production host was not measured. The register response came from an injected local fake, not a real workspace.

## Fold 11 — Opus round 11 PASS rulings

Opus's sole round-11 arm passed at `b6dd3a69` with three low RIGOUR findings. The lead reported 990/990 pure tests and 1054/1054 p1-cli tests at that base. This fold changes only the connect client, exclusive file publication, the timeout citation displaced by those edits, focused tests, and this evidence. No server, migration, production host, or real workspace was touched.

| Ruling | Change | Focused test | Measured single-change revert |
|---|---|---|---|
| QQ1 — pending-record scope extended by Fold 12 SS1 | `completedProfileAt` reads a profile using its own `host_session_id`. A working setup-bound profile therefore refuses a same-code rerun with `profile_exists` and keeps its bytes when no pending record remains. Fold 12 handles the pending-record branch. The completion rebuild rechecks and writes under the `setup` lock while holding the connect lock. | `Fold 11 setup-bound profile survives a same-code connect` uses `saveAgentProfile` to bind a connect profile, then checks the same-code refusal, unchanged bytes, and one POST. | Removing the host-session read: baseline pass, revert exit 1, targeted test 0/1 (same-code rerun replaced the profile). |
| QQ2 — extends and supersedes OO2's explicit-only rebuild and empty-file wording; clear wording extended by Fold 12 SS3 | The default scan accepts an owned, bounded, 0600 empty `profile.json` claim for local rebuild, as the explicit path already did. An empty `credential.json` is called an empty claim file in clear output and in no-pending and incomplete-rebuild refusals. Fold 12 also names a kept, unvalidated profile beside the empty claim. Nonempty damaged profiles and credential files retain their existing refusal and repair steps. | `Fold 11 default path repairs an empty profile claim without a move` checks local rebuild and no second POST. `Fold 11 clear and later refusal name an empty credential claim` checks both sentences and unchanged zero-length bytes. | Restoring the default scan's damaged-profile refusal: baseline pass, revert exit 1, targeted test 0/1. Restoring the old clear sentence: baseline pass, revert exit 1, targeted test 0/1. |
| QQ3 — supersedes OO2's closed-descriptor identity guard | The exclusive claim descriptor remains open through rename; the changed-claim and cleanup checks compare the path with that descriptor's `fstat` identity. | `Fold 11 open claim rejects a replacement before rename` injects a file replacement during the descriptor identity check, expects `EEXIST`, and keeps the replacement. | Closing the claim before the check: baseline pass, revert exit 1, targeted test 0/1 (`EBADF` instead of `EEXIST`). |

Each mutation changed only the named source fragment and was restored before the next measurement. Every new test has a timeout. The injected fetcher uses a loopback target, and the tests use temporary state and HOME directories. The timeout mapping now cites the register timer at `src/cloud/mcp-connect.ts:720`.

### Fold 11 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `env HOME="$T" node --test-reporter=dot --import tsx --test tests/p1-cli/mcp-connect.test.ts tests/p1-cli/timeout-table.test.ts` | Exit 0; 101/101, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 11 not established

- The lead owns the full pure, CLI, server, edge, release-bundle, and site gates at this fold's tip. No migration was applied.
- The setup-lock nesting is source-verified but was not isolated by a concurrency test: the earlier connect cleanup also acquires that lock. The filesystem replacement and unsupported-link behavior use injected faults; no inode-reusing external filesystem or real workspace was measured.

## Fold 12 — Codex round 12 FAIL and Opus round 12 PASS rulings

Both reviews identify the pending-record host-bound profile defect. Codex also identifies the completion-write ordering error; Opus identifies two incomplete messages. The reviews are `scratchpad/itemM/codex-r12.md` and `scratchpad/itemM/opus-r12.md`. This fold changes only the MCP client, private file writer, clear output, the focused MCP test file, and this evidence. No server, migration, production host, or real workspace was touched.

| Ruling | Change | Focused test | Measured single-change revert |
|---|---|---|---|
| SS1 — production; ownership claim superseded by Fold 14 WW2 | `completedProfileAt` returns the validated profile read with its own `host_session_id`. The pending-record branch uses that result. Fold 14 allows adoption only when the private attempt marker matches pending. | `Fold 12 pending resume keeps a host-bound working profile from this attempt` checks zero resume POSTs, pending removal, and byte-identical profile. | Restoring the old branch that discards `completedProfileAt` and calls `readAgentProfile(path)` without the host ID: exit 1, targeted test 0/1 at Fold 12. |
| SS2 — extends LL7's record-not-written claim | The completion writer applies `fchmod`, sync, and the secure-file check to its temp before rename. There is no fallible operation after rename in the success path. | `Fold 12 completion chmod failure leaves no record before reporting it unwritten` injects a chmod failure, checks the sentence and absent record, and reads source order to check the secure validation and rename boundary. | Restoring the exact pre-fold storage file: exit 1, targeted test 0/1 on the source-order assertion. |
| SS3 — extended by Fold 13 TT3 | `--clear-pending` names both the empty credential claim and an unvalidated profile in the same directory and says both were kept. Fold 13 prints the resolved profile path. | `Fold 12 clear names a kept unvalidated profile beside an empty credential claim` checks both files and the clear output, including `~/` expansion. | Restoring the earlier empty-claim-only sentence and rebuilding the CLI: exit 1, targeted test 0/1 at Fold 12. Fold 13 measures the raw-path revert separately. |
| SS4 | Rebuild-state copy uses `basename(path)` for all three profile states, including an explicit `--profile agent.json`. | `Fold 12 rebuild refusal names the explicit profile basename` checks missing, empty-claim, and damaged states, with no second POST. | Restoring literal `profile.json` in the state sentence: exit 1, targeted test 0/1. |

Each mutation changed one named source fragment, ran the targeted test with a 30-second child bound and temporary HOME, and restored the source in `finally`. The SS3 mutation rebuilt the CLI before its test and again after restoration. Every added test has a timeout. The tests use injected fetchers, a loopback target, and temporary state directories. The register abort timer remains at `src/cloud/mcp-connect.ts:720`.

### Fold 12 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `env HOME="$T" node --test-reporter=spec --import tsx --test tests/p1-cli/mcp-connect.test.ts` | Exit 0; 85/85, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 12 not established

- The lead owns the full pure, CLI, server, edge, release-bundle, and site gates at this fold's tip. No migration was applied.
- The completion chmod fault and post-rename ordering were injected and source-checked, respectively. No external filesystem, production host, release bundle, or real workspace was measured.
- `pgrep` could not inspect the sandbox process list (`sysmond service not found`). Focused test children and bounded mutation processes exited; no task child was intentionally left running.

## Fold 13 — Codex round 13 FAIL and Opus round 13 PASS rulings

Both reviews identify the pending-profile ownership and host-bound install defects; Opus also identifies the unresolved clear-output path. The reviews are `scratchpad/itemM/codex-r13.md` and `scratchpad/itemM/opus-r13.md`. This fold changes the MCP connect, setup, profile, and clear-output paths, the displaced timeout citation, focused CLI tests, and this evidence. No server, migration, production host, or real workspace was touched.

| Ruling | Change | Focused test | Measured single-change revert |
|---|---|---|---|
| TT1 — superseded by Fold 14 WW1/WW2 | At Fold 13, connect wrote `connect_attempt_id` into `profile.json`; Fold 14 moved it to a private marker to restore released-client compatibility. Pending resume adopts only when that marker matches pending. A different profile gets typed `connect_profile_other_attempt`, names the profile and pending files and a new `--profile` path, makes no POST, and leaves all files unchanged. At Fold 13, setup's second pending check ran under only the setup lock; it did not serialize with connect's pending write. Fold 14 adds the common outer connect lock. | `Fold 13 pending profile must belong to this connect attempt` covers another agent's setup-shaped profile and a different attempt with the same agent; `Fold 12 pending resume keeps a host-bound working profile from this attempt` checks adoption, no POST, identical bytes, and matching IDs; `Fold 13 setup refuses a directory with a connect pending record before network` checks the typed refusal and unchanged pending. | At Fold 13, removing the attempt comparison: exit 1, targeted test 0/1 (foreign profile accepted). Removing setup's early guard: exit 1, targeted test 0/1 (unexpected network path). Both mutations were restored. Fold 14 measures the private-marker and outer-lock reverts separately. |
| TT2 | One `connectedResult` argument list generates both install forms. A bound profile adds `--host-session-id <id>`; an unbound profile omits it. | The Fold 12 pending-resume test parses both printed forms with `Arguments` and passes each parsed path and session ID to `readAgentProfile`, the same profile check used by `serveMcp`, without network access. | Removing the host-session arguments: exit 1, targeted test 0/1 (bound install line incomplete). Restored. |
| TT3 — extends SS3 | The empty-claim clear sentence prints the resolved profile path after `~/` expansion, as the working-profile sentence does. | The Fold 12 clear test passes `~/empty-claim-and-profile/agent.json`, checks the absolute path and the kept file bytes. | Restoring the raw `--profile` string and rebuilding the CLI: exit 1, targeted test 0/1. Source restored and CLI rebuilt. |

Each new test has a 10-second timeout. The full focused MCP file passed **87/87** with a temporary HOME. Mutation commands ran only the named test with a temporary HOME and restored the changed source. The register abort timer moved to `src/cloud/mcp-connect.ts:724`; `scripts/timeout-table/mapping.json` now cites that line.

### Fold 13 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `env HOME="$T" node --test-reporter=dot --import tsx --test tests/p1-cli/mcp-connect.test.ts` | Exit 0; 87/87, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 13 not established

- The lead owns full pure, CLI, server, edge, release-bundle, and site gates at this fold's tip. The timeout-table test was not run in this lane. No migration was applied.
- The profile and register tests used local files and injected loopback responses. No production, external filesystem, or real-workspace behavior was measured.
- `pgrep` could not inspect the sandbox process list (`sysmond service not found`). All focused test and mutation commands exited, and the tests await their own spawned children.

## Fold 14 — Codex and Opus round 14 FAIL rulings

The reviews are `scratchpad/itemM/codex-r14.md` and `scratchpad/itemM/opus-r14.md`; the lead's failures are `scratchpad/itemM/gates-r14-failures.md`. At `dc17dc07`, the lead measured `npm test` 989/990 and `p1-cli` 1062/1064. This fold changes only local client/profile behavior, tests, the timeout citation, and this evidence. The Fold 13 TT1 row above is historical: its profile-field ownership claim and its claim about the setup-lock check are superseded here.

| Ruling | Change | Focused test | Measured single-change revert |
|---|---|---|---|
| WW1 — test injection superseded by Fold 15 ZZ3 | A non-connect `saveAgentProfile` holds the connect lock around the setup lock. Connect's pending write also holds both, in that order. | `Fold 14 setup and connect serialize the pending check with the profile write` now injects at the credential file write, after setup's in-lock pending check. It observes that the pending write waits until setup finishes. | Removing the outer connect lock from setup: exit 1, 0/1; pending appeared during setup's write. Restored. Fold 15 remeasures this without the test-only production hook. |
| WW2 — marker error handling extended by Fold 15 ZZ1 | `profile.json` keeps the released six-key connect shape. Connect writes the attempt ID to 0600 `connect-profile-attempt.json`, named in the reserved-file set, before publishing the profile. Pending adoption compares this marker; completion rebuild recreates it. Other profile readers do not open it. Fold 15 handles wrong-mode and unreadable markers separately. | `Fold 14 connect writes a v0.1.77-shaped profile and keeps its attempt marker private` applies the released exact-key reader and checks marker mode/ID. The Fold 12 bound adoption and Fold 13 foreign-profile refusals pass with the marker. | Putting `connect_attempt_id` back into the profile: exit 1, 0/1 in the released-reader test. Disabling the marker comparison: exit 1, 0/1 in the foreign-profile test; the foreign profile was adopted. Both restored. |
| WW3 | The workspace-name agreement test exercises `readAgentProfile` instead of matching its source text. | `the profile file accepts either released shape and rejects an extra key` writes six keys, six plus `workspace_name`, and an unknown-key shape to private temporary files. | Removing `workspace_name` from the reader's accepted keys: exit 1, 0/1. Restored. |
| WW4 | The owned MCP error table includes `setup_connect_pending` and gives an operator action. | `Fold 14 pending setup refusal has owned MCP advice`. | Removing the table row: exit 1, 0/1. Restored. |
| WW5 — comment-text test superseded by Fold 15 ZZ3 | The `renderMcpConnect` comment names the host session ID that bound install commands print. The Fold 12 bound-install test checks the actual printed arguments; the source-comment test is removed. | `Fold 12 pending resume keeps a host-bound working profile from this attempt` parses both printed install forms and opens the bound profile. | Restoring the stale comment previously failed a text-only test; that check is superseded. The Fold 13 TT2 mutation remains the behavior control. |
| WW6 — timer line superseded by Fold 15 ZZ1 | The HEAD timeout-table row cites `agent-setup.ts:17,45-68`; the historical v0.1.71 row is unchanged. The displaced register timer citation is now line 742 after ZZ1. | `setup whole-operation timeout citation names the constant and deadline block` resolves all three cited lines; the existing register-timer test resolves the current timer line. | Restoring the stale setup range: exit 1, 0/1. Restored. |

Every focused test has a timeout. The WW1 writer is injected at the lock boundary, not an external process. All register tests use a loopback target and injected responses; no real workspace was used.

### Fold 14 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| MCP connect lane file under temporary HOME | Exit 0; 91/91. |
| Workspace profile-shape test under temporary HOME | Exit 0; 1/1. |
| Setup and register citation tests under temporary HOME | Exit 0; 2/2. |

### Fold 14 not established

- The lead owns the full pure and CLI suites, MCP owned-table gate, server/edge gates, release bundle, and site gates at this fold's tip. No migration was applied.
- No production host, external filesystem, or real workspace was tested. The comment and citation checks establish source accuracy; the bound-output behavior is covered by the focused MCP test.
- `pgrep` was attempted before commit but could not inspect this sandbox's process list (`sysmond service not found`). The focused test and mutation commands returned; no task child was intentionally left running.

## Fold 15 — Codex round 15 FAIL and Opus round 15 PASS rulings

Both reviews identify the wrong-mode attempt-marker refusal. Opus also identifies two stale storage timeout citations and two test couplings. This fold changes only the connect/profile client, the HEAD timeout mapping, the two lane test files, and this evidence. The Fold 14 WW1 test injection, WW5 comment test, and WW6 timer line above are superseded as marked.

| Ruling | Change | Focused behavioral test | Measured single-change revert |
|---|---|---|---|
| ZZ1 — superseded by Fold 17 AE1 | A pending attempt's owned 0644 marker **beside a working profile** gets `connect_marker_mode` with its exact `chmod 600` path and same-command retry. The Fold 15 symlink test established `connect_marker_unreadable` only on that read path; it did **not** establish the same result on either marker write path. Fold 16 covered two wrong-mode writes, and Fold 17 covers all reserved paths before writes and POSTs. | `Fold 15 wrong-mode attempt marker gives an exact repair and same-command resume` checks no POST, preserved profile, and successful retry after chmod. `Fold 15 unsafe attempt marker gets a typed file-specific refusal before POST` uses a symlink beside a working profile. | Restoring the Fold 14 `.catch(() => null)` marker read: exit 1, 0/2. Both tests received the false `connect_profile_other_attempt` code. Restored. |
| ZZ2 — timer citations superseded by Fold 16 AB1 | The HEAD storage citations resolve to `storage.ts:27` (`LOCK_TIMEOUT_MS`) and `storage.ts:385` (`timeoutMs`); the historical v0.1.71 rows are unchanged. At Fold 15 the register timer was at `mcp-connect.ts:742`. | `Fold 15 storage lock citations resolve to the constant and default` reads both cited source lines. The existing register-timer citation test checked line 742 at Fold 15. | Restoring line 25 for the constant: exit 1, 0/1. Separately restoring line 383 for the default: exit 1, 0/1. Both restored. |
| ZZ3 — test shape superseded by Fold 16 AB3 | The comment-text assertion is removed. At Fold 15 the setup/connect concurrency test injected through the exclusive credential writer, using `refuseExisting=true`. Fold 16 uses the normal setup writer with `refuseExisting=false`. | `Fold 14 setup and connect serialize the pending check with the profile write` observes the file-write boundary. `Fold 12 pending resume keeps a host-bound working profile from this attempt` checks both printed install forms. | At Fold 15, removing the outer connect lock: exit 1, 0/1; pending appeared during setup's write. Fold 16 remeasures with the production setup shape. |

Every focused test has a timeout. The connect tests use temporary state directories, an injected fetcher and a loopback target. The mutation commands ran only their named lane tests under fresh temporary HOME directories and restored the source after each run.

### Fold 15 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `env HOME="$T" node --test-reporter=dot --import tsx --test tests/p1-cli/mcp-connect.test.ts tests/p1-cli/timeout-table.test.ts` | Exit 0; 114/114, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 15 not established

- The lead owns the full pure and CLI suites, MCP owned-table gate, server/edge gates, release bundle, and site gates at this fold's tip. No migration was applied.
- No production host, external filesystem, or real workspace was tested. The unreadable-marker test uses a symlink; the no-POST claim uses an injected fetcher.
- `pgrep` could not inspect this sandbox's process list (`sysmond service not found`). The focused test and mutation commands exited; no task child was intentionally left running.

## Fold 16 — Codex and Opus round 16 RIGOUR rulings

Both reviews found that a wrong-mode attempt marker was classified on the profile read but could reach either marker writer first. This fold changes the connect/profile client, its two moved timeout citations, the focused MCP test, and this evidence. The Fold 15 ZZ1 coverage claim and the ZZ2/ZZ3 historical details are corrected above.

| Ruling | Change | Focused behavioral test | Measured single-change revert |
|---|---|---|---|
| AB1 — superseded by Fold 17 AE1 | The Fold 16 marker classifier covered owned 0644 markers on pending and completion rebuild paths but did not classify symlinks or fresh attempts before POST. | `Fold 16 pending without profile classifies marker mode before register` and `Fold 16 completion rebuild classifies marker mode before rewriting it` covered those two states. | Removing both prewrite calls: exit 1, 0/2 at Fold 16. Fold 17 replaces these calls with the reserved-path preflight. |
| AB2 — superseded by Fold 17 AE1 | The Fold 16 marker classifier checked exact 0700 directory mode; Fold 17 folds that check into the one reserved-path classifier. | `Fold 16 marker read failure names a wrong-mode directory before an unsafe marker` checks `chmod 700` before the symlink refusal. | Removing the directory branch: exit 1, 0/1 at Fold 16. Fold 17 retains the behavior in the shared classifier. |
| AB3 — test seam superseded by Fold 17 AE2 | Setup uses `refuseExisting=false` and the normal credential write. Fold 17 removes the `writeCredential` argument and injects at `FileHandle.writeFile`. | `Fold 14 setup and connect serialize the pending check with the profile write` observes that pending cannot appear during the normal setup write. | Removing the outer connect lock: exit 1, 0/1 at Fold 16 and again at Fold 17 with filesystem-level injection. |

All three controls have timeouts, use temporary state and HOME directories, and target loopback through injected fetchers. The HEAD timeout mapping now cites the register timer at `mcp-connect.ts:758` and the hidden-input deadline at `mcp-connect.ts:289`; their focused citation tests resolve both lines.

### Fold 16 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `env HOME="$T" node --test-reporter=spec --import tsx --test tests/p1-cli/mcp-connect.test.ts tests/p1-cli/timeout-table.test.ts` | Exit 0; 117/117. |

### Fold 16 not established

- The lead owns the full pure and CLI suites, edge check, release bundle, and site build at this fold's tip. No migration was applied.
- No production host, real workspace, or external filesystem was tested. The directory case calls the read-failure classifier directly with real local files; it does not force a directory-mode race inside `connectMcp`.
- `pgrep` could not inspect this sandbox's process list (`sysmond service not found`). The focused tests and mutations exited; no task child was intentionally left running.

## Fold 17 — Codex and Opus round 17 FAIL rulings

Both reviews found that a fresh connect skipped marker classification and that a symlink or directory marker could pass the mode-only prewrite check. Opus also identified the test-only credential writer argument and a 0644 fixture dependent on umask. This fold changes only the connect/profile client, its reserved-name set and lock file mode, the focused MCP test, two displaced timeout citations, and this evidence. No server, migration, production host, or real workspace was touched.

| Ruling | Change | Behavioral test | Measured single-change revert |
|---|---|---|---|
| AE1 — one total reserved-path rule | `classifyConnectReservedPath` returns absent, ok, wrong mode, or unreadable. It checks the owned 0700 directory, owned regular 0600 file, and readable body. The preflight enumerates the fixed names and temporary patterns from `CONNECT_PROFILE_FILES` before locks, writes, or POSTs, on explicit paths and default discovery, with a second check under the connect lock. Wrong mode gives the exact `chmod` and same-command step; unsafe type, owner, or body names the file and inspection step. The lock writer sets 0600 explicitly so a restrictive umask cannot create a lock the preflight rejects. | `Fold 17 every reserved path refuses unsafe state before POST on explicit and default connect` covers 12 names × five states × two routes, using simulated owner and read faults; each cell checks zero POSTs and the exact repair or refusal sentence. `Fold 17 fresh connect checks marker before pending write or register` covers 0644 and symlink markers without pending, zero POSTs, and no pending write. Earlier pending and rebuild tests still pass. | Removing the preflight calls: exit 1, 0/2 targeted tests; the table got an older pending refusal without the required step, and the fresh marker reached `register_outcome_unknown`. Restored. |
| AE2 | Removed the `writeCredential` argument from `saveAgentProfile`. The setup/connect concurrency test intercepts `FileHandle.writeFile` when the regular credential body is written, then restores the method. It still uses setup's normal arguments. | `Fold 14 setup and connect serialize the pending check with the profile write` checks that the pending write waits for setup's outer lock. | Removing the outer connect lock: exit 1, 0/1; pending appeared during setup's credential write. Restored. |
| AE3 | The 0644 marker fixture writes first and calls `chmod` after; the preprompt directory fixture likewise sets its intended 0755 mode after `mkdir`. | The focused MCP file passes under `umask 077` with a fresh temporary HOME. | Removing the marker `chmod` and running the targeted test under `umask 077`: exit 1, 0/1; the file stayed 0600 and the test received `register_outcome_unknown` instead of `connect_marker_mode`. Restored. |

Each new test has a timeout. The table also checks absent and ok as positive controls. It uses a loopback target, an injected fetcher, and temporary profile directories. All mutation commands ran a named lane test under a fresh temporary HOME and restored the changed file after the test. The moved timeout citations now point to `mcp-connect.ts:792` and `:322`; the lead owns their gate.

### Fold 17 gates

| Gate | Result |
|---|---|
| `npm run build` | Exit 0. |
| `npm run check:tests` | Exit 0. |
| `umask 077; env HOME="$T" node --test-reporter=dot --import tsx --test tests/p1-cli/mcp-connect.test.ts` | Exit 0; 97/97, with `T` from `mktemp -d /tmp/lane-home.XXXXXX`. |

### Fold 17 not established

- The lead owns the full pure and CLI suites, edge check, release bundle, site build, and server gates at this fold's tip. No migration was applied.
- Owner and body faults in the table are injected; an external filesystem and real workspace were not tested. No production host was contacted.
- The focused command exited. Process-list inspection is reported separately after the final check.
