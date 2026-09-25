# Item M lane: crash-safe MCP connect (2026-09-25)

The original sections below record historical lane states. Fold 5 at the end is the current client rule; it supersedes earlier credential deletion, mode, fresh-register escape, and revocation-advice rows.

Branch `lane/item-m`. Client commit `df609b6a`; test commit `fa2768aa`. Base brief: `docs/design/2026-09-25-ITEM-M-CRASH-SAFE-CONNECT-BRIEF.md`. No server, migration, or production change. No production host was contacted. Every register test used an injected fetcher or a loopback HTTP server and a temporary profile directory.

## Decisions → change → test → mutation

| Decision | Change | Test | Mutation result |
|---|---|---|---|
| Keep a retry identity before POST without storing a code or token | `connect-pending.json` holds a random attempt ID, target URL, name, creation time, and HMAC-SHA256 keyed by the attempt ID. Secure storage writes it as 0600 under a 0700 directory before register. | `a committed save failure resumes one seat...` reads the pending record during the fake POST, checks its mode and absence of secret prefixes, then recovers one seat. | Replaced the POST's persisted attempt ID with `randomUUID()`: focused test exit 1, 0 pass / 1 fail. Reverted the whole client implementation to `origin/main`: this test exit 1, 0/1. |
| Retry the same seat after lost response or process death | Resume prompts for the code, verifies the HMAC, posts the stored attempt ID, then deletes pending after credential and profile are saved. | Save failure, truncated response, and killed child tests each observe two POSTs with one attempt/seat, a valid profile, and no pending record. | With the client reverted to `origin/main`, each of the three tests exited 1 with 0 pass / 1 fail. The restored client passed all three. |
| Recover both file-write crash windows — superseded by Fold 5 I1 | A pending record permits an orphan `credential.json` only; `saveAgentProfile` still refuses an existing profile while allowing that orphan to be replaced. A completed profile beside pending is validated and pending is cleared without another POST. An empty directory is accepted as fresh. | `orphan credential and completed profile crash windows recover safely`; existing occupied-path test. | Reverted only the orphan exception in `agent-profile.ts`: focused test exit 1, 0/1. Reverted the whole client: focused test exit 1, 0/1. |
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
| V3 | A completed profile and credential beside pending are validated and cleaned without another POST. | `completed profile clears old pending without POST` uses a record over two hours old; disabling completed-profile recovery: exit 1, 0/1. |
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
| FF1 / I1 | Atomic replacement after the server proof; completion record prevents a second default-path POST. | `rotating retry repairs a credential-only crash on explicit and default paths`; `a successful retry for another principal keeps the orphan bytes and pending record`. The fake revokes the old token, mints a new token, and retains one seat for the attempt. | Disabling orphan replacement: exit 1, 0/1. Disabling the completion record: exit 1, 0/1. |
| FF2 / I4 | A failed profile validation beside pending names `profile.json` as damaged and gives an exact `mv` of that file only to a UTC-stamped name, followed by the same command. | `a damaged profile beside this code gives a profile-only move step`. | Restoring new-path advice: exit 1, 0/1. |
| FF3 / I3 | An ancestor mode error names the actual directory, including `~/.cswarm` at 0000, with its `chmod 700` step. | `default scan names a mode-0000 ~/.cswarm directory`. | Disabling the ancestor check: exit 1, 0/1. |
| FF4 | The private JSON writer and exclusive credential writer call `fchmod(0600)` on their open handles before sync. | `umask 0277 still creates mode 0600 pending, credential, profile and completion files`. | Removing exclusive credential fchmod: exit 1, 0/1. |
| FF5 / I3 | The default scan classifies wrong modes for a same-URL possible pending record before validating its body or excluding another code. | `default scan repairs modes before calling same-URL malformed pending damaged` covers file 0644 and directory 0755; `owned pending with a wrong file or directory mode matches by HMAC and resumes after chmod` also checks a different code. | Restoring the parse-first mode condition: exit 1, 0/1. |

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
