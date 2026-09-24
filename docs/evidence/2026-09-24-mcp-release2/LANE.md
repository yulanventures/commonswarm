# Item H release 2, option A — Maker lane

Base: `main` at `86a938f3`. Branch: `lane/mcp-connect`. This lane changed the CLI, the client profile writer, the site handoff copy, and tests. It changed no command edge, H0 edge, schema, or migration.

Fold 1 results below supersede the original lane's verification counts and artifact hashes.

## Decisions, implementation, and controls

| Brief decision | Implementation | Control |
|---|---|---|
| 1. Operator redeems | `mcp code` authenticates as a human and sends `mint_agent_join_credential` with `seat_cap: 1`, `ttl_hours: 1`; `mcp connect` reads from a hidden terminal prompt, registers once with a fresh `attemptId`, and saves an unbound profile through `saveAgentProfile`. | `mcp-connect.test.ts`: mint request, private profile, no secret in connect result, CLI refusal of argv/file/environment code sources. |
| 2. Secret-free install | Connect prints only the profile path and the Claude Code and Codex install lines. The in-repo release artifact now has its own CommonJS package scope so the exact bundle path runs from an outside directory. | `mcp-connect.test.ts`: install lines and no join or seat secret in rendered output; `release-bundle.test.ts`: execute the in-repo bundle from a temporary directory. |
| 3. Target | The 256-bit `swm_join_` code has no deployment. Connect requires `--url`; the public anon key comes from `--anon-key` or a saved current target with the same URL. The register response supplies `workspace_id` and `principal_id`. No guess based on an unrelated saved target is accepted. | `mcp-connect.test.ts`: register URL and public key, saved workspace and principal. Existing `current-target.test.ts` covers URL/key matching. |
| 4. Fail closed | Invalid codes and registration refusals produce typed codes with remedies matched to whether the server can prove a seat already exists. `403 forbidden` is the shared edge refusal for unknown, expired, and revoked codes, so the client cannot distinguish those cases. Connect does not retry; occupied profile or credential paths are refused before register, and the writer rechecks inside its lock. | `mcp-connect.test.ts`: refusal codes, second use seat cap, one request per call, no new profile on refusal, existing profile and orphan credential guards. |
| 5. Onboarding | `setup guide` explains the MCP terminal flow and labels file and H0 handoffs as secret-bearing. The Connect component exposes an MCP guide without minting a credential for that path; its existing prompt and file flow remain labeled as fallback. H0's existing paste now names the model-visible join credential. | `agent-prompt.observer.test.ts`: MCP guide has no credential and shows install lines; fallback prompt discloses the model-visible credential. `h0-paste.test.ts`: reviewed paste golden and canonical URL control. |
| 6. Client-only | The code uses the existing mint command and `h0/register`; no server or migration files changed. | Changed-path inventory and the local loopback tests. |

The hidden-input reader requires a TTY, disables echo before the prompt, and restores echo on normal, error, SIGINT, and SIGTERM paths. A plain pipe or redirect is refused; a same-user pseudo-terminal wrapper is not detected. This is a speed bump, not a security boundary. Tests inject the terminal; no test uses a real workspace or production host.

## Mutation controls

The focused test passed unchanged (5/5). Each temporary source mutation was reverted; the CLI was rebuilt after its argv mutation. Captured test output was summarized without printing any credential value.

| Mutation | Result |
|---|---|
| Append the seat token to connect's returned install text | Test exit 1; one assertion failure. |
| Accept `--code` from argv and pass it as the code reader | Mutated build exit 0; test exit 1; one assertion failure. Restored build exit 0. |
| Make another register request after a refused response | Test exit 1; one assertion failure. |
| Bypass the occupied profile preflight | Test exit 1; one assertion failure. |

## Verification before Fold 1 (historical at `da5fa657`)

| Gate | Exit | Count and note |
|---|---:|---|
| `npm run build` | 0 | One TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1 | 962 tests: 960 pass, 2 fail. Both failures call `ps`, which returns EPERM in this sandbox: `the real ps returns this test process`; `the real resume CLI uses only read resources and leaves local files byte-identical`. Run with temporary HOME. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 901 tests: 898 pass, 3 fail. All three call `ps`, which returns EPERM here: `the real ps returns this test process`; `the real resume CLI uses only read resources and leaves local files byte-identical`; `whoami trusts the live credential identity and file input keeps the token out of ps`. Run with temporary HOME. |
| `npm run check:tests` | 0 | One tests TypeScript check. |
| `bash scripts/build-release.sh` | 0 | One CJS bundle built and execute-checked; the Fold 1 table records that checkout's historical bundle SHA. |
| `dist-release/cswarm mcp connect --help` from an external temporary directory | 0 | One invocation; both `mcp code` and `mcp connect` usage lines present. |
| `git diff --check origin/main...HEAD` | 0 | One branch range diff, checked after commit. |

The pre-Fold 1 dispatch baseline was regenerated twice: both runs passed (1 test each) and produced byte-identical files. Its historical `command-dispatch-baseline.json` SHA-256 was `664241a9c6ee9306b1b0553319ffc7e0204a3227472edd0c7811d22ec040c0d6`; the counts file SHA-256 was `5d5f7f20d51cbf1868cb093f23af9d42c5586f5859369effced7199fa1ccf938`. Rows: 1,261 → 1,330; 78 added, 9 removed, 339 changed. The original row inventory and reason for each change follow below.

