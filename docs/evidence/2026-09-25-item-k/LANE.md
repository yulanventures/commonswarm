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
| JJ1 — **superseded by Fold 3** | The enum values were linked, but the Fold 2 session start synopsis omitted its required credential and `--foreground`; status and stop displayed flags their handler refused. The parser test did not check those handlers. | The Fold 2 probe measured only enum rendering; it did not establish session help correctness. |
| JJ2 | `saveAgentProfile` records each written absolute path in a 0600 registry under the shared root. `profile ls finds walked and registered paths without opening credentials` covers an explicit path, a missing registered file, and absent credential file. | Ignored registry paths: 0/1 passed. |
| JJ3 — **superseded by Fold 3** | The Fold 2 test compared help with the same table used by `parseCommandOptions`, while handler `assertShape` lists could be narrower or wider. It missed rejected session flags and accepted listener flags. | The 0/1 probe only established table self-consistency. |
| JJ4 | Listen route and channel purpose help interpolate `listenerRouteUsage()` and `CHANNEL_PURPOSE_MAX`; `route and purpose guidance reads enforcement constants` checks both source linkage and output. | Replaced route interpolation with `main`: 0/1 passed. |
| JJ5 | Inbox `--since` and `--limit` guidance has its own heading before credential selection. `inbox guidance has its own heading before credential selection` checks placement. | Removed the heading: 0/1 passed. |
| JJ6 | `profile ls --url` validates the URL but does not filter damaged profiles. Directory walk reports unreadable paths and continues. MCP `profile_path_invalid` uses `profilePathRemedy()`. The profile test checks the damaged row, typed bad URL, unreadable directory, continued walk, and generated MCP example. | Restored URL filtering, accepted a bad URL, skipped an unreadable directory, and restored fixed MCP text in separate probes: each 0/1 passed. |
| JJ7 — **naive-timestamp refusal REVERSED by Fold 8** | The Fold 2 refusal claim is superseded: main accepts every `Date.parse`-finite `--since` value. The workspace identity check remains. The local-edge test still measures the former newest-50 mismatch and now records naive and offset timestamp results without asserting a refusal. | The Fold 2 naive-timestamp mutation measured the now-reversed rule. Fold 8 measured the restored main behavior. The workspace comparison probe remains applicable. |
| JJ8 — **continuation copy superseded by Fold 9 AI2** | `readDirectedInboxSince` uses typed paging errors and ten-page and 20-second caps. The earlier `--since <last>` notice is superseded: a timestamp cannot resume within equal-timestamp pages. | Read an eleventh page, removed the time cap, and threw a generic paging error in separate probes: each 0/1 passed. Fold 9 tests the revised notice. |
| JJ9 — **superseded by Fold 3** | Four focused profile routes passed, but `fixtures()` filtered `profile.*` out of the main recorded baseline. | The focused mutation did not establish main-baseline membership. |
| JJ10 | The lane tests share `createLaneTempHome`/`removeLaneTempHome`; deletion accepts only a path created by that helper under `/tmp`, and refuses `/`, the real home, and paths outside the temporary root. `temporary home cleanup refuses outside paths` is the control. | Returned a path the helper had not created: 0/1 passed. |

The server test has **not** measured the mismatch yet. Its expected comparison is an assertion for the lead to verify on an exclusive local stack: after 101 directed asks, the former newest-50 path omits the oldest ask while paged `inbox --since` returns it. Until that run succeeds, the cause is an inference from the client and read-edge code, not a measured local-edge result. The field report's original conditions are also not established. The full dispatcher baseline, released bundle, edge check, site build, and full suites remain with the lead.

Fold 2 verification was limited: `npm run build` exit 0; `npm run check:tests` exit 0; the three selected P1 CLI files passed 23/23 with `env HOME="$T"`, **excluding** the four files that the lead's gates found red. The focused dispatcher test passed 3/3, but it did not run the full 1,330-row baseline. Sixteen mutation probes exited 1 with the intended focused test failing (JJ6 and JJ8 each had additional probes). `git diff --check` passed before commits. Process enumeration via `pgrep` returned `sysmon request failed ... sysmond service not found`, so this sandbox did not establish a process-list control; the focused test commands returned, and their temporary homes were removed.

## Fold 3 — round 2 production and review repairs

Round 2 inputs: `codex-r2.md`, `opus-r2.md`, and `gates-r2-failures.md` under the task's `scratchpad/itemK/`. The lead measured 976/990 in `npm test`, 1000/1013 in `test:p1-cli`, and a real `listen --state-dir` refusal at `9d7da613`. The earlier claim that this fold changed only help and the optional profile inventory is **superseded**: it also changed the feedback refusal. Fold 4 restores that refusal. Fold 3 did not install a command-table flag gate in `main` or alter the then-recorded dispatcher rows.

| Ruling | Change and focused test | Measured reverted behavior |
|---|---|---|
| NN1 | Removed `main()`'s pre-handler `assertAcceptedFlags`. `profile dispatcher baseline covers listing and refusal routes` checks the typed `--profile is supported by:` text, and the full 1,342-row dispatcher baseline checks hook exit 0, MCP prefixes, listener flags, and prior refusals. The loose `profile|unknown option` regex is gone. | Restored the flag gate: focused profile dispatcher test exit 1. |
| NN2 — **superseded by Fold 4** | Exported session and listener accepted-flag constants now feed their handler `assertShape` calls and help table flags. Session status/stop advertise no mode/provider/principal/host-label/foreground, and show `--workspace-id` with `--profile`; start names its required token file and `--foreground`. Listen help shows `--state-dir` and `--defer-over` where accepted, without `--session-context` on start. AST and rendering assertions in `command-table-gates.test.ts` check handler, table, and help together. | Removed start `--foreground`, added a refused status flag, and disconnected listener table flags in separate probes: each focused test exit 1. |
| NN3 — **superseded by Fold 4** | Registry writes are best effort after a 0600 profile save. A 0755 shared root gets one warning with `chmod 700 ~/.cswarm`; damaged or unwritable inventory gets one warning. `profile ls` records a damaged registry row and continues the directory walk. `profile-ls`, `agent-onboarding`, and `mcp-connect` exercise missing, damaged, 0755, and unwritable cases with temporary homes and loopback fixtures. | Restored the registry throw: profile inventory test exit 1. |
| NN4 | Scoped ask/note help prints the cap from `SIGNAL_BODY_MAX`; session start puts `--foreground` on its synopsis line. Updated MCP and shifted CLI timeout citations, plus seven `src/cli.ts` citation anchors. Added the `profile_registry_invalid` MCP sentence. The four previously red gate files and the focused MCP sentence test pass. | Removed scoped cap or MCP sentence, or restored either stale citation: each corresponding focused test exit 1. The session synopsis reversion is the NN2 probe. |
| NN5 — **superseded by Fold 8** | Fold 8 restores main's `Date.parse`-finite acceptance and original invalid-value error. The time-zone example is guidance in help only. | The earlier strict-seconds probe no longer defines the accepted set. |
| NN6 | Removed the `profile.*` filter from the main baseline fixture generator. Added only 12 profile rows to the existing 1,330-row fixture, with 1,342 total. A focused inventory test names core, policy, and selected-error rows. | Reintroduced the policy filter: inventory test exit 1. |
| NN7 | The cleanup control uses an existing `/tmp/lane-home-*` directory that the helper did not create, plus an empty path. | Removed the created-path guard: cleanup control exit 1. |
| NN8 — **superseded by Fold 4** | MCP maps `profile_path_invalid` through `profilePathRemedy()` at call time. Its example uses `~/.cswarm` and never includes the operator's home path. | Replaced the call-time remedy with the fixed table sentence: profile remedy test exit 1. |
| NN9 — **superseded by Fold 4** | Listen provider and permission choices and feedback kinds render from the constants their parsers use. | Replaced each rendered list, then the listener provider validator, with literals in separate probes: each typed-value test exit 1. |

Mutation measurement: 17 focused reversion probes had an exit-0 positive control in the same invocation and then exited 1 on the intended assertion; every source and fixture edit was restored. Three initial probes exposed gaps in the new tests (listener table linkage and source linkage for provider/kind); those tests were strengthened and all three probes then failed as intended.

Verification in this lane: `npm run build` exit 0; `npm run check:tests` exit 0; seven focused P1 CLI files passed 63/63 under one temporary HOME, but that run omitted the red `feedback-verb` and `unknown-flag-message` tests; targeted setup, MCP connect, and MCP sentence tests passed 3/3. The final recorded dispatcher baseline passed 5/5 over 1,342 rows in its own temporary HOME. The JSON fixture diff adds 184 lines and removes none, so the original 1,330 recorded rows remain bytewise intact. No production host or real workspace was contacted. The local-edge server test, full suites, edge check, release bundle, and site build remain for the lead. The inbox field report's original cause remains an inference until the lead runs the local-edge comparison.

