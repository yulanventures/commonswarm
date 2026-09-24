# Item H release 2, option A — Maker lane

Base: `main` at `86a938f3`. Branch: `lane/mcp-connect`. This lane changed the CLI, the client profile writer, the site handoff copy, and tests. It changed no command edge, H0 edge, schema, or migration.

Fold 1 results below supersede the original lane's verification counts and artifact hashes.

## Decisions, implementation, and controls

| Brief decision | Implementation | Control |
|---|---|---|
| 1. Operator redeems | `mcp code` authenticates as a human and sends `mint_agent_join_credential` with `seat_cap: 1`, `ttl_hours: 1`; `mcp connect` reads from a hidden terminal prompt, registers once with a fresh `attemptId`, and saves an unbound profile through `saveAgentProfile`. | `mcp-connect.test.ts`: mint request, private profile, no secret in connect result, CLI refusal of argv/file/environment code sources. |
| 2. Secret-free install | Connect prints only the profile path and the Claude Code and Codex install lines. The in-repo release artifact now has its own CommonJS package scope so the exact bundle path runs from an outside directory. | `mcp-connect.test.ts`: install lines and no join or seat secret in rendered output; `release-bundle.test.ts`: execute the in-repo bundle from a temporary directory. |
| 3. Target | The 256-bit `swm_join_` code has no deployment. Connect requires `--url`; the public anon key comes from `--anon-key` or a saved current target with the same URL. The register response supplies `workspace_id` and `principal_id`. No guess based on an unrelated saved target is accepted. | `mcp-connect.test.ts`: register URL and public key, saved workspace and principal. Existing `current-target.test.ts` covers URL/key matching. |
| 4. Fail closed | Invalid codes and registration refusals produce typed codes with “Ask the operator for a new code.” `403 forbidden` is the shared edge refusal for unknown, expired, and revoked codes, so the client cannot distinguish those cases. Connect does not retry; occupied profile or credential paths are refused before register, and the writer rechecks inside its lock. | `mcp-connect.test.ts`: refusal codes, second use seat cap, one request per call, no new profile on refusal, existing profile and orphan credential guards. |
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
| `bash scripts/build-release.sh` | 0 | One CJS bundle built and execute-checked; the Fold 1 table gives the current bundle SHA. |
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
| K10 | Removed the principal ID output claim; corrected site gate history and the final bundle SHA below; documented the npm sentence restoration. A claim control checks the evidence. | Stale principal-ID output claim restored: evidence claim test failed; restored pass. |
| K11 | Serve and refusal fixture sources now exercise their named routes; baseline regenerated twice with identical bytes. The fixture comparison checks route outputs. | Refusal fixture override removed: named-route test failed; restored pass. |

### Fold 1 gates

All 15 distinct mutations had a passing positive control and a failing named test; K2, K3, K6, and K9 were rechecked after final refinements. Each source file was restored byte-for-byte. The final release bundle SHA-256 is `ae29260330660822bec971c2fb4b48aa68ea01287d0ce0e745cacab0ac28e210`. Final dispatch fixture: 1,330 rows, 0 added or removed, 12 changed against `da5fa657`; two final generations were byte-identical (`dacacbd4fbcf497511e1d5e022cecb4a739d0a8f918c07acf5ce8f5b70c2df62` fixture; `5d5f7f20d51cbf1868cb093f23af9d42c5586f5859369effced7199fa1ccf938` counts). Changed rows: `mcp.connect`, `setup.guide`, `policy.host-session.mcp.refusal.keep`, `policy.host-session.mcp.serve.keep`, and `selected-error.mcp.serve.{host-before,json-before,json-profile-missing-before,json-profile-valid-before,profile-json-missing-before,profile-json-valid-before,profile-missing-before,profile-valid-before}`.

| Gate | Exit | Count and result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1 | 962 tests: 960 pass, 2 `ps` EPERM failures in this sandbox. Temporary HOME and loopback site override. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 913 tests: 908 pass, 5 fail. Three are `ps` EPERM; the two F-1 target-discovery tests see the protective `CSWARM_SITE=http://127.0.0.1:9` override even though they inject a fake fetcher. No production discovery was attempted. |
| `npm run check:tests` | 0 | Test TypeScript check. |
| `bash scripts/build-release.sh` | 0 | Single-file CJS artifact built and execute-checked; SHA above. |
| `npm --prefix site run build` | 0 | 12 static pages built. The first attempt hit EPERM because `site/node_modules` was a symlink outside the writable sandbox; a workspace-local dependency copy let the final build complete. |
| `env -u FORCE_COLOR npm --prefix site test` | 1 | 569 tests: 566 pass, 2 browser geometry/screenshot subprocess failures, 1 skip. Both site tests that failed in review pass. |
| `git diff --check origin/main...HEAD` | 0 | Committed branch range, checked after the Fold 1 commit. |

No production host or real workspace was contacted in Fold 1. The Opus round-1 review disclosed one earlier unauthenticated discovery request to `commonswarm.com` from its comparison probe. Live H0, fresh MCP host sessions, D-036, npm publication, and box release are not established.

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