Post-fix focused controls: MCP connect and site handoff 17/17; bundle, H0 paste, and site handoff 27/27; command-table scan 1/1; profile-binding generated sweep 1/1; ACP timing rerun 4/4. These controls use local fakes and temporary HOME values. No production endpoint was called.

## Not established

The assignment prohibited contacting production, so this lane did not run the live H0 read/post control, fresh Codex and Claude Code MCP sessions, D-036 production pair, npm publication, or a box release. It did not prove behavior against the live deployment. A server commit followed by a client crash before profile writes may strand a seat; operator revocation remains the recovery. The original site run had two lane-only copy failures in access-lifecycle and workspace-entry; Fold 1 fixed those assertions and text. The completed site build passed. The rebuilt site suite has only browser geometry/screenshot subprocess failures in this sandbox; the two lane-only failures pass. A direct `ps` probe returned EPERM in this sandbox. The first full `npm test` run also had two ACP timing failures; their four focused cases passed after suite contention ended, and the final full run had only the two `ps` failures.

## Fold 1 — review rulings and controls

The option A TTY condition rejects plain pipes, `/dev/null`, and closed stdin. A same-user process can allocate a pseudo-terminal and is not detected. One client register attempt has a fresh attempt ID; the server's seat cap is one. Connect's output names the profile path, with no principal ID. The dashboard prompt retains the npm fallback sentence, and its Codex TOML places the table header and keys on separate lines.

| Ruling | Change and test | Reversion mutation result |
|---|---|---|
| K1 | The global parser reports only the option name; the three-command equals-style secret test checks both streams. | Parser reverted to the full option token: focused test failed; restored pass. |
| K2 | The private directory is prepared and checked before the prompt; `credential.json` is refused; all post-send uncertain responses and save/race failures use `register_outcome_unknown` and name `cswarm principal revoke`. The loopback committed-response matrix, race, and preflight tests cover these paths. | Revoke sentence replaced by a bare save failure: committed-response test failed; restored pass. |
| K3 | `MCP_REGISTER_TIMEOUT_MS` and the three timeout inventory rows cover register and `stty`; the exact inventory test checks both directions. | New `setTimeout` mapping row removed: exact inventory test failed; restored pass. |
| K4 | The site warning accurately names the model-visible prompt and MCP path; the button and observer assertions agree. The npm fallback sentence and valid Codex TOML are restored. The site prompt and two app observer tests cover this. | Four mutations were caught: old warning, old button, removed npm sentence, and one-line invalid TOML. Each focused site test passed before mutation and failed after. |
| K5 | Reader and test comments plus this evidence state the plain-pipe limit and pseudo-terminal bypass. A claim control checks this section. | Pseudo-terminal caveat removed: evidence claim test failed; restored pass. |
| K6 | EOF and empty input raise `code_missing`; code is trimmed, prompt follows echo-off, and both signal handlers restore echo and are removed. The injected terminal test covers each path. | Echo restoration removed: injected terminal test failed; restored pass. |
| K7 | The refusal table is generated from H0 and command producers; tests check generation, existing codes, status matches, and remedies without inspecting server message text. | Upgrade remedy replaced by “new code”: typed-remedy test failed; restored pass. |
| K8 | Register fetch uses `redirect: "error"`; the loopback 308 test proves no second origin receives the code. | `redirect: "error"` changed to `"follow"`: loopback 308 test failed; restored pass. |
| K9 | `mcp code` prints the exact URL and public anon key connect line; fresh connect without the key names only `--anon-key`. Unit and CLI tests cover both. | Two mutations were caught: omitted anon key from mint output and advice naming the ignored environment variable. Both focused tests failed. |
| K10 | Removed the principal ID output claim; corrected site gate history and the historical bundle SHA below; documented the npm sentence restoration. A claim control checks the evidence. | Stale principal-ID output claim restored: evidence claim test failed; restored pass. |
| K11 | Serve and refusal fixture sources now exercise their named routes; baseline regenerated twice with identical bytes. The fixture comparison checks route outputs. | Refusal fixture override removed: named-route test failed; restored pass. |

### Fold 1 gates

All 15 distinct mutations had a passing positive control and a failing named test; K2, K3, K6, and K9 were rechecked after final refinements. Each source file was restored byte-for-byte. The SHA-256 of the build in `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-hr2` at commit `f8328f83` was `ae29260330660822bec971c2fb4b48aa68ea01287d0ce0e745cacab0ac28e210`; it is a location-dependent historical measurement, not a gate. Final dispatch fixture: 1,330 rows, 0 added or removed, 12 changed against `da5fa657`; two final generations were byte-identical (`dacacbd4fbcf497511e1d5e022cecb4a739d0a8f918c07acf5ce8f5b70c2df62` fixture; `5d5f7f20d51cbf1868cb093f23af9d42c5586f5859369effced7199fa1ccf938` counts). Changed rows: `mcp.connect`, `setup.guide`, `policy.host-session.mcp.refusal.keep`, `policy.host-session.mcp.serve.keep`, and `selected-error.mcp.serve.{host-before,json-before,json-profile-missing-before,json-profile-valid-before,profile-json-missing-before,profile-json-valid-before,profile-missing-before,profile-valid-before}`.