The final `pgrep` process check returned exit 3 (`sysmond service not found`), so process enumeration was not established in this sandbox. All lane test commands returned and their temporary HOME directories were removed.

## Fold 4 — round 3 Opus rulings and lead gate repairs

At `46bdba1c`, Opus Round 3 returned FAIL. The lead measured `npm test` 990/990 and `test:p1-cli` 1020/1022; the two failures were feedback refusal wording and stdin/file help parity. The ten rulings below also address Opus findings 3–10. Opus finding 11 identified the inaccurate Fold 3 claims corrected above. The recorded dispatcher fixture remains the refusal control: its original 1,342 rows were retained, and one `--device` row was added (1,343 total, 43 zero, 1,300 nonzero). This lane did not run the full dispatcher or P1 CLI suites.

| Ruling / Opus finding | Change | Focused test | Reversion measurement |
|---|---|---|---|
| RR1 / 3 — **superseded by Fold 5** | Exported the accepted flag arrays used by all `assertShape` sites in `src/cli.ts` and `src/onboarding-cli.ts`. Help reads a separate map, with variant-specific options; parser table flags remain unchanged. `resume` omits stdin and session context, `dogfood` omits refused task flags and JSON, and `command` shows `--repo-mapping-id` without JSON. | `command-table-gates` enumerated handler shapes and help map rows, but did **not** bind each row to its handler. The rendered tests compared output with the map that built it, so they were circular. | Restored broad dogfood help flags: named test failed 1/1. That probe did not establish per-handler or per-variant correctness. Fold 5 replaces the claim. |
| RR2 / 1 | Restored the byte-for-byte feedback refusal through the shared Oxford-comma `formatOrList(FEEDBACK_KINDS)`. Channel, file and brain generated natural lists also use the joiner. | `feedback-verb`: invalid kind refusal. | Restored the comma-only join: failed 1/1. |
| RR3 / 2 | Session start remains a file-only credential help site because `runSession` refuses stdin and needs the stable token file. The parity test names this code path and checks the synopsis. | `unknown-flag-message`: stdin/file parity. | Re-advertised stdin in the start synopsis: failed 1/1. |
| RR4 / 4 | Session enable, disable and recover synopses mark `--workspace-id` optional; start has no stdin help. | `command-table-gates`: session help shapes. | Made human workspace ID required in help: failed 1/1. |
| RR5 / 5 | Removed the Fold 3 `KNOWN_FLAGS` additions, keeping bare unknown options' prior wording. Added a recorded `target show --url <loopback> --device` dispatcher row. | Focused dispatcher row checks exact exit, stderr and fixture. | Re-added `device` to `KNOWN_FLAGS`: failed 1/1. |
| RR6 / 6 | `profilePathRemedy` builds its private example with exported `agentProfilePath` and placeholder IDs. | `profile-ls`: example matches builder and source calls it. | Restored a literal example: failed 1/1. |
| RR7 / 7 — **symlink claim superseded by Fold 5** | A damaged registry is renamed once to `profile-paths.json.damaged-<UTC stamp>`, named in one message, then rebuilt. Registry failure remains advisory after profile save. The symlink remedy existed in code but had no reaching test in Fold 4. | `profile-ls`: backed-up bytes, one backup, no repeat warning, 0600 profile, walk continuation, mode and injected `EACCES` write failure. Setup and MCP connect focused cases also pass. | Restored throw on damaged registry: failed 1/1. No Fold 4 symlink mutation was measured. |
| RR8 / 8 — **help claim superseded by Fold 5** | Listener validation reads `LISTENER_PROVIDERS` through `isListenerProvider`; listener type derives from that array. Fold 4 help still read `SESSION_PROVIDERS`. | Type-level assignment of session providers to listener provider IDs, plus runtime source and set checks. | Added a session-only provider: `check:tests` exited 2 at the type assignment. That probe did not cover help. |
| RR9 / 9 | Date-only test asserts the Node-accepted `2026-09-25Z` form unconditionally. | `inbox-since`: offset parsing. | Refused date-only values in `checkedSince`: failed 1/1. |
| RR10 / 10 | The new MCP inventory HOME and the unowned cleanup control use guarded test helpers. | `profile-ls`: helper usage and ownership refusal. | Restored the raw MCP fixture directory: failed 1/1. |

Each listed mutation had an exit-0 positive control and the failing reversion in the same invocation, under a fresh `/tmp/lane-home.XXXXXX` HOME, then restored the source. No production host or real workspace was contacted. Final lane gates: `npm run build` and `npm run check:tests` exit 0; eight focused CLI invocations passed 38/38 tests. The lead still owns `npm test`, full `test:p1-cli`, edge check, release bundle, site build, and the local-edge server test. The original inbox field report's cause is not established until the lead runs that local-edge comparison. The full 1,343-row dispatcher baseline is also not established by this lane.

**Fold 4 focused-run correction:** the evidence retained only the count “eight focused CLI invocations”, not the names of all eight files. That 38/38 figure cannot be reconciled to a complete file list and omitted the four red files named in Round 4. It is superseded by the explicit Fold 5 file list below.

## Fold 5 — Round 4 Codex and Opus rulings

Both `scratchpad/itemK/codex-r4.md` and `scratchpad/itemK/opus-r4.md` were read in full. The only production changes in this fold affect help rendering; `src/onboarding-cli.ts` shares its existing hook refusal condition with the help filter without changing that refusal. The existing `KNOWN_FLAGS` and dispatch acceptance remain the recorded control. The help-only claim is superseded by Fold 6's shared refusal lists.

| Ruling | Change | Focused test | Reversion measurement |
|---|---|---|---|
| VV1 — **refusal-list linkage superseded by Fold 6** | Removed refused flags from `listen start`, `logout`, `inbox --follow`, and `accept --link-stdin` help. Listen provider help reads `LISTENER_PROVIDERS`; check hook help reads the list its handler refuses. | `command-table-gates`: rendered single and variant flags, provider source, and shared check refusal. | Six separate source reversions: each positive exit 0, reverted exit 1. |
| VV2 — **direct-row binding superseded by Fold 6** | Bound direct help rows to the named handler's source constant; variant rows resolve the handler and its exported shape constant, then compare that constant with flags parsed from rendered help. The site count is exactly 67. | `command-table-gates`: direct row and 14 variant cases. | Swapped `file.rm` help to `FILE_GET_ACCEPTED_FLAGS`: positive exit 0, reverted exit 1. |
| VV3 — **body-spread guard superseded by Fold 6** | Moved the seven CLI citation lines and the revoke, body and attachment source pins to the extracted constants. `BODY_FLAGS` and `attach` remain asserted. | `citation-drift`, `agent-revocation-cli`, `message-formatting`, `signal-attachments`. | Four separate reversions: each positive exit 0, reverted exit 1. |
| VV4 | Corrected the `KNOWN_FLAGS` comment and tested each advertised bare flag with its refusing command and named handler, plus the unadvertised `--device` refusal. | `unknown-flag-message` named test. | Added `device` to `KNOWN_FLAGS`: positive exit 0, reverted exit 1. |
| VV5 — **superseded by Fold 6** | Updated every `src/cli.ts` timeout citation and checked all ten mapped CLI citation occurrences against their source lines. This incorrectly treated shipped citations as HEAD citations. | `timeout-table` named test. | Shifted both margin citations one line: positive exit 0, reverted exit 1. |
| VV6 | Deleted unused `parseCommandOptions` and its false comment. Marked `registryWrite` as a test-only failure seam. | `command-table-gates` dead parser check; `profile-ls` injected write failure. | Reintroduced the dead function: positive exit 0, reverted exit 1. |
| VV7 | Corrected Fold 4's row-binding, circular-test, listener-provider, symlink and focused-run claims here. Added a symlinked inventory-root case that checks the post-save message and saved profile. | `profile-ls` symlink test. | Changed the real-directory remedy: positive exit 0, reverted exit 1. |

Mutation probes: 15/15 final probes passed after correcting two probe anchors (the initial citation probe pointed to another valid import line; the first timeout probe did not account for two matching rows). Each final probe ran its positive control and reverted source in the same invocation under a fresh temporary HOME, then restored the file. No production host or real workspace was contacted.

Fold 5 gates: `npm run build` exit 0; `npm run check:tests` exit 0; `command-table-gates.test.ts`, `agent-revocation-cli.test.ts`, `message-formatting.test.ts`, `signal-attachments.test.ts`, `profile-ls.test.ts`, and `citation-drift.test.ts` passed together, 75/75, under a temporary HOME. The named `unknown-flag-message.test.ts` and `timeout-table.test.ts` checks each passed 1/1 under a temporary HOME. A fixture comparison against `d437c291` found all 1,330 original dispatcher rows unchanged and 13 added rows, 1,343 total.

Not established here: full `npm test`, full `test:p1-cli`, edge check, release bundle, site build, local-edge server test, and the full 1,343-row dispatcher execution remain with the lead. A full local run of `unknown-flag-message.test.ts` reached an unrelated `ps` call that this sandbox denies with `EPERM`; the changed named test passed. The inbox field report's server cause remains unmeasured until the lead runs the local-edge comparison.

## Fold 6 — Round 5 Codex and Opus rulings

Both round-5 reviews were read in full. The lead's 7c6bcae2 gate report was 990/990 for `npm test` and 1,032/1,032 for P1 CLI; this lane did not rerun either suite. The changes below replace the superseded Fold 5 claims above.

| Ruling | Change | Focused test | Reverted behavior measured |
|---|---|---|---|
| YY1 — **ref fallback superseded by Fold 7** | Restored all five shipped `v0.1.71` CLI citations from `main`, byte for byte. The working-tree citation check now visits `refs.HEAD` only. | `timeout-table`: shipped section equals `git show main:scripts/timeout-table/mapping.json`. | Restored Fold 5's shipped section: control exit 0, mutation exit 1. |
| YY2 — **literal and kind binding superseded by Fold 7** | Direct help rows compare their constant names to the shape selected by their handler branch; multi-action branches are checked in the AST. Help rows contain no array literals, including one-literal spread arrays. | `command-table-gates`: direct row, multi-action branch, and literal ban. | Substituted the revoke constant for `invite.create`, then appended `"bogus"` to the feedback row in separate probes: each control exit 0, mutation exit 1. |
| YY3 — **inbox and added-flag linkage superseded by Fold 7** | Exported refusal lists now feed the handlers and help getters for listener start, session start, logout, check message and hook, inbox follow, and invite-link stdin. Help is recomputed from each list. | `command-table-gates`: remove a flag from each list in memory and check that it reappears in its own help section; source check requires handler use. | Replaced logout's list-backed filter with a typed `"device"` exclusion: control exit 0, mutation exit 1. |
| YY4 — **note and ask coverage superseded by Fold 7** | Restored the AST guard against spreading another body flag list beside `BODY_FLAGS`. The two unknown-option CLI probes in that test now pass an explicit loopback `--url`. | `message-formatting`: body source runtime gate. | Added `...BODY_BOOLEAN_FLAGS` beside `...BODY_FLAGS`: control exit 0, mutation exit 1. |
| YY5 | Refreshed only the `profile.refusal` baseline stderr with current generated help. | `command-dispatch-baseline`: stored profile refusal help equals current `usage()`. | Restored the stale Fold 5 row: control exit 0, mutation exit 1. |
| YY6 — **HEAD stdin label superseded by Fold 7** | Moved HEAD onboarding citations to the current stdin timer line 73 and hard-exit line 94, and checked both against `src/onboarding-cli.ts`. Shipped citations stay fixed. | `timeout-table`: HEAD CLI and onboarding citation lines. | Restored the HEAD hard-exit citation to line 106: control exit 0, mutation exit 1. |

The seven reversal probes each ran a positive control and then the named failing test under one fresh `/tmp/lane-home.XXXXXX` HOME; source and fixture bytes were restored after each probe. Final focused tests: `command-table-gates.test.ts` 28/28, two named `timeout-table.test.ts` tests 2/2, the named `message-formatting.test.ts` test 1/1, and the named `command-dispatch-baseline.test.ts` test 1/1. `npm run build`, `npm run check:tests`, and `git diff --check` exited 0. The fixture has 1,343 rows: all 1,330 `main` rows are equal, with 13 added rows; only `profile.refusal` changed within the added rows. An initial body-source test invocation inherited two pre-existing CLI probes without `--url`; both refused the unknown flag before target selection. They now pass `http://127.0.0.1:9`, and the final run used that form.

Not established by this lane: full `npm test`, full `test:p1-cli`, edge check, release bundle, site build, local-edge server test, and full dispatcher baseline execution. The lead owns those gates. No production host or real workspace was contacted. The final `pgrep` check returned exit 3 (`sysmond service not found`), so process enumeration was unavailable; all lane test commands returned and their temporary HOME directories were removed.

## Fold 7 — Round 6 Opus rulings

Opus Round 6 was read in full. Codex Round 6 passed; Opus found one production refusal regression and seven low-rigour findings. The original 1,330 `main` dispatcher row JSON spans are byte-identical; one recorded notify/follow row brings the fixture to 1,344 rows (43 zero, 1,301 nonzero). The added probe passes an explicit loopback `--url`. No production host or real workspace was contacted.

| Ruling | Change | Focused behavioral test | Reverted behavior measured |
|---|---|---|---|
| AD1 | Removed the new notify/follow refusal. `--notify` remains the mode selector; the follow refusal list excludes it and follow help hides the selector separately. | Dispatcher row `inbox.notify-over-follow` pins `cswarm: unknown option: --follow` and handler trace. | Reinserted the new refusal: control exit 0, mutation exit 1. |
| AD2 | Listener route and inbox follow check the actual members of their refusal lists. A synthetic in-process addition is refused and disappears from rendered help. The three existing inbox refusal sentences and channel precedence are asserted. | `command-table-gates`: added refusal flags reach listen and inbox handlers. | Disabled each list's added member in separate probes: both control exit 0, mutation exit 1. |
| AD3 | Help getters and variant exclusions read constants, including `defer-over`, `device`, and selector flags. The AST gate rejects inline flag strings in direct and variant help rows. | `command-table-gates`: direct-row and variant literal gates. | Added an array literal to a direct row, then an inline variant exclusion: both control exit 0, mutation exit 1. |
| AD4 | The AST gate binds the working-on, ask, and note branches inside `postSignalAllowedFlags` to their selected shapes. | `command-table-gates`: post-signal kind branches. | Swapped the ask and note lists: control exit 0, mutation exit 1. |
| AD5 | The shipped-section check chooses local `main` or `origin/main` through one helper; its fallback also reads the remote-tracking section. | `timeout-table`: shipped section byte identity and origin-only fallback. | Made the fallback return `main`: control exit 0, mutation exit 1. |
| AD6 | The body-spread AST guard visits note and ask in addition to working-on and reply. | `message-formatting`: body source runtime gate. | Added a foreign body spread to note and ask separately: both control exit 0, mutation exit 1. |
| AD7 | The route comment again sits above its function. The HEAD onboarding timer row says hook-stdin; the shipped section remains byte-identical to main. | `command-table-gates`: comment placement; `timeout-table`: hook timer label. | Moved the comment and restored the setup-stdin label separately: both control exit 0, mutation exit 1. |

All 11 Fold 7 mutation probes ran a positive control and a single reversion under a fresh temporary HOME, then restored source bytes. The measured exit pattern was control 0 and mutation 1 in every case.

Final permitted gates: `npm run build` exit 0; `npm run check:tests` exit 0; `command-table-gates.test.ts` 32/32; three selected `timeout-table.test.ts` tests 3/3; the named `message-formatting.test.ts` body source test 1/1; and two selected `command-dispatch-baseline.test.ts` tests 2/2. Each CLI test invocation used `env HOME="$T"` with a fresh `/tmp/lane-home.XXXXXX` directory and removed only that directory. `git diff --check` exited 0. A selected `citation-drift.test.ts` test failed on four unrelated identity-client citations: their mismatches are present at `97e52bb6` before Fold 7 (`classifyClaudeCanaryFailure` at 418 rather than cited 417; Claude/Codex/OpenCode executable sites at 6442/6468/7112 rather than cited 6433/6459/7103). Fold 7 moves those latter source lines by two more lines; the identity-client test and citations are outside this item K fold.

Not established here: full `npm test`, full `test:p1-cli`, edge check, release bundle, site build, local-edge server test, and the full 1,344-row dispatcher execution. The lead owns those gates. The inbox field report's original server cause also remains unmeasured. Final `pgrep` returned exit 3 (`sysmond service not found`), so process enumeration was unavailable; all commands started by this lane had returned before this check.

## Fold 8 — Round 7 Codex and Opus rulings

Both round-7 reviews were read in full. The Fold 2 JJ7 naive-timestamp refusal is **REVERSED**: this fold restores main's `Date.parse`-finite acceptance and its exact invalid-value error for shared read, feed, and inbox paths. Time-zone advice is generated from the single `INBOX_SINCE_EXAMPLE` constant and appears in help only. The Fold 7 claim that the three inbox refusal sentences had complete parity is superseded by AG2 below. The Fold 7 help-only selector constants and narrow synopsis stripping are superseded by AG5 and AG7.