| Gate | Exit | Count and result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1 | 962 tests: 960 pass, 2 `ps` EPERM failures in this sandbox. Temporary HOME and loopback site override. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 913 tests: 908 pass, 5 fail. Three are `ps` EPERM; the two F-1 target-discovery tests see the protective `CSWARM_SITE=http://127.0.0.1:9` override even though they inject a fake fetcher. No production discovery was attempted. |
| `npm run check:tests` | 0 | Test TypeScript check. |
| `bash scripts/build-release.sh` | 0 | Single-file CJS artifact built and execute-checked; historical checkout SHA above. |
| `npm --prefix site run build` | 0 | 12 static pages built. The first attempt hit EPERM because `site/node_modules` was a symlink outside the writable sandbox; a workspace-local dependency copy let the final build complete. |
| `env -u FORCE_COLOR npm --prefix site test` | 1 | 569 tests: 566 pass, 2 browser geometry/screenshot subprocess failures, 1 skip. Both site tests that failed in review pass. |
| `git diff --check origin/main...HEAD` | 0 | Committed branch range, checked after the Fold 1 commit. |

No production host or real workspace was contacted in Fold 1. The Opus round-1 review disclosed one earlier unauthenticated discovery request to `commonswarm.com` from its comparison probe. Live H0, fresh MCP host sessions, D-036, npm publication, and box release are not established.

## Fold 2 — review rulings and controls

Code and tests were committed at `8e4c21f0b7b76a690a12783a8290169072ecaccc`. This fold remains client, site, test, and evidence only. The generated refusal sets were checked against `registerAgentSeat`, its registration conflict constants, and the H0 forwarding/core handlers. `command_id_conflict` has no proof of seat state and keeps the uncertain-outcome remedy. A typed refusal is accepted only at its declared HTTP status.

| Ruling | Change and test | Reversion mutation |
|---|---|---|
| L1 | Removed the location-dependent release-bundle SHA assertion. The evidence test checks that the Fold 1 hash names its build folder and commit and that no test reads the generated bundle checksum. | Historical build-folder wording removed, then the old checksum path restored: evidence test 0 → 1 failure → 0 in each probe; sources restored byte-for-byte. |
| L2 | Generated separate seven-code early-refusal and three-code existing-seat sets from server source. Fold 3 narrowed the early-refusal claim to this attempt only. The existing-seat remedy says: “This code was already used. If you did not use it, someone else may have: tell the operator to revoke that agent and issue a new code.” The source inventory and all ten remedy cases run in `mcp-connect.test.ts`. | Seat-cap code removed from the existing-seat set: generated-set test 0 → 1 failure → 0; source restored byte-for-byte. |
| L3 | Restored `main` → `HEAD` in the timeout mapping, including all three MCP rows. The synthetic post-merge inventory test validates HEAD as main. | `main` alias removed: synthetic post-merge test 0 → 1 failure → 0; source restored byte-for-byte. |
| L4 | The signal test checks echo restoration before its stubbed `exit`; it does not rely on prompt cleanup. | Signal handler `restore()` removed: hidden-terminal test 0 → 1 failure → 0; source restored byte-for-byte. |
| L5 | The wrong-status matrix sends known refusal codes with 500 and 200, and keeps `command_id_conflict` uncertain. | HTTP status comparison removed: wrong-status test 0 → 1 failure → 0; source restored byte-for-byte. |
| L6 | The five shortened fallback-prompt sentences below remain necessary to meet the inline 3,200-character and file 2,000-character limits. A full restoration measured 3,252 and 2,114 characters. The site prompt and evidence assertions pin the wording. | Shortening disclosure heading removed, then a verbatim Grok sentence altered: evidence and site tests each went 0 → 1 failure → 0; source restored byte-for-byte. |
| L7 | `mcp code` and `mcp connect` now use their own generic failure labels; typed errors keep their codes, and `mcp` serve keeps `mcp_start_failed`. The CLI and code classifier tests check this. | `mcp code` generic label changed back to `mcp_start_failed`: label test 0 → 1 failure → 0; source restored byte-for-byte. |
| L8 | At Fold 2, the async cleanup removed an empty profile directory created by this run after EOF, an empty line, or a refusal. SIGINT and SIGTERM exited before that cleanup; Fold 3 added synchronous signal cleanup. The directory test checked that a new directory disappears and a preexisting one remains. | Empty-directory cleanup disabled: cancellation/refusal test 0 → 1 failure → 0; source restored byte-for-byte. |

The five retained fallback-prompt shortenings, relative to the original longer prompt, are:

1. “Connect to CommonSwarm. Keep the file private; never echo its contents or put them in commands, logs, URLs, or environment variables.” This shortens the connection-file and shell-command sentence.
2. “The installer reuses a matching build. If its host is blocked, use npm install -g commonswarm.” and “Confirm cswarm setup --check-version returns setup_version 1; otherwise report that the release needs updating.” These split and shorten the installer/version sentence while preserving the npm fallback. Fold 3 restored the version check as the condition for the release-update instruction.
3. “Run setup --json. Reuse its --profile and this session's --host-session-id.” This shortens the setup-command sentence.
4. “Ask once: enable wakeups in this same session, or check at each turn's start and whenever asked? Wake works with Claude Code preview channels or the local Grok Bot gateway; Codex supports turn checks. Explain approval or restart needs. Use cswarm receive configure with the user's choice; reuse a saved choice. Never start another model.” This shortens the gateway, approval, and model sentence. Fold 3 restored the setup guide's gateway name.
5. “Run cswarm check --profile <saved-profile> --host-session-id <this-session-id> before work. Read brain topics; post intent and reply. Use cswarm setup guide only when needed. Report connection, receive mode, and next step; claim wake only after its idle test passes.” This shortens the brain, connection, and wake-proof sentence.

The dispatch fixture was regenerated from the loopback harness. It remains 1,330 rows: zero added, zero removed, eleven changed. Every changed row is a stderr label: `mcp.code`, `policy.host-session.mcp.connect.drop`, `selected-error.mcp.code.json-before`, and eight `selected-error.mcp.connect.*` rows. The old `mcp_start_failed` labels became `mcp_code_failed` or `mcp_connect_failed`; no serve row changed. The generator invocation passed (exit 0); the subsequent full P1 CLI gate is recorded below.

The exact client remedy sentences are:

| Server result | Client sentence |
|---|---|
| `upgrade_required` | “Update cswarm and run mcp connect again; this attempt created no seat.” |
| `principal_limit_reached` | “The workspace has no free agent seat; this attempt created no seat. Ask the operator.” |
| `not_found`, `method_not_allowed` | “Check --url; this attempt created no seat.” |
| `forbidden` | “This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for a new code.” |
| `invalid_request`, `payload_too_large` | “The request was refused; this attempt created no seat. Ask the operator for a new code.” |
| `join_credential_seat_cap_reached`, `registration_token_already_used`, `registration_seat_revoked` | “This code was already used. If you did not use it, someone else may have: tell the operator to revoke that agent and issue a new code.” |
| `command_id_conflict`, network failures, malformed responses, redirects, save failures | “The seat may have been created. Ask the operator to revoke it with cswarm principal revoke and issue a new code.” |

The first group proves only that this registration attempt did not insert a seat; the credential may have been redeemed earlier. The existing-seat group follows the server's attempt or seat-cap branches. The uncertain group cannot prove whether a seat was created. The table records Fold 3's corrected client sentences; Fold 2's earlier sentence was overbroad.

### Fold 2 gates

| Gate | Exit | Count and result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1 | 962 tests: 960 pass, 2 `ps` spawn EPERM failures in this sandbox. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 917 tests: 912 pass, 5 fail. Three `ps` spawn EPERM failures and two F-1 target-discovery tests see the protective loopback site override. The dispatch baseline passes. |
| `npm run check:tests` | 0 | Test TypeScript check. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked. Its location-dependent SHA is not a gate. |
| `npm --prefix site run build` | 0 | Site build with a worktree-local dependency copy; the original `site/node_modules` symlink was restored afterward. An initial attempt using the symlink hit EPERM while unlinking Vite cache outside the sandbox. |
| `env -u FORCE_COLOR npm --prefix site test` | 1 | 570 tests: 494 pass, 75 headless Chrome SIGABRT failures, 1 skip. The new prompt claim test passes. |
| `git diff --check origin/main...HEAD` | 0 | Branch diff checked after the code commit; rechecked after this evidence commit. |

All test commands had a process-group timeout and a temporary HOME, XDG config directory, and loopback site override. No production host or real workspace was used. The Fold 2 post-gate change only strengthened the checksum-gate absence assertion; its focused test and mutation both passed.

Focused final controls after the last evidence edit: MCP connect 19/19, site fallback prompt 13/13, and the synthetic post-merge timeout alias 1/1. The generated refusal-table check is part of the MCP set.

### Fold 2 not established

The hard rules barred live H0 registration/read/post and production-host contact. Fresh Codex and Claude Code MCP sessions, D-036 transcripts, npm publication, a box release, the production fit of the 10-second register budget, and `cswarm principal revoke` on an H0 seat remain unmeasured. Local gates do not establish any of those conditions.

## Fold 3 — round-3 rulings and controls

Code and regression tests were committed at `2892f3ee`. Fold 3 checks claims against the existing server source only. `registerAgentSeat` can return `forbidden`, `invalid_request`, `upgrade_required`, and `principal_limit_reached` after loading a credential that may already have been redeemed. The H0 forwarding and routing refusals do not reach registration. `REGISTER_NO_SEAT_THIS_ATTEMPT` is generated from those handlers and states only what this call proves. The three existing-seat codes retain the revoke sentence; `command_id_conflict` remains uncertain. No server, edge, or migration file changed.