| Ruling | Change | Behavioral test | Reversion measurement |
|---|---|---|---|
| AG1 — **refusal-order coverage superseded by Fold 9 AI1** | `checkedSince` returns every finite `Date.parse` value unchanged; invalid values again say `--since must be an ISO-8601 timestamp`. Fold 8 left its CLI validation too early; Fold 9 moves it after target, credential, and query arguments. The local-edge comparison remains prepared. | `inbox-since`: accepted naive, date, offset, and RFC forms; mock read and feed requests preserve the original value. | Reinstated the offset-only check: control exit 0, reverted exit 1. Fold 9 tests refusal order separately. |
| AG2 | The follow refusal list reads `wait` through `Arguments.optional`, preserving the repeated-value error before the follow combination error. | Recorded loopback fixture `inbox.follow.repeated-wait` asserts exact `cswarm: --wait may only be provided once` and handler trace. | Restored `args.has` for every list member: control exit 0, reverted exit 1. |
| AG3 | One help-description builder reads each entry's `cliOnlyFlags`; note, ask, and reply now describe `--attach` truthfully. | `command-table-gates` enumerates every visible entry, compares synopsis attachment flags with entry flags, and checks the rendered sentence. | Removed the builder's attachment clause: control exit 0, reverted exit 1. |
| AG4 | Listener route refusal receives parsed arguments and checks every member of `LISTEN_START_REFUSED_FLAGS`; inbox follow still checks every member, with the main `wait` read. Both generic sentences are exercised by synthetic additions. | `command-table-gates` adds `poll-interval` to the listener list and `about` to the inbox list, then checks refusal and help. | Disabled the listener's parsed-argument read: control exit 0, reverted exit 1. |
| AG5 | The check and inbox dispatchers read the same selector constants as help. `force` is a separately named hidden flag, not a selector. | `command-table-gates` mutates selector members in memory and verifies that branch selection and help both follow the new member; it verifies `force` stays in check messages. | Restored a check dispatcher literal: control exit 0, reverted exit 1. |
| AG6 | The shipped-section test reads local `main` when present, otherwise `origin/main`; it no longer unconditionally reads the remote. | `timeout-table` injects both ref inventories and compares the shipped section with the chosen available ref. | Forced the local-main case to choose the remote: control exit 0, reverted exit 1. |
| AG7 — **outer nested group claim superseded by Fold 9 AI5** | Synopsis filtering applies to all entries and bracket groups. Fold 8 missed an outer refused flag when its nested flag was accepted; Fold 9 adds that case. The redundant body-test `continue` is gone. | `command-table-gates` checks one, multiple, and nested groups; Fold 9 adds outer-refused nesting. | Restored the one-flag filter: control exit 0, reverted exit 1. Fold 9 restores the full old filter as a further mutation. |

Each mutation used a positive control and a single reverted behavior in one invocation under a fresh `T=$(mktemp -d /tmp/lane-home.XXXXXX)` with `env HOME="$T"` on each test command. Source bytes were restored after every probe and only that temporary directory was deleted. The focused CLI fixtures carry loopback `--url`. HEAD timeout citations were refreshed for the moved `src/cli.ts` lines; the shipped `v0.1.71` section remains byte-identical to main.

The dispatcher fixture has 1,345 rows (43 zero, 1,302 nonzero). Its original 1,330 main rows are byte-identical; the diff against main consists only of whole added rows. The pre-existing added `profile.refusal` row was refreshed for the truthful help text. No production host, real workspace, or migration was contacted or changed.

Final permitted gates: `npm run build` exit 0; `npm run check:tests` exit 0; `command-table-gates` plus `inbox-since` 42/42; five named tests across the dispatcher baseline, timeout table, and message formatting files 5/5; `git diff --check` exit 0. The seven mutation controls each exited 0 and their reverted versions each exited 1. The fixture diff against main is 236 additions and zero removals. The local-edge server test, full suites, edge check, release bundle, site build, and full 1,345-row dispatcher run are not established here; the lead owns them. `pgrep` was attempted and returned exit 3 (`sysmond service not found`), so process-list enumeration was unavailable. Every test command returned and its temporary home was removed.

## Fold 9 — Round 8 Codex and Opus rulings

Both round-8 reviews were read in full. The Fold 2 JJ8 timestamp continuation, Fold 8 AG1 refusal-order coverage, and Fold 8 AG7 outer nested group claim are marked superseded above. The shipped `v0.1.71` timeout mapping remains byte-identical to `main`.

| Ruling | Change | Behavioral test | Reversion measurement |
|---|---|---|---|
| AI1 | Removed `checkedSince` before `target()` and moved the agent workspace lookup after `queryBase` parses `--about`, `--kind`, and `--limit`. Human reads retain validation in `readSignals`; agent inbox validates after those earlier refusals and before the new directory check. Added two loopback dispatcher rows. | `since validation preserves target and kind refusal order` checks missing anon key before invalid `--since`, and invalid agent `--kind` before invalid `--since`. | Restored the early `checkedSince` call: control exit 0, reverted exit 1 on the feed row. |
| AI2 | The drain still pages by `(after_created_at, after_id)`. Its cap notice now gives the exact last timestamp and ID, says that the original `--since` re-reads that timestamp, and points to `inbox --follow` for ordered reading. | `inbox drain stops at the exact cursor and explains equal-timestamp rereads` uses 1,100 rows with the same timestamp and checks both request cursor fields and the notice. | Restored the timestamp-only rerun sentence: control exit 0, reverted exit 1. |
| AI3 | Injected fixture HOME for existing setup, MCP connect, channel, Grok Bot, and MCP stdio saves; channel child processes receive the fixture HOME. The server comparison sets HOME and `SWARM_AGENT_STATE_DIR` before its in-process check and asserts them. A spy control runs the in-process registry and credential checks under an empty enclosing HOME, verifies it stays empty, and rejects real or enclosing homes from observed path builders. | `item K registry and credential checks use fixture homes and leave their enclosing HOME empty`; direct setup and MCP connect tests. | Removed the onboarding fixture HOME assignment: control exit 0, reverted exit 1 because the enclosing HOME acquired `.cswarm`. This reproduces the Fold 8 isolation defect without touching the real home. |
| AI4 | Refreshed `citation-drift` to the final `src/cli.ts` line positions. The three executable citations moved from the review's 6445, 6471, 7116 to 6447, 6473, 7118 after the Fold 9 source edits; the four nearby import/classifier citations resolve at their original lines. | `every file:line this lane cites still points at what it claims` passes after the final source edits. | Restored the three stale executable positions: control exit 0, reverted exit 1. |
| AI5 | `visibleUsageHint` walks nested bracket groups and removes an outer group when its own flag is refused, even when an inner flag is accepted. | `usage synopsis removes any refused bracket group` includes `[--thread [--broadcast-to-channel]]` with only `thread` refused. | Restored the Fold 8 function: control exit 0, reverted exit 1. |
| AI6 | Corrected the three HEAD `src/cloud/signals.ts` timeout citations to lines 38 and 929, 929, and 1042, and shifted the five HEAD CLI citations moved by Fold 9. | `HEAD signal read citations resolve for each mapped row` checks all three cited rows against their source lines; the existing HEAD CLI citation test also passes. | Restored the stale HEAD `timeoutMs` citation: control exit 0, reverted exit 1. |

Every mutation above ran a positive control and its negative probe in one invocation under `env HOME="$T"`, using a temporary `/tmp/lane-home.XXXXXX` directory; source bytes were restored before the next probe. The two new dispatcher rows were inserted whole: `git diff --numstat d437c291` shows 270 added and zero removed fixture lines. All 1,330 `main` rows compare equal by ID and value; the fixture now has 1,347 rows (43 zero, 1,304 nonzero).

Final permitted gates: `npm run build` exit 0; `npm run check:tests` exit 0; five focused CLI files passed 51/51, two selected dispatcher tests passed 2/2, and three selected timeout mapping tests passed 3/3, each under temporary HOME. `citation-drift.test.ts` was included in the 51/51 run after the final `src/cli.ts` edit. `git diff --check` exit 0. `pgrep` could not enumerate processes because `sysmond` is unavailable (exit 3); every lane command returned and its temporary HOME was removed.

The complete local-edge server comparison and the whole-file K CLI sweep are not established in this lane. The server comparison needs the lead's exclusive local stack. Several existing dispatcher and CLI tests intentionally invoke local refusals without a loopback `--url`; the hard rule against running such commands prevents using them for a whole-file HOME sweep here. The focused HOME control runs the two in-process save/check paths that exposed the incident. The lead also owns the full suites, edge check, release bundle, and site build. No production host, real workspace, or real home path was contacted.

## Fold 10 — Round 9 rulings

Round 9 Codex passed with one follow-up; Opus found one verified production blocker. `FOLLOW-UPS.md` accounts for the non-blocking round 8 and 9 findings.

| Ruling | Change | Behavioral test | Reversion measurement |
|---|---|---|---|
| AN1 | `agent-connection-token` and every `item-i-profile-binding` fixture now set HOME to their own temporary directory before profile writes and restore it afterward. The item I snapshot compares files after the inventory directory appears. A structural control scans every test file, reconciles the ten files importing profile writers or spawning setup/connect commands, and checks fixture HOME at the calls. | The connection-token setup test reads the registered paths under its fixture HOME; the item I receive test checks a saved profile's inventory there; the item I file passes 20/20. | With both test files restored from `895a0782`, the structural control exits 1 and names the connection-token call plus eight item I test paths. The positive control exits 0 in the same temporary HOME. |
| AN2 | The cap notice builds one printed `cswarm inbox --follow --ndjson` step from the original `--since` and explicit target flags. The same builder serves text and JSON notices. | `inbox-since` extracts the printed command and passes its words to `Arguments`, checking follow, ndjson, since, and loopback target flags. | Removing `--ndjson` from the builder gives control exit 0, mutation exit 1 in the same temporary HOME. |

The Fold 10 CLI addition shifted three `citation-drift` lines and five HEAD timeout-map CLI citations by nine lines. Their pointers were refreshed; the shipped `v0.1.71` timeout section remains byte-identical to `main`.

Permitted gates: `npm run build` exit 0; `npm run check:tests` exit 0; named connection-token setup 1/1; item I profile binding 20/20; inbox since 8/8; item K HOME control 2/2; citation drift 3/3; named timeout-map checks 2/2. Each lane test command used `T=$(mktemp -d /tmp/lane-home.XXXXXX)` and `env HOME="$T"`, then removed only that directory. An initial item I run found and fixed the snapshot's directory-read error; an initial citation run found and fixed the nine-line drift. `git diff --check` exited 0.

Not established here: full `npm test`, full P1 CLI, edge check, release bundle, site build, server tests, and the complete dispatcher baseline. Host rules reserve those gates for the lead and forbid Docker, Supabase, and browser tests on this machine. No production host or real workspace was contacted.

## Fold 11 — Round 10 AQ1

Codex and Opus round 10 identified the same production defect in the cap notice: the printed follow step lost the stdin credential, session binding, and filters, and profile expansion exposed the derived raw target flags. The lead ruled AQ1 blocking. Only that behavior, its tests, moved citations, and the two named follow-ups changed.

| Ruling | Change | Behavioral test | Reversion measurement |
|---|---|---|---|
| AQ1 | The notice walks the options captured by `Arguments` before profile expansion. It carries the original credential source, profile, host session ID, session context, and follow-compatible filters. It derives support from the inbox read accepted flags, command table flags, and follow refusal flags. One stated drop rule removes the one-shot limit and output shape; `--since` keeps its value. A refused read-changing option such as `--channel` or `--wait` produces a cannot-carry notice. Stdin guidance says to pipe the same token again. | `inbox-follow-step.test.ts` enumerates the accepted read flags, runs capped reads and their printed follow steps through the real CLI dispatcher with a temporary loopback server, checks the stdin bearer and each supported filter, checks profile and host binding without expanded credentials, and verifies session-context and channel behavior. | Rebuilt `src/cli.ts` from `d4d7a613`, ran the four focused tests under temporary HOME, and observed 0/4 pass. The control on Fold 11 passed 4/4. Source and build were restored after the baseline probe. |

`citation-drift.test.ts` passed 3/3 after three moved CLI pointers were updated. Five HEAD timeout mapping CLI pointers moved with the same source edit; its selected citation check passed 1/1. The shipped `v0.1.71` timeout section was untouched.

Permitted gates: `npm run build` exit 0; `npm run check:tests` exit 0; `inbox-follow-step`, `inbox-since`, and `citation-drift` together 15/15; selected HEAD timeout citation check 1/1. Each lane test invocation used a fresh `env HOME="$T"` with `T` under `/tmp/lane-home.XXXXXX` and removed only that directory. The follow children terminated and the test loopback servers closed. No production host or real workspace was contacted.

Not established here: full `npm test`, full P1 CLI, edge check, release bundle, site build, server tests, and the complete dispatcher baseline. The lead owns those gates.

## Merge with main after items M and G lane 2b (2026-09-26)

The merge commit at `1db6102c` deliberately stored conflict markers. The pre-fix acceptance command exited 1 and named all eight conflicted files. The resolution combined the parent changes, with the post-check corrections recorded below:

- `src/cli.ts`: kept K’s command-table-generated global/scoped help and profile inventory, retained M’s `--clear-pending` recovery handler, and declared both normal-connect and recovery help variants in the table. Listener status and stop use separate constants; an explicit status `--wait` precheck validates against the stop set first, preserving main’s dedicated refusal and later-flag order. Lane 2b did not change the listen-status flags. Imports retain K’s onboarding enums and inventory plus lane 2b’s live-session verification.
- `src/cloud/agent-profile.ts`: kept K’s root/registry/listing behavior and M’s pending-connect refusal, orphan recovery, exclusive credential write, attempt marker, and connect-before-setup lock ordering. Registry recording runs after the crash-safe save. The sixth argument accepts K’s test-only registry writer or M’s boolean orphan flag, preserving both existing call shapes without adding a second lock implementation.
- `src/cloud/mcp-connect.ts`: kept M’s pending/completion recovery, reserved-path preflight, and default pending-attempt search; default paths now use K’s shared `agentProfileRoot()`. All locks continue through lane 2b’s `withFileLock` module, and the preflight retains lane 2b’s validator for that module’s own symlink-published owner file.
- `src/onboarding-cli.ts`: kept K’s exported accepted-flag constant and added lane 2b’s `--url` to that constant, preserving the target-mismatch preflight.
- Timeout mapping/tests: retained both parents’ rows and tests, then re-pinned every merged CLI, onboarding, MCP, wake-release, and signal-read citation to the resolved source. The merged timeout test’s parent-specific set-timeout assumptions were updated for lane 2b’s listener-stop timer preceding K’s hook timer.
- Citation drift: retained all seven checks and re-pinned them to the resolved lazy host imports/classifier and executable-resolution calls.
- MCP tests: retained M/lane 2b’s filesystem, recovery, lock, credential, and error imports plus K’s isolated-home helpers. The resolved file passes all 105 tests.
- Command-table assertions outside the marker hunks were updated only where the merged listener path invalidated their one-shared-constant assumption; status and stop are now checked against their distinct accepted-flag constants.

The dispatch fixture initially failed only its current-help pin, which authorized the specified regeneration command. K’s baseline test masks generated help, so K’s fixture still contained stale hand-written help even though K’s runtime generated it from the command table. Regeneration therefore rewrote 338 existing row values and added no rows beyond K’s already-present inventory.

#### Rows different from both parents

The regenerated fixture has 1,347 rows, matching item K; main has 1,330. Exactly 338 resolved rows differ from both parents. The 332 rows in the first block differ only in `stderr`, because these refusals print the complete generated help. The regenerated help reflects K’s command table plus main’s merged additions: the second `mcp connect --clear-pending` synopsis, listen-stop `--state-dir` and `--wait`, resume-profile `--url`, and inbox-notify `--take-over`. Listen status had no lane 2b flag change. The stored fixture still renders its accepted `--state-dir` in the synopsis and omits it from Additional options; the post-check source fix described below was intentionally not regenerated into the fixture. The five rows in the second block differ only in `stdout` for the same generated-help reason. The final `profile.refusal` row is absent from main and exists in K, but its `stderr` now contains that same generated help. No recorded argv changed.

`stderr` rows (332):