| Ruling | Change | Regression control and reversal mutation |
|---|---|---|
| M1 | Renamed the generated early-refusal set and replaced every overbroad remedy with the exact attempt-scoped sentences above. | `mcp-connect.test.ts` checks generated membership, all ten exact remedies, absence of the old claim, and successful use followed by `forbidden`. Reverting a remedy or the generated name fails the focused test. |
| M2 | Attached “otherwise report that the release needs updating” to `setup --check-version`, retained the npm fallback, and restored “the local Grok Bot gateway.” | `agent-prompt.observer.test.ts` pins both prompt sentences and this evidence; reverting either fails. The existing length tests enforce the inline and file limits. |
| M3 | Async directory cleanup ignores every removal error so it cannot replace a committed-register failure. SIGINT and SIGTERM remove a newly created empty directory synchronously, before exit, after matching its device and inode; an existing directory remains. | `mcp-connect.test.ts` injects EACCES after a committed 502 and checks the revoke sentence; the signal test checks both signals and both directory origins at exit. Reverting either fix fails its focused test. This corrects Fold 2's L8 statement: EOF, an empty line, and refusal were covered then; signal exit is covered now. |
| M4 | Corrected the timeout map's register-abort timer citation to the timer's current source line. | `timeout-table.test.ts` resolves the citation and asserts that line contains the actual abort timer; reverting the citation fails. |
| M5 | Fold 2 removed the pre-existing real `main` enumeration from the timeout inventory's exact-both-directions test. It substituted a synthetic post-merge `HEAD` inventory test because, before merge, real `main` lacks the MCP rows and reports them as stale. Once main contains this branch, the synthetic inventory models the intended alias. | `timeout-table.test.ts` checks that Fold 3 records the removed check and its reason; deleting this disclosure fails. |

Eight reversal probes ran against the restored source, each with a passing positive control and a failing mutation: M1 remedy text and generated-set name; M2 version remedy and gateway name; M3 EACCES cleanup and signal cleanup; M4 timer citation; M5 removed-check disclosure. Each mutation produced one focused test failure and the source was restored byte-for-byte. Focused final controls: MCP connect 22/22, site prompt 13/13, timer citation 1/1, and the independently rerun hook deadline 1/1.

### Fold 3 gates

| Gate | Exit | Count and result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1 | 962 tests: 960 pass, 2 `ps`/spawn EPERM sandbox failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 922 tests: 916 pass, 6 fail. Three `ps`/spawn EPERM sandbox failures; two F-1 tests see the protective loopback site override; one hook deadline timing test took 5,009 ms under suite load. The hook test passed 1/1 when rerun alone. |
| `npm run check:tests` | 0 | Test TypeScript check. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked. |
| `npm --prefix site run build` | 0 | 12 static pages. The first local dependency copy dereferenced `.bin` links and could not resolve Astro; a second copy preserving those links passed, then the original symlink was restored. |
| `env -u FORCE_COLOR npm --prefix site test` | 1 | 570 tests: 494 pass, 75 browser subprocess SIGABRT failures, 1 skip. The Fold 3 prompt test passes. |
| `git diff --check origin/main...HEAD` | 0 | Checked the committed branch range after the code commit; rechecked after this evidence commit. |

All gate subprocesses had wall-clock timeouts and process-group termination on timeout. They used temporary HOME and XDG config directories and loopback `CSWARM_SITE` and `SWARM_CLOUD_URL` overrides. No gate timed out; no test process remains.

The release and production controls remain unmeasured: no live H0 registration/read/post, fresh Codex or Claude Code MCP session, D-036 transcript, npm publication, box release, production timing fit, or H0-seat revocation was performed.

## Dispatch baseline row inventory

Reason codes: **H** = the global help text now includes `mcp code` and `mcp connect`; **G** = MCP became a command group with new code/connect/serve/refusal routing and policy rows; **S** = setup guide's MCP and fallback wording changed. Every row below is named from the JSON fixture comparison with `origin/main`.