```text
refusal.unknown-verb
refusal.prototype-verb.constructor.plain
refusal.prototype-verb.constructor.json
refusal.prototype-verb.__defineGetter__.plain
refusal.prototype-verb.__defineGetter__.json
refusal.prototype-verb.__defineSetter__.plain
refusal.prototype-verb.__defineSetter__.json
refusal.prototype-verb.hasOwnProperty.plain
refusal.prototype-verb.hasOwnProperty.json
refusal.prototype-verb.__lookupGetter__.plain
refusal.prototype-verb.__lookupGetter__.json
refusal.prototype-verb.__lookupSetter__.plain
refusal.prototype-verb.__lookupSetter__.json
refusal.prototype-verb.isPrototypeOf.plain
refusal.prototype-verb.isPrototypeOf.json
refusal.prototype-verb.propertyIsEnumerable.plain
refusal.prototype-verb.propertyIsEnumerable.json
refusal.prototype-verb.toString.plain
refusal.prototype-verb.toString.json
refusal.prototype-verb.valueOf.plain
refusal.prototype-verb.valueOf.json
refusal.prototype-verb.__proto__.plain
refusal.prototype-verb.__proto__.json
refusal.prototype-verb.toLocaleString.plain
refusal.prototype-verb.toLocaleString.json
refusal.group.hook.missing.plain
refusal.group.hook.missing.json
refusal.group.hook.unknown.plain
refusal.group.hook.unknown.json
refusal.group.listen.missing.plain
refusal.group.listen.missing.json
refusal.group.listen.missing.profile-valid
refusal.group.listen.missing.profile-valid-json
refusal.group.listen.unknown.plain
refusal.group.listen.unknown.json
refusal.group.listen.unknown.profile-valid
refusal.group.listen.unknown.profile-valid-json
refusal.group.session.missing.plain
refusal.group.session.missing.json
refusal.group.session.missing.profile-valid
refusal.group.session.missing.profile-valid-json
refusal.group.session.unknown.plain
refusal.group.session.unknown.json
refusal.group.session.unknown.profile-valid
refusal.group.session.unknown.profile-valid-json
refusal.group.channel.missing.plain
refusal.group.channel.missing.json
refusal.group.channel.missing.profile-valid
refusal.group.channel.missing.profile-valid-json
refusal.group.channel.unknown.plain
refusal.group.channel.unknown.json
refusal.group.channel.unknown.profile-valid
refusal.group.channel.unknown.profile-valid-json
refusal.group.file.missing.plain
refusal.group.file.missing.json
refusal.group.file.missing.profile-valid
refusal.group.file.missing.profile-valid-json
refusal.group.file.unknown.plain
refusal.group.file.unknown.json
refusal.group.file.unknown.profile-valid
refusal.group.file.unknown.profile-valid-json
refusal.group.brain.missing.plain
refusal.group.brain.missing.json
refusal.group.brain.missing.profile-valid
refusal.group.brain.missing.profile-valid-json
refusal.group.brain.unknown.plain
refusal.group.brain.unknown.json
refusal.group.brain.unknown.profile-valid
refusal.group.brain.unknown.profile-valid-json
refusal.group.grant.unknown.plain
refusal.group.grant.unknown.json
refusal.group.link.missing.plain
refusal.group.link.missing.json
refusal.group.link.unknown.plain
refusal.group.link.unknown.json
refusal.prototype-sub-action.hook.constructor.plain
refusal.prototype-sub-action.hook.constructor.json
refusal.prototype-sub-action.hook.__defineGetter__.plain
refusal.prototype-sub-action.hook.__defineGetter__.json
refusal.prototype-sub-action.hook.__defineSetter__.plain
refusal.prototype-sub-action.hook.__defineSetter__.json
refusal.prototype-sub-action.hook.hasOwnProperty.plain
refusal.prototype-sub-action.hook.hasOwnProperty.json
refusal.prototype-sub-action.hook.__lookupGetter__.plain
refusal.prototype-sub-action.hook.__lookupGetter__.json
refusal.prototype-sub-action.hook.__lookupSetter__.plain
refusal.prototype-sub-action.hook.__lookupSetter__.json
refusal.prototype-sub-action.hook.isPrototypeOf.plain
refusal.prototype-sub-action.hook.isPrototypeOf.json
refusal.prototype-sub-action.hook.propertyIsEnumerable.plain
refusal.prototype-sub-action.hook.propertyIsEnumerable.json
refusal.prototype-sub-action.hook.toString.plain
refusal.prototype-sub-action.hook.toString.json
refusal.prototype-sub-action.hook.valueOf.plain
refusal.prototype-sub-action.hook.valueOf.json
refusal.prototype-sub-action.hook.__proto__.plain
refusal.prototype-sub-action.hook.__proto__.json
refusal.prototype-sub-action.hook.toLocaleString.plain
refusal.prototype-sub-action.hook.toLocaleString.json
refusal.prototype-sub-action.listen.constructor.plain
refusal.prototype-sub-action.listen.constructor.json
refusal.prototype-sub-action.listen.constructor.profile-valid
refusal.prototype-sub-action.listen.__defineGetter__.plain
refusal.prototype-sub-action.listen.__defineGetter__.json
refusal.prototype-sub-action.listen.__defineGetter__.profile-valid
refusal.prototype-sub-action.listen.__defineSetter__.plain
refusal.prototype-sub-action.listen.__defineSetter__.json
refusal.prototype-sub-action.listen.__defineSetter__.profile-valid
refusal.prototype-sub-action.listen.hasOwnProperty.plain
refusal.prototype-sub-action.listen.hasOwnProperty.json
refusal.prototype-sub-action.listen.hasOwnProperty.profile-valid
refusal.prototype-sub-action.listen.__lookupGetter__.plain
refusal.prototype-sub-action.listen.__lookupGetter__.json
refusal.prototype-sub-action.listen.__lookupGetter__.profile-valid
refusal.prototype-sub-action.listen.__lookupSetter__.plain
refusal.prototype-sub-action.listen.__lookupSetter__.json
refusal.prototype-sub-action.listen.__lookupSetter__.profile-valid
refusal.prototype-sub-action.listen.isPrototypeOf.plain
refusal.prototype-sub-action.listen.isPrototypeOf.json
refusal.prototype-sub-action.listen.isPrototypeOf.profile-valid
refusal.prototype-sub-action.listen.propertyIsEnumerable.plain
refusal.prototype-sub-action.listen.propertyIsEnumerable.json
refusal.prototype-sub-action.listen.propertyIsEnumerable.profile-valid
refusal.prototype-sub-action.listen.toString.plain
refusal.prototype-sub-action.listen.toString.json
refusal.prototype-sub-action.listen.toString.profile-valid
refusal.prototype-sub-action.listen.valueOf.plain
refusal.prototype-sub-action.listen.valueOf.json
refusal.prototype-sub-action.listen.valueOf.profile-valid
refusal.prototype-sub-action.listen.__proto__.plain
refusal.prototype-sub-action.listen.__proto__.json
refusal.prototype-sub-action.listen.__proto__.profile-valid
refusal.prototype-sub-action.listen.toLocaleString.plain
refusal.prototype-sub-action.listen.toLocaleString.json
refusal.prototype-sub-action.listen.toLocaleString.profile-valid
refusal.prototype-sub-action.session.constructor.plain
refusal.prototype-sub-action.session.constructor.json
refusal.prototype-sub-action.session.constructor.profile-valid
refusal.prototype-sub-action.session.__defineGetter__.plain
refusal.prototype-sub-action.session.__defineGetter__.json
refusal.prototype-sub-action.session.__defineGetter__.profile-valid
refusal.prototype-sub-action.session.__defineSetter__.plain
refusal.prototype-sub-action.session.__defineSetter__.json
refusal.prototype-sub-action.session.__defineSetter__.profile-valid
refusal.prototype-sub-action.session.hasOwnProperty.plain
refusal.prototype-sub-action.session.hasOwnProperty.json
refusal.prototype-sub-action.session.hasOwnProperty.profile-valid
refusal.prototype-sub-action.session.__lookupGetter__.plain
refusal.prototype-sub-action.session.__lookupGetter__.json
refusal.prototype-sub-action.session.__lookupGetter__.profile-valid
refusal.prototype-sub-action.session.__lookupSetter__.plain
refusal.prototype-sub-action.session.__lookupSetter__.json
refusal.prototype-sub-action.session.__lookupSetter__.profile-valid
refusal.prototype-sub-action.session.isPrototypeOf.plain
refusal.prototype-sub-action.session.isPrototypeOf.json
refusal.prototype-sub-action.session.isPrototypeOf.profile-valid
refusal.prototype-sub-action.session.propertyIsEnumerable.plain
refusal.prototype-sub-action.session.propertyIsEnumerable.json
refusal.prototype-sub-action.session.propertyIsEnumerable.profile-valid
refusal.prototype-sub-action.session.toString.plain
refusal.prototype-sub-action.session.toString.json
refusal.prototype-sub-action.session.toString.profile-valid
refusal.prototype-sub-action.session.valueOf.plain
refusal.prototype-sub-action.session.valueOf.json
refusal.prototype-sub-action.session.valueOf.profile-valid
refusal.prototype-sub-action.session.__proto__.plain
refusal.prototype-sub-action.session.__proto__.json
refusal.prototype-sub-action.session.__proto__.profile-valid
refusal.prototype-sub-action.session.toLocaleString.plain
refusal.prototype-sub-action.session.toLocaleString.json
refusal.prototype-sub-action.session.toLocaleString.profile-valid
refusal.prototype-sub-action.channel.constructor.plain
refusal.prototype-sub-action.channel.constructor.json
refusal.prototype-sub-action.channel.constructor.profile-valid
refusal.prototype-sub-action.channel.__defineGetter__.plain
refusal.prototype-sub-action.channel.__defineGetter__.json
refusal.prototype-sub-action.channel.__defineGetter__.profile-valid
refusal.prototype-sub-action.channel.__defineSetter__.plain
refusal.prototype-sub-action.channel.__defineSetter__.json
refusal.prototype-sub-action.channel.__defineSetter__.profile-valid
refusal.prototype-sub-action.channel.hasOwnProperty.plain
refusal.prototype-sub-action.channel.hasOwnProperty.json
refusal.prototype-sub-action.channel.hasOwnProperty.profile-valid
refusal.prototype-sub-action.channel.__lookupGetter__.plain
refusal.prototype-sub-action.channel.__lookupGetter__.json
refusal.prototype-sub-action.channel.__lookupGetter__.profile-valid
refusal.prototype-sub-action.channel.__lookupSetter__.plain
refusal.prototype-sub-action.channel.__lookupSetter__.json
refusal.prototype-sub-action.channel.__lookupSetter__.profile-valid
refusal.prototype-sub-action.channel.isPrototypeOf.plain
refusal.prototype-sub-action.channel.isPrototypeOf.json
refusal.prototype-sub-action.channel.isPrototypeOf.profile-valid
refusal.prototype-sub-action.channel.propertyIsEnumerable.plain
refusal.prototype-sub-action.channel.propertyIsEnumerable.json
refusal.prototype-sub-action.channel.propertyIsEnumerable.profile-valid
refusal.prototype-sub-action.channel.toString.plain
refusal.prototype-sub-action.channel.toString.json
refusal.prototype-sub-action.channel.toString.profile-valid
refusal.prototype-sub-action.channel.valueOf.plain
refusal.prototype-sub-action.channel.valueOf.json
refusal.prototype-sub-action.channel.valueOf.profile-valid
refusal.prototype-sub-action.channel.__proto__.plain
refusal.prototype-sub-action.channel.__proto__.json
refusal.prototype-sub-action.channel.__proto__.profile-valid
refusal.prototype-sub-action.channel.toLocaleString.plain
refusal.prototype-sub-action.channel.toLocaleString.json
refusal.prototype-sub-action.channel.toLocaleString.profile-valid
refusal.prototype-sub-action.file.constructor.plain
refusal.prototype-sub-action.file.constructor.json
refusal.prototype-sub-action.file.constructor.profile-valid
refusal.prototype-sub-action.file.__defineGetter__.plain
refusal.prototype-sub-action.file.__defineGetter__.json
refusal.prototype-sub-action.file.__defineGetter__.profile-valid
refusal.prototype-sub-action.file.__defineSetter__.plain
refusal.prototype-sub-action.file.__defineSetter__.json
refusal.prototype-sub-action.file.__defineSetter__.profile-valid
refusal.prototype-sub-action.file.hasOwnProperty.plain
refusal.prototype-sub-action.file.hasOwnProperty.json
refusal.prototype-sub-action.file.hasOwnProperty.profile-valid
refusal.prototype-sub-action.file.__lookupGetter__.plain
refusal.prototype-sub-action.file.__lookupGetter__.json
refusal.prototype-sub-action.file.__lookupGetter__.profile-valid
refusal.prototype-sub-action.file.__lookupSetter__.plain
refusal.prototype-sub-action.file.__lookupSetter__.json
refusal.prototype-sub-action.file.__lookupSetter__.profile-valid
refusal.prototype-sub-action.file.isPrototypeOf.plain
refusal.prototype-sub-action.file.isPrototypeOf.json
refusal.prototype-sub-action.file.isPrototypeOf.profile-valid
refusal.prototype-sub-action.file.propertyIsEnumerable.plain
refusal.prototype-sub-action.file.propertyIsEnumerable.json
refusal.prototype-sub-action.file.propertyIsEnumerable.profile-valid
refusal.prototype-sub-action.file.toString.plain
refusal.prototype-sub-action.file.toString.json
refusal.prototype-sub-action.file.toString.profile-valid
refusal.prototype-sub-action.file.valueOf.plain
refusal.prototype-sub-action.file.valueOf.json
refusal.prototype-sub-action.file.valueOf.profile-valid
refusal.prototype-sub-action.file.__proto__.plain
refusal.prototype-sub-action.file.__proto__.json
refusal.prototype-sub-action.file.__proto__.profile-valid
refusal.prototype-sub-action.file.toLocaleString.plain
refusal.prototype-sub-action.file.toLocaleString.json
refusal.prototype-sub-action.file.toLocaleString.profile-valid
refusal.prototype-sub-action.brain.constructor.plain
refusal.prototype-sub-action.brain.constructor.json
refusal.prototype-sub-action.brain.constructor.profile-valid
refusal.prototype-sub-action.brain.__defineGetter__.plain
refusal.prototype-sub-action.brain.__defineGetter__.json
refusal.prototype-sub-action.brain.__defineGetter__.profile-valid
refusal.prototype-sub-action.brain.__defineSetter__.plain
refusal.prototype-sub-action.brain.__defineSetter__.json
refusal.prototype-sub-action.brain.__defineSetter__.profile-valid
refusal.prototype-sub-action.brain.hasOwnProperty.plain
refusal.prototype-sub-action.brain.hasOwnProperty.json
refusal.prototype-sub-action.brain.hasOwnProperty.profile-valid
refusal.prototype-sub-action.brain.__lookupGetter__.plain
refusal.prototype-sub-action.brain.__lookupGetter__.json
refusal.prototype-sub-action.brain.__lookupGetter__.profile-valid
refusal.prototype-sub-action.brain.__lookupSetter__.plain
refusal.prototype-sub-action.brain.__lookupSetter__.json
refusal.prototype-sub-action.brain.__lookupSetter__.profile-valid
refusal.prototype-sub-action.brain.isPrototypeOf.plain
refusal.prototype-sub-action.brain.isPrototypeOf.json
refusal.prototype-sub-action.brain.isPrototypeOf.profile-valid
refusal.prototype-sub-action.brain.propertyIsEnumerable.plain
refusal.prototype-sub-action.brain.propertyIsEnumerable.json
refusal.prototype-sub-action.brain.propertyIsEnumerable.profile-valid
refusal.prototype-sub-action.brain.toString.plain
refusal.prototype-sub-action.brain.toString.json
refusal.prototype-sub-action.brain.toString.profile-valid
refusal.prototype-sub-action.brain.valueOf.plain
refusal.prototype-sub-action.brain.valueOf.json
refusal.prototype-sub-action.brain.valueOf.profile-valid
refusal.prototype-sub-action.brain.__proto__.plain
refusal.prototype-sub-action.brain.__proto__.json
refusal.prototype-sub-action.brain.__proto__.profile-valid
refusal.prototype-sub-action.brain.toLocaleString.plain
refusal.prototype-sub-action.brain.toLocaleString.json
refusal.prototype-sub-action.brain.toLocaleString.profile-valid
refusal.prototype-sub-action.grant.constructor.plain
refusal.prototype-sub-action.grant.constructor.json
refusal.prototype-sub-action.grant.__defineGetter__.plain
refusal.prototype-sub-action.grant.__defineGetter__.json
refusal.prototype-sub-action.grant.__defineSetter__.plain
refusal.prototype-sub-action.grant.__defineSetter__.json
refusal.prototype-sub-action.grant.hasOwnProperty.plain
refusal.prototype-sub-action.grant.hasOwnProperty.json
refusal.prototype-sub-action.grant.__lookupGetter__.plain
refusal.prototype-sub-action.grant.__lookupGetter__.json
refusal.prototype-sub-action.grant.__lookupSetter__.plain
refusal.prototype-sub-action.grant.__lookupSetter__.json
refusal.prototype-sub-action.grant.isPrototypeOf.plain
refusal.prototype-sub-action.grant.isPrototypeOf.json
refusal.prototype-sub-action.grant.propertyIsEnumerable.plain
refusal.prototype-sub-action.grant.propertyIsEnumerable.json
refusal.prototype-sub-action.grant.toString.plain
refusal.prototype-sub-action.grant.toString.json
refusal.prototype-sub-action.grant.valueOf.plain
refusal.prototype-sub-action.grant.valueOf.json
refusal.prototype-sub-action.grant.__proto__.plain
refusal.prototype-sub-action.grant.__proto__.json
refusal.prototype-sub-action.grant.toLocaleString.plain
refusal.prototype-sub-action.grant.toLocaleString.json
refusal.prototype-sub-action.link.constructor.plain
refusal.prototype-sub-action.link.constructor.json
refusal.prototype-sub-action.link.__defineGetter__.plain
refusal.prototype-sub-action.link.__defineGetter__.json
refusal.prototype-sub-action.link.__defineSetter__.plain
refusal.prototype-sub-action.link.__defineSetter__.json
refusal.prototype-sub-action.link.hasOwnProperty.plain
refusal.prototype-sub-action.link.hasOwnProperty.json
refusal.prototype-sub-action.link.__lookupGetter__.plain
refusal.prototype-sub-action.link.__lookupGetter__.json
refusal.prototype-sub-action.link.__lookupSetter__.plain
refusal.prototype-sub-action.link.__lookupSetter__.json
refusal.prototype-sub-action.link.isPrototypeOf.plain
refusal.prototype-sub-action.link.isPrototypeOf.json
refusal.prototype-sub-action.link.propertyIsEnumerable.plain
refusal.prototype-sub-action.link.propertyIsEnumerable.json
refusal.prototype-sub-action.link.toString.plain
refusal.prototype-sub-action.link.toString.json
refusal.prototype-sub-action.link.valueOf.plain
refusal.prototype-sub-action.link.valueOf.json
refusal.prototype-sub-action.link.__proto__.plain
refusal.prototype-sub-action.link.__proto__.json
refusal.prototype-sub-action.link.toLocaleString.plain
refusal.prototype-sub-action.link.toLocaleString.json
policy.host-session.brain.refusal.drop
policy.host-session.channel.refusal.drop
policy.host-session.file.refusal.drop
policy.host-session.listen.refusal.keep
policy.host-session.session.refusal.keep
```

`stdout` rows (5):

```text
meta.help-flag
meta.help-verb
meta.no-positional-json
meta.no-positional-profile
meta.bare
```

K row absent from main, with merged `stderr` (1):

```text
profile.refusal
```

### Fixes after the merge check

- Restored main’s `listen status --wait` behavior. The status branch first validates against `LISTEN_STOP_ACCEPTED_FLAGS`, then emits `--wait is only valid for listen stop`; the existing status/stop ternary remains the normal shape check. The command-table gate now pins both reads, and two built-CLI tests exercise the real parser rather than the dispatch fixture.
- Changed the shared `mcp connect` description to cover both forms: redeeming a code and clearing an interrupted connect. The two synopses and their shared description continue to come from the command table.
- Restored K’s listen-status synopsis by removing `--state-dir` from that synopsis. Because the flag remains accepted, generated help lists it under Additional options.
- Corrected this section’s parent-behavior, lane 2b, stale fixture, and `check.lock` explanations. No dispatch fixture or fixture count file was edited.

#### Before and after acceptance evidence

- `cswarm listen status --wait 5 --workspace-id 11111111-1111-4111-8111-111111111111`: before, `cswarm: unknown option: --wait`; after, `cswarm: --wait is only valid for listen stop`.
- `cswarm listen status --wait 5 --bogus x`: before, `cswarm: unknown option: --wait`; after, `cswarm: unknown option: --bogus`.