| Change | Row ID | Reason |
|---|---|---|
| added | `refusal.group.mcp.missing.plain` | G |
| added | `refusal.group.mcp.missing.json` | G |
| added | `refusal.group.mcp.missing.profile-valid` | G |
| added | `refusal.group.mcp.missing.profile-valid-json` | G |
| added | `refusal.group.mcp.missing.profile-missing` | G |
| added | `refusal.group.mcp.missing.profile-missing-json` | G |
| added | `refusal.group.mcp.unknown.plain` | G |
| added | `refusal.group.mcp.unknown.json` | G |
| added | `refusal.group.mcp.unknown.profile-valid` | G |
| added | `refusal.group.mcp.unknown.profile-valid-json` | G |
| added | `refusal.group.mcp.unknown.profile-missing` | G |
| added | `refusal.group.mcp.unknown.profile-missing-json` | G |
| added | `refusal.prototype-sub-action.mcp.constructor.plain` | G |
| added | `refusal.prototype-sub-action.mcp.constructor.json` | G |
| added | `refusal.prototype-sub-action.mcp.constructor.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.__defineGetter__.plain` | G |
| added | `refusal.prototype-sub-action.mcp.__defineGetter__.json` | G |
| added | `refusal.prototype-sub-action.mcp.__defineGetter__.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.__defineSetter__.plain` | G |
| added | `refusal.prototype-sub-action.mcp.__defineSetter__.json` | G |
| added | `refusal.prototype-sub-action.mcp.__defineSetter__.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.hasOwnProperty.plain` | G |
| added | `refusal.prototype-sub-action.mcp.hasOwnProperty.json` | G |
| added | `refusal.prototype-sub-action.mcp.hasOwnProperty.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.__lookupGetter__.plain` | G |
| added | `refusal.prototype-sub-action.mcp.__lookupGetter__.json` | G |
| added | `refusal.prototype-sub-action.mcp.__lookupGetter__.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.__lookupSetter__.plain` | G |
| added | `refusal.prototype-sub-action.mcp.__lookupSetter__.json` | G |
| added | `refusal.prototype-sub-action.mcp.__lookupSetter__.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.isPrototypeOf.plain` | G |
| added | `refusal.prototype-sub-action.mcp.isPrototypeOf.json` | G |
| added | `refusal.prototype-sub-action.mcp.isPrototypeOf.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.propertyIsEnumerable.plain` | G |
| added | `refusal.prototype-sub-action.mcp.propertyIsEnumerable.json` | G |
| added | `refusal.prototype-sub-action.mcp.propertyIsEnumerable.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.toString.plain` | G |
| added | `refusal.prototype-sub-action.mcp.toString.json` | G |
| added | `refusal.prototype-sub-action.mcp.toString.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.valueOf.plain` | G |
| added | `refusal.prototype-sub-action.mcp.valueOf.json` | G |
| added | `refusal.prototype-sub-action.mcp.valueOf.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.__proto__.plain` | G |
| added | `refusal.prototype-sub-action.mcp.__proto__.json` | G |
| added | `refusal.prototype-sub-action.mcp.__proto__.profile-valid` | G |
| added | `refusal.prototype-sub-action.mcp.toLocaleString.plain` | G |
| added | `refusal.prototype-sub-action.mcp.toLocaleString.json` | G |
| added | `refusal.prototype-sub-action.mcp.toLocaleString.profile-valid` | G |
| added | `mcp.code` | G |
| added | `mcp.connect` | G |
| added | `policy.host-session.mcp.code.drop` | G |
| added | `policy.host-session.mcp.connect.drop` | G |
| added | `policy.host-session.mcp.refusal.keep` | G |
| added | `policy.host-session.mcp.serve.keep` | G |
| added | `selected-error.mcp.code.json-before` | G |
| added | `selected-error.mcp.code.profile-valid-before` | G |
| added | `selected-error.mcp.code.profile-missing-before` | G |
| added | `selected-error.mcp.code.json-profile-valid-before` | G |
| added | `selected-error.mcp.code.json-profile-missing-before` | G |
| added | `selected-error.mcp.code.profile-json-valid-before` | G |
| added | `selected-error.mcp.code.profile-json-missing-before` | G |
| added | `selected-error.mcp.code.host-before` | G |
| added | `selected-error.mcp.connect.json-before` | G |
| added | `selected-error.mcp.connect.profile-valid-before` | G |
| added | `selected-error.mcp.connect.profile-missing-before` | G |
| added | `selected-error.mcp.connect.json-profile-valid-before` | G |
| added | `selected-error.mcp.connect.json-profile-missing-before` | G |
| added | `selected-error.mcp.connect.profile-json-valid-before` | G |
| added | `selected-error.mcp.connect.profile-json-missing-before` | G |
| added | `selected-error.mcp.connect.host-before` | G |
| added | `selected-error.mcp.serve.json-before` | G |
| added | `selected-error.mcp.serve.profile-valid-before` | G |
| added | `selected-error.mcp.serve.profile-missing-before` | G |
| added | `selected-error.mcp.serve.json-profile-valid-before` | G |
| added | `selected-error.mcp.serve.json-profile-missing-before` | G |
| added | `selected-error.mcp.serve.profile-json-valid-before` | G |
| added | `selected-error.mcp.serve.profile-json-missing-before` | G |
| added | `selected-error.mcp.serve.host-before` | G |
| removed | `policy.host-session.mcp.keep` | G |
| removed | `selected-error.mcp.json-before` | G |
| removed | `selected-error.mcp.profile-valid-before` | G |
| removed | `selected-error.mcp.profile-missing-before` | G |
| removed | `selected-error.mcp.json-profile-valid-before` | G |
| removed | `selected-error.mcp.json-profile-missing-before` | G |
| removed | `selected-error.mcp.profile-json-valid-before` | G |
| removed | `selected-error.mcp.profile-json-missing-before` | G |
| removed | `selected-error.mcp.host-before` | G |
| changed | `refusal.unknown-verb` | H |
| changed | `refusal.prototype-verb.constructor.plain` | H |
| changed | `refusal.prototype-verb.constructor.json` | H |
| changed | `refusal.prototype-verb.__defineGetter__.plain` | H |
| changed | `refusal.prototype-verb.__defineGetter__.json` | H |
| changed | `refusal.prototype-verb.__defineSetter__.plain` | H |
| changed | `refusal.prototype-verb.__defineSetter__.json` | H |
| changed | `refusal.prototype-verb.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-verb.hasOwnProperty.json` | H |
| changed | `refusal.prototype-verb.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-verb.__lookupGetter__.json` | H |
| changed | `refusal.prototype-verb.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-verb.__lookupSetter__.json` | H |
| changed | `refusal.prototype-verb.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-verb.isPrototypeOf.json` | H |
| changed | `refusal.prototype-verb.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-verb.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-verb.toString.plain` | H |
| changed | `refusal.prototype-verb.toString.json` | H |
| changed | `refusal.prototype-verb.valueOf.plain` | H |
| changed | `refusal.prototype-verb.valueOf.json` | H |
| changed | `refusal.prototype-verb.__proto__.plain` | H |
| changed | `refusal.prototype-verb.__proto__.json` | H |
| changed | `refusal.prototype-verb.toLocaleString.plain` | H |
| changed | `refusal.prototype-verb.toLocaleString.json` | H |
| changed | `refusal.group.hook.missing.plain` | H |
| changed | `refusal.group.hook.missing.json` | H |
| changed | `refusal.group.hook.unknown.plain` | H |
| changed | `refusal.group.hook.unknown.json` | H |
| changed | `refusal.group.listen.missing.plain` | H |
| changed | `refusal.group.listen.missing.json` | H |
| changed | `refusal.group.listen.missing.profile-valid` | H |
| changed | `refusal.group.listen.missing.profile-valid-json` | H |
| changed | `refusal.group.listen.unknown.plain` | H |
| changed | `refusal.group.listen.unknown.json` | H |
| changed | `refusal.group.listen.unknown.profile-valid` | H |
| changed | `refusal.group.listen.unknown.profile-valid-json` | H |
| changed | `refusal.group.session.missing.plain` | H |
| changed | `refusal.group.session.missing.json` | H |
| changed | `refusal.group.session.missing.profile-valid` | H |
| changed | `refusal.group.session.missing.profile-valid-json` | H |
| changed | `refusal.group.session.unknown.plain` | H |
| changed | `refusal.group.session.unknown.json` | H |
| changed | `refusal.group.session.unknown.profile-valid` | H |
| changed | `refusal.group.session.unknown.profile-valid-json` | H |
| changed | `refusal.group.channel.missing.plain` | H |
| changed | `refusal.group.channel.missing.json` | H |
| changed | `refusal.group.channel.missing.profile-valid` | H |
| changed | `refusal.group.channel.missing.profile-valid-json` | H |
| changed | `refusal.group.channel.unknown.plain` | H |
| changed | `refusal.group.channel.unknown.json` | H |
| changed | `refusal.group.channel.unknown.profile-valid` | H |
| changed | `refusal.group.channel.unknown.profile-valid-json` | H |
| changed | `refusal.group.file.missing.plain` | H |
| changed | `refusal.group.file.missing.json` | H |
| changed | `refusal.group.file.missing.profile-valid` | H |
| changed | `refusal.group.file.missing.profile-valid-json` | H |
| changed | `refusal.group.file.unknown.plain` | H |
| changed | `refusal.group.file.unknown.json` | H |
| changed | `refusal.group.file.unknown.profile-valid` | H |
| changed | `refusal.group.file.unknown.profile-valid-json` | H |
| changed | `refusal.group.brain.missing.plain` | H |
| changed | `refusal.group.brain.missing.json` | H |
| changed | `refusal.group.brain.missing.profile-valid` | H |
| changed | `refusal.group.brain.missing.profile-valid-json` | H |
| changed | `refusal.group.brain.unknown.plain` | H |
| changed | `refusal.group.brain.unknown.json` | H |
| changed | `refusal.group.brain.unknown.profile-valid` | H |
| changed | `refusal.group.brain.unknown.profile-valid-json` | H |
| changed | `refusal.group.grant.unknown.plain` | H |
| changed | `refusal.group.grant.unknown.json` | H |
| changed | `refusal.group.link.missing.plain` | H |
| changed | `refusal.group.link.missing.json` | H |
| changed | `refusal.group.link.unknown.plain` | H |
| changed | `refusal.group.link.unknown.json` | H |
| changed | `refusal.prototype-sub-action.hook.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.hook.constructor.json` | H |
| changed | `refusal.prototype-sub-action.hook.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.hook.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.hook.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.hook.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.hook.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.hook.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.hook.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.hook.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.hook.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.hook.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.hook.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.hook.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.hook.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.hook.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.hook.toString.plain` | H |
| changed | `refusal.prototype-sub-action.hook.toString.json` | H |
| changed | `refusal.prototype-sub-action.hook.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.hook.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.hook.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.hook.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.hook.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.hook.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.listen.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.listen.constructor.json` | H |
| changed | `refusal.prototype-sub-action.listen.constructor.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.listen.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.listen.__defineGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.listen.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.listen.__defineSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.listen.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.listen.hasOwnProperty.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.listen.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.listen.__lookupGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.listen.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.listen.__lookupSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.listen.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.listen.isPrototypeOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.listen.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.listen.propertyIsEnumerable.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.toString.plain` | H |
| changed | `refusal.prototype-sub-action.listen.toString.json` | H |
| changed | `refusal.prototype-sub-action.listen.toString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.listen.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.listen.valueOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.listen.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.listen.__proto__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.listen.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.listen.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.listen.toLocaleString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.session.constructor.json` | H |
| changed | `refusal.prototype-sub-action.session.constructor.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.session.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.session.__defineGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.session.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.session.__defineSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.session.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.session.hasOwnProperty.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.session.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.session.__lookupGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.session.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.session.__lookupSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.session.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.session.isPrototypeOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.session.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.session.propertyIsEnumerable.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.toString.plain` | H |
| changed | `refusal.prototype-sub-action.session.toString.json` | H |
| changed | `refusal.prototype-sub-action.session.toString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.session.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.session.valueOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.session.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.session.__proto__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.session.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.session.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.session.toLocaleString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.channel.constructor.json` | H |
| changed | `refusal.prototype-sub-action.channel.constructor.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.channel.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.channel.__defineGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.channel.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.channel.__defineSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.channel.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.channel.hasOwnProperty.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.channel.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.channel.__lookupGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.channel.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.channel.__lookupSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.channel.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.channel.isPrototypeOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.channel.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.channel.propertyIsEnumerable.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.toString.plain` | H |
| changed | `refusal.prototype-sub-action.channel.toString.json` | H |
| changed | `refusal.prototype-sub-action.channel.toString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.channel.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.channel.valueOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.channel.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.channel.__proto__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.channel.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.channel.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.channel.toLocaleString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.file.constructor.json` | H |
| changed | `refusal.prototype-sub-action.file.constructor.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.file.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.file.__defineGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.file.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.file.__defineSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.file.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.file.hasOwnProperty.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.file.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.file.__lookupGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.file.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.file.__lookupSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.file.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.file.isPrototypeOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.file.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.file.propertyIsEnumerable.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.toString.plain` | H |
| changed | `refusal.prototype-sub-action.file.toString.json` | H |
| changed | `refusal.prototype-sub-action.file.toString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.file.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.file.valueOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.file.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.file.__proto__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.file.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.file.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.file.toLocaleString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.brain.constructor.json` | H |
| changed | `refusal.prototype-sub-action.brain.constructor.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.brain.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.brain.__defineGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.brain.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.brain.__defineSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.brain.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.brain.hasOwnProperty.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.brain.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.brain.__lookupGetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.brain.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.brain.__lookupSetter__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.brain.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.brain.isPrototypeOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.brain.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.brain.propertyIsEnumerable.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.toString.plain` | H |
| changed | `refusal.prototype-sub-action.brain.toString.json` | H |
| changed | `refusal.prototype-sub-action.brain.toString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.brain.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.brain.valueOf.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.brain.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.brain.__proto__.profile-valid` | H |
| changed | `refusal.prototype-sub-action.brain.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.brain.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.brain.toLocaleString.profile-valid` | H |
| changed | `refusal.prototype-sub-action.grant.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.grant.constructor.json` | H |
| changed | `refusal.prototype-sub-action.grant.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.grant.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.grant.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.grant.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.grant.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.grant.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.grant.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.grant.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.grant.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.grant.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.grant.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.grant.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.grant.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.grant.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.grant.toString.plain` | H |
| changed | `refusal.prototype-sub-action.grant.toString.json` | H |
| changed | `refusal.prototype-sub-action.grant.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.grant.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.grant.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.grant.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.grant.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.grant.toLocaleString.json` | H |
| changed | `refusal.prototype-sub-action.link.constructor.plain` | H |
| changed | `refusal.prototype-sub-action.link.constructor.json` | H |
| changed | `refusal.prototype-sub-action.link.__defineGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.link.__defineGetter__.json` | H |
| changed | `refusal.prototype-sub-action.link.__defineSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.link.__defineSetter__.json` | H |
| changed | `refusal.prototype-sub-action.link.hasOwnProperty.plain` | H |
| changed | `refusal.prototype-sub-action.link.hasOwnProperty.json` | H |
| changed | `refusal.prototype-sub-action.link.__lookupGetter__.plain` | H |
| changed | `refusal.prototype-sub-action.link.__lookupGetter__.json` | H |
| changed | `refusal.prototype-sub-action.link.__lookupSetter__.plain` | H |
| changed | `refusal.prototype-sub-action.link.__lookupSetter__.json` | H |
| changed | `refusal.prototype-sub-action.link.isPrototypeOf.plain` | H |
| changed | `refusal.prototype-sub-action.link.isPrototypeOf.json` | H |
| changed | `refusal.prototype-sub-action.link.propertyIsEnumerable.plain` | H |
| changed | `refusal.prototype-sub-action.link.propertyIsEnumerable.json` | H |
| changed | `refusal.prototype-sub-action.link.toString.plain` | H |
| changed | `refusal.prototype-sub-action.link.toString.json` | H |
| changed | `refusal.prototype-sub-action.link.valueOf.plain` | H |
| changed | `refusal.prototype-sub-action.link.valueOf.json` | H |
| changed | `refusal.prototype-sub-action.link.__proto__.plain` | H |
| changed | `refusal.prototype-sub-action.link.__proto__.json` | H |
| changed | `refusal.prototype-sub-action.link.toLocaleString.plain` | H |
| changed | `refusal.prototype-sub-action.link.toLocaleString.json` | H |
| changed | `meta.help-flag` | H |
| changed | `meta.help-verb` | H |
| changed | `meta.no-positional-json` | H |
| changed | `meta.no-positional-profile` | H |
| changed | `meta.bare` | H |
| changed | `mcp` | G |
| changed | `setup.guide` | S |
| changed | `policy.host-session.brain.refusal.drop` | H |
| changed | `policy.host-session.channel.refusal.drop` | H |
| changed | `policy.host-session.file.refusal.drop` | H |
| changed | `policy.host-session.listen.refusal.keep` | H |
| changed | `policy.host-session.session.refusal.keep` | H |