#### Tests after the fixes

- Wrapped command-table gate: 38/38 passed, including both built-CLI parser repros and the corrected help placement/copy.
- Wrapped timeout-table and citation-drift gates: 29/29 and 5/5 passed after re-pinning the two shifted HEAD timeout citations.
- The first required `k-fix-test.sh` run exited 0. Its gates mode recorded `npm test` at 1,030 passed, 0 failed, and 2 skipped; build, test type-check, edge check, generated protocol diff, release bundle, site build, and `git diff --check` also exited 0. The script then completed its focused `cli-file` loop through `run-gates.sh`.
- After this evidence correction, two repetitions of the required command reached the same managed-sandbox limit: each gates run recorded 1,028 passed, 2 failed, and 2 skipped because the real-process-table tests received `spawn EPERM`; all other aggregate gates exited 0. The command therefore exited 1 before its focused loop. Running that exact focused loop file-by-file through `run-gates.sh` passed: command table 38/38, timeout table 29/29, citation drift 5/5, inbox since 8/8, inbox follow step 4/4, profile inventory 5/5, and MCP connect 105/105.

#### Deployment and live verification after the fixes

Not run and not authorized. No production host or real workspace was contacted.

### Verification so far

- Before: required `k-test.sh` exited 1 at its marker scan and listed all eight files.
- After source resolution: `npm run build` exited 0.
- Wrapped focused gates: MCP connect 105/105, citation drift 5/5, and command-table gates 35/35 passed.
- The first timeout run exposed stale merged citations; after re-pinning, 28/29 passed, with only a test regex expecting `export const` instead of the source’s `const`. That assertion is corrected; the final acceptance run below is the authoritative result.
- Deployment/live verification: not run and not authorized. No production host was contacted.

### Final verification

- The required `k-test.sh` was run after resolution. Its marker scan passed. Gates mode passed build, `check:tests`, `check:edge`, the generated command-core diff, release-bundle build, site build, and `git diff --check`; `npm test` passed 1,028, skipped 2 Docker-dependent cases, and failed only the two real-`ps` controls because this managed sandbox refuses their child-process spawn with `EPERM`. The wrapper therefore stopped before its focused loop. Those process-table tests are outside this merge, and no unrelated assertion was changed. An earlier draft's claim that the site build could not unlink external Vite metadata is unsupported by the final run: the same required script recorded `npm --prefix site run build` exit 0.
- Each focused acceptance file was therefore run directly through the required `run-gates.sh ... HEAD cli-file` mode: host-id rotation 36 pass / 2 skip / 0 fail; MCP connect 105/105; MCP whole-file HOME control 1/1; inbox since 8/8; inbox follow step 4/4; item K HOME control 2/2; profile inventory 5/5; timeout table 29/29; citation drift 5/5; dispatcher baseline 10/10. Command-table gates also passed 35/35.
- The real-home `check.lock` was not created by the MCP test run: it belonged to another session’s turn check for seat `78249a33` in a different workspace. The whole-file control still needed the `lane-home-mcp-` prefix because K’s MCP tests intentionally create isolated homes with `createLaneTempHome`; the widening recognizes those fixture homes and does not excuse a real-home write. The wrapped MCP file passed 105/105 with no real-home change, and the nested whole-file control passed 1/1 while continuing to reject its enclosing HOME and every non-fixture path.
- Final `npx tsc -p tsconfig.tests.json --noEmit`, `git diff --check`, and the tracked-file conflict-marker scan all exited 0. Every changed file is under an allowed path.
- Deployment and live verification were not run. A merge or commit does not deploy anything.

## Fixes after the landing p1-cli run

### Cause and before evidence

- The wrapped `mcp-stdio.test.ts` baseline passed 33/34 and failed at its non-recursive `mkdir(<fixture HOME>/.cswarm)` with `EEXIST`.
- The directory is created by `fixture()`'s earlier `saveAgentProfile(profile, ...)` call. Item K intentionally made every saved explicit profile discoverable: `saveAgentProfile` takes the `profile-registry` lock under `agentProfileRoot()` and writes `profile-paths.json`; `withFileLock` first creates and secures that root. Because the fixture sets `HOME` to its own `mkdtemp` root, this correctly creates `<fixture HOME>/.cswarm` before the private-path preflight case prepares `state.md` there.
- The claim that the unchanged non-recursive mkdir passed at item K tip `a3f7bbd4` is not supported by that tree: its test has the same mkdir, while its `saveAgentProfile` already takes the registry lock and its `withFileLock` calls `secureDirectory(stateDirectory)`. Those source paths provide a concrete counterexample to the claimed absence of `.cswarm` after profile save.
- The wrapped `item-k-home-control.test.ts` baseline passed 1/2. Its inventory found `command-table-gates.test.ts`, added by the landing fix, but the expected list omitted it.

### Fixes

- Made the MCP preflight's private-state directory preparation recursive. This preserves the product's intended explicit-profile registry write and lets the test reuse the already-secured fixture directory.
- Made `runBuiltCli` in `command-table-gates.test.ts` create a fresh temporary HOME for every child and remove that exact directory afterward. The only current calls exercise `listen status` refusals, not profile writes, but the helper now keeps any future child-side profile state out of the enclosing or real HOME.
- Added `command-table-gates.test.ts` to the reconciled profile-writing test inventory. No dispatch fixture was edited.

### After evidence

- The same wrapped MCP file passed 34/34; the private-path preflight reached all of its assertions instead of failing while preparing the fixture directory.
- The same wrapped HOME-control file passed 2/2. Its reconciled inventory includes `command-table-gates.test.ts`, and the structural check accepts the helper only after observing the explicit child `HOME`.
- Every wrapper reported `orbstack running: before=no after=no` and detected no change under the real CommonSwarm home paths.

### Tests

- The required `k-fix2-test.sh` command exited 0 after running its direct build and test TypeScript check, then all eight files through `run-gates.sh ... HEAD cli-file`.
- Wrapped results: MCP stdio 34/34, HOME control 2/2, command table 38/38, MCP connect 105/105, profile inventory 5/5, timeout table 29/29, citation drift 5/5, and dispatcher baseline 10/10.
- The timeout-table and citation-drift suites confirm that every existing pin still resolves after the test-only line shifts. No timeout mapping, citation pin, or dispatch fixture needed an edit.

### Deployment and live verification

Not run and not authorized. No production host or real workspace was contacted.
